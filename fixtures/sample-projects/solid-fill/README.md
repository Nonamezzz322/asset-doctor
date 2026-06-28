# solid-fill

Two **loose** images for the single-color (**solid-fill**) detector
(`docs/improvements/round6-f2-solid-fill.md`). Each carries a hand-authored golden `solid` flag in
`expected.json` — the independent cross-check of `isSolidColor` (the detector runs on the **9×8 dHash
sample** the worker already decodes; Invariant 4 — no encode).

Both are drawn on a grid that is an exact multiple of **9×8** (576×512, 64px cells), so a box-average
downsample to 9×8 is deterministic and the verdict survives the resample:

- **`plate.png`** — one solid opaque color edge to edge → every per-channel stdDev ≈ 0 (below
  `SOLID_STD` = 2) → **solid**. A 576×512 solid PNG pins ≈1.2 MB of VRAM to carry one color.
- **`framed.png`** — a solid center with a **thick 64px** perimeter (exactly one 9×8 cell) of a
  different color → the outer ring of sample cells reads color A, the interior reads color B, so the
  full A↔B delta survives the box-average → **not solid**.

**Limitation (by design):** a feature thinner than one 9×8 cell (e.g. a 1px border) is below the sample
resolution — it box-averages into the surrounding cell and the image reads as solid. Only structure at
least one cell thick is detectable. (That is why the negative control uses a 64px frame, not a 1px one.)
