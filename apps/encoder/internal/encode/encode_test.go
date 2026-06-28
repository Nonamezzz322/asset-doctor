package encode

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestFlagsForKnownProfile(t *testing.T) {
	flags, err := flagsFor(ProfileUASTCZstdMip)
	if err != nil {
		t.Fatalf("flagsFor(known) error: %v", err)
	}
	// Pinned, deterministic flag set: container, UASTC, zstd supercompression, baked mips. If any of these
	// change, output bytes change → the receipt's determinism claim breaks. This test pins the contract.
	for _, want := range []string{"--t2", "uastc", "--zcmp", "--genmipmap"} {
		if !contains(flags, want) {
			t.Fatalf("flags %v missing %q", flags, want)
		}
	}
}

func TestFlagsForUnknownProfile(t *testing.T) {
	if _, err := flagsFor(Profile("etc1s-fast")); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("flagsFor(unknown) err = %v, want ErrUnsupported", err)
	}
}

func TestSupportedProfilesAllowlist(t *testing.T) {
	if !SupportedProfiles[ProfileUASTCZstdMip] {
		t.Fatal("uastc-zstd-mip must be supported")
	}
	if SupportedProfiles[Profile("anything-else")] {
		t.Fatal("allowlist must be closed (no unknown profile allowed)")
	}
}

// TestToktxEncoderRejectsUnsupported verifies the encoder validates op/profile BEFORE ever touching the
// filesystem or shelling out — so these paths are testable with no toktx binary present.
func TestToktxEncoderRejectsUnsupported(t *testing.T) {
	e := NewToktxEncoder("toktx-not-installed", t.TempDir(), time.Second)
	if _, err := e.Encode(context.Background(), Request{Op: Op("jpeg"), Profile: ProfileUASTCZstdMip}); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("bad op err = %v, want ErrUnsupported", err)
	}
	if _, err := e.Encode(context.Background(), Request{Op: KTX2, Profile: Profile("nope")}); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("bad profile err = %v, want ErrUnsupported", err)
	}
}

// TestToktxEncoderMissingBinaryCleansTemp verifies that when the (absent) toktx binary fails to exec, the
// error is classified as ErrEncodeFailed AND the deferred unlinks leave NO temp files behind. This is the
// "unlink in a finally" guarantee, tested without a real toktx.
func TestToktxEncoderMissingBinaryCleansTemp(t *testing.T) {
	tmp := t.TempDir()
	e := NewToktxEncoder(filepath.Join(tmp, "definitely-not-toktx"), tmp, time.Second)
	_, err := e.Encode(context.Background(), Request{
		PNG: []byte("PNGBYTES"), W: 64, H: 64, Op: KTX2, Profile: ProfileUASTCZstdMip,
	})
	if !errors.Is(err, ErrEncodeFailed) {
		t.Fatalf("missing-binary err = %v, want ErrEncodeFailed", err)
	}
	// The error must NOT contain the image bytes.
	if strings.Contains(err.Error(), "PNGBYTES") {
		t.Fatalf("error leaked image bytes: %v", err)
	}
	left := listEncoderTemps(t, tmp)
	if len(left) != 0 {
		t.Fatalf("temp files not cleaned up: %v", left)
	}
}

func TestTrimStderr(t *testing.T) {
	short := []byte("short error")
	if got := trimStderr(short); got != "short error" {
		t.Fatalf("trimStderr(short) = %q", got)
	}
	long := make([]byte, 2000)
	for i := range long {
		long[i] = 'x'
	}
	got := trimStderr(long)
	if len(got) >= 2000 {
		t.Fatalf("trimStderr(long) not trimmed: len=%d", len(got))
	}
	if !strings.Contains(got, "2000B") {
		t.Fatalf("trimStderr(long) missing size hint: %q", got)
	}
}

func listEncoderTemps(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	var out []string
	for _, e := range entries {
		if isEncoderTemp(e.Name()) {
			out = append(out, e.Name())
		}
	}
	return out
}

func contains(ss []string, want string) bool {
	for _, s := range ss {
		if s == want {
			return true
		}
	}
	return false
}
