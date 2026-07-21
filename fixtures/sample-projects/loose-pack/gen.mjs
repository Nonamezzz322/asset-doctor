// Standalone generator for the loose-pack fixture: 8 loose (no-manifest) PNGs with PER-PIXEL-UNIQUE gradients
// (a solid fill would hide a wrong pack placement). ≥8 loose images ≤512px dominating the folder trips the
// shouldAtlas floor (minLooseImages:8), so with the packLoose toggle ON the fix packs them into ONE spritesheet.
// Consumed by tools/verify/fix-packloose-run.mjs (e2e scenario 9): each packed sprite must equal its source
// loose image pixel-for-pixel (the loose-pack compose has NO e2e coverage otherwise). Fully opaque so no trim
// interferes with the verbatim compare. Regenerate: node fixtures/sample-projects/loose-pack/gen.mjs
import { PNG } from 'pngjs';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const N = 8;
for (let k = 0; k < N; k++) {
  const w = 40 + k * 6; // distinct sizes so a mis-placed sprite mis-sizes visibly too
  const h = 48 + ((k * 5) % 24);
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      png.data[i] = 20 + ((x * 3) % 220); // R by column
      png.data[i + 1] = 25 + ((y * 3) % 210); // G by row
      png.data[i + 2] = 30 + k * 25; // B distinguishes the sprite
      png.data[i + 3] = 255; // opaque ⇒ no trim
    }
  writeFileSync(join(HERE, `spr_${k}.png`), PNG.sync.write(png));
}
console.log(`generated loose-pack (${N} opaque gradient PNGs)`);
