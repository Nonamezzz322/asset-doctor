`recordVariant(ref, kind: ManifestAssetKind, source, v)`. The draft calls `recordVariant(ref, isSpine ? 'spine' : 'atlas', emittedPage, { scale: 1, suffix: '', src: emittedSidecar })`. Note: the resize-atlas path uses `source = emittedImage` (the page) and `src = emittedJson` (the sidecar). The draft uses `source = emittedPage` and `src = emittedSidecar` — consistent. But importantly, resize-atlas gates `recordVariant` on `hashOn`. For transcode, the page name ALWAYS changes (ext change), so recordVariant should fire **unconditionally** — which the draft does. But this is a behavioral asymmetry the draft should call out: resize-atlas adds to the Pixi manifest only under hashOn, while transcode-atlas adds always. That's correct (the manifest must reflect the renamed page), but worth an explicit note.

I have thoroughly verified the premise. Let me compile the final revised mini-design.

---

# Mini-Design (REVISED): Prebuilt-Atlas Passthrough Transcode

**Closes a dangling-reference correctness bug in the fix engine's transcode branch.**

## VERDICT: Premise TRUE. Feature is real, scoped, and mostly correct as drafted. Two blockers, three majors fixed below. Task breakdown preserved.

---

## 0. The bug — VERIFIED TRUE against code

- `analyze.ts:135-168` — `addFormat(atlas.name, image, 'unknown')` runs `formatFinding` (via `deps.encodeImage`) on **atlas page images**. A measured-smaller WebP/AVIF earns a `format` finding on the page. CONFIRMED.
- `plan.ts:339-368` (pass-2 transcode) guards only `resized`/`dropped`/`packed`/`tiered` — **no atlas exclusion**. CONFIRMED. Emits `{kind:'transcode', assetRef: <page>, …}`.
- `fix.worker.ts:2109` profile-fanout guards `!atlasByRef.has(ref)` and falls through. `fix.worker.ts:2147-2213` single-format path calls `transcode()` → `renamedTo(path, enc.mime)` → `out.push` → `recordVariant(ref,'loose',…)` → `looseRenameChange`. It **never** consults `manifestPathOf`/`spineInfoOf`, **never** re-emits the sidecar, **never** repoints `meta.image`. CONFIRMED.
- **Net:** a fully-packed (high-occupancy, low-waste) + correctly-sized (POT, not oversize) PNG atlas trips none of `occupancy`/`wasted-regions`/`frame-redundancy`/`dimensions-oversize` (verified pass-1 triggers at `plan.ts:292-324`), so pass-2 transcode is the **only** op → page ships as `sheet.webp` while `sheet.json`'s `meta.image` still says `"sheet.png"` → **dangling reference / broken drop-in**. Dormancy explanation is exactly right.
- **Fix shape is sound:** the resize-atlas branch (`fix.worker.ts:1966-2035`) is the correct template — it re-emits the sidecar — but it does so because resize KEEPS the source format (`srcMime = mimeOf(path)`, line 1979) so `meta.image` stays valid; transcode CHANGES the extension so the sidecar MUST be repointed.

---

## 1. BLOCKERS (must fix before implementation)

### B1 — KTX2 candidate for a Spine atlas is malformed (draft §4 ships a broken `.ktx2.json`)

The draft records a KTX2 candidate **unconditionally** (both TP and Spine) with `atlasSidecar: { path: emittedSidecar, atlas: repointed }`. But the KTX2 post-pass (`fix.worker.ts:3228-3239`) **hardcodes TexturePacker**: it does `c.atlasSidecar.path.replace(/\.json$/i, '.ktx2.json')` and `emitTexturePackerJson(ktx2Sidecar)`. For a Spine `.atlas` sidecar this:
- produces a malformed sibling path (`.atlas` is not replaced → `sheet.atlas` literal, not `sheet.ktx2.json`), and
- emits **TexturePacker JSON for a Spine atlas** (wrong format entirely).

Evidence: the existing Spine repack path (`fix.worker.ts:1633-1637`) **deliberately records NO KTX2 candidate** — KTX2 candidates are only ever recorded for TP `.json` atlases (`1821`, `1877`, the loose `2082`/`2189`). 

**FIX:** record the KTX2 candidate only for the **TexturePacker (non-Spine)** case, mirroring existing practice. Guard `recordKtx2Candidate` inside `if (!isSpine)`.

