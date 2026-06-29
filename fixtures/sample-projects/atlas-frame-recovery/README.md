# atlas-frame-recovery

A TexturePacker atlas (both Hash and Array layouts) that mixes **good** frames with exactly **one**
corrupt frame, to prove per-frame recovery: a single bad frame no longer drops the whole sheet
(`docs/improvements/round21-per-frame-recovery-for-texturepack.md`) — symmetric with the Spine
per-region recovery (`spine-loose-spill`).

- **`sheet.png`** — a valid 128×128 page anchoring the atlas size for the OOB pass.
- **`hash.json`** — TexturePacker **Hash** layout: `a.png` + `b.png` are valid in-bounds frames;
  `bad.png` has a degenerate `frame.w: 0` → `readRect` rejects it → `bodyToSprite` returns null →
  surfaced `invalid frame "bad.png"`. **2 sprites survive.**
- **`array.json`** — TexturePacker **Array** layout: `c.png` + `d.png` are valid; `over.png` has
  `frame.x + frame.w = 160 > 128` → caught by the out-of-bounds pass → surfaced
  `frame "over.png" extends past atlas 128×128`. **2 sprites survive.**

Before round21 #1, `parseAtlasManifest` returned `{ok:false}` on the first unusable frame, losing
every good frame for one corrupt one. Now it collects each dropped frame into `malformedFrames[]`
`{name, reason}` and keeps the good sprites; the analyze worker fans those into the existing
`unparsed[]` surface as `<atlas>#<frame>` (deterministic, sorted). A **structurally** unparseable
manifest (bad JSON / no frames object / no `meta.image`) still wholesale-fails as before
(see `unparsed-corrupt`). A fully-valid atlas parses byte-identically — no `malformedFrames` field.

`expected.json` pins the surviving sprite names, the surfaced `{name, reason}` per layout, and the
worker's `unparsed` refs (`sheet.png#bad.png`, `sheet.png#over.png`). Honesty (Invariant 3): every
dropped frame is reported with a reason; nothing is silently dropped or clamped.
