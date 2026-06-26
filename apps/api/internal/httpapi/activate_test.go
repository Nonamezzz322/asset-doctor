package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Nonamezzz322/asset-doctor/apps/api/internal/license"
	"github.com/Nonamezzz322/asset-doctor/apps/api/internal/store"
)

// seed mints a license directly with a known key + seat count.
func seed(t *testing.T, st *store.Store, key string, seats int) {
	t.Helper()
	_, _, err := st.FulfillCheckout(context.Background(), "seed-"+key, store.License{StripeSession: "cs-" + key, Seats: seats}, func() (string, error) { return key, nil }, testClock)
	if err != nil {
		t.Fatal(err)
	}
}

func decodeToken(t *testing.T, rec *httptest.ResponseRecorder) tokenResp {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
	var r tokenResp
	if err := json.Unmarshal(rec.Body.Bytes(), &r); err != nil {
		t.Fatal(err)
	}
	return r
}

func TestActivateReturnsVerifiableToken(t *testing.T) {
	srv, st, h := newTestServer(t)
	seed(t, st, "AD-AAAA-BBBB-CCCC-DDDD", 3)

	rec := postJSON(h, "/v1/activate", `{"key":"ad-aaaa-bbbb-cccc-dddd","device":"dev-1","label":"laptop"}`)
	tr := decodeToken(t, rec)

	// the entitlement must verify with the server's public key (the exact contract the browser uses)
	claims, err := license.Verify(srv.cfg.PublicKey(), tr.Token)
	if err != nil {
		t.Fatalf("token does not verify: %v", err)
	}
	if claims.Lic != "AD-AAAA-BBBB-CCCC-DDDD" || claims.Dev != "dev-1" || claims.Plan != "pro" {
		t.Fatalf("claims wrong: %+v", claims)
	}
	if tr.Exp != testClock.Add(7*24*time.Hour).Unix() {
		t.Fatalf("exp wrong: %d", tr.Exp)
	}
	if tr.ActiveDevices != 1 {
		t.Fatalf("activeDevices = %d", tr.ActiveDevices)
	}
}

func TestActivateSeatExceeded(t *testing.T) {
	_, st, h := newTestServer(t)
	seed(t, st, "AD-ONE-SEAT", 1)
	if rec := postJSON(h, "/v1/activate", `{"key":"AD-ONE-SEAT","device":"d1"}`); rec.Code != http.StatusOK {
		t.Fatalf("d1: %d %s", rec.Code, rec.Body)
	}
	rec := postJSON(h, "/v1/activate", `{"key":"AD-ONE-SEAT","device":"d2"}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("d2 should 409, got %d", rec.Code)
	}
	var e errBody
	_ = json.Unmarshal(rec.Body.Bytes(), &e)
	if e.Code != "seats_exceeded" {
		t.Fatalf("code = %q", e.Code)
	}
}

func TestActivateUnknownKey(t *testing.T) {
	_, _, h := newTestServer(t)
	rec := postJSON(h, "/v1/activate", `{"key":"AD-NOPE","device":"d1"}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown key should 404, got %d", rec.Code)
	}
}

func TestActivateBadInput(t *testing.T) {
	_, _, h := newTestServer(t)
	for _, body := range []string{`{"device":"d1"}`, `{"key":"AD-X"}`, `{"key":"AD-X","device":"d1","bogus":1}`, `not json`} {
		if rec := postJSON(h, "/v1/activate", body); rec.Code != http.StatusBadRequest {
			t.Fatalf("body %q should 400, got %d", body, rec.Code)
		}
	}
}

