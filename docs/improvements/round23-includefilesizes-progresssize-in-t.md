I have everything needed. Here is the adversarial review with the final revised mini-design.

---

# Adversarial Review + Revised Mini-Design: `includeFileSizes` → `progressSize`

## Verdict on the draft: SALVAGEABLE, but premise has 2 false claims + 1 architectural flaw

I verified against the real AssetPack 1.7.0 source on disk (`/tmp/ap/package/dist/manifest/pixiManifest.js` + `utils.js`) and the real worker. The field name `progressSize` is **confirmed** (pixiManifest.js:139-142) and the additive pattern is sound. But three issues are blockers/majors:

### BLOCKER 1 — `'raw'` is NOT exact bytes (false premise)
The draft repeatedly states `'raw'` ⇒ "exact bytes" and default ⇒ KB. The **real** `getFileSizeInKB(filePath, useRaw)` (utils.js:24-42):
```js
if (useRaw) size = fs.statSync(filePath).size;     // raw byte count
else        size = zlib.gzipSync(readFileSync()).length; // gzip byte count
size = Number((size / 1024).toFixed(2));            // BOTH divided by 1024, 2dp
```
**Both modes divide by 1024 and round to 2dp.** `'raw'` = *uncompressed KB*; default(`'gzip'`) = *gzip KB*. There is no bytes-out mode. The draft's `kbOf` for default and "exact bytes" for raw is **backwards**: raw must also be KB. Parity requires `'raw'` → `kbOf(statBytes)`, `'gzip'` → `kbOf(gzipBytes)`.

### BLOCKER 2 — `'gzip'` approximated-by-raw is dishonest AND breaks the feature (false premise)
The draft proposes mapping `'gzip'` to raw-KB "honestly noted." But:
- AssetPack's **default** (no flag value, just `true`) IS real gzip. `'gzip'` approximated by uncompressed KB is a **wrong number** — `progressSize` exists to drive accurate Pixi load-progress over a gzip transport; reporting the uncompressed size defeats the purpose and is a fabricated metric (violates invariant 3: only measure honestly).
- The premise "no CompressionStream in the worker" is true as *current usage* but irrelevant as *capability*: `CompressionStream('gzip')` is a standard Worker API, and the manifest is built in an `async` worker function. Real gzip is free and honest.

**Resolution:** v1 ships TWO honest modes — `'raw'` (uncompressed KB) and `'gzip'` (REAL gzip KB via `CompressionStream`). No approximation, no fabricated number. This also means the size source must be the actual emitted bytes (needed to gzip them), which dovetails with Blocker 3.

### BLOCKER 3 (major) — per-site `bytes` threading reports STALE sizes
recordVariant fires at the out.push site, but two opt-in post-passes **replace bytes at the same path AFTER recording**:
- pngquant (fix.worker.ts:3640): `out.push({ path: c.path, bytes: res.bytes })` overwrites the lossless loose/page bytes; last-write-wins via `byPath` (3651-3652).
- KTX2 sidecar mutation in the same region.

So a recordVariant-time `bytes: enc.bytes.length` (e.g. loose transcode at 2510-2512) would report the **lossless** size while the zip ships the **quantized** file → a dishonest `progressSize`. The **authoritative final size** lives in `byPath` (Map<path, finalBytes>) built at 3651-3652, keyed by exactly the `src` strings the manifest uses.

**Resolution:** DROP the 17-site threading and the ktx2 hoist entirely. Instead pass the builder a `Map<src, Uint8Array>` of FINAL emitted bytes (a slice of `byPath`); the builder computes `progressSize` from the shipped bytes. This is simpler (1 worker edit, not 18), correct under pngquant/KTX2 replacement, and required anyway for real gzip (you need the bytes to compress them). `EmittedVariant.bytes` is **not added at all.**

