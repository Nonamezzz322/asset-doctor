`encodeCanvas` returns `new Uint8Array(buf)` / `new Uint8Array(await blob.arrayBuffer())` — fresh full-buffer-backed views (byteOffset 0, byteLength === buffer.byteLength). The oxipng path (`optimized`) at line 2135/2143 returns whatever `oxipngOptimize` returns; let me confirm it's not a subarray. But the draft's `shortHash` already handles the subarray case defensively via `bytes.buffer.slice(bytes.byteOffset, ...)`, so it's safe regardless. 

I now have all the grounding I need. Let me verify one final point — that the resize-atlas drop-in path at 1158-1189 keeps the **source format and filename** (so it's currently drop-in, and hashing it WOULD turn a drop-in into a reference change). Confirmed from the code I already read (line 1171 `srcMime = mimeOf(path)`, line 1173 `out.push({ path, ... })` — same path, same format). This is a real additivity-of-semantics concern that the draft's §3b enumeration **omits this site entirely**.

I have enough to write the adversarial review and revised design. Let me compile my findings.

Based on my verification against the actual code, here is my adversarial review and the final revised design.

---

# ADVERSARIAL REVIEW + REVISED DESIGN: `hashFilenames` content-hash cache-busting

## Part A — Verdict on the draft

The draft is **largely sound and well-grounded** — the core reference-chaining insight (image-first → patch `imageRef` → emit sidecar → hash sidecar) is correct, the Pixi-builder-is-hash-agnostic claim is verified (`pixi-manifest.ts:160`), and the additivity-by-short-circuit argument holds. But it has **3 blockers** and **4 majors** that would cause runtime 404s or break additivity-of-semantics if implemented as written.

### BLOCKERS

**B1 — Missing emit site: the resize-atlas drop-in path (`fix.worker.ts:1158-1189`) is unenumerated.** The draft's §3b lists repack-single / merge / pack / tier, but the `op.kind==='resize'` ATLAS branch re-emits the sheet image **in place** (line 1173, same `path`, `srcMime = mimeOf(path)`) plus its `.json`/`.atlas` sidecar (1178/1184). This is a static-atlas sheet that ships today as a pure drop-in (filename + format unchanged). The draft neither hashes it nor documents a carve-out. If left unhashed it's an honesty hole (one cache-bustable sheet ships un-busted under hashing); if hashed naively without the image→imageRef→sidecar chain it 404s. It MUST be added to the chained sites (K5).

**B2 — Pass-through loose-image hashing is a broken-reference-chain risk, not "safe".** The draft asserts parsed loose pass-throughs "ARE hashed (they're already recorded in the Pixi manifest)". But the Pixi-manifest referrer only saves the game **if the game actually loads via `manifest.json`**. `kindOf` classifies a ref `loose` whenever it's not in `atlasByRef` (`fix.worker.ts:392`) — and a loose image can still be referenced by (a) game code by hardcoded name, (b) a hand-authored manifest AD **failed to parse** (the `catch` at `manifest.ts:195-197` silently skips it, so `manifestPathByImage` never maps it → `manifestPathOf` returns undefined → AD believes it's an unreferenced loose image), or (c) a bitmap-font `.fnt`/CSS sprite map AD doesn't parse. Hashing such an image renames it with **no referrer AD can patch** → 404. This is the worst failure class. **Resolution:** pass-through loose images are hashed ONLY when `emitPixiManifest` is also on (the manifest is then the guaranteed referrer) AND the image is recorded in the manifest. When `hashFilenames` is on but `emitPixiManifest` is off, pass-through loose images keep their names (documented carve-out). Transformed loose images (resize/transcode) are different — they ALREADY rename today (`logo.png→logo.webp`) and already emit a `FixChange`/loader-migration row, so hashing their `to` is additive on an already-reference-changing event.

