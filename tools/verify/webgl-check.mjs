// Smoke test: can the system Chromium run headless WebGL (SwiftShader)?
// Usage: CHROME=/path/to/chrome node tools/verify/webgl-check.mjs
import puppeteer from 'puppeteer-core';

const executablePath = process.env.CHROME;
if (!executablePath) {
  console.error('set CHROME=/path/to/chrome');
  process.exit(2);
}

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
  ],
});
try {
  const page = await browser.newPage();
  const info = await page.evaluate(() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return { ok: false };
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      ok: true,
      webgl2: typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext,
      vendor: gl.getParameter(dbg ? dbg.UNMASKED_VENDOR_WEBGL : gl.VENDOR),
      renderer: gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER),
    };
  });
  console.log(JSON.stringify(info));
} finally {
  await browser.close();
}
