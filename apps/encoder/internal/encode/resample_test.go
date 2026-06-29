package encode

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestVipsArgsKnownProfile(t *testing.T) {
	args, err := vipsArgs(ProfileVipsLanczos3, 512, 256)
	if err != nil {
		t.Fatalf("vipsArgs(known) error: %v", err)
	}
	// Pinned, CLOSED arg vector. thumbnail_source reads /dev/stdin (no temp file); `--size force` produces the
	// EXACT tier dims (ignore aspect ratio, matching the browser canvas); `.png[strip]` is deterministic. If
	// any of these change, output bytes change → the determinism golden (deploy-time) breaks. This pins the
	// contract. The request supplies ONLY the integer w/h — never a raw flag — so there is no flag injection.
	for _, want := range []string{"thumbnail_source", "/dev/stdin", ".png[strip]", "512", "--height", "256", "--size", "force"} {
		if !contains(args, want) {
			t.Fatalf("args %v missing %q", args, want)
		}
	}
}

func TestVipsArgsUnknownProfile(t *testing.T) {
	if _, err := vipsArgs(ProfileUASTCZstdMip, 64, 64); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("vipsArgs(foreign) err = %v, want ErrUnsupported", err)
	}
}

// TestResampleEncoderRejectsUnsupported verifies the encoder validates op/profile/dims BEFORE ever shelling
// out — so these paths are testable with no vips binary present.
func TestResampleEncoderRejectsUnsupported(t *testing.T) {
	e := NewResampleEncoder("vips-not-installed", t.TempDir(), time.Second)
	// Wrong op → ErrUnsupported before any exec.
	if _, err := e.Encode(context.Background(), Request{Op: KTX2, Profile: ProfileVipsLanczos3, W: 64, H: 64}); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("bad op err = %v, want ErrUnsupported", err)
	}
	// Right op, foreign profile → ErrUnsupported before any exec.
	if _, err := e.Encode(context.Background(), Request{Op: Resample, Profile: Profile("nope"), W: 64, H: 64}); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("bad profile err = %v, want ErrUnsupported", err)
	}
	// Right op + profile, non-positive target dims → ErrUnsupported before any exec (defense in depth).
	if _, err := e.Encode(context.Background(), Request{Op: Resample, Profile: ProfileVipsLanczos3, W: 0, H: 64}); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("zero-w err = %v, want ErrUnsupported", err)
	}
}

// TestResampleEncoderMissingBinary verifies an absent binary classifies as ErrEncodeFailed and never leaks
// the image bytes into the error.
func TestResampleEncoderMissingBinary(t *testing.T) {
	e := NewResampleEncoder("/definitely/not/vips", t.TempDir(), time.Second)
	_, err := e.Encode(context.Background(), Request{
		PNG: []byte("PNGBYTES-SECRET"), W: 64, H: 64, Op: Resample, Profile: ProfileVipsLanczos3,
	})
	if !errors.Is(err, ErrEncodeFailed) {
		t.Fatalf("missing-binary err = %v, want ErrEncodeFailed", err)
	}
	if err != nil && containsStr(err.Error(), "PNGBYTES-SECRET") {
		t.Fatalf("error leaked image bytes: %v", err)
	}
}

// TestResampleStdoutPassthrough: a fake `cat` script proves the encoder feeds STDIN and reads STDOUT (no
// temp files), exactly as the production stream does — gated behind /bin/sh so it stays a unit test.
func TestResampleStdoutPassthrough(t *testing.T) {
	if !fileExists("/bin/sh") {
		t.Skip("/bin/sh unavailable; stdin/stdout stream exercised at deploy-time against real vips")
	}
	// A stand-in "binary": Encode appends our pinned args (thumbnail_source /dev/stdin .png[strip] …) but the
	// script ignores them and just `cat`s stdin → stdout, proving the stream path round-trips bytes.
	script := writeExecScript(t, "#!/bin/sh\ncat\n")
	e := &ResampleEncoder{Bin: script, TmpDir: t.TempDir(), Timeout: 2 * time.Second}
	out, err := e.Encode(context.Background(), Request{
		PNG: []byte("ROUNDTRIP"), W: 16, H: 8, Op: Resample, Profile: ProfileVipsLanczos3,
	})
	if err != nil {
		t.Fatalf("passthrough err: %v", err)
	}
	if string(out) != "ROUNDTRIP" {
		t.Fatalf("stdout passthrough = %q, want ROUNDTRIP", out)
	}
}

// TestResampleEmptyOutputFails: a fake binary that exits 0 but writes nothing is a real failure, not a
// silent success (we never emit a zero-byte tile).
func TestResampleEmptyOutputFails(t *testing.T) {
	if !fileExists("/bin/sh") {
		t.Skip("/bin/sh unavailable")
	}
	script := writeExecScript(t, "#!/bin/sh\nexit 0\n")
	e := &ResampleEncoder{Bin: script, TmpDir: t.TempDir(), Timeout: 2 * time.Second}
	_, err := e.Encode(context.Background(), Request{
		PNG: []byte("X"), W: 16, H: 8, Op: Resample, Profile: ProfileVipsLanczos3,
	})
	if !errors.Is(err, ErrEncodeFailed) {
		t.Fatalf("empty-output err = %v, want ErrEncodeFailed", err)
	}
}

// TestDispatcherRoutesResample: the Dispatcher routes a resample Request to the Resample encoder (and only
// it), mirroring the ktx2/pngquant routing assertions.
func TestDispatcherRoutesResample(t *testing.T) {
	toktx := &recordingEncoder{out: []byte("KTX2")}
	pq := &recordingEncoder{out: []byte("PNG")}
	rs := &recordingEncoder{out: []byte("RESAMPLED")}
	d := &Dispatcher{Toktx: toktx, PngQuant: pq, Resample: rs}

	if out, err := d.Encode(context.Background(), Request{Op: Resample}); err != nil || string(out) != "RESAMPLED" {
		t.Fatalf("resample route = %q,%v", out, err)
	}
	if rs.calls != 1 || toktx.calls != 0 || pq.calls != 0 {
		t.Fatalf("resample routed wrong: toktx=%d pq=%d rs=%d", toktx.calls, pq.calls, rs.calls)
	}
}
