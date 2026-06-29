# bmfont-sparse-xml

The **XML serialization** of `bmfont-sparse` — same 16 glyphs + whitespace + out-of-page glyph + 2 kerning
records, same `font.png`, same `expected.json`. `parseFntXml` produces a **byte-identical** `FntPage[]`
to `parseFntText` on `bmfont-sparse/font.fnt`. Ingest dispatches the leading `<` to the XML parser; the
font-glyph-page readout fires identically.
