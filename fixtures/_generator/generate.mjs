// Deterministic synthetic problem-atlases for Asset Doctor regression tests.
// Run from the repo root:  node fixtures/_generator/generate.mjs
//
// Per case it emits: <atlas>.png, the manifest JSON (TP Hash/Array or Pixi),
// expected.json, and README.md. Ground truth in expected.json is authored HERE,
// independently of @asset-doctor/analysis — so the goldens are a real cross-check.
//
// Geometry uses round numbers so occupancy/areas stay hand-verifiable. No randomness.

import { PNG } from 'pngjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Re-derive a buildDedupGroups-style ref (dir-aware, forward slashes) the way ingest's keyOf would
// for a folder upload. Used only to author the dedup golden's refs by hand, NOT to compute outcomes.

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'sample-projects');

const COLORS = [
  [38, 139, 210],
  [203, 75, 22],
  [133, 153, 0],
  [211, 54, 130],
  [181, 137, 0],
  [42, 161, 152],
  [220, 50, 47],
  [108, 113, 196],
];

function fillRect(png, x, y, w, h, [r, g, b]) {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const i = (png.width * yy + xx) << 2;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
  }
}

/** Paint a coarse 2-color checker into [x,y,w,h]. TEXTURED (not a single fill), so its box-averaged 9×8
 *  grayStdDev clears the dHash flat-guard (≥ 6) — the frame-redundancy detector hashes the region instead
 *  of nulling it as featureless. `sq` is the checker square size in px; same (x,y,w,h,a,b,sq) ⇒ byte-for-byte
 *  identical region (so duplicate frames cluster by SHA through the REAL decode path, not just injected hashes). */
function fillChecker(png, x, y, w, h, a, b, sq = 8) {
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      const cx = Math.floor(xx / sq);
      const cy = Math.floor(yy / sq);
      const [r, g, bl] = (cx + cy) & 1 ? a : b;
      const i = (png.width * (y + yy) + (x + xx)) << 2;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = bl;
      png.data[i + 3] = 255;
    }
  }
}

function atlasPng(size, frames) {
  const png = new PNG({ width: size.w, height: size.h });
  png.data.fill(0); // transparent background
  frames.forEach((f, i) =>
    fillRect(png, f.frame.x, f.frame.y, f.frame.w, f.frame.h, COLORS[i % COLORS.length]),
  );
  return PNG.sync.write(png);
}

function solidPng(w, h, color) {
  const png = new PNG({ width: w, height: h });
  fillRect(png, 0, 0, w, h, color);
  return PNG.sync.write(png);
}

/** A loose source image of full size w×h with a fully-TRANSPARENT margin: only the inner
 *  bbox [mx, my, bw, bh] is opaque (alpha 255). This is the input shape Feature 4's worker
 *  measures via alphaBBox → trim. The opaque bbox is the TOP-LEFT trim rect; for spine the
 *  emitter writes the BOTTOM-LEFT offset = h - (my + bh) (the only Y-flip, in trim.ts). */
function marginPng(w, h, mx, my, bw, bh, color) {
  const png = new PNG({ width: w, height: h });
  png.data.fill(0); // transparent background = the margin
  fillRect(png, mx, my, bw, bh, color);
  return PNG.sync.write(png);
}

/** A fully-transparent image (no opaque pixel) — alphaBBox returns null. Static packs a 1×1
 *  sentinel; spine skips + surfaces (an all-transparent attachment is a decoy). */
function transparentPng(w, h) {
  const png = new PNG({ width: w, height: h });
  png.data.fill(0);
  return PNG.sync.write(png);
}

/** Paint an OPAQUE silhouette into a frame's bbox: for each local pixel (lx,ly) in [0,w)×[0,h),
 *  call `inside(lx, ly, w, h)` — truthy ⇒ opaque (color), falsy ⇒ left transparent (alpha 0).
 *  This is how Case 8 draws concave shapes whose opaque area is far smaller than the bbox. */
