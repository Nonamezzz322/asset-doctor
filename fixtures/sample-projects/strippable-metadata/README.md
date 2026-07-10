# strippable-metadata (+ icc-non-srgb honesty)

**Hand-authored** PNGs for the **strippable-metadata** detector and the **icc-non-srgb** colour-honesty rule —
images carrying ancillary metadata (ICC profile / EXIF / XMP / text / timestamp chunks) the GPU never uses
(`docs/r25-design-0-strippable-metadata.md`). NOT produced by the `make-fixture` skill: the defect is not an
atlas defect, so the PNG bytes are authored directly (real, valid 4×4 RGBA8888 PNGs with injected
known-length ancillary chunks), exactly like the inline byte-array headers in `parsers.test.ts`.

## Why two files — the ICC honesty rule

An embedded ICC profile is only a **free** disk strip when it is **sRGB** (sRGB is the web/GPU default, so
dropping it does not change the rendered colours). A **non-sRGB** profile (Display P3 / Adobe RGB / …) is
**load-bearing**: stripping it silently shifts the colours. So `strippableMetadataBytes` counts an ICC
profile's bytes **only when we can PROVE the profile is sRGB** (`iccProfileInfo` — a header-only proof: an
`sRGB` chunk, an iCCP profile NAME matching `/srgb/i`, or an ICC `desc` tag for JPEG/WebP). Absence of proof
⇒ the bytes are **excluded** (a conservative TRUE LOWER BOUND — under-claiming a saving is correct;
over-claiming is a bug) and the `icc-non-srgb` finding **discloses** it (info; **NO estimate** — precedent:
texture-bleeding, dimension-mismatch). The Pro strip fix then **keeps** the chunk (`keepIcc`).

## `metadata.png` — the PROVABLY-sRGB case (ICC counted)

`SIG · IHDR(4×4 RGBA8888) · pHYs · iCCP · tEXt · tIME · IDAT · IEND`. The iCCP profile is **named
`sRGB IEC61966-2.1`**, so it is provably sRGB and its bytes stay counted.

> **Fixture history.** This file's iCCP profile was originally named `ICCProfile`, which the new rule cannot
> prove is sRGB. It was **renamed** to `sRGB IEC61966-2.1` so the file keeps testing what it was written to
> test — *an ICC profile that IS counted* — while the non-provable path moved to its own file
> (`metadata-p3.png`). The iCCP chunk length (`8215`) and every golden number are therefore **unchanged**; only
> the profile name and its (re-generated, still valid) zlib payload differ. Both PNGs remain real,
> decoder-loadable images: every chunk CRC is valid and each iCCP payload inflates cleanly.

| chunk | on-disk bytes (`len + 12`) | counted? | why |
| --- | --- | --- | --- |
| `iCCP` | 8227 | **yes** | embedded ICC profile, **provably sRGB** (name `sRGB IEC61966-2.1`) — a free strip |
| `tEXt` | 101 | **yes** | text comment — dead weight on disk |
| `tIME` | 19 | **yes** | last-modified timestamp — metadata |
| `pHYs` | 21 | **no** | physical pixel density — a re-encoder **keeps** it (may affect layout) |
| `IHDR` / `IDAT` / `IEND` | — | **no** | structural / pixel data |

`strippableMetadataBytes(metadata.png) === 8227 + 101 + 19 === **8347**`. Since `8347 >= minBytes (4096)` the
finding fires; since `8347 < warnBytes (65536)` its severity is **info**. `estimate.diskBytesSaved === 8347`
(EXACT); **never** `vramBytesSaved` (invariant 5). `icc = { bytes: 8227, provableSrgb: true, label:
"sRGB IEC61966-2.1" }`; the `icc-non-srgb` finding does **not** fire (the profile is provably sRGB).

## `metadata-p3.png` — the NON-sRGB case (ICC excluded + disclosed)

`SIG · IHDR(4×4 RGBA8888) · iCCP · tEXt · IDAT · IEND`, iCCP **named `Display P3`**, and **no `sRGB` chunk**.

