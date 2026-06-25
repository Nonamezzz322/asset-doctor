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
    writeFileSync(p, Buffer.isBuffer(content) ? content : JSON.stringify(content, null, 2) + '\n');
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

console.log('Done.');
