// @asset-doctor/pixel — the shared pixel layer. Pure, canvas-free perceptual math (dHash / flat-guard /
// solid / opaque / upscale-depth / premultiplied-edge / alpha-shape / frame-region hashing / content class)
// plus the per-page scan-budget policy. One source of truth so every host that decodes pages — the web
// analyze worker AND the extension overlay — computes byte-identical features from byte-identical inputs.

export * from './perceptual';
export { ANALYZE_PAGE_MAX_PX, pageExceedsScanBudget, scanSkipReason } from './budget';
export { decodeImageFeatures, featureFromDecode, type DecodedImageFeatures } from './decode';
