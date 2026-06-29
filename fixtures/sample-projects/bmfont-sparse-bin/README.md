# bmfont-sparse-bin

The **binary serialization** (AngelCode BMF v3) of `bmfont-sparse` — same 16 glyphs + whitespace +
out-of-page glyph + 2 kerning records, same `font.png`, same `expected.json`. `parseFntBinary` produces a
**byte-identical** `FntPage[]` to `parseFntText`. Ingest dispatches the `BMF\x03` magic to the binary
parser; the font-glyph-page readout fires identically. The blob is committed AND reproducible via
`node fixtures/_generator/generate.mjs` (`encodeBmfBinary`).
