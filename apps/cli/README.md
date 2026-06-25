# Asset Doctor — CLI (`asset-doctor`)

Phase 3: the static asset audit as a **CLI + GitHub Action budget gate**. Reuses the exact diagnostic
core the web app runs (`@asset-doctor/{ingest,parsers,analysis}`) in Node — assets are read from disk
and **never uploaded**. VRAM is real `w×h×4` math; exact-duplicates use `node:crypto` SHA‑256.

## Commands

```bash
asset-doctor audit  <dir> [--json] [--out file] [--severity crit|warn|info] [--quiet]
asset-doctor budget <dir> [--config file] [--baseline file] [--json] [--out file]
                          [--sarif file] [--summary file] [--annotate]
                          [--fail-on error|warn|none] [--warn-only] [--quiet]
asset-doctor init   <dir> [--out file] [--force]
```

- **audit** — measure & report, never fails on findings. Also the command the Action runs on the base
  ref to produce the baseline JSON.
- **budget** — the gate: audits, evaluates the report against the budget config, sets the exit code.
- **init** — scaffold `asset-doctor.budget.json`, seeded from a real scan (disk + loaded‑VRAM with headroom).

`--out` always writes the machine JSON report; `--json` switches stdout to JSON; `--sarif`/`--summary`
write those artifacts; `--annotate` prints GitHub `::error`/`::warning` commands.

## Exit codes

| code | meaning |
| --- | --- |
| 0 | pass / advisory (no config, `--warn-only`, or `--fail-on none`) |
| 1 | budget exceeded at the fail-on level |
| 2 | config / usage error — incl. **fail-closed** when a browser-only metric is budgeted |
| 3 | input error (bad/empty dir, no parseable assets) |
| 4 | internal error |

A green check provably means *measured-and-within-budget*: a misconfigured budget (unknown metric,
bytes without a unit, or a metric this build can't measure) is exit 2, never a silent pass.

## Budget config (`asset-doctor.budget.json`)

```json
{
  "version": 1,
  "thresholds": { "occupancy": { "warn": 0.8 } },
  "budgets": {
    "totals.loadedVramBytes": { "error": { "max": "192MB" } },
    "totals.diskBytes":       { "error": { "max": "8MB", "maxDeltaPct": 10 } },
    "drawCallsLowerBound":    { "warn":  { "max": 40 } },
    "findings.crit":          { "error": { "max": 0 } }
  },
  "assets": [
    { "match": "**/*.png", "budgets": { "vramBytes": { "error": { "max": "16MB" } }, "oversizePx": { "error": { "max": 2048 } } } }
  ],
  "ignore": ["**/*.bak.png"]
}
```

- `thresholds` is a `Partial<ThresholdConfig>` deep‑merged over the core defaults (single source of truth).
- Byte budgets **require a unit** (`"8MB"`); a bare number is rejected (the bytes‑vs‑KB footgun).
- Only `error`-level breaches flip the exit; `warn` keeps the check green. `maxDeltaPct` needs `--baseline`.
- Metric keys: `totals.{diskBytes,vramBytes,loadedVramBytes,potentialDiskSaved}`, `findings.{crit,warn,info,total,<rule>}`,
  `drawCallsLowerBound` (a static lower bound = distinct textures). Per‑asset: `vramBytes,diskBytes,occupancy,oversizePx`.

## What the CLI measures (and doesn't)

Measured headless: VRAM (`w×h×4`), loaded‑VRAM (variant‑deduped), disk, occupancy, wasted regions,
oversize/NPOT, should‑atlas, atlas‑merge, integrity, exact‑dupes, `drawCallsLowerBound`.

Needs the browser/extension build (disclosed in the `capabilities` block, **fail‑closed** if budgeted):
transcode‑savings (`format`), near‑dupes (`duplicate-similar`), live draw calls.

## GitHub Action

`action.yml` is a composite action that builds this CLI and gates a PR, computing a before/after
baseline by checking out the base ref in a `git worktree` (degrades gracefully on fork/shallow PRs):

```yaml
- uses: actions/checkout@v4
  with: { fetch-depth: 0 }
- uses: Nonamezzz322/asset-doctor@v1
  with:
    dir: assets
    config: asset-doctor.budget.json
```

## Build

```bash
pnpm --filter @asset-doctor/cli build   # esbuild → apps/cli/dist/cli.js (shebang + exec bit)
```