### Confirmed-correct in the draft (no change)
- Field name `progressSize`, type union `false | 'raw' | 'gzip'` (matches pixiManifest.d.ts:43).
- Sheet `src` = sidecar path ⇒ progressSize is the sidecar file's size (AssetPack stats whatever `src` points at — correct).
- Off ⇒ bare-string `src` ⇒ byte-identical (pixiManifest.js:136-138 returns bare `src`).
- `RawEntry.src` widening, `PixiSizedSrc` shape, alias/sort/ktx2-first untouched, `countPixiManifestEntries` unaffected.
- Anchors: FixOptions after line 171; App.tsx state ~1382, `effectiveEmitManifest` 1615, buildOptions 1579, checkbox 1834-1844; i18n `fix.pixiManifest*` at en.json:406-408; 9 catalogs. **Note:** `effectiveEmitManifest` (1615) can be forced ON by `backendWillUpload` even if the user didn't tick — gate the UI select on `effectiveEmitManifest`, not raw `emitPixiManifest`.

---

## Revised contract

`pixi-manifest.ts`:
```ts
export interface PixiSizedSrc { src: string; progressSize: number; } // KB, 2dp (AssetPack parity)
export interface PixiUnresolvedAsset { alias: string[]; src: string[] | PixiSizedSrc[]; }

export interface BuildPixiManifestOptions {
  bundleName?: string;
  /** AssetPack includeFileSizes parity. Absent/false ⇒ bare-string src (byte-identical to today).
   *  'raw' ⇒ progressSize = uncompressed KB (statBytes/1024, 2dp). 'gzip' ⇒ gzip KB (gzipBytes/1024, 2dp).
   *  BOTH are KB (getFileSizeInKB divides by 1024 in both branches). */
  includeFileSizes?: false | 'raw' | 'gzip';
  /** Final emitted byte length per `src` path (raw for 'raw'; pre-gzipped length for 'gzip'). Provided by
   *  the worker from the post-replace byPath map, so pngquant/KTX2 in-place swaps are reflected honestly.
   *  Required when includeFileSizes is set; ignored otherwise. */
  srcBytes?: ReadonlyMap<string, number>;
}
```
- `EmittedVariant` — **no change** (no `bytes` field).
- `FixOptions` (after line 171): `includeFileSizes?: 'raw' | 'gzip';`
- `FixReceipt.pixiManifest` — unchanged.

**Builder change** (inside the per-suffix loop, replacing `const src = [...new Set(...)].sort(compareSrc)`):
```ts
const kbOf = (b: number) => Number((b / 1024).toFixed(2)); // getFileSizeInKB parity (both modes /1024, 2dp)
const sortedSrcs = [...new Set(variants.map(v => v.src))].sort(compareSrc);
const src: string[] | PixiSizedSrc[] = opts?.includeFileSizes
  ? sortedSrcs.map(s => ({ src: s, progressSize: kbOf(opts.srcBytes?.get(s) ?? 0) }))
  : sortedSrcs;
```
Determinism preserved (pure math; sort key still the `src` string; no `Date.now`/`Math.random`). Off-path is literally today's code.

## Worker change (single edit at 3666-3672) — NO per-site threading
```ts
if (manifestAssets && manifestAssets.size > 0) {
  const assets = [...manifestAssets.values()];
  let srcBytes: Map<string, number> | undefined;
  if (opts.includeFileSizes) {
    srcBytes = new Map();
    for (const e of dedupedOut) {            // dedupedOut = FINAL shipped bytes (post pngquant/KTX2)
      const len = opts.includeFileSizes === 'gzip' ? await gzipLen(e.bytes) : e.bytes.length;
      srcBytes.set(e.path, len);             // keyed by the same path strings the manifest src uses
    }
  }
  const json = buildPixiManifest(assets, opts.includeFileSizes
    ? { includeFileSizes: opts.includeFileSizes, srcBytes }
    : {});
  ...
}
// gzipLen via standard Worker API; pure size, no IO:
async function gzipLen(bytes: Uint8Array): Promise<number> {
  const cs = new CompressionStream('gzip');
  const blob = await new Response(new Response(bytes).body!.pipeThrough(cs)).arrayBuffer();
  return blob.byteLength;
}
```
- Spread-gated ⇒ `undefined` never reaches the builder ⇒ off-path unchanged ⇒ byte-identical.
- `srcBytes` only over `dedupedOut` (final bytes) ⇒ honest under pngquant/KTX2 replacement.
- Only the manifest entries' `src` paths are looked up; extra `dedupedOut` entries (e.g. the manifest.json itself, which doesn't exist yet) are harmless map entries.
- **Determinism caveat to verify in test:** `CompressionStream('gzip')` output length must be stable across runs for identical input. gzip level/dictionary are fixed by the platform; the gzip *bytes* may carry an mtime=0 header but length is deterministic for a given engine. **Risk flag:** if a future engine changes zlib level, gzip-mode KB could shift. Mitigation: golden tests assert `'raw'` exactly (engine-independent) and assert `'gzip'` only as "present, >0, ≤ raw" (not an exact constant). Documented as a known platform-coupling for gzip mode.

