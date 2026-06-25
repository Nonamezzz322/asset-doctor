import type { Asset } from '@asset-doctor/core';

/** Result of parsing one asset. Errors are returned, never thrown. */
export type ParseResult = { ok: true; asset: Asset } | { ok: false; error: string };