function fillShape(png, x, y, w, h, [r, g, b], inside) {
  for (let ly = 0; ly < h; ly++) {
    for (let lx = 0; lx < w; lx++) {
      if (!inside(lx, ly, w, h)) continue;
      const i = (png.width * (y + ly) + (x + lx)) << 2;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
  }
}

/** Like atlasPng, but each frame may carry a `shape(lx,ly,w,h)` predicate (a concave silhouette);
 *  frames without one fall back to a solid bbox fill. Background stays transparent. */
function shapeAtlasPng(size, frames) {
  const png = new PNG({ width: size.w, height: size.h });
  png.data.fill(0); // transparent background
  frames.forEach((f, i) => {
    const color = COLORS[i % COLORS.length];
    if (f.shape) fillShape(png, f.frame.x, f.frame.y, f.frame.w, f.frame.h, color, f.shape);
    else fillRect(png, f.frame.x, f.frame.y, f.frame.w, f.frame.h, color);
  });
  return PNG.sync.write(png);
}

const round4 = (n) => Math.round(n * 10000) / 10000;
const occupancyOf = (size, frames) =>
  round4(frames.reduce((s, f) => s + f.frame.w * f.frame.h, 0) / (size.w * size.h));

/** Authoring helper for a frame (packed rect as placed in the atlas image). */
const fr = (name, x, y, w, h, extra = {}) => ({
  name,
  frame: { x, y, w, h },
  rotated: false,
  trimmed: false,
  sourceSize: { w, h },
  ...extra,
});

function tpFrameBody(f) {
  return {
    frame: f.frame,
    rotated: f.rotated,
    trimmed: f.trimmed,
    spriteSourceSize: f.spriteSourceSize ?? { x: 0, y: 0, w: f.frame.w, h: f.frame.h },
    sourceSize: f.sourceSize,
  };
}

const TP_META = { app: 'https://www.codeandweb.com/texturepacker', version: '3.0' };

function hashManifest(image, size, frames, { pixi = false } = {}) {
  const frameObj = {};
  for (const f of frames) frameObj[f.name] = tpFrameBody(f);
  const meta = { image, format: 'RGBA8888', size, scale: '1', ...(pixi ? {} : TP_META) };
  return { frames: frameObj, meta };
}

function arrayManifest(image, size, frames) {
  return {
    frames: frames.map((f) => ({ filename: f.name, ...tpFrameBody(f) })),
    meta: { ...TP_META, image, format: 'RGBA8888', size, scale: '1' },
  };
}

/** Encode an AngelCode BMFont BINARY (BMF v3) font from font/glyph/kerning data — the SAME layout
 *  parseFntBinary walks. Header `BMF`+3, then blocks (1B type + 4B LE size): 1 info (fontName NUL-terminated
 *  at body+14), 2 common (lineHeight u16@0, base u16@2, scaleW u16@4, scaleH u16@6, … 15B), 3 pages
 *  (uniform-stride NUL-terminated names), 4 chars (20B: id u32@0, x/y/width/height u16@4-10, page u8@18),
 *  5 kerning (10B each — only the count matters here). Deterministic; returns a Buffer. */
function encodeBmfBinary({ face, lineHeight, base, scaleW, scaleH, pages, chars, kerningCount }) {
  const block = (type, body) => {
    const head = Buffer.alloc(5);
    head[0] = type;
    head.writeUInt32LE(body.length, 1);
    return Buffer.concat([head, body]);
  };

  // info (type 1): 14 fixed bytes (we only populate what parseFntBinary reads — fontName@14), then face+NUL.
  const faceBytes = Buffer.from(face, 'utf-8');
  const infoBody = Buffer.concat([Buffer.alloc(14), faceBytes, Buffer.from([0])]);

  // common (type 2): the 15-byte block; only lineHeight/scaleW/scaleH are read back.
  const commonBody = Buffer.alloc(15);
  commonBody.writeUInt16LE(lineHeight, 0);
  commonBody.writeUInt16LE(base, 2);
  commonBody.writeUInt16LE(scaleW, 4);
  commonBody.writeUInt16LE(scaleH, 6);
  commonBody[8] = 0; // pages hi
  commonBody[9] = pages.length & 0xff; // pages lo (informational; parser derives count from stride)

  // pages (type 3): uniform-stride NUL-terminated names. Stride = longest name + 1 (the NUL).
  const maxLen = pages.reduce((m, n) => Math.max(m, Buffer.byteLength(n, 'utf-8')), 0);
  const stride = maxLen + 1;
  const pagesBody = Buffer.alloc(stride * pages.length, 0);
  pages.forEach((name, i) => Buffer.from(name, 'utf-8').copy(pagesBody, i * stride));

  // chars (type 4): 20-byte records.
  const charsBody = Buffer.alloc(20 * chars.length, 0);
  chars.forEach((c, i) => {
    const o = i * 20;
    charsBody.writeUInt32LE(c.id, o);
    charsBody.writeUInt16LE(c.x, o + 4);
    charsBody.writeUInt16LE(c.y, o + 6);
    charsBody.writeUInt16LE(c.w, o + 8);
    charsBody.writeUInt16LE(c.h, o + 10);
    charsBody[o + 18] = c.page & 0xff;
  });

  // kerning (type 5): 10-byte records (content is irrelevant — parser counts size/10).
  const kerningBody = Buffer.alloc(10 * kerningCount, 0);

  return Buffer.concat([
    Buffer.from([0x42, 0x4d, 0x46, 0x03]), // 'BMF' + version 3
    block(1, infoBody),
    block(2, commonBody),
    block(3, pagesBody),
    block(4, charsBody),
    block(5, kerningBody),
  ]);
}

function writeCase(name, files, readme) {
  const dir = join(OUT, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    const p = join(dir, file);
    mkdirSync(dirname(p), { recursive: true }); // nested fixture dirs (e.g. main_game/ui/icon.png)
    const out =
      Buffer.isBuffer(content) || typeof content === 'string'
        ? content
        : JSON.stringify(content, null, 2) + '\n';
    writeFileSync(p, out);
  }
  writeFileSync(join(dir, 'README.md'), readme.trimStart());
  const occ = files['expected.json']?.occupancy;
  console.log(`  ✓ ${name}${occ != null ? ` (occupancy ${occ})` : ''}`);
}

console.log('Generating fixtures →', OUT);

/* ── Case 1: TexturePacker Hash, very low occupancy (crit) ─────────────────
 * Sparse symbol sheet on a POT atlas. Includes one trimmed and one rotated
 * sprite to exercise parser fidelity. Headline finding = occupancy crit. */
{
  const size = { w: 512, h: 512 };
  const frames = [
    fr('sym_a.png', 0, 0, 100, 100),
    fr('sym_b.png', 110, 0, 100, 100),
    fr('sym_c.png', 0, 110, 80, 120, {
      trimmed: true,
      spriteSourceSize: { x: 10, y: 10, w: 80, h: 120 },
      sourceSize: { w: 100, h: 140 },
    }),
    fr('sym_d.png', 220, 0, 60, 90, { rotated: true, sourceSize: { w: 90, h: 60 } }),
    fr('sym_e.png', 0, 240, 120, 120),
  ];
  writeCase(
    'tp-hash-symbols',
    {
      'symbols.png': atlasPng(size, frames),
      'symbols.json': hashManifest('symbols.png', size, frames),
      'expected.json': {
        kind: 'atlas',
        format: 'texturepacker-hash',
        atlas: size,
        frameCount: frames.length,
        occupancy: occupancyOf(size, frames),
        findings: [
          { rule: 'occupancy', severity: 'crit' },
          { rule: 'wasted-regions', severity: 'info' },
        ],
        note: 'Sparse symbol sheet: ~19% occupancy. Includes 1 trimmed + 1 rotated sprite.',
      },
    },
    `# tp-hash-symbols

TexturePacker **Hash** format. A sparse symbol sheet on a 512×512 (power-of-two) atlas:
only ~19% of the area is covered, so occupancy is **crit** and wasted-regions carries the
emptiness overlay (info). \`sym_c\` is trimmed and \`sym_d\` is rotated — they exercise
parser fidelity (the packed frame stays as-placed; source size is preserved).
`,
  );
}

/* ── Case 2: TexturePacker Array, oversize + non-power-of-two (crit/warn) ───
 * Healthy occupancy, but the atlas is 4100×1024: longest edge > 4096 (oversize
 * crit) and 4100 is NPOT (warn). Headline findings = dimensions. */
{
  const size = { w: 4100, h: 1024 };
  const frames = [
    fr('tile_0.png', 0, 0, 1000, 900),
    fr('tile_1.png', 1024, 0, 1000, 900),
    fr('tile_2.png', 2048, 0, 1000, 900),
    fr('tile_3.png', 3072, 0, 1000, 900),
  ];
  writeCase(
    'tp-array-oversize',
    {
      'sheet.png': atlasPng(size, frames),
      'sheet.json': arrayManifest('sheet.png', size, frames),
      'expected.json': {
        kind: 'atlas',
        format: 'texturepacker-array',
        atlas: size,
        frameCount: frames.length,
        occupancy: occupancyOf(size, frames),
        findings: [
          { rule: 'dimensions-oversize', severity: 'crit' },
          { rule: 'dimensions-npot', severity: 'info' },
          { rule: 'mipmap-cost', severity: 'info' },
        ],
        note: 'Occupancy ~86% (ok). Atlas 4100×1024: edge 4100 > 4096 (oversize crit) and NPOT (warn). 16.8MB texture → mipmaps would add ~5.6MB (mipmap-cost info).',
      },
    },
    `# tp-array-oversize

TexturePacker **Array** format. Occupancy is healthy (~86%), but the atlas is **4100×1024**:
the longest edge exceeds the 4096 crit threshold (oversize **crit**) and 4100 is not a power
of two (NPOT **warn**). No occupancy/wasted finding — dimensions are the story here.
`,
  );
}

/* ── Case 3: Pixi format, healthy (no problem findings) ─────────────────────
 * The "ok" baseline. Pixi spritesheet JSON is the TexturePacker Hash schema
 * WITHOUT the TexturePacker meta.app signature — that's how we tag it 'pixi'. */
{
  const size = { w: 1024, h: 1024 };
  const frames = [
    fr('run_0.png', 0, 0, 500, 475),
    fr('run_1.png', 512, 0, 500, 475),
    fr('run_2.png', 0, 500, 500, 475),
    fr('run_3.png', 512, 500, 500, 475),
  ];
  writeCase(
    'pixi-packed-ok',
    {
      'packed.png': atlasPng(size, frames),
      'packed.json': hashManifest('packed.png', size, frames, { pixi: true }),
      'expected.json': {
        kind: 'atlas',
        format: 'pixi',
        atlas: size,
        frameCount: frames.length,
        occupancy: occupancyOf(size, frames),
        findings: [],
        note: 'Healthy: ~91% occupancy, 1024² POT, not oversize. Pixi format (no TexturePacker meta.app).',
      },
    },
    `# pixi-packed-ok

PixiJS spritesheet format — structurally the TexturePacker Hash schema but **without**
\`meta.app\`, which is how the parser tags the source as \`pixi\`. Healthy atlas: ~91%
occupancy on a 1024×1024 power-of-two sheet, not oversize → zero problem findings. This is
the baseline that proves a clean atlas stays clean.
`,
  );
}

/* ── Case 4: single images (no atlas / manifest) ───────────────────────────
 * A folder of standalone PNGs. Exercises the single-image path + dimensions
 * on images. hero is oversize(warn)+NPOT(warn); icon is clean. */
{
  const hero = { name: 'hero.png', w: 2050, h: 2050 };
  const icon = { name: 'icon.png', w: 256, h: 256 };
  writeCase(
    'single-images',
    {
      'hero.png': solidPng(hero.w, hero.h, COLORS[0]),
      'icon.png': solidPng(icon.w, icon.h, COLORS[5]),
      'expected.json': {
        kind: 'images',
        images: [
          {
            name: hero.name,
            w: hero.w,
            h: hero.h,
            mime: 'image/png',
            vramBytes: hero.w * hero.h * 4,
            findings: [
              { rule: 'dimensions-oversize', severity: 'warn' },
              { rule: 'dimensions-npot', severity: 'info' },
            ],
          },
          {
            name: icon.name,
            w: icon.w,
            h: icon.h,
            mime: 'image/png',
            vramBytes: icon.w * icon.h * 4,
            findings: [],
          },
        ],
        note: 'hero.png 2050² → oversize warn (>2048) + NPOT warn. icon.png 256² → clean.',
      },
    },
    `# single-images

Standalone PNGs, no atlas/manifest. \`hero.png\` is 2050×2050 → oversize **warn** (edge >
2048, below the 4096 crit) and **NPOT warn**; its VRAM is 2050×2050×4 = 16,810,000 bytes.
\`icon.png\` is a clean 256×256. Exercises the single-image parse + dimensions on images.
`,
  );
}

/* ── Case 5: folder-waste — cross-asset problems for the whole-folder checks ──
 * 9 loose sprites (→ should-atlas), a byte-identical pair (→ duplicate-exact),
 * and a manifest referencing a missing image (→ integrity). */
{
  const files = {};
  // distinct color per sprite (avoid accidental duplicates from cycling COLORS)
  for (let i = 0; i < 9; i++) {
    files[`s${i}.png`] = solidPng(32, 32, [(40 + i * 23) % 256, (90 + i * 41) % 256, (150 + i * 29) % 256]);
  }
  files['dup_a.png'] = solidPng(48, 48, COLORS[2]); // identical bytes …
  files['dup_b.png'] = solidPng(48, 48, COLORS[2]); // … to dup_a (deterministic PNG)
  files['broken.json'] = {
    frames: { 'x.png': { frame: { x: 0, y: 0, w: 10, h: 10 } } },
    meta: { image: 'missing.png', size: { w: 64, h: 64 } },
  };
  files['expected.json'] = {
    kind: 'folder',
    looseSprites: 11,
    duplicateGroups: [['dup_a.png', 'dup_b.png']],
    missingImages: [{ manifest: 'broken.json', image: 'missing.png' }],
    note: '9 loose sprites + an exact-duplicate pair + a manifest with a missing image.',
  };
  writeCase(
    'folder-waste',
    files,
    `# folder-waste

Cross-asset problems for the whole-folder checks: 9 loose sprites (→ should-atlas), a
byte-identical pair \`dup_a.png\`/\`dup_b.png\` (→ duplicate-exact), and \`broken.json\`
referencing a missing image (→ integrity-missing-image).
`,
  );
}

/* ── Case 6: Spine .atlas (libGDX text format) — exercises the Spine parser ── */
{
  const size = { w: 256, h: 256 };
  const frames = [
    fr('regionA', 0, 0, 100, 80),
    fr('regionB', 110, 0, 40, 60, { rotated: true }), // a 60×40 region placed rotated 90° → 40×60
  ];
  const atlasText = `sheet.png
size: ${size.w},${size.h}
format: RGBA8888
filter: Linear,Linear
repeat: none
regionA
  rotate: 0
  xy: 0, 0
  size: 100, 80
  orig: 100, 80
  offset: 0, 0
  index: -1
regionB
  rotate: 90
  xy: 110, 0
  size: 60, 40
  orig: 60, 40
  offset: 0, 0
  index: -1
`;
  writeCase(
    'spine-basic',
    {
      'sheet.png': atlasPng(size, frames),
      'sheet.atlas': atlasText,
      'expected.json': {
        kind: 'spine',
        atlas: size,
        frameCount: 2,
        occupancy: occupancyOf(size, frames),
        note: 'Single-page Spine .atlas with 2 regions (one rotated 90°).',
      },
    },
    `# spine-basic

A single-page Spine \`.atlas\` (libGDX text format) with 2 regions (one rotated 90°). Exercises
the Spine parser end-to-end (group → parseSpinePage → analyze).
`,
  );
}

/* ── Case 7: tp-merge — two under-filled atlases for the atlas-merge (non-drop-in) fix ──
 * Two 256² sheets at ~12.5% occupancy each; their content fits in one sheet, so atlas-merge
 * fires. Used to verify the "merge atlases" fix mode (which changes manifest references). */
{
  const size = { w: 256, h: 256 };
  const aFrames = [fr('a_red.png', 8, 8, 64, 64), fr('a_blue.png', 8, 96, 64, 64)];
  const bFrames = [fr('b_green.png', 8, 8, 64, 64), fr('b_gold.png', 8, 96, 64, 64)];
  writeCase(
    'tp-merge',
    {
      'atlas_a.png': atlasPng(size, aFrames),
      'atlas_a.json': hashManifest('atlas_a.png', size, aFrames),
      'atlas_b.png': atlasPng(size, bFrames),
      'atlas_b.json': hashManifest('atlas_b.png', size, bFrames),
      'expected.json': {
        kind: 'folder',
        atlases: 2,
        occupancyEach: occupancyOf(size, aFrames),
        findings: [
          { rule: 'atlas-merge', severity: 'warn' },
          { rule: 'occupancy', severity: 'crit' },
        ],
        note: 'Two ~12.5% atlases whose content fits in one sheet → atlas-merge.',
      },
    },
    `# tp-merge

Two under-filled 256×256 TexturePacker atlases (~12.5% occupancy each). Their content fits in a
single sheet, so **atlas-merge** fires. Used to verify the non-drop-in "merge atlases" fix mode
(which combines them into one sheet and rewrites manifest references).
`,
  );
}

/* ── Case 8: poly-concave — concave silhouettes whose bboxes waste space, so polygon nesting wins ──
 * 8 untrimmed 128×128 sprites (frame == bbox) on a 512×512 TexturePacker **Hash** atlas. Each sprite's
 * OPAQUE silhouette is ~half its bbox (a right-triangle split on the diagonal), and the sprites come in
 * 4 COMPLEMENTARY pairs (lower-left ▙ + upper-right ▝) that interlock into ~one bbox. Rectangle packing
 * sees only the 128×128 bboxes (Σ ≈ 8·130² with padding) and needs a 512² POT sheet; the bitmap-mask
 * nester sees ~half-occupied cell grids (Σ mask-cell area ≈ 4·128²) and interlocks the pairs into a 256²
 * POT sheet → 1/4 the VRAM. At ACC_CELL=4 a 128px edge is 32 cells and the +1-cell dilation
 * (DILATE_CELLS(padding=2)=1) still leaves a deep diagonal concavity, so the win is robust.
 *
 * Shapes (local lx,ly in [0,128), Y-down):
 *  - ll: lower-left triangle  (lx + ly >= w)   ▙   opaque below the anti-diagonal
 *  - ur: upper-right triangle (lx + ly <= w)   ▝   opaque above the anti-diagonal — complements ll
 *  - L:  L-shape (left column + bottom row)         a concave bracket
 *  - chevron: downward chevron (two diagonals)      a deep central notch */
{
  const size = { w: 512, h: 512 };
  const S = 128;
  // Anti-diagonal split: the two halves tile the bbox (every pixel belongs to exactly one of them on
  // the lx+ly==w line, so together they reconstruct the full 128×128 — a true interlock).
  const lowerLeft = (lx, ly, w) => lx + ly >= w; // ▙
  const upperRight = (lx, ly, w) => lx + ly < w; // ▝
  // A thick concave L (left column + bottom row, each 40px) — large transparent top-right quadrant.
  const lShape = (lx, ly, w, h) => lx < 40 || ly >= h - 40;
  // A downward chevron: opaque only near the two falling diagonals (deep transparent notch at top).
  const chevron = (lx, ly, w) => {
    const t = 26; // band thickness
    const onLeft = Math.abs(lx - ly) <= t && lx <= w / 2; // ╲
    const onRight = Math.abs(w - 1 - lx - ly) <= t && lx >= w / 2; // ╱
    return onLeft || onRight;
  };
  const frames = [
    fr('tri_ll_0.png', 0, 0, S, S, { shape: lowerLeft }),
    fr('tri_ur_0.png', 128, 0, S, S, { shape: upperRight }),
    fr('tri_ll_1.png', 256, 0, S, S, { shape: lowerLeft }),
    fr('tri_ur_1.png', 384, 0, S, S, { shape: upperRight }),
    fr('tri_ll_2.png', 0, 128, S, S, { shape: lowerLeft }),
    fr('tri_ur_2.png', 128, 128, S, S, { shape: upperRight }),
    fr('lshape_0.png', 256, 128, S, S, { shape: lShape }),
    fr('chevron_0.png', 384, 128, S, S, { shape: chevron }),
  ];
  writeCase(
    'poly-concave',
    {
      'atlas.png': shapeAtlasPng(size, frames),
      'atlas.json': hashManifest('atlas.png', size, frames),
      'expected.json': {
        kind: 'atlas',
        format: 'texturepacker-hash',
        atlas: size,
        frameCount: frames.length,
        occupancy: occupancyOf(size, frames),
        // expected.json occupancy is BBOX occupancy (frame area ÷ atlas area) — the diagnosis figure.
        // The actual OPAQUE coverage is far lower (~half the bboxes), which is the defect this case
        // documents: bbox-based rectangle packing wastes the transparent halves.
        defect: 'concave-silhouettes-waste-bbox',
        polygon: {
          mode: 'win',
          why: 'Opaque silhouettes are ~half their 128×128 bboxes and interlock in complementary pairs. '
            + 'Rectangle packing of the bboxes needs a 512² POT sheet; bitmap-mask polygon nesting '
            + 'interlocks the pairs into a 256² POT sheet → 1/4 the VRAM.',
          expectMeshedSprites: '>=1',
        },
        findings: [{ rule: 'occupancy', severity: 'crit' }],
        note: '8 concave 128² sprites (frame==bbox). BBox occupancy is the headline; opaque coverage is ~half, so polygon-mode packing wins (256² vs 512²).',
      },
    },
    `# poly-concave

8 untrimmed **128×128** sprites (frame == bbox) on a 512×512 TexturePacker **Hash** atlas, drawn with
**concave** opaque silhouettes whose opaque area is only ~half each bounding box:

- \`tri_ll_*\` / \`tri_ur_*\` — complementary right-triangles split on the anti-diagonal (▙ / ▝). Each
  opaque half is ~50% of its bbox; a ▙ and a ▝ **interlock into one 128×128 square**.
- \`lshape_0\` — a thick concave **L** (left column + bottom row); the top-right quadrant is transparent.
- \`chevron_0\` — a downward **chevron** with a deep transparent notch at the top.

### Known defect (what this fixture proves)
Rectangle packing sees only the 128×128 **bounding boxes** (the transparent halves are dead weight), so it
needs a **512² POT** sheet. The binary (bitmap-mask) polygon packer measures the actual opaque silhouette
at the \`ACC_CELL=4\` grid (with a conservative +1-cell dilation for the \`padding=2\` bleed budget) and
**interlocks the complementary pairs into a 256² POT** sheet — **1/4 the VRAM**. At least one concave
sprite traces to a real mesh (non-null \`traceMesh\`), so \`verticesUV\` / \`triangles\` ship in the
polygon manifest and the on-screen receipt reports the meshed count. This is the end-to-end proof that
polygon mode beats rectangle packing on genuinely concave art.
`,
  );
}

/* ── Case 9: raw-multifolder-dupes — owner/consumer whole-file dedup across bundles ───────────
 * Drives Part B Feature 1 (owner/consumer dedup) + Feature 3 (lazy-aware owner selection). A
 * multi-folder raw upload (NO pre-built atlases except the repoint pair) where the SAME bytes recur
 * across folders. The golden (expected.json) is authored HERE, by hand, mirroring what
 * buildDedupGroups(features, spineRefs, MARKING, SKIN_GUARD) must return for these refs — an
 * independent cross-check of packages/analysis/src/dedup.ts (design §3a, §10).
 *
 * bundle(ref) = first dir-aware path segment. MARKING below marks the two "game" roots eager and the
 * two "bonus" roots lazy; every other root is UNMARKED ⇒ isolated (the fail-safe default).
 *
 * Owner rule recap (codepoint cmp, NOT localeCompare): if any member is eager, owner = cmp-first eager
 * and everyone else consumes it (one safe cross-bundle edge — LAZY_MAY_CONSUME_EAGER=true). With no
 * eager member, dedup only WITHIN a bundle (cmp-first local owner); zero cross-bundle edges.
 *
 * Each distinct CONTENT below uses a unique (size,color) so byte-identity is intentional, never
 * accidental — only files sharing a content tag have the same contentHash. */
{
  // Marking used by the dedup golden. Roots not listed here are 'isolated' (unmarked default).
  const MARKING = { main_game: 'eager', fs_game: 'eager', bonus: 'lazy', bonus_b: 'lazy' };
  // SkinGuard matches on FILE basename (no ext), no general-owner fallback (AD's strict rule, §3c).
  const SKIN_GUARD = { skin_red: 'skin_blue' };

  // Distinct contents (unique size+color ⇒ unique bytes ⇒ unique contentHash).
  const L = solidPng(64, 64, COLORS[0]); // logo — cross-bundle eager pair
  const I = solidPng(40, 40, COLORS[1]); // icon — same-bundle pair
  const S = solidPng(24, 24, COLORS[2]); // spark — eager + two lazy
  const K = solidPng(80, 60, COLORS[3]); // skin art — keys/values pair (must NOT collapse)
  const T = solidPng(50, 50, COLORS[4]); // tile — folder-vs-file basename case
  const O = solidPng(33, 33, COLORS[6]); // orphan — same-bundle loose dup, no rewritable reference

  // Spine page image + a matching pixi sprite (same bytes F) → pool separation must keep them apart.
  const spineSize = { w: 128, h: 64 };
  const spineFrames = [fr('frameA', 0, 0, 60, 50), fr('frameB', 64, 0, 50, 40)];
  const F = atlasPng(spineSize, spineFrames); // spine page bytes (== props/frame.png pixi sprite)
  const spineAtlasText = (image) => `${image}
size: ${spineSize.w},${spineSize.h}
format: RGBA8888
filter: Linear,Linear
repeat: none
frameA
  rotate: 0
  xy: 0, 0
  size: 60, 50
  orig: 60, 50
  offset: 0, 0
  index: -1
frameB
  rotate: 0
  xy: 64, 0
  size: 50, 40
  orig: 50, 40
  offset: 0, 0
  index: -1
`;

  // Owner-atlas + identical consumer-atlas (image bytes A) for the meta.image repoint round-trip.
  const sheetSize = { w: 128, h: 128 };
  const sheetFrames = [fr('part0.png', 0, 0, 64, 64), fr('part1.png', 64, 0, 64, 64)];
  const A = atlasPng(sheetSize, sheetFrames); // owner+consumer sheet bytes (byte-identical)

  writeCase(
    'raw-multifolder-dupes',
    {
      // (a) cross-bundle identical, both eager → owner = cmp-first eager (fs_game < main_game).
      'main_game/logo.png': L,
      'fs_game/logo.png': L,

      // (b) same-bundle identical (both eager main_game) → owner = cmp-first (general < ui).
      'main_game/general/icon.png': I,
      'main_game/ui/icon.png': I,

      // (c) one eager image duplicated across two lazy bundles → both lazy consume the eager owner.
      'main_game/spark.png': S,
      'bonus/spark.png': S,
      'bonus_b/spark.png': S,

      // (d) SkinGuard keys/values pair, byte-identical, DIFFERENT basenames → MUST NOT collapse.
      'theme_default/skin_red.png': K,
      'theme_dark/skin_blue.png': K,

      // (e) folder-vs-file basename: folders are named like the skin key/value, but the FILE basename
      //     ('tile') is neither → AD's file-basename rule puts both in 'general'. Same-content, but
      //     distinct isolated bundles (skin_red ≠ skin_blue) → no eager → ZERO cross-bundle edges,
      //     each is its own owner. (Builder folder-basename matching would have split them keys/values;
      //     this pins AD's deliberate divergence — §3c.1.)
      'skin_red/tile.png': T,
      'skin_blue/tile.png': T,

      // (f) spine-pool pair: same bundle 'animations', both pages carry a .atlas → spine pool.
      'animations/a/frame.png': F,
      'animations/a/frame.atlas': spineAtlasText('frame.png'),
      'animations/b/frame.png': F,
      'animations/b/frame.atlas': spineAtlasText('frame.png'),

      // (g) pixi sprite byte-identical to the spine frame (bytes F) → pool separation keeps it apart;
      //     alone in the pixi pool for hash F ⇒ no group at all.
      'props/frame.png': F,

      // (h) atlas image+manifest pair fully identical to an owner atlas → meta.image repoint.
      //     main_game (eager) owns; extra (isolated) consumes (eager-owner-cross-bundle), repointManifest.
      'main_game/sheet.png': A,
      'main_game/sheet.json': hashManifest('sheet.png', sheetSize, sheetFrames),
      'extra/sheet.png': A,
      'extra/sheet.json': hashManifest('sheet.png', sheetSize, sheetFrames),

      // (i) loose same-bundle dup with NO rewritable reference (no manifest emits these refs) →
      //     same-isolated-bundle drop is planned, but the worker KEEPS it + surfaces looseRepathSkipped.
      'loose/orphan.png': O,
      'loose/orphan_copy.png': O,

      'expected.json': {
        kind: 'dedup',
        // The marking + skin guard the golden was authored against. Pass these to buildDedupGroups.
        marking: MARKING,
        skinGuard: SKIN_GUARD,
        // Expected buildDedupGroups(...) output, grouped by case. Ordering here is by case for
        // readability; the real call sorts by (contentHash, pool, skinGroup) — assert as a set.
        dedupGroups: [
          {
            case: 'a-cross-bundle-eager',
            pool: 'pixi',
            skinGroup: 'general',
            owners: ['fs_game/logo.png'],
            consumers: [{ ref: 'main_game/logo.png', ownerRef: 'fs_game/logo.png', reason: 'eager-owner-cross-bundle' }],
          },
          {
            case: 'b-same-bundle-eager',
            pool: 'pixi',
            skinGroup: 'general',
            owners: ['main_game/general/icon.png'],
            consumers: [{ ref: 'main_game/ui/icon.png', ownerRef: 'main_game/general/icon.png', reason: 'same-eager-bundle' }],
          },
          {
            case: 'c-eager-plus-two-lazy',
            pool: 'pixi',
            skinGroup: 'general',
            owners: ['main_game/spark.png'],
            consumers: [
              { ref: 'bonus/spark.png', ownerRef: 'main_game/spark.png', reason: 'eager-owner-cross-bundle' },
              { ref: 'bonus_b/spark.png', ownerRef: 'main_game/spark.png', reason: 'eager-owner-cross-bundle' },
            ],
          },
          {
            case: 'e-folder-vs-file-basename',
            pool: 'pixi',
            skinGroup: 'general',
            // No eager member, distinct isolated bundles → each its own owner, ZERO consumers.
            owners: ['skin_blue/tile.png', 'skin_red/tile.png'],
            consumers: [],
          },
          {
            case: 'f-spine-pool-same-bundle',
            pool: 'spine',
            skinGroup: 'general',
            owners: ['animations/a/frame.png'],
            consumers: [{ ref: 'animations/b/frame.png', ownerRef: 'animations/a/frame.png', reason: 'same-isolated-bundle' }],
          },
          {
            case: 'h-atlas-repoint',
            pool: 'pixi',
            skinGroup: 'general',
            owners: ['main_game/sheet.png'],
            consumers: [{ ref: 'extra/sheet.png', ownerRef: 'main_game/sheet.png', reason: 'eager-owner-cross-bundle', repointManifest: true }],
          },
          {
            case: 'i-loose-no-rewritable-ref',
            pool: 'pixi',
            skinGroup: 'general',
            owners: ['loose/orphan.png'],
            consumers: [{ ref: 'loose/orphan_copy.png', ownerRef: 'loose/orphan.png', reason: 'same-isolated-bundle' }],
          },
        ],
        // Groups that MUST NOT form (negative goldens — assert ABSENT from buildDedupGroups output).
        mustNotCollapse: [
          {
            case: 'd-skin-keys-values',
            refs: ['theme_dark/skin_blue.png', 'theme_default/skin_red.png'],
            why: 'byte-identical, but skin_red∈keys and skin_blue∈values → different (pool,skinGroup) partitions; never collapse.',
          },
          {
            case: 'g-pixi-vs-spine-same-bytes',
            refs: ['props/frame.png', 'animations/a/frame.png', 'animations/b/frame.png'],
            why: 'props/frame.png (pixi) is byte-identical to the spine frames, but pool separation keeps pixi and spine in different partitions; props/frame.png is alone in the pixi pool for this hash ⇒ no group.',
          },
        ],
        // Worker-side expectations beyond the pure group plan (consumed by the round-trip/worker tests).
        worker: {
          // (h) consumer atlas: drop the redundant IMAGE, repoint its manifest meta.image at the owner
          //     image (round-trips through @asset-doctor/parsers parseAtlas); referencesRewritten++.
          repointManifest: [{ consumerImage: 'extra/sheet.png', consumerManifest: 'extra/sheet.json', ownerImage: 'main_game/sheet.png' }],
          // (i) planned same-bundle drop with no AD-emitted referencing manifest → KEEP + surface.
          looseRepathSkipped: ['loose/orphan_copy.png'],
        },
        note:
          'Multi-folder raw dupes for owner/consumer dedup. Cross-bundle eager pair, same-bundle pair, '
          + 'eager+two-lazy, a keys/values skin pair that must NOT collapse, a folder-vs-file basename case, '
          + 'a spine-pool pair, a pixi sprite byte-identical to a spine frame (pool-separated, no collapse), '
          + 'an atlas image+manifest identical to an owner (meta.image repoint), and a loose dup with no '
          + 'rewritable reference (kept, surfaced). Marking: main_game/fs_game eager, bonus/bonus_b lazy, rest isolated.',
      },
    },
    `# raw-multifolder-dupes

A multi-folder **raw upload** (loose images + one pre-built atlas pair) where the same bytes recur
across folders. Drives Part B **owner/consumer dedup** (Feature 1) and **lazy-aware owner selection**
(Feature 3). \`bundle(ref)\` = first path segment; the golden uses marking
\`{ main_game: eager, fs_game: eager, bonus: lazy, bonus_b: lazy }\` (every other root is **isolated**,
the unmarked default), and SkinGuard \`{ skin_red: skin_blue }\` (matched on the **file** basename).

Owner rule (codepoint \`cmp\`, **not** localeCompare): with any eager member, owner = the cmp-first
eager copy and everyone else consumes it (one safe cross-bundle edge, \`LAZY_MAY_CONSUME_EAGER\`); with
no eager member, dedup only **within** a bundle (cmp-first local owner) — zero cross-bundle edges.

### Cases (see \`expected.json\` for the authored golden)
- **(a)** \`main_game/logo.png\` == \`fs_game/logo.png\` — cross-bundle, both eager → owner \`fs_game/logo.png\` (cmp-first), \`main_game\` consumes (\`eager-owner-cross-bundle\`).
- **(b)** \`main_game/general/icon.png\` == \`main_game/ui/icon.png\` — same eager bundle → owner \`general\` (cmp-first), \`ui\` consumes (\`same-eager-bundle\`).
- **(c)** \`main_game/spark.png\` (eager) == \`bonus/spark.png\` == \`bonus_b/spark.png\` (two lazy) → both lazy consume the eager owner (\`eager-owner-cross-bundle\`).
- **(d)** \`theme_default/skin_red.png\` == \`theme_dark/skin_blue.png\` (byte-identical) → **NOT collapsed**: \`skin_red\`∈keys, \`skin_blue\`∈values (different skin partitions).
- **(e)** \`skin_red/tile.png\` == \`skin_blue/tile.png\` — folders look like skin key/value, but the **file** basename \`tile\` is neither → both \`general\`. No eager, distinct isolated bundles → each its own owner, no drop. Pins AD's file-basename rule (vs the builder's folder-basename).
- **(f)** \`animations/a/frame.png\` == \`animations/b/frame.png\`, both with a \`.atlas\` → **spine** pool, same bundle → owner \`a\` (cmp-first), \`b\` consumes (\`same-isolated-bundle\`).
- **(g)** \`props/frame.png\` is byte-identical to the spine frame but is a **pixi** sprite → pool separation keeps it apart; alone in the pixi pool for this hash → **no group**.
- **(h)** \`extra/sheet.{png,json}\` is fully identical to \`main_game/sheet.{png,json}\` → owner \`main_game\` (eager), the consumer's **image is dropped and its manifest \`meta.image\` is repointed** at the owner image (round-trips through \`parseAtlas\`).
- **(i)** \`loose/orphan.png\` == \`loose/orphan_copy.png\` — same isolated bundle, so a drop is planned, but no AD-emitted manifest references them → the worker **KEEPS** the copy and surfaces \`looseRepathSkipped\`.
`,
  );
}

/* ── Case 10: loose-static — RAW loose PNGs → one packed sheet + TexturePacker JSON (Feature 4 A) ──
 * A folder of standalone PNGs (no manifest), enough to clear shouldAtlas.minLooseImages (8) so the
 * grouping helper forms a STATIC pack group (one sheet per leaf folder, default granularity). Every
 * image is ≤ maxSpriteEdgePx (512) so it re-applies as a pack candidate. Coverage:
 *   • some images carry a fully-transparent MARGIN → the worker's alphaBBox trims them; the golden's
 *     `trim` (top-left bbox) + `spriteSourceSize` (TP top-left convention) document the outcome.
 *   • one fully-OPAQUE image (bbox == source) → trimmed:false even with trim on.
 *   • one fully-TRANSPARENT image → static 1×1 sentinel (frame resolvable, never zero-size).
 *   • a NESTED subfolder (icons/) → its frame keys are folder-RELATIVE stems (icons/star), the
 *     reference-changing decision surfaced in fix.packWarn. The per-leaf-folder default would split
 *     icons/ into its own sheet, so here we exercise relative keys via the one-sheet-for-all view:
 *     the golden documents BOTH the per-leaf-folder grouping (the worker default) AND the relative
 *     region names a one-sheet pack would expose.
 * Region name = folder-relative stem (ext stripped, slash-preserved). The packed sheet's TP JSON
 * re-parses (parseAtlas) to these frames; meta.image = the sheet basename. */
{
  // Leaf-folder root (the default per-leaf-folder group): 8 loose PNGs directly under the folder.
  // Sizes are round; margins leave a deterministic opaque bbox the worker's alphaBBox recovers.
  const loose = [
    // name, full w,h, margin x,y, bbox w,h, colorIdx — opaque inner rect inside a transparent frame.
    { name: 'coin.png', w: 64, h: 64, mx: 8, my: 8, bw: 48, bh: 48, c: 4 }, // trimmed (margin all sides)
    { name: 'gem.png', w: 64, h: 64, mx: 0, my: 0, bw: 64, bh: 64, c: 5 }, // FULL opaque → trimmed:false
    { name: 'key.png', w: 80, h: 40, mx: 10, my: 4, bw: 60, bh: 32, c: 0 }, // trimmed
    { name: 'potion.png', w: 48, h: 96, mx: 6, my: 12, bw: 36, bh: 72, c: 1 }, // trimmed
    { name: 'ring.png', w: 40, h: 40, mx: 4, my: 4, bw: 32, bh: 32, c: 2 }, // trimmed
    { name: 'scroll.png', w: 100, h: 60, mx: 0, my: 0, bw: 100, bh: 60, c: 3 }, // full opaque
    { name: 'shield.png', w: 72, h: 72, mx: 4, my: 8, bw: 64, bh: 56, c: 6 }, // trimmed (asymmetric)
    { name: 'sword.png', w: 32, h: 120, mx: 8, my: 0, bw: 16, bh: 120, c: 7 }, // trimmed (tall sliver)
  ];
  const blank = { name: 'blank.png', w: 50, h: 50 }; // fully transparent → 1×1 sentinel
  const nested = [
    { name: 'icons/star.png', w: 32, h: 32, mx: 2, my: 2, bw: 28, bh: 28, c: 0 },
    { name: 'icons/heart.png', w: 32, h: 32, mx: 4, my: 4, bw: 24, bh: 24, c: 6 },
  ];

  const files = {};
  for (const im of loose) files[im.name] = marginPng(im.w, im.h, im.mx, im.my, im.bw, im.bh, COLORS[im.c]);
  files[blank.name] = transparentPng(blank.w, blank.h);
  for (const im of nested) files[im.name] = marginPng(im.w, im.h, im.mx, im.my, im.bw, im.bh, COLORS[im.c]);

  // expected.json documents the INTENDED packing outcome (authored by hand, the cross-check):
  //   - The default per-leaf-folder grouping yields TWO groups: the root leaf folder ('loose-static',
  //     8 root PNGs + blank → 9 candidates ≥ minLooseImages) and icons/ (2 candidates < minLooseImages
  //     → SKIPPED unless forced). So by default only the root sheet packs.
  //   - region (frame) name = stem relative to the group outDir; nested keep their sub-path.
  //   - trim metadata = the opaque bbox each image was authored with (top-left), so the worker's
  //     alphaBBox is independently checkable against these numbers.
  const expectRegion = (im) => {
    const full = im.bw === im.w && im.bh === im.h; // fully opaque (no transparent margin)
    return {
      name: im.name.replace(/\.png$/, ''),
      sourceSize: { w: im.w, h: im.h },
      // The opaque bbox the worker's alphaBBox recovers (top-left). For a fully-opaque image this IS the
      // full-size rect (alphaBBox returns the whole image, never null); null is reserved for the fully
      // transparent blank below. `trimmed` is the strict-inside test, decoupled from the bbox value.
      trim: full ? { x: 0, y: 0, w: im.w, h: im.h } : { x: im.mx, y: im.my, w: im.bw, h: im.bh },
      // trimmed:true only when the bbox is strictly inside the source.
      trimmed: !full,
      // TP spriteSourceSize (top-left convention) emitted ONLY when trimmed.
      ...(full ? {} : { spriteSourceSize: { x: im.mx, y: im.my, w: im.bw, h: im.bh } }),
    };
  };

  files['expected.json'] = {
    kind: 'pack-static',
    feature: 'pack-loose-static',
    // Grouping the helper must produce with DEFAULT options (mode auto, per-leaf-folder).
    grouping: {
      mode: 'auto',
      granularity: 'per-leaf-folder',
      thresholds: { minLooseImages: 8, maxSpriteEdgePx: 512 },
      groups: [
        {
          id: 'static:/loose-static', // outDir '' → repo root of the upload; stem = 'loose-static' leaf when uploaded as that folder; documented as the leaf-folder sheet
          kind: 'static',
          // 9 candidates at the root (8 loose + blank). icons/* are a separate <minLooseImages bucket.
          regionCount: 9,
          note: 'Root leaf folder packs (≥8 candidates). icons/ has 2 (<8) → skipped unless forced or one-sheet-for-all.',
        },
      ],
      skipped: [{ bucket: 'icons', regionCount: 2, why: 'below minLooseImages (8)' }],
    },
    // The regions the root sheet folds in (region name = stem; trim authored = worker alphaBBox golden).
    regions: [...loose, blank].map((im) =>
      im.name === 'blank.png'
        ? {
            name: 'blank',
            sourceSize: { w: blank.w, h: blank.h },
            trim: null,
            transparent: true,
            sentinel: '1x1', // static fully-transparent → 1×1 sentinel (frame resolvable, sourceSize=original)
            trimmed: true,
          }
        : expectRegion(im),
    ),
    // If packed with one-sheet-for-all (forced view), nested icons/ keep their relative sub-path key.
    relativeKeys: nested.map((im) => im.name.replace(/\.png$/, '')),
    pack: {
      sort: 'localeCompare', // emitted TP-JSON frame order == packLoose sprite order
      allowRotation: false, // v1: never rotate a blit (all rotated:false / rotate:0)
      targetMimeDefault: 'image/webp', // static may use lossless WebP/AVIF; spine defaults PNG
      referencesChanged: true, // building a sheet is reference-changing (NOT drop-in) → fix.packWarn
    },
    note:
      '8 loose PNGs (most with transparent margins) + a fully-transparent blank (1×1 sentinel) + a nested '
      + 'icons/ subfolder. Default per-leaf-folder grouping packs the 9 root candidates into ONE sheet + TP '
      + 'JSON (frames keyed by folder-relative stem); icons/ (2 < 8) is skipped. Reference-changing.',
  };

  writeCase(
    'loose-static',
    files,
    `# loose-static

RAW **loose PNGs** (no manifest) for Feature 4 part A — packing loose assets into a static
spritesheet + TexturePacker JSON. Eight images sit directly under the folder (≥ \`minLooseImages\`
= 8), most with a fully-transparent **margin** the worker's \`alphaBBox\` trims; \`gem.png\` /
\`scroll.png\` are fully opaque (\`trimmed:false\` even with trim on); \`blank.png\` is fully
**transparent** → a **1×1 sentinel** (the frame stays resolvable, never zero-size). A nested
\`icons/\` subfolder exercises folder-**relative** frame keys (\`icons/star\`).

### Intended outcome (\`expected.json\` is the authored golden)
Default grouping is **per-leaf-folder**: the 9 root candidates pack into **one** sheet + TP JSON
(frames keyed by the folder-relative stem); \`icons/\` (2 candidates < 8) is **skipped** unless
forced or under one-sheet-for-all. Sprite/frame order is \`localeCompare\` (== the emitted manifest).
Packing is **reference-changing** — the game must load the sheet JSON, not the loose files — so
\`FixReceipt.referencesChanged\` is set and \`fix.packWarn\` fires. \`allowRotation\` is always false.
`,
  );
}

/* ── Case 11: spine-loose — loose region PNGs + a MODERN (skins-ARRAY) skeleton → packed .atlas ──
 * Feature 4 part B. Loose region images whose folder-relative stems EQUAL the skeleton attachment
 * paths (incl. the nested items/sword). The skeleton is the modern skins-ARRAY form and exercises the
 * full verifier matrix (mirrors packages/fix/test/spine-verify.ts `modern`):
 *   • head        region, no path override          → region name 'head'
 *   • sword       region WITH path override 'items/sword' (attachment name ≠ region/path) → 'items/sword'
 *   • shield      region SHARED across two slots (shieldA, shieldB) — legitimate, must NOT collide
 *   • cape        mesh attachment                    → needs region 'cape'
 *   • capeLink    linkedmesh, parent 'cape'          → inherits region 'cape' (no path of its own)
 *   • mask        clipping attachment                → needs NO region; IGNORED (never flagged)
 * One region (cape.png) carries a transparent margin → the BOTTOM-LEFT Spine offset (the Y-flip) is
 * documented. The packed `.atlas` re-parses (parseSpineAtlasText) to these regions; every REQUIRED
 * attachment path resolves (verified = 6: head + items/sword + shield + shield + cape(mesh) + cape(link)).
 * The skeleton .json is PASSED THROUGH untouched (names already match attachment paths). */
function spineSkeletonModern() {
  // skins is an ARRAY of { name, attachments: { slot: { att: {...} } } } (real production form).
  return {
    skeleton: { hash: 'fixture', spine: '3.8', x: 0, y: 0, width: 100, height: 100 },
    bones: [{ name: 'root' }],
    slots: [
      { name: 'head', bone: 'root', attachment: 'head' },
      { name: 'weapon', bone: 'root', attachment: 'sword' },
      { name: 'shieldA', bone: 'root', attachment: 'shield' },
      { name: 'shieldB', bone: 'root', attachment: 'shield' },
      { name: 'cape', bone: 'root', attachment: 'cape' },
      { name: 'capeLink', bone: 'root', attachment: 'capeLink' },
      { name: 'mask', bone: 'root', attachment: 'mask' },
    ],
    skins: [
      {
        name: 'default',
        attachments: {
          head: { head: { type: 'region' } }, // region name = attachment name 'head'
          weapon: { sword: { type: 'region', path: 'items/sword' } }, // path override → 'items/sword'
          shieldA: { shield: { type: 'region' } }, // shared region 'shield' …
          shieldB: { shield: { type: 'region' } }, // … same region in a second slot (NOT a collision)
          cape: { cape: { type: 'mesh', width: 60, height: 80 } }, // mesh → needs region 'cape'
          capeLink: { capeLink: { type: 'linkedmesh', parent: 'cape', skin: 'default' } }, // inherits 'cape'
          mask: { mask: { type: 'clipping', end: 'mask', vertexCount: 4 } }, // clipping → ignored
        },
      },
    ],
    animations: { idle: {} },
  };
}

// The loose region files a from-scratch (or path-override) Spine export drops next to the skeleton.
// stem (folder-relative, ext stripped) == the attachment's resolved path.
const SPINE_REGIONS = [
  { name: 'head.png', w: 64, h: 64, mx: 4, my: 4, bw: 56, bh: 56, c: 0 }, // trimmed
  { name: 'items/sword.png', w: 32, h: 96, mx: 8, my: 0, bw: 16, bh: 96, c: 1 }, // nested + trimmed
  { name: 'shield.png', w: 72, h: 72, mx: 6, my: 6, bw: 60, bh: 60, c: 2 }, // trimmed; shared by 2 slots
  { name: 'cape.png', w: 80, h: 100, mx: 10, my: 20, bw: 60, bh: 60, c: 3 }, // trimmed (asymmetric → Y-flip visible)
];

function spineRegionFiles() {
  const files = {};
  for (const im of SPINE_REGIONS) files[im.name] = marginPng(im.w, im.h, im.mx, im.my, im.bw, im.bh, COLORS[im.c]);
  return files;
}

/** The bottom-left Spine offset the emitter writes for a region (spineOffsetFrom): the ONLY Y-flip.
 *  offsetX = bbox.x ; offsetY = sourceSize.h - (bbox.y + bbox.h). */
const spineOffset = (im) => ({ x: im.mx, y: im.h - (im.my + im.bh) });

function spineRegionGolden(im) {
  const region = im.name.replace(/\.png$/, '');
  return {
    region,
    sourceSize: { w: im.w, h: im.h }, // → .atlas `orig:`
    size: { w: im.bw, h: im.bh }, // un-rotated trimmed extent → .atlas `size:`
    trim: { x: im.mx, y: im.my, w: im.bw, h: im.bh }, // top-left bbox the worker's alphaBBox recovers
    offset: spineOffset(im), // BOTTOM-LEFT → .atlas `offset:` (Y-flip; emitted verbatim)
    rotate: 0,
  };
}

{
  const skel = spineSkeletonModern();
  const files = {
    ...spineRegionFiles(),
    'skeleton.json': skel,
    'expected.json': {
      kind: 'pack-spine',
      feature: 'pack-loose-spine',
      skinsShape: 'array-modern',
      grouping: {
        mode: 'auto',
        // The folder holding the skeleton .json is the spine root; ALL loose regions under it pack
        // into ONE .atlas (kind:'spine'), regardless of count (correctness > the minLooseImages floor).
        spineRoot: '(the upload folder)',
        skeletonRef: 'skeleton.json',
        regionCount: SPINE_REGIONS.length,
      },
      // The regions the packed .atlas ships (region name = folder-relative stem, slash-preserved).
      regions: SPINE_REGIONS.map(spineRegionGolden),
      // verifySpineSkeleton(skeleton, packedRegionNames) outcome — every required path resolves.
      verification: {
        unverified: false,
        // head + items/sword(override) + shield + shield(shared) + cape(mesh) + cape(linkedmesh parent)
        verified: 6,
        unmatched: [],
        ignored: ['mask (clipping → needs no region)'],
        sharedRegion: { region: 'shield', slots: ['shieldA', 'shieldB'], note: 'shared across slots — NOT a collision' },
        pathOverride: { attachment: 'sword', region: 'items/sword' },
        linkedmesh: { attachment: 'capeLink', parent: 'cape', resolvedRegion: 'cape' },
      },
      atlas: {
        format: 'RGBA8888',
        filter: 'Linear,Linear',
        repeat: 'none',
        pma: false,
        // ONE page (4 small regions fit). Regions sorted by name (localeCompare) in the emitted .atlas.
        pages: 1,
        sort: 'localeCompare',
        roundTrip: 'parseSpineAtlasText recovers each region byte-equivalently (orig/size/offset/rotate)',
      },
      pack: { allowRotation: false, targetMime: 'image/png', referencesChanged: true, skeletonPassedThrough: true },
      note:
        'Loose Spine region PNGs + a MODERN skins-ARRAY skeleton whose attachment paths equal the region '
        + 'stems (incl. nested items/sword). Covers a path override (sword→items/sword), a region shared by '
        + 'two slots (shield — never a collision), a mesh (cape), a linkedmesh resolved via its parent '
        + '(capeLink→cape), and an ignored clipping (mask). Packs into ONE .atlas; verified=6; skeleton '
        + 'passed through untouched. cape.png carries an asymmetric margin so the bottom-left offset (Y-flip) is exercised.',
    },
  };

  writeCase(
    'spine-loose',
    files,
    `# spine-loose

Loose **Spine region PNGs** + a **modern \`skins\`-ARRAY** skeleton (\`skeleton.json\`) for Feature 4
part B — packing a Spine animation's loose regions into page image(s) + a correct libGDX \`.atlas\`.
Each region's folder-relative stem **equals** the skeleton attachment's resolved \`path\` (incl. the
nested \`items/sword\`).

### Verifier matrix (mirrors \`packages/fix/test/spine-verify.ts\` \`modern\`)
- \`head\` — region, no path override → region \`head\`.
- \`sword\` — region **with a \`path\` override** \`items/sword\` (attachment name ≠ region) → \`items/sword\`.
- \`shield\` — one region **shared across two slots** (\`shieldA\`, \`shieldB\`) — legitimate, **never** a collision.
- \`cape\` — a **mesh** attachment → needs region \`cape\`.
- \`capeLink\` — a **linkedmesh** (parent \`cape\`) → inherits region \`cape\` (no path of its own).
- \`mask\` — a **clipping** attachment → needs **no** region; **ignored**.

### Intended outcome (\`expected.json\` is the authored golden)
The folder holding the skeleton is the **spine root**; all loose regions pack into **one** \`.atlas\`
(\`verified = 6\`, no unmatched). \`cape.png\` carries an **asymmetric transparent margin** so the
**bottom-left** Spine \`offset\` (the only Y-flip, in \`trim.ts\`) is exercised — the emitter writes it
verbatim and a re-parse recovers it. Spine sheets default to **PNG**; \`allowRotation\` is always false;
the skeleton \`.json\` is **passed through untouched**. Reference-changing (\`fix.packWarn\`).
`,
  );
}

/* ── Case 12: spine-loose-legacy — SAME skeleton in the LEGACY (skins-OBJECT) form ──
 * Identical regions + identical attachment resolution, but `skins` is the legacy OBJECT shape
 * { skinName: { slot: { att: {...} } } } (≤3.7). Pins the verifier's BOTH-shapes coverage: the same
 * required-region set + verified=6 must hold regardless of the skins wire shape. */
function spineSkeletonLegacy() {
  return {
    skeleton: { hash: 'fixture', spine: '3.7', x: 0, y: 0, width: 100, height: 100 },
    bones: [{ name: 'root' }],
    slots: [
      { name: 'head', bone: 'root', attachment: 'head' },
      { name: 'weapon', bone: 'root', attachment: 'sword' },
      { name: 'shieldA', bone: 'root', attachment: 'shield' },
      { name: 'shieldB', bone: 'root', attachment: 'shield' },
      { name: 'cape', bone: 'root', attachment: 'cape' },
      { name: 'capeLink', bone: 'root', attachment: 'capeLink' },
      { name: 'mask', bone: 'root', attachment: 'mask' },
    ],
    // LEGACY: skins is an OBJECT keyed by skin name → slot → attachment.
    skins: {
      default: {
        head: { head: { type: 'region' } },
        weapon: { sword: { type: 'region', path: 'items/sword' } },
        shieldA: { shield: { type: 'region' } },
        shieldB: { shield: { type: 'region' } },
        cape: { cape: { type: 'mesh', width: 60, height: 80 } },
        capeLink: { capeLink: { type: 'linkedmesh', parent: 'cape', skin: 'default' } },
        mask: { mask: { type: 'clipping', end: 'mask', vertexCount: 4 } },
      },
    },
    animations: { idle: {} },
  };
}

{
  const skel = spineSkeletonLegacy();
  const files = {
    ...spineRegionFiles(),
    'skeleton.json': skel,
    'expected.json': {
      kind: 'pack-spine',
      feature: 'pack-loose-spine',
      skinsShape: 'object-legacy',
      grouping: { mode: 'auto', spineRoot: '(the upload folder)', skeletonRef: 'skeleton.json', regionCount: SPINE_REGIONS.length },
      regions: SPINE_REGIONS.map(spineRegionGolden),
      verification: {
        unverified: false, // legacy OBJECT shape is recognized — NOT a false 0-of-0
        verified: 6,
        unmatched: [],
        ignored: ['mask (clipping → needs no region)'],
        sharedRegion: { region: 'shield', slots: ['shieldA', 'shieldB'], note: 'shared across slots — NOT a collision' },
        pathOverride: { attachment: 'sword', region: 'items/sword' },
        linkedmesh: { attachment: 'capeLink', parent: 'cape', resolvedRegion: 'cape' },
      },
      atlas: { format: 'RGBA8888', filter: 'Linear,Linear', repeat: 'none', pma: false, pages: 1, sort: 'localeCompare' },
      pack: { allowRotation: false, targetMime: 'image/png', referencesChanged: true, skeletonPassedThrough: true },
      note:
        'Same regions + same resolution as spine-loose, but the skeleton uses the LEGACY skins-OBJECT shape '
        + '({ skinName: { slot: { att } } }). Pins the verifier handling BOTH wire shapes: required set + '
        + 'verified=6 are identical to the modern form. A recognized shape → unverified:false (never a false 0-of-0).',
    },
  };

  writeCase(
    'spine-loose-legacy',
    files,
    `# spine-loose-legacy

The **same** Spine regions and the **same** skeleton as \`spine-loose\`, but \`skeleton.json\` uses the
**legacy \`skins\`-OBJECT** form (\`{ skinName: { slot: { att: {...} } } }\`, Spine ≤3.7). Pins the
verifier's **both-shapes** coverage: \`scanSkeleton\` must resolve the identical required-region set and
\`verifySpineSkeleton\` must report \`verified = 6\` regardless of whether \`skins\` is an array (modern)
or an object (legacy). A recognized legacy shape returns \`unverified:false\` — never a false 0-of-0.
`,
  );
}

/* ── Case 13: spine-loose-spill — enough regions + a forced small maxSize → a region lands on page 1 ──
 * Multi-page coverage: many same-size loose regions that cannot fit one POT page at a small maxSize, so
 * the packer spills onto page 1 (image stem.png + stem_1.png; ONE .atlas with N page blocks, each region
 * under ITS page header). The golden documents the forced maxSize + region count and the multi-page
 * invariant (each re-parsed region's frame.xy within its page size; per-page membership), NOT exact
 * placements (the packer owns those). A trivial skeleton (skins array, all region attachments) makes it
 * a spine group whose every attachment path resolves. */
function spineSpillSkeleton(regionNames) {
  const attachments = {};
  for (const n of regionNames) attachments[n] = { [n]: { type: 'region' } };
  return {
    skeleton: { hash: 'fixture', spine: '3.8', width: 256, height: 256 },
    bones: [{ name: 'root' }],
    slots: regionNames.map((n) => ({ name: n, bone: 'root', attachment: n })),
    skins: [{ name: 'default', attachments }],
    animations: { idle: {} },
  };
}

{
  // 12 opaque 64×64 regions. With maxSize 128 a POT page is at most 128×128 = 4 cells (with padding 2,
  // a 64-cell needs 66 → 2 per 128 axis ⇒ ≤4 per page), so 12 regions necessarily SPILL across ≥3 pages.
  const N = 12;
  const REG = 64;
  const regionNames = Array.from({ length: N }, (_, i) => `part_${String(i).padStart(2, '0')}`);
  const files = {};
  for (let i = 0; i < N; i++) files[`${regionNames[i]}.png`] = solidPng(REG, REG, COLORS[i % COLORS.length]);
  files['skeleton.json'] = spineSpillSkeleton(regionNames);
  files['expected.json'] = {
    kind: 'pack-spine',
    feature: 'pack-loose-spine-multipage',
    skinsShape: 'array-modern',
    grouping: { mode: 'auto', spineRoot: '(the upload folder)', skeletonRef: 'skeleton.json', regionCount: N },
    // The FORCED packing knobs that guarantee a spill (the worker/test passes these to the pack op).
    pack: {
      maxSize: 128, // forced small → cannot hold all 12 64² regions on one POT page
      padding: 2,
      allowRotation: false,
      targetMime: 'image/png',
      referencesChanged: true,
    },
    regions: regionNames.map((n) => ({ region: n, sourceSize: { w: REG, h: REG }, size: { w: REG, h: REG }, trimmed: false, rotate: 0 })),
    multipage: {
      // Authored invariants (NOT exact placements — the MaxRects packer owns those):
      minPages: 2, // at least a page 1 exists (a region landed off page 0)
      pageImages: ['stem.png', 'stem_1.png', '...'], // ${stem} for page 0, ${stem}_${i} for i>0
      atlasBlocks: 'ONE .atlas = N page blocks (per-bin emitSpineAtlasText concat); each region under ITS page header',
      invariant: 'every re-parsed region frame.xy is within its page size; pageOfName drives per-page membership',
    },
    verification: { unverified: false, verified: N, unmatched: [] }, // all region attachments resolve
    atlas: { format: 'RGBA8888', filter: 'Linear,Linear', repeat: 'none', pma: false, sort: 'localeCompare' },
    note:
      '12 opaque 64×64 loose regions with a FORCED small maxSize (128) so the packer SPILLS across multiple POT '
      + 'pages. ONE .atlas with N page blocks (each region under its own page header, driven by pageOfName); page '
      + 'images stem.png, stem_1.png, … The golden pins the multi-page invariant (≥2 pages; each region within its '
      + 'page) and verified=N, NOT exact placements (the packer owns those).',
  };

  writeCase(
    'spine-loose-spill',
    files,
    `# spine-loose-spill

Multi-page Spine packing: **12 opaque 64×64** loose regions + a trivial \`skins\`-array skeleton, packed
with a **forced small \`maxSize\` (128)** so they cannot fit one POT page and the packer **spills** onto
page 1+. Proves Feature 4 emits **one \`.atlas\` with N page blocks** (each region under **its own** page
header, driven by \`pageOfName\`) and page images \`stem.png\`, \`stem_1.png\`, … — never all regions under
page 0 (which would resolve spilled regions to the wrong image).

\`expected.json\` pins the multi-page **invariants** (≥2 pages; each re-parsed region's \`frame.xy\` within
its page size; \`verified = N\`), **not** exact placements — the MaxRects packer owns those. \`allowRotation\`
is always false; Spine pages default to PNG.
`,
  );
}

/* ── Case 14: tier-source — inputs for SCALE-TIER export (docs/scale-tiers-design.md §test plan) ──
 * A small mixed folder the scale-tier slice tiers (or refuses to tier):
 *   - banner.png      : an ODD 100×50 loose image — the round-trip subject (scaleLoose 100×50 →
 *                       75×38 (×0.75) → 50×25 (×0.5); independently-rounded aspect, the case that
 *                       breaks the old stem|aspectBucket clustering, so the resolution-stem path must
 *                       re-cluster all three tiers — correction 3).
 *   - sheet.png/.json : a small TP-Hash atlas to TIER (scaleAtlas geometry + per-tier manifest).
 *   - meshed.png/.json: a TP-Hash atlas whose frames carry a Sprite.mesh (vertices/verticesUV/
 *                       triangles) → parses back WITH meshes → tiering is REFUSED (scaleAtlas drops
 *                       mesh; correction 2). Mesh is a CCW corner fan over each frame's bbox;
 *                       verticesUV = vertices + frame.xy per the core coordinate contract.
 *   - spine_single.*  : a SINGLE-page Spine .atlas → tiering ALLOWED (one page, one info.path).
 *   - spine_multi.*   : a TWO-page Spine .atlas (pages spine_multi_0.png + spine_multi_1.png sharing
 *                       one info.path) → tiering SKIPPED in v1 (per-page emit would clobber; correction 4).
 * Pixels are irrelevant to the pure tests (geometry only); they exist so a parse/ingest round-trip is real. */
{
  // (a) loose 100×50 banner — opaque solid; the odd aspect is the whole point.
  const banner = solidPng(100, 50, COLORS[0]);

  // (b) small TP-Hash atlas (sheet) — a few round-number frames, one trimmed for fidelity under scaling.
  const sheetSize = { w: 128, h: 128 };
  const sheetFrames = [
    fr('a.png', 0, 0, 60, 40),
    fr('b.png', 64, 0, 50, 50),
    fr('c.png', 0, 64, 40, 30, { trimmed: true, spriteSourceSize: { x: 5, y: 8, w: 40, h: 30 }, sourceSize: { w: 50, h: 46 } }),
  ];

  // (c) meshed atlas — a CCW corner fan over each frame's bbox. verticesUV = vertices + frame.xy.
  const meshSize = { w: 128, h: 64 };
  const meshFrames = [fr('m0.png', 0, 0, 64, 64), fr('m1.png', 64, 0, 50, 50)];
  /** Corner fan over [0,w)×[0,h): TL→TR→BR→BL, two triangles (CCW under Y-down shoelace). */
  const cornerMesh = (f) => {
    const verts = [{ x: 0, y: 0 }, { x: f.frame.w, y: 0 }, { x: f.frame.w, y: f.frame.h }, { x: 0, y: f.frame.h }];
    return {
      vertices: verts.map((v) => [v.x, v.y]),
      verticesUV: verts.map((v) => [v.x + f.frame.x, v.y + f.frame.y]),
      triangles: [[0, 1, 2], [0, 2, 3]],
    };
  };
  const meshManifest = () => {
    const frameObj = {};
    for (const f of meshFrames) frameObj[f.name] = { ...tpFrameBody(f), ...cornerMesh(f) };
    return { frames: frameObj, meta: { image: 'meshed.png', format: 'RGBA8888', size: meshSize, scale: '1', ...TP_META } };
  };

  // (d) single-page Spine + (e) two-page Spine. The multi-page .atlas has TWO page blocks under ONE
  //     .atlas file (each begins with a bare image line + a non-indented `size:` header).
  const spSize = { w: 64, h: 64 };
  const spFrames = [fr('reg0', 0, 0, 30, 30), fr('reg1', 32, 0, 28, 24)];
  const spinePage = (image, frames) =>
    `${image}\nsize: ${spSize.w},${spSize.h}\nformat: RGBA8888\nfilter: Linear,Linear\nrepeat: none\n` +
    frames
      .map((f) => `${f.name}\n  rotate: 0\n  xy: ${f.frame.x}, ${f.frame.y}\n  size: ${f.frame.w}, ${f.frame.h}\n  orig: ${f.frame.w}, ${f.frame.h}\n  offset: 0, 0\n  index: -1`)
      .join('\n') + '\n';
  const singleAtlas = spinePage('spine_single.png', spFrames);
  // two page blocks concatenated → one .atlas, two pages (the v1 skip case).
  const multiAtlas = spinePage('spine_multi_0.png', [spFrames[0]]) + spinePage('spine_multi_1.png', [spFrames[1]]);

  writeCase(
    'tier-source',
    {
      'banner.png': banner,
      'sheet.png': atlasPng(sheetSize, sheetFrames),
      'sheet.json': hashManifest('sheet.png', sheetSize, sheetFrames),
      'meshed.png': atlasPng(meshSize, meshFrames),
      'meshed.json': meshManifest(),
      'spine_single.atlas': singleAtlas,
      'spine_single.png': atlasPng(spSize, spFrames),
      'spine_multi.atlas': multiAtlas,
      'spine_multi_0.png': atlasPng(spSize, [spFrames[0]]),
      'spine_multi_1.png': atlasPng(spSize, [spFrames[1]]),
      'expected.json': {
        kind: 'tier-source',
        feature: 'scale-tiers',
        loose: { 'banner.png': { size: { w: 100, h: 50 }, tiers: { _1080p: { w: 100, h: 50 }, _720p: { w: 75, h: 38 }, _540p: { w: 50, h: 25 } } } },
        atlas: { sheet: { size: sheetSize, frameCount: sheetFrames.length, tier: 'allowed' } },
        meshed: { size: meshSize, frameCount: meshFrames.length, tier: 'refused', why: 'sprites carry a source mesh; scaleAtlas drops mesh → refuse tiering (correction 2)', expectMeshedSprites: meshFrames.length },
        spine: {
          single: { pages: 1, tier: 'allowed' },
          multi: { pages: 2, tier: 'skipped', why: 'multi-page Spine pages share one info.path; per-page tier emit would clobber → skip in v1 (correction 4)' },
        },
        note: 'Mixed inputs for scale-tier export: an odd loose banner (tier round-trip), a TP atlas (tier), a meshed atlas (refuse), a single-page Spine (tier) and a 2-page Spine (skip).',
      },
    },
    `# tier-source

Mixed inputs for the **SCALE-TIER export** slice (\`docs/scale-tiers-design.md\`).

- **\`banner.png\`** — an odd **100×50** loose image. The whole-folder default ladder produces
  \`_1080p\` 100×50, \`_720p\` 75×38 (×0.75), \`_540p\` 50×25 (×0.5). The independently-rounded aspect
  (round(w/h·50) = 100 vs 99) is exactly the case the resolution-stem clustering must re-cluster into
  ONE group (correction 3 round-trip).
- **\`sheet.png\` / \`sheet.json\`** — a small TexturePacker **Hash** atlas to **tier** (scaleAtlas
  geometry + a per-tier manifest with scaled frames and per-tier \`meta.image\`/\`meta.scale\`).
- **\`meshed.png\` / \`meshed.json\`** — a TP-Hash atlas whose frames carry a \`Sprite.mesh\`
  (vertices/verticesUV/triangles, a CCW corner fan). \`scaleAtlas\` **drops** mesh, so tiering is
  **refused** for any atlas carrying a source mesh (correction 2). The fixture round-trips the mesh
  back through the parser so \`scaleAtlas(meshed, 0.5).sprites[i].mesh === undefined\` is a real assertion.
- **\`spine_single.*\`** — a single-page Spine \`.atlas\` → tiering **allowed**.
- **\`spine_multi.*\`** — a **two-page** \`.atlas\` (pages \`spine_multi_0.png\` + \`spine_multi_1.png\`)
  → tiering **skipped** in v1 (per-page emit would clobber the shared \`info.path\`; correction 4).

Pixels are irrelevant to the pure scale tests (geometry only); they exist so the parse/ingest
round-trip is real.
`,
  );
}

/* ── Case 15: format-classes — content-class format-suitability goldens (docs/improvements/content-class.md) ──
 * Three LOOSE images, one per content class, each with a hand-authored golden `contentClass`. These cross-
 * check `classifyContent` (apps/web/src/lib/perceptual.ts) the same way every other expected.json cross-
 * checks the analysis core: the class is authored HERE, independently of the classifier.
 *
 * The classifier runs on a 9×8 downsample of the decoded RGBA (the dHash sample the worker reuses; Inv 4 —
 * no encode). So the fixtures are drawn on a grid that is an exact multiple of 9×8 (180×160 = 20×20 px
 * cells) and aligned to cell boundaries, so a box-average downsample to 9×8 is deterministic and the class
 * survives the resample:
 *   • flat-fill   — one solid opaque color → grayStdDev ≈ 0 (< FLAT_STD 12) → 'flat'.
 *   • photographic — every 9×8 cell a DISTINCT high-contrast luminance → grayStdDev far above FLAT_STD,
 *                    fully opaque (no alpha poles) → 'photographic'. (A per-cell pattern, not pixel noise,
 *                    so the box-average to 9×8 preserves the inter-cell variance exactly.)
 *   • alpha-art   — a hard cutout: a solid opaque block over the LEFT ~half (cells 0–3 of 9), fully
 *                    transparent over the RIGHT ~half (cells 5–8), one smeared column between → both alpha
 *                    poles populated well past minPole (0.12) ⇒ hasHardAlpha ⇒ 'alpha-art' (checked before
 *                    the flat-variance branch, so an otherwise-flat opaque block with a cutout is alpha-art). */
{
  const GW = 9; // sample-grid columns (matches the dHash 9×8)
  const GH = 8; // sample-grid rows
  const CELL = 20; // px per grid cell → 180×160 source, an exact multiple of 9×8
  const W = GW * CELL; // 180
  const H = GH * CELL; // 160

  // flat-fill: one solid opaque mid color. grayStdDev ≈ 0.
  const flat = solidPng(W, H, [60, 120, 90]);

  // photographic: each 9×8 cell a distinct luminance via a deterministic high-spread ramp. Opaque.
  const photoPng = (() => {
    const png = new PNG({ width: W, height: H });
    png.data.fill(0);
    for (let gy = 0; gy < GH; gy++) {
      for (let gx = 0; gx < GW; gx++) {
        // Spread cell indices across the full 0..255 range with a coprime stride so neighbours differ a lot.
        const idx = gy * GW + gx;
        const v = (idx * 97 + 13) % 256;
        fillRect(png, gx * CELL, gy * CELL, CELL, CELL, [v, (v * 5 + 40) % 256, (v * 11 + 80) % 256]);
      }
    }
    return PNG.sync.write(png);
  })();

  // alpha-art: hard cutout — opaque LEFT block (cols 0–3), transparent RIGHT (cols 5–8), col 4 smeared.
  const alphaPng = (() => {
    const png = new PNG({ width: W, height: H });
    png.data.fill(0); // transparent background = the clear pole
    fillRect(png, 0, 0, 4 * CELL, H, [200, 60, 60]); // 4/9 of width fully opaque (≈44% ≥ minPole)
    // a single half-alpha smear column (col 4) so the edge isn't a perfect step — the histogram test
    // must still see both poles (cols 0–3 opaque, cols 5–8 clear) past minPole.
    for (let y = 0; y < H; y++) {
      for (let x = 4 * CELL; x < 5 * CELL; x++) {
        const i = (W * y + x) << 2;
        png.data[i] = 200;
        png.data[i + 1] = 60;
        png.data[i + 2] = 60;
        png.data[i + 3] = 128; // mid alpha → lands in the ramp band, NOT a pole
      }
    }
    // right half (cols 5–8) stays alpha 0 (the clear pole, ≈44%).
    return PNG.sync.write(png);
  })();

  writeCase(
    'format-classes',
    {
      'flat-fill.png': flat,
      'photographic.png': photoPng,
      'alpha-art.png': alphaPng,
      'expected.json': {
        kind: 'content-classes',
        feature: 'content-class-format-verdict',
        grid: { w: GW, h: GH, cell: CELL },
        // Golden contentClass per image — authored by hand, the independent cross-check of classifyContent.
        images: [
          { name: 'flat-fill.png', w: W, h: H, contentClass: 'flat', why: 'one solid opaque color → grayStdDev ≈ 0 < FLAT_STD (12)' },
          { name: 'photographic.png', w: W, h: H, contentClass: 'photographic', why: 'distinct luminance per 9×8 cell → grayStdDev far above FLAT_STD, opaque (no alpha poles)' },
          { name: 'alpha-art.png', w: W, h: H, contentClass: 'alpha-art', why: 'hard cutout: ≈44% opaque + ≈44% clear → both alpha poles past minPole (0.12), checked before the flat branch' },
        ],
        note:
          'Three loose images, one per content class, for the lossy-vs-lossless format verdict. Drawn on a '
          + '9×8-aligned grid so a box-average downsample to the dHash sample is deterministic and the class '
          + 'survives the resample. flat/alpha-art ⇒ messageKey:format-lossless (rule stays format); '
          + 'photographic ⇒ today\'s lossy verdict.',
      },
    },
    `# format-classes

Three **loose** images, one per **content class**, for the content-class format-suitability verdict
(\`docs/improvements/content-class.md\`). Each carries a hand-authored golden \`contentClass\` in
\`expected.json\` — the independent cross-check of \`classifyContent\` (the classifier runs on the **9×8
dHash sample** the worker already decodes; Invariant 4 — no encode).

The images are drawn on a grid that is an exact multiple of **9×8** (180×160, 20px cells) and aligned to
cell boundaries, so a box-average downsample to 9×8 is deterministic and the class survives the resample:

- **\`flat-fill.png\`** — one solid opaque color → \`grayStdDev\` ≈ 0 (below \`FLAT_STD\` = 12) → **flat**.
- **\`photographic.png\`** — every 9×8 cell a distinct high-contrast luminance → \`grayStdDev\` far above
  \`FLAT_STD\`, fully opaque (no alpha poles) → **photographic**. A per-cell pattern (not pixel noise) so the
  box-average preserves the inter-cell variance.
- **\`alpha-art.png\`** — a **hard cutout**: a solid opaque block over the left ~half, fully transparent over
  the right ~half (one mid-alpha smear column between) → both alpha poles populated past \`minPole\` (0.12)
  ⇒ \`hasHardAlpha\` ⇒ **alpha-art** (checked before the flat-variance branch).

flat / alpha-art ⇒ \`messageKey:'format-lossless'\` (rule stays \`format\`); photographic ⇒ today's lossy
verdict (gradients are deliberately out of the confident set, M2).
`,
  );
}

/* ── Case 16: solid-fill — single-color loose-image detector goldens (docs/improvements/round6-f2-solid-fill.md) ──
 * Two LOOSE images cross-checking `isSolidColor` (apps/web/src/lib/perceptual.ts) the same way Case 15
 * cross-checks `classifyContent`: the solid verdict is authored HERE, independently of the detector.
 *
 * `isSolidColor` runs on the 9×8 downsample of the decoded RGBA (the dHash sample the worker reuses;
 * Inv 4 — no encode). The cross-check reproduces that sample via the SAME box-average sample9x8 the
 * Case-15 test uses. So both fixtures are drawn on a 9×8-aligned grid (576×512, 64px cells):
 *   • plate.png  — one solid opaque color across the whole image → every per-channel stdDev ≈ 0 → solid.
 *   • framed.png — solid center color B with a THICK 64px perimeter color A (one full ring of edge cells).
 *                  Box-averaging keeps the perimeter cells = A and interior cells = B (the 64px ring fully
 *                  fills the outer 9×8 cells — NOT a thin 1px border that would average out), so the A↔B
 *                  delta is present at sample resolution → NOT solid, deterministically.
 * README documents the limitation: features below one 9×8 cell (e.g. a 1px border) are sub-sample and
 * average away — only ≥1-cell-thick structure is detectable. */
{
  const GW = 9; // sample-grid columns (matches the dHash 9×8)
  const GH = 8; // sample-grid rows
  const CELL = 64; // px per grid cell → 576×512, an exact multiple of 9×8; the frame is exactly one cell thick
  const W = GW * CELL; // 576
  const H = GH * CELL; // 512

  const PLATE_COLOR = [40, 110, 170]; // the single solid color
  const FRAME_COLOR = [220, 60, 60]; // perimeter color A (full A↔B delta vs the center)
  const CENTER_COLOR = [40, 110, 170]; // interior color B

  // plate: one solid opaque color, edge to edge → solid.
  const plate = solidPng(W, H, PLATE_COLOR);

  // framed: 64px (one full cell) perimeter of A around a solid B center → NOT solid (edge cells differ
  // from interior cells by the full A↔B delta after the box-average downsample).
  const framed = (() => {
    const png = new PNG({ width: W, height: H });
    fillRect(png, 0, 0, W, H, FRAME_COLOR); // whole image = frame color
    fillRect(png, CELL, CELL, W - 2 * CELL, H - 2 * CELL, CENTER_COLOR); // inset center = center color
    return PNG.sync.write(png);
  })();

  writeCase(
    'solid-fill',
    {
      'plate.png': plate,
      'framed.png': framed,
      'expected.json': {
        kind: 'solid-fill',
        feature: 'solid-fill-loose-detector',
        grid: { w: GW, h: GH, cell: CELL },
        // Golden `solid` per image — authored by hand, the independent cross-check of isSolidColor.
        images: [
          { name: 'plate.png', w: W, h: H, solid: true, why: 'one solid opaque color edge to edge → every per-channel stdDev ≈ 0 < SOLID_STD (2)' },
          { name: 'framed.png', w: W, h: H, solid: false, why: 'solid center with a 64px (one full 9×8 cell) perimeter of a different color → edge cells differ from interior by the full delta after box-average → above SOLID_STD' },
        ],
        note:
          'Two loose images for the single-color (solid-fill) detector. Drawn on a 9×8-aligned grid so a '
          + 'box-average downsample to the dHash sample is deterministic and the verdict survives the resample. '
          + 'plate ⇒ solid (rule solid-fill, vramBytesSaved = w·h·4 − 4); framed ⇒ not solid. Features below one '
          + '9×8 cell (e.g. a 1px border) are sub-sample and average away — only ≥1-cell-thick structure is detectable.',
      },
    },
    `# solid-fill

Two **loose** images for the single-color (**solid-fill**) detector
(\`docs/improvements/round6-f2-solid-fill.md\`). Each carries a hand-authored golden \`solid\` flag in
\`expected.json\` — the independent cross-check of \`isSolidColor\` (the detector runs on the **9×8 dHash
sample** the worker already decodes; Invariant 4 — no encode).

Both are drawn on a grid that is an exact multiple of **9×8** (576×512, 64px cells), so a box-average
downsample to 9×8 is deterministic and the verdict survives the resample:

- **\`plate.png\`** — one solid opaque color edge to edge → every per-channel stdDev ≈ 0 (below
  \`SOLID_STD\` = 2) → **solid**. A 576×512 solid PNG pins ≈1.2 MB of VRAM to carry one color.
- **\`framed.png\`** — a solid center with a **thick 64px** perimeter (exactly one 9×8 cell) of a
  different color → the outer ring of sample cells reads color A, the interior reads color B, so the
  full A↔B delta survives the box-average → **not solid**.

**Limitation (by design):** a feature thinner than one 9×8 cell (e.g. a 1px border) is below the sample
resolution — it box-averages into the surrounding cell and the image reads as solid. Only structure at
least one cell thick is detectable. (That is why the negative control uses a 64px frame, not a 1px one.)
`,
  );
}

/* ── Case 17: unparsed-corrupt — honestly-surfaced unparseable manifests (docs/improvements/round6-f3-unparsed-surface.md) ──
 * The diagnosis used to silently DROP would-be assets it couldn't parse. This folder mixes ONE good loose
 * image with the two deterministic ingest skip-points so the regression test can assert both:
 *   • good.png      — a valid loose image → a real asset survives (the notice never replaces the report).
 *   • broken.json   — invalid JSON text → JSON.parse throws → unparsed "manifest JSON parse failed: …".
 *   • noimage.json  — valid JSON, has `frames` (so it LOOKS like a manifest) but no `meta.image` →
 *                     unparsed "manifest has frames but no meta.image".
 * A bare `notes.txt` / a non-manifest `config.json` (no frames) stay SILENT by design — flagging a benign
 * non-asset file would be its own dishonesty (Invariant 3). expected.unparsed is authored here by hand. */
{
  const good = solidPng(64, 64, [38, 139, 210]); // a valid loose image — survives parsing
  // A frames-bearing manifest with NO meta.image (looks like a manifest, unusable).
  const noImageManifest = {
    frames: { 'a.png': tpFrameBody(fr('a.png', 0, 0, 32, 32)) },
    meta: { size: { w: 64, h: 64 } }, // deliberately no `image`
  };
  // A legitimate non-manifest JSON (no frames) — MUST stay silent (not surfaced).
  const config = { name: 'level-1', tiles: [1, 2, 3] };

  writeCase(
    'unparsed-corrupt',
    {
      'good.png': good,
      'broken.json': '{ "frames": { "a.png": { "frame": { "x": 0, "y": 0, ', // truncated → JSON.parse fails
      'noimage.json': noImageManifest,
      'config.json': config,
      'notes.txt': 'just a readme, not an asset\n',
      'expected.json': {
        kind: 'unparsed-surface',
        feature: 'unparsed-honest-surface',
        // The good asset the diagnosis still produces.
        assets: ['good.png'],
        // Surfaced honestly (sorted by ref). Reasons stay English (parser strings).
        unparsed: [
          { ref: 'broken.json', reasonStartsWith: 'manifest JSON parse failed:' },
          { ref: 'noimage.json', reason: 'manifest has frames but no meta.image' },
        ],
        // Deliberately NOT surfaced (benign non-asset files).
        silent: ['config.json', 'notes.txt'],
        note:
          'One good loose image plus the two deterministic ingest skip-points. The diagnosis surfaces the '
          + 'unusable would-be manifests (broken JSON; frames but no meta.image) and stays SILENT on benign '
          + 'non-asset files (a non-manifest config.json; a notes.txt) — symmetric with the fix engine\'s '
          + 'skipped[], never flagging a file that is legitimately not an asset (Invariant 3).',
      },
    },
    `# unparsed-corrupt

A folder that mixes one **good** loose image with the two deterministic **ingest skip-points**, to prove the
diagnosis surfaces unparseable would-be assets HONESTLY instead of silently dropping them
(\`docs/improvements/round6-f3-unparsed-surface.md\`) — symmetric with the fix engine's \`skipped[]\`.

- **\`good.png\`** — a valid 64×64 loose image → a real asset survives (the notice never replaces the report).
- **\`broken.json\`** — truncated/invalid JSON → \`JSON.parse\` throws → surfaced
  \`manifest JSON parse failed: …\`.
- **\`noimage.json\`** — valid JSON with \`frames\` (so it *looks* like a manifest) but no \`meta.image\` →
  surfaced \`manifest has frames but no meta.image\`.
- **\`config.json\`** (no \`frames\`) and **\`notes.txt\`** — legitimately **not** assets → stay **silent**
  (flagging a benign non-asset file would be its own dishonesty, Invariant 3).

\`expected.json\` pins the good asset, the sorted \`unparsed\` surface (reasons stay English — parser strings,
same precedent as \`fix.skipped\`), and the files that must NOT be surfaced.
`,
  );
}

/* ── Case 18: wasted-alpha — fully-opaque-with-alpha-channel detector goldens (docs/improvements/round15-wasted-alpha-detector-full-frame-opaque-.md) ──
 * Two LOOSE PNGs cross-checking `alphaFullyOpaque` (apps/web/src/lib/perceptual.ts). UNLIKE the solid-fill /
 * content-class fixtures (which run on the 9×8 box-average sample), the wasted-alpha detector runs on the
 * FULL-RESOLUTION decode — one transparent pixel must NOT average away. So the golden `opaque` flag is
 * authored over the full-res RGBA here, and the test reads the full-res PNG directly (no downsample):
 *   • opaque.png      — a solid OPAQUE fill: every pixel alpha 255 → the alpha channel is dead → opaque:true.
 *   • transparent.png — an opaque inner bbox with a fully-TRANSPARENT 32px margin (one corner clear) → at
 *                       least one alpha-0 pixel → the channel is in use → opaque:false. The single-pixel
 *                       short-circuit guarantees the margin is enough; the thick margin just keeps it
 *                       human-verifiable.
 * The DISK cost of the dead channel is MEASURED at analysis time by an opaque re-encode (worker
 * makeOpaqueEncoder); the finding reports diskBytesSaved ONLY — never VRAM (invariant 5: the GPU still
 * decodes to RGBA8888). README documents that the saving is disk-only and the VERDICT is the diagnosis;
 * the opaque re-encode itself is the Pro fix's job (generation — invariant 3). */
{
  const W = 256;
  const H = 256;
  const COLOR = [40, 110, 170];

  const opaque = solidPng(W, H, COLOR); // every pixel alpha 255 → dead alpha channel
  // opaque 192×192 content with a fully-transparent 32px margin (corner cells alpha 0) → channel in use
  const transparent = marginPng(W, H, 32, 32, W - 64, H - 64, COLOR);

  writeCase(
    'wasted-alpha',
    {
      'opaque.png': opaque,
      'transparent.png': transparent,
      'expected.json': {
        kind: 'wasted-alpha',
        feature: 'wasted-alpha-loose-detector',
        // Golden `opaque` per image — authored by hand over the FULL-RESOLUTION RGBA, the independent
        // cross-check of alphaFullyOpaque (which runs full-frame, NOT on the 9×8 sample).
        images: [
          { name: 'opaque.png', w: W, h: H, opaque: true, why: 'solid opaque fill → every pixel alpha 255 → the alpha channel is dead weight on disk' },
          { name: 'transparent.png', w: W, h: H, opaque: false, why: 'opaque 192×192 content with a fully-transparent 32px margin → at least one alpha-0 pixel → the channel is in use' },
        ],
        note:
          'Two loose PNGs for the wasted-alpha (fully-opaque-with-alpha-channel) detector. Read at FULL '
          + 'resolution (NOT the 9×8 sample — one transparent pixel must not average away). opaque ⇒ opaque:true '
          + '(rule wasted-alpha; diskBytesSaved = byteSize − opaque-re-encode bytes, MEASURED; NO vramBytesSaved, '
          + 'invariant 5); transparent ⇒ opaque:false. The disk saving is DOWNLOAD-only — the GPU still decodes '
          + 'to RGBA8888 and allocates the same VRAM. The opaque re-encode is the Pro fix\'s job (invariant 3).',
      },
    },
    `# wasted-alpha

Two **loose** PNGs for the **wasted-alpha** detector — a fully-opaque image still carrying an alpha channel
(\`docs/improvements/round15-wasted-alpha-detector-full-frame-opaque-.md\`). Each carries a hand-authored
golden \`opaque\` flag in \`expected.json\` — the independent cross-check of \`alphaFullyOpaque\`.

**Unlike** the solid-fill / content-class fixtures, this detector runs on the **full-resolution** decode
(a single transparent pixel must NOT box-average away), so the golden is authored over the full-res RGBA and
the test reads the PNG directly (no 9×8 downsample):

- **\`opaque.png\`** — a solid opaque 256×256 fill → every pixel alpha 255 → the alpha channel is **dead
  weight on disk** → \`opaque:true\`. The MEASURED disk cost (re-encode opaque, same format) is the finding's
  \`diskBytesSaved\`.
- **\`transparent.png\`** — opaque 192×192 content with a fully-transparent **32px margin** → at least one
  alpha-0 pixel → the channel is **in use** → \`opaque:false\`.

**Honesty (invariant 5):** dropping the dead channel is a **download/disk** saving only — the GPU still
decodes to RGBA8888 and allocates the same VRAM. The finding reports \`diskBytesSaved\` and **never** a VRAM
win. The diagnosis MEASURES (opaque or not) and reports the byte cost; the opaque re-encode itself is the
**Pro fix's** job (generation — invariant 3).
`,
  );
}

/* ── Case 19: frame-redundant — within-atlas duplicate-frame detector golden (docs/improvements/round18-animation-frame-redundancy-detector-.md) ──
 * ONE atlas whose frames have BYTE-IDENTICAL pixel regions — wasted duplicate frames. The within-atlas
 * frame-redundancy detector hashes each sprite's REGION off the already-decoded page (worker hashAtlasFrames)
 * and clusters identical regions; the recoverable atlas AREA → VRAM (a repack drops the dupes), and a
 * separate area-proportional DISK estimate (invariant 5 — the two are never conflated).
 *
 * An 8-frame strip on a 256×64 sheet (8 × 32×32 cells in a row). Four frames (idle_0..3) carry the SAME
 * solid color → identical 32×32 regions → ONE cluster of 4 (3 recoverable beyond the kept one); the other
 * four carry distinct colors → no cluster. So the golden cluster reaches minDuplicates (3) and fires WARN.
 * The golden frame hashes are NOT authored here (they depend on PNG encoding); instead the regression test
 * hand-supplies deterministic region hashes (the 4 idle frames share one hash, the rest distinct) so the
 * pure rule is exercised canvas-free, matching expected.json's documented cluster. */
{
  const CELL = 32;
  const N = 8;
  const size = { w: CELL * N, h: CELL }; // 256×32 strip — one row of 8 cells
  // The four redundant idle frames share ONE textured pattern (a 2-color checker). TEXTURED — not a solid
  // fill — so the production flat-guard (box-average to 9×8 → grayStdDev ≥ 6) does NOT null them, yet they
  // are byte-for-byte identical regions ⇒ they cluster by SHA through the REAL worker decode path. (The old
  // fixture used a SINGLE solid color, which isFlat skips → the finding never fired in the real worker.)
  const DUP_A = [42, 161, 152];
  const DUP_B = [16, 32, 42]; // film-dark — high luma contrast with DUP_A so the 9×8 average stays textured
  // idle_0..3 share the SAME checker (identical regions); walk_0..3 each get a DISTINCT (still textured) one.
  const frames = [];
  for (let i = 0; i < 4; i++) frames.push(fr(`idle_${i}`, i * CELL, 0, CELL, CELL));
  for (let i = 0; i < 4; i++) frames.push(fr(`walk_${i}`, (4 + i) * CELL, 0, CELL, CELL));

  const png = new PNG({ width: size.w, height: size.h });
  png.data.fill(0);
  frames.forEach((f, i) => {
    if (i < 4) {
      fillChecker(png, f.frame.x, f.frame.y, f.frame.w, f.frame.h, DUP_A, DUP_B); // identical idle pattern
    } else {
      // Distinct textured walk frame: a checker of a bright palette color against film-dark, so the 9×8
      // box-average keeps HIGH luma contrast (clears the flat-guard) AND each frame hashes to a unique value
      // (distinct bright color per frame ⇒ no false cluster with idle or with each other).
      const bright = COLORS[(i - 4) % COLORS.length];
      const dark = [16, 32, 42]; // film-dark — low luma so every walk pair stays well above the flat threshold
      fillChecker(png, f.frame.x, f.frame.y, f.frame.w, f.frame.h, bright, dark);
    }
  });
  const sheet = PNG.sync.write(png);

  writeCase(
    'frame-redundant',
    {
      'anim.png': sheet,
      'anim.json': hashManifest('anim.png', size, frames),
      'expected.json': {
        kind: 'frame-redundancy',
        feature: 'within-atlas-duplicate-frames',
        atlas: { w: size.w, h: size.h },
        // The redundant cluster — the 4 idle frames share one TEXTURED 32×32 region (a checker, not a solid
        // fill: solid regions are nulled by the production flat-guard and would never cluster).
        duplicateCluster: ['idle_0', 'idle_1', 'idle_2', 'idle_3'],
        minDuplicates: 3,
        // Recoverable beyond the one representative kept: 3 frames × 32×32 = 3072px → ×4 = 12288 bytes VRAM.
        recoverableArea: 3 * CELL * CELL,
        vramBytesSaved: 3 * CELL * CELL * 4,
        findings: [{ rule: 'frame-redundancy', severity: 'warn' }],
        note:
          'One atlas whose four idle_* frames are TEXTURED (a 2-color checker) and byte-identical 32×32 pixel '
          + 'regions (a wasted duplicate animation set), plus four distinct textured walk_* frames. The frames '
          + 'are textured — NOT a single solid color — so they clear the production flat-guard (box-average to '
          + '9×8 → grayStdDev ≥ 6) and the within-atlas frame-redundancy detector clusters them off the REAL '
          + 'decoded page (worker hashAtlasFrames / pure extractFrameRegions): 4 idle frames → 3 recoverable '
          + 'beyond the kept one. Recoverable atlas AREA → VRAM (vramBytesSaved, exact); the disk number is an '
          + 'area-proportional ESTIMATE, never conflated (invariant 5). The detector MEASURES the duplicate set '
          + '+ wasted bytes; de-duplicating the frames is the Pro fix\'s job (generation — invariant 3).',
      },
    },
    `# frame-redundant

ONE atlas with **within-atlas duplicate frames** for the **frame-redundancy** detector
(\`docs/improvements/round18-animation-frame-redundancy-detector-.md\`).

A 256×32 strip of **8 frames** (32×32 each). Every frame is **textured** (a 2-color checker), not a single
solid fill — solid regions are nulled by the production flat-guard and would never cluster:

- **\`idle_0\`–\`idle_3\`** — the SAME checker pattern → **byte-identical 32×32 pixel regions** → one cluster
  of 4 (≥ \`minDuplicates\` = 3). **3 frames are recoverable** beyond the one representative kept.
- **\`walk_0\`–\`walk_3\`** — each a distinct checker → not redundant (but still textured, so each is hashed).

The detector hashes each sprite's **region** off the already-decoded page (worker \`hashAtlasFrames\` →
pure \`extractFrameRegions\`) and clusters identical regions. It **MEASURES** the duplicate set + wasted bytes:

- **VRAM** — the recoverable distinct-rect area × 4 (here 3 × 32×32 × 4 = **12 288 B**), the atlas space the
  duplicates pin that a de-duplicated repack reclaims. Exact area arithmetic.
- **DISK** — an **area-proportional estimate** only (no per-region disk bytes exist), carried separately and
  **never** conflated with VRAM (invariant 5).

De-duplicating the frames is the **Pro fix's** job (generation — invariant 3). The regression test feeds this
PNG through the REAL hashing path (decode → pure \`extractFrameRegions\` → SHA) and asserts the cluster fires —
the duplicate frames are textured-but-identical precisely so the production flat-guard does NOT skip them.
`,
  );
}

/* ── Case 19b: cross-atlas-redundant — folder-scope cross-atlas frame-redundancy DETECTOR golden ──
 * (docs/improvements/round22-cross-atlas-frame-redundancy-detec.md)
 * TWO atlases that each pack the SAME byte-identical textured frame (`shared`) plus a distinct frame. The
 * folder-scope cross-atlas-redundancy detector clusters the SAME region hashes the within-atlas rule consumes
 * per-atlas (here folder-wide) and fires ONLY when a cluster spans ≥2 atlases. It MEASURES the cross-sheet
 * duplicate set + recoverable AREA → VRAM (referencing one shared copy reclaims the DUPLICATE-FRAME area —
 * orthogonal to atlas-merge's empty-space win), plus a separate area-proportional DISK estimate (invariant 5).
 *
 * Each sheet is a 64×32 strip of TWO 32×32 cells. `shared` carries the SAME 2-color checker on BOTH sheets →
 * byte-identical 32×32 regions → ONE cluster spanning 2 sheets → 1 recoverable copy (≥ minDuplicates = 2 distinct
 * cross-sheet copies). The frames are TEXTURED (not a single solid fill) so the production flat-guard does NOT
 * null them — the cluster fires through the REAL decode path (worker hashAtlasFrames / pure extractFrameRegions
 * → SHA), reproduced end-to-end in apps/web/src/lib/perceptual.test.ts. DIAGNOSIS-ONLY (the cross-atlas FIX is
 * a separate piece; invariant 3 — we generate nothing). */
{
  const CELL = 32;
  const size = { w: CELL * 2, h: CELL }; // 64×32 strip — one row of 2 cells per sheet
  // The shared (duplicate) frame: ONE textured 2-color checker, byte-for-byte identical on BOTH sheets ⇒ the
  // cross-atlas cluster forms by SHA through the real decode path (NOT a solid fill the flat-guard would null).
  const DUP_A = [42, 161, 152];
  const DUP_B = [16, 32, 42]; // film-dark — high luma contrast so the 9×8 box-average stays textured

  // Build one 64×32 sheet: cell 0 = the shared checker; cell 1 = a DISTINCT textured checker (per-sheet color).
  function buildSheet(distinctColor) {
    const png = new PNG({ width: size.w, height: size.h });
    png.data.fill(0);
    fillChecker(png, 0, 0, CELL, CELL, DUP_A, DUP_B); // cell 0 — the shared (duplicate) frame, identical on both
    fillChecker(png, CELL, 0, CELL, CELL, distinctColor, [16, 32, 42]); // cell 1 — distinct per sheet
    return PNG.sync.write(png);
  }
  const framesA = [fr('shared', 0, 0, CELL, CELL), fr('a_only', CELL, 0, CELL, CELL)];
  const framesB = [fr('shared', 0, 0, CELL, CELL), fr('b_only', CELL, 0, CELL, CELL)];
  const sheetA = buildSheet(COLORS[0]); // a_only is a blue checker
  const sheetB = buildSheet(COLORS[1]); // b_only is an orange checker → distinct from a_only AND from shared

  const CELL_AREA = CELL * CELL; // 1024
  writeCase(
    'cross-atlas-redundant',
    {
      'sheetA.png': sheetA,
      'sheetA.json': hashManifest('sheetA.png', size, framesA),
      'sheetB.png': sheetB,
      'sheetB.json': hashManifest('sheetB.png', size, framesB),
      'expected.json': {
        kind: 'cross-atlas-redundancy',
        feature: 'cross-atlas-duplicate-frames',
        atlases: [
          { name: 'sheetA.png', w: size.w, h: size.h },
          { name: 'sheetB.png', w: size.w, h: size.h },
        ],
        // The shared frame is packed on BOTH sheets — a cross-sheet duplicate cluster of 2 copies.
        duplicateCluster: ['sheetA.png:shared', 'sheetB.png:shared'],
        sheets: 2,
        minDuplicates: 2,
        // 2 distinct cross-sheet copies → 1 recoverable beyond the one representative kept: 1 × 32×32 = 1024px.
        dupes: 1,
        groups: 1,
        recoverableArea: CELL_AREA,
        vramBytesSaved: CELL_AREA * 4, // EXACT duplicate-region area × 4 (no bin-tier / POT inflation)
        findings: [{ rule: 'cross-atlas-redundancy', severity: 'warn' }],
        note:
          'Two atlases (sheetA, sheetB) that each pack the SAME byte-identical TEXTURED frame (`shared`, a 2-color '
          + 'checker) plus a distinct per-sheet frame. The shared frame forms a cross-atlas cluster spanning 2 '
          + 'sheets → 1 recoverable copy beyond the one kept. The frames are textured — NOT a single solid color — '
          + 'so they clear the production flat-guard (box-average to 9×8 → grayStdDev ≥ 6) and the folder-scope '
          + 'cross-atlas-redundancy detector clusters them off the REAL decoded page (worker hashAtlasFrames / pure '
          + 'extractFrameRegions). Recoverable DUPLICATE-FRAME AREA → VRAM (vramBytesSaved, EXACT area × 4 — '
          + 'identical precedent to within-atlas frame-redundancy, NO bin-tier delta so it never over-claims, '
          + 'invariant 5); the disk number is an area-proportional ESTIMATE, never conflated (invariant 5). '
          + 'ORTHOGONAL to atlas-merge (which reclaims EMPTY space — different px). The detector MEASURES the '
          + 'cross-sheet duplicate set; the cross-atlas FIX is a separate piece (generation — invariant 3).',
      },
    },
    `# cross-atlas-redundant

TWO atlases sharing a **byte-identical frame** for the folder-scope **cross-atlas-redundancy** detector
(\`docs/improvements/round22-cross-atlas-frame-redundancy-detec.md\`).

Each sheet (\`sheetA.png\`, \`sheetB.png\`) is a 64×32 strip of **2 frames** (32×32 each). Every frame is
**textured** (a 2-color checker), not a single solid fill — solid regions are nulled by the production
flat-guard and would never cluster:

- **\`shared\`** — the SAME checker pattern on **both** sheets → **byte-identical 32×32 pixel regions** → one
  cross-atlas cluster spanning **2 sheets** (≥ \`minDuplicates\` = 2 cross-sheet copies). **1 copy is recoverable**
  beyond the one representative kept.
- **\`a_only\` / \`b_only\`** — a distinct checker per sheet → not redundant (but still textured, so each is hashed).

The detector clusters the SAME region hashes the within-atlas \`frame-redundancy\` rule consumes (here
folder-wide, off the already-decoded page) and fires ONLY when a cluster spans **≥2 atlases**. It **MEASURES**
the cross-sheet duplicate set + wasted bytes:

- **VRAM** — the recoverable distinct-rect area × 4 (here 1 × 32×32 × 4 = **4 096 B**), the **duplicate-frame**
  area that referencing one shared copy reclaims. EXACT area arithmetic — identical precedent to within-atlas
  frame-redundancy, **no** POT-tier bin gate / packer (a real MaxRects pack lands on a larger bin than any area
  floor, so a bin-tier delta would over-claim — invariant 5). **Orthogonal to atlas-merge** (which reclaims
  EMPTY space — different pixels).
- **DISK** — an **area-proportional estimate** only (no per-region disk bytes exist), attributed to each freed
  copy's own atlas, carried separately and **never** conflated with VRAM (invariant 5).

The cross-atlas FIX is a separate piece (generation — invariant 3). The regression test feeds both PNGs through
the REAL hashing path (decode → pure \`extractFrameRegions\` → SHA → \`crossAtlasRedundancyFinding\`) and asserts
the cluster fires — the shared frame is textured-but-identical precisely so the flat-guard does NOT skip it.
`,
  );
}

/* ── Case 20: untrimmed-padding — within-atlas trim-margin detector golden (docs/improvements/round19-trim-margin-detector.md) ──
 * ONE atlas of UNtrimmed sprites that each carry a transparent margin around their opaque art. The
 * trim-margin detector computes each sprite's OPAQUE bbox from the already-decoded page (worker alphaBBox,
 * the SAME decode pass as frame-redundancy) and sums (frame area − bbox area) over UNtrimmed sprites; the
 * recoverable atlas AREA → VRAM (a trimmed repack tightens each frame), plus a separate area-proportional
 * DISK estimate (invariant 5 — never conflated).
 *
 * Layout: a 256×256 sheet, 4 frames laid out in a row of 64×64 cells (the rest of the sheet empty). Three
 * are UNtrimmed with a transparent margin (opaque core inset inside a 64×64 frame, trimmed:false, NO
 * spriteSourceSize); one is ALREADY trimmed (carries spriteSourceSize) and MUST be skipped by the detector.
 * The opaque cores are TEXTURED (a 2-color checker) so the fixture is realistic; the trim detector reads
 * alpha, not luma, so the texture is irrelevant to the bbox but keeps the art honest. */
{
  const size = { w: 256, h: 256 };
  const CELL = 64;
  // name, frame xy, opaque core inset (mx,my) + size (bw,bh) RELATIVE to the frame, trimmed?
  // padded_0/1/2 are untrimmed with margins; trimmed_0 is already trimmed (skipped by the detector).
  const specs = [
    { name: 'padded_0', fx: 0, fy: 0, mx: 16, my: 16, bw: 32, bh: 32, trimmed: false }, // 16px all sides
    { name: 'padded_1', fx: 64, fy: 0, mx: 12, my: 8, bw: 40, bh: 44, trimmed: false }, // asymmetric margin
    { name: 'padded_2', fx: 128, fy: 0, mx: 8, my: 8, bw: 48, bh: 48, trimmed: false }, // 8px all sides
    // Already-trimmed sprite: its FRAME (40×48 placed) is the tight opaque region; sourceSize is the larger
    // original. The detector skips it (it carries spriteSourceSize) — a NO-double-count negative golden.
    { name: 'trimmed_0', fx: 192, fy: 0, mx: 0, my: 0, bw: 40, bh: 48, trimmed: true },
  ];
  const DUP_A = [42, 161, 152];
  const DUP_B = [16, 32, 42];

  const png = new PNG({ width: size.w, height: size.h });
  png.data.fill(0); // transparent background = the margins
  for (const s of specs) {
    // Paint only the opaque core (textured checker) inside the frame; the rest of the frame stays transparent.
    fillChecker(png, s.fx + s.mx, s.fy + s.my, s.bw, s.bh, DUP_A, DUP_B);
  }
  const sheet = PNG.sync.write(png);

  // Authoring helper: a sprite frame body. Untrimmed → frame == full image (64×64), no spriteSourceSize.
  // Trimmed → frame is the tight rect, spriteSourceSize records the inset within the larger sourceSize.
  const frameOf = (s) =>
    s.trimmed
      ? {
          name: s.name,
          frame: { x: s.fx, y: s.fy, w: s.bw, h: s.bh },
          rotated: false,
          trimmed: true,
          spriteSourceSize: { x: 4, y: 4, w: s.bw, h: s.bh },
          sourceSize: { w: s.bw + 8, h: s.bh + 8 },
        }
      : {
          name: s.name,
          frame: { x: s.fx, y: s.fy, w: CELL, h: CELL },
          rotated: false,
          trimmed: false,
          sourceSize: { w: CELL, h: CELL },
        };
  const frames = specs.map(frameOf);

  // expected.json (authored HERE, independent of @asset-doctor/analysis): each region's opaque bbox RELATIVE
  // to its frame (top-left), and the summed recoverable margin over the UNtrimmed sprites only.
  const regions = specs.map((s) => ({
    name: s.name,
    frame: s.trimmed ? { x: s.fx, y: s.fy, w: s.bw, h: s.bh } : { x: s.fx, y: s.fy, w: CELL, h: CELL },
    // The opaque bbox the worker's alphaBBox recovers, RELATIVE to the frame. Trimmed → frame IS the opaque
    // region (bbox covers the whole frame) but the detector skips it via spriteSourceSize regardless.
    bbox: s.trimmed ? { x: 0, y: 0, w: s.bw, h: s.bh } : { x: s.mx, y: s.my, w: s.bw, h: s.bh },
    trimmed: s.trimmed,
  }));
  // Recoverable = Σ over UNtrimmed sprites of (frame area − opaque bbox area).
  const recoverableArea = specs
    .filter((s) => !s.trimmed)
    .reduce((sum, s) => sum + (CELL * CELL - s.bw * s.bh), 0);

  // Trim-on-repack (round20) golden: DERIVED from the same specs[] that build the regions above — the Pro
  // fix feeds the per-frame opaque bboxes into repackAtlases({trim}), tightening each UNtrimmed sprite to
  // its bbox. trimmedSprites/trimmedAreaReclaimed/perSprite are computed, never hand-copied, so the
  // generator output stays byte-identical to the committed golden (idempotent).
  const untrimmedSpecs = specs.filter((s) => !s.trimmed);
  const repack = {
    note:
      'Trim-on-repack (round20) golden: feeding the per-frame opaque bboxes into repackAtlases({trim}) '
      + 'tightens every UNtrimmed sprite to its bbox extent and emits trimmed:true + sourceSize(full) + '
      + 'spriteSourceSize(=bbox, TP top-left). The already-trimmed trimmed_0 is copied verbatim. '
      + 'trimmedAreaReclaimed === Σ(frame−bbox) === the detector\'s recoverableArea (every shrinkable sprite '
      + 'here also clears minMarginPx), but the FIX measures it directly (B1: reclaimed N px, never the '
      + 'detector\'s N).',
    trimmedSprites: untrimmedSpecs.length,
    trimmedAreaReclaimed: recoverableArea, // identical Σ to the detector's recoverableArea for THIS fixture
    perSprite: untrimmedSpecs.map((s) => ({
      name: s.name,
      packedSize: { w: s.bw, h: s.bh },
      sourceSize: { w: CELL, h: CELL },
      spriteSourceSize: { x: s.mx, y: s.my, w: s.bw, h: s.bh },
    })),
  };

  writeCase(
    'untrimmed-padding',
    {
      'sheet.png': sheet,
      'sheet.json': hashManifest('sheet.png', size, frames),
      'expected.json': {
        kind: 'trim-margin',
        feature: 'within-atlas-untrimmed-padding',
        atlas: { w: size.w, h: size.h },
        // The UNtrimmed sprites with reclaimable padding (trimmed_0 is intentionally excluded).
        qualifying: ['padded_0', 'padded_1', 'padded_2'],
        minMarginPx: 4,
        minRecoverablePct: 0.05,
        regions,
        recoverableArea,
        vramBytesSaved: recoverableArea * 4,
        repack,
        findings: [{ rule: 'trim-margin', severity: 'warn' }],
        note:
          'One atlas of UNtrimmed sprites carrying transparent margins (opaque cores inset inside 64×64 frames, '
          + 'trimmed:false, NO spriteSourceSize), plus one ALREADY-trimmed sprite that the detector must SKIP. '
          + 'The trim-margin detector computes each opaque bbox off the decoded page (worker alphaBBox — the SAME '
          + 'decode pass as frame-redundancy) and sums (frame area − bbox area) over the untrimmed sprites only: '
          + 'recoverable atlas AREA → VRAM (vramBytesSaved, EXACT); the disk number is an area-proportional '
          + 'ESTIMATE, never conflated (invariant 5). The detector MEASURES the padding; trimming the frames is '
          + 'the Pro fix\'s job (generation — invariant 3).',
      },
    },
    `# untrimmed-padding

ONE atlas with **untrimmed sprites carrying transparent padding** for the **trim-margin** detector
(\`docs/improvements/round19-trim-margin-detector.md\`).

A 256×256 sheet, 4 frames in a row of 64×64 cells. Each opaque core is a **textured** 2-color checker
(the detector reads alpha, not luma — the texture just keeps the art honest):

- **\`padded_0\`–\`padded_2\`** — **untrimmed** (\`trimmed:false\`, frame == full 64×64 image, NO
  \`spriteSourceSize\`), each with a transparent margin around a smaller opaque core → genuine
  reclaimable padding.
- **\`trimmed_0\`** — **already trimmed** (carries \`spriteSourceSize\`); the detector **SKIPS** it (a
  trimmed frame has no reclaimable margin) — a no-double-count negative golden.

The detector computes each sprite's **opaque bbox** off the already-decoded page (worker \`alphaBBox\`,
the SAME decode pass as frame-redundancy) and sums **(frame area − bbox area)** over the UNtrimmed
sprites:

- **VRAM** — the recoverable padding area × 4 (the atlas space the margins pin that a **trimmed repack
  reclaims up to**). EXACT area arithmetic.
- **DISK** — an **area-proportional estimate** only, carried separately and **never** conflated with
  VRAM (invariant 5).

Trimming the frames is the **Pro fix's** job (generation — invariant 3). The regression test feeds this
PNG through the REAL decode path (decode → \`alphaBBox\` → \`trimMarginFinding\`) and asserts the finding
fires with the documented recoverable area.
`,
  );
}

/* ── Case 12: bmfont-sparse — AngelCode BMFont .fnt (TEXT) glyph page for the font-glyph-page readout ──
 * A single-page TEXT BMFont on a 256×256 POT page with 16 small opaque glyph rects → a SPARSE glyph sheet
 * (the documented defect: a glyph page pinning w×h×4 VRAM for mostly-empty space). 16 usable glyphs clears
 * minChars (16); occupancy 16·20² / 256² ≈ 9.8% ≤ occupancyWarn (0.5) ⇒ the readout is WARN. Includes a
 * whitespace glyph (id=32, width=0 height=0 → skipped from sprites, NOT an error) and one deliberately
 * out-of-page glyph (kept OUT of the usable count, IN per-glyph recovery). Exercised through the REAL path
 * (groupFiles → parseFntPage → analyze) in packages/analysis/test/analysis.test.ts. */
{
  const size = { w: 256, h: 256 };
  const GLYPH = 20;
  const PER_ROW = 8;
  const GAP = 12; // step so glyphs don't touch; 8 cols × 12px*… stays well inside 256
  // 16 usable glyphs (ASCII 'A'..'P' = 65..80) laid out in a 8×2 grid of 20×20 opaque rects.
  const glyphs = [];
  for (let i = 0; i < 16; i++) {
    const col = i % PER_ROW;
    const r = Math.floor(i / PER_ROW);
    const x = 4 + col * (GLYPH + GAP);
    const y = 4 + r * (GLYPH + GAP);
    glyphs.push({ id: 65 + i, x, y, w: GLYPH, h: GLYPH });
  }
  const usableArea = glyphs.reduce((s, g) => s + g.w * g.h, 0); // 16 * 400 = 6400
  const occupancy = round4(usableArea / (size.w * size.h)); // 6400 / 65536 = 0.0977

  // Paint the glyph rects opaque onto a transparent page (the page IS an atlas; the generic occupancy
  // finding reads these as packed frames, the font readout reads occupancy + glyph count).
  const fontPng = (() => {
    const png = new PNG({ width: size.w, height: size.h });
    png.data.fill(0);
    glyphs.forEach((g, i) => fillRect(png, g.x, g.y, g.w, g.h, COLORS[i % COLORS.length]));
    return PNG.sync.write(png);
  })();

  // BMFont TEXT: info/common/page then 16 char lines + 1 whitespace glyph + 1 OOB glyph + 2 kerning lines.
  const charLine = (g) =>
    `char id=${g.id} x=${g.x} y=${g.y} width=${g.w} height=${g.h} xoffset=0 yoffset=4 xadvance=${g.w + 2} page=0 chnl=15`;
  const fntText =
    `info face="SparseFont" size=20 bold=0 italic=0 padding=2,2,2,2 spacing=1,1\n` +
    `common lineHeight=24 base=18 scaleW=${size.w} scaleH=${size.h} pages=1 packed=0\n` +
    `page id=0 file="font.png"\n` +
    `chars count=${glyphs.length}\n` +
    glyphs.map(charLine).join('\n') + '\n' +
    `char id=32 x=0 y=0 width=0 height=0 xoffset=0 yoffset=0 xadvance=8 page=0 chnl=15\n` + // space → skipped
    `char id=255 x=250 y=250 width=40 height=40 xoffset=0 yoffset=0 xadvance=40 page=0 chnl=15\n` + // OOB → recovery
    `kerning first=65 second=86 amount=-2\n` +
    `kerning first=65 second=87 amount=-1\n`;

  // The FULL ordered char list the three serializations share (16 real glyphs + 1 whitespace + 1 OOB),
  // so the XML + binary fonts carry IDENTICAL glyph data → byte-identical FntPage[] through every parser.
  const FACE = 'SparseFont';
  const KERNING = 2;
  const allChars = [
    ...glyphs.map((g) => ({ id: g.id, x: g.x, y: g.y, w: g.w, h: g.h, page: 0 })),
    { id: 32, x: 0, y: 0, w: 0, h: 0, page: 0 }, // whitespace → skipped
    { id: 255, x: 250, y: 250, w: 40, h: 40, page: 0 }, // OOB → per-glyph recovery
  ];

  // XML serialization (BMFont XML form): info/common/page/char/kerning tags carrying the SAME attributes
  // the TEXT form does → parseFntXml(fntXml) is byte-identical to parseFntText(fntText).
  const charTag = (g) =>
    `  <char id="${g.id}" x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" xoffset="0" yoffset="4" xadvance="${g.w + 2}" page="0" chnl="15"/>`;
  const fntXml =
    `<?xml version="1.0"?>\n` +
    `<font>\n` +
    `  <info face="${FACE}" size="20" bold="0" italic="0" padding="2,2,2,2" spacing="1,1"/>\n` +
    `  <common lineHeight="24" base="18" scaleW="${size.w}" scaleH="${size.h}" pages="1" packed="0"/>\n` +
    `  <pages>\n    <page id="0" file="font.png"/>\n  </pages>\n` +
    `  <chars count="${allChars.length}">\n` +
    allChars.map(charTag).join('\n') + '\n' +
    `  </chars>\n` +
    `  <kerning first="65" second="86" amount="-2"/>\n` +
    `  <kerning first="65" second="87" amount="-1"/>\n` +
    `</font>\n`;

  // Binary serialization (AngelCode BMF v3): the SAME font/glyph/kerning data via encodeBmfBinary →
  // parseFntBinary(fntBin) is byte-identical to parseFntText(fntText). Committed AND reproducible.
  const fntBin = encodeBmfBinary({
    face: FACE,
    lineHeight: 24,
    base: 18,
    scaleW: size.w,
    scaleH: size.h,
    pages: ['font.png'],
    chars: allChars,
    kerningCount: KERNING,
  });

  const expected = {
    kind: 'bmfont',
    face: FACE,
    atlas: size,
    glyphCount: 16, // usable glyphs (space skipped, OOB glyph recovered out)
    kerningCount: KERNING,
    occupancy, // ≈ 0.0977 (sparse → the documented defect)
    malformedGlyph: { id: '255', reason: 'glyph id=255 extends past page 256×256' },
    findings: [
      { rule: 'font-glyph-page', severity: 'warn' },
      { rule: 'occupancy', severity: 'crit' }, // sparse page also trips the generic occupancy finding (free)
      { rule: 'wasted-regions', severity: 'info' },
    ],
    note:
      'Single-page BMFont (.fnt) on a 256×256 POT page with 16 small opaque glyphs → a SPARSE glyph '
      + 'sheet (~9.8% packed) pinning w×h×4 VRAM for mostly-empty space. 16 usable glyphs clears minChars '
      + '(16); occupancy ≤ occupancyWarn (0.5) ⇒ the font-glyph-page readout is WARN. A whitespace glyph '
      + '(id=32, 0×0) is skipped (not an error); one out-of-page glyph (id=255) is dropped + surfaced via '
      + 'per-glyph recovery. The page IS an atlas, so the generic occupancy/wasted-regions findings fire '
      + 'for free. The font readout estimate carries ONLY occupancyPct — the generic findings own the VRAM '
      + 'on the same page (invariant 5; no double-count). Emitted in all THREE serializations (TEXT/XML/'
      + 'binary) from the SAME glyph data + the SAME font.png + this SAME expected.json; each parser '
      + 'produces a byte-identical FntPage[]. Exercised through the REAL path (groupFiles → parseFntPage → analyze).',
  };

  writeCase(
    'bmfont-sparse',
    {
      'font.png': fontPng,
      'font.fnt': fntText,
      'expected.json': expected,
    },
    `# bmfont-sparse

A single-page **AngelCode BMFont** \`.fnt\` (TEXT format) glyph page for the **font-glyph-page** readout
(\`docs/improvements/round23-bitmap-font-fnt-bmfont-parser-inge.md\`).

A 256×256 POT page carries **16 small opaque glyph rects** (ASCII \`A\`–\`P\`, 20×20 each) → a **sparse**
glyph sheet at ~9.8% occupancy: the documented defect, a glyph page pinning **w×h×4 VRAM** for mostly-empty
space. 16 usable glyphs clears \`minChars\` (16) and occupancy ≤ \`occupancyWarn\` (0.5), so the readout is
**warn**.

- a **whitespace glyph** (\`id=32\`, \`width=0 height=0\`) → skipped from sprites, **not** an error.
- one deliberately **out-of-page glyph** (\`id=255\` at 250,250 / 40×40) → dropped + surfaced via **per-glyph
  recovery** (kept OUT of the usable glyph count).

The \`.fnt\` page **is** an Atlas, so the generic **occupancy** (crit) + **wasted-regions** (info) findings
fire for free — the font readout sits BESIDE them and its estimate carries **only** \`occupancyPct\` (the
generic findings own the VRAM on the same page — invariant 5, no double-count).

The regression test feeds this through the **REAL path** (\`groupFiles → parseFntPage → analyze\` with the
\`fontPages\` dep) and asserts the \`font-glyph-page\` finding **fires** with the documented glyph/kerning
counts. The sibling \`bmfont-sparse-xml/\` and \`bmfont-sparse-bin/\` carry the SAME glyphs in the XML +
binary serializations (same \`font.png\`, same \`expected.json\`) — each parser yields a byte-identical page.
`,
  );

  // Sibling fixtures: the SAME font/glyph data in the XML + binary serializations, reusing the SAME page
  // image + the SAME expected.json. Each parser (parseFntXml / parseFntBinary) yields a byte-identical
  // FntPage[] to parseFntText — proven through the REAL groupFiles → parseFntPage → analyze path.
  writeCase(
    'bmfont-sparse-xml',
    {
      'font.png': fontPng,
      'font.fnt': fntXml,
      'expected.json': expected,
    },
    `# bmfont-sparse-xml

The **XML serialization** of \`bmfont-sparse\` — same 16 glyphs + whitespace + out-of-page glyph + 2 kerning
records, same \`font.png\`, same \`expected.json\`. \`parseFntXml\` produces a **byte-identical** \`FntPage[]\`
to \`parseFntText\` on \`bmfont-sparse/font.fnt\`. Ingest dispatches the leading \`<\` to the XML parser; the
font-glyph-page readout fires identically.
`,
  );

  writeCase(
    'bmfont-sparse-bin',
    {
      'font.png': fontPng,
      'font.fnt': fntBin,
      'expected.json': expected,
    },
    `# bmfont-sparse-bin

The **binary serialization** (AngelCode BMF v3) of \`bmfont-sparse\` — same 16 glyphs + whitespace +
out-of-page glyph + 2 kerning records, same \`font.png\`, same \`expected.json\`. \`parseFntBinary\` produces a
**byte-identical** \`FntPage[]\` to \`parseFntText\`. Ingest dispatches the \`BMF\\x03\` magic to the binary
parser; the font-glyph-page readout fires identically. The blob is committed AND reproducible via
\`node fixtures/_generator/generate.mjs\` (\`encodeBmfBinary\`).
`,
  );
}

console.log('Done.');
