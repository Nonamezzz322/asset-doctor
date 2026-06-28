// Package config loads the encoder sidecar's runtime configuration from the environment.
// Every limit (size/dimension/pixel caps, concurrency, timeout) is an env-tunable with a safe default.
// The sidecar holds NO secrets: it has no DB, no signing seed, no Stripe keys. Entitlement is verified
// upstream in apps/api before a request ever reaches here, so this layer is purely a bounded exec wrapper.
package config

import (
	"os"
	"strconv"
	"time"
)

type Config struct {
	// Addr is the listen address. In compose this binds to the INTERNAL network only (never host/tailnet).
	Addr string

	// ToktxPath is the absolute path to the pinned `toktx` binary (KTX-Software). The Dockerfile installs
	// a pinned release and sets this; locally it defaults to "toktx" on PATH (tests never exec it).
	ToktxPath string

	// TmpDir is the scratch directory for ephemeral temp-in/temp-out files. In compose this is a tmpfs
	// (RAM-backed, never persisted). Falls back to the OS temp dir.
	TmpDir string

	// MaxBodyBytes caps the request body (PNG upload). Over → 413. Default 32 MiB (one large atlas page).
	MaxBodyBytes int64

	// MaxDim caps a single side (w or h) in pixels. Over → 415. Default 8192.
	MaxDim int

	// MaxPixels caps total w*h. Guards against degenerate 8192x8192 = 64 Mpx blowups before decode. Over → 415.
	MaxPixels int64

	// MaxConcurrent bounds simultaneous toktx execs. Over → 503 (busy). UASTC RDO is CPU-heavy; default 2.
	MaxConcurrent int

	// ExecTimeout bounds a single toktx exec. Over → the exec is killed and the request fails. Default 120s.
	ExecTimeout time.Duration

	// SweepInterval is how often the orphan-temp sweeper runs. Default 5m.
	SweepInterval time.Duration

	// SweepMaxAge is how old an orphan temp file must be before the sweeper deletes it. Must exceed
	// ExecTimeout so it never races a live exec. Default 10m.
	SweepMaxAge time.Duration
}

func Load() *Config {
	return &Config{
		Addr:          env("ADDR", ":8090"),
		ToktxPath:     env("TOKTX_PATH", "toktx"),
		TmpDir:        env("TMP_DIR", os.TempDir()),
		MaxBodyBytes:  envInt64("MAX_BODY_BYTES", 32<<20), // 32 MiB
		MaxDim:        envInt("MAX_DIM", 8192),
		MaxPixels:     envInt64("MAX_PIXELS", 8192*8192),
		MaxConcurrent: envInt("MAX_CONCURRENT", 2),
		ExecTimeout:   envDuration("EXEC_TIMEOUT", 120*time.Second),
		SweepInterval: envDuration("SWEEP_INTERVAL", 5*time.Minute),
		SweepMaxAge:   envDuration("SWEEP_MAX_AGE", 10*time.Minute),
	}
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
