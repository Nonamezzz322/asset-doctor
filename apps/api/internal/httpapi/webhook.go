package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/stripe/stripe-go/v82"

	"github.com/Nonamezzz322/asset-doctor/apps/api/internal/store"
)

const maxWebhookBody = 1 << 20 // 1 MiB

// handleWebhook is the ONLY endpoint Stripe calls. It verifies the signature, then dispatches by
// event type. Idempotency lives in the store (fulfillments PK), so Stripe's at-least-once retries are
// safe. We always return 200 for events we understand-or-ignore; only signature/parse failures 4xx.
func (s *Server) handleWebhook(w http.ResponseWriter, r *http.Request) {
	payload, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxWebhookBody))
	if err != nil {
		writeErr(w, http.StatusRequestEntityTooLarge, "too_large", "webhook body too large")
		return
	}
	event, err := s.constructEvent(payload, r.Header.Get("Stripe-Signature"))
	if err != nil {
		// Do not leak why; just refuse. Stripe will not retry a 400 indefinitely.
		writeErr(w, http.StatusBadRequest, "bad_signature", "signature verification failed")
		return
	}

	switch event.Type {
	case "checkout.session.completed":
		s.onCheckoutCompleted(w, r, event)
	case "charge.refunded":
		s.onChargeRefunded(w, r, event)
	default:
		// Acknowledge unknown events so Stripe stops retrying them.
		writeJSON(w, http.StatusOK, map[string]string{"status": "ignored"})
	}
}

func (s *Server) onCheckoutCompleted(w http.ResponseWriter, r *http.Request, event stripe.Event) {
	var sess stripe.CheckoutSession
	if err := json.Unmarshal(event.Data.Raw, &sess); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_payload", "unparseable checkout session")
		return
	}
	// Only mint when actually paid (skip unpaid/expired sessions).
	if sess.PaymentStatus != stripe.CheckoutSessionPaymentStatusPaid &&
		sess.PaymentStatus != stripe.CheckoutSessionPaymentStatusNoPaymentRequired {
		writeJSON(w, http.StatusOK, map[string]string{"status": "unpaid"})
		return
	}

	lic := store.License{
		StripeSession: sess.ID,
		Email:         checkoutEmail(&sess),
		Plan:          "pro",
		Seats:         3,
	}
	if sess.Customer != nil {
		lic.StripeCustomer = sess.Customer.ID
	}
	if sess.PaymentIntent != nil {
		lic.StripePaymentIntent = sess.PaymentIntent.ID
	}

	key, created, err := s.store.FulfillCheckout(r.Context(), event.ID, lic, s.mintKey, s.now())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", "could not record fulfillment")
		return
	}
	// The key itself is delivered to the buyer out-of-band (success-page lookup by session id),
	// never logged here. Respond 200 with a non-sensitive ack.
	_ = key
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "created": created})
}

func (s *Server) onChargeRefunded(w http.ResponseWriter, r *http.Request, event stripe.Event) {
	var ch stripe.Charge
	if err := json.Unmarshal(event.Data.Raw, &ch); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_payload", "unparseable charge")
		return
	}
	// Stripe fires charge.refunded for PARTIAL refunds too (a goodwill credit, a partial dispute, or
	// refunding one of several charges on a PaymentIntent). `Refunded` is true ONLY on a full refund.
	// Revoking on a partial refund would cut off a fully-paid customer — so only kill on a full refund.
	if !ch.Refunded {
		writeJSON(w, http.StatusOK, map[string]string{"status": "partial_refund_ignored"})
		return
	}
	pi := ""
	if ch.PaymentIntent != nil {
		pi = ch.PaymentIntent.ID
	}
	_, err := s.store.SetStatusByPaymentIntent(r.Context(), pi, "refunded", s.now())
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusInternalServerError, "internal", "could not apply refund")
		return
	}
	// Not-found is fine (refund for a charge we never minted from) — ack so Stripe stops retrying.
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func checkoutEmail(sess *stripe.CheckoutSession) string {
	if sess.CustomerDetails != nil && sess.CustomerDetails.Email != "" {
		return sess.CustomerDetails.Email
	}
	return sess.CustomerEmail
}
