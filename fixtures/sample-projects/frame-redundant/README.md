# frame-redundant

ONE atlas with **within-atlas duplicate frames** for the **frame-redundancy** detector
(`docs/improvements/round18-animation-frame-redundancy-detector-.md`).

A 256×32 strip of **8 frames** (32×32 each). Every frame is **textured** (a 2-color checker), not a single
solid fill — solid regions are nulled by the production flat-guard and would never cluster:

- **`idle_0`–`idle_3`** — the SAME checker pattern → **byte-identical 32×32 pixel regions** → one cluster
  of 4 (≥ `minDuplicates` = 3). **3 frames are recoverable** beyond the one representative kept.
- **`walk_0`–`walk_3`** — each a distinct checker → not redundant (but still textured, so each is hashed).

The detector hashes each sprite's **region** off the already-decoded page (worker `hashAtlasFrames` →
pure `extractFrameRegions`) and clusters identical regions. It **MEASURES** the duplicate set + wasted bytes:

- **VRAM** — the recoverable distinct-rect area × 4 (here 3 × 32×32 × 4 = **12 288 B**), the atlas space the
  duplicates pin that a de-duplicated repack reclaims. Exact area arithmetic.
- **DISK** — an **area-proportional estimate** only (no per-region disk bytes exist), carried separately and
  **never** conflated with VRAM (invariant 5).

De-duplicating the frames is the **Pro fix's** job (generation — invariant 3). The regression test feeds this
PNG through the REAL hashing path (decode → pure `extractFrameRegions` → SHA) and asserts the cluster fires —
the duplicate frames are textured-but-identical precisely so the production flat-guard does NOT skip them.
