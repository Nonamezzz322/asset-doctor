// Package config loads the thin-backend's runtime configuration from the environment.
// Every secret (Stripe keys, the ed25519 signing seed) lives in the environment — never on disk
// in the repo. In production (ENV=production) a missing secret is a hard startup error (fail-closed);
// in dev we synthesize an ephemeral signing key so `go run` works without ceremony.
package config

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Env  string // "production" | "development"
	Addr string // listen address, e.g. ":8080"

	DBPath string // SQLite file path

	// Stripe
	StripeSecretKey     string // sk_... (used only if we ever call Stripe back; webhook needs only the signing secret)
	StripeWebhookSecret string // whsec_... — verifies inbound webhook signatures

	// License signing
	SigningSeed ed25519.PrivateKey // 64-byte expanded private key

	// Entitlement lifetime (short-lived so revocation propagates on the next /v1/refresh).
	EntitlementTTL time.Duration

	// Optional: opt-in metric history endpoint. Off by default (privacy invariant).
	HistoryEnabled bool

	// TrustedIPHeader: the name of a header your TRUSTED ingress sets to the real client IP (e.g.
	// "Fly-Client-IP" on Fly.io). The rate limiter keys on it. EMPTY (default) = trust nothing, key on
	// the raw TCP peer. Never set this to a header the client itself can forge through your proxy.
	TrustedIPHeader string

	// --- Native encode gateway (opt-in, default OFF) -------------------------------------------------
	// When NativeEnabled is false (the default), the whole /v1/encode path is DEAD: the route is not even
	// registered, so the client zip + behavior is byte-identical to a build without this feature. This is
	// the load-bearing safety property of the user-directed amendment to invariants 1 & 2.

	// NativeEnabled turns the encode proxy on. From ENABLE_NATIVE_ENCODE=true.
	NativeEnabled bool

	// EncoderURL is the base URL of the apps/encoder sidecar on the INTERNAL network (e.g.
	// "http://encoder:8090"). REQUIRED when NativeEnabled — a missing value is a hard startup error
	// (fail-closed: we never silently run with the feature half-wired). Never host/tailnet-reachable.
	EncoderURL string

	// EncodeMaxBodyBytes caps a single /v1/encode request body (base64 PNG + small JSON envelope). Over →
	// 413, BEFORE any work or proxying. Sized to comfortably hold base64(32 MiB page)+envelope. Default 48 MiB.
	EncodeMaxBodyBytes int64

	// EncodeTimeout bounds one upstream encode call (UASTC RDO is slow). Default 120s. The proxy route runs
	// outside the short billing WriteTimeout via ResponseController deadline extension.
	EncodeTimeout time.Duration

	// EncodeMaxConcurrentPerLicense bounds simultaneous in-flight encodes per license (keyed on the token
	// claim, in-memory — NOT SQLite). Over → 429. Default 2.
	EncodeMaxConcurrentPerLicense int

	// EncodeDailyQuotaPerLicense caps encodes per license per UTC day (in-memory, NOT SQLite). Over → 429.
	// Default 500.
	EncodeDailyQuotaPerLicense int
}

func (c *Config) IsProd() bool { return c.Env == "production" }

// PublicKey returns the 32-byte ed25519 public key the web client embeds to verify entitlements offline.
func (c *Config) PublicKey() ed25519.PublicKey {
	return c.SigningSeed.Public().(ed25519.PublicKey)
}

func Load() (*Config, error) {
	c := &Config{
		Env:            env("ENV", "development"),
		Addr:           env("ADDR", ":8080"),
		DBPath:         env("DB_PATH", "asset-doctor.db"),
		StripeSecretKey:     os.Getenv("STRIPE_SECRET_KEY"),
		StripeWebhookSecret: os.Getenv("STRIPE_WEBHOOK_SECRET"),
		EntitlementTTL:  durationDays(env("ENTITLEMENT_TTL_DAYS", "7")),
		HistoryEnabled:  env("HISTORY_ENABLED", "false") == "true",
		TrustedIPHeader: os.Getenv("TRUSTED_IP_HEADER"),

		NativeEnabled:                 env("ENABLE_NATIVE_ENCODE", "false") == "true",
		EncoderURL:                    strings.TrimRight(os.Getenv("ENCODER_URL"), "/"),
		EncodeMaxBodyBytes:            envInt64("ENCODE_MAX_BODY_BYTES", 48<<20), // 48 MiB
		EncodeTimeout:                 envDuration("ENCODE_TIMEOUT", 120*time.Second),
		EncodeMaxConcurrentPerLicense: envInt("ENCODE_MAX_CONCURRENT_PER_LICENSE", 2),
		EncodeDailyQuotaPerLicense:    envInt("ENCODE_DAILY_QUOTA_PER_LICENSE", 500),
	}

	seed, err := loadSigningKey(os.Getenv("LICENSE_SIGNING_SEED"), c.IsProd())
	if err != nil {
		return nil, err
	}
	c.SigningSeed = seed

	if c.IsProd() {
		if c.StripeWebhookSecret == "" {
			return nil, errors.New("config: STRIPE_WEBHOOK_SECRET is required in production (fail-closed)")
		}
	}

	// Fail-closed: if the native encode gateway is enabled we MUST know where the sidecar is. We never
	// register a proxy route that has nowhere to forward to.
	if c.NativeEnabled && c.EncoderURL == "" {
		return nil, errors.New("config: ENCODER_URL is required when ENABLE_NATIVE_ENCODE=true (fail-closed)")
	}
	return c, nil
}

// loadSigningKey decodes a base64 ed25519 SEED (32 bytes) into a full private key.
// Prod requires it; dev generates an ephemeral one and logs nothing secret.
func loadSigningKey(b64 string, prod bool) (ed25519.PrivateKey, error) {
	if b64 == "" {
		if prod {
			return nil, errors.New("config: LICENSE_SIGNING_SEED is required in production (fail-closed)")
		}
		_, priv, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return nil, fmt.Errorf("config: generate ephemeral key: %w", err)
		}
		return priv, nil
	}
	raw, err := decodeB64(strings.TrimSpace(b64))
	if err != nil {
		return nil, fmt.Errorf("config: LICENSE_SIGNING_SEED is not valid base64: %w", err)
	}
	switch len(raw) {
	case ed25519.SeedSize: // 32
		return ed25519.NewKeyFromSeed(raw), nil
	case ed25519.PrivateKeySize: // 64 (full key)
		return ed25519.PrivateKey(raw), nil
	default:
		return nil, fmt.Errorf("config: LICENSE_SIGNING_SEED must be %d or %d bytes, got %d", ed25519.SeedSize, ed25519.PrivateKeySize, len(raw))
	}
}

// decodeB64 accepts both std and url base64, padded or not.
func decodeB64(s string) ([]byte, error) {
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		if b, err := enc.DecodeString(s); err == nil {
			return b, nil
		}
	}
	return nil, errors.New("not valid base64 in any standard alphabet")
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return def
}

func envInt64(k string, def int64) int64 {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 0 {
			return n
		}
	}
	return def
}

func envDuration(k string, def time.Duration) time.Duration {
	if v := os.Getenv(k); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			return d
		}
	}
	return def
}

func durationDays(s string) time.Duration {
	n, err := strconv.Atoi(s)
	if err != nil || n <= 0 {
		n = 7
	}
	return time.Duration(n) * 24 * time.Hour
}
