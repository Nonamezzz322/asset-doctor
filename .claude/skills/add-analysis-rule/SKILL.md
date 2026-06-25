---
name: add-analysis-rule
description: Scaffold a new Asset Doctor analysis rule end-to-end so it stays consistent with the rest of packages/analysis. Use when adding or substantially changing an audit check (occupancy, wasted regions, format, dimensions, or a new one). Walks core type → rule impl → threshold config → fixture test → overlay → UI surfacing.
---

# Add an analysis rule

Keep every rule uniform. Do these in order; each is a small commit.

1. **Type (packages/core).** Add the rule id to the `Rule` union. If it needs a new finding shape or overlay kind, extend `Finding` / `OverlayZone` here — never inline ad-hoc shapes in analysis.

2. **Threshold (config).** Add the rule's thresholds to `ThresholdConfig` and the default config object. **No magic numbers in rule logic** — read from config. Pick provisional values, mark them `// calibrate`, and note they will be tuned on fixtures.

3. **Rule implementation (packages/analysis).** A pure function `(asset, cfg) => Finding[]`. Compute the measured number, compare to threshold, set `severity`, write a `title`/`detail` that states the verdict AND the proof (numbers, readout style). If visual, emit `OverlayZone` rects in atlas pixel coords. Fill `estimate` only with defensible numbers; if the effect is uncertain, say so in `detail` and leave estimate sparse.

4. **VRAM/disk honesty.** If the rule touches footprint, surface VRAM (w×h×4) next to disk bytes. Never imply file size == GPU cost.

5. **Fixture test (Vitest).** Add or extend a case under `fixtures/sample-projects` (use the `make-fixture` skill). Golden-assert: finding count, severity, key numbers (occupancy %, saved bytes), overlay rect count. A rule without a test is not done.

6. **Surface in UI.** Ensure the film-viewer findings list + overlay rendering handle the new rule / overlay kind. Coordinate with film-viewer-engineer if the core type changed.

7. **Run** `pnpm --filter @asset-doctor/analysis test` (and core) green before committing.
