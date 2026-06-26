// @asset-doctor/fix — the PURE half of the Phase-2 fix: rectangle packing, geometry-only atlas repack,
// deterministic manifest emission, and findings→FixPlan translation. No pixels, no canvas, no IO — the
// worker reads/writes pixels per the Blit contract. Golden-testable against the Atlas model.

export { pack } from './pack';
export type { PackItem, Placement, PackBin, PackOptions } from './pack';
export { repackAtlases } from './repack';
export type { RepackOptions } from './repack';
export { emitTexturePackerJson } from './manifest';
export { planFix } from './plan';
export type { PlanOptions } from './plan';
