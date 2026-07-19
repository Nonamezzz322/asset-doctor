// Pins the rotation-packing v2 COMPOSE direction (the one corruption-prone piece). Runs the EXACT transform
// the fix worker uses for a rotate90 blit in a real browser canvas, then compares the composed on-page region
// against a first-principles 90-degree CLOCKWISE rotation of the source computed manually — no un-rotate
// ambiguity. If they match, the compose is a true 90 CW rotation, which is what TexturePacker/Pixi's
// rotated:true convention (the manifest emit/parse round-trip already tests) expects.
// Usage: CHROME=/path/to/chrome node tools/verify/rotate-compose-check.mjs
import puppeteer from 'puppeteer-core';
import { CHROME_ARGS, chromePath } from './lib.mjs';

const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: CHROME_ARGS });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR ' + String(e)));
  const result = await page.evaluate(() => {
    const sw = 4, sh = 3;            // source width/height (distinct so w != h reveals a transpose bug)
    const tox = 5, toy = 7;          // a non-zero destination box origin (matches a real blit.to.x/y)
    // Build the source: a unique RGBA per pixel so any wrong pixel is caught.
    const src = new OffscreenCanvas(sw, sh);
    const sctx = src.getContext('2d');
    const sdata = sctx.createImageData(sw, sh);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      const i = (y * sw + x) * 4;
      sdata.data[i] = 20 + x * 50;      // R varies by column
      sdata.data[i + 1] = 30 + y * 70;  // G varies by row
      sdata.data[i + 2] = 200 - x * 10 - y * 5;
      sdata.data[i + 3] = 255;
    }
    sctx.putImageData(sdata, 0, 0);
    const srcBmp = src.transferToImageBitmap();

    // ── the EXACT fix.worker rotate90 compose (blit.to.w = sh, blit.to.h = sw on-page footprint) ──
    const dest = new OffscreenCanvas(tox + sh + 4, toy + sw + 4);
    const c2d = dest.getContext('2d');
    c2d.save();
    c2d.translate(tox + sh, toy);
    c2d.rotate(Math.PI / 2);
    c2d.drawImage(srcBmp, 0, 0, sw, sh, 0, 0, sw, sh);
    c2d.restore();

    // Read the on-page region (footprint sh wide x sw tall) and the source pixels.
    const onW = sh, onH = sw;
    const got = c2d.getImageData(tox, toy, onW, onH).data;
    const s = sdata.data;
    // First-principles expected: source rotated 90 CW ⇒ result[r'][c'] = source[sh-1-c'][r'] (r' in [0,sw),
    // c' in [0,sh)). result is onH=sw rows x onW=sh cols.
    let mismatches = 0;
    let firstBad = null;
    for (let rp = 0; rp < onH; rp++) {
      for (let cp = 0; cp < onW; cp++) {
        const gi = (rp * onW + cp) * 4;
        const srcRow = sh - 1 - cp;
        const srcCol = rp;
        const si = (srcRow * sw + srcCol) * 4;
        for (let k = 0; k < 4; k++) {
          if (Math.abs(got[gi + k] - s[si + k]) > 1) { // tolerance 1 for canvas premultiply round-trip
            mismatches++;
            if (!firstBad) firstBad = { rp, cp, k, got: got[gi + k], exp: s[si + k] };
          }
        }
      }
    }
    return { mismatches, firstBad, checked: onW * onH * 4 };
  });
  console.log('CHECKED', result.checked, 'channels · MISMATCHES', result.mismatches, result.firstBad ? JSON.stringify(result.firstBad) : '');
  const ok = result.mismatches === 0;
  console.log(ok ? 'ROTATE_COMPOSE_CHECK PASS (compose is a true 90-CW rotation)' : 'ROTATE_COMPOSE_CHECK FAIL');
  if (!ok) process.exitCode = 1;
} catch (e) {
  console.log('ROTATE_COMPOSE_CHECK FAIL —', e && e.message ? e.message : String(e));
  process.exitCode = 1;
} finally {
  await browser.close();
}
