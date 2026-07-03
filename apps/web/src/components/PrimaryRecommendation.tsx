import { useI18n } from '../lib/i18n';
import { useBuildSettings } from '../lib/settings-ctx';

// The PRIMARY "Build a spritesheet" recommendation card (spritesheet-first design §4). Rendered between the
// results <h1> and the VerdictBar, gated on `looseRecommendation(report)` — so it appears ONLY when the
// folder is loose-dominated. INVARIANT 3 (objectivity): this card INVENTS NOTHING. `n` is the should-atlas
// finding's own count (verbatim, via the caller's `rec.n`); the body reuses the should-atlas wording; there
// is NO fabricated draw-call/byte headline (draw calls depend on the on-screen batched set — unmeasurable
// statically). The copy says "N loose sprites detected" (a DETECTION count), never "will pack exactly N",
// because should-atlas.relatedRefs is size-gated ≤512px while the pack candidate filter also admits Spine
// roots of any size — the two counts may differ (design §4.3 size-gate divergence note).
//
// [Build]: flips the shared `packLoose` build-setting ON for the next run (patch — never persisted, per-run)
// AND bumps the App's buildNonce so the FixCard previews a plan that includes the pack ops and scrolls into
// view. `patch` comes from THIS component's own useBuildSettings() (App renders the provider, so App itself is
// OUTSIDE the context and cannot read it); the App-owned `onBuild` only bumps the nonce. Net click behavior:
// patch({ packLoose: true }) + setBuildNonce(x => x + 1). No pack-engine change; the Pro gate is unchanged.
//
// [Configure]: a plain hash link to the Settings page (SETTINGS_HASH) — identical precedent to the existing
// optimize-entry deep-link; the user then toggles/tunes packing there.

export function PrimaryRecommendation({
  n,
  onBuild,
  configureHref,
}: {
  /** should-atlas.params.n, verbatim (via the caller's LooseRecommendation.n) — never re-derived here. */
  n: number;
  /** App-owned: bump the buildNonce (setBuildNonce(x => x + 1)). Called together with the local packLoose patch. */
  onBuild: () => void;
  /** Deep link to the Settings page pack section (SETTINGS_HASH). */
  configureHref: string;
}) {
  const { t } = useI18n();
  const { patch } = useBuildSettings();

  const handleBuild = () => {
    // React batches both updates into one commit: the context re-renders with packLoose:true and the App
    // re-renders with the new nonce, so the FixCard's nonce effect reads the already-updated settings.
    patch({ packLoose: true });
    onBuild();
  };

  return (
    <section
      aria-labelledby="ad-pack-rec-h"
      className="rounded-xl border border-line bg-panel p-4"
    >
      <h2 id="ad-pack-rec-h" className="font-display text-base font-semibold text-ink">
        {t('recommend.pack.title')}
      </h2>
      <p className="mt-1 font-mono text-[13px] leading-relaxed text-ink">
        {t('recommend.pack.body', { n })}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleBuild}
          className="rounded-lg bg-cta px-3 py-2 font-sans text-xs font-semibold text-white shadow-[0_2px_6px_rgba(21,160,106,0.32)] transition hover:bg-cta-hover"
        >
          {t('recommend.pack.build')}
        </button>
        <a
          href={configureHref}
          className="rounded-lg border border-line px-3 py-2 font-mono text-xs text-teal-text transition hover:border-teal"
        >
          {t('recommend.pack.configure')}
        </a>
      </div>
    </section>
  );
}
