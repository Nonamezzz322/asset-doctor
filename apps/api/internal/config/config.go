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

func durationDays(s string) time.Duration {
	n, err := strconv.Atoi(s)
	if err != nil || n <= 0 {
		n = 7
	}
	return time.Duration(n) * 24 * time.Hour
}
