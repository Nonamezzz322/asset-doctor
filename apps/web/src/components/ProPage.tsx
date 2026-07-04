// The honest Pro / License screen (app-screen re-skin Phase 4) — the third nav destination. It is the REAL
// LicensePanel surface, NOT the mockup's fake payment screen: there is NO card-number/expiry/CVC field, NO
// "Pay", NO fabricated prices, NO monthly/annual toggle (invariant 2/3/4). When the Pro gate is OFF (the
// default beta) the fix is free and the copy says so; when it is ON, the only conversion is the offline
// ed25519 ActivatePanel (a real Stripe checkout link appears only if VITE_CHECKOUT_URL is set — handled
// inside ActivatePanel). Panel/subtitle decisions come from the pure Node-tested lib/pro-view.ts. Monotonic
// outline h1 -> h2 -> h3; token-only classes (dark-safe).

import { useI18n } from '../lib/i18n';
import { PRO_GATE_ENABLED } from '../lib/license';
import { pricingLineKey } from '../lib/landing-nav';
import { proPanel, proSubtitleKey } from '../lib/pro-view';
import { ActivatePanel, ProBadge } from './LicensePanel';

/** `unlocked` / `onUnlockedChange` are the SINGLE app-level Pro entitlement (probed once in App, also drives
 *  the sidebar plan card + FixCard) — so activating/deactivating here keeps every surface in sync. */
export function ProPage({ unlocked, onUnlockedChange }: { unlocked: boolean; onUnlockedChange: (v: boolean) => void }) {
  const { t } = useI18n();
  const panel = proPanel(PRO_GATE_ENABLED, unlocked);
  return (
    <section aria-labelledby="ad-pro-h1" className="mx-auto max-w-4xl">
      <h1 id="ad-pro-h1" tabIndex={-1} className="ad-focus-anchor font-display text-3xl font-semibold tracking-tight text-ink">
        {t('pro.screen.title')}
      </h1>
      <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-ink-soft">{t(proSubtitleKey(PRO_GATE_ENABLED))}</p>

      <h2 className="ad-label mt-8 text-teal-text">{t('pro.screen.plans')}</h2>
      <div className="mt-3 grid gap-5 md:grid-cols-2">
        <div className="rounded-2xl border border-line bg-panel p-6">
          <h3 className="font-display text-[15px] font-semibold text-ink">{t('landing.pricing.diag.title')}</h3>
          <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">{t('landing.pricing.diag.body')}</p>
        </div>
        <div className="rounded-2xl border border-line bg-panel p-6">
          <h3 className="font-display text-[15px] font-semibold text-ink">{t('landing.pricing.fix.title')}</h3>
          <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">{t('landing.pricing.fix.body')}</p>
          {/* teal-bordered mono chip — the SAME gate constant LicensePanel/landing use, so the copy can never
              contradict the gate (beta-free vs requires-a-key). Not a button (green = the one action color). */}
          <span className="mt-3 inline-block rounded-full border border-teal px-2.5 py-0.5 font-mono text-[11px] text-ink">
            {t(pricingLineKey(PRO_GATE_ENABLED))}
          </span>
        </div>
      </div>

      {/* The one conversion surface, honest per gate state. NO payment form anywhere. */}
      <div className="mt-6 rounded-2xl border border-line bg-panel p-6 text-center">
        {panel === 'beta' ? (
          <p className="mx-auto max-w-md font-mono text-xs leading-relaxed text-ink-soft">{t('pro.screen.betaNote')}</p>
        ) : panel === 'active' ? (
          <>
            <p className="font-mono text-xs text-ink-soft">{t('pro.screen.activeTitle')}</p>
            <ProBadge onDeactivated={() => onUnlockedChange(false)} />
          </>
        ) : (
          <>
            <p className="font-mono text-xs text-ink-soft">{t('pro.note')}</p>
            <ActivatePanel onUnlocked={() => onUnlockedChange(true)} />
          </>
        )}
      </div>
    </section>
  );
}
