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

function writeCase(name, files, readme) {
  const dir = join(OUT, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    const p = join(dir, file);
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
        ],
        note: 'Occupancy ~86% (ok). Atlas 4100×1024: edge 4100 > 4096 (oversize crit) and NPOT (warn).',
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

console.log('Done.');
