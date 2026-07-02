# LANDING DESIGN — "the tool IS the landing" (enriched idle state)

**VERDICT: PROCEED.**

Every feature claim in the ruled outline was re-verified against `docs/FEATURES.md` and the code at
HEAD `4512c48` (branch `feat/asset-pipeline`). Zero contradictions found; one docs drift confirmed
(§1.3) — the spec follows code. The working tree is mid-edit ONLY in
`apps/web/src/lib/{build-config,optimize-entry,build-settings,route}*`, `apps/web/src/worker/fix*`,
`packages/fix/*`, and an untracked `components/SettingsPage.tsx` — **`App.tsx`, `index.css`,
`Dropzone`, `FilmViewer`, i18n catalogs are clean at HEAD**, so HEAD == tree for every surface this
design reads. Implementation lands AFTER the in-flight settings tree merges (§11).

All paths relative to repo root `/home/nonamezzz/Рабочий стол/projects`.

---

## 1. Claim verification (every outline claim, file:line)

### 1.1 Confirmed claims

| # | Claim | Evidence |
|---|---|---|
| 1 | Mount gate: Dropzone renders while `phase.t !== 'done'` | `App.tsx:361-367` |
| 2 | Hero CTA button unmounts during analyzing (ternary) | `App.tsx:573-603` (button at :596-602) |
| 3 | Shipped h1 `dropzone.title` = "Drop an asset folder to diagnose" | `App.tsx:546`; `packages/i18n/src/catalogs/en.json:43` |
| 4 | Scoped subtitle claim "Analysis runs locally — nothing leaves your device" | `en.json:44` (`dropzone.subtitle`), rendered `App.tsx:547` |
| 5 | Zero network in analysis: no fetch/XHR/WebSocket in `analyze.worker.ts` | grep re-run: 0 hits |
| 6 | fix.worker network = ONLY `encodeRemote` (consent-gated) | `git show HEAD:…fix.worker.ts` — only hits are `encodeRemote` imports/calls (:223, :3809, :3903, :3998), each behind the consent gate |
| 7 | Probe never pings pre-opt-in | `lib/backend-client.ts:4-8` ("fired ONLY after Pro unlock + a configured host … never pings the encoder host on page load") |
| 8 | Consent never saved | HEAD `lib/build-config.ts:18-19` ("DELIBERATELY NOT PERSISTED … backendConsent (consent must be per-run)"); per-run reset `App.tsx:2026-2031` |
| 9 | Upload count/preview shown before consent | `App.tsx:1065-1082` |
| 10 | VRAM = w × h × 4; 2048² = 16 MB; +33% mip ceiling | `packages/analysis/src/rules.ts:8-16` (`vramBytes`, `vramBytesMipmapped` ×4/3 = `MIP_OVERHEAD`); CLAUDE.md invariant 5 |
| 11 | Parsers: TexturePacker Hash/Array + Pixi | `packages/parsers/src/atlas.ts:1-4` |
| 12 | Spine/libGDX `.atlas`, legacy + modern, multi-page | `packages/parsers/src/spine-atlas.ts:1-4`; FEATURES.md:12, :114 |
| 13 | BMFont `.fnt` text + XML + binary, byte-identical | `packages/parsers/src/fnt.ts:1-8` |
| 14 | Loose PNG/WebP/JPG/AVIF | FEATURES.md:12 |
| 15 | Format savings from a REAL in-browser encode | FEATURES.md:15 |
| 16 | De-overlapped headline savings (never double-counts) | FEATURES.md:112 |
| 17 | Polygon packer: trace→RDP→earcut→bitmap nesting, VRAM gate, rect fallback | `packages/fix/src/polygon-pack.ts`; FEATURES.md:43 |
| 18 | Keep-original-on-size-loss / "never ships a bigger file" | FEATURES.md:45, :50, :66, :111 |
| 19 | Render-probe CAN read measured draw calls + VRAM (WebGL, results screen) | FEATURES.md:33, :37; `FilmViewer.tsx:99` ("absent for loose assets / no-WebGL") |
| 20 | CLI `audit\|budget\|init` + composite `action.yml`, on-runner | FEATURES.md:105-106; CLAUDE.md Phase 3 |
| 21 | 9 locales, parity-tested | `packages/i18n/src/index.ts:21` (`LOCALES`), `NATIVE_NAME` :25-35 |
| 22 | Pro gate OFF by default → fix free in beta | `lib/license.ts:13-14` (`PRO_GATE_ENABLED = env.VITE_PRO_GATE === 'true'`); gate branch `App.tsx:2037` |
| 23 | `npx asset-doctor` would be FALSE — package is private | `apps/cli/package.json:4` `"private": true` — footer/FAQ say "ship in the repo" ✓ |
| 24 | GitHub remote | `github.com/Nonamezzz322/asset-doctor` (git remote -v). GH Pages live ⇒ public is implied; **CONFIRM visibility at impl time; if private, ship footer without the link** |
| 25 | Tokens + motifs | `index.css:4-30` (@theme), :65-93 (`ad-grid`/`ad-viewer-shadow`/`ad-clip`), :19 (`--color-film-soft`), :52-55 (film-soft focus ring on dark) |
| 26 | Overlay colors single source | `lib/film-legend-style.ts:7-12` (`ZONE_STYLE`: empty/transparent/bleeding/duplicate-frame) — **import, never copy hex** |
| 27 | Four shipped keyframes only | `index.css:95-140` (`ad-reveal`/`ad-scan`/`ad-pulse`/`ad-blink`); reduce block :220-236 |
| 28 | Reduced-motion smooth-scroll pattern | `App.tsx:434-435` (matchMedia + `behavior: reduce ? 'auto' : 'smooth'`) |
| 29 | `<details>` accordion precedent | `App.tsx:507-523` (`UnparsedNotice`) |
| 30 | Zero `scroll-margin`/`scroll-mt` anywhere today | grep re-run: 0 hits in `apps/web/src` |
| 31 | CTA-green button reference style | `App.tsx:596-602` (`bg-cta … hover:bg-cta-hover`, white text, shadow) |
| 32 | `<main>` is `max-w-6xl px-6` ⇒ full-bleed needs a breakout | `App.tsx:350` |
| 33 | Header totals disk vs VRAM (declared/measured) | `App.tsx:328-343` |
| 34 | webkitdirectory fallback exists (file-input picking) | `lib/import.ts:32` (`supportsDirectoryPicker`), :59 (`filesFromInput`), `App.tsx:110` (`setAttribute('webkitdirectory','')`) |
| 35 | "≤10s" is a design target, not a guarantee | FEATURES.md:9 (section heading); copy uses "in seconds" only |
| 36 | Teal text on panel FAILS AA (4.08:1); on bg worse (~3.05:1) | measured in `ux4-design-landmarks-skip-focus-skeleton.md` §1.7 — landing nav/links use ink text, teal for borders/accents only |
| 37 | ink-soft on bg passes AA (UX-3 raised all faded variants) | commit `7840e41`; `--color-ink-soft #566472` vs bg `#e7ecf1` ≈ 4.97:1 |

### 1.2 Existing keys reused (zero new strings for these)

- `dropzone.footnote` = "disk weight ≠ GPU footprint · VRAM = w × h × 4" (`en.json:48`) — the footer motto.
- `legend.empty` / `legend.transparent` / `legend.bleeding` / `legend.duplicateFrame` (`en.json:29-32`) —
  the specimen's mini-legend labels (same decoded meanings as the real FilmViewer legend).
- `dropzone.title` — stays the one visible h1 in the idle state; also names the Dropzone region (UX pick 2).

### 1.3 Docs drift found (follow code)

FEATURES.md:81 describes the film readout as "VRAM/DISK/SIZE/OCC". The CODE renders
**VRAM / DISK / OCC / FRAG** (`FilmViewer.tsx:139-148`; the VRAM cell relabels to `readout.declared`
only when a probe reading exists). The SpecimenFilm mirrors the code. Optional 1-line docs fix
commit at the end of the breakdown.

### 1.4 Honesty gates (BINDING for the implementer — copy review checklist)

- **BANNED anywhere on the page:** unqualified "nothing EVER leaves your device"; any "≤10 s"
  promise ("in seconds" only); future pricing ("free while in beta" only, and only when
  `!PRO_GATE_ENABLED`); "npx asset-doctor" in any locale; fabricated measurements, testimonials,
  screenshots, user counts.
