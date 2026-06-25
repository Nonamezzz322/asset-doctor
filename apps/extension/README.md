# Asset Doctor — Runtime Profiler (Chrome MV3 extension)

Injects the runtime profiler ([`@asset-doctor/probe`](../../packages/probe)) into every page as a
**MAIN-world content script at `document_start`** — so it patches the game's WebGL context before the
renderer initialises — and draws a live on-page HUD (draw calls/frame, redundant binds, VRAM, hitch
causes, FPS) that appears only once a WebGL context is detected.

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
