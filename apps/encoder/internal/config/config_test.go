package config

import (
	"testing"
	"time"
)

func TestLoadDefaults(t *testing.T) {
	// No env set → safe defaults.
	t.Setenv("ADDR", "")
	t.Setenv("TOKTX_PATH", "")
	t.Setenv("MAX_BODY_BYTES", "")
	t.Setenv("MAX_DIM", "")
	t.Setenv("MAX_CONCURRENT", "")
	t.Setenv("EXEC_TIMEOUT", "")
	c := Load()
	if c.Addr != ":8090" {
		t.Fatalf("Addr default = %q", c.Addr)
	}
	if c.ToktxPath != "toktx" {
		t.Fatalf("ToktxPath default = %q", c.ToktxPath)
	}
	if c.MaxBodyBytes != 32<<20 {
		t.Fatalf("MaxBodyBytes default = %d", c.MaxBodyBytes)
	}
	if c.MaxDim != 8192 {
		t.Fatalf("MaxDim default = %d", c.MaxDim)
	}
	if c.MaxConcurrent != 2 {
		t.Fatalf("MaxConcurrent default = %d", c.MaxConcurrent)
	}
	if c.ExecTimeout != 120*time.Second {
		t.Fatalf("ExecTimeout default = %v", c.ExecTimeout)
	}
	// Sweeper safety invariant: max-age must exceed exec timeout so a sweep never races a live encode.
	if c.SweepMaxAge <= c.ExecTimeout {
		t.Fatalf("SweepMaxAge %v must exceed ExecTimeout %v", c.SweepMaxAge, c.ExecTimeout)
	}
}

func TestLoadOverrides(t *testing.T) {
	t.Setenv("ADDR", ":9999")
	t.Setenv("TOKTX_PATH", "/usr/local/bin/toktx")
	t.Setenv("MAX_BODY_BYTES", "1048576")
	t.Setenv("MAX_DIM", "2048")
	t.Setenv("MAX_PIXELS", "1000000")
	t.Setenv("MAX_CONCURRENT", "4")
	t.Setenv("EXEC_TIMEOUT", "30s")
	c := Load()
	if c.Addr != ":9999" || c.ToktxPath != "/usr/local/bin/toktx" {
		t.Fatalf("string overrides not applied: %+v", c)
	}
	if c.MaxBodyBytes != 1048576 || c.MaxDim != 2048 || c.MaxPixels != 1000000 || c.MaxConcurrent != 4 {
		t.Fatalf("numeric overrides not applied: %+v", c)
	}
	if c.ExecTimeout != 30*time.Second {
		t.Fatalf("ExecTimeout override = %v", c.ExecTimeout)
	}
}

func TestLoadIgnoresGarbage(t *testing.T) {
	// Invalid / non-positive values fall back to defaults (fail-safe, never zero a cap).
	t.Setenv("MAX_DIM", "-5")
	t.Setenv("MAX_CONCURRENT", "notanumber")
	t.Setenv("EXEC_TIMEOUT", "garbage")
	c := Load()
	if c.MaxDim != 8192 {
		t.Fatalf("garbage MAX_DIM not defaulted: %d", c.MaxDim)
	}
	if c.MaxConcurrent != 2 {
		t.Fatalf("garbage MAX_CONCURRENT not defaulted: %d", c.MaxConcurrent)
	}
	if c.ExecTimeout != 120*time.Second {
		t.Fatalf("garbage EXEC_TIMEOUT not defaulted: %v", c.ExecTimeout)
	}
}
