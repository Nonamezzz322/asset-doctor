package encode

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// containsStr reports whether s contains sub (a tiny helper so the byte-leak assertions read clearly).
func containsStr(s, sub string) bool { return strings.Contains(s, sub) }

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// writeExecScript writes an executable shell script to a temp file and returns its path. Used to stand in
// for the native binary so the exec/exit-code mapping is unit-testable without pngquant installed.
func writeExecScript(t *testing.T, body string) string {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, "fake-bin")
	if err := os.WriteFile(p, []byte(body), 0o755); err != nil {
		t.Fatalf("write script: %v", err)
	}
	return p
}

// recordingEncoder is a trivial Encoder fake for the Dispatcher routing test.
type recordingEncoder struct {
	out   []byte
	err   error
	calls int
}

func (r *recordingEncoder) Encode(_ context.Context, _ Request) ([]byte, error) {
	r.calls++
	return r.out, r.err
}