### B2 — `transcodeIsSizeLoss` does NOT guard a non-opaque atlas transcode (draft §6 over-claims)

`transcode-guard.ts:19`: `return opaque === true && reencodedBytes >= sourceBytes;` — for a **non-opaque** transcode (the common prebuilt-atlas PNG→WebP case) this is **always `false`**. The draft's §6 claim "guard reused so an opaque/no-win re-encode never ships a larger page" is true only for the opaque sub-case. For the headline case there is **no size-loss guard at all**.

For loose images that's intentional (comment `transcode-guard.ts`: a format change "is a legitimate format choice handled by the downstream dedup/Phase-C accounting"). But an atlas page transcode that re-emits a sidecar has **no such downstream accounting**, and worse, an atlas page transcode is gated by a `format` finding that **already measured WebP/AVIF strictly smaller** (`rules.ts:511-516`, `frac < cfg.formatSaving.warn` ⇒ no finding) — so in practice the re-encode is smaller. Still, the worker's actual encoder is not the analysis-time sizer, so a regression (worker produces a larger file than the page) is possible.

**FIX:** keep the existing `transcodeIsSizeLoss` opaque guard for parity, AND add an honest **general** size check for the atlas path: if `enc.bytes.length >= bytes.byteLength`, KEEP the original page + original sidecar (no `out.push`, no rename) and surface a `skipped[]` note. This is the *minimum* to honor "the fix that fixes dangling refs never creates a dangling ref by shipping a worse page." Re-word §6 accordingly (do not claim `transcodeIsSizeLoss` covers the non-opaque case).

---

## 2. MAJORS (fix; not architecture-breaking)

### M1 — "Mirror the resize-atlas recordVariant/repackChanges sites verbatim" is WRONG (they are `hashOn`-gated)

resize-atlas gates `recordVariant`/`repackChanges`/`referencesChanged` on **`hashOn`** (`fix.worker.ts:1998-2033`) because resize-atlas is a stable-name drop-in today (not in the manifest, no migration row) and must stay byte-identical when hashing is off. **Transcode is the opposite**: the page name ALWAYS changes (extension change), so these MUST fire **unconditionally**. The draft's code does fire them unconditionally (correct), but the prose "mirror … verbatim" is misleading and will trip an implementer into copying the `if (hashOn)` gate. **FIX: state explicitly "do NOT gate on hashOn — a transcode always renames the page, so recordVariant/repackChanges/referencesChanged fire unconditionally."**

### M2 — "Frames/trim/pivot/mesh copied byte-identically" overstates fidelity

The sidecar is **regenerated** via `emitTexturePackerJson`/`emitSpineAtlasText`, not byte-copied. `emitTexturePackerJson` (`manifest.ts:7-36`) emits a **fixed** meta set (`app`, `version`, `image`, `size`, optional `format`/`scale`) — any other original `meta` field (e.g. `smartupdate`, custom keys) is **dropped**. Frame-level fields (frame/rotated/trimmed/spriteSourceSize/sourceSize/pivot/mesh) ARE preserved. This is identical to what resize-atlas already does, so it is acceptable for v1 — but the claim must read "frame geometry (frame/trim/pivot/mesh) is preserved; the sidecar is deterministically re-serialized (non-frame meta extras are not round-tripped, same as resize-atlas)."

### M3 — Atlas-page dedup-owner interaction is real and under-specified

Verified `buildDedupGroups` (`dedup.ts:73-167`) groups by `f.contentHash` over **all** supplied `features` keyed by `assetRef` — atlas page refs included. So **an atlas page CAN be a dedup owner**, and the draft's owner-aware lines are LIVE (not dead). The draft correctly adds:
```ts
if (ownerActualName.has(ref)) { ownerActualName.get(ref)!.image = emittedPage; ownerActualUnhashed.set(ref, newPage); }
```
This is necessary and matches the loose path (`fix.worker.ts:2202-2205`). **Residual risk (call out + test):** when an atlas page is a dedup owner, Phase-C repoints *consumer* manifests at the owner's `image`; the owner now ALSO re-emits its own sidecar in the new block. The resize-atlas path does NOT set `ownerActualName` at all (a latent gap there), so the new block is strictly *more* correct. Keep the lines; add a Harness-C case where the transcoded atlas page is a dedup owner and assert consumers repoint at the emitted page name (not the original).

