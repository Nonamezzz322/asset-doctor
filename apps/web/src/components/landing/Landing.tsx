// The landing shell — nav + sections 1-6, rendered BELOW the Dropzone on the idle/analyzing/error
// screen (inside the existing <main id="ad-main"> landmark). ALL landing t() calls live in this file
// (registered in test/i18n-app-keys.test.ts). Pure decisions come from lib/landing-nav + lib/landing-
// reveal (Node-tested); everything visual here is verified by the design manual gate. No external
// images/fonts/deps — inline SVG + CSS from the real @theme tokens only, so first paint / the instant-wow
// analysis path is never delayed. Reduced-motion: every reveal + smooth-scroll is gated on the shipped
// matchMedia pattern (App.tsx). Honesty gates enforced in the copy (privacy round12 nuance, no "≤10s"
// promise, no fabricated numbers) — see docs/improvements/landing-design.md §1.4.

import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { PRO_GATE_ENABLED } from '../../lib/license';
import { useI18n } from '../../lib/i18n';
import {
  LANDING_SECTIONS,
  LANDING_OPEN_FOLDER_ID,
  h2IdOf,
  landingView,
  pricingLineKey,
  pricingTitleKey,
  type LandingAnchor,
} from '../../lib/landing-nav';
import { revealMode } from '../../lib/landing-reveal';
import { SpecimenFilm } from './SpecimenFilm';

const prefersReduce = (): boolean =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// Focus the target section's h2 (preventScroll so the smooth scroll below isn't cancelled by an instant
// focus jump), then smooth-scroll the SECTION (its scroll-mt-20 clears the sticky header). Reduced-motion
// gated. Local DOM helper (user gesture) — mirrors UX-4's skip-link/focus-move spirit; verified by the gate.
const focusThenScroll = (anchor: LandingAnchor): void => {
  document.getElementById(h2IdOf(anchor))?.focus({ preventScroll: true });
  document.getElementById(anchor)?.scrollIntoView({ behavior: prefersReduce() ? 'auto' : 'smooth' });
};

// The ONE conversion: move focus onto the real Open-folder button (Enter chains straight into the picker),
// not a bare scroll. Reduced-motion gated. No email/signup/demo anywhere (invariant 4).
const scanFolder = (): void => {
  const btn = document.getElementById(LANDING_OPEN_FOLDER_ID);
  btn?.focus({ preventScroll: true });
  btn?.scrollIntoView({ behavior: prefersReduce() ? 'auto' : 'smooth', block: 'center' });
};

function LandingCta({ label }: { label: string }) {
  return (
    <div className="mt-8 text-center">
      <button
        type="button"
        onClick={scanFolder}
        className="rounded-lg bg-cta px-5 py-2.5 font-sans text-sm font-semibold text-white shadow-[0_2px_6px_rgba(21,160,106,0.32)] transition hover:bg-cta-hover"
      >
        {label}
      </button>
    </div>
  );
}

