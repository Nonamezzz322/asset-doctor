// Re-export shim: the pure perceptual math moved to @asset-doctor/pixel so the extension overlay can share
// it with the analyze worker (one source of truth — no drift). Web consumers keep importing `./perceptual`.
export * from '@asset-doctor/pixel';
