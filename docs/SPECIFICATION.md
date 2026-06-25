# Asset Doctor — Specification (STUB / TODO)

> This is a placeholder. The full specification (requirements, the §6 checks catalogue,
> architecture, data model, roadmap) has not been written yet. The founding brief in
> [`AGENT_GUIDE.md`](AGENT_GUIDE.md) is currently the source of truth; `CLAUDE.md` is the
> compressed per-session view.

To be filled in (or provided) — proposed outline:

1. **Problem & positioning** — pain, why no direct competitor, the moat.
2. **Architecture invariants** — the 5 invariants (see AGENT_GUIDE §2).
3. **Ingest & profiling modes** — A (local folder), B (URL headless), C (SDK/extension); see AGENT_GUIDE §4.
4. **Checks catalogue** — per-check definition, inputs, thresholds, severity mapping, proof, fix, effect.
5. **Data model** — the `@asset-doctor/core` contracts (atlas + analysis), versioning rules.
6. **Render-probe** — what is measured, device-independent vs timing metrics, GL instrumentation.
7. **UI** — the X-ray-room / film-viewer spec, overlays, design tokens.
8. **Roadmap** — phases 0–4 (see AGENT_GUIDE §6).

The normalized data model already implemented lives in
[`../packages/core/src/index.ts`](../packages/core/src/index.ts).
