# Spine viewer v2 — inspector-grade upgrade (bug fixes + big feature set)

User (RU): the Open-files / Open-folder buttons do not work; the Spine cannot be dragged around the view;
the view should be bigger; add skin AND track management; add display of ALL slots, meshes, clippings, bones
and other Spine entities; make a convenient, friendly interface. Ship via an agent workflow.

Builds on v1 (`docs/improvements/spine-viewer-port-brief.md`). Same files: `apps/web/src/lib/spine-engine.ts`
(imperative Pixi/Spine glue), `apps/web/src/components/SpineViewer.tsx` (React shell + controls), pure
`apps/web/src/lib/spine-files.ts` (+ tests). Same route (`#spine`), same design language, same invariants.

## A. BUGS TO FIX (verified against the current code)

1. **Open-files / Open-folder buttons are dead — the WebGL canvas swallows the clicks.**
   In `init()` the canvas is `host.appendChild(canvas)` with `classList.add('absolute','inset-0',...)`; the
   drop-overlay (with the two buttons) is a React child of the SAME host div, rendered BEFORE the canvas in
   DOM order. Both are `absolute inset-0` with z-auto, so the transparent WebGL canvas paints ON TOP and
   intercepts pointer events — the buttons are visible but unclickable. **Fix:** establish an explicit
   stacking order. The interactive drop-overlay (and any not-loaded UI) must sit ABOVE the canvas (e.g. the
   canvas layer `z-0`, the overlay `z-10`). When LOADED the canvas must itself receive pointer events (for
   drag-pan, feature B2) and the drop-overlay is not rendered — so the fix must not disable canvas pointer
   events unconditionally. Simplest robust approach: mount the canvas in its own absolutely-positioned layer,
   put all React controls in front via z-index, and attach the pan/zoom listeners directly to `app.canvas`
   in the engine (so they work even with UI in front elsewhere). VERIFY the buttons are the topmost element
   at their location after the fix.
2. **`accept` is missing `.avif`** on the hidden files `<input>` (`accept=".json,.atlas,.png,.jpg,.jpeg,.webp"`).
   Add `.avif` (ingest already reads it).

## B. FEATURES

2. **Drag-to-pan + wheel-zoom the skeleton, with keyboard equivalents.**
   The engine keeps `fitScale` (auto-fit) × `scaleFactor` (the Scale slider) and ADDS `userZoom` (wheel) and
   `userOffset {x,y}` (drag). Final: `spine.position = center + userOffset`, `spine.scale = fitScale *
   scaleFactor * userZoom`. Pointer-drag on `app.canvas` (engine-attached `pointerdown/move/up/leave`
   listeners; cursor grab/grabbing) updates `userOffset`. Wheel updates `userZoom` (clamp e.g. 0.1..8; zoom
   toward the cursor is a nice-to-have, center-zoom is acceptable). A **Reset view / Fit** button re-runs the
   fit and clears `userOffset`+`userZoom`. a11y: arrow keys nudge the offset, `+`/`-` zoom, `0` or `F` reset —
   wired on the focusable stage (so mouseless users can pan/zoom). Auto-fit on load must not fight a user who
   has panned (only fit on load / skin change / explicit reset).
3. **Bigger stage.** The canvas is the hero. Replace the small `aspect-[4/3]` in a 1.4fr column with a large
   stage: full available width and a tall min-height (e.g. `min-h-[60vh]` / a taller aspect), the inspector
   controls in a compact, scrollable side panel (lg two-pane) that collapses under the stage on narrow
   screens. Keep the film aesthetic (`ad-grid`, `ad-clip`, `ad-viewer-shadow`, `bg-film`).
4. **Track management (multi-track animation).** Today only track 0 with one animation. Add a Tracks panel
   listing tracks 0..N; per track: an animation `<select>` (with an Empty option), a Loop toggle, a Remove
   (clear) button; a global "Add track" button; optional per-track mix-in duration + optional default mix.
   API: `state.setAnimation(track, name, loop)`, `state.setEmptyAnimation(track, mixDuration)`,
   `state.clearTrack(track)`, `state.getCurrent(track)`, `state.data.defaultMix`, `state.data.setMix(a,b,d)`.
   Play/pause + speed still apply globally via `state.timeScale`.
5. **Skin management (combine multiple skins).** Support selecting MULTIPLE skins at once, combined:
   `const custom = new Skin('custom'); for (name of selected) custom.addSkin(<Skin for name>);
   skeleton.setSkin(custom); skeleton.setSlotsToSetupPose()` (the engine already uses
   `skeleton.setSkin(name)` + `skeleton.setupPoseSlots()` for the single case — verify the exact method
   names in 4.3.9 and reuse; combined skins re-fit/recenter). UI: a checklist of skin names (multi-select),
   single-skin remains a special case. Find a skin by name via `skeletonData.skins` (already listed) or
   `skeleton.data.findSkin(name)`.
6. **Debug rendering of all Spine entities.** `spine.debug = new SpineDebugRenderer()` (exported from
   `@esotericsoftware/spine-pixi-v8`). Wire checkboxes to its per-entity flags: `drawBones` (incl. the
   skeleton root XY), `drawRegionAttachments`, `drawMeshTriangles`, `drawMeshHull`, `drawClipping`,
   `drawBoundingBoxes`, `drawPaths`, `drawEvents`. Set the color fields (`bonesColor`, `meshTrianglesColor`,
   `clippingPolygonColor`, `boundingBoxesPolygonColor`, `regionAttachmentsColor`, …) to OUR palette as hex
   ints (a WebGL canvas cannot read CSS vars — mirror the tokens: teal 0x0E8C8C, warn 0xD98A00, crit
   0xE5484D, info 0x2B8FC9, etc.) and `lineWidth`. Attach on load; on reset set `spine.debug = undefined`
   (unregisters) and drop the renderer. Default all flags OFF (clean first view). Toggling a checkbox flips
   the flag live.
