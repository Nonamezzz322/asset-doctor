# Port brief — the pixi-spine-viewer into Asset Doctor (functionality intact, OUR design)

User: port the whole functionality of https://github.com/Nonamezzz322/pixi-spine-viewer into this app;
keep the design/styling like the rest of OUR app (the rentgen-cabinet aesthetic); use a workflow of agents.

## The source
Upstream: https://github.com/Nonamezzz322/pixi-spine-viewer — the whole viewer is `src/App.jsx`
(~1621 LOC, React + Pixi v7 + pixi-spine v4) + `src/styles.js` (~574 LOC of inline JS style objects,
DISCARDED here — we restyle with OUR tokens). Verbatim copies were kept in this folder while the port
workflow ran, then removed (third-party source does not live in our repo); clone the upstream to compare.

## Features to port (from the source + its README — every one)
1. **Drag-drop load** of a Spine asset: the skeleton JSON, the `.atlas`, and the page image(s). Group the
   dropped files, parse the atlas, resolve image pages to textures, build the skeleton, add the Spine to the stage.
2. **Play / pause** the animation + an **adjustable playback speed** (timeScale).
3. **Scale** the Spine display (a scale control).
4. **Animation dropdown** — list + select the skeleton's animations (state.setAnimation).
5. **Skin dropdown** — list + select skins (skeleton.setSkinByName + setSlotsToSetupPose).
6. **Slot markers** — attach / remove circular markers (Pixi Graphics) bound to specific slots; **adjust the
   marker circle scale**; the markers follow the slot bones each frame.
7. **Slot list + filter** — list the skeleton's slots with a text filter.
Preserve the source's exact loading logic (the atlas-text munging `modifyAtlasText`, `expandSequencePath`,
`extractImageNames` — sequence attachments, multi-page atlases) — those are format-correctness, not styling.

## The hard part — Pixi v7 → v8 + Spine runtime migration
- Source deps: `pixi.js@7`, `pixi-spine@4`, `@pixi-spine/runtime-4.1`. OUR app is `pixi.js@^8`.
- **Use `@esotericsoftware/spine-pixi-v8@4.3.9`** — already installed (the official Spine-4.x runtime for Pixi
  v8). READ its types in `node_modules/@esotericsoftware/spine-pixi-v8/` to get the EXACT manual-load API for
  raw dropped files (NOT the Assets-registered path — the files are user-dropped blobs): it re-exports
  `@esotericsoftware/spine-core` (`TextureAtlas`, `AtlasAttachmentLoader`, `SkeletonJson`, `SkeletonBinary`,
  `Skeleton`, `AnimationState`, …) plus the Pixi-v8 `Spine` display object. Map every v7/pixi-spine-v4 call:
  - `new Application()` (sync) → `new Application(); await app.init({...})` (v8 async init), canvas = `app.canvas`.
  - Texture from an image blob: v8 `Texture`/`Assets` (build a `Texture` from an `ImageBitmap`/`HTMLImageElement`
    via `Texture.from` or `new Texture({ source })`); wire the atlas pages to these textures.
  - `new TextureAtlas(atlasText, imageLoaderCallback)` (spine-core) — the callback resolves each page name to a
    Pixi v8 texture the atlas region wraps (spine-pixi-v8 provides `SpineTexture`/an adapter — find it in its types).
  - `AtlasAttachmentLoader` + `SkeletonJson.readSkeletonData(json)` → `skeletonData` → `new Spine(skeletonData)`
    (or the spine-pixi-v8 `Spine` factory — check whether it takes skeletonData or a `{skeleton, atlas}` bundle).
  - Playback: `spine.state.setAnimation(0, name, loop)`, `spine.state.timeScale = speed`, `spine.skeleton.setSkinByName`.
  - Ticker/autoUpdate: v8 `app.ticker` + `Spine.autoUpdate` (or manual `spine.update(dt)`).
  - `Graphics` markers: v8 Graphics API (`.circle(x,y,r).fill(color)` — the v8 chained API, NOT v7 `beginFill`).
