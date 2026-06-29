I now have full code-grounded verification. The catalogs parity test (`catalogs.test.ts` L20) enforces all 9 locales carry identical keys — so omitting a locale fails, as the draft claims. ✓ The `renderFinding` mechanism and `$count` PluralForm shape are confirmed. ✓

I have everything needed to produce the revised design. Summary of findings:

**BLOCKERS/MAJORS found:**
1. **Multi-page glyph attachment is contradictory and wrong** (§3a / §8.3). The draft states both "attach to most-recent page" AND "attach to page whose id matches char.page." In real BMFont TEXT, ALL `char` lines come after ALL `page` lines, so "most-recent page" dumps every glyph onto the last page. Must key by `char.page` field. This is a determinism/correctness defect.
2. **Fabricated App.tsx label task** (§4e + task 9). No `source.kind`→label map exists in App.tsx; `atlas.source` is never rendered. The grep hit the draft cited is a comment (L1385). The `engine` state (L2437) is the unrelated Pixi/Phaser probe selector.

**Confirmed correct:** zero existing handling; spine mirror shape; fix-path safety (only `opts.kind==='spine'` branched, emits never reads); helper exports; core line numbers; i18n drift + parity contracts; ParseResult/malformedFrames consistency; worker keying.

Here is the revised design.

---

# Bitmap-font (.fnt BMFont) parser + ingest grouping + glyph-page audit — REVISED mini-design

## 0. Premise verification (code-grounded)

| Claim | Verdict |
|---|---|
| Zero existing `.fnt`/BMFont/glyph handling | **TRUE** — only hit is `packages/fix/test/packLoose.spine.test.ts` (unrelated "spine") |
| ingest knows only `.atlas` (L99) + `.json` (L120) | **TRUE** |
| `parseSpineAtlasText`→`SpinePage[]` / `parseSpinePage`→`ParseResult` is the mirror | **TRUE** (`spine-atlas.ts` L105/L169) |
| `malformedRegions` lives ON `SpinePage`, read by worker via `a.manifest as SpinePage` | **TRUE** (worker L83) — bmfont must mirror this exactly |
| `vramBytes`/`fmtBytes`/`occupancyValue` exported from `rules.ts` | **TRUE** (L11/L26/L32) |
| core L30 (`AtlasSourceKind`), L252 (`Rule`), L601 (`crossAtlasRedundancy`), `FindingEstimate.occupancyPct` L318 | **ALL TRUE** |
| fix path branches only on `'spine'`, emits source.kind, never reads incoming `AtlasSourceKind` | **TRUE** (`packLoose.ts` L99/L125) → a `'bmfont'` atlas is safe in the fix path with zero new branch |
| i18n drift guard (`render.test.ts` L95/L99-101) + 9-locale parity (`catalogs.test.ts` L20) | **TRUE** |
| **§4e: App.tsx has a `source.kind`→display-label map to extend** | **FALSE — DROPPED.** No code renders `atlas.source`. The cited grep hit (App.tsx:1385) is a *comment*. `engine` state (L2437) is the Pixi/Phaser **render-probe** selector, unrelated to `AtlasSourceKind`. The fix-op group label (L2410-2412, `fix.op.${g.kind}`) is a fix-operation kind, not an atlas source kind. **No UI label task exists.** |
| **§3a/§8.3: multi-page glyph attachment** | **WRONG AS WRITTEN — REVISED.** The draft contradicts itself ("most-recent page" vs "char.page id"). In real BMFont TEXT the section order is `info → common → page×N → chars → char×N → kerning×N`: every `char` line follows **all** `page` lines, so "most-recent page" would dump *all* glyphs onto the *last* page. **Correct rule: attach each `char` to the page whose `id === char.page`.** See §3a-revised. |
| `includeFileSizes` Pixi field | Correctly flagged as a **separate, deferred** work item (not conflated with `.fnt`). No fabrication. |

Net: 1 MAJOR fabricated task (DROPPED), 1 MAJOR correctness/determinism defect (FIXED). Everything else verified true. Scope is salvageable and shrinks by one task.

---

## 1. v1 scope

