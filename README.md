# Asset Doctor

**▶ Live demo:** <https://nonamezzz322.github.io/asset-doctor/> — drop the folder
`fixtures/sample-projects/tp-hash-symbols` to see a real diagnosis.

[![Deploy](https://github.com/Nonamezzz322/asset-doctor/actions/workflows/deploy.yml/badge.svg)](https://github.com/Nonamezzz322/asset-doctor/actions/workflows/deploy.yml)

Browser-side audit and optimization for HTML5-game assets (PixiJS / Phaser). Drop an asset
folder and in seconds see a map of problems — wasted atlas space, suboptimal formats,
oversized textures, excess VRAM and draw calls — and how much weight you can cut. Assets
never leave your device.

> Key insight: **disk weight ≠ GPU footprint.** A 2048×2048 PNG is 16 MB of VRAM
> (`w×h×4`, RGBA8888) no matter how well it compresses — +33% with mipmaps. We make that
> visible.

## Status

Phase 1 (free diagnosis / MVP) · **Milestone 0 complete** (this scaffold) · Milestone 1
next: the vertical slice (local folder → real diagnosis → film-viewer). The working brief
is [`CLAUDE.md`](CLAUDE.md); the full project guide is
[`docs/AGENT_GUIDE.md`](docs/AGENT_GUIDE.md).

## Monorepo layout

| Path | What |
| --- | --- |
| `apps/web` | Vite + React + TS client. Folder import, Web Worker analysis, film-viewer. |
| `apps/api` | _(Phase 2 placeholder)_ thin backend — auth, billing, history. |
| `packages/core` | Shared TS contracts (atlas + analysis model). Single source of truth. |
| `packages/parsers` | TexturePacker (Hash/Array) + PixiJS + single images → `core` model. |
| `packages/analysis` | Occupancy, wasted regions, format audit, dimensions. Thresholds in config. |
| `packages/probe` | Render-probe: offscreen PixiJS WebGL → draw calls + VRAM. |
| `packages/fix` | _(Phase 2 placeholder)_ repack + transcode. |
| `workers/fix-worker` | _(Phase 2 placeholder)_ server-side fix jobs. |
| `fixtures/sample-projects` | Synthetic problem-atlases for threshold calibration + regression. |

## Prerequisites

- Node ≥ 20.19 (we use 20.x; see [`.nvmrc`](.nvmrc)). pnpm 11 requires Node 22+, so we pin pnpm 10.
- pnpm 10 via Corepack: `corepack prepare pnpm@10 --activate`

## Commands

```bash
pnpm install      # install workspace deps
pnpm dev          # run apps/web (Vite dev server)
pnpm build        # build apps/web
pnpm test         # run Vitest across packages
pnpm typecheck    # tsc --noEmit across packages
pnpm lint         # eslint
pnpm format       # prettier --write
```

## Conventions

Small, single-purpose commits. Core analysis (`parsers`, `analysis`) ships with tests on
fixtures; thresholds live in config, never hardcoded. Agree before changing a library, the
folder structure, a DB schema, or the data format between packages (`packages/core`).
Project agents and skills live in [`.claude/`](.claude/).
