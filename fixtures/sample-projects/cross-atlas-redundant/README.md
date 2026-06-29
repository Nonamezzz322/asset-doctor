# cross-atlas-redundant

TWO atlases sharing a **byte-identical frame** for the folder-scope **cross-atlas-redundancy** detector
(`docs/improvements/round22-cross-atlas-frame-redundancy-detec.md`).

Each sheet (`sheetA.png`, `sheetB.png`) is a 64×32 strip of **2 frames** (32×32 each). Every frame is
**textured** (a 2-color checker), not a single solid fill — solid regions are nulled by the production
flat-guard and would never cluster:

- **`shared`** — the SAME checker pattern on **both** sheets → **byte-identical 32×32 pixel regions** → one
  cross-atlas cluster spanning **2 sheets** (≥ `minDuplicates` = 2 cross-sheet copies). **1 copy is recoverable**
  beyond the one representative kept.
- **`a_only` / `b_only`** — a distinct checker per sheet → not redundant (but still textured, so each is hashed).

The detector clusters the SAME region hashes the within-atlas `frame-redundancy` rule consumes (here
folder-wide, off the already-decoded page) and fires ONLY when a cluster spans **≥2 atlases**. It **MEASURES**
the cross-sheet duplicate set + wasted bytes:

- **VRAM** — the recoverable distinct-rect area × 4 (here 1 × 32×32 × 4 = **4 096 B**), the **duplicate-frame**
  area that referencing one shared copy reclaims. EXACT area arithmetic — identical precedent to within-atlas
  frame-redundancy, **no** POT-tier bin gate / packer (a real MaxRects pack lands on a larger bin than any area
  floor, so a bin-tier delta would over-claim — invariant 5). **Orthogonal to atlas-merge** (which reclaims
  EMPTY space — different pixels).
- **DISK** — an **area-proportional estimate** only (no per-region disk bytes exist), attributed to each freed
  copy's own atlas, carried separately and **never** conflated with VRAM (invariant 5).

The cross-atlas FIX is a separate piece (generation — invariant 3). The regression test feeds both PNGs through
the REAL hashing path (decode → pure `extractFrameRegions` → SHA → `crossAtlasRedundancyFinding`) and asserts
the cluster fires — the shared frame is textured-but-identical precisely so the flat-guard does NOT skip it.
