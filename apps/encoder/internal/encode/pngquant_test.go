package encode

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestPngQuantFlagsKnownProfile(t *testing.T) {
	flags, err := pngQuantFlags(ProfilePngQuant256)
	if err != nil {
		t.Fatalf("pngQuantFlags(known) error: %v", err)
	}
	// Pinned, deterministic flag set. The quality FLOOR (--quality=45-85) is what makes exit-99 fire when
	// pngquant can't hit the floor; stdin/stdout (--output -, trailing -) keeps it temp-free. If any of
	// these change, output bytes change → the determinism golden (M3) breaks.
	for _, want := range []string{"--quality=45-85", "--strip", "256", "--output", "-"} {
		if !contains(flags, want) {
			t.Fatalf("flags %v missing %q", flags, want)
		}
	}
	// The LAST arg must be "-" (read PNG from stdin).
	if flags[len(flags)-1] != "-" {
		t.Fatalf("flags %v must end with stdin marker \"-\"", flags)
	}
}

func TestPngQuantFlagsUnknownProfile(t *testing.T) {
	if _, err := pngQuantFlags(ProfileUASTCZstdMip); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("pngQuantFlags(foreign) err = %v, want ErrUnsupported", err)
	}
}

func TestSupportedOpsAllowlist(t *testing.T) {
	if !SupportedOps[KTX2] || !SupportedOps[PngQuant] {
		t.Fatal("both ktx2 and pngquant must be supported ops")
	}
	if SupportedOps[Op("jpeg")] {
		t.Fatal("op allowlist must be closed (no unknown op allowed)")
	}
}

func TestRequiredProfileOpXProfileCompat(t *testing.T) {
	if p, ok := RequiredProfile(KTX2); !ok || p != ProfileUASTCZstdMip {
		t.Fatalf("RequiredProfile(ktx2) = %q,%v want uastc-zstd-mip,true", p, ok)
	}
	if p, ok := RequiredProfile(PngQuant); !ok || p != ProfilePngQuant256 {
		t.Fatalf("RequiredProfile(pngquant) = %q,%v want pngquant-256-fs,true", p, ok)
	}
	if _, ok := RequiredProfile(Op("jpeg")); ok {
		t.Fatal("RequiredProfile(unknown) must report ok=false")
	}
}

func TestSupportedProfilesIncludesPngQuant(t *testing.T) {
	if !SupportedProfiles[ProfilePngQuant256] {
		t.Fatal("pngquant-256-fs must be a supported profile")
	}
}

func TestPngQuantEncoderRejectsUnsupported(t *testing.T) {
	e := NewPngQuantEncoder("pngquant-not-installed", t.TempDir(), time.Second)
	// Wrong op → ErrUnsupported before any exec.
	if _, err := e.Encode(context.Background(), Request{Op: KTX2, Profile: ProfilePngQuant256}); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("bad op err = %v, want ErrUnsupported", err)
	}
	// Right op, foreign profile → ErrUnsupported before any exec.
	if _, err := e.Encode(context.Background(), Request{Op: PngQuant, Profile: Profile("nope")}); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("bad profile err = %v, want ErrUnsupported", err)
	}
}

// TestPngQuantEncoderMissingBinary verifies an absent binary classifies as ErrEncodeFailed (NOT the
// quality-floor decline) and never leaks the image bytes into the error.
func TestPngQuantEncoderMissingBinary(t *testing.T) {
	e := NewPngQuantEncoder("/definitely/not/pngquant", t.TempDir(), time.Second)
	_, err := e.Encode(context.Background(), Request{
		PNG: []byte("PNGBYTES-SECRET"), W: 64, H: 64, Op: PngQuant, Profile: ProfilePngQuant256,
	})
	if !errors.Is(err, ErrEncodeFailed) {
		t.Fatalf("missing-binary err = %v, want ErrEncodeFailed", err)
	}
	if errors.Is(err, ErrQualityFloor) {
		t.Fatalf("missing-binary must NOT be classified as quality-floor: %v", err)
	}
	if err != nil && containsStr(err.Error(), "PNGBYTES-SECRET") {
		t.Fatalf("error leaked image bytes: %v", err)
	}
}