| chunk | on-disk bytes | counted? | why |
| --- | --- | --- | --- |
| `iCCP` | 3024 | **NO** | ICC profile `Display P3` — NOT provably sRGB ⇒ stripping it shifts colours ⇒ excluded |
| `tEXt` | 62 | **yes** | text comment — the only strippable metadata |
| `IHDR` / `IDAT` / `IEND` | — | **no** | structural / pixel data |

`strippableMetadataBytes(metadata-p3.png) === **62**` (the iCCP's 3024 bytes are excluded). `62 < minBytes
(4096)` ⇒ the **strippable-metadata finding does NOT fire**. `icc = { bytes: 3024, provableSrgb: false,
label: "Display P3" }` ⇒ the **`icc-non-srgb`** finding fires (info; **NO estimate** — no diskBytesSaved, no
vramBytesSaved; params `{ label: "PNG", bytes: 3024, profile: "Display P3" }`).

## The allow-set (the counted chunks)

PNG: `{ iCCP, eXIf, tEXt, iTXt, zTXt, tIME }`. **Deliberately excluded:** `tRNS` (functional transparency),
`pHYs / gAMA / cHRM / sRGB / bKGD / sBIT` (may alter rendering / a re-encoder keeps `pHYs`). JPEG:
`APP1..APP15 + COM` (APP0/JFIF excluded). WebP: VP8X `EXIF / XMP / ICCP`. AVIF / unrecognized → 0. On top of
that, a **non-provably-sRGB ICC profile** (iCCP / ICCP / JPEG APP2 ICC) is subtracted back out of the count.

## Test D — no over-claim (BLOCKING): the counted set is a TRUE LOWER BOUND

**Approach taken: documented-subset + fix-path analysis (NOT a live in-test canvas round-trip).** Re-encoding
a PNG through an `OffscreenCanvas` is not faithfully available in the Vitest/jsdom test env (no real PNG
encoder), so a live encode→diff would not prove anything. Instead the claim is anchored two ways:

1. **Strict subset of known-ancillary, non-pixel chunks.** Every counted chunk type is an *ancillary*
   PNG chunk (lowercase 5th-bit "safe-to-copy/ancillary" set) that carries **no pixel and no rendering
   data** — `iCCP/eXIf/tEXt/iTXt/zTXt/tIME`. None of `tRNS/pHYs/gAMA/cHRM/sRGB/bKGD/sBIT/IHDR/IDAT/PLTE`
   is ever counted, and a non-sRGB ICC profile is further excluded. So the counted set ⊆ {chunks a metadata
   strip removes **without changing the decoded pixels OR the colours**}.

2. **Anchored to the EXISTING fix path.** The only PNG-emitting paths in `apps/web/src/worker/fix.worker.ts`
   are `convertToBlob({ type: 'image/png' })` (encode from a canvas), `recompressPng()` → `@jsquash/oxipng`
   `optimise(getImageData(...))`, and the lossless `stripImageMetadata` (`strip` FixOp). The first two consume
   pixels only, so they **cannot carry forward any ancillary chunk** from the source. `stripImageMetadata`
   removes **exactly** the counted set (pinned lock-step by `packages/fix/test/strip.test.ts`), and with
   `keepIcc` it **keeps** a non-sRGB ICC profile — matching the detector's exclusion byte-for-byte.

**Counted set:** `{ iCCP (only if provably sRGB), eXIf, tEXt, iTXt, zTXt, tIME }` ⊆ drop-set. Therefore the
reported `strippableBytes` is a **conservative true lower bound** of the bytes the existing fix actually
removes — it can never over-claim. `pHYs` is excluded because a re-encoder *may keep* it; a **non-sRGB ICC**
is excluded because removing it would **change the rendered colours** — counting it would be an invariant-3
lie.

**Honesty (invariant 5):** stripping metadata is a **download / disk** saving only — the GPU still decodes to
RGBA8888 and allocates the same VRAM. The `strippable-metadata` finding reports `diskBytesSaved` and **never**
a VRAM win; the `icc-non-srgb` finding reports **no saving at all**. The diagnosis MEASURES (a pure header
walk, no decode — invariant 1); the strip itself is the **Pro fix's** job (generation — invariant 3).
