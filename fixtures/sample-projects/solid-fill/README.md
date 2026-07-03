# solid-fill

Three **loose** images for the single-color (**solid-fill**) detector
(`docs/improvements/round6-f2-solid-fill.md`). Each carries hand-authored golden `solid` (the cheap
**9×8 pre-filter** `isSolidColor`) and `solidFullRes` (the **full-resolution confirmation**
`isSolidFullRes`) flags in `expected.json` — independent cross-checks of the two detector stages. The
worker now sets `ImageFeatures.solid` only when **both** are true (candidate AND confirmed).

All three are drawn on a grid that is an exact multiple of **9×8** (576×512, 64px cells), so a
box-average downsample to 9×8 is deterministic and the verdict survives the resample:

- **`plate.png`** — one solid opaque color edge to edge → every per-channel stdDev ≈ 0 (below
  `SOLID_STD` = 2) **and** full-res spread 0 (≤ `SOLID_FULL_TOL` = 8) → **solid**. A 576×512 solid PNG
  pins ≈1.2 MB of VRAM to carry one color.
- **`framed.png`** — a solid center with a **thick 64px** perimeter (exactly one 9×8 cell) of a
  different color → the outer ring of sample cells reads color A, the interior reads color B, so the
  full A↔B delta survives the box-average **and** the full-res spread ≫ tol → **not solid** at either
  stage.
- **`speck.png`** — a solid plate with a tiny **12×12** contrasting speck fully inside one interior
  64px cell. The speck is **sub-cell**: box-averaging dilutes it to a per-channel stdDev < `SOLID_STD`,
  so the **9×8 pre-filter reads `solid = true` (a false positive)** — but the speck pixels swing a
  channel by the full contrast (180 ≫ `SOLID_FULL_TOL`), so the **full-resolution confirmation reads
  `solid = false`**. The worker requires both ⇒ **not flagged**.

**Sub-cell features are now caught (was a known limitation).** A feature thinner than one 9×8 cell
(e.g. `speck.png`'s 12×12 dot, or a 1px border) box-averages into its cell and the 9×8 pre-filter reads
it as solid. That used to fabricate a ~1.2 MB VRAM saving on a not-actually-solid image; the
**full-resolution confirmation** (`isSolidFullRes`) now vetoes those candidates, so only a genuinely
single-color image (`plate.png`) is flagged. `speck.png` is the before/after that pins the fix.
