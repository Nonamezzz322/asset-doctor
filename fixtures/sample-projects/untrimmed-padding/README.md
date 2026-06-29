# untrimmed-padding

ONE atlas with **untrimmed sprites carrying transparent padding** for the **trim-margin** detector
(`docs/improvements/round19-trim-margin-detector.md`).

A 256×256 sheet, 4 frames in a row of 64×64 cells. Each opaque core is a **textured** 2-color checker
(the detector reads alpha, not luma — the texture just keeps the art honest):

- **`padded_0`–`padded_2`** — **untrimmed** (`trimmed:false`, frame == full 64×64 image, NO
  `spriteSourceSize`), each with a transparent margin around a smaller opaque core → genuine
  reclaimable padding.
- **`trimmed_0`** — **already trimmed** (carries `spriteSourceSize`); the detector **SKIPS** it (a
  trimmed frame has no reclaimable margin) — a no-double-count negative golden.

The detector computes each sprite's **opaque bbox** off the already-decoded page (worker `alphaBBox`,
the SAME decode pass as frame-redundancy) and sums **(frame area − bbox area)** over the UNtrimmed
sprites:

- **VRAM** — the recoverable padding area × 4 (the atlas space the margins pin that a **trimmed repack
  reclaims up to**). EXACT area arithmetic.
- **DISK** — an **area-proportional estimate** only, carried separately and **never** conflated with
  VRAM (invariant 5).

Trimming the frames is the **Pro fix's** job (generation — invariant 3). The regression test feeds this
PNG through the REAL decode path (decode → `alphaBBox` → `trimMarginFinding`) and asserts the finding
fires with the documented recoverable area.