func TestRefreshLifecycle(t *testing.T) {
	srv, st, h := newTestServer(t)
	seed(t, st, "AD-REF", 3)
	postJSON(h, "/v1/activate", `{"key":"AD-REF","device":"d1"}`)

	// refresh works while active
	tr := decodeToken(t, postJSON(h, "/v1/refresh", `{"key":"AD-REF","device":"d1"}`))
	if _, err := license.Verify(srv.cfg.PublicKey(), tr.Token); err != nil {
		t.Fatalf("refreshed token bad: %v", err)
	}

	// deactivate → refresh must tell the client to re-activate
	if rec := postJSON(h, "/v1/deactivate", `{"key":"AD-REF","device":"d1"}`); rec.Code != http.StatusOK {
		t.Fatalf("deactivate: %d", rec.Code)
	}
	rec := postJSON(h, "/v1/refresh", `{"key":"AD-REF","device":"d1"}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("refresh after deactivate should 404, got %d", rec.Code)
	}
	var e errBody
	_ = json.Unmarshal(rec.Body.Bytes(), &e)
	if e.Code != "reactivate" {
		t.Fatalf("code = %q", e.Code)
	}
}

func TestRefreshAfterRefundDeclines(t *testing.T) {
	_, st, h := newTestServer(t)
	seed(t, st, "AD-RF", 3)
	postJSON(h, "/v1/activate", `{"key":"AD-RF","device":"d1"}`)
	_ = st.SetStatus(context.Background(), "AD-RF", "refunded", testClock)

	rec := postJSON(h, "/v1/refresh", `{"key":"AD-RF","device":"d1"}`)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("refresh after refund should 403, got %d", rec.Code)
	}
}

func TestKeyBySession(t *testing.T) {
	_, st, h := newTestServer(t)
	seed(t, st, "AD-SESS", 3) // session id = "cs-AD-SESS"
	_ = st

	req := httptest.NewRequest(http.MethodGet, "/v1/key?session_id=cs-AD-SESS", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("key lookup: %d %s", rec.Code, rec.Body)
	}
	var resp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp["key"] != "AD-SESS" {
		t.Fatalf("key = %v", resp["key"])
	}

	// unknown session → 404 pending
	req2 := httptest.NewRequest(http.MethodGet, "/v1/key?session_id=cs-unknown", nil)
	rec2 := httptest.NewRecorder()
	h.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusNotFound {
		t.Fatalf("unknown session should 404, got %d", rec2.Code)
	}
}

func TestRateLimit(t *testing.T) {
	_, st, h := newTestServer(t)
	seed(t, st, "AD-RL", 3)
	limited := false
	for i := 0; i < 12; i++ { // all share httptest's default RemoteAddr → same IP bucket
		rec := postJSON(h, "/v1/activate", `{"key":"AD-RL","device":"d1"}`)
		if rec.Code == http.StatusTooManyRequests {
			limited = true
			break
		}
	}
	if !limited {
		t.Fatal("expected a 429 within 12 requests at 10/min")
	}
}

func TestRateLimitNotBypassedBySpoofedHeaders(t *testing.T) {
	_, st, h := newTestServer(t) // trustedIPHeader == "" → keys on the TCP peer
	seed(t, st, "AD-SP", 3)
	limited := false
	for i := 0; i < 12; i++ {
		// rotate forgeable proxy headers every request; RemoteAddr (httptest default) stays constant
		rec := postJSONHdr(h, "/v1/activate", `{"key":"AD-SP","device":"d1"}`, map[string]string{
			"X-Forwarded-For": fmt.Sprintf("9.9.9.%d", i),
			"X-Real-IP":       fmt.Sprintf("8.8.8.%d", i),
			"True-Client-IP":  fmt.Sprintf("7.7.7.%d", i),
		})
		if rec.Code == http.StatusTooManyRequests {
			limited = true
			break
		}
	}
	if !limited {
		t.Fatal("spoofed forwarded headers bypassed the limiter — should key on the TCP peer")
	}
}

func TestTrustedIPHeaderKeysBuckets(t *testing.T) {
	srv, st, h := newTestServer(t)
	srv.trustedIPHeader = "Fly-Client-IP" // read live by clientIP
	seed(t, st, "AD-TR", 3)

	// distinct trusted-header values → distinct buckets → no 429 even past the per-IP cap
	for i := 0; i < 15; i++ {
		rec := postJSONHdr(h, "/v1/activate", `{"key":"AD-TR","device":"d1"}`, map[string]string{"Fly-Client-IP": fmt.Sprintf("5.5.5.%d", i)})
		if rec.Code == http.StatusTooManyRequests {
			t.Fatalf("distinct trusted IPs share a bucket (req %d)", i)
		}
	}
	// same trusted value → one bucket → 429 fires
	limited := false
	for i := 0; i < 15; i++ {
		rec := postJSONHdr(h, "/v1/activate", `{"key":"AD-TR","device":"d1"}`, map[string]string{"Fly-Client-IP": "6.6.6.6"})
		if rec.Code == http.StatusTooManyRequests {
			limited = true
			break
		}
	}
	if !limited {
		t.Fatal("same trusted IP should hit the limiter")
	}
}

func TestHistorySchemaEnforced(t *testing.T) {
	srv, st, h := newTestServer(t)
	srv.cfg.HistoryEnabled = true // handler reads cfg live
	seed(t, st, "AD-H", 3)
	postJSON(h, "/v1/activate", `{"key":"AD-H","device":"d1"}`)

	// valid: only the known numeric fields
	if rec := postJSON(h, "/v1/history", `{"key":"AD-H","device":"d1","metrics":{"diskBytesBefore":100,"diskBytesAfter":40,"savedPct":60}}`); rec.Code != http.StatusOK {
		t.Fatalf("valid metrics: %d %s", rec.Code, rec.Body)
	}
	// rejected: an unknown field inside metrics (could smuggle asset data) → 400
	if rec := postJSON(h, "/v1/history", `{"key":"AD-H","device":"d1","metrics":{"thumbnail":"data:image/png;base64,AAAA"}}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("unknown metric field should 400, got %d", rec.Code)
	}
	// rejected: a non-numeric value where a number is required → 400
	if rec := postJSON(h, "/v1/history", `{"key":"AD-H","device":"d1","metrics":{"diskBytesBefore":"lots"}}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("non-numeric metric should 400, got %d", rec.Code)
	}
}

func TestCORSPreflight(t *testing.T) {
	_, _, h := newTestServer(t)
	req := httptest.NewRequest(http.MethodOptions, "/v1/activate", nil)
	req.Header.Set("Origin", "https://nonamezzz322.github.io")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("preflight should 204, got %d", rec.Code)
	}
	if rec.Header().Get("Access-Control-Allow-Origin") == "" {
		t.Fatal("missing CORS allow-origin")
	}
}

func TestPubKeyEndpoint(t *testing.T) {
	srv, _, h := newTestServer(t)
	req := httptest.NewRequest(http.MethodGet, "/v1/pubkey", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	var resp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp["alg"] != "ed25519" || resp["publicKey"] != b64std(srv.cfg.PublicKey()) {
		t.Fatalf("pubkey endpoint wrong: %v", resp)
	}
}