---

## 3. Confirmed-correct draft claims (no change)

- All imports exist: `emitTexturePackerJson`/`emitSpineAtlasText` (`fix.worker.ts:48-49`), `dirOf`/`relativeImageRef`/`renamedTo` (`101/103/108`), `repackChanges`/`looseRenameChange` (`171/168` from `../lib/loader-migration`), `transcodeIsSizeLoss` (`177`), `atlasByRef`/`spineRefs`/`manifestPathOf`/`spineInfoOf`/`recordVariant`/`recordKtx2Candidate`/`effectiveForTranscode`/`encOptsFor`/`hashEmit`/`te`/`basename` all present.
- `relativeImageRef(dirOf(sidecar), emittedPage)` is the proven inverse of the parser's `resolveImageRef` (`dedup-repoint.ts:27-41`); same call shape the KTX2 post-pass uses (`3231-3234`). Same-dir collapses to basename; cross-dir handled.
- `repackChanges(oldManifest, newManifest, pageImage?)` (`loader-migration.ts:68`): 3-arg for TP (maps `.json`→page, gated by `ATLAS_EXT` at `setChanges`), 2-arg for Spine (`.atlas` carries no page map). Draft's `isSpine ? repackChanges(2-arg) : repackChanges(3-arg)` is correct.
- Multi-page Spine guard via `spineInfoOf(ref).pages` (`fix.worker.ts:341-357`): each page maps to the same `.atlas` with `pages: pages.length`; `parseSpinePage` (`parsers/spine-atlas.ts:169`) yields **one Atlas per page**, so `emitSpineAtlasText(singlePageAtlas)` would drop siblings — the `pages > 1 ⇒ skip` guard is REQUIRED and correct.
- `transcode()` forces `allowPngFallback:false` (`fix.worker.ts:3727`) ⇒ failed AVIF/WebP returns `null` ⇒ honest skip; `enc.mime` is the real emitted mime ⇒ `renamedTo` matches. §8.2 correct.
- Test premise is REAL: `analyze` takes `deps.encodeImage` (`analyze.ts:136`); a differentiating mock makes `formatFinding` fire on the atlas page; `planFix` then emits exactly one transcode op and no repack/resize (pass-1 triggers verified). Harness A reproduces the defect through the real audit path.
- Determinism: both emitters sort by name, fixed key order, no timestamps; `relativeImageRef` is pure path math; `hashEmit` content-hash deterministic. No `Date.now`/`Math.random`.

---

## 4. Contract / type changes

**None.** Purely additive worker logic + (optional) one pure helper re-exported from `@asset-doctor/fix`. No `core` change.

---

## 5. Pure module (recommended) — `packages/fix/src/atlas-transcode.ts`

```ts
import type { Atlas } from '@asset-doctor/core';
import { dirOf, relativeImageRef } from './dedup-repoint';
/** Repoint a parsed atlas's imageRef at a re-encoded page in the SAME dir (only the extension changes on a
 *  passthrough transcode). Routes through relativeImageRef(dirOf(sidecar), newPagePath) so cross-dir +
 *  cache-bust naming resolve back through parseAtlas — the proven inverse of resolveImageRef. */
export function repointAtlasImage(atlas: Atlas, sidecarPath: string, newPagePath: string): Atlas {
  return { ...atlas, imageRef: relativeImageRef(dirOf(sidecarPath), newPagePath) };
}
```
Re-export from `packages/fix/src/index.ts`. (If zero-new-files preferred, inline exactly as the dedup Phase-C does at `fix.worker.ts:~2636`.)

---

## 6. Worker change — `fix.worker.ts`, transcode branch, inserted after the profile-fanout block (after `~2142`, before the loose single-format path at `~2143`)

