// Generate the premult-halo fixture: two premultiplied-SHAPED sprite PNGs used by the extension R6
// live check (tools/verify/ext-premult-run.mjs). Each has a bright OPAQUE core wrapped in a 1px soft edge
// whose stored RGB is premultiplied (RGB = coreLuma * alphaFraction, so it collapses toward black as alpha
// falls) and a transparent margin. This is exactly the byte pattern premultipliedEdgeShape flags: soft-edge
// pixels (alpha in [12,200]) 8-adjacent to a bright near-opaque neighbour, whose implied matte collapses to
// black — i.e. a "premultiplied export" that fringes under straight-alpha blending.
// Run: node fixtures/_generator/gen-premult.mjs fixtures/sample-projects/premult-halo
import { PNG } from 'pngjs';
import { writeFileSync, mkdirSync } from 'node:fs';

function makeSprite(size, coreLuma) {
  const png = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const edge = x === 1 || y === 1 || x === size - 2 || y === size - 2;
      const outer = x === 0 || y === 0 || x === size - 1 || y === size - 1;
      if (outer) {
        png.data[i] = 0; png.data[i + 1] = 0; png.data[i + 2] = 0; png.data[i + 3] = 0; // transparent margin
      } else if (edge) {
        const a = 128; // soft edge, premultiplied: RGB tracks alpha toward black
        const rgb = Math.round(coreLuma * (a / 255));
        png.data[i] = rgb; png.data[i + 1] = rgb; png.data[i + 2] = rgb; png.data[i + 3] = a;
      } else {
        png.data[i] = coreLuma; png.data[i + 1] = coreLuma; png.data[i + 2] = coreLuma; png.data[i + 3] = 255; // bright opaque core
      }
    }
  }
  return png;
}

const outDir = process.argv[2] || 'fixtures/sample-projects/premult-halo';
mkdirSync(outDir, { recursive: true });
for (const [name, size, luma] of [['glow_a.png', 48, 255], ['glow_b.png', 40, 240]]) {
  const buf = PNG.sync.write(makeSprite(size, luma));
  writeFileSync(`${outDir}/${name}`, buf);
  console.log(`${name}: ${size}x${size}, ${buf.length} bytes`);
}
