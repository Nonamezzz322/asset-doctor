# strippable-metadata

One **hand-authored** PNG for the **strippable-metadata** detector — an image carrying ancillary metadata
(ICC profile / EXIF / XMP / text / timestamp chunks) the GPU never uses
(`docs/r25-design-0-strippable-metadata.md`). NOT produced by the `make-fixture` skill: the defect is not an
atlas defect, so the PNG bytes are authored directly (a real, valid 4×4 RGBA8888 PNG with injected
known-length ancillary chunks), exactly like the inline byte-array headers in `parsers.test.ts`.

## The file — `metadata.png`

A real, decoder-loadable PNG: `SIG · IHDR(4×4 RGBA8888) · pHYs · iCCP · tEXt · tIME · IDAT · IEND`.

| chunk | on-disk bytes (`len + 12`) | counted? | why |
| --- | --- | --- | --- |
| `iCCP` | 8227 | **yes** | embedded ICC profile — pure metadata, GPU never reads it |
| `tEXt` | 101 | **yes** | text comment — dead weight on disk |
| `tIME` | 19 | **yes** | last-modified timestamp — metadata |
| `pHYs` | 21 | **no** | physical pixel density — a re-encoder **keeps** it (may affect layout) |
| `IHDR` / `IDAT` / `IEND` | — | **no** | structural / pixel data |

`strippableMetadataBytes(metadata.png) === 8227 + 101 + 19 === **8347**`. The on-disk chunk size is
`data length + 12` (4 length + 4 type + data + 4 CRC). Since `8347 >= minBytes (4096)` the finding fires;
since `8347 < warnBytes (65536)` its severity is **info**. `estimate.diskBytesSaved === 8347` (EXACT);
**never** `vramBytesSaved` (invariant 5 — the GPU decodes to RGBA8888 regardless, so VRAM is unchanged).

## The allow-set (the counted chunks)

PNG: `{ iCCP, eXIf, tEXt, iTXt, zTXt, tIME }`. **Deliberately excluded:** `tRNS` (functional transparency),
`pHYs / gAMA / cHRM / sRGB / bKGD / sBIT` (may alter rendering / a re-encoder keeps `pHYs`). JPEG:
`APP1..APP15 + COM` (APP0/JFIF excluded). WebP: VP8X `EXIF / XMP / ICCP`. AVIF / unrecognized → 0.

## Test D — no over-claim (BLOCKING): the counted set is a TRUE LOWER BOUND

**Approach taken: documented-subset + fix-path analysis (NOT a live in-test canvas round-trip).** Re-encoding
a PNG through an `OffscreenCanvas` is not faithfully available in the Vitest/jsdom test env (no real PNG
encoder), so a live encode→diff would not prove anything. Instead the claim is anchored two ways:

1. **Strict subset of known-ancillary, non-pixel chunks.** Every counted chunk type is an *ancillary*
   PNG chunk (lowercase 5th-bit "safe-to-copy/ancillary" set) that carries **no pixel and no rendering
   data** — `iCCP/eXIf/tEXt/iTXt/zTXt/tIME`. None of `tRNS/pHYs/gAMA/cHRM/sRGB/bKGD/sBIT/IHDR/IDAT/PLTE`
   is ever counted. So the counted set ⊆ {chunks a metadata strip definitively removes}.

2. **Anchored to the EXISTING fix path.** The only PNG-emitting paths in `apps/web/src/worker/fix.worker.ts`
   are `convertToBlob({ type: 'image/png' })` (encode from a canvas) and `recompressPng()` → `@jsquash/oxipng`
   `optimise(getImageData(...))`. **Both consume pixels only** — `convertToBlob` re-encodes from the canvas
   raster and `oxipng.optimise` is handed `ImageData` (already-decoded RGBA), so **neither can carry forward
   any ancillary chunk from the source**. Canvas/`convertToBlob` PNG output is minimal — `IHDR / IDAT / IEND`
   (plus at most `pHYs`), **never** `iCCP/eXIf/tEXt/iTXt/zTXt/tIME`. There is **no raw-byte passthrough**
   anywhere (even the prebuilt-atlas passthrough re-decodes via `transcode()`), so the fix removes **all**
   ancillary metadata chunks — a strict **superset** of our counted set.

**Validated drop-set the fix removes:** `{ iCCP, eXIf, tEXt, iTXt, zTXt, tIME, + every other ancillary
chunk }`. **Counted set:** `{ iCCP, eXIf, tEXt, iTXt, zTXt, tIME }` ⊂ drop-set. Therefore the reported
`strippableBytes` is a **conservative true lower bound** of the bytes the existing fix actually removes — it
can never over-claim. `pHYs` is excluded from the count precisely because a re-encoder *may keep* it, so
counting it could over-claim.

**Honesty (invariant 5):** stripping metadata is a **download / disk** saving only — the GPU still decodes to
RGBA8888 and allocates the same VRAM. The finding reports `diskBytesSaved` and **never** a VRAM win. The
diagnosis MEASURES (a pure header walk, no decode — invariant 1); the strip itself is the **Pro fix's** job
(generation — invariant 3).
