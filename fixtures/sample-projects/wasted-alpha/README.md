# wasted-alpha

Two **loose** PNGs for the **wasted-alpha** detector — a fully-opaque image still carrying an alpha channel
(`docs/improvements/round15-wasted-alpha-detector-full-frame-opaque-.md`). Each carries a hand-authored
golden `opaque` flag in `expected.json` — the independent cross-check of `alphaFullyOpaque`.

**Unlike** the solid-fill / content-class fixtures, this detector runs on the **full-resolution** decode
(a single transparent pixel must NOT box-average away), so the golden is authored over the full-res RGBA and
the test reads the PNG directly (no 9×8 downsample):

- **`opaque.png`** — a solid opaque 256×256 fill → every pixel alpha 255 → the alpha channel is **dead
  weight on disk** → `opaque:true`. The MEASURED disk cost (re-encode opaque, same format) is the finding's
  `diskBytesSaved`.
- **`transparent.png`** — opaque 192×192 content with a fully-transparent **32px margin** → at least one
  alpha-0 pixel → the channel is **in use** → `opaque:false`.

**Honesty (invariant 5):** dropping the dead channel is a **download/disk** saving only — the GPU still
decodes to RGBA8888 and allocates the same VRAM. The finding reports `diskBytesSaved` and **never** a VRAM
win. The diagnosis MEASURES (opaque or not) and reports the byte cost; the opaque re-encode itself is the
**Pro fix's** job (generation — invariant 3).
