# Render-probe spike — GO / NO-GO (TODO)

> Placeholder for the moat spike's conclusion. Filled in during Milestone 1 by the
> render-probe POC (see the `probe-engineer` agent and `packages/probe`).

## Question

Can we load one atlas PNG into offscreen PixiJS v8 (WebGL) and **reliably** read:

1. **Draw calls** — via a GL-context wrapper (`drawElements` / `drawArrays`) and/or PixiJS
   renderer stats?
2. **VRAM** — Σ over live base textures of `w × h × 4`?

If both read cleanly, the differentiator static analyzers cannot replicate is real → **GO**.

## Method

_(to fill: offscreen canvas setup, GL wrapper approach, what was loaded, how counts were
cross-checked)_

## Findings

_(to fill: measured draw calls, measured VRAM, reliability notes — a false GO is worse than
a NO-GO)_

## Decision

**GO / NO-GO:** _pending._

## Notes / caveats

- Structural / GPU-workload metrics (draw calls, VRAM, uploads, shader compiles) are
  **device-independent** — valid from headless or extension.
- Timing metrics (FPS, frame time, jank) are **not** trustworthy off the target device and
  must not be reported as "what the player sees".
