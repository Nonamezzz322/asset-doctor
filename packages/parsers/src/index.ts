// @asset-doctor/parsers — raw asset files → normalized @asset-doctor/core model.
// Milestone 1 fills in: TexturePacker JSON (Hash + Array), PixiJS spritesheet, and
// single PNG/WebP/JPG. Parsers are pure and worker-safe — no DOM, no network.

import type { Asset } from '@asset-doctor/core';

/** Result of parsing one asset file. Errors are returned, never thrown. */
export type ParseResult = { ok: true; asset: Asset } | { ok: false; error: string };

// Real parsers land in Milestone 1 (see the parsers-engineer agent).
