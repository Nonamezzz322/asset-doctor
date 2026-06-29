package encode

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"time"
)

// pngQuantExitQualityFloor is pngquant's documented exit code for "couldn't meet the requested quality"
// (the `--quality=min-max` floor). We map it to ErrQualityFloor — an HONEST DECLINE, not a failure.
const pngQuantExitQualityFloor = 99

// PngQuantEncoder shells to the pinned `pngquant` binary for lossy-indexed PNG re-compression. Unlike the
// toktx path it streams PNG bytes via STDIN and reads the result from STDOUT (`-o -`), so it needs NO temp
// files — one fewer attacker-influenced filesystem path. It NEVER logs or returns the image bytes; stderr
// (dimensions/flags/errors only) is captured for SERVER-SIDE logs.
//
// HONESTY (load-bearing, round13-pngquant-backend.md): the output is a smaller PNG ON DISK only. It decodes
// to full RGBA8888 on the GPU ⇒ ZERO VRAM change. This encoder never produces or implies a VRAM number.
type PngQuantEncoder struct {
	Bin     string        // absolute path to the pinned pngquant, or "pngquant" on PATH
	TmpDir  string        // unused (stdin/stdout) — kept for a uniform constructor signature with toktx
	Timeout time.Duration // hard wall on a single exec
}

func NewPngQuantEncoder(bin, tmpDir string, timeout time.Duration) *PngQuantEncoder {
	return &PngQuantEncoder{Bin: bin, TmpDir: tmpDir, Timeout: timeout}
}

// pngQuantFlags maps a pinned Profile to the EXACT pngquant flag set. Determinism: same profile + same
// pinned pngquant version ⇒ same output bytes (M3 verifies this with a golden behind the real binary).
// The flag set is a CLOSED mapping — the request never supplies flags (no flag injection).
func pngQuantFlags(p Profile) ([]string, error) {
	switch p {
	case ProfilePngQuant256:
		// --quality=45-85 : a quality FLOOR (min 45). If pngquant can't reach 45 it EXITS 99 and writes
		//                   nothing → we surface ErrQualityFloor and the client keeps the original. This is
		//                   what makes the honest-decline path fire.
		// --speed 1       : best quality (slowest); pngquant is fast even at speed 1, far cheaper than UASTC.
		// --strip         : drop metadata chunks (smaller, deterministic — no timestamps/embedded paths).
		// --force         : allow writing to stdout even if it "looks" like overwriting.
		// 256             : palette size (max colors).
		// --output -      : write the result to STDOUT.
		// -               : read the source PNG from STDIN.
		return []string{"--quality=45-85", "--speed", "1", "--strip", "--force", "256", "--output", "-", "-"}, nil
	default:
		return nil, ErrUnsupported
	}
}

func (e *PngQuantEncoder) Encode(ctx context.Context, req Request) ([]byte, error) {
	if req.Op != PngQuant {
		return nil, ErrUnsupported
	}
	flags, err := pngQuantFlags(req.Profile)
	if err != nil {
		return nil, err
	}

	cctx, cancel := context.WithTimeout(ctx, e.Timeout)
	defer cancel()

	cmd := exec.CommandContext(cctx, e.Bin, flags...)
	// Minimal env (PATH only) — reduces surprise, mirrors the toktx posture.
	cmd.Env = []string{"PATH=" + os.Getenv("PATH")}

	// Feed the PNG via stdin; collect stdout (result) and stderr (logs) separately. We MUST NOT mix them:
	// stdout carries the binary PNG, stderr is the only thing safe to log.
	cmd.Stdin = bytes.NewReader(req.PNG)
	var out, stderr bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &stderr

	runErr := cmd.Run()
	if runErr != nil {
		// Timeout first (clearer server logs).
		if errors.Is(cctx.Err(), context.DeadlineExceeded) {
			return nil, fmt.Errorf("%w: pngquant timed out after %s", ErrEncodeFailed, e.Timeout)
		}
		// Exit 99 = quality floor not met. This is an HONEST DECLINE, NOT a failure (M1): the caller keeps
		// the original page. NEVER include stdout/image bytes in the error.
		var ee *exec.ExitError
		if errors.As(runErr, &ee) && ee.ExitCode() == pngQuantExitQualityFloor {
			return nil, ErrQualityFloor
		}
		// Any other failure: classify as ErrEncodeFailed. Trim stderr (dimensions/flags — never image bytes).
		return nil, fmt.Errorf("%w: pngquant exit: %v: %s", ErrEncodeFailed, runErr, trimStderr(stderr.Bytes()))
	}

	b := out.Bytes()
	if len(b) == 0 {
		return nil, fmt.Errorf("%w: pngquant produced empty output", ErrEncodeFailed)
	}
	return b, nil
}

// Dispatcher routes a Request to the concrete Encoder for its Op. It is the single seam the HTTP layer
// holds, so adding an op never widens the server's surface — it only adds a case here + an entry in
// SupportedOps/opProfiles. Unknown ops → ErrUnsupported (defense in depth behind the HTTP allowlist).
type Dispatcher struct {
	Toktx    Encoder
	PngQuant Encoder
	Resample Encoder
}

func (d *Dispatcher) Encode(ctx context.Context, req Request) ([]byte, error) {
	switch req.Op {
	case KTX2:
		return d.Toktx.Encode(ctx, req)
	case PngQuant:
		return d.PngQuant.Encode(ctx, req)
	case Resample:
		return d.Resample.Encode(ctx, req)
	default:
		return nil, ErrUnsupported
	}
}