## UI (App.tsx)
- State: `const [includeFileSizes, setIncludeFileSizes] = useState<'off'|'raw'|'gzip'>('off');`
- buildOptions (after `emitPixiManifest:` ~1579):
  ```ts
  includeFileSizes: effectiveEmitManifest && includeFileSizes !== 'off' ? includeFileSizes : undefined,
  ```
  (No `kb→gzip` remap — UI values ARE the contract values now: `raw`/`gzip`.)
- `<select>` under the checkbox (1834-1844), **disabled when `!effectiveEmitManifest`**, options Off / Uncompressed KB (`raw`) / Gzip KB (`gzip`). Title from `fix.includeFileSizesHint`.

## i18n (en.json after 408; mirror to all 9 catalogs)
```json
"fix.includeFileSizes": "File sizes in manifest (progressSize)",
"fix.includeFileSizesHint": "Adds AssetPack's progressSize (KB) to each manifest src so PixiJS shows accurate load progress. 'Uncompressed' = file size / 1024; 'Gzip' = gzipped size / 1024 (matches an HTTP gzip transport). Sizes reflect the actually-shipped file (a sheet's .json/.atlas sidecar; the final bytes after any pngquant/KTX2 step). Requires the PixiJS manifest. Off ⇒ today's bare-string src.",
"fix.includeFileSizes.off": "Off",
"fix.includeFileSizes.raw": "Uncompressed KB",
"fix.includeFileSizes.gzip": "Gzip KB"
```
Drift test requires the same keys in de/es/fr/hi/it/pt/ru/zh (CLI stays EN, unaffected).

## Honesty & invariants
- Inv 1/2: `CompressionStream` is a browser/Worker primitive — no network, no native lib, no backend.
- Inv 3: both modes are MEASURED (raw stat-equivalent; gzip = real compression). **No fabricated/approximated number** (this is the core fix vs the draft).
- Inv 5: `progressSize` is disk/download size; never summed into VRAM or any saving.
- Determinism: pure for `'raw'`; `'gzip'` length is platform-stable (tested as bound, not constant).

## Edge cases
- Missing `srcBytes` entry ⇒ `?? 0` ⇒ `progressSize: 0`, no throw (only off-by-construction; all real entries are in `dedupedOut`).
- 300-byte sidecar ⇒ raw `0.29` KB (parity with `(300/1024).toFixed(2)`); 0-byte ⇒ `0`.
- ktx2-first order preserved (sizes ride after `compareSrc`).
- gzip of multi-MB page ⇒ KB float, no overflow.
- Off / empty manifest ⇒ unchanged.

## Test plan (`packages/fix/test/pixi-manifest.test.ts`)
- **T17 off:** `includeFileSizes` absent + `srcBytes` provided ⇒ `src` still `string[]`, equals current T2 (byte-identity of off-path).
- **T18 raw:** loose multi-format, `srcBytes` {avif:1536, webp:..., png:...} ⇒ `[{src,progressSize}]`, `progressSize === 1.5` for 1536 B, avif<webp<png order.
- **T19 KB rounding:** 1536→`1.5`, 300→`0.29`, 0→`0` (locks `(b/1024).toFixed(2)` parity for BOTH modes — note correction: raw is KB too).
- **T20 sheet:** atlas variant `src=.json`, `srcBytes` = sidecar length ⇒ `progressSize` is the SIDECAR's, no image in `src`.
- **T21 determinism:** shuffled input + `'raw'` ⇒ byte-identical string.
- **T22 missing srcBytes ⇒ 0:** variant whose `src` not in `srcBytes` + `'raw'` ⇒ `progressSize:0`, no throw.
- **T23 field-name lock:** assert JSON contains `"progressSize"` and does NOT contain `"fileSize"`/`"size"` (locks verified AssetPack contract).
- **gzip mode (worker-level, where CompressionStream exists):** since the builder is pure and gzip happens in the worker, test `gzipLen` (or the worker glue) separately: assert `gzip KB > 0` and `gzip KB ≤ raw KB` for compressible input (NOT an exact constant — platform-coupling note).
- **Real-path fixture (proves it FIRES):** build a `ManifestAsset[]` + `srcBytes` map mirroring the exact emitted sidecar/page lengths a real fix records (same proof-strategy as T1-T16; no headless OffscreenCanvas harness exists). Assert emitted JSON carries `progressSize` with the real value.
- **Manual-verify footer:** `pnpm dev`, drop a fixture, enable manifest + "File sizes" (try both raw and gzip), download zip, confirm every `src` is `{src,progressSize}` and gzip-KB < raw-KB for a PNG sidecar.

