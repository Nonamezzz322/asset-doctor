# bmfont-sparse

A single-page **AngelCode BMFont** `.fnt` (TEXT format) glyph page for the **font-glyph-page** readout
(`docs/improvements/round23-bitmap-font-fnt-bmfont-parser-inge.md`).

A 256×256 POT page carries **16 small opaque glyph rects** (ASCII `A`–`P`, 20×20 each) → a **sparse**
glyph sheet at ~9.8% occupancy: the documented defect, a glyph page pinning **w×h×4 VRAM** for mostly-empty
space. 16 usable glyphs clears `minChars` (16) and occupancy ≤ `occupancyWarn` (0.5), so the readout is
**warn**.

- a **whitespace glyph** (`id=32`, `width=0 height=0`) → skipped from sprites, **not** an error.
- one deliberately **out-of-page glyph** (`id=255` at 250,250 / 40×40) → dropped + surfaced via **per-glyph
  recovery** (kept OUT of the usable glyph count).

The `.fnt` page **is** an Atlas, so the generic **occupancy** (crit) + **wasted-regions** (info) findings
fire for free — the font readout sits BESIDE them and its estimate carries **only** `occupancyPct` (the
generic findings own the VRAM on the same page — invariant 5, no double-count).

The regression test feeds this through the **REAL path** (`groupFiles → parseFntPage → analyze` with the
`fontPages` dep) and asserts the `font-glyph-page` finding **fires** with the documented glyph/kerning
counts. The sibling `bmfont-sparse-xml/` and `bmfont-sparse-bin/` carry the SAME glyphs in the XML +
binary serializations (same `font.png`, same `expected.json`) — each parser yields a byte-identical page.
