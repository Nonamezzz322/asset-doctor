package encode

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// tempPrefixes are the basenames the encoder creates. The sweeper only ever touches files matching one
// of these — it will never delete an unrelated file that happens to share the scratch dir.
var tempPrefixes = []string{"enc-in-", "enc-out-"}

// SweepOrphans deletes encoder temp files in dir older than maxAge. Under normal operation Encode's
// deferred unlinks remove temps immediately; the sweeper is the backstop for a hard crash / OOM-kill that
// skips defers. maxAge MUST exceed the exec timeout so the sweep never races a live encode.
// It returns the number of files removed (handy for the test + for a metric later).
func SweepOrphans(dir string, maxAge time.Duration, now time.Time) (removed int) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	cutoff := now.Add(-maxAge)
	for _, e := range entries {
		if e.IsDir() || !isEncoderTemp(e.Name()) {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if info.ModTime().Before(cutoff) {
			if err := os.Remove(filepath.Join(dir, e.Name())); err == nil {
				removed++
			}
		}
	}
	return removed
}

func isEncoderTemp(name string) bool {
	for _, p := range tempPrefixes {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}

// RunSweeper runs SweepOrphans on a ticker until ctx is cancelled. Intended to be launched as a goroutine
// in main. Errors are non-fatal (the sweeper is a backstop, not a critical path).
func RunSweeper(ctx context.Context, dir string, interval, maxAge time.Duration, onRemoved func(int)) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if n := SweepOrphans(dir, maxAge, time.Now()); n > 0 && onRemoved != nil {
				onRemoved(n)
			}
		}
	}
}