```ts
const atlas = atlasByRef.get(ref);
if (atlas) {
  // ── Prebuilt-atlas passthrough transcode: re-encode the page verbatim, repoint its sidecar.
  // NO recompose/repack — frame geometry (frame/trim/pivot/mesh) is preserved; the sidecar is
  // deterministically RE-SERIALIZED (non-frame meta extras are not round-tripped, same as resize-atlas).
  // Only the page ENCODING (and therefore its extension) changes ⇒ meta.image MUST be repointed or it dangles.
  const isSpine = spineRefs.has(ref);
  const sidecar = isSpine ? spineInfoOf(ref)?.path : manifestPathOf(ref);
  if (!sidecar) {
    skipped.push({ assetRef: ref, reason: 'transcode skipped: atlas sidecar unavailable — kept original page' });
    continue;
  }
  if (isSpine && (spineInfoOf(ref)?.pages ?? 1) > 1) {
    skipped.push({ assetRef: ref, reason: 'transcode skipped: multi-page Spine atlas — kept original page' });
    continue;
  }
  // M1 honest note: an active multi-format profile can't safely fan an atlas page across N sidecar entries.
  if (profileOn && resolveProfile(ref).formats.length > 1)
    skipped.push({ assetRef: ref, reason: 'export profile: atlas pages stay single-format — emitted one page only' });

  const eff = effectiveForTranscode(ref, op.targetMime);
  const enc = await transcode(bytes, eff.targetMime, { ...encOptsFor(eff, false), opaque: op.opaque });
  if (!enc) { skipped.push({ assetRef: ref, reason: `transcode to ${eff.targetMime} unavailable` }); continue; }
  // B2: never ship a worse page from the fix that fixes dangling refs. Opaque guard (parity) + general
  // size guard for the atlas path (no downstream dedup/Phase-C accounting absorbs a larger atlas page).
  if (transcodeIsSizeLoss(op.opaque, enc.bytes.length, bytes.byteLength) || enc.bytes.length >= bytes.byteLength) {
    skipped.push({ assetRef: ref, reason: `transcode kept original: re-encode was not smaller (${enc.bytes.length} ≥ ${bytes.byteLength} B)` });
    continue;
  }

  const newPage = renamedTo(path, enc.mime);
  const emittedPage = await hashEmit(newPage, enc.bytes);
  out.push({ path: emittedPage, bytes: enc.bytes });
  replaced.add(path);

  // Repoint the sidecar at the new page (relative to the SIDECAR's own dir → resolves back through parseAtlas).
  const repointed: Atlas = { ...atlas, imageRef: relativeImageRef(dirOf(sidecar), emittedPage) };
  const sidecarBytes = te.encode(isSpine ? emitSpineAtlasText(repointed) : emitTexturePackerJson(repointed));
  const emittedSidecar = await hashEmit(sidecar, sidecarBytes);
  out.push({ path: emittedSidecar, bytes: sidecarBytes });
  replaced.add(sidecar);

  // M1: a page-format change ALWAYS renames the page ⇒ NOT drop-in ⇒ fire these UNCONDITIONALLY
  // (do NOT copy resize-atlas's `if (hashOn)` gate — resize keeps the source ext, transcode does not).
  referencesChanged = true;
  recordVariant(ref, isSpine ? 'spine' : 'atlas', emittedPage, { scale: 1, suffix: '', src: emittedSidecar });
  changeRows.push(...(isSpine ? repackChanges(sidecar, emittedSidecar) : repackChanges(sidecar, emittedSidecar, emittedPage)));

  // M3: if this atlas page is a retained dedup OWNER, record its ACTUAL emitted image so Phase-C repoints
  // consumers at the real page (no-op when not an owner). Mirrors the loose transcode at :2202-2205.
  if (ownerActualName.has(ref)) { ownerActualName.get(ref)!.image = emittedPage; ownerActualUnhashed.set(ref, newPage); }

  // B1: KTX2 candidate ONLY for TexturePacker atlases — the post-pass (:3228-3239) hardcodes
  // emitTexturePackerJson + /\.json$/ replacement, so a Spine .atlas sidecar would ship malformed.
  if (!isSpine)
    recordKtx2Candidate({ ref, imagePath: emittedPage, pageBytes: enc.bytes, pageMime: enc.mime,
      w: atlas.size.w, h: atlas.size.h, atlasSidecar: { path: emittedSidecar, atlas: repointed } });

  vramSaved += 0; // DISK-only: identical pixel dims ⇒ identical RGBA8888 VRAM (invariant 5). No VRAM claim.
  operations.push(`transcode atlas ${basename(ref)} → ${enc.mime.replace('image/', '')}`);
  continue;
}
```
The loose single-format path (`~2143-2213`) is left **untouched** — now reached only for non-atlas refs.

---

## 7. UI / backend changes

