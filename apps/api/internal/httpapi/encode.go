package httpapi

// This file implements the OPT-IN native-encode GATEWAY (round12 T7–T11). It is the auth/quota/proxy
// front for the apps/encoder sidecar. apps/api stays DISTROLESS and THIN: it does NO native work and
// NEVER touches SQLite on this path. It only (1) verifies the license entitlement BEFORE any work,
// (2) applies an in-memory per-license concurrency + daily-quota cap, (3) reverse-proxies the verified
// request to the sidecar on the internal network, mapping sidecar errors to the standard {error,code}.
//
// SAFETY (load-bearing): when cfg.NativeEnabled is false the route below is never registered, so the
// whole path is dead and client behavior is byte-identical to a build without this feature. Assets ride
// this path ONLY after explicit per-run user consent in the browser; the server keeps NOTHING and never
// logs image bytes.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Nonamezzz322/asset-doctor/apps/api/internal/license"
)

// isMaxBytes reports whether err is the MaxBytesReader overflow (→ 413).
func isMaxBytes(err error) bool {
	var mbe *http.MaxBytesError
	return errors.As(err, &mbe)
}

// hashLic returns a short, non-reversible tag for a license id so diagnostic logs can correlate without
// recording the raw key. Never log the key itself.
func hashLic(lic string) string {
	sum := sha256.Sum256([]byte(lic))
	return hex.EncodeToString(sum[:6])
}

// logEncode emits a diagnostic line that NEVER contains image bytes or the raw license key.
func (s *Server) logEncode(format string, args ...any) {
	if s.encodeLogger != nil {
		s.encodeLogger.Printf(format, args...)
	}
}

// ctxKeyLicense carries the verified license id from the entitlement middleware to the handler. Using a
// private type avoids collisions with any other context value.
type ctxKeyLicense struct{}

// encodeBearerToken pulls the entitlement token from a "Authorization: Bearer <token>" header. We use the
// standard header (not the JSON body) because the body is the image envelope, proxied verbatim upstream.
func encodeBearerToken(r *http.Request) string {
	h := r.Header.Get("Authorization")
	const p = "Bearer "
	if len(h) > len(p) && strings.EqualFold(h[:len(p)], p) {
		return strings.TrimSpace(h[len(p):])
	}
	return ""
}

// entitlement is the gate that runs BEFORE any work: it verifies the ed25519 token against the server's
// public key and rejects an expired one. A bad/absent token → 402 (payment/entitlement required); a
// well-formed but expired token → 403. This closes the "free CPU" hole (no endpoint verified the token
// server-side before this). On success the license id is stashed for the quota keyer.
func (s *Server) entitlement(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tok := encodeBearerToken(r)
		if tok == "" {
			writeErr(w, http.StatusPaymentRequired, "entitlement_required", "missing entitlement token")
			return
		}
		claims, err := license.Verify(s.cfg.PublicKey(), tok)
		if err != nil {
			// Malformed / bad-signature / unsupported-version → not entitled. We do NOT leak which.
			writeErr(w, http.StatusPaymentRequired, "entitlement_invalid", "invalid entitlement token")
			return
		}
		if claims.Expired(s.now()) {
			writeErr(w, http.StatusForbidden, "entitlement_expired", "entitlement expired; refresh and retry")
			return
		}
		if claims.Lic == "" {
			writeErr(w, http.StatusForbidden, "entitlement_invalid", "entitlement has no license")
			return
		}
		ctx := context.WithValue(r.Context(), ctxKeyLicense{}, claims.Lic)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// licenseQuota bounds native-encode use per license, keyed on the token's `lic` claim and held entirely
// IN MEMORY (never SQLite — the encode path must not touch the single-conn billing DB). Two limits:
//   - concurrency: at most `maxConcurrent` simultaneous in-flight encodes per license.
//   - daily: at most `dailyQuota` encodes per license per UTC day; the counter resets at the UTC date roll.
//
// Both over-limit cases return 429 with a Retry-After. The map is keyed by license id; a tiny per-license
// struct holds the live counter and the day's used count. This is intentionally simple — at this scale a
// mutex-guarded map is plenty.
type licenseQuota struct {
	mu           sync.Mutex
	maxConcurrent int
	dailyQuota   int
	clock        func() time.Time
	entries      map[string]*quotaEntry
}

type quotaEntry struct {
	inflight int    // currently-running encodes
	day      string // UTC date "2006-01-02" the `used` counter belongs to
	used     int    // encodes counted for `day`
}

func newLicenseQuota(maxConcurrent, dailyQuota int, clock func() time.Time) *licenseQuota {
	if clock == nil {
		clock = time.Now
	}
	return &licenseQuota{
		maxConcurrent: maxConcurrent,
		dailyQuota:    dailyQuota,
		clock:         clock,
		entries:       map[string]*quotaEntry{},
	}
}

// acquire reserves a slot for one encode by `lic`. It returns ok=false (with a reason) when either the
// concurrency cap or the daily quota would be exceeded; the caller must NOT call release in that case.
// On ok=true the caller MUST call release exactly once (defer) when the encode finishes.
func (q *licenseQuota) acquire(lic string) (ok bool, reason string) {
	q.mu.Lock()
	defer q.mu.Unlock()
	today := q.clock().UTC().Format("2006-01-02")
	e := q.entries[lic]
	if e == nil {
		e = &quotaEntry{day: today}
		q.entries[lic] = e
	}
	if e.day != today { // UTC date rolled over → reset the daily counter
		e.day = today
		e.used = 0
	}
	if e.inflight >= q.maxConcurrent {
		return false, "concurrency"
	}
	if e.used >= q.dailyQuota {
		return false, "daily_quota"
	}
	e.inflight++
	e.used++
	return true, ""
}

// release frees a concurrency slot. The daily `used` count is NOT decremented (a daily quota counts
// attempts that did work, not concurrent peak).
func (q *licenseQuota) release(lic string) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if e := q.entries[lic]; e != nil && e.inflight > 0 {
		e.inflight--
	}
}

