// Command encoder is the Asset Doctor KTX2 native-encode SIDECAR. It runs on an internal docker network
// only and is reached EXCLUSIVELY by apps/api (the gateway), which verifies the license entitlement and
// applies per-license quota before proxying here. This process holds NO secrets and NO database.
//
// SAFETY (load-bearing): assets reaching this service are processed IN MEMORY + ephemeral tmpfs and
// deleted immediately; image bytes are NEVER logged; the container runs non-root on a read-only FS with
// a scratch tmpfs for temp files. This path is OPT-IN per the amended invariants — assets leave the
// device only on explicit per-run user consent, gated upstream by apps/api.
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Nonamezzz322/asset-doctor/apps/encoder/internal/config"
	"github.com/Nonamezzz322/asset-doctor/apps/encoder/internal/encode"
	"github.com/Nonamezzz322/asset-doctor/apps/encoder/internal/httpapi"
)

func main() {
	cfg := config.Load()
	logger := log.New(os.Stderr, "encoder ", log.LstdFlags|log.LUTC)

	// Dispatcher routes each Op to its concrete encoder (KTX2→toktx, pngquant→pngquant). Adding an op never
	// touches the HTTP layer — only this wiring + the encode allowlists.
	enc := &encode.Dispatcher{
		Toktx:    encode.NewToktxEncoder(cfg.ToktxPath, cfg.TmpDir, cfg.ExecTimeout),
		PngQuant: encode.NewPngQuantEncoder(cfg.PngQuantPath, cfg.TmpDir, cfg.ExecTimeout),
	}
	srv := &http.Server{
		Addr:    cfg.Addr,
		Handler: httpapi.New(cfg, enc, logger).Router(),
		// ReadTimeout is generous because the body is a large PNG upload; the EXEC timeout (toktx) is the
		// real cost wall and lives inside the encoder. WriteTimeout must exceed ExecTimeout so a slow
		// encode can still flush its result.
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      cfg.ExecTimeout + 30*time.Second,
		IdleTimeout:       120 * time.Second,
	}

	// Orphan-temp sweeper: a backstop for temps left by a hard crash that skipped Encode's deferred
	// unlinks. Runs until shutdown.
	ctx, cancelSweep := context.WithCancel(context.Background())
	defer cancelSweep()
	go encode.RunSweeper(ctx, cfg.TmpDir, cfg.SweepInterval, cfg.SweepMaxAge, func(n int) {
		logger.Printf("sweeper: removed %d orphan temp file(s)", n)
	})

	go func() {
		logger.Printf("encoder sidecar listening on %s (toktx=%s, pngquant=%s, tmp=%s, maxConcurrent=%d)",
			cfg.Addr, cfg.ToktxPath, cfg.PngQuantPath, cfg.TmpDir, cfg.MaxConcurrent)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Fatalf("serve: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	logger.Print("shutting down…")
	cancelSweep()
	shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutCtx); err != nil {
		logger.Printf("shutdown: %v", err)
	}
}
