package httpapi

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Nonamezzz322/asset-doctor/apps/encoder/internal/config"
	"github.com/Nonamezzz322/asset-doctor/apps/encoder/internal/encode"
)

// fakeEncoder is the mocked exec seam: tests run the FULL HTTP/caps/error-mapping surface WITHOUT toktx
// installed. It can echo bytes, return a classified error, or block until released (to test 503).
type fakeEncoder struct {
	out      []byte
	err      error
	block    chan struct{} // if non-nil, Encode blocks until it's closed (concurrency test)
	mu       sync.Mutex
	calls    int
	lastReq  encode.Request
	sawBytes []byte // records the PNG bytes the encoder received (to assert they never hit logs)
}

func (f *fakeEncoder) Encode(ctx context.Context, req encode.Request) ([]byte, error) {
	f.mu.Lock()
	f.calls++
	f.lastReq = req
	f.sawBytes = req.PNG
	f.mu.Unlock()
	if f.block != nil {
		select {
		case <-f.block:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if f.err != nil {
		return nil, f.err
	}
	return f.out, nil
}

func testCfg() *config.Config {
	c := config.Load()
	c.MaxConcurrent = 2
	c.MaxBodyBytes = 1 << 20 // 1 MiB for fast tests
	c.MaxDim = 4096
	c.MaxPixels = 4096 * 4096
	return c
}

func newTestServer(t *testing.T, enc encode.Encoder) (*Server, *bytes.Buffer) {
	t.Helper()
	var logBuf bytes.Buffer
	logger := log.New(&logBuf, "", 0)
	return New(testCfg(), enc, logger), &logBuf
}

func validProcessBody(png []byte, w, h int) string {
	b, _ := json.Marshal(processRequest{
		PNG:     base64.StdEncoding.EncodeToString(png),
		W:       w,
		H:       h,
		Op:      "ktx2",
		Profile: "uastc-zstd-mip",
	})
	return string(b)
}

func do(s *Server, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	rec := httptest.NewRecorder()
	s.Router().ServeHTTP(rec, req)
	return rec
}

func decodeErr(t *testing.T, rec *httptest.ResponseRecorder) errBody {
	t.Helper()
	var e errBody
	if err := json.Unmarshal(rec.Body.Bytes(), &e); err != nil {
		t.Fatalf("response is not JSON errBody: %v (body=%q)", err, rec.Body.String())
	}
	return e
}

func TestHealthz(t *testing.T) {
	s, _ := newTestServer(t, &fakeEncoder{})
	rec := do(s, http.MethodGet, "/healthz", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("healthz status = %d, want 200", rec.Code)
	}
	var b healthzBody
	if err := json.Unmarshal(rec.Body.Bytes(), &b); err != nil {
		t.Fatalf("healthz body not JSON: %v", err)
	}
	if b.Status != "ok" {
		t.Fatalf("healthz status field = %q, want ok", b.Status)
	}
	// Healthz must NOT leak the toktx path/version.
	if strings.Contains(rec.Body.String(), "toktx") {
		t.Fatalf("healthz leaks binary inventory: %s", rec.Body.String())
	}
}

func TestProcessSuccess(t *testing.T) {
	want := []byte("KTX2-FAKE-BYTES")
	fe := &fakeEncoder{out: want}
	s, _ := newTestServer(t, fe)
	rec := do(s, http.MethodPost, "/process", validProcessBody([]byte("PNGDATA"), 256, 256))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%q, want 200", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/octet-stream" {
		t.Fatalf("content-type = %q, want application/octet-stream", ct)
	}
	if !bytes.Equal(rec.Body.Bytes(), want) {
		t.Fatalf("body = %q, want %q", rec.Body.Bytes(), want)
	}
	if fe.lastReq.Op != encode.KTX2 || fe.lastReq.Profile != encode.ProfileUASTCZstdMip {
		t.Fatalf("encoder got op=%q profile=%q", fe.lastReq.Op, fe.lastReq.Profile)
	}
	if string(fe.lastReq.PNG) != "PNGDATA" {
		t.Fatalf("encoder PNG mismatch: %q", fe.lastReq.PNG)
	}
}

func TestProcessBadJSON(t *testing.T) {
	s, _ := newTestServer(t, &fakeEncoder{})
	rec := do(s, http.MethodPost, "/process", "{not json")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if c := decodeErr(t, rec).Code; c != "bad_request" {
		t.Fatalf("code = %q, want bad_request", c)
	}
}

func TestProcessUnknownField(t *testing.T) {
	s, _ := newTestServer(t, &fakeEncoder{})
	rec := do(s, http.MethodPost, "/process", `{"png":"AA==","w":16,"h":16,"op":"ktx2","profile":"uastc-zstd-mip","evil":1}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unknown field status = %d, want 400", rec.Code)
	}
}

func TestProcessUnsupportedOp(t *testing.T) {
	s, _ := newTestServer(t, &fakeEncoder{})
	body, _ := json.Marshal(processRequest{PNG: base64.StdEncoding.EncodeToString([]byte("x")), W: 16, H: 16, Op: "jpeg", Profile: "uastc-zstd-mip"})
	rec := do(s, http.MethodPost, "/process", string(body))
	if rec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("status = %d, want 415", rec.Code)
	}
	if c := decodeErr(t, rec).Code; c != "unsupported_op" {
		t.Fatalf("code = %q, want unsupported_op", c)
	}
}

func TestProcessUnsupportedProfile(t *testing.T) {
	s, _ := newTestServer(t, &fakeEncoder{})
	body, _ := json.Marshal(processRequest{PNG: base64.StdEncoding.EncodeToString([]byte("x")), W: 16, H: 16, Op: "ktx2", Profile: "etc1s-fast"})
	rec := do(s, http.MethodPost, "/process", string(body))
	if rec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("status = %d, want 415", rec.Code)
	}
	if c := decodeErr(t, rec).Code; c != "unsupported_profile" {
		t.Fatalf("code = %q, want unsupported_profile", c)
	}
}

func TestProcessDimensionCaps(t *testing.T) {
	s, _ := newTestServer(t, &fakeEncoder{out: []byte("x")})
	cases := []struct {
		name string
		w, h int
		code string
	}{
		{"zero w", 0, 16, "dimensions_out_of_range"},
		{"negative h", 16, -1, "dimensions_out_of_range"},
		{"oversize w", 4097, 16, "dimensions_out_of_range"},
		{"oversize h", 16, 4097, "dimensions_out_of_range"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := do(s, http.MethodPost, "/process", validProcessBody([]byte("x"), tc.w, tc.h))
			if rec.Code != http.StatusUnsupportedMediaType {
				t.Fatalf("status = %d, want 415", rec.Code)
			}
			if c := decodeErr(t, rec).Code; c != tc.code {
				t.Fatalf("code = %q, want %q", c, tc.code)
			}
		})
	}
}

func TestProcessPixelCap(t *testing.T) {
	s, _ := newTestServer(t, &fakeEncoder{out: []byte("x")})
	// Within per-side cap (4096) but exceeds MaxPixels when both near the edge would be fine; use a case
	// where w*h > MaxPixels but each side <= MaxDim. MaxPixels = 4096*4096; 4096*4096 is OK, push over via
	// a config tweak: shrink MaxPixels.
	s.cfg.MaxPixels = 1000
	rec := do(s, http.MethodPost, "/process", validProcessBody([]byte("x"), 64, 64)) // 4096 px > 1000
	if rec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("status = %d, want 415", rec.Code)
	}
	if c := decodeErr(t, rec).Code; c != "too_many_pixels" {
		t.Fatalf("code = %q, want too_many_pixels", c)
	}
}

func TestProcessBodyTooLarge(t *testing.T) {
	s, _ := newTestServer(t, &fakeEncoder{out: []byte("x")})
	s.cfg.MaxBodyBytes = 64 // tiny cap; the MaxBytesReader headroom is 2x = 128 raw bytes
	// Build a JSON body well over 128 raw bytes so the MaxBytesReader trips → 413.
	big := strings.Repeat("A", 4096)
	body := validProcessBody([]byte(big), 16, 16)
	rec := do(s, http.MethodPost, "/process", body)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d body=%q, want 413", rec.Code, rec.Body.String())
	}
	if c := decodeErr(t, rec).Code; c != "payload_too_large" {
		t.Fatalf("code = %q, want payload_too_large", c)
	}
}

func TestProcessDecodedImageTooLarge(t *testing.T) {
	// The DECODED PNG exceeds MaxBodyBytes, but the raw JSON body stays under the MaxBytesReader cap
	// (MaxBodyBytes*2), so we exercise the explicit decoded-size 413 (not the reader-level 413).
	// base64 inflates by ~4/3, so with MaxBodyBytes=1000 the reader cap is 2000 chars and a 1100-byte PNG
	// base64-encodes to ~1468 chars + a ~70-char envelope ≈ 1538 < 2000.
	s, _ := newTestServer(t, &fakeEncoder{out: []byte("x")})
	s.cfg.MaxBodyBytes = 1000
	png := bytes.Repeat([]byte("Z"), 1100) // decoded 1100 > 1000 cap
	body := validProcessBody(png, 16, 16)
	if int64(len(body)) >= s.cfg.MaxBodyBytes*2 {
		t.Fatalf("test sizing wrong: body %d >= reader cap %d", len(body), s.cfg.MaxBodyBytes*2)
	}
	rec := do(s, http.MethodPost, "/process", body)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d body=%q, want 413", rec.Code, rec.Body.String())
	}
	if c := decodeErr(t, rec).Code; c != "payload_too_large" {
		t.Fatalf("code = %q, want payload_too_large", c)
	}
}

func TestProcessEmptyPNG(t *testing.T) {
	s, _ := newTestServer(t, &fakeEncoder{out: []byte("x")})
	rec := do(s, http.MethodPost, "/process", validProcessBody([]byte{}, 16, 16))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestProcessBadBase64(t *testing.T) {
	s, _ := newTestServer(t, &fakeEncoder{out: []byte("x")})
	body, _ := json.Marshal(processRequest{PNG: "!!!not-base64!!!", W: 16, H: 16, Op: "ktx2", Profile: "uastc-zstd-mip"})
	rec := do(s, http.MethodPost, "/process", string(body))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestEncodeErrorMapping(t *testing.T) {
	cases := []struct {
		name string
		err  error
		code int
		ecod string
	}{
		{"unsupported", encode.ErrUnsupported, http.StatusUnsupportedMediaType, "unsupported_op"},
		{"encode failed", encode.ErrEncodeFailed, http.StatusBadGateway, "encode_failed"},
		{"unexpected", io.ErrUnexpectedEOF, http.StatusInternalServerError, "internal"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s, _ := newTestServer(t, &fakeEncoder{err: tc.err})
			rec := do(s, http.MethodPost, "/process", validProcessBody([]byte("PNGDATA"), 64, 64))
			if rec.Code != tc.code {
				t.Fatalf("status = %d, want %d", rec.Code, tc.code)
			}
			if c := decodeErr(t, rec).Code; c != tc.ecod {
				t.Fatalf("code = %q, want %q", c, tc.ecod)
			}
		})
	}
}

func TestConcurrencyCap503(t *testing.T) {
	block := make(chan struct{})
	fe := &fakeEncoder{out: []byte("ok"), block: block}
	s, _ := newTestServer(t, fe) // MaxConcurrent = 2
	body := validProcessBody([]byte("PNGDATA"), 64, 64)

	// Launch 2 blocking requests to fill the semaphore.
	var wg sync.WaitGroup
	started := make(chan struct{}, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			started <- struct{}{}
			do(s, http.MethodPost, "/process", body)
		}()
	}
	// Wait until both goroutines have entered and (almost certainly) acquired the semaphore.
	<-started
	<-started
	// Give the handlers a moment to acquire the semaphore before the in-flight encode blocks.
	deadline := time.After(2 * time.Second)
	for {
		fe.mu.Lock()
		calls := fe.calls
		fe.mu.Unlock()
		if calls >= 2 {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("encoder never reached 2 in-flight calls (got %d)", calls)
		default:
			time.Sleep(2 * time.Millisecond)
		}
	}

	// 3rd request must be rejected with 503 (semaphore full).
	rec := do(s, http.MethodPost, "/process", body)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("3rd request status = %d, want 503", rec.Code)
	}
	if c := decodeErr(t, rec).Code; c != "busy" {
		t.Fatalf("code = %q, want busy", c)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Fatalf("503 missing Retry-After header")
	}

	close(block) // release the two blocked encodes
	wg.Wait()
}

// TestNoImageByteLogging asserts the recognizable image-byte marker never appears in the log buffer on
// the error path (the path that logs the most detail).
func TestNoImageByteLogging(t *testing.T) {
	const marker = "SECRET-IMAGE-PIXELS-DO-NOT-LOG"
	fe := &fakeEncoder{err: encode.ErrEncodeFailed}
	s, logBuf := newTestServer(t, fe)
	rec := do(s, http.MethodPost, "/process", validProcessBody([]byte(marker), 64, 64))
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rec.Code)
	}
	if strings.Contains(logBuf.String(), marker) {
		t.Fatalf("image bytes leaked into logs: %s", logBuf.String())
	}
	// And the client response must not echo the bytes either.
	if strings.Contains(rec.Body.String(), marker) {
		t.Fatalf("image bytes leaked into response: %s", rec.Body.String())
	}
}
