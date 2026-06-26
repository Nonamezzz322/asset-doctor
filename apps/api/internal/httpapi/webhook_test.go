package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestWebhookMintsAndIsIdempotent(t *testing.T) {
	_, st, h := newTestServer(t)
	ctx := context.Background()
	payload := checkoutEvent("evt_1", "cs_1", "paid", "pi_1", "buyer@example.com")

	if rec := postWebhook(h, payload, testClock); rec.Code != http.StatusOK {
		t.Fatalf("first webhook: %d %s", rec.Code, rec.Body)
	}
	lic, err := st.GetLicenseBySession(ctx, "cs_1")
	if err != nil {
		t.Fatalf("license not minted: %v", err)
	}
	if lic.Email != "buyer@example.com" || lic.Status != "active" || lic.StripePaymentIntent != "pi_1" {
		t.Fatalf("license fields wrong: %+v", lic)
	}

	// Stripe retry (same event id) → still exactly one license, created=false
	rec := postWebhook(h, payload, testClock)
	var resp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if rec.Code != http.StatusOK || resp["created"] != false {
		t.Fatalf("retry not idempotent: %d %v", rec.Code, resp)
	}
}

func TestWebhookRejectsBadSignature(t *testing.T) {
	_, _, h := newTestServer(t)
	req := httptest.NewRequest(http.MethodPost, "/v1/stripe/webhook", strings.NewReader(checkoutEvent("e", "cs", "paid", "pi", "x@y.z")))
	req.Header.Set("Stripe-Signature", "t=1,v1=deadbeef")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("bad signature should 400, got %d", rec.Code)
	}
}

func TestWebhookSkipsUnpaid(t *testing.T) {
	_, st, h := newTestServer(t)
	rec := postWebhook(h, checkoutEvent("evt_u", "cs_u", "unpaid", "pi_u", "x@y.z"), testClock)
	if rec.Code != http.StatusOK {
		t.Fatalf("unpaid: %d", rec.Code)
	}
	if _, err := st.GetLicenseBySession(context.Background(), "cs_u"); err == nil {
		t.Fatal("unpaid session must NOT mint a license")
	}
}

func TestWebhookRefundFlipsStatus(t *testing.T) {
	_, st, h := newTestServer(t)
	ctx := context.Background()
	postWebhook(h, checkoutEvent("evt_1", "cs_1", "paid", "pi_77", "x@y.z"), testClock)
	lic, _ := st.GetLicenseBySession(ctx, "cs_1")

	if rec := postWebhook(h, refundEvent("evt_r", "pi_77"), testClock); rec.Code != http.StatusOK {
		t.Fatalf("refund webhook: %d", rec.Code)
	}
	got, _ := st.GetLicense(ctx, lic.Key)
	if got.Status != "refunded" {
		t.Fatalf("status after refund = %q, want refunded", got.Status)
	}
}

func TestWebhookPartialRefundKeepsActive(t *testing.T) {
	_, st, h := newTestServer(t)
	ctx := context.Background()
	postWebhook(h, checkoutEvent("evt_1", "cs_1", "paid", "pi_88", "x@y.z"), testClock)
	lic, _ := st.GetLicenseBySession(ctx, "cs_1")

	// a partial refund (refunded:false) must NOT revoke a fully-paid license
	if rec := postWebhook(h, partialRefundEvent("evt_pr", "pi_88"), testClock); rec.Code != http.StatusOK {
		t.Fatalf("partial refund webhook: %d", rec.Code)
	}
	got, _ := st.GetLicense(ctx, lic.Key)
	if got.Status != "active" {
		t.Fatalf("partial refund wrongly changed status to %q (want active)", got.Status)
	}

	// a subsequent FULL refund still revokes
	postWebhook(h, refundEvent("evt_fr", "pi_88"), testClock)
	got, _ = st.GetLicense(ctx, lic.Key)
	if got.Status != "refunded" {
		t.Fatalf("full refund should revoke, status=%q", got.Status)
	}
}

func TestWebhookUnknownEventAcked(t *testing.T) {
	_, _, h := newTestServer(t)
	payload := `{"id":"evt_x","object":"event","type":"customer.created","data":{"object":{"id":"cus_1"}}}`
	if rec := postWebhook(h, payload, testClock); rec.Code != http.StatusOK {
		t.Fatalf("unknown event should be acked 200, got %d", rec.Code)
	}
}
