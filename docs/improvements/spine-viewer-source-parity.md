# Spine viewer — full source parity (every function of the upstream repo, ported to ours)

User (RU): review in detail ALL functions of the upstream pixi-spine-viewer and port them ALL into ours.
Upstream: https://github.com/Nonamezzz322/pixi-spine-viewer — single-file `src/App.jsx` (1622 LOC), Pixi v7 +
pixi-spine v4. Our target: Pixi v8 + `@esotericsoftware/spine-pixi-v8` 4.3.9, our rentgen-cabinet design, the
`#spine` route. This doc is the COMPLETE function inventory + the gap vs what we have shipped/are shipping.

## Complete upstream inventory (every function + feature)

### Loading (all already ported in v1 — verify still present)
- `modifyAtlasText` (no-op passthrough), `expandSequencePath` (sequence attachments), `extractImageNames`
  (walk skins → region/mesh/linkedmesh/weightedmesh/skinnedmesh att paths, incl. sequences), `findImageFile`
  (6-rung resolve ladder), `generateAtlasFromImages` (synthesize a TP atlas when only JSON+images dropped),
  placeholder 2×2 texture for genuinely-missing images, `getTextureForLine` (page→texture resolve).
- Load paths: JSON+atlas, JSON+images(synthesized). Drag-drop files OR folder (recursive `readEntryRecursive`),
  Open-Files (multi input), Open-Folder (webkitdirectory).
- `setMeshRegion` null-guard + sequence-attachment `att.region = att.sequence.regions[setupIndex]` pre-set
  (v4-specific; the spine-pixi-v8 loader handles sequences differently — verify our path renders sequences).

### Playback
- Play / pause (`state.timeScale = 0 | speed`).            [v1 ✓]
- Speed slider 0.1–2.                                       [v1 ✓]
- Scale slider 0.1–2 (`spine.scale.set`).                  [v1 ✓]
- Animation dropdown on track 0.                            [v1 ✓]
- **Animation QUEUE** — a playlist: `addToQueue`/`removeFromQueue`/`clearQueue`/`toggleQueueLoop`; a
  `state.addListener({complete})` auto-advances to the next queued anim (last one loops iff queue-loop off →
  actually: last plays non-loop unless queueLoop, then wraps to 0); current index highlighted; adding to the
  queue sets the current track entry `loop=false`. **MISSING.**
- **Multi-TRACK** — `addTrack` (next free index ≥1), `removeTrack` (`clearTrack`), `updateTrackAnimation`,
  `toggleTrackLoop`, **`updateTrackAlpha`** (`entry.alpha`), **`updateTrackMixDuration`** (`entry.mixDuration`).
  [v2 adds tracks; **alpha may be MISSING** — verify.]
- **Timeline** — `updateTimeline` ticker reads `track.getAnimationTime()` + `track.animation.duration`;
  shows `animTime / animDuration`; **`handleScrub`** sets `track.trackTime` (click-drag on a timeline bar).
  **MISSING.**
- **Trim** — `trimEnabled` + `[trimStart,trimEnd]`; the timeline ticker loops the track back into the range
  (`if t>=trimEnd: trackTime -= (t-trimStart)`); a trim region is drawn on the timeline. **MISSING.**
- **FPS counter** — `ticker.FPS` shown as an on-canvas badge. **MISSING.**

### Skins
- Single-skin dropdown (shown only when >1 skin): `skeleton.setSkin(skin)` + `setSlotsToSetupPose`. [v1 ✓]
- [v2 extends to combined MULTI-skin.]

### Slot markers (circles)
- `addCircleToSlot` (white circle radius 200 + slot-name Text label, re-parented into the slot container each
  frame via `updateCircles` ticker so it tracks the bone), `removeCircleFromSlot`, circle-scale slider. [v1 ✓]
- **`handleSlotVisibilityChange`** — a per-marker visibility checkbox (`circle.visible`). **MISSING.**

### Drag / view
- **Drag the skeleton around the canvas** — pointerdown/move/up → `dragOffset` → `updateSpinePosition`
  (`spine.x/y = center + dragOffset`). [v2 adds pan + wheel-zoom + reset.]
- ResizeObserver → `renderer.resize` + reposition. [ours uses `resizeTo`/`app.screen` — verify reposition.]

### Debug mode (`debugMode` checkbox) — the big one
Organized by a `debugEntityType` dropdown: **bones · slots · regionAttachments · meshes · paths ·
boundingBoxes · clipping** (each with a live count). The upstream draws with a manual `Graphics` per frame via
`attachment.computeWorldVertices(slot,0,len,verts,0,2)` + the spine `worldTransform` matrix — GRANULAR: the
user selects WHICH named entities to draw (per-type Set + All/None + text filter).
- **Bones** — `drawBones` ticker: line parent→bone + dot at bone tip; a bone LIST with filter; **per-bone
  selection** (selected bones drawn yellow/orange & thicker); a **show-bones** checkbox. **MISSING** (v2 has
  only the SpineDebugRenderer global drawBones flag, no per-bone list/selection/highlight).
