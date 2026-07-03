// The app's first honest contentinfo landmark — a top-level <footer> rendered AFTER </main> (a <footer>
// nested inside <main> does NOT map to contentinfo per HTML-AAM scoping). UX-4 deliberately reserved this
// slot for the landing (docs/improvements/ux4-landmarks-skip-focus.md: "footer=contentinfo … Owned by
// landing-design.md"); there is no pre-existing footer to reuse. Mounted only while the landing itself
// shows (view==='main' && phase!=='done', wired in App.tsx). No email capture / signup / demo (invariant
// 4). The repo is public (GH Pages is live), so the Source-on-GitHub link ships.
import type { ReactNode } from 'react';
import { useI18n } from '../../lib/i18n';

export function LandingFooter({ switcher }: { switcher: ReactNode }) {
  const { t } = useI18n();
  return (
    <footer className="mt-20 border-t border-line">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-8">
        {/* the disk≠VRAM motto (existing key — the page's honest sign-off) */}
        <p className="font-mono text-[11px] text-ink-soft">{t('dropzone.footnote')}</p>
        {/* the single secondary CTA — GitHub / CLI pointer (ink link, NOT green) */}
        <div className="flex flex-col gap-0.5">
          <a
            href="https://github.com/Nonamezzz322/asset-doctor"
            target="_blank"
            rel="noreferrer noopener"
            className="font-sans text-sm text-ink underline underline-offset-2 transition hover:decoration-teal"
          >
            {t('landing.footer.github')}
          </a>
          <span className="font-mono text-[11px] text-ink-soft">{t('landing.footer.cli')}</span>
        </div>
        {/* locale echo — the shared LanguageSwitcher, passed in so nothing moves files */}
        {switcher}
      </div>
    </footer>
  );
}
