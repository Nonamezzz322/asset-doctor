# spine-pma

An under-filled (~16% occupancy) single-page Spine `.atlas` that declares **`pma: true`**
(premultiplied alpha — common in Spine exports). Drives e2e scenario 11: the fix must REFUSE to
repack it and surface an honest skip, because a canvas-2D recompose cannot round-trip premultiplied
pixels byte-losslessly (measured up to Δ8 on low-alpha edges — `tools/verify/pma-roundtrip-measure.mjs`).
Dropping the `pma` flag would also make a loader read premultiplied bytes as straight (too-bright/haloed).

`sheet.png` is copied from `spine-basic` (the pixel VALUES are irrelevant — the refusal is driven by the
`pma: true` FLAG, not by inspecting pixels). e2e-only: not in the analysis `ATLAS_CASES` golden list.