- **Slots** (inside debug) — reuses the marker attach/remove + circle-scale + slot filter + attached-slot
  visibility list. [markers ✓ in v1/v2; the debug-panel grouping + visibility toggle MISSING.]
- **Region attachments** — per-entity list + All/None + filter; selected → highlight the actual slot via a
  **ColorMatrixFilter** (`brightness(2)` + `desaturate`) on the slot container. **MISSING.**
- **Meshes** — per-entity → draw **triangles** (from `att.triangles`) + **hull** (`att.hullLength`). **MISSING
  (granular)** — v2 has SpineDebugRenderer global drawMeshTriangles/drawMeshHull only.
- **Paths** — per-entity → draw **bezier curves** (`att.closed`, control points). **MISSING (granular).**
- **Bounding boxes** — per-entity → draw polygon. **MISSING (granular).**
- **Clipping** — per-entity → draw polygon. **MISSING (granular).**
- Entity classification at load: walk `skeletonData.skins[].attachments[slotIndex][attName].type` (numeric:
  0 region, 1 boundingbox, 2 mesh, 4 path, 6 clipping) → the per-type name lists (`slot/att` keys), dedup.

### UI / misc
- Theme toggle (dark/light). [ours has a global auto/light/dark theme already — do NOT duplicate.]
- Error messages, empty/drop overlay, on-canvas controls (play, open, debug).

## Gap to close (this round) — everything the upstream has that v1+v2 will NOT
1. Animation **queue** (playlist + loop + auto-advance + current highlight).
2. **Timeline** readout + **scrubber** (drag to set `trackTime`).
3. **Trim** (loop a sub-range; timeline trim region).
4. **FPS** badge.
5. Per-track **alpha** (confirm; add if v2 omitted).
6. **Bone inspector**: list + filter + per-bone select/highlight + show-bones.
7. **Granular per-entity debug selection** for regions/meshes/paths/bounding-boxes/clipping (All/None + filter),
   with real overlay drawing (triangles/hull/bezier/polygon) + region **ColorMatrixFilter** highlight.
8. Per-marker **visibility** toggle.

## Porting notes for Pixi v8 + spine-pixi-v8 4.3.9 (vs the v7/pixi-spine-v4 source)
- **Custom overlay drawing:** the source used `spine.worldTransform` (Matrix a/b/c/d/tx/ty) to map skeleton→
  screen and a manual `Graphics`. In v8: attachments (`MeshAttachment`/`ClippingAttachment`/`PathAttachment`/
  `BoundingBoxAttachment`/`RegionAttachment`) still expose `computeWorldVertices(slot, start, count, verts,
  offset, stride)` + `triangles`/`hullLength`/`worldVerticesLength` (spine-core, unchanged). Map each vertex
  skeleton→pixi via `spine.skeletonToPixiWorldCoordinates(point)` (public on Spine) OR draw the Graphics as a
  CHILD of the Spine (skeleton-local coords, no manual matrix — simpler & robust). Pixi v8 Graphics uses the
  chained API: `g.poly(pointsArray).stroke({width,color,alpha})`, `g.moveTo/lineTo/stroke`, `g.circle().fill()`
  — NOT v7 `lineStyle/beginFill/drawCircle/bezierCurveTo` (bezier → sample the curve into a polyline, or use
  `g.bezierCurveTo` if present in v8 Graphics — verify).
- **Region highlight:** Pixi v8 filters live in `pixi.js` (`ColorMatrixFilter` with `.brightness()` +
  `.desaturate()`). The slot render object is internal in spine-pixi-v8 (no public `slotContainers`) — options:
  (a) apply the filter to a per-slot attached Container, (b) accept that granular region-highlight maps to the
  SpineDebugRenderer `drawRegionAttachments` outline instead. Prefer an HONEST outline/box if a per-slot filter
  is not cleanly reachable; do NOT fake it. Decide in design and state the limitation if any.
- **Bones:** either SpineDebugRenderer `drawBones` (global) for the visual + a SEPARATE bone list with
  selection that re-colors selected bones (needs custom draw), or a fully-custom bone drawer as the source did
  (bone.parent worldX/Y → bone worldX/Y, mapped via skeletonToPixiWorldCoordinates). Custom is closer to source.
- **Queue/timeline/trim/fps/alpha/marker-visibility:** pure state + `state.getCurrent(track)`/`track.trackTime`/
  `track.animation.duration`/`entry.alpha`/`entry.mixDuration`/`ticker.FPS` — all present in spine-core/pixi v8.

## Constraints (unchanged)
Assets never leave the device (local, zero network); exactly one h1 `ad-spine-h1`; every control keyboard-
operable + labeled; reduced-motion starts paused; all UI labels via `t()` in all 10 catalogs (data-derived
animation/skin/slot/bone/entity names NEVER translated); our tokens only, no inline JS style objects; renders
REAL data (no fabrication); pure logic (queue/trim/entity-classification/filters) Node-unit-tested; the
orchestrator cannot run a browser ⇒ typecheck+lint+build clean + a manual browser-test checklist.
