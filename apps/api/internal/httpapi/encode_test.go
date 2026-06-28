package httpapi

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Nonamezzz322/asset-doctor/apps/api/internal/config"
	"github.com/Nonamezzz322/asset-doctor/apps/api/internal/license"
	"github.com/Nonamezzz322/asset-doctor/apps/api/internal/store"
)

// fakeSidecar is a stand-in for apps/encoder. Tests run the FULL gateway (entitlement + quota + proxy +
// error mapping) without a real toktx or a real sidecar process. The handler is swappable per test.
type fakeSidecar struct {
	mu      sync.Mutex
	calls   int
	lastBody []byte
	handler  http.HandlerFunc
}

func (f *fakeSidecar) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	f.mu.Lock()
	f.calls++
	f.lastBody = body
	h := f.handler
	f.mu.Unlock()
	if h != nil {
		h(w, r)
		return
	}
	// default: echo a tiny "KTX2" blob
	w.Header().Set("Content-Type", "application/octet-stream")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("KTX2-OK"))
}

func (f *fakeSidecar) count() int { f.mu.Lock(); defer f.mu.Unlock(); return f.calls }

// newEncodeServer builds a hermetic, NATIVE-ENABLED gateway whose EncoderURL points at the supplied mock
// sidecar. The clock is fixed; the ed25519 key is generated so we can mint matching tokens in-test.
func newEncodeServer(t *testing.T, sc *fakeSidecar) (*Server, http.Handler) {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	side := httptest.NewServer(sc)
	t.Cleanup(side.Close)

	cfg := &config.Config{
		Env:                           "development",
		StripeWebhookSecret:           testWebhookSecret,
		SigningSeed:                   priv,
		EntitlementTTL:                7 * 24 * time.Hour,
		NativeEnabled:                 true,
		EncoderURL:                    side.URL,
		EncodeMaxBodyBytes:            1 << 20, // 1 MiB for fast tests
		EncodeTimeout:                 5 * time.Second,
		EncodeMaxConcurrentPerLicense: 2,
		EncodeDailyQuotaPerLicense:    3,
	}
	st, err := store.Open(t.TempDir() + "/t.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })

	srv := New(cfg, st)
	srv.now = func() time.Time { return testClock }
	// rebuild the quota with the injected (fixed) clock so daily-roll tests are deterministic
	srv.encodeQuota = newLicenseQuota(cfg.EncodeMaxConcurrentPerLicense, cfg.EncodeDailyQuotaPerLicense, srv.now)
	srv.encodeClient = side.Client()
	srv.encodeLogger = log.New(io.Discard, "", 0) // never assert on logs, just silence them
	srv.allowOrigins = []string{"*"}
	return srv, srv.Router()
}

// tokenFor mints a valid entitlement token for `lic` against the server's signing key, valid at testClock.
func tokenFor(t *testing.T, s *Server, lic string) string {
	t.Helper()
	claims := license.NewClaims(lic, "dev-1", "pro", s.now(), s.cfg.EntitlementTTL)
	tok, err := license.Sign(s.cfg.SigningSeed, claims)
	if err != nil {
		t.Fatal(err)
	}
	return tok
}

// expiredTokenFor mints a well-formed token that is already past its exp at testClock.
func expiredTokenFor(t *testing.T, s *Server, lic string) string {
	t.Helper()
	past := s.now().Add(-30 * 24 * time.Hour)
	claims := license.NewClaims(lic, "dev-1", "pro", past, time.Hour) // exp = past+1h, still < now
	tok, err := license.Sign(s.cfg.SigningSeed, claims)
	if err != nil {
		t.Fatal(err)
	}
	return tok
}

func postEncode(h http.Handler, token, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/v1/encode", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

const sampleEncodeBody = `{"png":"UE5HREFUQQ==","w":256,"h":256,"op":"ktx2","profile":"uastc-zstd-mip"}`

func errCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var b errBody
	if err := json.Unmarshal(rec.Body.Bytes(), &b); err != nil {
		t.Fatalf("response body is not a {error,code} envelope: %q", rec.Body.String())
	}
	return b.Code
}

// --- T8: entitlement gate (token verified BEFORE any work) -----------------------------------------

func TestEncodeRequiresToken(t *testing.T) {
	sc := &fakeSidecar{}
	_, h := newEncodeServer(t, sc)
	rec := postEncode(h, "", sampleEncodeBody)
	if rec.Code != http.StatusPaymentRequired {
		t.Fatalf("status = %d, want 402", rec.Code)
	}
	if errCode(t, rec) != "entitlement_required" {
		t.Fatalf("code = %q", errCode(t, rec))
	}
	if sc.count() != 0 {
		t.Fatal("sidecar was called despite missing token (work happened before the gate)")
	}
}

func TestEncodeRejectsBadToken(t *testing.T) {
	sc := &fakeSidecar{}
	_, h := newEncodeServer(t, sc)
	rec := postEncode(h, "not-a-real-token", sampleEncodeBody)
	if rec.Code != http.StatusPaymentRequired {
		t.Fatalf("status = %d, want 402", rec.Code)
	}
	if errCode(t, rec) != "entitlement_invalid" {
		t.Fatalf("code = %q, want entitlement_invalid", errCode(t, rec))
	}
	if sc.count() != 0 {
		t.Fatal("sidecar called with an unverifiable token")
	}
}

func TestEncodeRejectsForeignSignature(t *testing.T) {
	// A token signed by a DIFFERENT key must not pass — proves we verify against OUR public key.
	sc := &fakeSidecar{}
	s, h := newEncodeServer(t, sc)
	_, otherPriv, _ := ed25519.GenerateKey(rand.Reader)
	claims := license.NewClaims("AD-FOREIGN", "dev", "pro", s.now(), time.Hour)
	tok, _ := license.Sign(otherPriv, claims)
	rec := postEncode(h, tok, sampleEncodeBody)
	if rec.Code != http.StatusPaymentRequired || errCode(t, rec) != "entitlement_invalid" {
		t.Fatalf("foreign-signed token accepted: status=%d code=%s", rec.Code, errCode(t, rec))
	}
	if sc.count() != 0 {
		t.Fatal("sidecar called with a foreign-signed token")
	}
}

func TestEncodeRejectsExpiredToken(t *testing.T) {
	sc := &fakeSidecar{}
	s, h := newEncodeServer(t, sc)
	rec := postEncode(h, expiredTokenFor(t, s, "AD-EXP"), sampleEncodeBody)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
	if errCode(t, rec) != "entitlement_expired" {
		t.Fatalf("code = %q, want entitlement_expired", errCode(t, rec))
	}
	if sc.count() != 0 {
		t.Fatal("sidecar called with an expired token")
	}
}

func TestEncodeHappyPathProxies(t *testing.T) {
	sc := &fakeSidecar{}
	s, h := newEncodeServer(t, sc)
	rec := postEncode(h, tokenFor(t, s, "AD-OK"), sampleEncodeBody)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%q, want 200", rec.Code, rec.Body.String())
	}
	if rec.Body.String() != "KTX2-OK" {
		t.Fatalf("proxied body = %q, want the sidecar's bytes", rec.Body.String())
	}
	if sc.count() != 1 {
		t.Fatalf("sidecar calls = %d, want 1", sc.count())
	}
	// The gateway forwards the EXACT body to the sidecar (it does not re-encode the envelope).
	sc.mu.Lock()
	got := string(sc.lastBody)
	sc.mu.Unlock()
	if got != sampleEncodeBody {
		t.Fatalf("forwarded body = %q, want verbatim", got)
	}
}

