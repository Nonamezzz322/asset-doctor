// PURE landing model: the anchor contract + section registry + mount/CTA decision + the pricing-line
// key switch. No React, no DOM (precedent: progress-view.ts / focus-move.ts / results-heading.ts) —
// apps/web has no React/CSS test harness, so the load-bearing landing logic lives here and is
// Node-unit-tested; Landing.tsx is a thin renderer over these outputs.

/** Locale-independent anchor ids (RULED). Frozen contract with the markup + the nav — tests pin them. */
export const LANDING_ANCHORS = ['how-it-works', 'disk-vram', 'features', 'privacy', 'pricing', 'faq'] as const;
export type LandingAnchor = (typeof LANDING_ANCHORS)[number];

/** The h2 id for a section (aria-labelledby + focus target of nav clicks). Derived, never hand-typed. */
export const h2IdOf = (a: LandingAnchor): string => `${a}-h2`;

/** Registry driving BOTH the <nav> and the section render order — one source, no drift. */
export const LANDING_SECTIONS: ReadonlyArray<{ anchor: LandingAnchor; navKey: string }> = [
  { anchor: 'how-it-works', navKey: 'landing.nav.how' },
  { anchor: 'disk-vram', navKey: 'landing.nav.vram' },
  { anchor: 'features', navKey: 'landing.nav.features' },
  { anchor: 'privacy', navKey: 'landing.nav.privacy' },
  { anchor: 'pricing', navKey: 'landing.nav.pricing' },
  { anchor: 'faq', navKey: 'landing.nav.faq' },
];

/** Focus target of every landing CTA: the Dropzone "Open folder" button (repo 'ad-' id convention). */
export const LANDING_OPEN_FOLDER_ID = 'ad-open-folder';

/** MOUNT RULE (ratified): sections render while phase !== 'done' (visible during 'analyzing' — the
 *  progress card stays the focal point); CTAs are hidden while analyzing (the hero CTA is unmounted
 *  then anyway, so there is no scan affordance mid-run). 'error' keeps CTAs — the Dropzone is idle-
 *  equivalent there (the user should retry). */
export type LandingPhase = 'idle' | 'analyzing' | 'error' | 'done';
export function landingView(phase: LandingPhase): { mounted: boolean; ctas: boolean } {
  return { mounted: phase !== 'done', ctas: phase === 'idle' || phase === 'error' };
}

/** The Pro card's status line — driven by the SAME gate constant LicensePanel uses (lib/license.ts),
 *  so the landing copy can never contradict the gate. */
export function pricingLineKey(gateEnabled: boolean): string {
  return gateEnabled ? 'landing.pricing.gated' : 'landing.pricing.beta';
}

/** The pricing section HEADLINE — same gate discipline as pricingLineKey. Gate OFF ⇒ the beta-free
 *  headline; gate ON ⇒ a headline that does NOT assert the fix is free (else the h2 would contradict the
 *  "Requires a license key" chip below it). The diagnosis-is-free half is true under both gates. */
export function pricingTitleKey(gateEnabled: boolean): string {
  return gateEnabled ? 'landing.pricing.titleGated' : 'landing.pricing.title';
}
