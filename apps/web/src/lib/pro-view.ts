// PURE gate-honest Pro-view model (app-screen re-skin Phase 4). apps/web has NO React harness (vitest
// env=node), so the honesty-critical decision — what the Pro screen + the sidebar plan card show in each
// gate/entitlement state — lives here and is Node-unit-tested. HONESTY (invariant 3/4): when the Pro gate is
// OFF (the default beta), activation does not exist and the fix is FREE — the copy must never claim otherwise,
// and there is NO payment surface anywhere (the only real conversion is the offline ed25519 ActivatePanel
// when the gate is ON). Returns i18n KEYS (pinned by pro-view.test.ts against CATALOGS.en) so the app-keys
// scanner, which cannot see helper-returned keys, still has a proof they exist.

export type ProPanel = 'beta' | 'activate' | 'active';

/** Which panel the Pro screen (and the plan card) shows. Gate OFF ⇒ 'beta' (free, no activation); gate ON ⇒
 *  'active' when a license is unlocked on this device, else 'activate'. */
export function proPanel(gateEnabled: boolean, unlocked: boolean): ProPanel {
  if (!gateEnabled) return 'beta';
  return unlocked ? 'active' : 'activate';
}

/** The Pro-screen subtitle key — gate-disciplined: must NOT claim the fix is free while the gate is ON. */
export function proSubtitleKey(gateEnabled: boolean): string {
  return gateEnabled ? 'pro.screen.subGated' : 'pro.screen.subBeta';
}

/** Sidebar plan-card VALUE key — honest per state (Free · beta / Free / Pro). */
export function planValueKey(p: ProPanel): string {
  return p === 'active' ? 'pro.plan.value.pro' : p === 'activate' ? 'pro.plan.value.free' : 'pro.plan.value.beta';
}

/** Sidebar plan-card ACTION key — always routes to PRO_HASH; label honest per state. */
export function planActionKey(p: ProPanel): string {
  return p === 'active' ? 'pro.plan.action.manage' : p === 'activate' ? 'pro.plan.action.upgrade' : 'pro.plan.action.about';
}
