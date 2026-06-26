package httpapi

import (
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Nonamezzz322/asset-doctor/apps/api/internal/config"
	"github.com/Nonamezzz322/asset-doctor/apps/api/internal/store"
)

const testWebhookSecret = "whsec_test_secret"

var testClock = time.Unix(1_700_000_000, 0)

// newTestServer builds a hermetic server: fixed clock, deterministic key minting, ed25519 test key,
// and a real (signature-verifying) webhook constructor keyed by testWebhookSecret.
func newTestServer(t *testing.T) (*Server, *store.Store, http.Handler) {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{
		Env:                 "development",
		Addr:                ":0",
		StripeWebhookSecret: testWebhookSecret,
		SigningSeed:         priv,
		EntitlementTTL:      7 * 24 * time.Hour,
	}
	st, err := store.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })

	srv := New(cfg, st)
	srv.now = func() time.Time { return testClock }
	n := 0
	srv.mintKey = func() (string, error) { n++; return fmt.Sprintf("AD-KEY-%04d", n), nil }
	srv.allowOrigins = []string{"*"}
	return srv, st, srv.Router()
}

// signStripe builds a valid Stripe-Signature header for `payload` so ConstructEvent accepts it,
// exercising the REAL signature-verification path (not a stub).
func signStripe(payload []byte, ts time.Time) string {
	signedPayload := fmt.Sprintf("%d.%s", ts.Unix(), payload)
	mac := hmac.New(sha256.New, []byte(testWebhookSecret))
	mac.Write([]byte(signedPayload))
	return fmt.Sprintf("t=%d,v1=%s", ts.Unix(), hex.EncodeToString(mac.Sum(nil)))
}

func postWebhook(h http.Handler, payload string, _ time.Time) *httptest.ResponseRecorder {
	// Stripe's ConstructEvent enforces a ±300s tolerance vs real wall-clock, so the SIGNATURE timestamp
	// must be ~now — independent of the server's injected entitlement clock (testClock).
	req := httptest.NewRequest(http.MethodPost, "/v1/stripe/webhook", strings.NewReader(payload))
	req.Header.Set("Stripe-Signature", signStripe([]byte(payload), time.Now()))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func postJSON(h http.Handler, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func checkoutEvent(eventID, sessionID, paymentStatus, pi, email string) string {
	return fmt.Sprintf(`{"id":%q,"object":"event","type":"checkout.session.completed","data":{"object":{"id":%q,"object":"checkout.session","payment_status":%q,"payment_intent":%q,"customer":"cus_1","customer_details":{"email":%q}}}}`,
		eventID, sessionID, paymentStatus, pi, email)
}

func refundEvent(eventID, pi string) string {
	return fmt.Sprintf(`{"id":%q,"object":"event","type":"charge.refunded","data":{"object":{"id":"ch_1","object":"charge","payment_intent":%q,"refunded":true}}}`, eventID, pi)
}

// a PARTIAL refund: charge.refunded fires but `refunded` is false (full-refund flag) and only part of
// the amount was returned.
func partialRefundEvent(eventID, pi string) string {
	return fmt.Sprintf(`{"id":%q,"object":"event","type":"charge.refunded","data":{"object":{"id":"ch_1","object":"charge","payment_intent":%q,"refunded":false,"amount":1000,"amount_refunded":300}}}`, eventID, pi)
}

func postJSONHdr(h http.Handler, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}