### In scope
1. `parseFntText(text): FntPage[]` — `packages/parsers/src/fnt.ts`. Pure, never throws, per-glyph recovery. **TEXT BMFont only.**
2. `parseFntPage(page, image, opts)` → `ParseResult` (mirror of `parseSpinePage`).
3. Export both + `FntPage` from `packages/parsers/src/index.ts`.
4. ingest `groupFiles`: recognize `.fnt`, parse, resolve each `page` to its image dir-aware (reuse `resolve`/`atlasName`/`keyOf`/`referenced`/`missing`/`unparsed`), route as `GroupedAtlas.kind: 'bmfont'`.
5. `AtlasSourceKind` += `'bmfont'`; `Rule` += `'font-glyph-page'`; one finding in `packages/analysis/src/font.ts`; threshold `fontGlyphPage`.
6. analyze worker: route `a.kind === 'bmfont'` → `parseFntPage` + per-glyph recovery + build `fontPages` dep.
7. i18n: `find.font-glyph-page.{title,detail,fix}` in all 9 catalogs + drift wiring.
8. Fixture `bmfont-sparse/` exercised through the REAL path (`groupFiles → parseFntPage → analyze`), asserting the finding FIRES.

### Out of scope (follow-ups, surfaced honestly)
- **XML `.fnt`** (leading `<`) and **binary `.fnt`** (`BMF\x03`) → `unparsed[]` honest error, never silent-dropped.
- Kerning geometry audit (only `kerningCount` reported).
- **Any fix-engine work** — verified safe: fix branches only on `opts.kind === 'spine'` (`packLoose.ts` L99) and *emits* `source.kind`, never reads an incoming `AtlasSourceKind`, so a `'bmfont'` atlas needs zero fix change.
- Font-metric correctness audits (baseline/lineHeight sanity).
- **~~App.tsx source-kind label~~** — DROPPED: no such label exists in the UI.

---

## 2. Additive contract (`packages/core/src/index.ts`)

**2a. L30:**
```ts
export type AtlasSourceKind = 'texturepacker-hash' | 'texturepacker-array' | 'pixi' | 'spine' | 'bmfont';
```
Ripple (verified): no exhaustive `switch (source.kind)` over `AtlasSourceKind` exists. The only consumer is `fix/src/packLoose.ts` which uses its OWN `opts.kind` and emits, never reads. Safe.

**2b. `Rule` union (L274, append after `cross-atlas-redundancy`):**
```ts
  | 'cross-atlas-redundancy'
  // per-bmfont-page glyph-sheet readout (informational; a parsed .fnt page IS an atlas)
  | 'font-glyph-page';
```

**2c. `ThresholdConfig` (after `crossAtlasRedundancy`, L601):**
```ts
  /** Bitmap-font glyph-page gate (browser + headless). A parsed BMFont `.fnt` page is structurally an
   *  atlas; this surfaces a font-specific readout (glyph-page occupancy + glyph count + kerning-present)
   *  ALONGSIDE the generic atlas findings the page already trips. `minChars` — a page must expose ≥ this
   *  many glyphs before the readout fires. `occupancyWarn` — glyph-page occupancy at/below which the
   *  readout is `warn`, else `info`. The estimate carries ONLY occupancyPct — the generic
   *  occupancy/oversize findings own the VRAM (w·h·4) on the SAME page; this rule never double-counts and
   *  fabricates NO disk/VRAM-saved (invariant 5). Optional/additive: absent ⇒ readout suppressed (CLI/
   *  budget configs that don't opt in; NOT enumerated by resolveThresholds, mirrors frameRedundancy). */
  fontGlyphPage?: { minChars: number; occupancyWarn: number };
```
`DEFAULT_THRESHOLDS` (`config.ts`): `fontGlyphPage: { minChars: 16, occupancyWarn: 0.5 },`

No change to `Sprite`/`Atlas`(struct)/`Finding`/`FindingEstimate`/`OverlayZone`. Font metrics live transiently on `FntPage` + surface via finding `params` only.

---

## 3. Pure modules

### 3a. `packages/parsers/src/fnt.ts` (REVISED — multi-page by `char.page`)

```ts
import type { Atlas, ImageAsset, Rect, Size, Sprite } from '@asset-doctor/core';
import type { ParseResult } from './types';
import { readImageInfo } from './image-size';

export interface FntPage {
  image: string;           // page `file` (quotes stripped)
  size?: Size;             // common scaleW/scaleH (>0 both, else undefined)
  sprites: Sprite[];       // one per `char` whose page= id maps HERE; frame from x,y,width,height
  face?: string;           // info face= (quotes stripped) — surfaced in finding params
  lineHeight?: number;     // common lineHeight — font metric, surfaced in params
  kerningCount: number;    // # kerning lines (kerningPresent flag); kerning has no page id, counted GLOBALLY (see note)
  malformedGlyphs?: { id: string; reason: string }[]; // per-glyph recovery, mirrors SpinePage.malformedRegions
}

/** Parse BMFont TEXT format. Pure & defensive: never throws. `common pages=N` + N `page` lines →
 *  FntPage[] (one per page id). Each `char` is attached to the page whose `id === char.page` (NOT the
 *  "most-recent" page — in BMFont TEXT every char line follows ALL page lines). XML/binary .fnt are NOT
 *  this format (caller detects + returns an honest unparsed error); returns [] for input with no
 *  page/char lines. */
export function parseFntText(text: string): FntPage[];

export function parseFntPage(
  page: FntPage,
  image: { ref: string; bytes: Uint8Array },
  opts?: { name?: string },
): ParseResult;
```