// --- round13 T8: the gateway is OP-AGNOSTIC — pngquant proxies through entitlement+quota IDENTICALLY ---
//
// The gateway (handleEncode) reads the body and forwards it verbatim; it NEVER inspects `op`/`profile`, so a
// new sidecar op needs ZERO gateway code change. This table-driven test proves the SAME entitlement gate,
// the SAME per-license quota path, and verbatim body-forwarding hold for `op:pngquant` exactly as for
// `op:ktx2` — the only difference is the bytes the (mock) sidecar streams back.
func TestEncodeOpAgnosticProxy(t *testing.T) {
	const ktx2Body = `{"png":"UE5HREFUQQ==","w":256,"h":256,"op":"ktx2","profile":"uastc-zstd-mip"}`
	const pngquantBody = `{"png":"UE5HREFUQQ==","w":256,"h":256,"op":"pngquant","profile":"pngquant-256-fs"}`
	cases := []struct {
		name     string
		body     string
		sidecarCT string
		sidecarOut string
	}{
		{"ktx2", ktx2Body, "application/octet-stream", "KTX2-OK"},
		{"pngquant", pngquantBody, "image/png", "PNGQUANT-OK"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// The sidecar echoes op-specific bytes so we can assert the gateway streams them straight back.
			sc := &fakeSidecar{handler: func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", tc.sidecarCT)
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte(tc.sidecarOut))
			}}
			s, h := newEncodeServer(t, sc)
			rec := postEncode(h, tokenFor(t, s, "AD-OPAG"), tc.body)
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d body=%q, want 200", rec.Code, rec.Body.String())
			}
			if rec.Body.String() != tc.sidecarOut {
				t.Fatalf("proxied body = %q, want the sidecar's %q", rec.Body.String(), tc.sidecarOut)
			}
			if got := rec.Header().Get("Content-Type"); got != tc.sidecarCT {
				t.Fatalf("Content-Type = %q, want %q (relayed verbatim)", got, tc.sidecarCT)
			}
			if sc.count() != 1 {
				t.Fatalf("sidecar calls = %d, want 1", sc.count())
			}
			// The gateway forwards the EXACT body upstream — op/profile ride through untouched (no re-encode).
			sc.mu.Lock()
			got := string(sc.lastBody)
			sc.mu.Unlock()
			if got != tc.body {
				t.Fatalf("forwarded body = %q, want verbatim %q", got, tc.body)
			}
		})
	}
}

