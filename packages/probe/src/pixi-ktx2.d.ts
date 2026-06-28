// Pixi v8's `./ktx2` subpath export (lib/compressed-textures/ktx2/init.mjs) ships no `types` entry — it
// is a SIDE-EFFECT module that registers the `loadKTX2` Assets parser + `getSupportedTextureFormats`. We
// only `await import('pixi.js/ktx2')` for its side effect (probeKtx2), so an ambient declaration with no
// exports is exactly right — it just tells tsc the subpath exists.
declare module 'pixi.js/ktx2';