- The scoped subtitle claim (analysis-scoped) is the ONLY place "nothing leaves your device" may
  appear without the opt-in nuance — it is true as scoped and stays verbatim (`en.json:44`).
- The hero tagline's "nothing is uploaded" is scoped by its subject ("Free X-ray" = the diagnosis) —
  ratified wording, keep verbatim.
- Probe copy says "**can** include" — never "always shows".
- Polygon copy MUST carry "optional" + "rectangle fallback".
- The specimen carries the "illustrative example — not a measurement" caption ×9 and shows `—`
  placeholder values (the real FilmViewer's absent-metric convention) — zero fabricated numbers.
- The pricing beta line renders on the SAME constant the LicensePanel uses (`PRO_GATE_ENABLED`,
  `lib/license.ts:14`) so copy can never contradict the gate.

---

## 2. Page structure & mount rule

```
<div min-h-full bg-bg>                          (existing root)
  [skip link — UX pick 2, not ours]
  <header sticky>                               (existing banner; settings link joins it — NOT ours)
  <main id="ad-main" max-w-6xl px-6>            (existing; id from UX pick 2)
    <live region>                               (existing, stays FIRST child, OUTSIDE any wrapper)
    { phase.t !== 'done' && (
      <Dropzone …/>                             ← SECTION 0 (hero, enriched in place)
      <Landing phaseT={phase.t}/>               ← nav + sections 1-6
    )}
    { done && results tree }                    (existing)
  </main>
  { phase.t !== 'done' && <LandingFooter …/> }  ← SECTION 7 (top-level ⇒ real contentinfo)
</div>
```

**Mount rule (binding, ratified):** `Landing` + `LandingFooter` render inside the same
`phase.t !== 'done'` condition as the Dropzone (`App.tsx:361`). They stay mounted DURING
`'analyzing'` (the progress card remains the focal point at the top — deliberate) and unmount at
`'done'`. While analyzing the sections are **inert**: no live regions exist in them at all (static
content), and every landing CTA is hidden (`landingView()`, §5.1). The done-state scroll clamp +
focus is UX pick 2's job (`focusTargetAfterSwap` → `ad-results-h1`); the landing adds nothing there.

**Why the footer is OUTSIDE `<main>`:** a `<footer>` nested in `<main>` does NOT map to the
`contentinfo` landmark (HTML-AAM scoping). Rendering it as a top-level sibling after `</main>`,
under the same phase gate, makes it the app's first honest `contentinfo` (aligns with UX pick 2's
landmark map, which reserved exactly this slot).

**Surface rhythm (ratified):** bg (hero + nav) → bg (S1 how-it-works, dark specimen card inside) →
bg (S2 disk≠vram, compact) → panel cards on bg (S3 capabilities) → **THE one full-bleed dark film
strip** (S4 privacy) → panel (S5 pricing) → bg (S6 FAQ) → bg + top border (S7 footer).

**Heading outline (idle & analyzing):** visible `h1` = `dropzone.title` (`App.tsx:546`) → one `h2`
per section (6 total; nav has aria-label, no heading) → `h3` for S1 steps, S3 cards, S5 cards. FAQ
questions are `<summary>` text, NOT headings (keeps the outline monotonic — same discipline as
UX-3 / results-heading). Results state: everything landing unmounts; the sr-only results h1 model
is untouched.

---

## 3. Section-by-section spec (exact EN + RU copy)

Every string below is a new `landing.*` i18n key unless marked *(existing key)* or *(literal)*.
The remaining 7 locales are written at impl time (parity test enforces ×9).

### SECTION 0 — HERO (surface: bg; the existing Dropzone, enriched in place, never replaced)

Changes inside `Dropzone` (App.tsx:525-614) — three additive lines, nothing removed:

1. **Tagline** — new `<p>` between the h1 (:546) and the subtitle (:547). Style: `mt-3 text-[15px]
   leading-relaxed text-ink` (full ink — it is the value prop, not secondary text).
   - `landing.tagline` EN: `Free X-ray for your game's atlases — runs in your browser, nothing is uploaded.`
   - RU: `Бесплатный рентген атласов вашей игры — работает в браузере, ничего не загружается.`
   - The existing subtitle (`dropzone.subtitle`, scoped analysis claim) stays verbatim below it,
     `text-ink-soft` as today.
2. **Mobile honesty line** — after the footnote (:611), visible only `< sm` (`sm:hidden`), mono 11px
   ink-soft. Never promises mobile analysis (WebGL probe / FS Access limits); file-input picking
   exists (`lib/import.ts:59`) so we don't say "impossible" either.
   - `landing.mobileNote` EN: `Made for desktop browsers — you'll pick a whole asset folder.`
   - RU: `Рассчитано на десктопный браузер — выбирается целая папка ассетов.`
3. **`id={LANDING_OPEN_FOLDER_ID}`** (= `'ad-open-folder'`) on the Open-folder button (:596) — the
   focus target of every landing CTA (§5.2).

