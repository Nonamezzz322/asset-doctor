# Runtime profiler (Phase 4-C — foundation)

The moat's **runtime half**: drop into a live HTML5 game (as a snippet, or injected by a browser
extension) and read the actual per-frame GPU workload — the thing static analysis and competitors
cannot give. Built on the same GL instrument as the render-probe (`packages/probe`).

## How it works

`installRuntimeProfiler()` (must run BEFORE the renderer initialises):

1. Patches `HTMLCanvasElement.getContext` → instruments **every** WebGL context the page creates
   (games often make a throwaway capability-probe context first), Spector.js-style.
2. Wraps `requestAnimationFrame` → after each render callback, snapshots the instrument's per-frame
   counters and resets, building a per-frame timeline.

`report()` returns a `RuntimeReport`.

## Metrics

**Structural / GPU-workload (device-independent — valid from headless or an extension):**
draw calls/frame (avg over rendered frames, max), texture binds/frame, **redundant binds** (re-binding
the already-bound texture/program — wasted state changes), texture **uploads during gameplay** and
**shader compiles during gameplay** (hitch causes, after a warmup window), live texture count, VRAM
(Σ w×h×4), and a `hitches` list (frames with a >2× frame-time spike + likely cause).

**Timing (only trustworthy on the real target device):** FPS, frame-time avg/p95 — flagged
`deviceDependent: true`. We never sell datacenter/desktop timing as "what the player sees".

## Verified live

Driven against a real animated PixiJS v8 scene (60 sprites, 3 textures) in headless Chromium
(SwiftShader), `tools/verify/runtime-run.mjs` against `apps/web/runtime.html`:

```
draw calls/frame  avg 1  max 1     (60 sprites + 3 textures batch into one draw — correct)
texture binds/frame 0    redundant binds 0   (efficient: textures bound once in warmup)
live textures 4   VRAM 12 KB   gameplay uploads/compiles 0/0   (no hitches)
timing  fps 125  frametime 8ms (p95 16.6ms)   [device-dependent]
```

The instrument's accounting (draw counts, redundant binds, VRAM, both texImage2D forms, mipmaps) is
unit-tested headless in `packages/probe/test/instrument.test.ts`.

## Usage (snippet)

```ts
import { installRuntimeProfiler } from '@asset-doctor/probe';
const profiler = installRuntimeProfiler({ warmupFrames: 30 }); // BEFORE the game loads
// … game runs …
const report = profiler.report();
```

## Next slices

- **Chrome extension (MV3)** — ✅ done: [`apps/extension`](../apps/extension) injects this SDK into
  any page as a MAIN-world content script at `document_start` + a live on-page HUD. Verified loading
  the real extension in headless Chromium (`tools/verify/ext-run.mjs`). Next within it: messaging
  (MAIN ↔ isolated ↔ popup/devtools) to surface the full report + capture/export.
- **Correlation layer** (linter → doctor): stitch these runtime numbers to the static findings, e.g.
  "symbols 58% empty (static) AND 47 draw calls / 31 binds (runtime) → spread across 4 atlases, not
  batching → merge to 2 ≈ 18 draw calls." This is where the two halves become one verdict.