7. **List ALL slots + their attachment kind.** Enumerate `skeleton.slots`; for each read
   `slot.getAttachment()` and classify by `instanceof` against the spine-core classes (`MeshAttachment`,
   `ClippingAttachment`, `RegionAttachment`, `BoundingBoxAttachment`, `PathAttachment`, `PointAttachment`;
   null ⇒ empty). Render a filterable list: slot name + a small kind label/badge (mesh/clip/region/bbox/
   path/point/none). This complements the VISUAL debug overlay (B6) with a textual index. Keep the existing
   marker attach/remove per slot. Classification is PURE (skeleton data in → list out) ⇒ Node-unit-tested in
   `lib/spine-inspect.ts` (or extend spine-files.ts).
8. **Friendly, convenient interface.** Reorganize into a clean inspector: the big stage + a sectioned/tabbed
   inspector (Playback · Tracks · Skins · Debug · Slots), collapsible sections, clear labels + tooltips,
   sensible defaults, our tokens, fully keyboard-accessible. Honest empty/loading/error states.

## C. API grounding (installed spine-pixi-v8 4.3.9 + spine-core 4.3.9 — VERIFIED in the d.ts)

- `import { SpineDebugRenderer } from '@esotericsoftware/spine-pixi-v8'`. Flags: drawBones, drawRegionAttachments,
  drawMeshTriangles, drawMeshHull, drawClipping, drawBoundingBoxes, drawPaths, drawEvents (all boolean).
  Colors: bonesColor, skeletonXYColor, regionAttachmentsColor, meshTrianglesColor, meshHullColor,
  clippingPolygonColor, boundingBoxesRectColor/PolygonColor/CircleColor, pathsCurveColor/LineColor,
  eventFontColor (all number ints), lineWidth (number), eventFontSize (number).
  `get/set debug(value: ISpineDebugRenderer | undefined)` on Spine; setting a value calls
  `registerSpine`, setting undefined calls `unregisterSpine`; `renderDebug(spine)` runs every frame.
- `Spine`: `state: AnimationState`, `skeleton: Skeleton`, `autoUpdate`, `position`, `scale`, `pivot`,
  `getLocalBounds()`, `skeleton.updateWorldTransform(Physics.update)`, `addSlotObject/removeSlotObject`,
  `setBonePosition/getBonePosition`, `pixiWorldCoordinatesToSkeleton/skeletonToPixiWorldCoordinates`
  (available if we later want bone-level drag — NOT required for B2 which pans the whole container).
- `AnimationState` (spine-core): setAnimation(trackIndex, animationName, loop), addAnimation(...),
  setEmptyAnimation(trackIndex, mixDuration), addEmptyAnimation(...), clearTrack(trackIndex), clearTracks(),
  getCurrent(trackIndex), timeScale, `data: AnimationStateData` with `defaultMix` + `setMix(from,to,dur)`.
- `Skin` (spine-core): `new Skin(name)`, `addSkin(skin)`, `copySkin(skin)`, `getAttachments()`. Skeleton:
  `setSkin(skinOrNull)`, `setupPoseSlots()` (the method the engine already calls), `data.findSkin(name)`.
- Attachments (spine-core exports): MeshAttachment, ClippingAttachment, RegionAttachment,
  BoundingBoxAttachment, PathAttachment, PointAttachment (+ base Attachment).

## D. Structure
- `apps/web/src/lib/spine-engine.ts` — new methods: pan/zoom/resetView, setTrackAnimation/clearTrack/addTrack/
  setDefaultMix, setSkins(names[]) (combined), setDebug(flags)/setDebugColorsOnce, attachment/slot enumeration
  passed back in the load result (or a getter). Keep ALL Pixi out of React.
- `apps/web/src/components/SpineViewer.tsx` — new inspector layout + controls.
- `apps/web/src/lib/spine-inspect.ts` (new) or extend `spine-files.ts` — PURE attachment classification +
  track/skin model helpers, Node-unit-tested (apps/web has no Pixi harness).
- i18n: NEW keys in ALL 10 catalogs (tracks/skins/debug/slots/pan-zoom labels + tooltips). Data-derived names
  (animation/skin/slot/bone names) are NEVER translated.

## E. Constraints (unchanged from v1)
- **Invariant 1:** assets never leave the device — all local, ZERO network/upload.
- **a11y:** exactly one h1 (`ad-spine-h1`); every control keyboard-operable + labeled; drag AND zoom have
  keyboard equivalents; canvas has an accessible name; reduced-motion starts paused; monotonic headings.
- **i18n:** all UI labels via `t()` in all 10 catalogs; placeholder parity holds.
- **Design:** our tokens only, dark-safe film stage, no inline JS style objects (dynamic transforms on the
  Pixi side only, not React inline styles).
- **Honesty:** it renders the REAL dropped skeleton + REAL debug data; nothing fabricated.
- **Orchestrator caveat:** cannot run a browser ⇒ the port must be `pnpm typecheck` + `pnpm lint` +
  `pnpm --filter web build` clean and ship a precise MANUAL browser-test checklist (buttons open a dialog and
  load; drag pans; wheel/keys zoom; reset fits; each debug toggle shows/hides its overlay; multi-track plays;
  combined skins render; slot list + filter; reduced-motion starts paused; keyboard-only operable; zero
  network in DevTools).
