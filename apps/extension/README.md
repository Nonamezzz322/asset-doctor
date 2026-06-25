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

## How it works

- `manifest.json` — MV3, one `content_scripts` entry with `"world": "MAIN"`, `"run_at":
  "document_start"`, matching `<all_urls>`.
- `src/inject.ts` — bundled by `build.mjs` (esbuild → single IIFE, ~11 KB, no pixi). Installs the
  profiler and renders the HUD.
- Verified headless: `tools/verify/ext-run.mjs` loads the built extension in Chromium and confirms the
  HUD injects into a bare WebGL page.

## Next

- Messaging (MAIN ↔ isolated content script ↔ popup/devtools) to show the full `RuntimeReport` and
  capture/export sessions.
- Correlation: pair runtime numbers with a static folder audit into one verdict.