// TestEncodePngQuantQuotaShared: the per-license daily quota is OP-AGNOSTIC — a pngquant encode counts
// against the same budget as a ktx2 encode (v1 keeps one quota knob; round13 §3). With dailyQuota=3, three
// pngquant encodes pass and the fourth is rate-limited, exactly as for ktx2.
func TestEncodePngQuantQuotaShared(t *testing.T) {
	const pngquantBody = `{"png":"UE5HREFUQQ==","w":64,"h":64,"op":"pngquant","profile":"pngquant-256-fs"}`
	sc := &fakeSidecar{}
	s, h := newEncodeServer(t, sc) // EncodeDailyQuotaPerLicense = 3
	tok := tokenFor(t, s, "AD-PQ-QUOTA")
	for i := 0; i < 3; i++ {
		if rec := postEncode(h, tok, pngquantBody); rec.Code != http.StatusOK {
			t.Fatalf("encode #%d status = %d, want 200 (within quota)", i+1, rec.Code)
		}
	}
	rec := postEncode(h, tok, pngquantBody)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("4th encode status = %d, want 429 (daily quota)", rec.Code)
	}
	if errCode(t, rec) != "rate_limited" {
		t.Fatalf("code = %q, want rate_limited", errCode(t, rec))
	}
}

// --- T7: route is DEAD when native is OFF (default) -------------------------------------------------

func TestEncodeRouteAbsentWhenNativeOff(t *testing.T) {
	// The standard test server (newTestServer) leaves NativeEnabled=false → no /v1/encode route at all.
	s, _, h := newTestServer(t)
	tok := tokenFor(t, s, "AD-OFF") // even WITH a valid token, the route must not exist
	rec := postEncode(h, tok, sampleEncodeBody)
	if rec.Code != http.StatusNotFound && rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 404/405 (route dead when native OFF)", rec.Code)
	}
}

// --- T9: per-license concurrency → 429 -------------------------------------------------------------

func TestEncodeConcurrencyCap429(t *testing.T) {
	release := make(chan struct{})
	sc := &fakeSidecar{handler: func(w http.ResponseWriter, _ *http.Request) {
		<-release // block so requests pile up against the per-license concurrency cap (=2)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("KTX2-OK"))
	}}
	s, h := newEncodeServer(t, sc)
	tok := tokenFor(t, s, "AD-CC")

	var wg sync.WaitGroup
	codes := make([]int, 2)
	for i := 0; i < 2; i++ { // fill both concurrency slots
		wg.Add(1)
		go func(i int) { defer wg.Done(); codes[i] = postEncode(h, tok, sampleEncodeBody).Code }(i)
	}
	// wait until both are in-flight inside the sidecar
	deadline := time.Now().Add(2 * time.Second)
	for sc.count() < 2 {
		if time.Now().After(deadline) {
			t.Fatal("two requests never reached the sidecar")
		}
		time.Sleep(time.Millisecond)
	}
	// a 3rd request for the SAME license must be rejected 429 before reaching the sidecar
	rec := postEncode(h, tok, sampleEncodeBody)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("3rd concurrent status = %d, want 429", rec.Code)
	}
	if errCode(t, rec) != "rate_limited" {
		t.Fatalf("code = %q, want rate_limited", errCode(t, rec))
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Fatal("429 missing Retry-After")
	}
	if sc.count() != 2 {
		t.Fatalf("sidecar calls = %d, want 2 (3rd never proxied)", sc.count())
	}
	close(release)
	wg.Wait()
}

