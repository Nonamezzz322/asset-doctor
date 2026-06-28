package encode

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writeFile(t *testing.T, dir, name string, age time.Duration) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
	mt := time.Now().Add(-age)
	if err := os.Chtimes(p, mt, mt); err != nil {
		t.Fatalf("chtimes %s: %v", name, err)
	}
	return p
}

func TestSweepOrphans(t *testing.T) {
	dir := t.TempDir()
	// Old encoder temps → should be swept.
	writeFile(t, dir, "enc-in-abc123.png", 30*time.Minute)
	writeFile(t, dir, "enc-out-abc123.png.ktx2", 30*time.Minute)
	// Fresh encoder temp (live encode) → must be SPARED.
	freshTemp := writeFile(t, dir, "enc-in-live999.png", 1*time.Minute)
	// Old NON-encoder file → must NOT be touched (sweeper only owns its own prefixes).
	unrelated := writeFile(t, dir, "important-config.json", 30*time.Minute)

	removed := SweepOrphans(dir, 10*time.Minute, time.Now())
	if removed != 2 {
		t.Fatalf("removed = %d, want 2", removed)
	}
	if _, err := os.Stat(freshTemp); err != nil {
		t.Fatalf("fresh live temp was wrongly swept: %v", err)
	}
	if _, err := os.Stat(unrelated); err != nil {
		t.Fatalf("unrelated file was wrongly deleted: %v", err)
	}
}

func TestSweepOrphansMissingDir(t *testing.T) {
	// A non-existent dir must not panic; it returns 0.
	if n := SweepOrphans(filepath.Join(t.TempDir(), "nope"), time.Minute, time.Now()); n != 0 {
		t.Fatalf("removed = %d on missing dir, want 0", n)
	}
}

func TestIsEncoderTemp(t *testing.T) {
	cases := map[string]bool{
		"enc-in-x.png":        true,
		"enc-out-x.png.ktx2":  true,
		"random.png":          false,
		"my-enc-in-thing.png": false, // prefix must be at the start
	}
	for name, want := range cases {
		if got := isEncoderTemp(name); got != want {
			t.Fatalf("isEncoderTemp(%q) = %v, want %v", name, got, want)
		}
	}
}
