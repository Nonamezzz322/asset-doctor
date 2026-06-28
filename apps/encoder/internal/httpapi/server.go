// Package httpapi wires the encoder sidecar's two routes. This service does NO auth and NO billing —
// it sits on an internal docker network and trusts apps/api (the gateway) to have verified the license
// entitlement, applied per-license quota, and bounded the body BEFORE proxying here. This layer is the
// last line of defense: it re-applies hard size/dimension/pixel caps, bounds concurrency, and never logs
// image bytes. The actual KTX2 encode is behind the encode.Encoder interface (mocked in tests).
package httpapi

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"

	"github.com/Nonamezzz322/asset-doctor/apps/encoder/internal/config"
	"github.com/Nonamezzz322/asset-doctor/apps/encoder/internal/encode"
)

type Server struct {
	cfg *config.Config
	enc encode.Encoder
	// sem is a counting semaphore that bounds simultaneous encodes. A non-blocking acquire → 503 when
	// full, so a flood of opt-in requests degrades gracefully instead of OOM-ing the host. UASTC RDO is
	// CPU+RAM heavy, so this cap matters.
	sem chan struct{}
	// logger is injectable so tests can assert that image bytes never appear in logs.
	logger *log.Logger
}

func New(cfg *config.Config, enc encode.Encoder, logger *log.Logger) *Server {
	if logger == nil {
		logger = log.Default()
	}
	return &Server{
		cfg:    cfg,
		enc:    enc,
		sem:    make(chan struct{}, cfg.MaxConcurrent),
		logger: logger,
	}
}

func (s *Server) Router() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.handleHealthz)
	mux.HandleFunc("POST /process", s.handleProcess)
	return mux
}

// healthzBody is the liveness/readiness payload. It deliberately does NOT leak the toktx version or
// path — a probe answers "am I up", nothing about the binary inventory.
type healthzBody struct {
	Status string `json:"status"`
}

func (s *Server) handleHealthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, healthzBody{Status: "ok"})
}

// processRequest is the JSON envelope. The PNG bytes ride as base64 in `png` so the whole request is one
// JSON body the gateway can proxy without multipart parsing. base64 inflates by ~33%, accounted for in
// the gateway's body cap. Unknown fields are rejected (tight contract).
type processRequest struct {
	PNG     string `json:"png"`     // base64 std-encoded PNG bytes
	W       int    `json:"w"`       // declared width  (cross-checked against caps; trusted from gateway)
	H       int    `json:"h"`       // declared height
	Op      string `json:"op"`      // "ktx2"
	Profile string `json:"profile"` // "uastc-zstd-mip"
}

func (s *Server) handleProcess(w http.ResponseWriter, r *http.Request) {
	// Bound the raw body first: base64 of MaxBodyBytes is ~4/3 the binary size, plus a small JSON
	// envelope. We cap at MaxBodyBytes*2 to leave headroom; the decoded-byte cap below is the real limit.
	r.Body = http.MaxBytesReader(w, r.Body, s.cfg.MaxBodyBytes*2)

	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	var req processRequest
	if err := dec.Decode(&req); err != nil {
		// A MaxBytesReader overflow surfaces here as an error; map the size case to 413 explicitly.
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			writeErr(w, http.StatusRequestEntityTooLarge, "payload_too_large", "request body exceeds limit")
			return
		}
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
		return
	}

	// Op / profile allowlist → 415 (we don't implement it). Closed sets: no flag injection possible.
	if encode.Op(req.Op) != encode.KTX2 {
		writeErr(w, http.StatusUnsupportedMediaType, "unsupported_op", "unsupported op")
		return
	}
	if !encode.SupportedProfiles[encode.Profile(req.Profile)] {
		writeErr(w, http.StatusUnsupportedMediaType, "unsupported_profile", "unsupported profile")
		return
	}

	// Dimension + pixel caps → 415 (we refuse to decode/encode an oversized texture). Checked BEFORE we
	// even allocate the decoded PNG, using the declared dimensions from the trusted gateway.
	if req.W <= 0 || req.H <= 0 || req.W > s.cfg.MaxDim || req.H > s.cfg.MaxDim {
		writeErr(w, http.StatusUnsupportedMediaType, "dimensions_out_of_range", "image dimensions out of allowed range")
		return
	}
	if int64(req.W)*int64(req.H) > s.cfg.MaxPixels {
		writeErr(w, http.StatusUnsupportedMediaType, "too_many_pixels", "image pixel count exceeds limit")
		return
	}

	png, err := decodeBase64(req.PNG)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "png is not valid base64")
		return
	}
	if int64(len(png)) > s.cfg.MaxBodyBytes {
		writeErr(w, http.StatusRequestEntityTooLarge, "payload_too_large", "image exceeds size limit")
		return
	}
	if len(png) == 0 {
		writeErr(w, http.StatusBadRequest, "bad_request", "png is empty")
		return
	}

	// Concurrency cap → 503. Non-blocking acquire: if the encode pool is full, fail fast (the client
	// retries later) rather than queueing unbounded work.
	select {
	case s.sem <- struct{}{}:
		defer func() { <-s.sem }()
	default:
		w.Header().Set("Retry-After", "5")
		writeErr(w, http.StatusServiceUnavailable, "busy", "encoder is busy, retry shortly")
		return
	}

	out, err := s.enc.Encode(r.Context(), encode.Request{
		PNG:     png,
		W:       req.W,
		H:       req.H,
		Op:      encode.KTX2,
		Profile: encode.Profile(req.Profile),
	})
	if err != nil {
		s.mapEncodeError(w, err)
		return
	}

	// Success: return raw KTX2 bytes. The gateway streams these straight into the client zip.
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.Itoa(len(out)))
	w.WriteHeader(http.StatusOK)
	if _, err := w.Write(out); err != nil {
		// Connection dropped mid-write — log WITHOUT any image bytes.
		s.logger.Printf("encode: response write failed (w=%d h=%d): %v", req.W, req.H, err)
	}
}

// mapEncodeError translates an Encoder error into a stable status + code. The full error (which may carry
// a trimmed toktx stderr — never image bytes) is logged SERVER-SIDE; the client gets a generic message.
func (s *Server) mapEncodeError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, encode.ErrUnsupported):
		writeErr(w, http.StatusUnsupportedMediaType, "unsupported_op", "unsupported op or profile")
	case errors.Is(err, encode.ErrEncodeFailed):
		// We log the detail (dimensions + trimmed stderr) but NOT the image bytes.
		s.logger.Printf("encode: %v", err)
		writeErr(w, http.StatusBadGateway, "encode_failed", "encoding failed")
	default:
		s.logger.Printf("encode: unexpected: %v", err)
		writeErr(w, http.StatusInternalServerError, "internal", "internal error")
	}
}

// decodeBase64 accepts standard base64 (padded). The gateway controls the encoding, so we keep it strict.
func decodeBase64(s string) ([]byte, error) {
	return base64.StdEncoding.DecodeString(s)
}