## Ordered task breakdown (small commits) — KEPT, re-scoped
1. **`feat(fix): PixiSizedSrc + includeFileSizes/srcBytes in buildPixiManifest`** — add `PixiSizedSrc`, widen `PixiUnresolvedAsset.src` + `RawEntry.src`, add `includeFileSizes` + `srcBytes` to `BuildPixiManifestOptions`, `kbOf`, branch in builder. Re-export `PixiSizedSrc` from `index.ts`. *(No `EmittedVariant.bytes` — removed vs draft.)*
2. **`test(fix): golden off/raw/KB/determinism/field-name + real-path fixture for progressSize`** — T17-T23 + real-path fixture (raw-KB asserted exactly; gzip asserted as bound).
3. **`feat(fix): compute srcBytes from final emitted bytes + gzipLen at the manifest call`** — single edit at fix.worker.ts:3666-3672; `gzipLen` via `CompressionStream`. *(Replaces the draft's 17-site threading + ktx2 hoist — those tasks are DROPPED as stale-prone and unnecessary.)*
4. **`feat(fix): forward includeFileSizes from FixOptions`** — add `FixOptions.includeFileSizes` (after line 171), spread-gate into the call.
5. **`feat(web): includeFileSizes select gated behind the Pixi manifest toggle`** — App.tsx state + `<select>` (disabled when `!effectiveEmitManifest`) + buildOptions wiring (UI values = contract values, no remap).
6. **`feat(i18n): includeFileSizes keys (9 langs)`** — 5 keys × 9 catalogs; run drift test.
7. **`docs: round-note for includeFileSizes / progressSize parity`** — CHANGELOG + FEATURES; document the raw-vs-gzip KB semantics and the gzip platform-coupling.

## Key files (absolute)
- `/home/nonamezzz/Рабочий стол/projects/packages/fix/src/pixi-manifest.ts` — types + builder (`PixiUnresolvedAsset` 24-27, `BuildPixiManifestOptions` 67-69, builder 148-202; the `src` line is 180).
- `/home/nonamezzz/Рабочий стол/projects/packages/fix/src/index.ts` — re-export `PixiSizedSrc`.
- `/home/nonamezzz/Рабочий стол/projects/packages/fix/test/pixi-manifest.test.ts` — golden tests.
- `/home/nonamezzz/Рабочий стол/projects/apps/web/src/worker/fix.worker.ts` — SINGLE edit at the manifest build (3666-3672); `byPath`/`dedupedOut` at 3651-3658; pngquant replace at 3640 (the staleness source).
- `/home/nonamezzz/Рабочий стол/projects/apps/web/src/worker/fix-protocol.ts` — `FixOptions.includeFileSizes` after line 171.
- `/home/nonamezzz/Рабочий стол/projects/apps/web/src/App.tsx` — state ~1382, buildOptions ~1579, `effectiveEmitManifest` 1615, checkbox 1834-1844.
- `/home/nonamezzz/Рабочий стол/projects/packages/i18n/src/catalogs/*.json` — 5 keys × 9 langs (en.json anchor 406-408).

## One decision for the lead
Keep BOTH `'raw'` and `'gzip'` as real measured modes (recommended — full AssetPack parity, both honest). The draft's "drop gzip OR approximate it" choice is rejected: approximation is dishonest (inv 3) and `CompressionStream` makes real gzip free. If you want to minimize surface for v1, the only defensible cut is shipping **`'gzip'` only** (it's AssetPack's default and the value that matches a real HTTP transport) and adding `'raw'` later — but shipping both is low-cost.