func TestEncodeConcurrencyIsPerLicense(t *testing.T) {
	release := make(chan struct{})
	sc := &fakeSidecar{handler: func(w http.ResponseWriter, _ *http.Request) {
		<-release
		w.WriteHeader(http.StatusOK)
	}}
	s, h := newEncodeServer(t, sc)
	tokA := tokenFor(t, s, "AD-A")
	tokB := tokenFor(t, s, "AD-B")

	var wg sync.WaitGroup
	for _, tok := range []string{tokA, tokA} { // fill license A's two slots
		wg.Add(1)
		go func(tk string) { defer wg.Done(); postEncode(h, tk, sampleEncodeBody) }(tok)
	}
	deadline := time.Now().Add(2 * time.Second)
	for sc.count() < 2 {
		if time.Now().After(deadline) {
			t.Fatal("license A requests never reached the sidecar")
		}
		time.Sleep(time.Millisecond)
	}
	// license B has its own budget → must NOT be 429'd. Run it concurrently too.
	wg.Add(1)
	var bCode int
	go func() { defer wg.Done(); bCode = postEncode(h, tokB, sampleEncodeBody).Code }()
	deadline = time.Now().Add(2 * time.Second)
	for sc.count() < 3 {
		if time.Now().After(deadline) {
			t.Fatal("license B was wrongly throttled (cross-license interference)")
		}
		time.Sleep(time.Millisecond)
	}
	close(release)
	wg.Wait()
	if bCode != http.StatusOK {
		t.Fatalf("license B status = %d, want 200", bCode)
	}
}

// --- T9: daily quota → 429 -------------------------------------------------------------------------

func TestEncodeDailyQuota429(t *testing.T) {
	sc := &fakeSidecar{} // default echo, returns immediately
	s, h := newEncodeServer(t, sc)
	tok := tokenFor(t, s, "AD-Q") // daily quota = 3
	for i := 0; i < 3; i++ {
		if rec := postEncode(h, tok, sampleEncodeBody); rec.Code != http.StatusOK {
			t.Fatalf("request %d status = %d, want 200", i+1, rec.Code)
		}
	}
	rec := postEncode(h, tok, sampleEncodeBody) // 4th over the daily cap
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("over-quota status = %d, want 429", rec.Code)
	}
	if errCode(t, rec) != "rate_limited" {
		t.Fatalf("code = %q, want rate_limited", errCode(t, rec))
	}
	if sc.count() != 3 {
		t.Fatalf("sidecar calls = %d, want 3 (4th rejected before proxy)", sc.count())
	}
}

func TestEncodeDailyQuotaResetsNextDay(t *testing.T) {
	sc := &fakeSidecar{}
	clock := testClock
	q := newLicenseQuota(2, 1, func() time.Time { return clock })
	if ok, _ := q.acquire("L"); !ok {
		t.Fatal("first acquire should pass")
	}
	q.release("L")
	if ok, reason := q.acquire("L"); ok || reason != "daily_quota" {
		t.Fatalf("second acquire same day: ok=%v reason=%q, want daily_quota", ok, reason)
	}
	clock = clock.Add(24 * time.Hour) // roll to next UTC day
	if ok, _ := q.acquire("L"); !ok {
		t.Fatal("acquire after day roll should pass (daily counter reset)")
	}
	_ = sc
}

// --- T7: dedicated size cap → 413 ------------------------------------------------------------------

func TestEncodeSizeCap413(t *testing.T) {
	sc := &fakeSidecar{}
	s, h := newEncodeServer(t, sc) // EncodeMaxBodyBytes = 1 MiB
	big := `{"png":"` + strings.Repeat("A", 2<<20) + `","w":16,"h":16,"op":"ktx2","profile":"uastc-zstd-mip"}`
	rec := postEncode(h, tokenFor(t, s, "AD-BIG"), big)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", rec.Code)
	}
	if errCode(t, rec) != "payload_too_large" {
		t.Fatalf("code = %q, want payload_too_large", errCode(t, rec))
	}
	if sc.count() != 0 {
		t.Fatal("oversized body was proxied to the sidecar")
	}
}

func TestEncodeSizeCapCheckedAfterEntitlement(t *testing.T) {
	// An oversized body WITHOUT a token must still be a 402 (gate runs first, before we read the body).
	sc := &fakeSidecar{}
	_, h := newEncodeServer(t, sc)
	big := `{"png":"` + strings.Repeat("A", 2<<20) + `"}`
	rec := postEncode(h, "", big)
	if rec.Code != http.StatusPaymentRequired {
		t.Fatalf("status = %d, want 402 (gate before body read)", rec.Code)
	}
}

