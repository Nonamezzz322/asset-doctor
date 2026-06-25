---
name: check-invariants
description: Audit the Asset Doctor codebase against its 5 architecture invariants — especially zero network in the client analysis path, analysis-in-worker, thin backend, objectivity (no generation), and disk≠VRAM honesty. Use before merging analysis/web changes or when verifying privacy claims.
---

# Check architecture invariants

Run these checks and report violations with `file:line`. These are the product's promises — treat a violation as a release blocker, not a nit.

1. **Assets never leave the device.** Grep the analysis/import path in `apps/web`, `packages/parsers`, `packages/analysis` for `fetch(`, `XMLHttpRequest`, `WebSocket`, `navigator.sendBeacon`, an image `src` pointing off-origin, or any upload. The analysis flow must be 100% local. Any network call there is a bug.
2. **Heavy work off the main thread.** Confirm parsing/analysis run inside a Web Worker, not the UI thread. Flag synchronous heavy loops in React render/effects.
3. **Thin backend.** No image processing, packing, or asset bytes server-side in the base scenario. (In Phase 1 there should be no backend at all.)
4. **Objectivity — measure, don't generate.** No code that fabricates "optimized" output or fakes an "after" result. Savings are computed numbers; the emptiness overlay is real grid data. Flag any faked/mocked result presented as real.
5. **disk ≠ VRAM.** Wherever footprint is shown, VRAM (w×h×4) must appear alongside disk bytes, never conflated. Flag UI/strings implying file size == GPU cost.
6. **Thresholds in config.** Grep analysis rules for inline magic numbers that belong in `ThresholdConfig`.

Output a short table: invariant → pass/fail → evidence. If all pass, say so explicitly.