**B3 — Determinism gap: `withHashedImageRef` must NOT mutate `na` in place across the merge/pack page loop.** The draft says "feed `na.imageRef = basename(emittedImage)`" — but `na` (and `scaled` in the tier loop) is reused/captured and `captureSheetDiff` reads `na.imageRef`/`basename(na.imageRef)` AFTER the assignment (`fix.worker.ts:1095, 1102, 1446`). In the merge path the diff label is `basename(na.imageRef)` (1102) — if `imageRef` now carries the hash, the X-ray sheet-diff label shows `atlas-merged.a1b2c3d4.webp`, which is actually **correct/desirable** (it's the real emitted name). But the pure helper `withHashedImageRef(atlas, basename)` returning a NEW atlas (`{...atlas, imageRef}`) while the worker ALSO needs `na` mutated for `emit*Text(na)` creates two sources of truth. **Resolution:** the worker assigns `na.imageRef = hashFilenames ? basename(emittedImage) : <today's value>` directly (one mutation, as today), and `withHashedImageRef` exists ONLY as the pure test double (it mirrors the assignment for golden testing, never called by the worker). The draft half-acknowledges this ("the existing `na.imageRef = ...` assignment") but then proposes the worker call `withHashedImageRef` (K5 acceptance) — contradictory. Pick the in-place assignment; keep the helper test-only.

### MAJORS

**M1 — The tier loop's multi-format sidecar chain is under-specified and has an ordering trap.** At `:1773` `scaled.imageRef = basename(tierImagePath)` is set INSIDE the per-format loop, then the sidecar is emitted at `:1775/:1786` via `variantManifestName(...)`. Under hashing, each format's image is hashed (its own `enc.bytes`), `scaled.imageRef` patched to the hashed image basename, THEN the sidecar bytes built from `scaled` and hashed. Because `scaled` is mutated per-format in the loop, this is naturally correct ONLY if the hash-image→patch→build-sidecar→hash-sidecar sequence is strictly inside the same iteration (it is). But `tierTargetPaths.push(...)` (`:1797`) recomputes `variantManifestName(...)` a SECOND time — it must push the **hashed** sidecar name, not re-derive the unhashed one. The draft says "consume the hashed names" but `:1797-1803` literally re-calls `variantManifestName`; the implementation must thread the already-hashed `emittedSidecar` local into both the `out.push`, the `recordVariant`, AND `tierTargetPaths` (a `let emittedSidecar` computed once per branch). Same for `tierImagePath` (loose tier → push hashed image).

**M2 — Dedup `relativeImageRef(dir, actual.image)` + hashed owner image: confirm `actual.image` is the EMITTED (hashed) path, not a basename.** Verified: dedup sets `repointed.imageRef = relativeImageRef(dirOf(consumerManifest), actual.image)` (`:1579, 1606`). `actual.image` is set from `r.ownerImage`/`newPath`/`path` at every owner site (`:1208, 1249, 1255, 1267, 1277, 1879`). For hashing to chain correctly into dedup, EVERY one of those assignments must carry the **hashed** owner image path. The draft covers the fan-out (`ownerImage`) and the resize/transcode (`newPath`), but does NOT call out `:1249/:1267` (the two `ownerActualName...image = path` **fallback** assignments on encode-failure/no-context). Those keep the ORIGINAL `path` — which is correct (encode failed, nothing was hashed, the original ships), so they need NO change. This must be stated explicitly (it's a correctness point, not a gap) so the implementer doesn't "fix" them.

**M3 — `dedupedOut` last-write-wins interaction with hashed collisions of IDENTICAL content is fine, but the consumer-`.json` carve-out reasoning needs the hashed-owner-image to survive the in-place rewrite.** The dedup consumer `.json` is re-emitted at its ORIGINAL path (`:1580, 1607`) with `meta.image` → hashed owner image. The draft's §3d is correct, but must note: the consumer `.json` keeping its name means a DIFFERENT consumer `.json` and the owner sheet's OWN `.json` (if the owner is also an atlas that got hashed in K5) are distinct files — no collision. Verified there's no path where the consumer `.json` and an owner `.json` share a name.

**M4 — i18n: the draft's `pixiManifestReceipt`-style key count is honest, but `RESERVED + IGNORED` comment at `fix-protocol.ts:113-115` MUST be rewritten** (it currently says "no UI, no worker wiring") or the wire contract comment lies post-implementation. Also `pixi-manifest.ts:198-209` (the `hashedName` JSDoc) and `index.ts:74` both say "SHIPPED + TESTED but UNUSED in v1 / cache-busting deferred" — these comments become false and must be updated (a doc-drift blocker for the "single source of truth" CLAUDE.md convention).

### Rebuttals (draft claims I verified as CORRECT, keep them)
- `sha256Hex(bytes: ArrayBuffer)` exists at `:2228`, pure WebCrypto — ✓ invariant 1.
- Pixi builder consumes `src` verbatim, no re-derivation (`:160`) — ✓ zero builder churn.
- `meta.image`/`.atlas` line 0 derive from `atlas.imageRef` (`manifest.ts:30,41`) — ✓ patch-before-emit cache-busts the sidecar.
- `replaced`/`dropped` key the ORIGINAL input path (`:1911`) — ✓ additivity bookkeeping untouched.
- Atlases never reach the `format` finding (`rules.ts:224`) — ✓ no atlas-page-transcode sidecar gap (the transcode path treating ref as loose at `:1271` is correct).
- Token survival: `hashedName('ui/btn_720p.webp.json', h)` → `ui/btn_720p.webp.HASH.json` (inserts before last dot) — ✓ H8 correct.
- `encodeCanvas` returns fresh full-buffer `new Uint8Array(...)` — ✓; the `shortHash` defensive slice is belt-and-suspenders and harmless.
- Off ⇒ short-circuit ⇒ `hashedName` never called ⇒ byte-identical — ✓ additivity by construction.

---

## Part B — FINAL REVISED DESIGN (implementation-ready)

### 0. Grounding (re-verified file:line, drift-corrected)

| Fact | Location (current) |
|---|---|
| `hashedName(path, hash)` — insert hash before final ext | `packages/fix/src/pixi-manifest.ts:204-209` |
| `hashedName` exported (with "unused in v1" comment to UPDATE) | `packages/fix/src/index.ts:76` (comment `:74-75`) |
| `hashFilenames?` reserved field (comment "IGNORED in v1" to UPDATE) | `apps/web/src/worker/fix-protocol.ts:113-115` |
| `sha256Hex(bytes: ArrayBuffer)` full-64-hex, WebCrypto | `fix.worker.ts:2228-2231` |
| Pixi builder consumes `src` verbatim | `pixi-manifest.ts:160` |
| `recordVariant(ref, kind, source, v)` (no-op when off) | `fix.worker.ts:618-626` |
| `te = new TextEncoder()` | `fix.worker.ts:130` |
| `emitTexturePackerJson` `meta.image = atlas.imageRef` | `manifest.ts:30` |
| `emitSpineAtlasText` line 0 = `atlas.imageRef` | `manifest.ts:41` |
| Loose fan-out (`ownerImage`/first-emitted-canonical) | `fix.worker.ts:892-940` |
| Loose single resize | `:1217` · single transcode | `:1271` |
| **Resize-ATLAS drop-in (image+sidecar, in place)** ⟵ NEW SITE | `:1158-1189` |
| Repack single atlas | `:1097-1112` · merge page | `:1085-1095` |
| Spine repack | `:980-983` · packed Spine multi-page | `:1433-1460` |
| Pack static page | `:1432-1442` |
| Tier loop (image `:1760`, atlas sidecar `:1786`, spine sidecar `:1775`, skeleton `:1781`, `tierTargetPaths` `:1797`) | `:1699-1810` |
| Dedup repoint (`relativeImageRef(dir, actual.image)`) | `:1579, 1606` |
| `ownerActualName.image` set sites | `:1208, 1249(fallback), 1255, 1267(fallback), 1277, 1879` |
| Pass-through (re-emit + record loose) | `:1910-1915` |
| `looseRefByPath` (manifest collector reverse-index) | `:1905-1909` |
| Dedup tail → `dedupedOut` → Pixi manifest → `makeZip` | `:1920-1943` |
| `pickManifestPath` (manifest.json stable name) | `:113-121` |
| `manifestPathByImage` (silently skips unparseable JSON ⇒ B2) | `:189-198` |
| Atlases never reach `format` finding | `packages/analysis/src/rules.ts:224` |

### 1. Scope

**In scope** — append `.<8hex>` before the final extension of every emitted asset byte stream **plus** every referrer AD owns, with the image→`imageRef`→sidecar→hash ordering enforced. Sites: loose single resize/transcode, loose fan-out, **resize-atlas drop-in (NEW)**, repack-single, merge pages, pack static pages, pack/repack Spine `.atlas`, tier loop (loose/atlas/spine × tier × format, skeleton copies excluded), dedup-repointed `meta.image` (via hashed owner image). Hash = `sha256Hex(finalBytes).slice(0,8)`. UI toggle, 2 i18n keys, comment-drift fixes.

**Out of scope (carve-outs, documented in the UI hint + the wire comment):**
- `manifest.json` itself (the stable entrypoint — `pickManifestPath`).
- Spine **skeleton** `.json`/`.skel` (referenced by runtime convention, no writable link AD patches; tier-suffixed copies at `:1781` keep their names).
- Dedup **consumer `.json`** (kept at its original name to preserve B1 "no load-call change"; its `meta.image` IS repointed to the hashed owner image — the image is busted, the sidecar name is stable).
- **Pass-through loose images when `emitPixiManifest` is OFF** (B2: no AD-owned referrer to patch). Hashed ONLY when `emitPixiManifest` is on AND the image is recorded in the manifest.
- Pass-through **non-asset** files (README/font/audio/unparsed-JSON) — never hashed.
- `drop` rows — no successor.
- Backend / HTTP headers (user wires CDN immutable headers; invariant 1/2).

### 2. Deterministic hashing

```ts
const HASH_LEN = 8;
const shortHash = async (bytes: Uint8Array): Promise<string> =>
  (await sha256Hex(
     bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
       ? bytes.buffer
       : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
   )).slice(0, HASH_LEN);
const hashOn = opts.hashFilenames === true;
```
- Hash is of the **FINAL emitted bytes** (honesty anchor) — never input, never a guessed name.
- 8 hex = 32 bits; dir+stem preserved by `hashedName` make a real collision negligible; §6 handles it deterministically regardless.
- No `Date.now`/`Math.random`; `dedupedOut` is first-appearance-order-preserving; Pixi builder totally re-sorts ⇒ same input ⇒ same names ⇒ byte-identical zip.

### 3. Reference-chaining order (the cardinal rule)

> A referenced file's hash is computed from its FINAL bytes BEFORE its name is consumed by any referrer; a sidecar is hashed AFTER it embeds the hashed name of what it points at.

**3a. Loose image** (single resize `:1217`, single transcode `:1271`, fan-out `:919`) — no sidecar:
```
enc = encode(...)                                   // final bytes
h   = await shortHash(enc.bytes)                    // ONLY inside if(hashOn)
emittedPath = hashOn ? hashedName(newPath, h) : newPath
out.push({ path: emittedPath, bytes: enc.bytes })
recordVariant(ref, 'loose', srcPath, { ..., src: emittedPath })
changeRows.push(looseRenameChange(srcPath, emittedPath, kind))   // from=ORIGINAL, to=hashed
replaced.add(srcPath)                               // UNCHANGED — keys the ORIGINAL input path
```
Fan-out: hash each format from its own `enc.bytes`; the first-emitted canonical (`ownerImage`) and every `ownerActualName.image` assignment carry the HASHED `variantPath` (dedup-repoint resolves to the real file).

**3b. Static atlas sheet** (image→`meta.image`→sidecar) — repack-single `:1097`, merge `:1085`, pack `:1432`, **resize-atlas `:1158` (NEW)**:
```
sheet = composePageEncode(...) | convertToBlob(...)   // final IMAGE bytes
imgHash     = await shortHash(sheet.bytes)
emittedImage = hashOn ? hashedName(imagePath, imgHash) : imagePath
na.imageRef = hashOn ? basename(emittedImage) : <today's imageRef value>   // ONE in-place mutation
out.push({ path: emittedImage, bytes: sheet.bytes })
jsonBytes   = te.encode(emitTexturePackerJson(na))    // sidecar now embeds hashed meta.image
jsonHash    = await shortHash(jsonBytes)
emittedJson = hashOn ? hashedName(manifestPath, jsonHash) : manifestPath
out.push({ path: emittedJson, bytes: jsonBytes })
recordVariant(ref, 'atlas', emittedImage, { ..., src: emittedJson })
// loader-migration: mergedManifestPaths/packManifestPaths.push(emittedJson); ...PageImages.push(emittedImage)
```
- `withHashedImageRef` is **test-only** (B3): the worker mutates `na.imageRef` in place exactly as today, just with the hashed basename.
- `captureSheetDiff(..., basename(na.imageRef) | basename(emittedImage), ...)` will display the hashed name — that's the real emitted file (correct).
- **resize-atlas (`:1158`):** keeps source format today; under hashing it becomes a reference-changing event. Add a `looseRenameChange`-equivalent — but resize-atlas currently emits NO `FixChange` (it's drop-in). So under `hashOn`, set `referencesChanged = true` and emit a `mergeChanges`/`setChanges`-shaped row (`from`=original `.json`, `to`=[hashed `.json`], `pageImages`={hashed json→hashed image}, kind `'resize'`). Document that hashing demotes the resize-atlas drop-in to reference-changing (truthful — the filename changed).

**3c. Spine `.atlas`** (line 0 patch) — Spine repack `:980`, packed multi-page `:1433/1456`, tier `:1775`:
```
enc = composePageEncode(..., 'image/png', ...)        // Spine pages stay PNG
imgHash = await shortHash(enc.bytes)
emittedImage = hashOn ? hashedName(imagePath, imgHash) : imagePath
na.imageRef  = hashOn ? basename(emittedImage) : <today>   // patches the .atlas texture line
out.push({ path: emittedImage, bytes: enc.bytes })          // (pack: emitted.push)
atlasBytes  = te.encode(emitSpineAtlasText(na))            // (pack: spineBlocks.push BEFORE assembling)
atlasHash   = await shortHash(atlasBytes)                  // pack: hash the JOINED bytes at :1456
emittedAtlas = hashOn ? hashedName(info.path, atlasHash) : info.path
out.push({ path: emittedAtlas, bytes: atlasBytes })
recordVariant(ref, 'spine', emittedImage, { ..., src: emittedAtlas })
```
Packed multi-page: each page image hashed + its `na.imageRef` patched BEFORE `spineBlocks.push(emitSpineAtlasText(na))` at `:1436`; the concatenated `.atlas` (`:1456`) hashed last from final joined bytes. Skeleton copies (`:1781`) NOT hashed.

**3d. Dedup-repointed consumer** (`:1579, 1606`): consumer `.json` keeps its ORIGINAL name; `meta.image = relativeImageRef(dir, actual.image)` where `actual.image` is the HASHED owner image (set in 3a/3b). The two fallback assignments (`:1249, :1267`) keep the ORIGINAL `path` (encode failed ⇒ nothing hashed ⇒ correct, NO change). M2.

**3e. Tier loop** (`:1699-1810`): per (tier×format) iteration — hash `enc.bytes` → `let emittedImage = hashOn ? hashedName(tierImagePath, h) : tierImagePath` → `out.push(emittedImage)`; if `scaled`, `scaled.imageRef = hashOn ? basename(emittedImage) : basename(tierImagePath)` → build sidecar bytes → hash → `let emittedSidecar = hashOn ? hashedName(variantManifestName(...), sh) : variantManifestName(...)`. Thread `emittedSidecar` into `out.push`, `recordVariant`, AND `tierTargetPaths.push` (M1 — compute ONCE, never re-derive). Loose tier branch threads `emittedImage`. Skeleton untouched.

### 4. How `src[]` + FixChange/loader-migration pick up hashed names
Zero builder change — the worker passes HASHED paths as `src` into `recordVariant`; `buildPixiManifest` lists them verbatim (`:160`); the alias still derives from the unhashed `ref` (`:150-151`) so `Assets.load('ui/hud')` resolves the hashed URL. `FixChange` rows are built from the emitted (hashed) `newPath`/`tierTargetPaths`/`merged*`/`pack*` paths; `pageImages[hashedJson]=hashedImage` drives Phaser's `this.load.atlas(key, hashedImage, hashedJson)`. `looseRenameChange.from` stays the ORIGINAL (the `// was:` comment), `to` is hashed.

### 5. UI (`App.tsx`)
- State beside `emitPixiManifest` (`:992`): `const [hashFilenames, setHashFilenames] = useState(false);`
- Checkbox under the Pixi-manifest label (`:1236-1241`), same styling, `title={t('fix.hashFilenamesHint')}`, label `{t('fix.hashFilenames')}`.
- `buildOptions` (`:1090`): `hashFilenames: hashFilenames || undefined,`
- Deps array (`:1153`): append `hashFilenames`.
- Optional receipt note gated on a new `receipt.hashedFilenames?: boolean` ("Filenames content-hashed — serve with immutable headers"). No fabricated count (every emitted asset is busted; describe in the hint).

### 6. Edge cases
1. **Merged/multi-page/pack** — each page hashes its own image then sidecar; distinct `ref` per page ⇒ no alias collision.
2. **resize-atlas drop-in → reference-changing under hash** (B1) — surfaced honestly via `referencesChanged` + a loader row.
3. **Pass-through** — parsed loose hashed ONLY when `emitPixiManifest` on AND recorded (B2); else kept; non-asset never hashed; `replaced`/`dropped` key original `f.path`.
4. **Collisions** — `dedupedOut` last-write-wins by path. Identical bytes + identical stem ⇒ same hash ⇒ collapse to one entry (correct, true dup). Different bytes colliding at the same stem (8-hex, ~1e-9): keep a `Set<string>` of emitted hashed paths; on a collision with DIFFERENT bytes, fall back to a 12-hex slice for the colliding file + a `skipped[]` note. Deterministic, never silently clobbers.
5. **Single-format tier** (`formatToken=''`): `variantManifestName`→`_540p.json`; `hashedName`→`_540p.HASH.json` (token preserved, T13/H8).
6. **AVIF→WebP→PNG fallback** — hash from post-fallback `enc.bytes`, `hashedName(newPath,h)` on the post-fallback ext ⇒ never names a non-existent file.
7. **Same-mime fan-out collision** (`:914, :1754`) — skipped before `out.push`, no hash computed.
8. **Off / no-op / empty** — short-circuit, nothing hashed; Pixi `size>0` gate unaffected.

### 7. Determinism + additivity
- Every site: `emitted = hashOn ? hashedName(p, h) : p`; when off, `hashedName` is never called (`&&` short-circuit), `na.imageRef` keeps today's value, `await shortHash` never runs (off path's async shape identical to today), `recordVariant`/`FixChange`/`out.push` get today's paths ⇒ `dedupedOut` identical ⇒ `makeZip` input identical ⇒ **zip byte-identical**.
- On: `sha256Hex` pure of bytes ⇒ identical bytes ⇒ identical 8-hex ⇒ identical names ⇒ identical zip. Honesty anchor: name = fingerprint of what ships (re-encode same source/options ⇒ same name, cache warm; any byte change flips it). Naming only — sums nothing into VRAM/disk (invariant 5).

