// Pro activation UI. Only ever shown when the gate is enabled (VITE_PRO_GATE === 'true'); in the free
// beta this never renders. Paste a license key → activate this device → unlock the fix. The only
// network call is /v1/activate; the entitlement is then verified offline.

import { useState } from 'react';
import { useI18n } from '../lib/i18n';
import { activate, deactivate, LicenseError } from '../lib/license';

const CHECKOUT_URL = ((import.meta.env as Record<string, string | undefined>).VITE_CHECKOUT_URL ?? '').trim();

const KNOWN_CODES = new Set(['unknown_key', 'inactive', 'seats_exceeded', 'reactivate', 'network', 'rate_limited']);

export function ActivatePanel({ onUnlocked }: { onUnlocked: () => void }) {
  const { t } = useI18n();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!key.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await activate(key);
      onUnlocked();
    } catch (ex) {
      const code = ex instanceof LicenseError ? ex.code : 'generic';
      setErr(t(`license.err.${KNOWN_CODES.has(code) ? code : 'generic'}`));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-2.5 space-y-2 text-left">
      <p className="text-center font-mono text-[10px] text-ink-soft">{t('license.locked')}</p>
      <input
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder={t('license.keyPlaceholder')}
        spellCheck={false}
        autoCapitalize="characters"
        className="w-full rounded-lg border border-line bg-bg px-2.5 py-1.5 font-mono text-[11px] tracking-wide text-ink focus:border-teal"
      />
      <button
        type="submit"
        disabled={busy || !key.trim()}
        className="w-full rounded-lg bg-cta px-3 py-2 font-sans text-xs font-semibold text-white transition hover:bg-cta-hover disabled:opacity-55"
      >
        {busy ? t('license.activating') : t('license.activate')}
      </button>
      {err && <p className="font-mono text-[10px] text-crit">{err}</p>}
      {CHECKOUT_URL && (
        <a
          href={CHECKOUT_URL}
          target="_blank"
          rel="noreferrer"
          className="block text-center font-mono text-[10px] text-teal underline-offset-2 hover:underline"
        >
          {t('license.buy')} →
        </a>
      )}
    </form>
  );
}

/** Small "Pro active · deactivate" footer shown under the fix once unlocked. */
export function ProBadge({ onDeactivated }: { onDeactivated: () => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  return (
    <div className="mt-2 flex items-center justify-center gap-2 font-mono text-[10px] text-ink-soft">
      <span className="inline-flex items-center gap-1 text-ok">
        <span className="h-1.5 w-1.5 rounded-full bg-ok" /> {t('license.active')}
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await deactivate();
          } finally {
            setBusy(false);
            onDeactivated();
          }
        }}
        className="underline-offset-2 hover:text-crit hover:underline disabled:opacity-50"
      >
        {t('license.deactivate')}
      </button>
    </div>
  );
}
