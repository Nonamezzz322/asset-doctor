package encode

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"time"
)

// ToktxEncoder shells to the pinned `toktx` binary (KTX-Software). It is the production Encoder.
// It NEVER logs image bytes. Temp in/out files are created under TmpDir and unlinked in a finally
// (a deferred cleanup), so a crash or timeout still leaves at most a transient file the sweeper reaps.
type ToktxEncoder struct {
	Bin     string        // absolute path to the pinned toktx, or "toktx" on PATH
	TmpDir  string        // scratch dir (a tmpfs in production compose)
	Timeout time.Duration // hard wall on a single exec
}

func NewToktxEncoder(bin, tmpDir string, timeout time.Duration) *ToktxEncoder {
	return &ToktxEncoder{Bin: bin, TmpDir: tmpDir, Timeout: timeout}
}

// flagsFor maps a pinned Profile to the EXACT toktx flag set. Determinism: same profile + same pinned
// toktx version ⇒ same output bytes. The flag set is a CLOSED mapping — the request never supplies flags.
func flagsFor(p Profile) ([]string, error) {
	switch p {
	case ProfileUASTCZstdMip:
		// --t2          : write a KTX2 container
		// --encode uastc: UASTC LDR 4x4 (high-quality, transcodable to BC7/ASTC/BC1/ETC1 at runtime)
		// --uastc_quality 2 : balanced UASTC quality level
		// --zcmp 19     : Zstd supercompression of the (already block-encoded) payload, level 19
		// --genmipmap   : bake a full mip chain (the +1/3 VRAM the receipt discloses)
		return []string{"--t2", "--encode", "uastc", "--uastc_quality", "2", "--zcmp", "19", "--genmipmap"}, nil
	default:
		return nil, ErrUnsupported
	}
}

func (e *ToktxEncoder) Encode(ctx context.Context, req Request) ([]byte, error) {
	if req.Op != KTX2 {
		return nil, ErrUnsupported
	}
	flags, err := flagsFor(req.Profile)
	if err != nil {
		return nil, err
	}

	// Unique temp basenames so concurrent execs never collide. The PID+nano+pixels suffix is enough at
	// our scale; os.CreateTemp gives us the uniqueness guarantee + O_EXCL.
	inF, err := os.CreateTemp(e.TmpDir, "enc-in-*.png")
	if err != nil {
		return nil, fmt.Errorf("%w: temp in: %v", ErrEncodeFailed, err)
	}
	inPath := inF.Name()
	// finally: unlink the input no matter what (success, error, panic, timeout).
	defer os.Remove(inPath)

	outPath := filepath.Join(e.TmpDir, "enc-out-"+filepath.Base(inPath)+".ktx2")
	// finally: unlink the output no matter what.
	defer os.Remove(outPath)

	if _, err := inF.Write(req.PNG); err != nil {
		_ = inF.Close()
		return nil, fmt.Errorf("%w: write in: %v", ErrEncodeFailed, err)
	}
	if err := inF.Close(); err != nil {
		return nil, fmt.Errorf("%w: close in: %v", ErrEncodeFailed, err)
	}

	cctx, cancel := context.WithTimeout(ctx, e.Timeout)
	defer cancel()

	// toktx <flags> <out> <in>  — KTX-Software CLI argument order.
	args := append(append([]string{}, flags...), outPath, inPath)
	cmd := exec.CommandContext(cctx, e.Bin, args...)
	// Do NOT inherit the parent environment beyond what toktx needs; a minimal env reduces surprise.
	cmd.Env = []string{"PATH=" + os.Getenv("PATH")}

	// We capture stderr for SERVER-SIDE logs only (never returned to the client, never includes image
	// bytes — toktx stderr is dimensions/flags/errors). combinedOutput would mix stdout; we don't need it.
	stderr, runErr := cmd.CombinedOutput()
	if runErr != nil {
		// Distinguish a timeout (context killed the process) for clearer server logs.
		if errors.Is(cctx.Err(), context.DeadlineExceeded) {
			return nil, fmt.Errorf("%w: toktx timed out after %s", ErrEncodeFailed, e.Timeout)
		}
		// Trim the stderr so a giant blob can't bloat logs; image bytes are NEVER in here.
		return nil, fmt.Errorf("%w: toktx exit: %v: %s", ErrEncodeFailed, runErr, trimStderr(stderr))
	}

	out, err := os.ReadFile(outPath)
	if err != nil {
		return nil, fmt.Errorf("%w: read out: %v", ErrEncodeFailed, err)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("%w: toktx produced empty output", ErrEncodeFailed)
	}
	return out, nil
}

func trimStderr(b []byte) string {
	const max = 512
	if len(b) > max {
		return string(b[:max]) + "…(" + strconv.Itoa(len(b)) + "B)"
	}
	return string(b)
}
