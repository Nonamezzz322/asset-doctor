# spine-loose-spill

Multi-page Spine packing: **12 opaque 64×64** loose regions + a trivial `skins`-array skeleton, packed
with a **forced small `maxSize` (128)** so they cannot fit one POT page and the packer **spills** onto
page 1+. Proves Feature 4 emits **one `.atlas` with N page blocks** (each region under **its own** page
header, driven by `pageOfName`) and page images `stem.png`, `stem_1.png`, … — never all regions under
page 0 (which would resolve spilled regions to the wrong image).

`expected.json` pins the multi-page **invariants** (≥2 pages; each re-parsed region's `frame.xy` within
its page size; `verified = N`), **not** exact placements — the MaxRects packer owns those. `allowRotation`
is always false; Spine pages default to PNG.
