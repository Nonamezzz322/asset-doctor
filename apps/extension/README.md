# Asset Doctor — Runtime Profiler (Chrome MV3 extension)

Closes the moat **in the page**. As a **MAIN-world content script at `document_start`** it patches the
game's WebGL context before the renderer initialises, then:

1. **Live HUD** — draw calls/frame, texture binds, redundant binds, VRAM, hitch causes, FPS (shown once
   a WebGL context is detected).
2. **Load asset folder & correlate** — a button in the overlay loads the game's asset folder, runs the
   full static audit in-page, and **correlates static structure × live GPU workload into one verdict**
   (e.g. "11 loose sprites (static) + 60 draw calls (runtime) → pack into one atlas → 1 draw").

The whole pipeline (runtime profiler + folder audit + correlation) is bundled into one ~50 KB content
script (no pixi).

## Build & load

```bash
pnpm --filter @asset-doctor/extension build      # → apps/extension/dist/
```

Then in Chrome (111+): `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
select `apps/extension/dist/`. Open any PixiJS / Phaser / WebGL game — the HUD appears top-right.

The overlay has a header (minimise `–` / close `×`), severity-coloured correlation cards (crit/warn/
info), a **re-correlate** button (re-runs the verdict against the *current* runtime as gameplay evolves),
and **export** (downloads the session — runtime report + correlation + static findings — as JSON).

## How it works

- `manifest.json` — MV3, one `content_scripts` entry with `"world": "MAIN"`, `"run_at":
  "document_start"`, matching `<all_urls>`.
- `src/inject.ts` — bundled by `build.mjs` (esbuild → single IIFE, ~55 KB, no pixi). Installs the
  profiler, renders the overlay, and runs the in-page folder audit + `correlate()`.
- Automation hooks on `window.__assetDoctor`: `audit(FileList)`, `recorrelate()`, `export()` (JSON
  string), `runtime()`.
- Verified headless:
  - `tools/verify/ext-run.mjs` — HUD injects into a bare WebGL page.
  - `tools/verify/ext-correlate-run.mjs` — loads the real extension on a fragmented page
    (`apps/web/webgl-busy.html`, 60 draws/frame), loads an asset folder via the overlay, and asserts the
    correlated verdict + export JSON + severity colours + close-teardown.

## Next

- A popup / devtools panel (MAIN ↔ isolated content script ↔ popup messaging) mirroring the overlay, so
  the report is reachable without the on-page HUD.
