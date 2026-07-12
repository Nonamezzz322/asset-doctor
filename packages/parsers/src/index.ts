// @asset-doctor/parsers — raw asset files → normalized @asset-doctor/core model.
// TexturePacker JSON (Hash + Array), PixiJS spritesheets, and single PNG/WebP/JPEG.
// Everything here is pure and worker-safe — no DOM, no network. Errors are returned.

export type { ParseResult } from './types';
export { readImageInfo, strippableMetadataBytes } from './image-size';
export type { ImageInfo } from './image-size';
export { iccProfileInfo } from './icc';
export type { IccInfo } from './icc';
export { parseAtlasManifest, parseAtlas, parseImage } from './atlas';
export type { AtlasParseResult, MalformedFrame } from './atlas';
export { parseSpineAtlasText, parseSpinePage } from './spine-atlas';
export type { SpinePage } from './spine-atlas';
export { parseFntText, parseFntXml, parseFntBinary, parseFntPage } from './fnt';
export type { FntPage } from './fnt';
export { readSkeletonAttachmentRefs } from './spine-skeleton';
export type { SkeletonAttachmentRefs } from './spine-skeleton';