export function Landing({ phaseT }: { phaseT: 'idle' | 'analyzing' | 'error' }) {
  const { t } = useI18n();
  const ctas = landingView(phaseT).ctas;
  const rootRef = useRef<HTMLDivElement>(null);

  // Scroll-reveal pre-state, decided ONCE at mount (client-only). 'observe' ⇒ sections start with
  // .ad-reveal-wait (opacity:0) and the effect below reveals them one-shot on scroll; 'static' ⇒ empty
  // class ⇒ everything visible immediately (no-JS/no-IO/reduce never blanks). Computed in a lazy initializer
  // so the initial render already carries the right class (no visible→hidden flash).
  const [revealClass] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    return revealMode(prefersReduce(), 'IntersectionObserver' in window) === 'observe' ? 'ad-reveal-wait' : '';
  });

  useEffect(() => {
    if (revealClass === '') return; // static mode: never attach observers
    const root = rootRef.current;
    if (!root) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.remove('ad-reveal-wait');
            e.target.classList.add('ad-reveal');
            io.unobserve(e.target); // one-shot
          }
        }
      },
      { threshold: 0.15 },
    );
    for (const el of root.querySelectorAll<HTMLElement>('[data-reveal]')) io.observe(el);
    return () => io.disconnect();
  }, [revealClass]);

  const onAnchorClick = (anchor: LandingAnchor) => (e: MouseEvent) => {
    e.preventDefault();
    focusThenScroll(anchor);
    // replaceState (no hashchange ⇒ the settings router never fires) — a scroll hash, not a history entry.
    history.replaceState(null, '', `#${anchor}`);
  };

  const steps = [
    { title: t('landing.how.step1.title'), body: t('landing.how.step1.body') },
    { title: t('landing.how.step2.title'), body: t('landing.how.step2.body') },
    { title: t('landing.how.step3.title'), body: t('landing.how.step3.body') },
  ];
  const caps = [
    { title: t('landing.caps.film.title'), body: t('landing.caps.film.body') },
    { title: t('landing.caps.vram.title'), body: t('landing.caps.vram.body') },
    { title: t('landing.caps.parsers.title'), body: t('landing.caps.parsers.body') },
    { title: t('landing.caps.polygon.title'), body: t('landing.caps.polygon.body') },
    { title: t('landing.caps.formats.title'), body: t('landing.caps.formats.body') },
    { title: t('landing.caps.probe.title'), body: t('landing.caps.probe.body') },
    { title: t('landing.caps.ci.title'), body: t('landing.caps.ci.body') },
    { title: t('landing.caps.i18n.title'), body: t('landing.caps.i18n.body') },
  ];
  const faqs = [
    { q: t('landing.faq.q1'), a: t('landing.faq.a1') },
    { q: t('landing.faq.q2'), a: t('landing.faq.a2') },
    { q: t('landing.faq.q3'), a: t('landing.faq.a3') },
    { q: t('landing.faq.q4'), a: t('landing.faq.a4') },
    { q: t('landing.faq.q5'), a: t('landing.faq.a5') },
  ];
  const legend = [
    { kind: 'empty' as const, label: t('legend.empty') },
    { kind: 'transparent' as const, label: t('legend.transparent') },
    { kind: 'bleeding' as const, label: t('legend.bleeding') },
    { kind: 'duplicate-frame' as const, label: t('legend.duplicateFrame') },
  ];

  const h2Class = 'ad-focus-anchor font-display text-2xl font-semibold tracking-tight sm:text-3xl';

  return (
    <div ref={rootRef}>
      {/* Scroll affordance — static (no bounce), same click behavior as the nav links. */}
      <div className="mt-10 text-center">
        <a
          href="#how-it-works"
          onClick={onAnchorClick('how-it-works')}
          className="inline-flex items-center gap-1.5 font-mono text-[11px] text-ink-soft transition hover:text-ink"
        >
          {t('landing.scrollHint')}
          <span aria-hidden="true">↓</span>
        </a>
      </div>

      {/* NAV — in-flow table of contents (NOT in the sticky header — ruled). ink text; teal is the hover
          border accent only (teal text fails AA on panel). */}
      <nav aria-label={t('landing.nav.label')} className="mt-12 flex flex-wrap justify-center gap-2">
        {LANDING_SECTIONS.map((s) => (
          <a
            key={s.anchor}
            href={`#${s.anchor}`}
            onClick={onAnchorClick(s.anchor)}
            className="rounded-full border border-line bg-panel px-3.5 py-1.5 font-mono text-xs text-ink transition hover:border-teal"
          >
            {t(s.navKey)}
          </a>
        ))}
      </nav>

      {/* SECTION 1 — HOW IT WORKS */}
      <section id="how-it-works" aria-labelledby={h2IdOf('how-it-works')} data-reveal className={`mt-20 scroll-mt-20 ${revealClass}`}>
        <h2 id={h2IdOf('how-it-works')} tabIndex={-1} className={`${h2Class} text-center`}>
          {t('landing.how.title')}
        </h2>
        <div className="mt-10 grid gap-4 md:grid-cols-3">
          {steps.map((step, i) => (
            <div key={i} className="rounded-xl border border-line bg-panel p-5">
              <div className="font-mono text-3xl font-semibold leading-none text-teal">{i + 1}</div>
              <h3 className="mt-3 font-display text-[15px] font-semibold">{step.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">{step.body}</p>
            </div>
          ))}
        </div>
        <div className="mx-auto mt-10 max-w-sm">
          <SpecimenFilm alt={t('landing.how.specimenAlt')} caption={t('landing.how.specimenCaption')} legend={legend} />
        </div>
        {ctas ? <LandingCta label={t('landing.cta')} /> : null}
      </section>

      {/* SECTION 2 — DISK ≠ VRAM (compact) */}
      <section id="disk-vram" aria-labelledby={h2IdOf('disk-vram')} data-reveal className={`mx-auto mt-20 max-w-3xl scroll-mt-20 ${revealClass}`}>
        <h2 id={h2IdOf('disk-vram')} tabIndex={-1} className={`${h2Class} text-center`}>
          {t('landing.vram.title')}
        </h2>
        <p className="mx-auto mt-4 max-w-2xl text-pretty text-center text-sm leading-relaxed text-ink-soft">
          {t('landing.vram.body')}
        </p>
        {/* Token figure: a small file on disk vs a fixed 16 MB on the GPU. One role=img group; inner
            labels aria-hidden (the alt carries the meaning). */}
        <div role="img" aria-label={t('landing.vram.figureAlt')} className="mt-8">
          <div className="flex flex-wrap items-end justify-center gap-8" aria-hidden="true">
            <div className="flex flex-col items-center gap-2">
              <div className="flex h-24 w-24 items-center justify-center rounded-lg border border-line bg-panel">
                <span className="font-mono text-sm font-semibold text-ink">{t('landing.vram.disk.value')}</span>
              </div>
              <span className="font-mono text-[11px] text-ink-soft">{t('landing.vram.disk.label')}</span>
            </div>
            <div className="flex flex-col items-center gap-2">
              <div className="ad-grid flex h-24 w-24 items-center justify-center rounded-lg border border-film-border">
                <span className="font-mono text-sm font-semibold text-white">{t('landing.vram.gpu.value')}</span>
              </div>
              <span className="font-mono text-[11px] text-ink-soft">{t('landing.vram.gpu.label')}</span>
            </div>
          </div>
          <p className="mt-5 text-center font-mono text-xs text-ink-soft" aria-hidden="true">{t('landing.vram.math')}</p>
          <p className="mt-1 text-center font-mono text-[11px] text-ink-soft" aria-hidden="true">{t('landing.vram.mip')}</p>
        </div>
        <p className="mx-auto mt-6 max-w-2xl text-pretty text-center text-sm leading-relaxed text-ink-soft">
          {t('landing.vram.note')}
        </p>
      </section>

      {/* SECTION 3 — CAPABILITIES */}
      <section id="features" aria-labelledby={h2IdOf('features')} data-reveal className={`mt-20 scroll-mt-20 ${revealClass}`}>
        <h2 id={h2IdOf('features')} tabIndex={-1} className={`${h2Class} text-center`}>
          {t('landing.caps.title')}
        </h2>
        <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {caps.map((c, i) => (
            <div key={i} className="rounded-xl border border-line bg-panel p-5">
              <h3 className="font-display text-[15px] font-semibold">{c.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">{c.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* SECTION 4 — PRIVACY (the one full-bleed dark film strip) */}
      <section id="privacy" aria-labelledby={h2IdOf('privacy')} data-reveal className={`ad-bleed mt-20 scroll-mt-20 bg-film ${revealClass}`}>
        <div className="mx-auto max-w-6xl px-6 py-16">
          <div className="grid gap-10 md:grid-cols-2 md:items-center">
            <div>
              <h2 id={h2IdOf('privacy')} tabIndex={-1} className={`${h2Class} text-white`}>
                {t('landing.privacy.title')}
              </h2>
              <p className="mt-4 text-sm leading-relaxed text-film-soft">{t('landing.privacy.p1')}</p>
              <p className="mt-3 text-sm leading-relaxed text-film-soft">{t('landing.privacy.p2')}</p>
            </div>
            {/* Diagram: analysis loops on-device; a dashed opt-in arrow points at a muted, off-by-default
                server. One role=img; inner SVG text aria-hidden (the alt carries the meaning). No padlock
                theater. */}
            <div className="flex justify-center md:justify-end">
              <svg viewBox="0 0 260 150" role="img" aria-label={t('landing.privacy.figureAlt')} className="w-full max-w-sm">
                {/* device */}
                <rect x={8} y={26} width={116} height={98} rx={10} fill="none" stroke="var(--color-film-soft)" strokeWidth={1.5} />
                {/* analysis loop (stays inside the device) */}
                <path d="M44 86 a22 22 0 1 1 20 12" fill="none" stroke="var(--color-film-soft)" strokeWidth={1.5} />
                <path d="M64 98 l-8 -3 l3 8 z" fill="var(--color-film-soft)" />
                <text x={66} y={44} textAnchor="middle" fontSize={9} fontFamily="var(--font-mono)" fill="var(--color-film-soft)" aria-hidden="true">
                  {t('landing.privacy.device')}
                </text>
                {/* dashed opt-in arrow → server */}
                <line x1={126} y1={75} x2={182} y2={75} stroke="var(--color-teal)" strokeWidth={1.5} strokeDasharray="5 4" />
                <path d="M182 75 l-9 -4 l0 8 z" fill="var(--color-teal)" />
                <text x={154} y={66} textAnchor="middle" fontSize={8} fontFamily="var(--font-mono)" fill="var(--color-teal)" aria-hidden="true">
                  {t('landing.privacy.optIn')}
                </text>
                {/* server (muted, off by default — crossed) */}
                <rect x={188} y={46} width={62} height={58} rx={8} fill="none" stroke="var(--color-film-mute)" strokeWidth={1.5} />
                <line x1={198} y1={56} x2={240} y2={94} stroke="var(--color-film-mute)" strokeWidth={1.5} />
                <text x={219} y={120} textAnchor="middle" fontSize={9} fontFamily="var(--font-mono)" fill="var(--color-film-mute)" aria-hidden="true">
                  {t('landing.privacy.server')}
                </text>
              </svg>
            </div>
          </div>
        </div>
      </section>

      {/* SECTION 5 — FREE / PRO */}
      <section id="pricing" aria-labelledby={h2IdOf('pricing')} data-reveal className={`mt-20 scroll-mt-20 ${revealClass}`}>
        <h2 id={h2IdOf('pricing')} tabIndex={-1} className={`${h2Class} text-center`}>
          {t(pricingTitleKey(PRO_GATE_ENABLED))}
        </h2>
        <div className="mx-auto mt-8 max-w-4xl rounded-2xl border border-line bg-panel p-8">
          <div className="grid gap-5 md:grid-cols-2">
            <div className="rounded-xl border border-line bg-bg p-5">
              <h3 className="font-display text-[15px] font-semibold">{t('landing.pricing.diag.title')}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">{t('landing.pricing.diag.body')}</p>
            </div>
            <div className="rounded-xl border border-line bg-bg p-5">
              <h3 className="font-display text-[15px] font-semibold">{t('landing.pricing.fix.title')}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">{t('landing.pricing.fix.body')}</p>
              {/* teal-bordered mono chip — NOT green, not a button (green = the one action color); the SAME
                  gate constant LicensePanel uses, so the copy can never contradict the gate. */}
              <span className="mt-3 inline-block rounded-full border border-teal px-2.5 py-0.5 font-mono text-[11px] text-ink">
                {t(pricingLineKey(PRO_GATE_ENABLED))}
              </span>
            </div>
          </div>
          {ctas ? <LandingCta label={t('landing.cta')} /> : null}
        </div>
      </section>

      {/* SECTION 6 — FAQ (summaries are NOT headings ⇒ the outline stays monotonic) */}
      <section id="faq" aria-labelledby={h2IdOf('faq')} data-reveal className={`mx-auto mt-20 max-w-3xl scroll-mt-20 ${revealClass}`}>
        <h2 id={h2IdOf('faq')} tabIndex={-1} className={`${h2Class} text-center`}>
          {t('landing.faq.title')}
        </h2>
        <div className="mt-8 space-y-2.5">
          {faqs.map((f, i) => (
            <details key={i} className="rounded-md border border-line bg-panel p-3 open:pb-3.5">
              <summary className="cursor-pointer font-sans text-sm font-semibold text-ink">{f.q}</summary>
              <p className="mt-2 text-sm leading-relaxed text-ink-soft">{f.a}</p>
            </details>
          ))}
        </div>
        {ctas ? <LandingCta label={t('landing.cta')} /> : null}
      </section>
    </div>
  );
}
