// @asset-doctor/parsers — raw asset files → normalized @asset-doctor/core model.
// TexturePacker JSON (Hash + Array), PixiJS spritesheets, and single PNG/WebP/JPEG.
// Everything here is pure and worker-safe — no DOM, no network. Errors are returned.

export type { ParseResult } from './types';
export { readImageInfo } from './image-size';
export type { ImageInfo } from './image-size';
export { parseAtlasManifest, parseAtlas, parseImage } from './atlas';
export type { AtlasParseResult } from './atlas';
export { parseSpineAtlasText, parseSpinePage } from './spine-atlas';
export type { SpinePage } from './spine-atlas';
