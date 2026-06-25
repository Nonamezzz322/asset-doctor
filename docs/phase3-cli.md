# Phase 3 — CLI + GitHub Action budget gate

Bring the static asset audit to the terminal and CI: gate a PR on an asset budget (disk, VRAM,
atlasing) by **reusing the existing core** (`@asset-doctor/{ingest,parsers,analysis}`) in Node. Assets
are read from the checkout and **never uploaded** (invariant 1 holds — heavy work is local, not server).

## Decisions (signed off)

| Fork | Choice | Why |
| --- | --- | --- |
| Structure | `packages/budget` (pure lib) + `apps/cli` (thin bin) + root `action.yml` | packages stay pure/testable, apps are endpoints; the Action and Vitest reuse the gate as a function, not a spawned process. The gate contract stays OUT of `core`. |
| Config | JSON `asset-doctor.budget.json` (+ `package.json#assetDoctor` fallback) | inert data only (objectivity: never execute a user `.js` config in CI), zero-dep, diff-reviewable, machine-writable by `init`. |
| Action | Composite invoking the CLI | one home for gate logic → dev/CI parity, zero drift; before/after via `git worktree` of the base ref. |
| Metric scope | Headless metrics + **fail-closed** on browser-only | a green check provably means measured-and-within-budget; budgeting an unmeasurable metric is exit 2, never a silent pass. |

## Surface

- `audit <dir>` — measure & report (exit 0); produces the baseline JSON for the Action.
- `budget <dir>` — the gate; evaluates the report vs the config and sets the exit code.
- `init <dir>` — scaffold a measured `asset-doctor.budget.json`.

Exit codes: **0** pass/advisory · **1** over budget · **2** config/usage (fail-closed) · **3** input · **4** internal.

Outputs: human table (default) / `--json` / `--out file` (always JSON) / `--sarif` / `--summary`
(job summary md) / `--annotate` (GitHub `::error`/`::warning`, worst-first, capped, escaped).

## Reuse, no drift

`ingest.groupFiles` → `parsers.{parseAtlas,parseSpinePage,parseImage}` → `analysis.mergeSharedAtlases`
→ `analysis.analyze` — the exact web-worker pipeline. The only Node-side substitution is `node:crypto`
SHA-256 for `ImageFeatures.contentHash` (exact-dup). `fmtBytes`/`vramBytes`/`DEFAULT_THRESHOLDS` are
imported, so CLI and web numbers match by construction. `thresholds` in the config is a
`Partial<ThresholdConfig>` deep-merged over the defaults.

## What Node can't measure (disclosed, fail-closed)

No canvas/WebGL in the CLI, so these are **off** and budgeting them is exit 2 (every output carries a
`capabilities` block):

- `format` / transcode-savings → needs `encodeImage` (canvas). `potentialDiskSaved` reflects only
  exact-dup savings in v1.
- `duplicate-similar` / near-dupes → needs dHash (canvas pixel decode).
- live draw calls → needs the WebGL probe (browser/extension). The CLI exposes `drawCallsLowerBound`
  (= distinct textures), a labelled **static lower bound**, never sold as the real count.

VRAM is fully measured (pure `w×h×4`), not a render.

## Determinism

`analyze()` leaves `report.assets` in readdir order, so the JSON emitter sorts assets by ref **and**
gate entries by (scope, ref, key) before serializing — base/head diffs line up regardless of OS readdir
order or a formatter re-sorting the config. `walkDir` also sorts its inputs.

## Adversarial review outcome

A multi-agent review raised 12 findings. Five "path-traversal" criticals were **rejected**: this is a
user-run dev/CI tool (no privilege boundary — the user owns the flags), and confining output paths to
cwd would break the Action's own absolute `$RUNNER_TEMP`/`$GITHUB_STEP_SUMMARY` writes. The "missing
ANSI ESC" finding was a false positive (the ESC byte is present; verified by hexdump + a color-on test).
Fixed the genuine, cheap items: GitHub annotation escaping, deterministic `gate.entries` in JSON, SARIF
rule metadata, markdown pipe escaping, and color-on test coverage.

## Verification

92 tests (budget 31, cli 13) + typecheck + lint green. CLI verified live on fixtures for every exit
code, fail-closed, baseline deltas, init scaffold, warn-only, summary + annotations. `ci.yml` runs the
gate red/green/fail-closed in CI; `asset-budget.yml` dogfoods the composite Action on fixtures.
