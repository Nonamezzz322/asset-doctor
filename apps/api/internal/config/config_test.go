package config

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"testing"
	"time"
)

// setSeedEnv installs a valid base64 ed25519 seed so Load() doesn't fail on the signing key while we test
// the native-encode config branch.
func setSeedEnv(t *testing.T) {
	t.Helper()
	seed := make([]byte, ed25519.SeedSize)
	if _, err := rand.Read(seed); err != nil {
		t.Fatal(err)
	}
	t.Setenv("LICENSE_SIGNING_SEED", base64.StdEncoding.EncodeToString(seed))
}

func TestNativeDisabledByDefault(t *testing.T) {
	setSeedEnv(t)
	c, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if c.NativeEnabled {
		t.Fatal("NativeEnabled should default to false (feature OFF / byte-identical behavior)")
	}
}

func TestNativeFailsClosedWithoutEncoderURL(t *testing.T) {
	setSeedEnv(t)
	t.Setenv("ENABLE_NATIVE_ENCODE", "true")
	// ENCODER_URL deliberately unset → must be a hard startup error.
	if _, err := Load(); err == nil {
		t.Fatal("Load should fail when native is enabled but ENCODER_URL is unset (fail-closed)")
	}
}

func TestNativeEnabledWithEncoderURL(t *testing.T) {
	setSeedEnv(t)
	t.Setenv("ENABLE_NATIVE_ENCODE", "true")
	t.Setenv("ENCODER_URL", "http://encoder:8090/")
	c, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !c.NativeEnabled {
		t.Fatal("NativeEnabled should be true")
	}
	if c.EncoderURL != "http://encoder:8090" {
		t.Fatalf("EncoderURL = %q, want trailing slash trimmed", c.EncoderURL)
	}
}

func TestEncodeDefaults(t *testing.T) {
	setSeedEnv(t)
	c, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if c.EncodeMaxBodyBytes != 48<<20 {
		t.Fatalf("EncodeMaxBodyBytes = %d, want 48 MiB", c.EncodeMaxBodyBytes)
	}
	if c.EncodeTimeout != 120*time.Second {
		t.Fatalf("EncodeTimeout = %v, want 120s", c.EncodeTimeout)
	}
	if c.EncodeMaxConcurrentPerLicense != 2 {
		t.Fatalf("EncodeMaxConcurrentPerLicense = %d, want 2", c.EncodeMaxConcurrentPerLicense)
	}
	if c.EncodeDailyQuotaPerLicense != 500 {
		t.Fatalf("EncodeDailyQuotaPerLicense = %d, want 500", c.EncodeDailyQuotaPerLicense)
	}
}

func TestEncodeEnvOverrides(t *testing.T) {
	setSeedEnv(t)
	t.Setenv("ENCODE_MAX_BODY_BYTES", "1048576")
	t.Setenv("ENCODE_TIMEOUT", "30s")
	t.Setenv("ENCODE_MAX_CONCURRENT_PER_LICENSE", "5")
	t.Setenv("ENCODE_DAILY_QUOTA_PER_LICENSE", "10")
	c, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if c.EncodeMaxBodyBytes != 1048576 || c.EncodeTimeout != 30*time.Second ||
		c.EncodeMaxConcurrentPerLicense != 5 || c.EncodeDailyQuotaPerLicense != 10 {
		t.Fatalf("env overrides not applied: %+v", c)
	}
}
