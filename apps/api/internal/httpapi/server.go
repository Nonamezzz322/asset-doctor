// Package httpapi wires the thin-backend's routes. All business state lives in store; this layer only
// validates input, enforces CORS + rate limits, and signs entitlements. The clock and the Stripe
// event constructor are injected so tests run hermetically (no real time, no real Stripe network).
package httpapi

import (
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/stripe/stripe-go/v82"
	"github.com/stripe/stripe-go/v82/webhook"

	"github.com/Nonamezzz322/asset-doctor/apps/api/internal/config"
	"github.com/Nonamezzz322/asset-doctor/apps/api/internal/license"
	"github.com/Nonamezzz322/asset-doctor/apps/api/internal/store"
)

type Server struct {
	cfg   *config.Config
	store *store.Store
	now   func() time.Time
	// constructEvent verifies + parses an inbound webhook. Default verifies the Stripe signature.
	constructEvent func(payload []byte, sigHeader string) (stripe.Event, error)
	// mintKey produces a fresh license key (overridable in tests for determinism).
	mintKey      func() (string, error)
	allowOrigins []string
	// trustedIPHeader: rate-limit key source set by a TRUSTED proxy (empty = use the TCP peer).
	trustedIPHeader string
}

func New(cfg *config.Config, st *store.Store) *Server {
	s := &Server{
		cfg:   cfg,
		store: st,
		now:   time.Now,
		mintKey: license.NewKey,
		constructEvent: func(payload []byte, sig string) (stripe.Event, error) {
			// IgnoreAPIVersionMismatch: stripe-go pins one API version, but the account's webhook may be
			// on a different one — a hard reject there would drop legitimate paid events. We only read
			// stable top-level fields (id/type/session id/payment_status/payment_intent), so skew is safe.
			return webhook.ConstructEventWithOptions(payload, sig, cfg.StripeWebhookSecret, webhook.ConstructEventOptions{
				IgnoreAPIVersionMismatch: true,
			})
		},
		allowOrigins:    splitOrigins(cfg),
		trustedIPHeader: cfg.TrustedIPHeader,
	}
	return s
}

func splitOrigins(cfg *config.Config) []string {
	raw := os.Getenv("ALLOWED_ORIGINS")
	if raw == "" {
		if cfg.IsProd() {
			return nil // prod must set ALLOWED_ORIGINS explicitly
		}
		return []string{"*"}
	}
	var out []string
	for _, o := range strings.Split(raw, ",") {
		if t := strings.TrimSpace(o); t != "" {
			out = append(out, t)
		}
	}
	return out
}

func (s *Server) Router() http.Handler {
	r := chi.NewRouter()
	// NOTE: we deliberately do NOT use chi's middleware.RealIP — it is deprecated precisely because it
	// trusts client-supplied X-Forwarded-For / X-Real-IP / True-Client-IP with no allowlist, which would
	// let an attacker rotate a header per request to defeat the rate limiter. We key the limiter on the
	// TCP peer, or on cfg.TrustedIPHeader when an operator opts into a trusted ingress header.
	r.Use(middleware.Recoverer)
	r.Use(s.cors)

	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, http.StatusOK, map[string]string{"status": "ok"}) })
	r.Get("/v1/pubkey", s.handlePubKey)

	// Stripe → us. Signature-verified inside the handler; NOT rate-limited (Stripe retries legitimately).
	r.Post("/v1/stripe/webhook", s.handleWebhook)

	// Every client-facing route (all of /v1/* except the Stripe webhook) goes through the per-IP
	// limiter — including /v1/history, which writes to the single-conn DB.
	limited := newIPLimiter(10, time.Minute) // 10 req/min/IP
	limitMW := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !limited.allow(s.clientIP(r)) {
				writeErr(w, http.StatusTooManyRequests, "rate_limited", "too many requests, slow down")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
	r.Group(func(r chi.Router) {
		r.Use(limitMW)
		r.Post("/v1/activate", s.handleActivate)
		r.Post("/v1/refresh", s.handleRefresh)
		r.Post("/v1/deactivate", s.handleDeactivate)
		r.Get("/v1/key", s.handleKeyBySession)
		r.Post("/v1/history", s.handleHistory)
	})
	return r
}

// cors permits the configured app origins to call the API (preflight + actual). Credentials are not
// used (no cookies) — the client sends a license key in the body, so a permissive-but-bounded CORS is fine.
func (s *Server) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && s.originAllowed(origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.Header().Set("Access-Control-Max-Age", "600")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) originAllowed(origin string) bool {
	for _, o := range s.allowOrigins {
		if o == "*" || strings.EqualFold(o, origin) {
			return true
		}
	}
	return false
}

func (s *Server) handlePubKey(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"alg":       "ed25519",
		"publicKey": b64std(s.cfg.PublicKey()),
		"v":         license.TokenVersion,
	})
}
