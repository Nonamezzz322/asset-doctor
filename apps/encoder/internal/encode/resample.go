package encode

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"time"
)

// ResampleEncoder shells to the pinned `vips` binary (libvips) for a high-quality lanczos3 DOWNSCALE
// (round24-libvips-lanczos3-resample-op-sidecar.md). Like the pngquant path it streams PNG bytes via STDIN
// (`/dev/stdin`) and reads the result from STDOUT (`/dev/stdout`), so it needs NO temp files — one fewer
// attacker-influenced filesystem path (those device nodes always exist in the container; the root FS stays
// read-only). It NEVER logs or returns the image bytes; stderr (dimensions/flags/errors only) is captured
// for SERVER-SIDE logs.
//
// W/H ASYMMETRY (load-bearing, round24): unlike ktx2/pngquant — where Request.W/H DESCRIBE the input page —
// here W/H are the OUTPUT target the FULL-RES source PNG is downscaled TO. The client uploads the full-res
// top tier (PNG-re-encoded) and the worker would otherwise produce this tier with the browser's
// non-steerable canvas resampler; vips' lanczos3 is the one kernel the browser can't be asked for.
//
// HONESTY (load-bearing): the output is a PNG at the SAME tier dimensions the browser would have emitted, so
// it decodes to full RGBA8888 on the GPU ⇒ ZERO VRAM change AND no disk-saving claim. This encoder NEVER
// produces or implies a VRAM number; the only thing the receipt carries is a MEASURED high-frequency-energy
// retention delta computed client-side (resample-quality.ts).
type ResampleEncoder struct {
	Bin     string        // absolute path to the pinned vips, or "vips" on PATH
	TmpDir  string        // unused (stdin/stdout via /dev/std*) — kept for a uniform constructor signature
	Timeout time.Duration // hard wall on a single exec
}

func NewResampleEncoder(bin, tmpDir string, timeout time.Duration) *ResampleEncoder {
	return &ResampleEncoder{Bin: bin, TmpDir: tmpDir, Timeout: timeout}
}

// vipsArgs builds the EXACT, CLOSED vips argument vector for a pinned Profile + the target dimensions. The
// request supplies ONLY the integer w/h (validated by the HTTP caps before we get here) — never raw flags —
// so there is NO flag injection. Determinism: same profile + same pinned libvips version ⇒ same output bytes
// (re-verify with a deploy-time golden on a version bump, mirroring toktx/pngquant).
//
// Command shape (`vips thumbnail_source`): read a source from /dev/stdin, force the EXACT output box
// (`--size force` = ignore aspect ratio so the tier dims match the browser canvas exactly), use the
// lanczos3 reducer (libvips' high-quality default for thumbnail), strip metadata for smaller/deterministic
// PNGs, and write to /dev/stdout. The width is positional; the height is `--height`.
//
//	vips thumbnail_source /dev/stdin .png[strip] <W> --height <H> --size force
//
// CONFIRM the exact `vips thumbnail_source` stdin→stdout forced-w+h syntax against the PINNED libvips-tools
// build before live e2e (the single external surface this design can't verify without the binary). If a
// pinned build cannot stream to /dev/stdout, fall back to a TmpDir output file (toktx posture) — NOT to a
// guessed flag set. Until then this is unit-tested behind a mock/passthrough Encoder exactly like toktx.
func vipsArgs(p Profile, w, h int) ([]string, error) {
	switch p {
	case ProfileVipsLanczos3:
		// /dev/stdin   : read the source PNG from STDIN (no temp file).
		// .png[strip]  : write PNG to the target (suffix-typed), stripping metadata (smaller, deterministic).
		// <w>          : positional target WIDTH.
		// --height <h> : target HEIGHT.
		// --size force : ignore the source aspect ratio — produce EXACTLY w×h (match the browser tier dims).
		return []string{
			"thumbnail_source", "/dev/stdin", ".png[strip]",
			strconv.Itoa(w), "--height", strconv.Itoa(h), "--size", "force",
		}, nil
	default:
		return nil, ErrUnsupported
	}
}

func (e *ResampleEncoder) Encode(ctx context.Context, req Request) ([]byte, error) {
	if req.Op != Resample {
		return nil, ErrUnsupported
	}
	// Target dims must be sane BEFORE any exec. The HTTP layer already enforced the caps; this is defense in
	// depth so the encoder is correct even if called directly (e.g. in the Dispatcher unit test).
	if req.W <= 0 || req.H <= 0 {
		return nil, ErrUnsupported
	}
	args, err := vipsArgs(req.Profile, req.W, req.H)
	if err != nil {
		return nil, err
	}

	cctx, cancel := context.WithTimeout(ctx, e.Timeout)
	defer cancel()

	cmd := exec.CommandContext(cctx, e.Bin, args...)
	// Minimal env (PATH only) — reduces surprise, mirrors the toktx/pngquant posture.
	cmd.Env = []string{"PATH=" + os.Getenv("PATH")}

	// Feed the full-res PNG via stdin; collect stdout (result) and stderr (logs) separately. We MUST NOT mix
	// them: stdout carries the binary PNG, stderr is the only thing safe to log.
	cmd.Stdin = bytes.NewReader(req.PNG)
	var out, stderr bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &stderr

	if runErr := cmd.Run(); runErr != nil {
		// Timeout first (clearer server logs).
		if errors.Is(cctx.Err(), context.DeadlineExceeded) {
			return nil, fmt.Errorf("%w: vips timed out after %s", ErrEncodeFailed, e.Timeout)
		}
		// Any failure: classify as ErrEncodeFailed. Trim stderr (dimensions/flags — never image bytes).
		return nil, fmt.Errorf("%w: vips exit: %v: %s", ErrEncodeFailed, runErr, trimStderr(stderr.Bytes()))
	}

	b := out.Bytes()
	if len(b) == 0 {
		return nil, fmt.Errorf("%w: vips produced empty output", ErrEncodeFailed)
	}
	return b, nil
}
