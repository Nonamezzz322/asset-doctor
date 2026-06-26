import type { ImageMime } from '@asset-doctor/core';

export interface FixInputFile {
  path: string;
  name: string;
  bytes: ArrayBuffer;
}

export interface FixOptions {
  /** Preferred transcode target for loose images (falls back to WebP / skip if unavailable). */
  targetMime: ImageMime;
  quality: number;
  padding: number;
  maxSize: number;
  /** Downscale a loose image whose longest edge exceeds this (px). */
  maxEdge: number;
  /** Merge under-filled atlases into fewer sheets — NON-drop-in (rewrites manifest references). */
  mergeAtlases: boolean;
}

export type FixRequest = { type: 'fix'; files: FixInputFile[]; options: FixOptions };

/** Lightweight receipt (no bytes — the optimized files live in the zip Blob). */
export interface FixReceipt {
  diskBytesBefore: number;
  diskBytesAfter: number;
  vramBytesBefore: number;
  vramBytesAfter: number;
  fileCount: number;
  changedCount: number;
  operations: string[];
  skipped: { assetRef: string; reason: string }[];
  /** True when a merge rewrote manifest references — the folder is NOT a drop-in replacement. */
  referencesChanged: boolean;
}

export type FixResponse =
  | { type: 'fix-progress'; label: string; done: number; total: number }
  | { type: 'fix-done'; receipt: FixReceipt; zip: Blob }
  | { type: 'fix-error'; error: string };