// handleEncodeHealthz is the PUBLIC liveness probe for the encode path (round12 T13). It exists only when
// native encoding is enabled (registered behind that guard), so its mere presence already signals the path
// is live; it additionally pings the sidecar's /healthz so a 200 means the encoder is actually reachable.
// No token, no body, no quota — a probe must be cheap and unauthenticated so the browser can decide whether
// to even OFFER the opt-in consent step before any license token goes on the wire. NEVER logs image bytes.
func (s *Server) handleEncodeHealthz(w http.ResponseWriter, r *http.Request) {
	// Short, independent timeout — a probe must not hang the UI on a slow/dead sidecar.
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.cfg.EncoderURL+"/healthz", nil)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "encoder_unreachable", "encoder service is unavailable")
		return
	}
	resp, err := s.encodeClient.Do(req)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "encoder_unreachable", "encoder service is unavailable")
		return
	}
	defer resp.Body.Close()
	// Drain so the connection can be reused; we relay only liveness, never the sidecar's body.
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusOK {
		writeErr(w, http.StatusServiceUnavailable, "encoder_unhealthy", "encoder is not ready")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleEncode is the proxy handler. By the time it runs, the token is already verified (entitlement
// middleware) and the license id is in the context. It bounds the body, applies the per-license quota,
// then forwards the EXACT body to the sidecar's POST /process and streams the response back. apps/api
// holds nothing: no temp files, no DB writes, no image-byte logging.
func (s *Server) handleEncode(w http.ResponseWriter, r *http.Request) {
	lic, _ := r.Context().Value(ctxKeyLicense{}).(string)
	if lic == "" { // defensive: middleware guarantees this, but never proxy unverified
		writeErr(w, http.StatusPaymentRequired, "entitlement_required", "missing entitlement token")
		return
	}

	// Per-license concurrency + daily quota → 429. Checked BEFORE we read the (large) body so a
	// rate-limited caller is rejected cheaply.
	if ok, reason := s.encodeQuota.acquire(lic); !ok {
		w.Header().Set("Retry-After", "60")
		writeErr(w, http.StatusTooManyRequests, "rate_limited", "encode quota exceeded ("+reason+")")
		return
	}
	defer s.encodeQuota.release(lic)

	// Dedicated large-body reader — NOT the 16 KiB decodeJSON used for billing. A MaxBytesReader overflow
	// surfaces as an *http.MaxBytesError when we read; we map that to 413 below. We read the whole body so
	// we can re-send it upstream with a clean Content-Length (no chunked-vs-length ambiguity).
	r.Body = http.MaxBytesReader(w, r.Body, s.cfg.EncodeMaxBodyBytes)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		if isMaxBytes(err) {
			writeErr(w, http.StatusRequestEntityTooLarge, "payload_too_large", "request body exceeds limit")
			return
		}
		writeErr(w, http.StatusBadRequest, "bad_request", "could not read request body")
		return
	}

	// This route legitimately runs much longer than the server's short billing WriteTimeout (UASTC RDO is
	// slow). Extend the per-request write deadline so the proxy isn't killed mid-encode; the upstream call
	// still has its own hard EncodeTimeout below. ResponseController is a no-op on writers that don't
	// support deadlines (e.g. httptest), which is fine.
	rc := http.NewResponseController(w)
	_ = rc.SetWriteDeadline(s.now().Add(s.cfg.EncodeTimeout + 30*time.Second))

	ctx, cancel := context.WithTimeout(r.Context(), s.cfg.EncodeTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.cfg.EncoderURL+"/process", strings.NewReader(string(body)))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", "could not build upstream request")
		return
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.encodeClient.Do(req)
	if err != nil {
		// Network failure / timeout / sidecar down → 502 (bad gateway). We never expose the upstream URL.
		writeErr(w, http.StatusBadGateway, "encoder_unreachable", "encoder service is unavailable")
		return
	}
	defer resp.Body.Close()

	// Pass the sidecar's status + body straight through. The sidecar already speaks our {error,code}
	// envelope on errors and raw octet-stream KTX2 bytes on success, so there is nothing to translate;
	// we just relay it (mapping is identity for known codes). We copy a minimal, safe set of headers.
	ct := resp.Header.Get("Content-Type")
	if ct == "" {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	if ra := resp.Header.Get("Retry-After"); ra != "" {
		w.Header().Set("Retry-After", ra)
	}
	if cl := resp.Header.Get("Content-Length"); cl != "" {
		if _, err := strconv.Atoi(cl); err == nil {
			w.Header().Set("Content-Length", cl)
		}
	}
	w.WriteHeader(resp.StatusCode)
	// Stream the body. On a write/read error mid-stream we can no longer change the status; log WITHOUT
	// any image bytes.
	if _, err := io.Copy(w, resp.Body); err != nil {
		s.logEncode("encode proxy: relay failed (lic-hash=%s, upstream=%d): %v", hashLic(lic), resp.StatusCode, err)
	}
}
