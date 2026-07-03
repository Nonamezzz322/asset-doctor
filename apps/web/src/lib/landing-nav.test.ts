// apps/web has NO React test harness (vitest env=node), so the landing's load-bearing model — the frozen
// anchor contract, the nav/section registry, the mount/CTA rule and the pricing-line gate — is pinned here
// (same discipline as progress-view.test.ts / focus-move.test.ts). These lock the contract the markup and
// the i18n catalog depend on, and guarantee the copy can never contradict the Pro gate.

import { describe, it, expect } from 'vitest';
import {
  LANDING_ANCHORS,
  LANDING_SECTIONS,
  LANDING_OPEN_FOLDER_ID,
  h2IdOf,
  landingView,
  pricingLineKey,
  pricingTitleKey,
  type LandingAnchor,
  type LandingPhase,
} from './landing-nav';

describe('landing-nav — anchors + registry', () => {
  it('the anchor contract is exactly the six ruled ids, in page order', () => {
    expect(LANDING_ANCHORS).toEqual(['how-it-works', 'disk-vram', 'features', 'privacy', 'pricing', 'faq']);
  });

  it('every anchor is locale-independent (lowercase kebab, no spaces / i18n)', () => {
    for (const a of LANDING_ANCHORS) expect(a).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it('the section registry covers each anchor exactly once, in page order', () => {
    expect(LANDING_SECTIONS.map((s) => s.anchor)).toEqual([...LANDING_ANCHORS]);
    expect(new Set(LANDING_SECTIONS.map((s) => s.anchor)).size).toBe(LANDING_ANCHORS.length);
  });

  it('every nav key is under the landing.nav.* namespace', () => {
    for (const s of LANDING_SECTIONS) expect(s.navKey).toMatch(/^landing\.nav\./);
  });

  it('h2IdOf is deterministic, unique across anchors, and never equal to a section id', () => {
    const ids = LANDING_ANCHORS.map(h2IdOf);
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of LANDING_ANCHORS) {
      expect(h2IdOf(a)).toBe(`${a}-h2`);
      expect(h2IdOf(a)).not.toBe(a); // the label id must not collide with the section anchor id
    }
  });
});

describe('landing-nav — mount / CTA rule (exhaustive over the phase union)', () => {
  const cases: Array<[LandingPhase, { mounted: boolean; ctas: boolean }]> = [
    ['idle', { mounted: true, ctas: true }],
    ['analyzing', { mounted: true, ctas: false }],
    ['error', { mounted: true, ctas: true }],
    ['done', { mounted: false, ctas: false }],
  ];
  for (const [phase, expected] of cases) {
    it(`${phase} ⇒ ${JSON.stringify(expected)}`, () => {
      expect(landingView(phase)).toEqual(expected);
    });
  }
});

describe('landing-nav — pricing line can never contradict the gate', () => {
  it('gate ON ⇒ "gated"; gate OFF ⇒ "beta"', () => {
    expect(pricingLineKey(true)).toBe('landing.pricing.gated');
    expect(pricingLineKey(false)).toBe('landing.pricing.beta');
  });

  // The headline follows the SAME gate discipline as the chip: gate ON must NOT reuse the beta-free title
  // (else the h2 would claim the fix is free directly above the "Requires a license key" chip).
  it('title: gate ON ⇒ "titleGated" (no beta-free claim); gate OFF ⇒ "title"', () => {
    expect(pricingTitleKey(true)).toBe('landing.pricing.titleGated');
    expect(pricingTitleKey(false)).toBe('landing.pricing.title');
  });
});

describe('landing-nav — frozen id contract with the Dropzone markup', () => {
  it('the CTA focus target id matches the Open-folder button id', () => {
    expect(LANDING_OPEN_FOLDER_ID).toBe('ad-open-folder');
  });

  it('LandingAnchor stays assignable from the frozen list (type/value in sync)', () => {
    const a: LandingAnchor = 'faq';
    expect(LANDING_ANCHORS).toContain(a);
  });
});
