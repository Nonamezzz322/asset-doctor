// Milestone 0 shell — proves the Tailwind v4 token wiring and the X-ray-room metaphor.
// The real film-viewer (atlas snapshot + overlays, fed by analysis) arrives in Milestone 1.
export function App() {
  return (
    <div className="min-h-full bg-bg text-ink">
      <header className="border-b border-line bg-panel">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <div className="flex items-baseline gap-3">
            <span className="font-display text-xl font-semibold tracking-tight">Asset Doctor</span>
            <span className="font-mono text-xs text-ink-soft">v0.0.0 · phase 1 · milestone 0</span>
          </div>
          <span className="font-mono text-xs text-teal">x-ray room</span>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-10">
        <h1 className="font-display text-3xl font-semibold tracking-tight">
          Browser-side asset audit for HTML5 games
        </h1>
        <p className="mt-3 max-w-2xl text-ink-soft">
          Drop an asset folder and see the problem map in seconds — wasted atlas space,
          suboptimal formats, oversized textures, excess VRAM. Nothing leaves your device.
        </p>

        {/* Film lightbox placeholder — the real film-viewer arrives in Milestone 1. */}
        <div className="mt-8 rounded-lg border border-dashed border-line bg-film p-10 text-center">
          <p className="font-mono text-sm text-line">
            film-viewer — drag &amp; drop coming in Milestone 1
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-2 font-mono text-xs">
            <span className="rounded px-2 py-1 text-crit ring-1 ring-crit/40">crit</span>
            <span className="rounded px-2 py-1 text-warn ring-1 ring-warn/40">warn</span>
            <span className="rounded px-2 py-1 text-ok ring-1 ring-ok/40">ok</span>
            <span className="rounded px-2 py-1 text-info ring-1 ring-info/40">info</span>
          </div>
        </div>

        <p className="mt-6 font-mono text-xs text-ink-soft">
          disk weight ≠ GPU footprint · VRAM = w × h × 4
        </p>
      </main>
    </div>
  );
}
