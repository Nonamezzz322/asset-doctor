// Standalone generator for the tp-rotate-win fixture (kept separate from the shared generate.mjs so it can
// carry PER-PIXEL-UNIQUE gradients — a solid fill would hide a wrong rotation). Two fully-opaque sprites:
// A 100x60 (landscape) + B 60x100 (portrait), untrimmed + unrotated, in a low-occupancy 256x256 sheet. The
// fix's rect repack CAN stack them into a 128x128 bin ONLY by rotating one (100x60 + rotated-100x60), which
// is strictly smaller VRAM than any unrotated bin (128x256) ⇒ the measured gate rotates it. Consumed by
// tools/verify/fix-rotate-run.mjs (e2e scenario 8) which verifies the composed rotated sprite == the
// forward-rotated source pixel-for-pixel. Regenerate: node fixtures/sample-projects/tp-rotate-win/gen.mjs
import { PNG } from 'pngjs';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const size = { w: 256, h: 256 };
const sprites = [
  { name: 'A.png', frame: { x: 0, y: 0, w: 100, h: 60 }, bTint: 40 },
  { name: 'B.png', frame: { x: 110, y: 0, w: 60, h: 100 }, bTint: 200 },
];

const png = new PNG({ width: size.w, height: size.h });
png.data.fill(0); // transparent background
for (const s of sprites) {
  for (let y = 0; y < s.frame.h; y++)
    for (let x = 0; x < s.frame.w; x++) {
      const i = ((s.frame.y + y) * size.w + (s.frame.x + x)) * 4;
      png.data[i] = 20 + ((x * 2) % 220); // R varies by column
      png.data[i + 1] = 30 + ((y * 2) % 210); // G varies by row
      png.data[i + 2] = s.bTint; // B distinguishes the sprite
      png.data[i + 3] = 255; // opaque ⇒ the fix never trims it
    }
}
writeFileSync(join(HERE, 'symbols-rot.png'), PNG.sync.write(png));

const frames = {};
for (const s of sprites)
  frames[s.name] = {
    frame: s.frame,
    rotated: false,
    trimmed: false,
    spriteSourceSize: { x: 0, y: 0, w: s.frame.w, h: s.frame.h },
    sourceSize: { w: s.frame.w, h: s.frame.h },
  };
writeFileSync(
  join(HERE, 'symbols-rot.json'),
  JSON.stringify({ frames, meta: { image: 'symbols-rot.png', format: 'RGBA8888', size, scale: '1' } }, null, 2) + '\n',
);
console.log('generated tp-rotate-win (A 100x60 + B 60x100, opaque gradients, 256x256)');
