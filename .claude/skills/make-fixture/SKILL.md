---
name: make-fixture
description: Generate a synthetic problem-atlas fixture for Asset Doctor regression tests — an atlas image plus its TexturePacker (Hash or Array) or PixiJS JSON, with a known documented defect and a golden expectations file. Use when adding test coverage for a parser format or an analysis threshold.
---

# Make a synthetic fixture

Fixtures live in `fixtures/sample-projects/<case-name>/`. Each case is small, deterministic, and documents the defect it encodes so thresholds can be calibrated against ground truth.

## Produce
1. **Atlas image** — generate programmatically (Node canvas or a raw pixel buffer → PNG) at a chosen size. Place colored rects at known positions so occupancy is exact. For NPOT cases pick a non-power-of-two size; for oversize pick > the oversize threshold.
2. **Manifest JSON** in the requested format:
   - `texturepacker-hash` (`frames` object keyed by name),
   - `texturepacker-array` (`frames` array with `filename`),
   - or `pixi` spritesheet.
   Include `meta.image`, `meta.size`, and per-frame `frame` / `rotated` / `trimmed` / `spriteSourceSize` / `sourceSize` as needed to exercise the parser.
3. **`expected.json`** — the golden truth: frame count, atlas size, computed occupancy, which findings + severities should fire, overlay rect count. Parser/analysis tests assert against this.
4. **`README.md`** (one paragraph) — what defect this case encodes and why those expectations.

## Defect catalog to cover
- Low occupancy (lots of empty space) — for occupancy + wasted-regions.
- Non-power-of-two size — for dimensions.
- Absolute oversize (e.g. 4096+).
- Trimmed and rotated sprites — to verify parser fidelity feeds correct areas.
- A PNG that compresses well to WebP — for format audit.

Keep numbers round so occupancy / areas are hand-verifiable. Determinism only — no randomness that breaks goldens.
