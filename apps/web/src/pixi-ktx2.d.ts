// apps/web compiles @asset-doctor/probe's SOURCE directly (workspace path mapping), and probeKtx2 does
// `await import('pixi.js/ktx2')` — a side-effect subpath Pixi ships WITHOUT a `types` entry. tsc resolves
// that bare specifier against THIS project's type roots (not the probe package's), so the ambient
// declaration must also live here (parallel to packages/probe/src/pixi-ktx2.d.ts). No exports: the module
// only registers the loadKTX2 Assets parser as a side effect.
declare module 'pixi.js/ktx2';