// TestPngQuantExitQualityFloorMapsToErrQualityFloor exercises the exit-99 → ErrQualityFloor path through
// a fake `sh` that exits 99 (M1). Gated behind /bin/sh so it stays a unit test, not a real-pngquant test.
func TestPngQuantExitQualityFloorMapsToErrQualityFloor(t *testing.T) {
	if !fileExists("/bin/sh") {
		t.Skip("/bin/sh unavailable; exit-99 mapping exercised at deploy-time against real pngquant")
	}
	// A stand-in "binary": /bin/sh -c 'exit 99' — but Encode appends our pinned flags as args. sh ignores
	// extra args after -c's command word, so this reliably exits 99 regardless of the appended flags.
	e := &PngQuantEncoder{Bin: "/bin/sh", TmpDir: t.TempDir(), Timeout: 2 * time.Second}
	// Override flags is not possible (closed map); instead we wrap: run sh with our own arg vector by
	// pointing Bin at a tiny wrapper. Simplest portable approach: a script file that exits 99.
	script := writeExecScript(t, "#!/bin/sh\nexit 99\n")
	e.Bin = script
	_, err := e.Encode(context.Background(), Request{
		PNG: []byte("X"), W: 16, H: 16, Op: PngQuant, Profile: ProfilePngQuant256,
	})
	if !errors.Is(err, ErrQualityFloor) {
		t.Fatalf("exit-99 err = %v, want ErrQualityFloor", err)
	}
	if errors.Is(err, ErrEncodeFailed) {
		t.Fatalf("exit-99 must NOT also be ErrEncodeFailed: %v", err)
	}
}

// TestPngQuantNonQualityExitMapsToEncodeFailed: a generic non-zero exit (e.g. 1) is a real failure, NOT
// the honest quality-floor decline.
func TestPngQuantNonQualityExitMapsToEncodeFailed(t *testing.T) {
	if !fileExists("/bin/sh") {
		t.Skip("/bin/sh unavailable")
	}
	script := writeExecScript(t, "#!/bin/sh\nexit 1\n")
	e := &PngQuantEncoder{Bin: script, TmpDir: t.TempDir(), Timeout: 2 * time.Second}
	_, err := e.Encode(context.Background(), Request{
		PNG: []byte("X"), W: 16, H: 16, Op: PngQuant, Profile: ProfilePngQuant256,
	})
	if !errors.Is(err, ErrEncodeFailed) {
		t.Fatalf("exit-1 err = %v, want ErrEncodeFailed", err)
	}
	if errors.Is(err, ErrQualityFloor) {
		t.Fatalf("exit-1 must NOT be quality-floor: %v", err)
	}
}

// TestPngQuantStdoutPassthrough: a fake that echoes stdin to stdout proves the encoder reads STDOUT and
// returns the bytes (no temp files involved).
func TestPngQuantStdoutPassthrough(t *testing.T) {
	if !fileExists("/bin/cat") {
		t.Skip("/bin/cat unavailable")
	}
	// `cat` echoes stdin → stdout, ignoring the appended flags' values it doesn't understand? cat treats
	// unknown flags as errors, so instead use a script that just `cat`s stdin and exits 0.
	script := writeExecScript(t, "#!/bin/sh\ncat\n")
	e := &PngQuantEncoder{Bin: script, TmpDir: t.TempDir(), Timeout: 2 * time.Second}
	out, err := e.Encode(context.Background(), Request{
		PNG: []byte("ROUNDTRIP"), W: 16, H: 16, Op: PngQuant, Profile: ProfilePngQuant256,
	})
	if err != nil {
		t.Fatalf("passthrough err: %v", err)
	}
	if string(out) != "ROUNDTRIP" {
		t.Fatalf("stdout passthrough = %q, want ROUNDTRIP", out)
	}
}

func TestDispatcherRouting(t *testing.T) {
	toktx := &recordingEncoder{out: []byte("KTX2")}
	pq := &recordingEncoder{out: []byte("PNG")}
	d := &Dispatcher{Toktx: toktx, PngQuant: pq}

	if out, err := d.Encode(context.Background(), Request{Op: KTX2}); err != nil || string(out) != "KTX2" {
		t.Fatalf("ktx2 route = %q,%v", out, err)
	}
	if toktx.calls != 1 || pq.calls != 0 {
		t.Fatalf("ktx2 routed wrong: toktx=%d pq=%d", toktx.calls, pq.calls)
	}
	if out, err := d.Encode(context.Background(), Request{Op: PngQuant}); err != nil || string(out) != "PNG" {
		t.Fatalf("pngquant route = %q,%v", out, err)
	}
	if pq.calls != 1 {
		t.Fatalf("pngquant not routed: pq=%d", pq.calls)
	}
	if _, err := d.Encode(context.Background(), Request{Op: Op("jpeg")}); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("unknown op err = %v, want ErrUnsupported", err)
	}
}