**None.** Receipt already surfaces `operations[]`/`skipped[]`/`referencesChanged`/`changes[]` + Pixi manifest. KTX2 path reused, gated by `backendOn` (no-op otherwise). No new i18n (EN audit-trail text, consistent with siblings).

---

## 8. Honesty + invariant compliance

- **Inv 1/2:** all pixel work in the worker; no asset leaves device; backend KTX2 stays opt-in/consented.
- **Inv 3:** op derives from a MEASURED `format` finding; the fix re-encodes existing pixels + rewrites a path. Nothing invented.
- **Inv 5:** identical pixel dims ⇒ identical RGBA8888 VRAM. `vramSaved += 0`; headline saving is the measured disk delta only. No VRAM claim.
- **B2 size guard:** the fix that closes dangling refs never ships a larger atlas page (general + opaque guard); on loss it keeps the original page AND original sidecar → no dangling ref created.
- **Fail-safe:** missing sidecar / multi-page Spine ⇒ keep original page + honest skip.

---

## 9. Determinism

Both emitters sort frames by name, fixed key order, no timestamps ⇒ byte-identical sidecars. `relativeImageRef` pure path math. `hashEmit` content-hash deterministic (OFF ⇒ stable names). Op order = plan's deterministic order. No `Date.now`/`Math.random`.

---

## 10. Edge cases