**Scroll affordance** — first child of `<Landing>` (so the Dropzone file isn't touched further):
a centered, STATIC (no animation — conservative vs the motion prohibition) mono link:
`<a href="#how-it-works">` with an `aria-hidden` `↓` glyph. `font-mono text-[11px] text-ink-soft`
(AA on bg, §1.1#37). Uses the same click behavior as nav links (§5.2).
- `landing.scrollHint` EN: `See how it works` · RU: `Как это работает`

Honesty: "in seconds" never appears in the hero at all — the existing copy already carries the
instant-wow promise implicitly; S1 step 2 says "in seconds" (the only place).

### NAV — in-flow TOC directly below the hero (ruling: NOT in the sticky header)

`<nav aria-label={t('landing.nav.label')}>` — a wrapping row of pill links, centered,
`mt-12 flex flex-wrap justify-center gap-2`. Each link: `rounded-full border border-line bg-panel
px-3.5 py-1.5 font-mono text-xs text-ink hover:border-teal` (ink text — teal text fails AA, §1.1#36;
teal appears only as the hover border accent). Anchor ids are locale-independent (§5.1).

| key | EN | RU |
|---|---|---|
| `landing.nav.label` | `On this page` | `На этой странице` |
| `landing.nav.how` | `How it works` | `Как это работает` |
| `landing.nav.vram` | `Disk ≠ VRAM` | `Диск ≠ VRAM` |
| `landing.nav.features` | `Capabilities` | `Возможности` |
| `landing.nav.privacy` | `Privacy` | `Приватность` |
| `landing.nav.pricing` | `Free & Pro` | `Бесплатно и Pro` |
| `landing.nav.faq` | `FAQ` | `Вопросы` |

### SECTION 1 — HOW IT WORKS (`#how-it-works`, surface: bg) + SpecimenFilm

`<section id="how-it-works" aria-labelledby="how-it-works-h2" class="scroll-mt-20 mt-20">`.
Layout: h2 centered → 3 step cards (`md:grid-cols-3`, each with an oversized mono step numeral in
teal) → SpecimenFilm (the dark card, `max-w-sm mx-auto mt-10`) → one CTA (§5.2).

| key | EN | RU |
|---|---|---|
| `landing.how.title` (h2) | `Drop. Scan. Read the film.` | `Перетащите. Просканируйте. Прочитайте снимок.` |
| `landing.how.step1.title` (h3) | `Drop a folder` | `Перетащите папку` |
| `landing.how.step1.body` | `TexturePacker (Hash & Array) and Pixi sheets, Spine / libGDX .atlas, BMFont .fnt in text, XML and binary — plus loose PNG / WebP / JPG / AVIF.` | `Листы TexturePacker (Hash и Array) и Pixi, Spine / libGDX .atlas, BMFont .fnt в текстовой, XML и бинарной сериализации — плюс одиночные PNG / WebP / JPG / AVIF.` |
| `landing.how.step2.title` (h3) | `A local worker measures` | `Локальный воркер измеряет` |
| `landing.how.step2.body` | `Analysis runs in a Web Worker on your machine, in seconds. Format savings come from a real in-browser encode of your images — never a guess.` | `Анализ идёт в Web Worker на вашей машине — за считанные секунды. Экономия форматов берётся из реального энкода ваших картинок прямо в браузере, а не из догадки.` |
| `landing.how.step3.title` (h3) | `Read the film` | `Прочитайте снимок` |
| `landing.how.step3.body` | `Each atlas becomes an X-ray film with problem overlays, and the headline savings are de-overlapped — the same byte is never counted twice.` | `Каждый атлас становится рентген-снимком с оверлеями проблем, а итоговая экономия де-оверлапнута — один и тот же байт никогда не считается дважды.` |
| `landing.how.specimenCaption` | `Illustrative example — not a measurement.` | `Иллюстративный пример — не измерение.` |
| `landing.how.specimenAlt` | `Stylized atlas film with example overlay markers: empty space, transparent margins, texture bleeding, duplicate frames.` | `Стилизованный снимок атласа с примерами оверлеев: пустое место, прозрачные поля, texture bleeding, дублирующиеся кадры.` |

Claim mapping: step 1 = §1.1 #11-14; step 2 = #15 (+ "in seconds", never "≤10s", #35);
step 3 = #16, #26.

**SpecimenFilm** (ruling: illustrates step 3 INSIDE this section — no standalone section):
pure presentational component, built ONLY from real tokens (§4.2). Wrapper div carries
`ad-grid ad-clip ad-viewer-shadow rounded-2xl border border-film-border p-3.5 aspect-square`
(the Dropzone's own film styling, App.tsx:561). Inside:
- one inline `<svg role="img" aria-label={specimenAlt}>` (`viewBox="0 0 320 320"`) drawing
  (a) faint "sprite frames" — outlined rects, `stroke: var(--color-film-border)`,
  `fill: rgba(255,255,255,0.05)`; (b) overlay zones with stroke/fill from **imported** `ZONE_STYLE`
  (`empty` also gets `stroke-dasharray` — mirrors "пустота = заливка + пунктир"). Zone/frame
  geometry comes from `lib/landing-specimen.ts` (§4.3) — never inline numbers in the component.
- one `.ad-scanline` div (`aria-hidden`) — the SHIPPED one-shot scan (2.1s, `both` fill — runs
  once; the ratified NO-infinite-loop rule is satisfied by the existing keyframe as-is; under
  reduce it is `display:none` via the existing rule, index.css:227-229).
- readout strip mirroring the CODE's cells (§1.3): `grid grid-cols-4 gap-px rounded-lg border
  border-film-border bg-film-border` with cells `bg-film` — labels *(literals, as in code)*
  `VRAM · DISK · OCC · FRAG`, every value `—` *(literal — the FilmViewer absent-metric convention)*.
- mini-legend row reusing *(existing keys)* `legend.empty/transparent/bleeding/duplicateFrame`,
  swatches from `ZONE_STYLE` (aria-hidden, text carries meaning — same as the real legend).
- caption `landing.how.specimenCaption` under the card, `font-mono text-[10px] text-ink-soft
  text-center` — on the LIGHT bg below the card, not on film.

### SECTION 2 — DISK ≠ VRAM (`#disk-vram`, surface: bg, compact)

`<section id="disk-vram" aria-labelledby="disk-vram-h2" class="scroll-mt-20 mt-20 max-w-3xl mx-auto">`.
The moat in plain language (ratified fold-in of comprehension candidate 13). Complements — does NOT
replace — the in-app explainers backlog (that fix is in-app, not landing copy).

| key | EN | RU |
|---|---|---|
| `landing.vram.title` (h2) | `Disk weight ≠ GPU footprint` | `Вес на диске ≠ нагрузка на GPU` |
| `landing.vram.body` | `GPUs don't store PNGs — they store decoded RGBA pixels. A 2048 × 2048 texture always occupies 16 MB of VRAM, no matter how small the file is on disk.` | `GPU не хранит PNG — он хранит декодированные RGBA-пиксели. Текстура 2048 × 2048 всегда занимает 16 МБ VRAM, каким бы маленьким ни был файл на диске.` |
| `landing.vram.math` | `2048 × 2048 px × 4 bytes = 16 MB` | `2048 × 2048 px × 4 байта = 16 МБ` |
| `landing.vram.mip` | `+33% ceiling when mipmaps are on` | `+33% потолок при включённых мипмапах` |
| `landing.vram.disk.label` | `on disk` | `на диске` |
| `landing.vram.disk.value` | `a few MB` | `несколько МБ` |
| `landing.vram.gpu.label` | `on the GPU` | `на GPU` |
| `landing.vram.gpu.value` | `16 MB` | `16 МБ` |
| `landing.vram.note` | `The report shows both numbers side by side — and the render-probe can measure the real decoded footprint on your GPU.` | `Отчёт показывает оба числа рядом — а render-probe может измерить реальный декодированный футпринт на вашем GPU.` |
| `landing.vram.figureAlt` | `The same texture twice: a small file on disk, a fixed 16 MB in GPU memory.` | `Одна и та же текстура дважды: маленький файл на диске и фиксированные 16 МБ в памяти GPU.` |

Claim mapping: `rules.ts:11` (w×h×4), `:16` (×4/3 mip ceiling), header totals `App.tsx:330-342`,
film readout + `readout.measured` (probe). The 16 MB example is canonical (invariant 5). The disk
side is DELIBERATELY qualitative ("a few MB" — illustrative); 16 MB is the one exact number
(honest math, not a measurement of anyone's file).

**Figure** (token-built, one `role="img"` group with `landing.vram.figureAlt`; inner labels
aria-hidden): two equal squares side by side (`flex justify-center gap-8`) — left: `bg-panel
border border-line rounded-lg` with `landing.vram.disk.value` in mono + label under it; right:
`bg-film rounded-lg` (a mini film card) with `landing.vram.gpu.value` in mono `text-white` +
label. Under both: `landing.vram.math` in `font-mono text-xs text-ink-soft` and `landing.vram.mip`
in `font-mono text-[11px] text-ink-soft`. All numbers/units IBM Plex Mono.

### SECTION 3 — CAPABILITIES (`#features`, surface: panel cards on bg)

`<section id="features" aria-labelledby="features-h2" class="scroll-mt-20 mt-20">`.
h2 = ratified option B (the section's honest thesis). Grid `grid gap-4 lg:grid-cols-3
sm:grid-cols-2 grid-cols-1` (3→2→1 ✓); each card `rounded-xl border border-line bg-panel p-5`,
h3 `font-display text-[15px] font-semibold`, body `mt-1.5 text-sm leading-relaxed text-ink-soft`.

| key | EN | RU |
|---|---|---|
| `landing.caps.title` (h2) | `Measured, not guessed` | `Измерено, а не угадано` |
| `landing.caps.film.title` | `X-ray overlays` | `Рентген-оверлеи` |
| `landing.caps.film.body` | `Empty space, transparent margins, texture bleeding and duplicate frames — highlighted right on the atlas film.` | `Пустота, прозрачные поля, texture bleeding и дублирующиеся кадры — подсвечены прямо на снимке атласа.` |
| `landing.caps.vram.title` | `Disk ≠ VRAM honesty` | `Честность диск ≠ VRAM` |
| `landing.caps.vram.body` | `Every atlas shows its GPU cost next to its disk weight — the math is explained above.` | `Каждый атлас показывает цену в памяти GPU рядом с весом на диске — математика объяснена выше.` |
| `landing.caps.parsers.title` | `Your formats, parsed` | `Ваши форматы разбираются` |
| `landing.caps.parsers.body` | `TexturePacker JSON (Hash & Array), PixiJS sheets, Spine / libGDX .atlas, BMFont .fnt (text, XML, binary), loose PNG / WebP / JPG / AVIF.` | `TexturePacker JSON (Hash и Array), листы PixiJS, Spine / libGDX .atlas, BMFont .fnt (текст, XML, бинарный), одиночные PNG / WebP / JPG / AVIF.` |
| `landing.caps.polygon.title` | `Polygon packing` | `Полигональная упаковка` |
| `landing.caps.polygon.body` | `Optional tight packing: alpha tracing → conservative simplification → triangulation → bitmap nesting. Honest VRAM gate, rectangle fallback.` | `Опциональная плотная упаковка: трассировка альфы → консервативное упрощение → триангуляция → bitmap-nesting. Честный VRAM-гейт и фолбэк на прямоугольники.` |
| `landing.caps.formats.title` | `WebP / AVIF that pays off` | `WebP / AVIF, который окупается` |
| `landing.caps.formats.body` | `Savings are measured by a real in-browser encode. If the new file isn't smaller, you keep the original — never a bigger "optimized" file.` | `Экономия измеряется реальным энкодом в браузере. Если новый файл не меньше — остаётся оригинал; «оптимизированный» файл никогда не бывает больше.` |
| `landing.caps.probe.title` | `Render-probe` | `Render-probe` |
| `landing.caps.probe.body` | `With WebGL available, the report can include measured draw calls and real decoded VRAM from an offscreen render — measurements, not estimates.` | `При доступном WebGL отчёт может включать измеренные draw calls и реальный декодированный VRAM из offscreen-рендера — измерения, а не оценки.` |
| `landing.caps.ci.title` | `CI budget gate` | `Бюджет-гейт в CI` |
| `landing.caps.ci.body` | `The asset-doctor CLI and a composite GitHub Action audit and gate your assets on the runner — they never leave the machine.` | `CLI asset-doctor и composite GitHub Action проверяют и гейтят ассеты прямо на раннере — они не покидают машину.` |
| `landing.caps.i18n.title` | `9 languages` | `9 языков` |
| `landing.caps.i18n.body` | `English · Русский · Deutsch · Español · Português · Français · Italiano · 中文 · हिन्दी — parity-tested.` | `English · Русский · Deutsch · Español · Português · Français · Italiano · 中文 · हिन्दी — с тестами паритета.` |

Per-card claim mapping (all re-verified): film = #26 + FilmViewer.tsx; vram = short echo →
Section 2 (teaching lives there — ruling); parsers = #11-14; polygon = #17 (**carries "optional" +
"rectangle fallback"** — mandatory); formats = #15, #18; probe = #19 (**"can", never "always"**);
ci = #20 (never "npx", #23); i18n = #21 (native names are constant across catalogs — `NATIVE_NAME`).

### SECTION 4 — PRIVACY (`#privacy`, surface: THE one full-bleed dark film strip)

`<section id="privacy" aria-labelledby="privacy-h2" class="ad-bleed scroll-mt-20 mt-20 bg-film">`
with inner `mx-auto max-w-6xl px-6 py-16` (re-establishes the page gutter inside the bleed).
Text: h2 `text-white`, body `text-film-soft` — film-soft/white only (AA on dark; index.css:19,
:52-55). Two-column ≥ md: text left, diagram right; stacks below.

| key | EN | RU |
|---|---|---|
| `landing.privacy.title` (h2) | `Local by default. A server only when you say so — once, per run.` | `Локально по умолчанию. Сервер — только когда вы разрешите, явно и на один запуск.` |
| `landing.privacy.p1` | `The free diagnosis makes zero network calls — your files are parsed and measured entirely in your browser.` | `Бесплатный диагноз не делает ни одного сетевого вызова — файлы разбираются и измеряются целиком в вашем браузере.` |
| `landing.privacy.p2` | `Fixes run in the browser too. The one exception: native-only operations (like KTX2 GPU textures) can use an opt-in backend — off by default, it asks every run, shows exactly which images would be sent, and never remembers your consent.` | `Фиксы тоже выполняются в браузере. Единственное исключение — нативные операции (например, KTX2 GPU-текстуры) могут использовать opt-in бэкенд: выключен по умолчанию, спрашивает при каждом запуске, показывает, какие именно картинки будут отправлены, и никогда не запоминает согласие.` |
| `landing.privacy.device` | `your browser` | `ваш браузер` |
| `landing.privacy.server` | `server` | `сервер` |
| `landing.privacy.optIn` | `opt-in only, per run` | `только opt-in, на один запуск` |
| `landing.privacy.figureAlt` | `Diagram: analysis stays on your device; a dashed opt-in arrow leads to a server that is off by default.` | `Схема: анализ остаётся на устройстве; пунктирная opt-in стрелка ведёт к серверу, выключенному по умолчанию.` |

Claim mapping (the BINDING round12 nuance, carried in spirit verbatim): p1 = §1.1 #5 (grep-verified
workers) — scoped to the diagnosis; p2 = #6 (browser fixes default), #7 (no pre-opt-in ping),
#8 (consent per-run, never persisted), #9 (upload count/preview shown before consent). The
unqualified "nothing EVER leaves your device" is BANNED here and everywhere (§1.4).

**Diagram** (illustrative token art only — NO padlock/encryption theater): one `role="img"` SVG —
a device rectangle (stroke `--color-film-soft`) labeled `landing.privacy.device`, a solid
"analysis" loop arrow inside it, and a **dashed** arrow (stroke-dasharray, `--color-teal`) toward a
server/cloud outline rendered muted (`--color-film-mute`) with a small crossed-out default mark and
caption `landing.privacy.optIn`. Inner text labels via SVG `<text>` in mono, aria-hidden (the
figureAlt carries the meaning). No CTA in this section (green CTA belongs on light surfaces only).

### SECTION 5 — FREE / PRO (`#pricing`, surface: panel)

`<section id="pricing" aria-labelledby="pricing-h2" class="scroll-mt-20 mt-20">` — one big
`rounded-2xl border border-line bg-panel p-8` wrapper; two inner cards `md:grid-cols-2`
(`rounded-xl border border-line bg-bg p-5` — bg-on-panel inversion for contrast rhythm).

| key | EN | RU |
|---|---|---|
| `landing.pricing.title` (h2) | `The diagnosis is free. In beta, the fix is too.` | `Диагноз бесплатный. В бете бесплатен и фикс.` |
| `landing.pricing.diag.title` (h3) | `Diagnosis` | `Диагноз` |
| `landing.pricing.diag.body` | `Always free. No account, no upload — drop a folder and read the film.` | `Всегда бесплатно. Без аккаунта и без загрузки — перетащите папку и прочитайте снимок.` |
| `landing.pricing.fix.title` (h3) | `Pro fix` | `Pro-фикс` |
| `landing.pricing.fix.body` | `Repack, resize, transcode, dedup — an optimized copy of your folder, generated in your browser and downloaded as a zip.` | `Перепаковка, ресайз, транскод, дедуп — оптимизированная копия вашей папки, собранная в браузере и скачанная как zip.` |
| `landing.pricing.beta` | `Free while in beta.` | `Бесплатно, пока идёт бета.` |
| `landing.pricing.gated` | `Requires a license key.` | `Нужен лицензионный ключ.` |

Claims: gate OFF by default → fix free (#22); no registration for diagnosis (invariant 4);
fix output = zip copy, non-destructive (FEATURES.md:58). HONESTY GATES: no future pricing, ever;
the Pro card's status line is `{PRO_GATE_ENABLED ? t('landing.pricing.gated') :
t('landing.pricing.beta')}` — the SAME constant the LicensePanel path uses (`App.tsx:2037`), via
the pure `pricingLineKey()` (§4.1), so copy can never contradict the gate. The status line renders
as a **teal-bordered mono chip** (`border border-teal text-ink font-mono text-[11px] rounded-full
px-2.5 py-0.5`) — deliberately NOT CTA-green and not a button (green = the one action color; teal =
diagnostic chrome; ink text for AA). One shared green CTA (§5.2) below the two cards.

### SECTION 6 — FAQ (`#faq`, surface: bg)

`<section id="faq" aria-labelledby="faq-h2" class="scroll-mt-20 mt-20 max-w-3xl mx-auto">`.
Five `<details class="rounded-md border border-line bg-panel p-3 open:pb-3.5">` accordions —
shipped precedent `App.tsx:507-523` (UnparsedNotice). `<summary class="cursor-pointer font-sans
text-sm font-semibold text-ink">` — summaries are NOT headings (outline stays monotonic).
Answers: `mt-2 text-sm leading-relaxed text-ink-soft`.

| key | EN | RU |
|---|---|---|
| `landing.faq.title` (h2) | `FAQ` | `Вопросы и ответы` |
| `landing.faq.q1` | `Does anything get uploaded?` | `Что-нибудь загружается на сервер?` |
| `landing.faq.a1` | `No — the diagnosis makes zero network calls. Only if you enable an optional native-only fix (like KTX2 GPU textures) and explicitly consent — every run — are those specific images sent. Off by default.` | `Нет — диагноз не делает ни одного сетевого вызова. Только если вы включите опциональный нативный фикс (например, KTX2 GPU-текстуры) и явно согласитесь — при каждом запуске — отправляются именно эти картинки. По умолчанию выключено.` |
| `landing.faq.q2` | `Why does my 2 MB PNG cost 16 MB?` | `Почему мой PNG на 2 МБ стоит 16 МБ?` |
| `landing.faq.a2` | `The GPU stores decoded RGBA pixels, not your compressed file: width × height × 4 bytes. 2048 × 2048 → 16 MB, plus up to +33% if mipmaps are generated.` | `GPU хранит декодированные RGBA-пиксели, а не сжатый файл: ширина × высота × 4 байта. 2048 × 2048 → 16 МБ, плюс до +33% при генерации мипмапов.` |
| `landing.faq.q3` | `Which formats are understood?` | `Какие форматы понимаются?` |
| `landing.faq.a3` | `TexturePacker JSON (Hash & Array), PixiJS sheets, Spine / libGDX .atlas (legacy and modern, multi-page), BMFont .fnt in text, XML and binary, plus loose PNG / WebP / JPG / AVIF images.` | `TexturePacker JSON (Hash и Array), листы PixiJS, Spine / libGDX .atlas (legacy и modern, multi-page), BMFont .fnt в текстовой, XML и бинарной сериализации, плюс одиночные PNG / WebP / JPG / AVIF.` |
| `landing.faq.q4` | `Will the fix break my project?` | `Фикс сломает мой проект?` |
| `landing.faq.a4` | `It never touches your files — you download an optimized copy as a zip, with a receipt of every change (per-file before → after), honest skips for anything it couldn't improve, and loader-migration snippets whenever references change.` | `Он не трогает ваши файлы — вы скачиваете оптимизированную копию как zip, с квитанцией всех изменений (before → after по каждому файлу), честными skip там, где улучшить не вышло, и сниппетами миграции лоадера, если ссылки изменились.` |
| `landing.faq.q5` | `Can I enforce this in CI?` | `Можно ли включить это в CI?` |
| `landing.faq.a5` | `Yes — the asset-doctor CLI and a composite GitHub Action ship in the repo: audit, a fail-closed budget gate, SARIF / summary output. Assets never leave the runner.` | `Да — CLI asset-doctor и composite GitHub Action поставляются в репозитории: аудит, fail-closed бюджет-гейт, вывод SARIF / summary. Ассеты не покидают раннер.` |

Claim mapping: a1 = Section-4 condensed (opt-in nuance ALWAYS present — ruling); a2 = `rules.ts:11`
+ `:16`; a3 = parser list #11-14; a4 = FEATURES.md:58 (zip), :53 (receipt), :111 (honest skips),
:54 (loader migration); a5 = FEATURES.md:105-106 + the npx ruling (#23: "ship in the repo", NEVER
"npx"). One green CTA after the list (§5.2) closes the page's conversion path.

### SECTION 7 — FOOTER (top-level `<footer>` ⇒ contentinfo)

`<footer class="mt-20 border-t border-line">` with inner `mx-auto max-w-6xl px-6 py-8` — surface bg.
Row (`flex flex-wrap items-center justify-between gap-4`):
1. Motto: *(existing key)* `dropzone.footnote` in `font-mono text-[11px] text-ink-soft`.
2. The single secondary CTA — GitHub/CLI pointer (NOT green; ink underline link):
   `<a href="https://github.com/Nonamezzz322/asset-doctor" …>` `landing.footer.github` +
   a mono sub-line `landing.footer.cli`. **Impl-time check:** confirm repo visibility (#24); if
   private, ship the `landing.footer.cli` line without the link.
3. Locale echo: the existing `<LanguageSwitcher/>` mounted a second time (it is a local component
   in App.tsx:465 and shares the i18n context — pass it into `LandingFooter` as a `switcher`
   ReactNode prop so nothing moves files).

| key | EN | RU |
|---|---|---|
| `landing.footer.github` | `Source on GitHub` | `Исходники на GitHub` |
| `landing.footer.cli` | `CLI + GitHub Action — in the repo` | `CLI + GitHub Action — в репозитории` |

No email capture, no signup, no "request demo" anywhere (invariant 4; cross-cutting CTA rule).

---

## 4. Component tree & pure logic

### 4.1 NEW `apps/web/src/lib/landing-nav.ts` (pure, zero DOM — Node-testable)

```ts
// PURE landing model: anchor contract + section registry + mount/CTA decision + the pricing-line
// key switch. No React, no DOM (precedent: progress-view.ts / focus-move.ts / results-heading.ts).

/** Locale-independent anchor ids (RULED). Frozen contract with the markup + the nav — tests pin them. */
export const LANDING_ANCHORS = ['how-it-works', 'disk-vram', 'features', 'privacy', 'pricing', 'faq'] as const;
export type LandingAnchor = (typeof LANDING_ANCHORS)[number];

/** The h2 id for a section (aria-labelledby + focus target of nav clicks). Derived, never hand-typed. */
export const h2IdOf = (a: LandingAnchor): string => `${a}-h2`;

/** Registry driving BOTH the <nav> and the section render order — one source, no drift. */
export const LANDING_SECTIONS: ReadonlyArray<{ anchor: LandingAnchor; navKey: string }> = [
  { anchor: 'how-it-works', navKey: 'landing.nav.how' },
  { anchor: 'disk-vram',    navKey: 'landing.nav.vram' },
  { anchor: 'features',     navKey: 'landing.nav.features' },
  { anchor: 'privacy',      navKey: 'landing.nav.privacy' },
  { anchor: 'pricing',      navKey: 'landing.nav.pricing' },
  { anchor: 'faq',          navKey: 'landing.nav.faq' },
];

/** Focus target of every landing CTA: the Dropzone "Open folder" button (repo 'ad-' id convention). */
export const LANDING_OPEN_FOLDER_ID = 'ad-open-folder';

/** MOUNT RULE (ratified): sections render while phase !== 'done' (visible during 'analyzing' —
 *  the progress card stays the focal point); CTAs hidden while analyzing (the hero CTA is
 *  unmounted then anyway). 'error' keeps CTAs — the Dropzone is idle-equivalent there. */
export type LandingPhase = 'idle' | 'analyzing' | 'error' | 'done';
export function landingView(phase: LandingPhase): { mounted: boolean; ctas: boolean } {
  return { mounted: phase !== 'done', ctas: phase === 'idle' || phase === 'error' };
}

/** The Pro card's status line — SAME gate constant as LicensePanel (lib/license.ts:14), so the
 *  landing can never contradict the gate. */
export function pricingLineKey(gateEnabled: boolean): string {
  return gateEnabled ? 'landing.pricing.gated' : 'landing.pricing.beta';
}
```

### 4.2 NEW `apps/web/src/components/landing/SpecimenFilm.tsx` (presentational, NO `t()` calls)

Props: `{ alt: string; caption: string; legend: Array<{ kind, label }> }` — every string arrives
localized from `Landing.tsx`, so this file needs no i18n-scan registration and stays render-pure.
Imports `ZONE_STYLE` from `../../lib/film-legend-style` (colors — NEVER copied hex) and
`SPECIMEN_FRAMES/SPECIMEN_ZONES/SPECIMEN_VIEWBOX` from `../../lib/landing-specimen`. Renders the
film card described in §3/S1. No state, no effects, no listeners.

### 4.3 NEW `apps/web/src/lib/landing-specimen.ts` (pure data)

```ts
// STATIC illustrative specimen geometry (invariant 3: zero fabricated measurements — geometry only,
// every metric cell renders '—'). Node tests pin: zones pairwise disjoint, all rects inside the
// viewBox, every kind ∈ keys of ZONE_STYLE (imported — cannot drift from the real overlay palette).
import type { OverlayZone } from '@asset-doctor/core';

export const SPECIMEN_VIEWBOX = { w: 320, h: 320 } as const;
export interface SpecimenRect { x: number; y: number; w: number; h: number }
export interface SpecimenZone extends SpecimenRect { kind: OverlayZone['kind'] }
export const SPECIMEN_FRAMES: ReadonlyArray<SpecimenRect> = [ /* ~8 "sprite" rects */ ];
export const SPECIMEN_ZONES: ReadonlyArray<SpecimenZone> = [
  /* one 'empty' (large, right-bottom), one 'transparent' (frame margin), one 'bleeding'
     (thin strip between two adjacent frames), one 'duplicate-frame' (two matching small rects
     count as one zone each — still pairwise disjoint) */
];
```

Exact rect numbers are the implementer's freedom WITHIN the pinned invariants (tests below).
Canvas/fixture-render alternative stays REJECTED (fixture bytes in bundle + async decode).

### 4.4 NEW `apps/web/src/lib/landing-reveal.ts` (pure)

```ts
// Scroll-reveal decision: 'static' = content visible immediately (never attach observers);
// 'observe' = hide-then-reveal via IO. Reduce wins over everything (reveal NOT attached at all
// under reduce — ruled); missing IO (old browsers / jsdom) degrades to visible-by-default.
export type RevealMode = 'static' | 'observe';
export function revealMode(prefersReduce: boolean, hasIntersectionObserver: boolean): RevealMode {
  return !prefersReduce && hasIntersectionObserver ? 'observe' : 'static';
}
```

### 4.5 NEW `apps/web/src/components/landing/Landing.tsx` (ALL landing `t()` calls live here)

Props: `{ phaseT: 'idle' | 'analyzing' | 'error' }`. Contains: scroll affordance, `<nav>`, sections
1-6, the shared `<LandingCta/>` (local subcomponent — the green button, §5.2), the IO reveal wiring
(§7), and the local DOM helper `focusThenScroll` (§5.2). Also mounts `<SpecimenFilm/>` with
localized props. Register in `apps/web/test/i18n-app-keys.test.ts` (`comp('landing/Landing.tsx')`) —
the file's maintenance contract (same MANDATORY step the settings design follows).

### 4.6 NEW `apps/web/src/components/landing/LandingFooter.tsx`

Props: `{ switcher: ReactNode }`. The §3/S7 markup. Register in `i18n-app-keys.test.ts` too.

### 4.7 `App.tsx` — three surgical edits (design against HEAD; re-anchor by JSX after settings lands)

1. `App.tsx:361-367`: wrap the gate's children in a fragment — `<Dropzone …/>` + `<Landing
   phaseT={phase.t}/>` (phase.t is narrowed by the gate; TS: pass as the union minus 'done').
2. `App.tsx:596`: `id={LANDING_OPEN_FOLDER_ID}` on the Open-folder button (+ the §3/S0 tagline `<p>`
   and mobile-note `<p>` inside Dropzone; keys via the existing `useI18n()` already in scope).
3. After `</main>` (`App.tsx:~453`): `{phase.t !== 'done' && <LandingFooter
   switcher={<LanguageSwitcher/>}/>}`.

### 4.8 `apps/web/src/index.css` — two additions (appended near the existing motif blocks)

```css
/* Landing full-bleed strip: escapes <main>'s max-w-6xl px-6 to the viewport edge. Paired with
   overflow-x clip on html below — calc(50% - 50vw) overhangs by the scrollbar width otherwise. */
.ad-bleed {
  margin-inline: calc(50% - 50vw);
}
/* Kill the phantom horizontal scroll from the bleed. `clip` (NOT hidden) — it does not create a
   scroll container, so the sticky header keeps sticking to the viewport. */
html {
  overflow-x: clip;
}

/* Scroll-reveal pre-state. Content hidden ONLY when JS chose 'observe' mode (revealMode) — never
   by default, so no-JS/no-IO/reduce users always see everything. The reveal itself is the SHIPPED
   one-shot ad-reveal keyframe (0.5s ease both). */
.ad-reveal-wait {
  opacity: 0;
}
```

AND appended to the EXISTING reduce block (`index.css:220-236`) — ruled requirement:

```css
  .ad-reveal-wait {
    opacity: 1 !important;
  }
```

(Belt & braces — under reduce the class is never attached, §7; this guards a race on
mid-session OS toggles.) **No new tokens, no new keyframes, no new fonts.**

---

## 5. Behavior

### 5.1 Anchors & nav clicks

- Section elements carry the ruled locale-independent ids `#how-it-works · #disk-vram · #features ·
  #privacy · #pricing · #faq` + Tailwind `scroll-mt-20` (80px > the ~52px sticky header — verified
  zero `scroll-margin` exists anywhere today, §1.1#30; this ALSO establishes the convention UX pick
  1's chip anchor reuses).
- Nav links are real `<a href="#faq">` (SR link list, middle-click, native deep-link scroll on page
  load). Click handler: `e.preventDefault()` → `focusThenScroll(anchor)` →
  `history.replaceState(null, '', '#faq')`. replaceState does NOT fire `hashchange`, and every
  landing hash fail-opens to view `'main'` in the in-flight router (`viewOfHash` exact-matches only
  `'#settings'`) — no router interference either way; preventDefault avoids polluting history with
  scroll entries (same reasoning as UX pick 2's skip link, I5).
- `focusThenScroll(anchor)` (local DOM helper in Landing.tsx, manual-gated):
  `const h2 = document.getElementById(h2IdOf(anchor)); h2?.focus({ preventScroll: true });
  document.getElementById(anchor)?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth' });`
  where `reduce` is the shipped matchMedia pattern (`App.tsx:434`). Focus first with
  `preventScroll` (so the smooth scroll isn't cancelled by the instant focus scroll), then scroll
  the SECTION (its `scroll-mt-20` handles header clearance). Each h2: `id={h2IdOf(anchor)}
  tabIndex={-1} className="… ad-focus-anchor"` (`ad-focus-anchor` = UX pick 2's outline-suppression
  class for tabIndex=-1 anchors; see integration I-3 if the landing somehow lands first).
- We deliberately do NOT add global `scroll-behavior: smooth` — UX pick 2's focus-move relies on
  programmatic `focus()` being an instant jump (their §1.5 verification); a global smooth rule
  would silently change that.

### 5.2 The ONE conversion (cross-cutting CTA rule)

`<LandingCta/>` — the same CTA-green style as the hero button (reference `App.tsx:596-602`:
`rounded-lg bg-cta px-5 py-2.5 font-sans text-sm font-semibold text-white
shadow-[0_2px_6px_rgba(21,160,106,0.32)] hover:bg-cta-hover`), label `landing.cta`:
EN `Scan your folder` · RU `Просканировать папку`.

- Placement: end of S1, end of S5, end of S6 — three instances of the SAME action; no other
  button on the page is green (the pricing status chip is teal-bordered; footer links are ink).
- onClick: `const btn = document.getElementById(LANDING_OPEN_FOLDER_ID);
  btn?.focus({ preventScroll: true }); btn?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth',
  block: 'center' });` — a real focus move onto the Open-folder button (Enter immediately opens the
  picker), not a bare scrollIntoView; reduced-motion-gated. This is the landing's own wiring in the
  same spirit as UX pick 2's helper (their `focusTargetAfterSwap` handles PHASE swaps; CTA clicks
  are a user gesture, so a tiny local handler is the right owner — no shared-module coupling).
- Visibility: rendered only when `landingView(phaseT).ctas` (hidden during 'analyzing' — the hero
  CTA is unmounted then anyway, so there is NO scan affordance mid-run; 'error' keeps them).
- No email capture, no signup, no demo-request — anywhere (invariant 4).

### 5.3 Deep links & edge flows

- Load with `#faq` → router keeps view `main`, browser natively scrolls to the section
  (`scroll-mt-20` clears the header). No focus is moved on load (first Tab must stay on UX pick
  2's skip link).
- Drop a folder while reading `#privacy` → at 'done' the landing unmounts; UX pick 2's focus move
  to `ad-results-h1` yanks the viewport to the results top — the done-state scroll clamp is THEIRS
  by ruling, nothing to do here.
- 'error' phase: Dropzone shows the alert (`role=alert`, App.tsx:610), landing stays fully
  interactive (CTAs visible — user should retry).
- 'analyzing': nav links still scroll (harmless; sections are inert, no live regions, no CTAs).
- 0/1/1000 assets: irrelevant — the landing exists only pre-report and renders O(1) static nodes.

---

## 6. Token usage per section (all existing — zero new tokens)

| Surface | Tokens/classes |
|---|---|
| Hero (S0) | existing Dropzone styling untouched; tagline `text-ink`; mobile note + scroll hint `text-ink-soft` mono |
| Nav | `bg-panel` pills, `border-line`, ink text, `hover:border-teal`; `font-mono` |
| S1 steps | bg surface; step numerals `text-teal font-mono`; titles `font-display`; bodies `text-ink-soft` |
| SpecimenFilm | `ad-grid ad-clip ad-viewer-shadow`, `border-film-border`, `bg-film` cells, `ZONE_STYLE` strokes/fills (imported), `.ad-scanline` one-shot; caption `text-ink-soft` on bg |
| S2 figure | left square `bg-panel border-line`; right square `bg-film` + `text-white`; math/mip `font-mono text-ink-soft`; numbers IBM Plex Mono |
| S3 cards | `bg-panel border-line rounded-xl`; h3 `font-display`; bodies `text-ink-soft` |
| S4 strip | `bg-film` full-bleed (`.ad-bleed`); h2 `text-white`; body `text-film-soft`; diagram strokes `film-soft/film-mute/teal` |
| S5 | wrapper `bg-panel`; inner cards `bg-bg border-line`; status chip `border-teal` + ink text (NOT green, not a button) |
| S6 | `<details>` `bg-panel border-line`; summaries ink; answers `text-ink-soft` |
| Footer | bg + `border-t border-line`; mono ink-soft motto; ink links |
| CTA | `bg-cta`/`hover:bg-cta-hover` white text — the ONLY green on the page |

Fonts: Space Grotesk for every h2/h3; IBM Plex Sans body; IBM Plex Mono for ALL numbers, file
formats, readout labels, nav pills, captions, motto (brand rule).

---

## 7. Reduced-motion plan

- Only the four shipped keyframes are used, and only two of them: `ad-reveal` (one-shot, `both`
  fill — scroll reveal) and `ad-scan` (the specimen's shipped one-shot scanline). NO new keyframes;
  NO infinite loops in the specimen (explicit spec prohibition — battery + CTA distraction); the
  hero's existing `ad-pulse-dot` badge is untouched (pre-existing).
- Scroll-reveal wiring: at mount, `revealMode(matchMedia('(prefers-reduced-motion: reduce)').matches,
  'IntersectionObserver' in window)` — `'static'` ⇒ classes never attached, no observers created
  (reveal NOT attached at all under reduce — ruled); `'observe'` ⇒ sections get `.ad-reveal-wait`,
  one IO (threshold ~0.15) swaps it for `.ad-reveal` and unobserves (one-shot). All new animation
  classes appended to the EXISTING reduce block (index.css:220-236) as belt & braces.
- `.ad-scanline` inside the specimen is already `display:none` under reduce (index.css:227-229).
- Smooth scrolling (nav + CTA) is gated per-call on the same matchMedia (shipped pattern
  App.tsx:434); no global `scroll-behavior`.
- The scroll affordance is static text (no bounce — conservative choice).

## 8. A11y plan

- **Landmarks** (aligns with UX pick 2's reserved map — they own skip link/main/regions/focus
  moves; we own nav + contentinfo + landing regions):
  ```
  banner   <header>                       (existing)
  main     <main id="ad-main">            (existing + pick-2 id)
  ├─ region "Drop an asset folder to diagnose"     (Dropzone — pick 2)
  ├─ nav   "On this page"                          (landing, in-flow below hero)
  ├─ region ×6 — each landing section, aria-labelledby its own h2 (names = visible headlines,
  │            can never drift; matches pick-2's reserved "each a named region" slot)
  └─ (done) region "Asset audit results…" + region "Asset detail"   (pick 2)
  contentinfo <footer>                    (landing — the app's first footer, top-level)
  ```
- **Headings:** idle/analyzing outline = visible h1 (dropzone.title) → 6× h2 → h3 (steps/cards) —
  monotonic; FAQ summaries are not headings. Results state unchanged (sr-only h1 model). Exactly
  one h1 in every state.
- **Keyboard:** nav pills and FAQ summaries are native focusables with the shipped `:focus-visible`
  ring; nav click moves focus to the target h2 (`tabIndex={-1}` + `ad-focus-anchor` — no phantom
  ring); CTA click moves focus onto the real Open-folder button (Enter chains into the picker).
  Tab order: skip link (pick 2) → header → hero CTA → scroll hint → nav pills → section content in
  DOM order → footer links → switcher.
- **SR semantics:** both figures (`SpecimenFilm`, privacy diagram, S2 comparison) are single
  `role="img"` groups with localized alt keys; inner SVG text/labels aria-hidden (no "colored box"
  readouts). The specimen legend mirrors the real FilmViewer legend pattern (swatch aria-hidden,
  text carries meaning, reused `legend.*` keys).
- **Live regions:** ZERO in the landing (inert during analyzing — ruled). The existing status/alert
  regions in Dropzone/App are untouched.
- **Contrast (AA, measured values from §1.1 #36-37):** ink on bg/panel 14-16:1; ink-soft on bg
  ≈4.97:1 (UX-3-approved); white + film-soft on film (shipped dark-surface pair); teal NEVER as
  text on bg/panel (4.08:1/3.05:1 fail) — border/accent only; CTA white-on-green = the shipped
  hero button pair. No `ink-soft/70`-style faded variants anywhere (UX-3 ban).
- **Skip link:** owned by UX pick 2 — the landing adds nothing and must not duplicate it.

## 9. Responsive plan

- Breakpoints: nav wraps (`flex-wrap`); S1 `md:grid-cols-3 → 1`; S3 `lg:3 → sm:2 → 1` (ruled);
  S4/S5 two-up `md` → stacked; specimen `max-w-sm` + `aspect-square` at every width; S2 squares
  stay side-by-side ≥360px (small fixed squares), stack under `flex-wrap` otherwise.
- ≤640px: single column everywhere; the hero shows `landing.mobileNote` (`sm:hidden`); numbers/
  filenames stay IBM Plex Mono at every width.
- 320px audit (manual gate, ties to backlog e): de/ru/hi longest strings — nav pills wrap to rows;
  card bodies are free-height; the full-bleed strip's inner `px-6` gutter holds; `html
  overflow-x: clip` guarantees no horizontal scroll even with the bleed.
- The page body NEVER scrolls horizontally; nothing on the landing needs its own `overflow-x`
  container (no tables/code blocks; the SVG scales via viewBox).

## 10. Perf / instant-wow guarantees

- Analysis worker, probe, ingest — UNTOUCHED. The landing is static JSX below the fold in the same
  bundle: no new deps, no images (inline SVG + CSS only), no fonts, no fetches (CSP-clean), no
  React.lazy (avoids a second request on the GH Pages critical path for ~10 KB of markup).
- Hero above the fold is byte-identical except two added `<p>`s ⇒ first paint unchanged.
- IO: ≤7 observed nodes, unobserved after first reveal; zero scroll listeners; zero per-asset work;
  0/1/1000-asset cost identical (landing never sees the report).
- Bundle delta ≈ +8-14 KB pre-gzip (markup + 74 keys ×9 catalogs) — no measurable TTI shift on the
  GH Pages target; verify in the impl PR with `pnpm build` size output (manual gate).

---

## 11. INTEGRATION NOTES vs the in-flight settings workflow (BINDING sequencing)

Land AFTER the settings tree merges (ruled). Design is against HEAD; the settings design doc
(`settings-page-design.md`) + uncommitted tree files were read for these notes.

- **I-1 Hidden wrapper.** Settings wraps the "Dropzone/results tree verbatim" in
  `<div hidden={view==='settings'}>` inside `<main>` (their §5). `<Landing/>` mounts INSIDE that
  wrapper (next to Dropzone) ⇒ auto-hidden on `#settings` — correct for free. `<LandingFooter/>`
  is OUTSIDE `<main>` ⇒ add `view === 'main' &&` to its render condition at integration (one
  line; without it the footer would show under the settings page).
- **I-2 Header.** The settings link joins the header before `<LanguageSwitcher/>` (their §5) —
  the landing deliberately puts NO nav in the header (ruled deviation from the navigation-lens
  proposal; contested real estate). No collision by construction.
- **I-3 Order vs UX pick 2 (landmarks/skip/focus).** The landing REUSES pick 2's
  `ad-focus-anchor` CSS class (h2 focus targets) and relies on their skip link + done-state focus
  move. If the landing somehow lands first, copy the 4-line `.ad-focus-anchor` block from their
  §4.4 (it is additive) — do NOT duplicate the skip link or focus-move effect.
- **I-4 UX pick 1 (chip anchor).** `scroll-mt-20` on landing sections establishes the exact
  convention their `skipped-chip` jump needs (their §4 cites the same App.tsx:434 scroll pattern) —
  first-in wins, second reuses; zero conflict.
- **I-5 i18n catalogs.** `landing.*` namespace is disjoint from their `settings.*` and from all
  existing keys (verified against en.json) — merge conflicts are textual-only (adjacent JSON
  lines); resolve by keeping both. MANDATORY: register `landing/Landing.tsx` +
  `landing/LandingFooter.tsx` in `apps/web/test/i18n-app-keys.test.ts` (same maintenance contract
  their design follows for SettingsPage.tsx).
- **I-6 Line numbers.** The settings workflow rewrites App.tsx (~26 useStates removed, panels
  moved). Every App.tsx line ref here re-anchors by the quoted JSX (the phase gate
  `phase.t !== 'done' &&`, the Open-folder button JSX, `</main>`), which their design keeps
  verbatim.
- **I-7 Hash namespace.** Landing anchors never collide with the router: `viewOfHash` exact-matches
  `'#settings'` only, everything else fail-opens to `'main'` (their route.ts contract). We use
  `history.replaceState` (no `hashchange` event) for scroll-position hashes — their listener never
  fires. A user ON `#settings` cannot see landing nav (hidden wrapper), so no cross-view clicks.
- **I-8 route.test/build-settings tests** are untouched by the landing (no shared modules).

---

## 12. Ordered small-commit breakdown (each green in isolation)

1. `feat(web): landing pure model — anchors, section registry, mount/CTA rule, pricing-line gate`
   — `lib/landing-nav.ts` + `lib/landing-nav.test.ts`. No UI change.
2. `feat(web): landing specimen geometry (pure data + invariant tests)` — `lib/landing-specimen.ts`
   + test (disjoint/in-bounds/kinds ⊆ ZONE_STYLE).
3. `feat(web): landing scroll-reveal mode decision (pure + tests)` — `lib/landing-reveal.ts` + test.
4. `feat(web,i18n): landing.* catalog keys x9` — all 74 keys, 9 catalogs (EN/RU from this spec;
   7 translated at impl); parity tests cover automatically.
5. `feat(web): SpecimenFilm presentational component` — `components/landing/SpecimenFilm.tsx`
   (no strings, no i18n registration needed).
6. `feat(web): landing shell — container, in-flow nav, scroll affordance, CTA helper, hero enrich`
   — `components/landing/Landing.tsx` (nav + focusThenScroll + LandingCta, sections stubbed),
   App.tsx mount inside the phase gate, Dropzone tagline/mobile-note/`ad-open-folder` id,
   i18n-scan registration. Includes `scroll-mt-20` + h2 id/tabIndex conventions.
7. `feat(web): landing S1 how-it-works + specimen` (mounts SpecimenFilm + legend + one CTA).
8. `feat(web): landing S2 disk-vram comparison` (token figure, canonical 16 MB math).
9. `feat(web): landing S3 capabilities grid (8 cards, 3-2-1)`.
10. `feat(web): landing S4 privacy full-bleed film strip` — includes `.ad-bleed` +
    `html{overflow-x:clip}` CSS + the opt-in diagram.
11. `feat(web): landing S5 free/pro panel (PRO_GATE-conditional status line)`.
12. `feat(web): landing S6 FAQ accordions (5 verified Q/A)`.
13. `feat(web): landing footer — contentinfo, motto, GitHub/CLI pointer, locale echo` —
    `components/landing/LandingFooter.tsx` + App.tsx mount after `</main>` (+ visibility check #24).
14. `feat(web): landing scroll-reveal wiring (IO, one-shot, reduce-gated)` — `.ad-reveal-wait` CSS
    + reduce-block append + Landing IO effect.
15. `docs: FEATURES — landing (the tool is the landing); fix film readout cell list (SIZE→FRAG)`
    — includes the §1.3 drift fix + CLAUDE.md phase note if desired.

Commits 7-13 are each one section = one meaning; any can ship independently behind the already-
mounted shell (6). Key prerequisite order: 4 before 6-13; 1-3 before 6.

## 13. Test plan

### 13.1 Pure Node tests (vitest, env=node — the repo's only web-app harness)

- `lib/landing-nav.test.ts`
  1. Frozen anchor contract: `LANDING_ANCHORS` deep-equals the six RULED ids (markup contract).
  2. Locale independence: every anchor matches `/^[a-z][a-z0-9-]*$/` (no i18n, no spaces, stable).
  3. Registry integrity: `LANDING_SECTIONS` covers each anchor exactly once, in page order; every
     `navKey` starts with `landing.nav.`.
  4. `h2IdOf` determinism + uniqueness across anchors; ids never equal a section id (no DOM clash).
  5. `landingView` table: idle→{mounted:true, ctas:true}; analyzing→{true, false};
     error→{true, true}; done→{false, false} (exhaustive over the union).
  6. `pricingLineKey(true)='landing.pricing.gated'`, `(false)='landing.pricing.beta'` — the copy
     can never contradict the gate.
  7. `LANDING_OPEN_FOLDER_ID === 'ad-open-folder'` (frozen contract with Dropzone markup).
- `lib/landing-specimen.test.ts`
  1. Every frame/zone rect lies fully inside `SPECIMEN_VIEWBOX` (x≥0, y≥0, x+w≤W, y+h≤H, w>0, h>0).
  2. Zones pairwise disjoint (no overlapping claims — mirrors real non-double-counting).
  3. Every `zone.kind` ∈ `Object.keys(ZONE_STYLE)` (imported — palette can't drift).
  4. Data is plain/frozen: JSON-round-trip stable (determinism pin).
- `lib/landing-reveal.test.ts` — 4-combo table: only (reduce=false, hasIO=true) ⇒ 'observe';
  reduce wins over hasIO; repeat-call identical.
- i18n: the existing parity + placeholder tests in `packages/i18n` pick up all `landing.*` keys ×9
  automatically; `apps/web/test/i18n-app-keys.test.ts` (after I-5 registration) statically verifies
  every `t('landing.…')` call resolves.

### 13.2 Honestly NOT unit-testable (no React harness) — the manual gate, noted per impl PR

- **Visual rhythm per locale:** all 9 locales × {360px, 768px, 1440px} — surface order
  bg→cards→ONE dark strip→panel→bg→footer; no text clipping (de/ru/hi worst-case); IBM Plex Mono on
  every number.
- **IO reveal:** sections fade in once on scroll (Chromium + Firefox); with reduce emulated —
  everything visible immediately, zero observers (devtools check); mid-session OS toggle doesn't
  blank content.
- **Full-bleed breakout:** privacy strip touches both viewport edges at 320-2560px; NO horizontal
  scrollbar anywhere (the `overflow-x: clip` gate); sticky header still sticks (clip ≠ scroll
  container).
- **Anchor occlusion:** every nav target lands with its h2 fully below the sticky header
  (`scroll-mt-20`) — includes a `#faq` deep-link load.
- **Keyboard/SR:** Tab order per §8; nav Enter → focus lands on the section h2 (NVDA/VoiceOver
  reads the headline); CTA Enter → focus on Open-folder button, second Enter opens the picker;
  rotor shows banner/main/nav/regions/contentinfo; exactly one h1; axe: zero new violations.
- **Analyzing state:** drop a large fixture (`fixtures/sample-projects`) — progress card focal at
  top, sections visible but no green CTA anywhere until done/error.
- **Gate copy:** build with `VITE_PRO_GATE=true` → S5 shows "Requires a license key."; default
  build shows "Free while in beta." (mirrors the FixCard gate branch).
- **Perf:** `pnpm build` — bundle delta within §10's envelope; Lighthouse on GH Pages preview —
  no CLS from the reveal (opacity-only), FCP unchanged.

---

## 14. Rejected (carried from the ruling — do not re-litigate at impl)

Headline options B/C · standalone specimen section · canvas/fixture-rendered specimen ·
disk≠VRAM as M-effort standalone with bespoke art · anchor nav in the sticky header · mobile
header anchors · `npx asset-doctor audit` anywhere (package is `private: true`) · "≤10 s" as a
promise · unqualified "nothing ever leaves your device" outside the analysis-scoped subtitle ·
infinite specimen scan loop · document.title localization · email capture/signup/demo CTAs ·
router/separate site/deploy changes.
