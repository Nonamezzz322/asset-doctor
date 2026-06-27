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

console.log('Done.');