1. **Target == source mime:** `formatFinding` can't pick the source mime (`rules.ts:509` skips `target===image.mime`; AVIF early-return `:506`), and `bestMime` inherits that ⇒ `newPage ≠ path`. B2 guard covers any degenerate same-mime fallback.
2. **PNG-fallback off in `transcode()`** (`:3727`) ⇒ failed encode ⇒ `null` ⇒ honest skip; `enc.mime` is the real emitted mime.
3. **Cross-dir sidecar/page:** `relativeImageRef(dirOf(sidecar), emittedPage)` handles dir-aware keys; same-dir collapses to basename.
4. **Cache-bust ON:** `hashEmit(newPage)` → embed hashed page name in sidecar → `hashEmit(sidecar)` after embedding — same ordering as resize-atlas (`:1987-2018`).
5. **Multi-page Spine:** skipped + surfaced (one op can't re-encode sibling pages — verified by `parseSpinePage` one-Atlas-per-page).
6. **Source mesh (polygon manifest):** `{...atlas}` copies `sprites[].mesh`; `emitTexturePackerJson` emits `vertices/verticesUV/triangles` (`manifest.ts:20-24`) ⇒ no geometry loss.
7. **Atlas page IS a dedup owner (M3):** owner-aware lines repoint consumers at the emitted page; tested in Harness C.
8. **Page indexed by both `.json` and `.atlas`:** `isSpine` keyed off `spineRefs` (set authoritatively at parse, `fix.worker.ts:312`) ⇒ correct emitter/sidecar.
9. **B1 — Spine + KTX2:** KTX2 candidate suppressed for Spine ⇒ no malformed `.ktx2.json`.

---

## 11. Test plan (REAL decode/audit/emit path)

The worker can't run in Node (`createImageBitmap`/`OffscreenCanvas`). Reproduce the defect through the REAL parse→analyze→plan path and the REAL emit→parse→resolve path (the half the dangling-ref bug lives in). Established project discipline (best-format-worker test = pure-seam mirror; dedup-repoint test = real emit→parse round-trip).

**Harness A — defect fires through the real audit path** (`apps/web/test/atlas-transcode-worker.test.ts`, new): read a new fixture `fixtures/sample-projects/prebuilt-atlas-format/{sheet.png,sheet.json}` (genuine well-packed POT, high-occupancy, NOT oversize TexturePacker Hash) → `groupFiles` → `parseAtlas` → `analyze` with a **differentiating `deps.encodeImage`** (WebP < PNG `byteSize`) so `formatFinding` actually fires on the atlas page → `planFix` → assert exactly one `{kind:'transcode', assetRef:'sheet.png'}` op and **no** repack/resize op (proves the prebuilt atlas reaches the transcode-only path).

**Harness B — fix correctness (real emit→parse→resolve; no dangling ref):** seam test mirroring the new block's PURE half via `repointAtlasImage` + `emitTexturePackerJson`/`emitSpineAtlasText` + `parseAtlasManifest`/`parseSpineAtlasText` + `resolveImageRef`:
- `repointed = repointAtlasImage(atlas, 'sheet.json', 'sheet.webp')` → emit → re-parse → assert `resolveImageRef('sheet.json', parsed.imageRef) === 'sheet.webp'`. Add cross-dir + cache-busted (`sheet.<8hex>.webp`) variants.
- **Dangling-ref assertion (headline):** assemble the emitted output set `{emittedPage, emittedSidecar}`, re-parse the emitted sidecar, resolve its `meta.image`, assert the resolved page **is a member of the emitted set**, and assert the OLD `sheet.png` is in `replaced` and NOT referenced by the sidecar. This is exactly the invariant the bug violates today.
- **Spine variant:** `emitSpineAtlasText` + `parseSpineAtlasText` (single-page); assert the page line repointed.
- **Loose-path regression guard:** a non-atlas ref through the same seam emits NO sidecar (proves the loose path is untouched).

**Harness C — guards + interactions:** (a) sidecar unavailable ⇒ honest skip, no rename/`out.push`; (b) multi-page Spine ⇒ skip; (c) **B2 size-loss** (worker re-encode `≥` source) ⇒ keep original page + original sidecar, no dangling ref; (d) **B1** Spine ⇒ no KTX2 candidate emitted; (e) **M3** transcoded atlas page that is a dedup owner ⇒ consumers repoint at the emitted page name (assert via the owner-actual-name → Phase-C seam).

All under existing `pnpm test` (Vitest); the only browser-only piece (the actual `transcode()` pixel re-encode) is identical to the shipped loose transcode and is not where the dangling-ref bug lives.

---

## 12. Ordered task breakdown (small commits)

1. **`fix(fix): extract repointAtlasImage pure helper`** — add `packages/fix/src/atlas-transcode.ts` + re-export from `index.ts`; unit test `packages/fix/test/atlas-transcode.test.ts` (real emit→`parseAtlasManifest`→`resolveImageRef` incl. cross-dir + cache-bust; Spine variant). *(Skip + inline if reviewer prefers zero new files.)*
2. **`feat(fix): atlas-aware passthrough transcode in the worker`** — add the §6 atlas block: re-encode page, repoint + re-emit sidecar (TP/Spine), `recordVariant('atlas'|'spine')` + `repackChanges` **unconditionally** (M1), **B2** general size-loss guard, **B1** KTX2 candidate TP-only, **M3** owner-aware lines, multi-format-profile honest note, `vramSaved += 0`, `operations` line; fail-safe skips. Loose path untouched.
3. **`test(fix): prebuilt-atlas fixture + the op fires on the page`** — extend `fixtures/_generator/generate.mjs` to emit `fixtures/sample-projects/prebuilt-atlas-format/{sheet.png,sheet.json}`; add Harness A.
4. **`test(fix): no-dangling-meta.image after atlas transcode`** — Harness B (emitted-output-set membership, `replaced` of old page, Spine variant, loose-path regression guard).
5. **`test(fix): atlas-transcode guard skips + interactions`** — Harness C (sidecar-unavailable, multi-page Spine, **B2** size-loss keep-original, **B1** Spine-no-KTX2, **M3** dedup-owner repoint).
6. **`docs: CHANGELOG/FEATURES — prebuilt-atlas passthrough transcode (closes dangling-ref bug)`** — one entry in `docs/CHANGELOG.md` + `docs/FEATURES.md`.

**Files touched:** `packages/fix/src/atlas-transcode.ts` (new, optional), `packages/fix/src/index.ts`, `apps/web/src/worker/fix.worker.ts`, `fixtures/_generator/generate.mjs`, `fixtures/sample-projects/prebuilt-atlas-format/*` (new), `packages/fix/test/atlas-transcode.test.ts` (new), `apps/web/test/atlas-transcode-worker.test.ts` (new), `docs/CHANGELOG.md`, `docs/FEATURES.md`. No `core` change.

---

### Effort note
Realistic: ~1 worker block (~45 lines) + 1 tiny pure helper + 3 test harnesses + 1 fixture-generator extension + docs. The draft's "no new pure code required" is true but the optional helper is worth it (Node-testable seam). The two blockers (B1 Spine-KTX2, B2 size guard) and three majors are small, localized edits — none changes the architecture. Estimate stands at a few hours; the test harnesses (esp. the differentiating-encoder Harness A) are the bulk of the work, not the worker change.