- If a piece of the pixi-spine-v4 API has NO clean spine-pixi-v8 equivalent, say so and pick the closest honest
  path — never fake playback.

## Structure (fit OUR monorepo — TS, React, the sidebar shell)
- New view/route: extend `apps/web/src/lib/route.ts` with a `'spine'` view + `SPINE_HASH` (`#spine`) — MIRROR the
  Phase-4 Pro route work (+ route.test.ts). Extend `apps/web/src/lib/focus-move.ts` with an `ad-spine-h1` anchor
  (+ focus-move.test.ts, extend the sweep). Add a 4th sidebar `NavItem` (App.tsx `Sidebar`, a new `NavIcon` arm)
  + the `hidden={view!=='main'}` gate already covers it; render `{view==='spine' ? <SpineViewer/> : null}`.
- New component `apps/web/src/components/SpineViewer.tsx` (the React shell + controls) + a Pixi/Spine ENGINE
  module (e.g. `apps/web/src/lib/spine-engine.ts` — the imperative Pixi-v8/Spine glue, kept out of React render).
  Extract PURE logic (file grouping, `modifyAtlasText`/`expandSequencePath`/`extractImageNames`, slot filtering)
  into Node-testable `lib/*.ts` with tests (apps/web has NO React/Pixi harness — Pixi is verified by build only).
- Register `SpineViewer.tsx` in `apps/web/test/i18n-app-keys.test.ts` appSrc.

## Design (OUR rentgen-cabinet aesthetic — DISCARD the source styles.js)
- Tokens (index.css @theme): the canvas stage on the dark film surface (`.ad-grid` / `bg-film` + `.ad-clip` /
  `.ad-viewer-shadow`, like the FilmViewer/Dropzone viewer). Controls = OUR patterns: cards
  (`rounded-2xl border border-line bg-panel p-6`), `.ad-label text-teal-text` section eyebrows, the mono/IBM-Plex
  type, teal accents, the CTA-green for the primary action, dropdowns/sliders styled like SettingsPage
  (`Segmented`/native select + `accent-teal` range). Severity/marker colors from tokens. Dark-theme safe (all
  token-driven; the canvas is always-dark film like the FilmViewer). NO inline JS style objects.

## a11y + i18n + invariants
- a11y: EXACTLY one h1 (`ad-spine-h1`, tabIndex=-1 ad-focus-anchor) on the spine view; skip-link + the persistent
  live region intact (they live in App.tsx main); real accessible controls (labeled selects/sliders/buttons,
  keyboard-operable — NOT div soup); the canvas gets an accessible name; reduced-motion: do not auto-play on load
  under `prefers-reduced-motion` (start paused), and gate any decorative motion. Monotonic heading outline.
- i18n: EVERY UI label via `t()` — new keys in ALL 10 catalogs (en source + genuine ru/uk/de/es/pt/fr/it/zh/hi);
  data-derived names (animation/skin/slot names) are NOT translated. Parity + placeholder-parity must hold.
- invariants: **assets never leave the device** — the Spine files are user-dropped blobs, read client-side (FileReader
  / object URLs), rendered locally; ZERO network, no upload (invariant 1). Instant, in-browser. No fabrication —
  it renders the REAL dropped Spine (invariant 3). No backend (invariant 2).

## Constraint the orchestrator has (state it in the plan)
The orchestrator CANNOT run a browser, so the Pixi/Spine RUNTIME playback can only be BUILD + typecheck verified
(the spine-pixi-v8 API used correctly per its TS types) — NOT visually confirmed. The port MUST be `pnpm typecheck`
+ `pnpm --filter web build` + `pnpm lint` clean, and MUST ship a precise MANUAL browser-test checklist (drop a real
Spine, play/pause/speed, scale, switch animation + skin, attach/scale/remove a marker, filter slots) for the user.
