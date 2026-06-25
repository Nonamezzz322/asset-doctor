// Shared launch flags for driving the system Chromium headless with SwiftShader WebGL.
export const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
];

export function chromePath() {
  const p = process.env.CHROME;
  if (!p) throw new Error('set CHROME=/path/to/chrome');
  return p;
}