// --- T11: proxy error mapping ----------------------------------------------------------------------

func TestEncodeProxyRelaysSidecarErrors(t *testing.T) {
	cases := []struct {
		name   string
		status int
		code   string
	}{
		{"unsupported", http.StatusUnsupportedMediaType, "unsupported_op"},
		{"too_large_upstream", http.StatusRequestEntityTooLarge, "payload_too_large"},
		{"encode_failed", http.StatusBadGateway, "encode_failed"},
		{"busy", http.StatusServiceUnavailable, "busy"},
		{"internal", http.StatusInternalServerError, "internal"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sc := &fakeSidecar{handler: func(w http.ResponseWriter, _ *http.Request) {
				writeErr(w, tc.status, tc.code, "sidecar says no")
			}}
			s, h := newEncodeServer(t, sc)
			rec := postEncode(h, tokenFor(t, s, "AD-ERR"), sampleEncodeBody)
			if rec.Code != tc.status {
				t.Fatalf("relayed status = %d, want %d", rec.Code, tc.status)
			}
			if got := errCode(t, rec); got != tc.code {
				t.Fatalf("relayed code = %q, want %q", got, tc.code)
			}
		})
	}
}

func TestEncodeProxyMapsUnreachableSidecar(t *testing.T) {
	// Point the gateway at a dead address → the proxy must map the dial failure to 502, not crash.
	sc := &fakeSidecar{}
	s, h := newEncodeServer(t, sc)
	s.cfg.EncoderURL = "http://127.0.0.1:1" // nothing listens here
	rec := postEncode(h, tokenFor(t, s, "AD-DOWN"), sampleEncodeBody)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rec.Code)
	}
	if errCode(t, rec) != "encoder_unreachable" {
		t.Fatalf("code = %q, want encoder_unreachable", errCode(t, rec))
	}
}

func TestEncodeProxyRelaysRetryAfter(t *testing.T) {
	sc := &fakeSidecar{handler: func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "7")
		writeErr(w, http.StatusServiceUnavailable, "busy", "busy")
	}}
	s, h := newEncodeServer(t, sc)
	rec := postEncode(h, tokenFor(t, s, "AD-BUSY"), sampleEncodeBody)
	if rec.Header().Get("Retry-After") != "7" {
		t.Fatalf("Retry-After = %q, want 7 (relayed from sidecar)", rec.Header().Get("Retry-After"))
	}
}

// --- T13: PUBLIC healthz probe for the encode path (round12) ---------------------------------------

func getEncodeHealthz(h http.Handler) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/v1/encode/healthz", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestEncodeHealthzOKWhenSidecarUp(t *testing.T) {
	// Default fakeSidecar answers 200 on any path → the probe proxies /healthz and returns 200. No token.
	sc := &fakeSidecar{}
	_, h := newEncodeServer(t, sc)
	rec := getEncodeHealthz(h)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (sidecar up, no token required)", rec.Code)
	}
}

func TestEncodeHealthz503WhenSidecarUnhealthy(t *testing.T) {
	// Sidecar /healthz returns non-200 → the probe maps it to 503 encoder_unhealthy (path live, not ready).
	sc := &fakeSidecar{handler: func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusInternalServerError) }}
	_, h := newEncodeServer(t, sc)
	rec := getEncodeHealthz(h)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
	if errCode(t, rec) != "encoder_unhealthy" {
		t.Fatalf("code = %q, want encoder_unhealthy", errCode(t, rec))
	}
}

func TestEncodeHealthz502WhenSidecarUnreachable(t *testing.T) {
	sc := &fakeSidecar{}
	s, h := newEncodeServer(t, sc)
	s.cfg.EncoderURL = "http://127.0.0.1:1" // nothing listens
	rec := getEncodeHealthz(h)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rec.Code)
	}
	if errCode(t, rec) != "encoder_unreachable" {
		t.Fatalf("code = %q, want encoder_unreachable", errCode(t, rec))
	}
}

func TestEncodeHealthzAbsentWhenNativeOff(t *testing.T) {
	// When native is OFF (default) the whole encode group — including the probe — does not exist (404/405).
	_, _, h := newTestServer(t)
	rec := getEncodeHealthz(h)
	if rec.Code != http.StatusNotFound && rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 404/405 (probe dead when native OFF)", rec.Code)
	}
}
