# tier-source

Mixed inputs for the **SCALE-TIER export** slice (`docs/scale-tiers-design.md`).

- **`banner.png`** — an odd **100×50** loose image. The whole-folder default ladder produces
  `_1080p` 100×50, `_720p` 75×38 (×0.75), `_540p` 50×25 (×0.5). The independently-rounded aspect
  (round(w/h·50) = 100 vs 99) is exactly the case the resolution-stem clustering must re-cluster into
  ONE group (correction 3 round-trip).
- **`sheet.png` / `sheet.json`** — a small TexturePacker **Hash** atlas to **tier** (scaleAtlas
  geometry + a per-tier manifest with scaled frames and per-tier `meta.image`/`meta.scale`).
- **`meshed.png` / `meshed.json`** — a TP-Hash atlas whose frames carry a `Sprite.mesh`
  (vertices/verticesUV/triangles, a CCW corner fan). `scaleAtlas` **drops** mesh, so tiering is
  **refused** for any atlas carrying a source mesh (correction 2). The fixture round-trips the mesh
  back through the parser so `scaleAtlas(meshed, 0.5).sprites[i].mesh === undefined` is a real assertion.
- **`spine_single.*`** — a single-page Spine `.atlas` → tiering **allowed**.
- **`spine_multi.*`** — a **two-page** `.atlas` (pages `spine_multi_0.png` + `spine_multi_1.png`)
  → tiering **skipped** in v1 (per-page emit would clobber the shared `info.path`; correction 4).

Pixels are irrelevant to the pure scale tests (geometry only); they exist so the parse/ingest
round-trip is real.

Note (P3 parser fixes, 2026-07-17): `spine_multi.atlas` pages are separated by the CANONICAL
blank line (the libGDX/spine-ts page-separator contract real exporters emit; the parser's old
`size:`-lookahead tolerated its absence but mis-split real files both ways).
