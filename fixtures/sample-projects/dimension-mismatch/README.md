# dimension-mismatch

A **stale / downscaled manifest**: the TexturePacker **Hash** JSON declares `meta.size`
`1024×1024`, but the real `sheet.png` is only **512×512**. The two sizes are parsed
independently — `atlas.size` from `meta.size`, `image.size` from the decoded PNG header — and
the always-on static audit now compares them.

The frame `off_right` is placed at `x:600, w:100` → `700`. That is **within** the declared
`1024` (so the parser's out-of-bounds pass, which tests the *declared* size, lets it through as
a placed sprite) yet **past** the real `512` edge — at runtime it samples transparent/garbage.
This is the exact bug the OOB check misses, surfaced today only by an optional render-probe.

`dimensionMismatchFinding` fires **crit** (real < declared **and** ≥1 frame off the real edge),
with the two measurements stated verbatim (`1024×1024` declared vs `512×512` real) and **no**
estimate — it is a correctness finding, never a saving (invariant 5). The copy also discloses
that the static VRAM estimate (w·h·4) is charged on the **declared** `1024²` (4 MB), so it
**over-states** the real `512²` footprint — a factual disclosure of the existing accounting.

Occupancy is computed on the declared `1024²` (12.4%), so the sheet also reads occupancy **crit**
with a `wasted-regions` overlay. The golden in `expected.json` lists all three.
