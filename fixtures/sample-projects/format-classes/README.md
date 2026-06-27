# format-classes

Three **loose** images, one per **content class**, for the content-class format-suitability verdict
(`docs/improvements/content-class.md`). Each carries a hand-authored golden `contentClass` in
`expected.json` — the independent cross-check of `classifyContent` (the classifier runs on the **9×8
dHash sample** the worker already decodes; Invariant 4 — no encode).

The images are drawn on a grid that is an exact multiple of **9×8** (180×160, 20px cells) and aligned to
cell boundaries, so a box-average downsample to 9×8 is deterministic and the class survives the resample:

- **`flat-fill.png`** — one solid opaque color → `grayStdDev` ≈ 0 (below `FLAT_STD` = 12) → **flat**.
- **`photographic.png`** — every 9×8 cell a distinct high-contrast luminance → `grayStdDev` far above
  `FLAT_STD`, fully opaque (no alpha poles) → **photographic**. A per-cell pattern (not pixel noise) so the
  box-average preserves the inter-cell variance.
- **`alpha-art.png`** — a **hard cutout**: a solid opaque block over the left ~half, fully transparent over
  the right ~half (one mid-alpha smear column between) → both alpha poles populated past `minPole` (0.12)
  ⇒ `hasHardAlpha` ⇒ **alpha-art** (checked before the flat-variance branch).

flat / alpha-art ⇒ `messageKey:'format-lossless'` (rule stays `format`); photographic ⇒ today's lossy
verdict (gradients are deliberately out of the confident set, M2).
