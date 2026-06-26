# poly-concave

8 untrimmed **128×128** sprites (frame == bbox) on a 512×512 TexturePacker **Hash** atlas, drawn with
**concave** opaque silhouettes whose opaque area is only ~half each bounding box:

- `tri_ll_*` / `tri_ur_*` — complementary right-triangles split on the anti-diagonal (▙ / ▝). Each
  opaque half is ~50% of its bbox; a ▙ and a ▝ **interlock into one 128×128 square**.
- `lshape_0` — a thick concave **L** (left column + bottom row); the top-right quadrant is transparent.
- `chevron_0` — a downward **chevron** with a deep transparent notch at the top.

### Known defect (what this fixture proves)
Rectangle packing sees only the 128×128 **bounding boxes** (the transparent halves are dead weight), so it
needs a **512² POT** sheet. The binary (bitmap-mask) polygon packer measures the actual opaque silhouette
at the `ACC_CELL=4` grid (with a conservative +1-cell dilation for the `padding=2` bleed budget) and
**interlocks the complementary pairs into a 256² POT** sheet — **1/4 the VRAM**. At least one concave
sprite traces to a real mesh (non-null `traceMesh`), so `verticesUV` / `triangles` ship in the
polygon manifest and the on-screen receipt reports the meshed count. This is the end-to-end proof that
polygon mode beats rectangle packing on genuinely concave art.