### 8. Invariants
Inv1: WebCrypto `sha256Hex`, pure, in-browser, no native/network. Inv2: nothing server-side. Inv3: hashing only in the fix engine; names reflect real emitted bytes; never names a non-existent file; dedup's no-load-call-change preserved (consumer `.json` name stable); B2 prevents un-patchable renames. Inv4: Phase-2, off the diagnosis path. Inv5: naming only, no footprint claim. Additivity: §7.

### 9. Test plan (`packages/fix/test`, no worker e2e)
Pure helper `withHashedImageRef(atlas, hashedImageBasename): Atlas` (test double mirroring the worker's `na.imageRef = basename(emittedImage)`) in a new `packages/fix/src/cache-bust.ts`, exported. New `packages/fix/test/cache-bust.test.ts`:

| # | Asserts |
|---|---|
| H2 | `withHashedImageRef` patches `meta.image` only (`emitTexturePackerJson` out has hashed `meta.image`, frames byte-identical) |
| H3 | Spine: line 0 of `emitSpineAtlasText` = hashed PNG; regions unchanged |
| H4 | Chain order: hashing the patched `.json` ≠ hashing the unpatched (sidecar hash depends on embedded image hash — ordering load-bearing) |
| H5 | Determinism: identical bytes ⇒ identical `hashedName`; same atlas+image twice ⇒ same names |
| H6 | Pixi builder lists hashed `src` verbatim; alias from unhashed `ref` |
| H7 | `looseRenameChange(orig, hashed, 'transcode')` → `from:orig, to:[hashed]`; `setChanges` with hashed manifest+pageImages → `pageImages[hashedJson]===hashedImage` (feeds `loader-migration.test.ts`) |
| H8 | `hashedName(variantManifestName('ui/btn.json','_720p','image/webp',true), h)` === `ui/btn_720p.webp.HASH.json` |

Manual byte-identity footer (mirroring `pixi-manifest.test.ts` / `export-profile-fanout.test.ts`): loose + TP atlas + Spine; OFF→zip A, ON→zip B; B's assets carry `.HASH.`, every sidecar's `meta.image`/`.atlas` line 0 points at the hashed image that exists; OFF ⇒ B==A byte-for-byte (structural guarantee: short-circuit when off).

### 10. Ordered task breakdown (small commits)

| ID | Title | Files | Deps | Acceptance |
|---|---|---|---|---|
| **K0** | Comment-drift fixes (M4) | `fix-protocol.ts:113-115`, `pixi-manifest.ts:198-209`, `index.ts:74-75` — rewrite "RESERVED/IGNORED/UNUSED in v1" to "wired by hashFilenames" | — | No code change; comments truthful post-feature. |
| **K1** | Pure test-double helper + export | `packages/fix/src/cache-bust.ts` (new) `withHashedImageRef`; `index.ts` export | — | `--filter @asset-doctor/fix typecheck` green; pure (no canvas/Date/random). |
| **K2** | Pure unit tests | `packages/fix/test/cache-bust.test.ts` (H2-H8) | K1 | `--filter @asset-doctor/fix test` green. |
| **K3** | Worker hash util | `fix.worker.ts` — `HASH_LEN`, `shortHash`, `hashOn` flag (+ emitted-hashed-path `Set` for §6.4) | K1 | Web typecheck green; unused when off (no behavior change). |
| **K4** | Loose-image hashing | `fix.worker.ts` `:919-936` (fan-out incl. `ownerImage`/`ownerActualName.image`), `:1217`, `:1271` (+`ownerActualName.image` at `:1277`); leave `:1249/:1267` fallbacks unchanged (M2) | K3 | OFF: byte-identical. ON: loose `.HASH.ext`; `looseRenameChange.to` + Pixi `src` hashed. |
| **K5** | Static-atlas chain (incl. NEW resize-atlas B1) | `fix.worker.ts` repack-single `:1097`, merge `:1085`, pack static `:1432`, **resize-atlas `:1158-1189`**; feed `merged*`/`pack*` + new resize-atlas loader row | K3,K1 | ON: `meta.image`=hashed image, `.json` hashed, `recordVariant.src`+`pageImages` hashed, resize-atlas flips `referencesChanged`+emits a row. OFF: byte-identical. |
| **K6** | Spine chain | `fix.worker.ts` Spine repack `:980`, packed multi-page `:1433/1456` (patch line 0 before `spineBlocks.push`; hash joined `.atlas` last) | K3,K1 | ON: line 0=hashed PNG, `.atlas` hashed, PNG preserved. OFF: byte-identical. |
| **K7** | Tier-loop chain (M1) | `fix.worker.ts` `:1760` image, `:1775/:1786` sidecar, `:1797` `tierTargetPaths` — thread `emittedImage`/`emittedSidecar` computed ONCE; skeleton `:1781` NOT hashed | K3,K1 | ON: each (tier×format) image+sidecar hashed once; `recordVariant`+`tierChanges` hashed; token preserved. OFF: byte-identical. |
| **K8** | Dedup carve-out + pass-through gate (B2) | `fix.worker.ts` confirm dedup `meta.image`→hashed owner via `ownerActualName.image` (set in K4/K5); pass-through `:1910-1915` hash loose ONLY when `manifestOn && looseRef` | K4,K5 | Dedup: no load-call change (B1), owner image busted, consumer `.json` name stable. Pass-through loose hashed only with manifest referrer; else kept. |
| **K9** | UI toggle | `App.tsx` state `:992`, checkbox `:1236-1241`, `buildOptions` `:1090`, deps `:1153` | K3 | Default off; omitted when off; pairs with `emitPixiManifest`. |
| **K10** | i18n keys | `packages/i18n/src/catalogs/{en,ru,de,es,pt,fr,it,zh,hi}.json` — `fix.hashFilenames`, `fix.hashFilenamesHint` (en source) | K9 | i18n drift/baked test green; 9 catalogs; CLI EN. |
| **K11** | Manual byte-identity footer + optional receipt | `cache-bust.test.ts` footer; optional `receipt.hashedFilenames?` + `App.tsx` receipt line | K4-K10 | Footer documents OFF==today / ON busts names+chains. |

**Commit grouping:** K0 (comment-drift) · K1+K2 (pure helper+tests) · K3 (worker util) · K4 (loose) · K5 (static atlas incl. resize-atlas) · K6 (Spine) · K7 (tiers) · K8 (dedup+pass-through gate) · K9+K10 (UI+i18n) · K11 (docs/receipt).

### Suggested i18n copy (en source)
```json
"fix.hashFilenames": "Content-hash filenames (cache-busting)",
"fix.hashFilenamesHint": "Renames every emitted image/sheet AD references to name.<hash>.ext (hash = sha256 of the final bytes) so you can serve the optimized folder with immutable long-cache headers. Sheet .json/.atlas sidecars are repointed to the hashed image, then hashed themselves; the loader-migration snippet (and the PixiJS manifest.json, if emitted) reference the hashed names. The skeleton, manifest.json, and loose images with no AD-owned referrer keep stable names. Off ⇒ today's filenames (byte-identical)."
```

---

## Summary of changes from the draft
1. **B1 (blocker):** added the resize-atlas drop-in site (`:1158-1189`) to the static-atlas chain, with an explicit note that hashing demotes it from drop-in to reference-changing.
2. **B2 (blocker):** pass-through loose images hashed ONLY when `emitPixiManifest` is on (a guaranteed AD-owned referrer); otherwise kept — closes the 404-via-unparsed-manifest/game-code reference chain the draft called "safe".
3. **B3 (blocker):** `withHashedImageRef` is test-only; the worker mutates `na.imageRef` in place (one source of truth) — resolves the draft's K5-acceptance contradiction.
4. **M1:** tier loop computes `emittedImage`/`emittedSidecar` ONCE and threads them into `out.push`/`recordVariant`/`tierTargetPaths` (no re-derivation via a second `variantManifestName` call).
5. **M2:** the two `ownerActualName.image = path` fallbacks (`:1249, :1267`) explicitly stay unchanged (encode-failed ⇒ nothing hashed).
6. **M4 / K0:** added a commit to fix the now-false "reserved/unused in v1" comments (CLAUDE.md single-source-of-truth convention).
7. Kept the draft's correct core: image-first chaining, zero Pixi-builder churn, short-circuit additivity, 8-hex from `sha256Hex`, the pure-test-surface strategy, the manifest/skeleton/consumer-`.json` carve-outs.