**Grammar (real BMFont TEXT — tag + space-delimited `key=value`; values quoted or comma-lists):**
```
info face="Arial" size=32 ... padding=2,2,2,2
common lineHeight=38 base=30 scaleW=256 scaleH=256 pages=1
page id=0 file="arial_0.png"
chars count=95
char id=65 x=2 y=2 width=28 height=30 xoffset=0 yoffset=4 xadvance=30 page=0 chnl=15
kerning first=65 second=86 amount=-2
```

**Parse rules (load-bearing):**
- **Two-pass over lines** (so glyph→page attachment is independent of line order, and deterministic): pass 1 collects `info`/`common`/`page` headers and builds `FntPage[]` indexed by page `id`; pass 2 walks `char`/`kerning` lines and routes each by its `page=` id. (A one-pass variant is acceptable ONLY if it buffers chars until all `page` lines are seen; two-pass is simpler and unambiguously correct.)
- Tokenize: first whitespace-delimited token = tag; rest = `key=value`. Strip surrounding `"` from a value; a value opening with `"` consumes through its closing `"` so `face="My Font"` keeps the space. Numerics via `parseInt(v,10)` (NaN-preserving, matching spine's `numsRaw` discipline — blank/garbage → NaN → glyph flagged malformed, never coerced to 0).
- `info`: `face` → `page.face` (applied to ALL pages, or stored once and copied — face is font-global). `common`: `lineHeight`, `scaleW`, `scaleH`; `size = {w:scaleW,h:scaleH}` only when both finite & `>0` (mirrors `applyPageKey` L56). `common` is one block shared by all pages, so every page gets the same `size`/`lineHeight`.
- `page id=N file="..."`: create/open `FntPage` at index `N`. Pages stored in a `Map<number, FntPage>`; result array is the pages **sorted by id ascending** (deterministic).
- `char ... page=P`: build a `Sprite`, attach to page id `P`. If no page with id `P` exists → `malformedGlyphs.push({ id, reason: 'glyph id=<id>: references missing page <P>' })` (attached to the lexicographically-first page so it still surfaces, or to a side list flushed onto page 0 — **decision: attach the malformed entry to page id `P`'s slot if any page exists; if NONE exists, the whole file has no usable page → handled by the empty-result path**). Simplest deterministic rule: if pages is non-empty and `P` is missing, record on the first page (id-sorted). Single-page files (the overwhelming norm, `pages=1`) make this moot — every char has `page=0`.
- `char` Sprite build:
  - `frame = { x, y, w: width, h: height }`; `rotated: false` always (BMFont has no glyph rotation).
  - Required = `x,y,width,height`. Any non-finite → `malformedGlyphs` (`'glyph id=<id>: non-finite <field>'`), glyph dropped (NOT placed at 0 — spine discipline, `spine-atlas.ts` L70-81).
  - `width<=0||height<=0||x<0||y<0` → malformed (degenerate-rect rule, atlas.ts L36). **EXCEPTION: a whitespace glyph (`width===0 && height===0`, e.g. id=32 space) is silently skipped from `sprites` — zero-area, not a packed region, NOT an error** (documented).
  - `sourceSize = { w: width, h: height }`, `trimmed: false`. We do NOT fabricate a full-cell `sourceSize` from `xadvance`/`lineHeight` (that invents geometry the page doesn't carry; `xadvance` is horizontal advance, not height). `xoffset`/`yoffset` are layout-placement offsets, NOT in-page trim offsets → not mapped to `spriteSourceSize`. This keeps occupancy = Σ(frame area)/page area = the real packed glyph coverage (honest).
  - `name = glyph_<id>` (deterministic).
- `kerning`: increment `kerningCount`. **Note (revised):** `kerning` lines carry `first`/`second`/`amount` — NO `page` id. They are font-global, not per-page. **Decision: count kerning GLOBALLY and attach the total to EVERY page's `kerningCount`** (a kerning pair belongs to the font, not a specific glyph page). Documented so the finding's kerning readout is the font's total on whichever page surfaces. (Single-page fonts make this moot.)
- OOB check on flush when `page.size` known: `frame.x+frame.w > size.w || frame.y+frame.h > size.h` → `malformedGlyphs` (`'glyph id=<id> extends past page WxH'`), mirrors `spine-atlas.ts` L120-127.
- Unknown tags ignored (forward-compat).

`parseFntPage` (mirror of `parseSpinePage` L169-191):
```ts
const info = readImageInfo(image.bytes);
if (!info) return { ok: false, error: `bmfont page image unrecognized: ${image.ref}` };
const atlas: Atlas = {
  name: opts?.name ?? image.ref,
  imageRef: image.ref,
  size: page.size ?? info.size,
  sprites: page.sprites,
  source: { kind: 'bmfont' },
};
const imageAsset: ImageAsset = {
  name: atlas.name, imageRef: image.ref, size: info.size, mime: info.mime, byteSize: image.bytes.byteLength,
};
return { ok: true, asset: { kind: 'atlas', atlas, image: imageAsset } };
```
`malformedGlyphs`/`face`/`kerningCount` are NOT forwarded through `ParseResult` (its shape is `{ok;asset}|{ok;error}` — verified `types.ts` L4, no extra slot). The worker reads them off `a.manifest as FntPage`, mirroring exactly how it reads `(a.manifest as SpinePage).malformedRegions` (worker L83). This is the verified, consistent pattern.

### 3b. `packages/analysis/src/font.ts` (new)

```ts
import type { Atlas, Finding, ThresholdConfig } from '@asset-doctor/core';
import { occupancyValue, vramBytes } from './rules';

/** Bitmap-font glyph-page readout. Fires ONLY for source.kind === 'bmfont' (positive guard). Pure
 *  measurement: glyph-page occupancy, glyph count, font metrics (faceName/kerningCount passed by host).
 *  estimate carries ONLY occupancyPct — the generic occupancy/oversize findings own the VRAM on this
 *  page (invariant 5; no double-count, no fabricated saving). null with no config / below minChars /
 *  non-bmfont. */
export function fontGlyphPageFinding(
  atlas: Atlas,
  cfg: ThresholdConfig,
  font: { faceName?: string; kerningCount: number },
): Finding | null {
  if (!cfg.fontGlyphPage || atlas.source.kind !== 'bmfont') return null;
  const glyphs = atlas.sprites.length;
  if (glyphs < cfg.fontGlyphPage.minChars) return null;
  const occ = occupancyValue(atlas);
  const severity = occ <= cfg.fontGlyphPage.occupancyWarn ? 'warn' : 'info';
  const params = {
    face: font.faceName ?? '', glyphs, occ, kerning: font.kerningCount,
    w: atlas.size.w, h: atlas.size.h, vram: vramBytes(atlas.size),
  };
  return {
    id: `${atlas.name}:font-glyph-page`, rule: 'font-glyph-page', severity, scope: 'asset',
    assetRef: atlas.name,
    title: /* baked EN, MUST equal en.json — see §7 */,
    detail: /* baked EN, kerning-present clause is a ternary matching the PluralForm */,
    fix: /* baked EN */,
    messageKey: 'font-glyph-page', params, estimate: { occupancyPct: occ },
  };
}
```
Export from `packages/analysis/src/index.ts`.

---

## 4. Worker / analyze / surfaces

### 4a. ingest `packages/ingest/src/index.ts`
- `GroupedAtlas.kind` union (L19): `'manifest' | 'spine' | 'bmfont'`.
- Import `parseFntText, type FntPage`.
- Update the L18 doc comment + the `Grouped.unparsed` comment (L30-34) to include the `.fnt` case (it currently enumerates "the 3 'looks like a manifest but unusable' cases"; add the `.fnt` case so the honesty contract stays documented).
- New branch after the `.atlas` block (L117), before the `.json` block:
```ts
if (/\.fnt$/i.test(f.name)) {
  const text = new TextDecoder().decode(f.bytes);
  const head = text.slice(0, 64).trimStart();
  if (head.startsWith('<') || /^BMF\x03/.test(text)) {
    unparsed.push({ ref: baseName(f.name), reason: 'BMFont .fnt not in TEXT format (XML/binary unsupported in v1)' });
    continue;
  }
  let pages: FntPage[];
  try { pages = parseFntText(text); }
  catch (e) { unparsed.push({ ref: baseName(f.name), reason: `BMFont .fnt parse failed: ${msg(e)}` }); continue; }
  if (pages.length === 0) { unparsed.push({ ref: baseName(f.name), reason: 'BMFont .fnt has no page/char lines' }); continue; }
  for (const page of pages) {
    const image = resolve(f.path, page.image);
    if (!image) { missing.push({ manifest: baseName(f.name), image: baseName(page.image) }); continue; }
    referenced.add(keyOf(image));
    atlases.push({ kind: 'bmfont', manifest: page, image, name: atlasName(image) });
  }
  continue;
}
```
`unparsed.sort` at L144 already covers the new pushes.

### 4b. analyze worker `apps/web/src/worker/analyze.worker.ts`
- Import `parseFntPage, type FntPage` (L7).
- Parse dispatch (L64-67):
```ts
const res: ParseResult & { malformedFrames?: MalformedFrame[] } =
  a.kind === 'spine'  ? parseSpinePage(a.manifest as SpinePage, image, { name: a.name })
: a.kind === 'bmfont' ? parseFntPage(a.manifest as FntPage, image, { name: a.name })
                      : parseAtlas(a.manifest, image, { name: a.name });
```
- Per-glyph recovery (after the spine `malformedRegions` block L82-86, symmetric):
```ts
if (a.kind === 'bmfont') {
  for (const mg of (a.manifest as FntPage).malformedGlyphs ?? []) {
    unparsed.push({ ref: `${a.name}#${mg.id}`, reason: mg.reason });
  }
}
```
- `fontPages` dep. Add to `AnalyzeDeps`:
```ts
  /** Per-bmfont-page font metadata (face + kerning count) read off the parsed FntPage, keyed by
   *  atlas.name. Drives the font-glyph-page readout. Absent ⇒ never fires (additive, gated like
   *  frameHashes). */
  fontPages?: { atlasRef: string; faceName?: string; kerningCount: number }[];
```
Build it in the **same atlas loop** (the parse loop L57-87, where `a.manifest as FntPage` is in scope — NOT the later `merged` frame-hash loop). bmfont atlases are never shared-page-merged, so `a.name` here === the `merged` atlas name analyze sees (verified: `mergeSharedAtlases` unions by name; a single-image bmfont page keeps its name). Pass `...(fontPages.length ? { fontPages } : {})` into the existing `analyze(merged, undefined, {...})` call (L167-175).

### 4c. `packages/analysis/src/analyze.ts`
- Import `fontGlyphPageFinding` from `./font`; add `fontPages` to deps destructure; build `const fontByRef = new Map(...)` from `deps.fontPages ?? []` (mirrors `frameHashByRef` L121).
- In the atlas branch, after the trim-margin block (after L194, still inside `if (asset.kind === 'atlas')`):
```ts
if (atlas.source.kind === 'bmfont') {
  const fp = fontByRef.get(atlas.name) ?? { kerningCount: 0 };
  const gp = fontGlyphPageFinding(atlas, cfg, fp);
  if (gp) findings.push(gp);
}
```
- Export `fontGlyphPageFinding` from `packages/analysis/src/index.ts`.

### 4d. CLI / budget
No change. `resolveThresholds` does not enumerate `fontGlyphPage` (mirrors `frameRedundancy`/`solidFill`/`wastedAlpha` — verified by their identical "NOT enumerated by resolveThresholds" doc-contract) ⇒ CLI never opts in ⇒ font readout stays browser/headless-test-only. `.fnt` files the CLI ingests still group as bmfont atlases + trip GENERIC occupancy/oversize (desirable, additive). Regression: an existing no-`.fnt` CLI fixture is byte-identical.

### 4e. UI / FilmViewer
**No change.** The bmfont atlas IS an `Atlas` (imageRef/sprites) → renders in the FilmViewer like any atlas; generic occupancy/wasted-regions overlays work unchanged. **There is NO `source.kind` display-label in the UI** (verified: `atlas.source` is never rendered; the App.tsx `engine` state is the Pixi/Phaser render-probe selector). The fabricated "App.tsx label entry" task is DROPPED.

### 4f. Backend
None. Pure in-browser `TextDecoder` + header-only `readImageInfo`. Invariants 1-2 hold.

---

## 5. Honesty + invariants
- **Inv 1**: pure `TextDecoder` + header-only image read, no network. ✓
- **Inv 2**: zero backend change. ✓
- **Inv 3**: MEASURE only (occupancy, glyph/kerning counts). No font generated; fix path untouched (verified `'bmfont'` falls into the non-spine branch which does nothing font-specific). ✓
- **Inv 4**: parse is O(lines), header-only read. The glyph page runs the SAME already-bounded frame-hash/trim decode pass as any atlas (`pageExceedsScanBudget` + `FRAME_HASH_MAX_SPRITES`; a ~95-glyph page is far under the sprite cap) — no NEW decode. ✓
- **Inv 5**: font finding `estimate` carries ONLY `occupancyPct`; VRAM on the page is attributed by the existing occupancy/oversize findings (w·h·4). No `vramBytesSaved`/`diskBytesSaved` fabricated; `potentialDiskSaved` untouched. ✓
- **Honest unsupported-format surface**: XML/binary/empty `.fnt` → `unparsed[]` (never silent); per-glyph recovery uses the `<page>#<id>` ref convention identical to spine/TP recovery.

---

## 6. Determinism
- `parseFntText` is a pure function of input bytes: two-pass over lines, pages emitted **id-sorted**, glyphs pushed in `char`-line source order, `glyph_<id>` derived from the `id` field. No `Date.now`/`Math.random`/iteration-order dependence.
- **Multi-page attachment is `char.page`-id-driven (FIXED)** — not "most-recent page," which was order-fragile and wrong for the real format.
- `malformedGlyphs` in source order; kerning counted globally (deterministic total).
- ingest keying reuses `keyOf`/`atlasName` (the one dir-aware normalizer).
- `fontGlyphPageFinding` pure over `(atlas,cfg,font)`; `occupancyValue` deterministic; `id`/`params` fully input-determined.
- `fontPages` keyed by `atlas.name`, read via map lookup (order-independent).

---

## 7. i18n
Add `find.font-glyph-page.{title,detail,fix}` to **all 9** catalogs. EN MUST be byte-identical to the baked strings in `fontGlyphPageFinding` (`render.test.ts` L99-101).
- `title`: `PluralForm` on `$count:'glyphs'` (mirror `find.frame-redundancy.title` shape — verified en.json L105-109), carrying `{glyphs}` + `{occ:pct}`.
- `detail`: `PluralForm` on `$count:'kerning'` (zero ⇒ "no kerning pairs"; one/other ⇒ "{kerning} kerning pair(s)"), carrying `{face}`,`{glyphs}`,`{w}`,`{h}`,`{occ:pct}`,`{vram:bytes}`,`{kerning}`. EN `zero`/`one`/`other` forms MUST equal the baked ternary in the rule. (Note: EN PluralRules has no `zero` category — express "no kerning" via `=0`-style handling only if the catalog's plural machinery supports it; otherwise bake the zero case into the `other` form's wording driven by `kerning===0`. Verify against `Intl.PluralRules` usage in `i18n/src/index.ts` during impl — EN `cardinal` yields only `one`/`other`, so a true `zero` form will NOT be selected for EN; fold the no-kerning wording into a `kerning`-conditional inside `other`, or use a separate non-plural sentence. The drift test compares EN render to baked, so whatever the rule bakes must match the catalog's EN-selected form.)
- `fix`: plain string.

Drift wiring (`render.test.ts`):
- Import `fontGlyphPageFinding`.
- In `realFindings()` build a bmfont `Atlas` (`source:{kind:'bmfont'}`, ≥16 sprites to clear `minChars`, occupancy ≤0.5 ⇒ `warn`) and push `fontGlyphPageFinding(fontAtlas, cfg, { faceName:'Arial', kerningCount:12 })!`.
- Add `'font-glyph-page'` to the `keys` Set assertion (L95).
- `catalogs.test.ts` L20 then requires all 9 locales carry the new keys (intended guard).

---

## 8. Edge cases
1. Whitespace glyph (`width=0 height=0`) → skipped from `sprites`, NOT malformed. ✓
2. `chars count=N` mismatch → ignored; `glyphs` = actual usable `sprites.length` (no false "missing glyphs" claim). ✓
3. **Multi-page (`pages=2`)** → each page id its own `Atlas`; each `char` routed by `page=` id (id-sorted output). `char` with a `page=` id that has no page line → `malformedGlyphs`. ✓ (FIXED rule)
4. Missing page image → `missing[]` (integrity finding fires) — symmetric with `.atlas`. ✓
5. XML `.fnt` (leading `<`) → `unparsed[]`. ✓
6. Binary `.fnt` (`BMF\x03`) → `unparsed[]`. ✓
7. Empty / non-BMFont `.fnt` (no page/char lines) → `unparsed[]`. ✓
8. Glyph rect past page edge → OOB recovery; page keeps good glyphs. ✓
9. `face="My Font"` with spaces → quote-aware value read preserves spaces. ✓
10. No `common scaleW/scaleH` → `parseFntPage` falls back to `info.size` from the image header. ✓
11. Quoted `file="fonts/arial_0.png"` → `resolve()` handles dir-relative via `normalizePath(dirOf/imageName)`. ✓
12. `.fnt` page also referenced by a TP/Spine manifest → `referenced` set dedups. ✓
13. `fontGlyphPage` config absent (CLI) → readout suppressed; page still trips generic findings; byte-identical to the page being a plain atlas. ✓

---

## 9. Test plan (real harness; fixture reproduces the defect; CONFIRM the finding FIRES)

### 9a. Unit — extend `packages/parsers/test/parsers.test.ts` (mirror the spine `describe` at L122)
- `describe('parseFntText — BMFont TEXT')`:
  - `info`/`common`/`page`/`char`/`kerning`: page count 1, `face`, `size` from scaleW/scaleH, `sprites.length` = usable glyphs, a known glyph's `frame`/`trimmed:false`/`rotated:false`, `kerningCount`.
  - Whitespace glyph (`width=0 height=0`) excluded from `sprites`, NOT in `malformedGlyphs`.
  - Non-finite required field → glyph dropped + exact `malformedGlyphs` reason string.
  - OOB glyph past scaleW/scaleH → dropped + surfaced; page keeps good glyphs.
  - **Multi-page (`pages=2`, two `page` lines, chars with `page=0` and `page=1` interleaved AFTER both page lines) → 2 `FntPage`s, each carrying ONLY its own-id glyphs** (this asserts the FIXED `char.page` routing, not "most-recent page").
  - `parseFntPage`: builds `Atlas` with `source.kind==='bmfont'`, `size`, `imageRef`, sprites; bad image bytes → `{ok:false}`.

### 9b. ingest — new `packages/ingest/test/group-fnt.test.ts` (real `groupFiles`)
- `.fnt` + PNG (as `RawFile`s w/ `path`) → one `{kind:'bmfont', name:<dir-aware>, image}`; PNG NOT in `grouped.images` (it's `referenced`).
- Dir-aware: `.fnt` in `fonts/` referencing `file="arial_0.png"` → `fonts/arial_0.png`.
- Missing page image → `grouped.missing`.
- XML `.fnt` → `grouped.unparsed` with the unsupported-format reason.
- No `.fnt` in the set → `grouped` byte-identical (regression).

### 9c. Fixture through the REAL path — `bmfont-sparse/` + new `describe` in `packages/analysis/test/analysis.test.ts`
```ts
const grouped = groupFiles([fntFile, pngFile]);
expect(grouped.atlases).toHaveLength(1);
const a = grouped.atlases[0]!;                       // kind 'bmfont'
const fp = a.manifest as FntPage;
const res = parseFntPage(fp, { ref: a.name, bytes }, { name: a.name });
const report = await analyze([res.asset], DEFAULT_THRESHOLDS, {
  fontPages: [{ atlasRef: a.name, faceName: fp.face, kerningCount: fp.kerningCount }],
});
const f = report.findings.find((x) => x.rule === 'font-glyph-page');
expect(f).toBeTruthy();
expect(f!.severity).toBe('warn');                    // sparse page = the documented defect
expect(f!.params!.glyphs).toBe(<documented count>);
expect(f!.params!.kerning).toBe(<documented count>);
```
Plus: assert the GENERIC `occupancy` finding ALSO fires on the same sparse page (proves "atlas rules run for free"); and with `fontGlyphPage` OMITTED from cfg the font finding does NOT fire (gate proof + byte-identity).

### 9d. i18n drift — `render.test.ts` (§7): `'font-glyph-page'` in the Set; EN render === baked; RU non-empty + brace-free. `catalogs.test.ts` enforces 9-locale parity.

### 9e. Worker — no new worker test (exercised in-app); the `analyze.worker.ts` branch is type-checked by `pnpm typecheck`; the parse+recovery+`fontPages` wiring is validated by 9c's real-path harness (groupFiles → parseFntPage → analyze with fontPages), which mirrors exactly what the worker does.

### 9f. Full suite: `pnpm test && pnpm typecheck && pnpm lint`. Confirm the 88-test CLI suite + every existing golden are unchanged (additive; absent `.fnt` ⇒ byte-identical).

---

## 10. Make-fixture `fixtures/sample-projects/bmfont-sparse/`
- **`font.png`** — small POT page (256×256), opaque colored rects at exact glyph positions so occupancy is hand-computable and LOW (the documented defect: a sparse glyph sheet pinning VRAM for mostly-empty space).
- **`font.fnt`** — BMFont TEXT: `info face="TestFont"`, `common lineHeight= base= scaleW=256 scaleH=256 pages=1`, `page id=0 file="font.png"`, ≥16 `char` lines (clears `minChars`) matching the PNG rects, a few `kerning` lines (`kerningCount>0`), one whitespace glyph (`id=32 width=0 height=0`), and one deliberately OOB or non-finite glyph (kept OUT of the analysis golden count, IN the recovery test).
- **`expected.json`** — golden: `kind:'bmfont'`, atlas `w/h`, usable `glyphCount`, `kerningCount`, computed `occupancy`, `face`, `findings:['font-glyph-page'(warn),'occupancy'(...)]`. Mirror `spine-basic/expected.json`.
- **`README.md`** — one paragraph documenting the single-page TEXT BMFont, the sparse-page defect, the end-to-end path exercised, the per-glyph recovery glyph, and the XML/binary follow-up.

---

## 11. Ordered task breakdown (small commits — App.tsx label task DROPPED)

1. **`feat(core): 'bmfont' AtlasSourceKind + 'font-glyph-page' Rule + fontGlyphPage threshold`** — `core/src/index.ts` (§2) + `DEFAULT_THRESHOLDS` in `analysis/src/config.ts`. No logic. `pnpm typecheck` green.
2. **`feat(parsers): parseFntText + parseFntPage (BMFont TEXT, char.page-keyed multi-page)`** — new `parsers/src/fnt.ts` + exports in `parsers/src/index.ts`. Pure, never throws, per-glyph recovery (§3a).
3. **`test(parsers): BMFont TEXT parse + per-glyph recovery + multi-page by char.page`** — extend `parsers.test.ts` (§9a).
4. **`feat(ingest): group .fnt pages like .atlas (bmfont kind, honest unsupported-format surface)`** — `ingest/src/index.ts` (§4a), incl. updated unparsed-contract doc comment.
5. **`test(ingest): group-fnt — dir-aware resolve, missing, XML-unparsed, byte-identity`** — new `group-fnt.test.ts` (§9b).
6. **`feat(analysis): font-glyph-page readout + analyze wiring + fontPages dep`** — new `analysis/src/font.ts`, `analyze.ts` branch + `AnalyzeDeps.fontPages` + `fontByRef`, export from `index.ts` (§3b/§4c).
7. **`feat(fixtures): bmfont-sparse (.fnt + PNG + golden + README)`** — make-fixture (§10).
8. **`test(analysis): bmfont-sparse through the REAL path — font + occupancy FIRE; gate-off byte-identity`** — `analysis.test.ts` (§9c).
9. **`feat(web): route bmfont in analyze.worker + glyph recovery + fontPages`** — `apps/web/src/worker/analyze.worker.ts` (§4b). **(No App.tsx change — there is no source-kind UI label.)**
10. **`feat(i18n): find.font-glyph-page in all 9 catalogs + render drift wiring`** — `i18n/src/catalogs/*.json` (×9) + `render.test.ts` (§7/§9d). `catalogs.test.ts` parity green.
11. **`docs: CHANGELOG + FEATURES — bitmap-font (.fnt) parser/ingest/audit (TEXT; XML/binary follow-up)`** — per the round-log convention.

Each commit independently green for `pnpm typecheck`; commits 3/5/8/10 add the tests that make their predecessor observable. Final gate: `pnpm test && pnpm typecheck && pnpm lint`.

### Key file references (absolute)
- Mirror: `/home/nonamezzz/Рабочий стол/projects/packages/parsers/src/spine-atlas.ts` (L70-81 required-field, L105 text parser, L120-127 OOB, L169-191 page-build)
- ingest: `/home/nonamezzz/Рабочий стол/projects/packages/ingest/src/index.ts` (L17-23 union, L97-117 .atlas branch, L144 sort)
- core: `/home/nonamezzz/Рабочий стол/projects/packages/core/src/index.ts` (L30, L274, L318, L601)
- analyze atlas branch: `/home/nonamezzz/Рабочий стол/projects/packages/analysis/src/analyze.ts` (L121 byRef pattern, L153-200 atlas branch, L167-175 analyze call)
- rule helpers: `/home/nonamezzz/Рабочий стол/projects/packages/analysis/src/rules.ts` (L11 vramBytes, L26 fmtBytes, L32 occupancyValue)
- worker dispatch: `/home/nonamezzz/Рабочий стол/projects/apps/web/src/worker/analyze.worker.ts` (L64-67 dispatch, L82-86 spine recovery, L167-175 deps)
- i18n drift: `/home/nonamezzz/Рабочий стол/projects/packages/i18n/test/render.test.ts` (L95, L99-101) + `catalogs.test.ts` (L20) + en.json (L105-109 PluralForm shape) + `i18n/src/index.ts` (renderFinding L132-145)
- fixture template: `/home/nonamezzz/Рабочий стол/projects/fixtures/sample-projects/spine-basic/`