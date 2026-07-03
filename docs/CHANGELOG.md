# Asset Doctor — журнал изменений (по раундам)

Живой лог автономного цикла улучшений. Одна запись на раунд; каждый раунд = цикл
design→skeptic→impl→adversarial-review→fix, независимо проверенный «зелёным» и закоммиченный
мелко в ветке `feat/asset-pipeline` (= локальный `main`). Новые сверху.
**Каждый новый раунд ОБЯЗАН дописать свою запись сюда.** `origin/main` находится на `54c1a3a` (деплой заблокирован: нет
GitHub-кредов — пушит пользователь); хэши коммитов ниже отсчитываются от этой базы.

> Convention: `commit` · что отгружено · вердикт ревью · gate. Дизайны лежат в `docs/improvements/round*.md`.

---

## Лендинг на idle-экране (честный маркетинг) — 2026-07-03
Запрос пользователя: «пришла пора сделать лендинг». Дизайн: `docs/improvements/landing-design.md` (решено: лендинг = обогащённый idle-экран самого приложения, секции ПОД дропзоной; дропзона остаётся героем ⇒ инструмент в одном drag-drop, инвариант instant-wow; НЕ отдельный сайт/роутер/деплой). Impl-workflow (A структура+компоненты+EN/RU → B 7 локалей+responsive+a11y → 2-линзовое ревью [линза №1 — только честность маркетинг-claim’ов] → фикс). **implA умер на session-limit (reset 3:50am) при resume-цикле** — откатил частичное к чистому `7a1f96c`, перезапустил воркфлоу (`w191jrpdh`), прошёл зелёным. Ревью нашло 3 MINOR (0 serious) — **починил 2 реальных сам** (ниже). Ветка `feat/asset-pipeline` теперь **91 над `origin/main`** (web 746).

- **Лендинг** (`5efe5ec`)
  — Секции под `<Dropzone>` на idle-экране (`phase !== done`), ВНУТРИ существующего `<main id=ad-main>` landmark, переиспользуя UX-4 footer/contentinfo — БЕЗ второго h1, без роутера, без новых зависимостей (иллюстративная арт — inline SVG/CSS из @theme-токенов, ноль внешних картинок/шрифтов, НЕ фейковый скриншот). Секции: hero scroll-hint · как-это-работает · грид возможностей · рентген-спесимен · приватность (100% локально по умолчанию; opt-in бэкенд ТОЛЬКО с per-run согласием — round12-нюанс) · цена · FAQ · футер. Каждое утверждение мапится на отгруженную фичу (проверено vs FEATURES/код); ноль выдуманных цифр, ноль фейковых отзывов/скринов, никакого «гарантированно ≤10с». Reveal-on-scroll под `prefers-reduced-motion`; рендерится ТОЛЬКО на idle (результаты + analysis-воркер не тронуты). Логика (`landing-nav`/`landing-reveal`/`landing-specimen`) — чистые Node-тестируемые модули. **Мои фиксы 2 MINOR ревью:** (1) заголовок цены был статичным и под gate=ON противоречил чипу «Requires a license key» ⇒ завёл `pricingTitleKey(PRO_GATE_ENABLED)` (зеркало `pricingLineKey`) + ключ `landing.pricing.titleGated` ×9 ⇒ и заголовок, и чип идут через ОДНУ gate-константу, копирайт не может соврать про бесплатность фикса; (2) scroll-hint и footer-GitHub-ссылка перекрашивали ТЕКСТ в teal на hover (~3.4:1, ниже AA) вопреки правилу дизайна «teal только бордеры/акценты» ⇒ `hover:text-ink` / `hover:decoration-teal` (текст остаётся ink AA, teal — акцент подчёркивания). 3-й MINOR был дублем #1. Вердикт ревью: **SHIP** (0 blocker/major; 2 minor починены, 1 дубль). Gate: typecheck + web 746 + i18n 29 + fix 493 + lint зелёные.

## UX-раунд 4 — состояния/landmarks/понятность (3 pick, все отгружены) — 2026-07-03
6-линзовый брейншторм (4 UX + 2 лендинг) → строгий судья выбрал 3 UX-пика на ОСНОВНОМ пути (отклонил ~13 кандидатов с цитатами: напр. «сырой текст ошибки» — премис code-true, но когорта ложная: битый манифест падает в `unparsed[]`, а не крашит ран). Дизайны в `docs/improvements/ux4-*.md`. Impl-workflow (3 последовательных пика → ревью → фикс) прошёл зелёным; ревью-агенты воркфлоу вернули пусто (2 empty_result), поэтому я прогнал СВЕЖИЙ независимый adversarial-ревью (honesty+a11y) — **чисто, 0 находок**. Каждый пик — чистый Node-тестируемый модуль. Ветка `feat/asset-pipeline` теперь **89 над `origin/main`** (web 724, +47 тестов).

- **Причинно-осознанные пустые состояния + мёртвый контрол + чип неразобранных** (`9ae5704`)
  — Единый cause-blind «no assets match» заменён тремя причинными карточками (`apps/web/src/lib/ledger-empty.ts`, чистый): clean-bill (согласован с зелёным вердиктом, тот же ok-токен) / all-filtered-out (+ one-click сброс severity — раньше чипы жали по одному) / search-miss (+ one-click очистка поиска); шумное «показано 0 из 0» подавлено; фокус после действия возвращается в листбокс/поиск (WCAG 2.4.3). **Побочно исправлен МЁРТВЫЙ контрол «show N clean»** — severity-фильтр отбрасывал синтезированные ok-строки ⇒ кнопка ничего не показывала; `effectiveSeverityFilter` впускает `ok` при showClean. Скрытая когорта неразобранных файлов — **warn-чип «N files skipped»** у вердикта (dashed, НЕ severity, не в тэлли; виден и при assets=0+unparsed=N), открывает+якорно-скроллит к `UnparsedNotice` (`skipped-chip.ts`, чистый). Тесты ledger-empty (клампы/причины) + skipped-chip.

- **Landmark-роли + skip-to-results + фокус на смене view** (`9ae5704`)
  — header/main/nav/aside/footer landmark-роли, skip-ссылка на фокусируемый `<main id=ad-main tabIndex=-1>` (первый tab-стоп, `preventDefault` не мусорит в settings-роутер), и фокус-менеджмент на переключении settings↔results (App владеет единым `focusTargetAfterSwap`; **заодно закрыт отложенный gap фокуса back-nav настроек** — mount-focus-эффект SettingsPage удалён). Ровно ОДИН h1 на view (settings-дерево под `hidden` ⇒ вне AOM); монотонный outline h1→h2(карточка спрайтшита, опц.)→h2(VerdictBar)→h3. Чистый `focus-move.ts` (все переходы, тесты закрепляют якоря).

- **Клавиатурно-доступные пояснения disk≠VRAM (не через `title=`)** (`9ae5704`)
  — Реальный WAI-ARIA disclosure (`<button aria-expanded aria-controls>` + `<dl hidden>`) в FilmViewer вместо недоступного с клавиатуры `title=`; тело — ТРИ существующих провалидированных инвариант-5 ключа verbatim (measured footprint = «не экономия, другая величина»; mip-ceiling = base×4/3, «потолок, не заявленная резидентность»; delta = «два измерения, не экономия») ⇒ НИЧЕГО не выдумано, disk и VRAM НЕ смешаны. Триггер-гейты зеркалят ячейки карточки 1:1. Контраст на тёмной плёнке: `text-ink-soft`→`text-film-soft` (доказано 8.51:1 в `contrast.ts` + тест). `readout-explainers.ts` чистый.

## Спрайтшит в первую очередь + честное сворачивание спама — 2026-07-03
Запрос пользователя: «определять одну картинку в разных форматах, и что набор — НЕ спрайтшит; если это не спрайтшит — не спамить сотни варнингов, а в первую очередь предлагать собрать спрайтшит (настраиваемо)». Design-first (инвариант 3 чувствителен): brainstorm×3 → строгий скептик-судья, «страж объективности» → дизайн-спека (`docs/improvements/spritesheet-first-design.md`). Вердикт **PROCEED_NARROWED**: скептик поймал реальную деталь плумбинга (презентационный слой имеет только `vramBytes`, НЕ mime/размеры), поэтому детекция формат-сиблингов ушла в analysis + маркер `params.redundantSibling` (без изменения core-контракта, `potentialDiskSaved` не тронут). Impl-workflow: A(analysis/core/triage чистая логика) → B(карточка+build+i18n×9) → C(сворачивание) → 2-линзовое ревью (одна линза — только охота на нарушения инварианта 3) → фикс. Ревью: 2 MAJOR (оба починены воркфлоу) + 2 MINOR. Мои действия: MINOR #2 починил (см. ниже), MINOR #4 отложил (унаследованный product-wide контраст CTA — отдельный раунд). Ветка `feat/asset-pipeline` теперь **87 над `origin/main`**.

- **Детекция формат-сиблингов + маркер redundant + порог loose-dominated** (`eb34b20`)
  — `formatSiblingGroups`/`redundantFormatRefs` в `packages/analysis/src/variants.ts`: кластер «одна картинка в разных форматах» = ОДИН dir-aware stem (существующий `stemOf`) + НЕТ resolution-токена + ТОЧНО совпадающие размеры + ≥2 разных mime ⇒ `icon.png`/`icon.avif` читаются как один логический ассет; `icon_blue`/`icon_red` (разные stem) и res-тиры (`hero_540p`/`hero_1080p`) НИКОГДА не кластеризуются (тесты). Guarded post-pass в `analyze.ts` (только если есть format-находки ⇒ CLI байт-в-байт) ставит `params.redundantSibling=1` на per-file format-совет, чей рекомендованный формат УЖЕ есть на диске у сиблинга — НЕ трогая severity/estimate/`potentialDiskSaved` (реверт занижал бы реальную экономию — kill скептика). Новое ОПЦИОНАЛЬНОЕ `ThresholdConfig.shouldAtlas.dominatedFraction` (browser-only, дефолт 0.5): ни одно правило не читает ⇒ CLI/budget байт-в-байт. Тесты: format-siblings (матрица suppress/keep/false-cluster/dims) + analyze-redundant (маркер фейрит, `potentialDiskSaved` неизменна, res-тир без маркера, CLI без маркера). analysis 178 (+17).

- **Первичная рекомендация «Собрать спрайтшит» + честное сворачивание** (`bb3cd30`)
  — Когда папка loose-доминирована (`should-atlas` фейрит И loose-спрайты ≥ `dominatedFraction` от ВСЕХ ассетов — знаменатель включает атласы, поэтому atlas-heavy папка не промоутится), экран результатов ВЕДЁТ заметной карточкой `PrimaryRecommendation` (n verbatim из should-atlas, переиспользованная формулировка, БЕЗ выдуманных «M draw calls → 1» / байт-заголовка): [Собрать] флипает `packLoose` + превью pack-плана, [Настроить] открывает `#settings`. Вторичный per-image шум (ТОЛЬКО `format`+`dimensions-npot`) на этих спрайтах + любой redundant-format-сиблинг сворачиваются в разворачиваемую группу. **Сворачивание — ЧИСТО презентация (инвариант 3):** tally считается `buildIndex` по ВСЕМ находкам ДО любого сворачивания ⇒ счётчики VerdictBar не меняются; crit и folder-находки НИКОГДА не сворачиваются; свёрнутые строки остаются в индексе и раскрываются в ОДИН клик с точным K; «показано N из M» держит M; сворачивание применяется ТОЛЬКО в finding-axis сортировках (**мой фикс MINOR #2**: в asset-axis строка-на-ассет могла бы спрятать не-сворачиваемый warn solid-fill/wasted-alpha ⇒ K=0 на asset-axis). Ничего не удалено, счётчики не изменены, чисел не выдумано. Дефолт (не loose-dominated, без redundant-сиблингов) байт-в-байт. Вердикт ревью: **2 MAJOR починены** (aria-live «показано N из M» брал pre-fold `rows.length`; reset сворачивания срабатывал на probe write-back — оба честно исправлены), 2 MINOR (asset-axis — мой фикс; CTA-контраст — отложен). Gate: typecheck + web 677 + analysis 178 + i18n 28 + fix 493 + lint зелёные.

> **Отложено (осознанно):** MINOR #4 — белый текст на CTA-green #15A06A (12px) и teal-линк #0E8C8C на белом дают ~3.35:1 / ~4.08:1 (ниже AA 4.5:1). Это УНАСЛЕДОВАННАЯ product-wide конвенция (те же классы у всех отгруженных CTA-кнопок и teal-ссылок), НЕ регрессия этого диффа. Чинить надо product-wide (как UX-3 сделал для ink-soft) — отдельный UX-раунд, не card-local дивергенция.

## Единый конфиг оптимизации + отдельная страница настроек + форматы упаковки — 2026-07-03
Два запроса пользователя: (1) «сейчас упаковка идёт только в png, надо добавить конверт в другие форматы + настройку мипмапов»; (2) «сделать всё удобным конфигом по примеру asset-builder + отдельную страницу, где будут все настройки». Workflow: skeptic-design (оба open-question разрешены) → 4 impl-агента (чистые либы → форматы в воркере → UI-страница → i18n×9) → 2-линзовое adversarial-review → мои 4 фикса + независимая проверка. Session-limit срезал impl3 mid-edit ⇒ откатил частичный `App.tsx` к verified-green post-impl2 базе и переиграл impl3+ на чистой основе. Ветка `feat/asset-pipeline` теперь **84 над `origin/main`**.

- **Профиль-осознанный формат страниц атласа для repack/merge/pack + политика Spine** (`3a3ffec`)
  — Перепакованные/смерженные/собранные листы кодировались ЖЁСТКО: статические — lossless-WebP, Spine — PNG; выбранный экспорт-профиль (webp/avif/quality/субсемплинг) до них не доходил вообще (repacked-рефы исключены из tier/format-фан-аута). **Фикс:** новое ЧИСТОЕ решение `sheetPageTarget` в `packages/fix` (Node-тесты: матрица решений ≥12 кейсов + байт-идентичность дефолтов + детерминизм) прогоняется через ОДИН `sheetEnc`-маппер поверх существующих `resolveProfile`/`formatEncode`/`feToEncodeOpts`-замыканий воркера (без дублирования encode-логики), на всех 4 compose-сайтах: SPINE repack, STATIC repack/MERGE, non-merge ext-repoint, PACK. **Разрешение Q1 (скептик):** профиль OFF ⇒ repack/merge держит lossless-WebP БЕЗУСЛОВНО (геометрический lossless-фикс не гоняем через lossy-дефолт под баннером «точный VRAM до→после»), pack держит legacy-таргет ⇒ дефолтный прогон байт-в-байт. Профиль ON ⇒ `formats[0]` (+ честная `skipped[]`-заметка при multi-format, т.к. один сайдкар ссылается на одну страницу). Аддитивное `spinePageFormat?:'png'|'profile'` — `png` (дефолт) опускает поле ⇒ без изменений; `profile` ⇒ `formats[0]` + честная заметка «рантайм должен декодировать этот формат (Pixi умеет)». `padding/maxSize/maxEdge` уже текут из опций. Инварианты: honesty (keep-original-on-size-loss и allowPngFallback не тронуты), disk≠VRAM. Вердикт ревью: **SHIP** (0 blocker/major). Gate: typecheck + fix (493) + web (659) + lint зелёные.

- **Единая модель `BuildSettings` + отдельная страница `#settings` (конфиг v2)** (`b009170`)
  — Все ручки оптимизации (~35 useState) были размазаны по `FixCard`, а `targetMime/quality/padding/maxSize/maxEdge` вообще зашиты в `buildOptions`. **Фикс (browser-only, аддитивно):** (1) ОДИН чистый объект `BuildSettings` + `settingsDefaults()` + вынесенный `buildFixOptions` (`apps/web/src/lib/build-settings.ts`, Node-тесты: B1-пин байт-идентичного option-bag, матрица взаимоисключений профиль↔scaleTiers↔webpNearLossless, таблица опущений-по-дефолту) — `settingsDefaults()` воспроизводит СЕГОДНЯШНЕЕ поведение точно ⇒ дефолтный zip байт-в-байт; (2) hash-роутинг без зависимостей (`route.ts`: `viewOfHash`), основное дерево остаётся смонтированным под `hidden`, страница настроек — отдельная view, ссылка «Настройки» в шапке; (3) `SettingsPage.tsx` — карточки-секции как в asset-builder: **Форматы · Разрешения/масштабы · Упаковка атласов · Мипмапы и швы · Правила · Вывод · Бэкенд · Конфиг**; (4) конфиг v2 (`build-config.ts`): save/load покрывает всю поверхность, v1-файлы мигрируют (`pngRecompress` boolean → level, недостающие секции добиваются), backend-тоглы и per-run consent НИКОГДА не сериализуются. **Честная секция мипмапов:** копирайт прямо говорит — растровые PNG/WebP/AVIF НЕ хранят мип-уровни, GPU генерит их при загрузке (≈+33% VRAM, это меряет находка mipmap-cost), opt-in KTX2-бэкенд печёт настоящие мипы, extrude лечит швы; «здесь пиксели не генерируются». Ноль байт ассетов, ноль сети (инв. 1); движок фикса нетронут кроме форматного маппера. **4 фикса ревью (мои):** parse отдаёт `version` ⇒ загрузка старого конфига ПРЕДУПРЕЖДАЕТ, а не молча сбрасывает v2-секции; back-ссылка говорит «Назад» (не «к результатам») при открытии до анализа; aria-label на инпуте суффикса тира; ключи в 9 каталогах. Фокус-менеджмент на возврате отложен к UX-пику landmarks-skip-focus. Вердикт ревью: **SHIP** (4 minor, все закрыты). Gate: typecheck + web (661) + i18n (27) + fix (493) + lint зелёные.

## UX-раунд 3 — дизайн/удобство (3 pick, все отгружены) — 2026-06-29
4 UX-линзы (состояния/первое-впечатление · a11y landmarks/заголовки · ясность disk≠VRAM · визуальная полировка) → 11 кандидатов → строгий судья выбрал 3 конкретных a11y/instant-wow-улучшения на ОСНОВНОМ пути и отклонил кластер `title=`-тултипов (слабый, недоступен с клавиатуры) + отложил states/landmark-проход. Дизайны в `docs/improvements/ux3-*.md`. Те же жёсткие UX-инварианты.

- **#progress детерминированный прогресс-бар для состояния анализа (reduced-motion-safe indeterminate-fallback)** (`docs/improvements/ux3-progress.md`)
  — Воркер анализа эмитит РЕАЛЬНЫЙ детерминированный прогресс (done/total/label), но он рендерился ТОЛЬКО как текст; ни одного `role=progressbar`/`aria-valuenow`; единственное движение (`.ad-scanline`) — `display:none` под `prefers-reduced-motion`, поэтому reduced-motion-пользователи не получали НИКАКОГО визуального индикатора прогресса. **Фикс:** (1) чистый Node-тестируемый `apps/web/src/lib/progress-view.ts` — `progressView(p?)` → `{determinate, pct(int 0..100), valueNow?, valueMax?}`: undefined / total≤0 / non-finite ⇒ indeterminate (БЕЗ valuenow/valuemax — каноничный busy-сигнал для AT); валидный ⇒ done клампится в [0,total], pct округляется и клампится; 11 тестов (клампы в обе стороны, округление 1/3⇒33, NaN/Infinity-guard, property-loop pct всегда int 0..100); (2) тонкий бар в ветке analyzing: `role=progressbar` + `aria-valuemin=0` + `aria-label` + (determinate ? `aria-valuenow/valuemax` : опущены); determinate-fill — статичная inline-ширина `aria-hidden`; (3) token-driven CSS (teal→cta градиент на film-border треке) — indeterminate-fallback это СТАТИЧНЫЙ пунктирный трек; sweep-анимация ТОЛЬКО внутри `@media (prefers-reduced-motion: no-preference)`, а под `reduce` И width-transition, И sweep убиты (рядом с .ad-scanline). **Инварианты:** честность (ширина = реальные done/total воркера; indeterminate когда total неизвестен — НИКОГДА фейковый crawl/ETA; без disk/VRAM); reduced-motion safe по построению; instant-wow (только рендер, ноль работы на analysis-пути); perf (один div в Dropzone, который размонтируется при done ⇒ не сосуществует с useWindow-виртуализацией); цвет не единственный сигнал (числовой `{done}/{total}` остаётся). Без новых i18n-ключей/токенов; Pro-fix-прогресс и scanline не тронуты. Вердикт ревью: **SHIP** (honestProgress + reducedMotionSafe). Gate: typecheck + web (595) + полный vitest + lint зелёные.

- **#h1 документ-level `<h1>` на экране результатов + монотонная иерархия заголовков** (`docs/improvements/ux3-h1.md`)
  — На основном пути НЕ было документ-level `<h1>`: единственный h1 жил в Dropzone и размонтируется при `phase==='done'`, после чего результаты открывались сразу с `<h2>` (VerdictBar) — нарушение WCAG 1.3.1, у SR-навигации по заголовкам нет верхнего якоря. **Фикс:** (1) чистый Node-тестируемый `apps/web/src/lib/results-heading.ts` — `resultsHeading(tally,t)` = `t('a11y.resultsHeading',{n})`, где `n = crit+warn+info` (ИСКЛЮЧАЕТ ok/clean — та же формула, что у VerdictBar.problemCount и announce.ts, чтобы озвученный outline не расходился) + тесты (n=3 из {crit:2,warn:1,ok:99} доказывает исключение clean; n=0/n=1); (2) ОДИН `<h1 className="ad-sr-only">` первым ребёнком контейнера результатов перед `<VerdictBar/>` — `.ad-sr-only` (`position:absolute`) ⇒ НУЛЕВОЙ визуальный диф (нет box/space-y-gap); VerdictBar/Findings остаются h2, FixCard/optimize — h3 ⇒ монотонно h1→h2→h3; Dropzone-h1 и бренд-`<span>` не тронуты (состояния не сосуществуют); (3) i18n `a11y.resultsHeading` (плюрал) ×9. **Инварианты:** честность (только crit+warn+info, НИКОГДА VRAM/disk), нулевой визуальный диф, O(1) (3 tally-инта, без итерации строк, useWindow не тронут), reduced-motion safe, без новых токенов, h1 неинтерактивен. Вердикт ревью: **SHIP** (monotonicOutline + zeroVisualDiff; ровно 2 взаимоисключающих h1). Gate: typecheck + web (584) + i18n (27) + полный vitest + lint зелёные.

- **#contrast подъём блёклого вторичного текста до контраста WCAG AA** (`docs/improvements/ux3-contrast.md`)
  — Читаемый вторичный текст шёл на `text-ink-soft/70` (2.84:1) и `/80` (3.44:1) над bg `#E7ECF1` / panel `#FFF` — НИЖЕ минимума AA 4.5:1 для обычного текста; полный `text-ink-soft` (#566472) проходит (5.10/6.07). Это самый трафиковый honesty-копирайт (заметки disk≠VRAM, прозрачность загрузки, backend-хинты) — худшее место для нечитаемости. **Фикс:** (1) чистый Node-тестируемый `apps/web/src/lib/contrast.ts` — `relLuminance`/`contrastRatio`/`compositeAlpha` + `AA_NORMAL=4.5` + `inkSoftPassesAA` + `accessibleInkSoftAlpha()=1` (зеркалит хексы токенов из index.css; доказательство, что полный ink-soft проходит, а блёклый — нет) + 9 тестов, пиннящих премис-числа и решение; (2) механический ремап ВСЕХ 36 читаемых `text-ink-soft/{70,80}` → полный `text-ink-soft` в `App.tsx` (только сброс альфа-суффикса — diff ровно 36/36, без изменений layout/spacing/font); единственный `text-ink-soft/50` (disabled consent-label) НЕ тронут (WCAG освобождает disabled). Severity-цвета, статус-строка `ready?text-ok:text-warn`, film-палитра — не тронуты; `components/` не имел блёклых ink-soft. **Инварианты:** без новых @theme-токенов (полный ink-soft уже проходит), без изменения поведения/layout, честность строго улучшена, без касания analysis/perf/виртуализации. Вердикт ревью: **SHIP** (remapComplete + noUnsafeEdit; ревьюер независимо пересчитал WCAG-коэффициенты). Gate: typecheck + web (580) + полный vitest + lint зелёные.

## Сборщик ассетов (asset-builder паритет) — раунды 1-5, ВСЕ отгружены — 2026-06-29
Запрос пользователя: поток как у asset-builder — загрузить папку СЫРЬЯ → сконфигурировать (форматы вывода, степени сжатия, качество, **субсемплинг** и др. per-format настройки; настраиваемые уровни скейла с выбором суффиксов) → получить папку ТОЙ ЖЕ СТРУКТУРЫ с готовыми спрайтшитами/Spine-атласами/Pixi-JSON. **Gap-анализ (read-only) показал: ~85% уже реализовано** внутри Pro-движка фикса — сохранение структуры папок на выводе (вход→`fix.worker`→`zip.ts` зеркалят дерево), полная конфиг-модель `ExportProfile` (форматы/quality/lossless/near/effort/avifSubsample/тиры+суффиксы/per-folder оверрайды) с fail-closed валидацией, и производство (loose→спрайтшит, repack Spine `.atlas`, Pixi `manifest.json`, транскод) НЕ гейтится на находках (движок прогоняет все ассеты). Решение: **расширять существующий ExportProfile-поток, без нового движка**; внешний `@gamzix/assets-builder` (node-нативный sharp/free-tex-packer) — эталон, не портируется (browser-first). План на 5 раундов: R1 ручки конфига в UI · R2 первоклассный вход «оптимизировать папку» · R3 принудительные тиры/упаковка из сырья · R4 политика суффиксов · R5 импорт/экспорт конфига. Дизайн R1: `docs/improvements/ab-r1-config-knobs.md`.

- **R5 импорт/экспорт build-конфига (версионированный JSON, fail-closed через `validateProfile`)** (`docs/improvements/ab-r5-config-io.md`)
  — Пользователь настраивал форматы/quality/субсемплинг/тиры/оверрайды + глобальные encode-ручки, но не мог сохранить/поделиться/перезагрузить конфиг (у внешнего asset-builder — файл конфига). **Фикс (browser-only, аддитивно, БЕЗ движка/воркера/core):** (1) тело `exportProfile`-memo вынесено в ЧИСТУЮ `buildProfileFromState(state)` в новом `apps/web/src/lib/build-config.ts` — memo теперь её вызывает ⇒ сохранение/валидация и живой прогон используют ОДНУ маппинг-логику (без дрейфа; закреплено no-drift тестом: near→60, effort сворачивается только при >0, avifSubsample опускается при undefined); (2) чистое ядро: `serializeBuildConfig` (стабильный порядок ключей, 2-space, детерминирован — pinned-string тест) и `parseBuildConfig` который НИКОГДА не бросает и **fail-closed**: malformed JSON / не-объект / неверный `kind` / будущая `version` / каждый → `{ok:false, reasonKey}` (i18n-ключ); `pickState` отбрасывает лишние ключи, добивает недостающие дефолтами, клампит неверные типы ⇒ переиспользуемый `validateProfile` (из `@asset-doctor/fix`) — единственный семантический гейт (lossless-AVIF/dupTarget/badSuffix/emptyFormats отвергаются; AVIF структурно форсится lossy ⇒ faked-lossless невозможен); применение атомарно (всё-или-ничего); 24 web-теста; (3) Save/Load-кнопки в `ExportProfilePanel` (`downloadText` зеркалит `downloadZip`, скрытый file-input), ошибки/успех — через polite live-регион (без alert/краша); (4) i18n `fix.config.*` ×9. **Честность:** сериализуется ГРАНУЛЯРНОЕ UI-состояние (не lossy производный профиль) ⇒ перезагрузка восстанавливает ровно те контролы, что видит пользователь, и валидируется ТЕМ ЖЕ `validateProfile`, что и живой прогон («ровно то, что применится»). **НЕ сохраняются** backend-тоглы (ktx2/pngquant/resample) и `backendConsent` (согласие — только per-run), без localStorage; конфиг несёт НОЛЬ байт ассетов (инвариант 1). Циклический импорт решён выносом UI-типов в `apps/web/src/lib/profile-ui-types.ts`. Движок/воркер/core НЕ тронуты; дефолт байт-в-байт. Вердикт ревью: **SHIP** (failClosed + noConsentPersist). Gate: typecheck + web (571) + i18n (27) + полный vitest + lint зелёные.

- **R2 первоклассный аффорданс «Оптимизировать эту папку» на экране результатов (обнаруживаемость, без нового движка)** (`docs/improvements/ab-r2-optimize-affordance.md`)
  — Способность оптимизировать/собрать ВСЮ папку (структуро-сохраняющий ExportProfile-fan-out) уже работала, но была НЕобнаруживаема: жила только внутри `FixCard` ниже диагноза, во фрейминге «починить проблемы»; дропзона никогда не называла optimize/build/convert. **Фикс (чистый apps/web + i18n, БЕЗ движка/воркера/core):** (1) чистый Node-тестируемый `apps/web/src/lib/optimize-entry.ts` — `OPTIMIZE_ENTRY` (ключи `optimize.title/sub/anchor`), `optimizeEntryEnabled(fileCount,...)`=`fileCount>0`, общий `PROFILE_PANEL_ANCHOR` + 14 тестов (контракт гейта/ключей/якоря, наличие в 9 локалях, brace-free); (2) i18n `optimize.*` ×9 — ЧЕСТНЫЙ копирайт («Convert formats, emit scale variants, and repack — output keeps your folder structure»); (3) `ExportProfilePanel` сделана УПРАВЛЯЕМОЙ (опц. `open?/onToggleOpen?` + `id`); при `open===undefined` остаётся неуправляемой свёрнутой (рендер байт-в-байт); `onToggle` синхронит lifted-состояние и не зацикливается; (4) `FixCard` — титульный заголовок (optimize.title/sub) вместо голой `pro.note` (та сохранена как Phase-2 подпись); `profilePanelOpen` поднят в App и НЕ в deps стейл-плана (тоггл не инвалидирует показанный план); (5) в aside — гейтнутая кнопка «Optimize whole folder →» открывает панель + scrollIntoView (reduced-motion honored; на залоченном Pro-гейте скролл безвреден — без ложных обещаний). **Инварианты:** движок/воркер/core НЕ тронуты (диф пуст); дефолт байт-в-байт (intent-флаг лишь двигает `<details open>` + скролл); instant-wow цел (никакого конфига до ≤10s-диагноза; аффорданс только пост-диагноз); честность — копирайт ровно про то, что делает ТОТ ЖЕ Pro-движок, без новых заявок на VRAM/экономию; token-driven, без новых токенов. Вердикт ревью: **SHIP** (noEngineChange + noOverClaim). Gate: typecheck + web (547) + i18n (26) + полный vitest + lint зелёные.

- **R4 пользовательские суффиксы уровней скейла (безопасный charset; кластеризация вариантов НЕ тронута, честно задокументировано)** (`docs/improvements/ab-r4-suffix-policy.md`)
  — Прямой запрос пользователя «настраиваемые уровни скейла с выбором суффиксов»: раньше `validateTiers` (`packages/fix/src/scale.ts`, `RESOLUTION_TOKEN`) принимал только resolution-токены (`_540p`/`@2x`/`_hd`) и отвергал `_mobile`/`_lq`/`_hidpi`; UI блокировал прогон. **Взвешенное решение (отличается от исходного дизайна):** дизайн предлагал ЗАОДНО расширить кластеризацию вариантов в `packages/analysis`, чтобы кастомные суффиксы кластеризовались на ре-ингесте — но это сделало бы диагноз НЕЧЕСТНЫМ (ложно кластеризовал бы реально РАЗНЫЕ файлы вроде `icon_blue`/`icon_red`). Поэтому сделан **только build-side relax, кластеризация НЕ тронута**: (1) `isSafeSuffix` + `SUFFIX_TOKEN` в `scale.ts` — СТРОГИЙ СУПЕРСЕТ `RESOLUTION_TOKEN` (ноль регрессий) ИЛИ безопасный free-form `[_-][A-Za-z0-9][A-Za-z0-9_-]{0,23}`, ОТВЕРГающий имена форматов (png/webp/avif/jpg/jpeg, case-insens), точки, слэши, `@`, без-сепаратора, пустое/overlong тело; остальные гарды (пустой/дубль-case-insens/нет-top-tier/upscale/сортировка) без изменений; (2) **честная документация** (комментарий в коде + `docs/improvements/ab-r4-suffix-policy.md`): кастомные НЕ-resolution суффиксы НЕ распознаются как tier-варианты на ре-ингесте оптимизированной папки ⇒ показываются как отдельные ассеты (КОНСЕРВАТИВНЫЙ over-count advisory-варианта `warn`, НИКОГДА не выдуманный кластер и не влияет на жёсткий VRAM-гейт); resolution-суффиксы кластеризуются как и раньше; (3) UI использует `isSafeSuffix`; (4) i18n переформулирован `fix.tier.badSuffix`/`fix.profile.tierBadSuffix` ×9 (без новых ключей). Честный нюанс `@2x`: голый `@2x` без ведущего сепаратора НИКОГДА не был валиден ⇒ остаётся отвергнутым (используются `_2x`/`-2x`), без поддельного приёма. **`packages/analysis`, `core`, воркер — НЕ тронуты** (диф пуст; 161 analysis-тест зелёные unchanged ⇒ нет регрессии кластеризации); дефолт байт-в-байт (каждый ранее-валидный суффикс валиден). Вердикт ревью: **SHIP** (analysisUntouched + noRegression). Gate: typecheck + fix (480) + analysis (161) + web (533) + i18n (26) + полный vitest + lint зелёные.

- **R3 принудительный выбранный формат на предсобранных атласах при single-format профиле (закрыт последний findings-gated остаток)** (`docs/improvements/ab-r3-force-atlas-format.md`)
  — Скелетная проверка показала: loose-изображения и multi-tier атласы уже принудительно конвертируются по профилю, но ПРЕДСОБРАННЫЙ АТЛАС при SINGLE-format format-only профиле (один scale-1 тир ⇒ `tieringOn=false`) транскодился в выбранный формат ТОЛЬКО если заработал format-находку — поэтому «AVIF, один тир» молча давал папку СМЕШАННЫХ форматов (уже-AVIF / почти-оптимальные / суб-пороговые листы проходили как есть). **Фикс (только воркер + чистый предикат, БЕЗ core/UI):** (1) чистый Node-тестируемый `packages/fix/src/atlasProfileForce.ts` — `atlasNeedsForcedFormat(...)` → `{force, skipReason?}`, тотальный/детерминированный, force=false (с причиной) при multi-format / multi-page-Spine / нет-сайдкара / уже-claimed / source===target; + исчерпывающий тест на каждый гейт; (2) тело passthrough-транскода вынесено в общий хелпер `forceAtlasFormat` (ОДНА реализация для op-обработчика и драйвера — без дрейфа); (3) драйвер сразу после loose-pass, гейт ИДЕНТИЧНЫЙ `if (profileOn && !profileHasLowerTier && !profileMulti)`: для каждого merged-атласа пропуск при replaced/dropped/profileOwned, target = `resolveProfile(ref).formats[0]`, force ⇒ хелпер (rename страницы, repoint сайдкара, drop старой ДО pass-through-петли, +profileAssets/+profileOwned); (4) предсказание owner-имени расширено на принудительно-транскодированный owner. **Ревью поймало BLOCKER** (значимость свежего adversarial-прохода): три bail-ветки хелпера (`!bytes` / encode-fail / size-loss) возвращали `forced:false` БЕЗ сброса owner-bookkeeping ⇒ для dedup-OWNER атласа на ЧАСТОМ size-loss Phase C не видел расхождения и репойнтил consumer на неэмитированную переименованную страницу (dangling 404). **Исправлено:** хелпер `keepOriginalOwner(ref, path)` сбрасывает `ownerActualName.image` + `ownerActualUnhashed` на оригинал во всех трёх bail-ветках (зеркалит loose-путь) ⇒ Phase C видит расхождение и СОХРАНЯЕТ consumer. **Инварианты:** дефолт БАЙТ-В-БАЙТ (драйвер целиком внутри `profileOn && !profileHasLowerTier && !profileMulti`); честность — реальный ре-энкод, keep-original-on-size-loss (никогда не отгружаем файл крупнее под баннером фикса), каждый отказ в `skipped[]`; одинаковые пиксельные размеры ⇒ БЕЗ vramSaved (инвариант 5). Без `packages/core`/`App.tsx`-изменений; browser-only. Вердикт ревью: **SHIP после фикса 1 блокера** (byteIdenticalDefault + noDangling; свежий adversarial-агент вместо упавшего на лимите). Gate: typecheck + fix (470) + web (533) + полный vitest + lint зелёные.

- **R1 проброс глобальных ручек профиля + пикер AVIF-субсемплинга (effort / scaleAwareQuality / pngRecompressLevel / avifSubsample)** (`docs/improvements/ab-r1-config-knobs.md`)
  — Пять глобальных encode-ручек уже были в контракте `ExportProfile` (`core/index.ts`) и уже читались воркером (`fix.worker.ts:532-536`, `settings.ts formatEncode`, `encodeCanvas` AVIF-ветка), но `exportProfile`-memo в `App.tsx` их НЕ заполнял — субсемплинг достигался только через пресет-оверрайд `fonts444`, а `validateProfile` валидировал ручки оверрайдов, но НЕ глобальные (fail-closed дыра). **Фикс (чисто проводка, БЕЗ движка/воркера/core):** (C1) `validateGlobals` в `scale.ts` — fail-closed для глобальных `effort [0,6]` / `pngRecompressLevel [0,6]` / `avifSubsample` (целое ∈ {0,1,2,3}) / `avifQualityAlpha` (-1 или [0,100]) + тесты на приём валидных и ОТКАЗ 3.5/4/effort 7/png -1/alpha 101; (C2) тесты fan-out, доказывающие что глобальный effort доходит до всех 3 таргетов, а avifSubsample — только до AVIF-записей (и опускается по умолчанию); (C3) memo сворачивает `effort/scaleAwareQuality/pngRecompressLevel` из СУЩЕСТВУЮЩЕГО состояния SettingsPanel (omit-when-default ⇒ байт-в-байт; ранее ложный комментарий стал правдой — единый источник истины); (C4) новое локальное состояние `profileAvifSubsample` + AVIF-гейтнутый `<select>` (Default(omit)/4:4:4=3/4:2:2=1/4:2:0=0; 4:4:0=2 отложен per protocol); (C5) i18n `fix.profile.avifSubsample` + 4 опции ×9. **Инварианты:** все ручки 100% в браузере (@jsquash/OffscreenCanvas — инвариант 1, ничего не покидает устройство), DISK-only (инвариант 5, без заявки на VRAM; diskNote покрывает); дефолт байт-в-байт (все ручки omit-when-default); fail-closed закрыт. **Без изменений `packages/core` и `apps/web/src/worker`** (диф пуст — проводка к уже существующему). Вердикт ревью: **SHIP** (byteIdenticalDefault + failClosed). Gate: typecheck + fix (450) + web (533) + i18n (26) + полный vitest + lint зелёные.

## UX-раунд 2 — дизайн/удобство (2 pick, все отгружены) — 2026-06-29
4 UX-линзы → 15 кандидатов → строгий судья выбрал 2 сильных неперекрывающихся пика (дедуплицировав 4 варианта клавиатурной навигации в один — на `aria-activedescendant`, чтобы фокус никогда не оставался на размонтированной виртуализированной строке; маргинальные ARIA-группировки свёрнуты в него). Дизайны в `docs/improvements/ux2-*.md`. Те же жёсткие UX-инварианты (честность disk≠VRAM, instant-wow, a11y, perf при 1000+, верность токенам); UX-логика — в чистых Node-тестируемых модулях.

- **#2 sub-md полоса тоталов: disk vs VRAM (declared/measured) + saveable на узких экранах, где они скрыты на 100%** (`docs/improvements/ux2-submd-totals.md`)
  — Четыре заголовочных тотала (disk / declared vram / measured vram / saveable) рендерятся ТОЛЬКО в шапке с классом `hidden ... md:flex`, поэтому при ширине <768px завершённый анализ показывал НОЛЬ заголовочных метрик — пин честности disk≠VRAM (инвариант 5) и payoff «saveable» (instant-wow) были на телефонах невидимы именно там, где места меньше всего. **Фикс:** (1) НОВЫЙ чистый Node-тестируемый билдер `apps/web/src/lib/totals-rows.ts` — `buildTotalsRows(totals,t,fmtBytes)` фиксированного порядка `[disk, declared, measured?(только при totals.probe), saveable(accent)]`; строка declared использует самодостаточный ключ `readout.declared` («vram (declared)»), а НЕ голый `metric.vram`, чтобы declared/measured оставались текстуально различимы даже когда measured-чип отсутствует (правка честности); measured берётся прямо из `totals.probe.vramBytes` (никогда не дельта) с тултипом `readout.measuredTooltip`; saveable — `accent` + disk-only `%`/байты, как в шапке; `[]` при отсутствии totals; (2) компактная wrap-полоса `flex flex-wrap ... md:hidden` под `<VerdictBar>` — ТОЧНО обратный брейкпоинт к `md:flex`-шапке, поэтому они НИКОГДА не сосуществуют (без дублирования); десктоп-шапка НЕ ТРОНУТА (диф чисто аддитивный). **Честность:** declared (`loadedVramBytes`) и measured (`probe.vramBytes`) — разные величины с разными метками; flex-col ячейки приклеивают метку к значению, перенос их не смешивает. **Токены/perf:** только существующие `text-ink/ink-soft/cta/border-line` (без новых); 3-4 статичные ячейки независимо от числа ассетов; `useWindow`/TriageLedger не тронуты; без анимации (reduced-motion safe). i18n без новых строк (`readout.declared` подтверждён в 9 локалях + добавлен guard в `catalogs.test`). Вердикт ревью: **SHIP** (honesty + mutualExclusion). Gate: typecheck + web (533) + i18n (26) + полный vitest + lint зелёные.

- **#1 полная клавиатурная навигация по виртуализированному TriageLedger (listbox + `aria-activedescendant` + scroll-into-window)** (`docs/improvements/ux2-keynav.md`)
  — Ledger виртуализирует строки (в DOM только ~25-35 из `useWindow`), и клавиатурных примитивов НЕ было вовсе — клавиатурный/SR-пользователь мог достать только смонтированные строки, остальные ~965 из отчёта на 1000 были недостижимы (провал WCAG 2.1.1). Кольцо фокуса из UX-1 сделало перемещение фокуса видимым — пункт разблокирован. **Фикс:** (1) НОВЫЙ чистый Node-тестируемый `apps/web/src/lib/ledger-nav.ts` — `nextActiveIndex` (полная карта клавиш Arrow/Home/End/PageUp/PageDown, клемп `[0,total)`, без wrap, края current=-1/total=0/1) и `scrollToActive` (возвращает `scrollTop`, монтирующий цель; при уже-видимой цели — текущий `scrollTop` без рывка; клемп `[0,maxScroll]`; degrade-safe) + 15 тестов, ВКЛЮЧАЯ consistency-тест (выход `scrollToActive` → `windowSlice` ⇒ цель ∈ `[start,end)`, гарантия что активная строка примонтируется); (2) контейнер стал `role=listbox` + `aria-label` + `tabIndex=0` + `aria-activedescendant` + единый `onKeyDown`; строки — `role=option` + `aria-selected` (РОВНО на одной активной опции, не на всех строках того же assetRef) + стабильный `id` + `tabIndex=-1` (контейнер — единственная tab-остановка); заголовки групп — `role=presentation`, пропускаются индекс-математикой через карту option↔item (учёт высоты заголовка, без дрейфа). **Модель фокуса:** `aria-activedescendant` (НЕ roving-tabindex) ⇒ DOM-фокус никогда не уходит с контейнера и не теряется при размонтировании строки. **Инварианты:** `useWindow.ts` и `triage.ts` НЕ ТРОНУТЫ (навигация двигает тот же единственный `scrollTop`; лишних строк не монтируется); выделение переиспользует существующий путь `onRowClick`, активная опция выводится из `selectedAsset` (worst-offender авто-селект, orphan-reselect и probe-реасайн её не сбивают); `scrollTop` ставится МГНОВЕННО (reduced-motion safe); без новых @theme-токенов (активная строка едет на существующем `bg-teal/10`); честность — ни одного выдуманного числа. i18n: 1 ключ `triage.listLabel` ×9. Вердикт ревью: **SHIP** (virtualizationIntact + noDetachedFocus; единственный «major» ревьюера оказался про устаревший текст сводки имплементера — фактический код уже делает строго одно-активный `aria-selected`, проверено мной). Gate: typecheck + web (522) + i18n (25) + полный vitest + lint зелёные.

## UX-раунд 1 — дизайн/удобство (3 pick, все отгружены) — 2026-06-29
Новая тема цикла по запросу пользователя: **не расширение функционала, а дизайн и удобство использования (UX/доступность)** — та же машинерия (brainstorm в 4 UX-линзы → строгий судья → скептик-дизайн → impl→ревью→fix). 4 линзы (иерархия/состояния · взаимодействие при масштабе · визуальная полировка/бренд · доступность и ясность) → 16 кандидатов → судья выбрал 3 ответственных, высокоуверенных, неперекрывающихся улучшения и отложил единственный среднерисковый пункт (клавиатурная arrow-навигация по строкам ledger — лучше после того, как приземлится focus-ring). Дизайны в `docs/improvements/ux1-*.md`. Жёсткие UX-инварианты: честность (disk≠VRAM, без фейков), instant-wow ≤10s, a11y (ARIA/клавиатура/reduced-motion/контраст/focus-visible/цвет-не-единственный-сигнал), perf при 1000+ ассетов, верность токенам бренда (`apps/web/src/index.css`). Поскольку в apps/web НЕТ React-харнесса, UX-логика выносится в ЧИСТЫЕ Node-тестируемые функции; чисто-визуальные правки — token-driven и аддитивные.

- **#2 объявления через `aria-live` для прогресса анализа, готовности результата, счётчика и ошибок (сделать instant-wow ≤10s воспринимаемым для скринридеров)** (`docs/improvements/ux1-arialive.md`)
  — Момент instant-wow и каждый переход состояния анализа были немыми для ассистивных технологий: у текста «анализирую… N/M» не было `role`/`aria-live`/`aria-busy`, своп analyzing→done не объявлялся, у текста ошибки не было `role=alert`, смена счётчика «показано N из M» не озвучивалась (grep подтвердил ноль `aria-live`/`role=status`/`role=alert`/`aria-busy`/`sr-only` в apps/web/src). **Фикс:** (1) чистые Node-тестируемые форматтеры `apps/web/src/lib/announce.ts` (с инъекцией `t`): `analysisReadyMessage(tally,t)` где число проблем = `crit+warn+info` (та же формула, что у VerdictBar; `ok`/clean ИСКЛЮЧЕНЫ — честность; VRAM не озвучивается), `resultCountMessage(shown,total,t)` переиспользует существующий ключ `triage.showing`; (2) каноничный token-free класс `.ad-sr-only` в `index.css`; (3) ARIA-атрибуты: `role=status aria-live=polite aria-atomic` на тексте прогресса, `aria-busy={analyzing}` на дропзоне, `role=alert` на ошибке; (4) ОДИН постоянный визуально-скрытый live-регион, смонтированный один раз в начале `<main>` (переживает своп dropzone↔результаты); (5) сообщение «готово» эмитится ИМПЕРАТИВНО сразу после `setPhase(done)` в успешной ветке `run()` — РОВНО один раз на анализ, ДО асинхронной дозаписи render-probe, поэтому probe-реасайн (новый объект report) не вызывает повторного объявления (нет report-keyed эффекта для ready); счётчик — `useEffect` на `[rows.length,totalRows]` (уже задебаунсен), с `ref`-гейтом, пропускающим первый settle на свежем report (не дублирует ready). Идентичная строка переобъявляется детерминированным NBSP-тогглом (вне чистых форматтеров). **Честность:** озвучиваются ТОЛЬКО числа уже на экране (проблемы = crit+warn+info как у VerdictBar; shown/total = реальные значения ledger); VRAM никогда; clean не подмешивается; текст ошибки — существующий `phase.message`. Без перехвата фокуса и без новых фокусируемых элементов. i18n: `a11y.diagnosisReady` (плюрал one/other, `{n}`) ×9 локалей; динамический ключ из `announce.ts` защищён (добавлен в скан `i18n-app-keys.test.ts` + явный `it()`), `catalogs.test` расширен. Вердикт ревью: **SHIP** (0 блокеров/мейджоров, honesty + no-probe-double-fire). Gate: typecheck + web (507) + i18n (25) + полный vitest + lint зелёные.

- **#1 легенда оверлеев на карточке FilmViewer + доступное имя canvas (расшифровать рентген; снять «цвет — единственный сигнал» с бренд-героя)** (`docs/improvements/ux1-legend.md`)
  — Бренд-герой — рентген-снимок атласа — кодировал весь смысл проблем ТОЛЬКО цветом (`ZONE_STYLE`: пустота=красный, прозрачные поля=жёлтый, bleeding+дубль-кадр=бирюзовый), а соответствие цвет→смысл жило лишь в комментарии кода; сам `<canvas>` был безымянным для скринридеров — нарушение a11y-инварианта. **Фикс:** (1) `ZONE_STYLE` вынесён в `apps/web/src/lib/film-legend-style.ts` (одно определение, импортируется и в paint-loop FilmViewer, и в новый `film-legend.ts` — без import-цикла); (2) чистые Node-тестируемые хелперы `legendItemsFor`/`regionCount`/`filmAltText` (легенда показывает ТОЛЬКО реально присутствующие в `findings[].overlay` виды в фиксированном порядке; цвет swatch читается из `ZONE_STYLE` ⇒ не может разойтись с отрисовкой; `filmAltText` — только измеренные факты: имя+размеры+число подсвеченных областей, без disk/VRAM/экономии); (3) у canvas теперь `role="img"` + измеренный `aria-label`, у декоративной scanline `aria-hidden`, и компактная wrap-легенда (`role=list` с useId-заголовком; каждый пункт = `aria-hidden` swatch + локализованная ТЕКСТОВАЯ метка) — рендерится ТОЛЬКО когда есть оверлей-зоны (before/after-diff с `findings=[]` не даёт пустой полоски). **Честность:** `bleeding` и `duplicate-frame` несут РАЗНЫЕ метки, хотя swatch у обоих бирюзовый (честнее прежнего комментария, лумпившего их); ни одной выдуманной категории. **a11y:** цвет больше не единственный сигнал (рядом всегда текст); SR читает слова, не «цветной квадрат». **perf:** легенда в единственном sticky-aside (раз на выбранную плёнку, не на строку) — виртуализация не тронута. i18n: 7 ключей ×9 локалей (плюрал на `{regions}`), динамические ключи меток покрыты явным drift-guard `it()`-блоком (статический скан их не ловит). Без новых @theme-токенов/цветов; `ZONE_STYLE` без изменений (имплементер корректно поймал ошибку дизайн-спеки о «байт-идентичных» бирюзовых заливках и поправил только тест). Вердикт ревью: **SHIP** (0 блокеров/мейджоров, honesty + no-color-sole-signal). Gate: typecheck + web (499) + i18n (25) + полный vitest + lint зелёные.

- **#3 единое token-driven кольцо фокуса `:focus-visible` по всему интерактивному хрому** (`docs/improvements/ux1-focusring.md`)
  — В apps/web НЕ было согласованного индикатора фокуса с клавиатуры: у строк ledger и verdict-чипов фокус-стиля не было вовсе, а ряд контролов использовал `focus:outline-none` (подавляя UA-кольцо) лишь со слабым 1px `focus:border-teal`; у главной CTA «открыть папку» фокус-стиля не было — это провал WCAG 2.4.7/1.4.11 и невидимая клавиатурная навигация. **Фикс:** ОДНО аддитивное глобальное правило в `index.css` — `:focus-visible { outline: 2px solid var(--color-teal); outline-offset: 2px; border-radius: inherit; }` + вариант `--color-film-soft` для тёмной плёночной карточки (`.ad-grid`/`.bg-film`), на СУЩЕСТВУЮЩИХ токенах (новых не вводим); `:focus-visible` (не `:focus`), чтобы клик мышью оставался без кольца. Убраны избыточные `focus:outline-none`/`outline-none` с 8 контролов (App.tsx ×7 + LicensePanel ×1), `focus:border-teal` сохранён как дублирующий сигнал. Контраст проверен (teal ≥3:1 на panel/bg/film; film-soft ~9:1). **Honesty/perf:** нулевое касание data-path; `outline` не занимает место в боксе ⇒ нет сдвига layout при любой длине локали; виртуализация не тронута; reduced-motion безопасно (у `outline` нет анимации). Выбор «поверхность→токен» вынесен в чистый Node-тестируемый `lib/focus-ring.ts` (спека, зеркалящая CSS). Девиация (честно): дизайн ссылался на 2 правки в `TriageLedger.tsx`, но тот был отрефакторен и `outline-none` там уже не было — намерение (снять все подавители UA-кольца) выполнено 8 правками, глобальное правило покрывает остальное. Вердикт ревью: **SHIP** (0 блокеров/мейджоров, аддитивно + token-faithful). Gate: typecheck + web (486) + полный vitest + lint зелёные.

## Раунд 29 — отбор (1 pick; отгружено) — 2026-06-29
Отбор (очень высокая планка, пространство почти исчерпано): brainstorm в 4 линзы → 4 кандидата → строгий судья выбрал ровно
**1** и отклонил 3 (budget-config silent-no-op — авто-сброс из `resolveThresholds` это намеренная задокументированная
архитектура, истинной но узкой косметикой валидации остаётся только accept-then-discard нескольких ключей;
trim-bounds детектор `spriteSourceSize`-vs-`sourceSize` — подтверждённый пробел, но самопомеченный как маргинальный / срабатывает только на
повреждённых/руками-правленных манифестах, широкая новая поверхность; масштаб оверлея FilmViewer на атласах declared≠real — только визуальный,
неоднозначное лечение, корректные числа в заголовке). Один pick, без наполнителя —
честное решение. Дизайн в `docs/improvements/round29-animations-preserve.md`.

- **(parity/honesty) сохранять карту `animations` спрайтшита дословно при byte-stable повторной эмиссии — близнец
  r28-фикса `related_multi_packs`** (`docs/improvements/round29-animations-preserve.md`)
  — Спрайтшит Pixi v8 / TexturePacker несёт верхнеуровневую карту `animations` (имя-группы → упорядоченный список имён FRAME
  = порядок воспроизведения), из которой строятся `Spritesheet.animations` / каждый `AnimatedSprite`. Наш парсер её никогда не читал,
  у ядрового `Atlas` не было поля, а `emitTexturePackerJson` повторно эмитил только `{frames, meta}` — так что каждая Pro
  повторная эмиссия (passthrough-транскод, resize, KTX2-sidecar, dedup-repoint) молча её роняла, ломая каждую
  анимацию в рантайме, при том что комментарий в коде ложно заявлял дословную точность (18 реальных шитов в собственных
  данных пользователя её несут). **Фикс:** нести опциональный `animations?: Record<string, string[]>` на ядровом `Atlas`
  (omit-when-absent ⇒ **байт-в-байт**); защищённый `readAnimations` (каждая группа должна быть непустым массивом
  непустых строк; невалидная группа отбрасывается, валидные соседи выживают; порядок сохраняется) читает
  **верхнеуровневый** `j.animations`; `emitTexturePackerJson` повторно эмитит её **дословно, БЕЗ sort** (порядок ключей + порядок
  массива внутри группы это порядок воспроизведения) между `frames` и `meta`, только когда присутствует+непуста. Она протекает через
  существующие spread-ы `{...atlas}` на каждом frame-name-stable пути **без strip-кода в воркере** — и, в отличие от
  `related_multi_packs`, она корректно **переносится (не stripped) при `hashFilenames`/cache-bust и в KTX2-
  sidecar**, потому что ссылается на КЛЮЧИ фреймов (стабильны при переименовании ФАЙЛОВ), а не на имена соседних файлов.
  Repack/merge/pack строят свежие атласы ⇒ `animations` отсутствует **по построению** (без синтеза — инвариант 3). Ложные
  «дословные» комментарии исправлены (+ заметка с обоснованием frame-key-vs-file-name для KTX2). **Без изменения Spine `.atlas`**
  (нет концепции анимаций; frameless Spine-skeleton JSON никогда не доходит до чтения), без изменений finding/i18n/UI/бэкенда.
  — **Тесты**: parsers (single + порядок ключей multi-group + порядок массива внутри группы ≥20 элементов сохранён;
  absent/non-object/empty/null/all-malformed ⇒ undefined; malformed-group-filtered; Spine-skeleton frameless ⇒
  not-ok так что чтение никогда не достигается), fix (emit между frames/meta + reparse целым; absent ⇒ нет ключа;
  `repointAtlasImage`/`scaleAtlas` его сохраняют; свежий результат `repackAtlases` имеет `animations` undefined; чистый
  parse→emit→reparse deep-equal). parsers 54→63, fix 434→441. Вердикт ревью: **SHIP** (ноль блокеров/мажоров,
  байт-в-байт + дословно-без-sort). Gate: typecheck + parsers (63) + fix (441) + полный vitest (web 479) + lint
  зелёные.

## Раунд 28 — отбор (2 pick-а отложенных пунктов; все отгружены) — 2026-06-29
Раунд 28 целился в два сильнейших ОТЛОЖЕННЫХ пункта бэклога, которые судья раунда 27 пометил как заслуживающие собственных
ограниченных раундов (оба с подтверждённой посылкой, отклонены из r27 только по объёму): skeptic-architect перепроверил каждый
против реального кода и вернул **PROCEED** по обоим. Дизайны в `docs/improvements/round28-*.md`.

- **(gamedev/honesty) детектор рассогласования declared-vs-real размеров атласа — всегда-включённый статический сиблинг
  лейбла render-probe** (`docs/improvements/round28-dimension-mismatch.md`)
  — Для атласа `atlas.size` это ЗАЯВЛЕННЫЙ размер манифеста (`meta.size` / Spine page `size:`), тогда как
  `image.size` это РЕАЛЬНЫЙ декодированный заголовок в пикселях — однако `analyze.ts` начисляет VRAM + запускает `dimensionFindings` на
  ЗАЯВЛЕННОМ значении и **никогда не сравнивает их** для атласов, так что устаревший/уменьшенный/POT-округлённый манифест (фреймы
  семплят с меньшей реальной текстуры, UV-ы сдвинуты) был невидим в бесплатном аудите (всплывал только из
  опционального лейбла WebGL render-probe). Хуже того, парсерный проход out-of-bounds по фреймам тестирует ЗАЯВЛЕННЫЙ размер,
  так что фрейм может его пройти, но семплить за пределами меньшей реальной текстуры. **Новое чистое правило**
  `dimensionMismatchFinding(atlas, image, cfg)` (ноль декода, integer-сравнение двух чисел, которые парсер уже
  держит) с откалиброванной **абсолютной толерантностью** (`tolerancePx: 2` — безобидный нечётный trim/округление остаётся ТИХИМ;
  здоровые trimmed/POT атласы имеют declared==real и никогда не срабатывают) и **обработкой направления**: real<declared с
  размещённым фреймом за реальными границами ⇒ `crit` (фреймы семплят за реальным краем — баг, который пропускает OOB-проход);
  real<declared всё в границах ⇒ `warn`; real>declared (лишняя рамка) ⇒ `info`. **Честно по инварианту 5:** не несёт
  **НИКАКОЙ оценки вообще** — он сообщает ДВА ИЗМЕРЕНИЯ (declared W×H vs real W×H), никогда delta-saving, и
  фактически раскрывает, что статическая VRAM-оценка начислена на declared-размер, так что она пере-/недо-заявляет
  реальный футпринт (раскрытие существующего учёта, никогда не заявка о fix-saving); без оверлея. Срабатывает
  в браузере + на CLI `audit`/`init` через `DEFAULT_THRESHOLDS`; подавляется, когда budget-config опускает ключ
  (нет в `resolveThresholds`, та же поза, что у bleeding). **Замкнуто — только DETECT:** без изменения VRAM-базиса, без
  изменения парсерного OOB, без fix-движка, без изменений воркера/бэкенда.
  — **i18n**: три плоских per-direction messageKey-а под одним Rule `dimension-mismatch` (проверенная
  маршрутизация `format`/`format-lossless` — без изменения рендерера), во всех 9 локалях с одинаковыми `{dw}{dh}{rw}{rh}`
  (+`{off}`) плейсхолдерами; render-drift + catalogs parity зелёные. **Golden**: вручную написанный
  `fixtures/sample-projects/dimension-mismatch/` (declared 1024² + real 512² PNG + один off-edge фрейм),
  expected.json честно сверён через реальный путь parse→analyze; **3 существующих ATLAS_CASES golden-а
  остаются зелёными БЕЗ правок expected.json** (проверено, что ноль существующих фикстур расходится). CLI-тест утверждает, что оно срабатывает
  через `auditDir` и подавляется budget-config-ом. Вердикт ревью: **SHIP** (ноль блокеров/мажоров; honestyOk
  + noFalsePositive). Gate: typecheck + analysis (161) + i18n (25) + budget (31) + cli (15) + полный vitest + lint
  зелёные.

- **(parity/honesty) сохранять `meta.related_multi_packs` при дословной passthrough/resize повторной эмиссии — round-trip
  безопасность multipack-а на ПЛАТНОМ пути** (`docs/improvements/round28-multipacks-preserve.md`)
  — Манифест страницы-0 multipack-а TexturePacker несёт `meta.related_multi_packs` (имена соседних `.json`, которые Pixi v8
  авто-загружает). Наш парсер его ронял, у ядрового `Atlas` не было поля, а `emitTexturePackerJson` пересобирал `meta`
  с нуля — так что **passthrough-транскод** готового атласа (и resize-эмиссия) молча его срезали,
  ломая авто-загрузку соседей в рантайме: `Assets.load('sheet-0.json')` переставал грузить страницы 1+ (каждый фрейм
  на тех страницах становится undefined-текстурой), при том что чек заявлял чистую disk-only оптимизацию, а
  комментарий в коде ложно заявлял «manifest round-trips» (дефект честности по инварианту 3/5, на распространённом реальном
  входе). **Фикс (низкорисковый срез только дословного-сохранения):** нести опциональный `relatedMultiPacks?: string[]` на
  ядровом `Atlas` (omit-when-absent ⇒ **байт-в-байт** для одностраничных атласов — частый случай); защищённый
  порядко-сохраняющий `readStringArray` читает его в `parseAtlasManifest`; `emitTexturePackerJson` повторно эмитит его
  **дословно, БЕЗ sort** (позиционный индекс нагружен) только когда присутствует+непуст. Он протекает через
  существующие spread-ы `repointAtlasImage`/`scaleAtlas` на byte-stable дефолте и **СРЕЗАЕТСЯ с честной
  skip-заметкой** на каждом пути, где имена соседей меняются: безусловно на пути **tier** (суффиксированные sidecar-ы
  кросс-смешали бы разрешения), на **KTX2** втором sidecar-е (BLOCKER, пойманный ревьюером — `.ktx2.json` иначе
  авто-слинковал бы РАСТРОВОГО соседа, кросс-форматное смешение), и при `hashFilenames` на passthrough+resize (переименованные
  соседи повисают). Ложный drop-in комментарий исправлен на условную правду. Repack/merge/packLoose
  собираются с нуля (нет поля) ⇒ статус-кво. **Без изменений ingest/finding/i18n/UI/бэкенда**, без дрейфа golden/каталога.
  — **Тесты**: parsers +6 (порядок при разборе сохранён; absent/non-array/empty/garbage ⇒ undefined), fix manifest +5
  (emit↔reparse целым, single-page байт-в-байт no-key guard, `repointAtlasImage` его сохраняет, Spine никогда
  его не эмитит), worker harness-ы +3 (tier strip, passthrough preserve-vs-strip-under-hash, новый KTX2-sidecar
  опускает поле). Вердикт ревью: **SHIP after one BLOCKER fixed** (KTX2 кросс-форматный mis-link). Gate:
  typecheck + parsers (54) + fix (434) + полный vitest (web 479) + lint зелёные.

## Раунд 27 — отбор (2 pick-а; все отгружены) — 2026-06-29
Отбор (высокая планка, тонкое пространство): brainstorm в 4 линзы → 5 кандидатов → строгий судья проверил каждую посылку и
выбрал 2 замкнутых выигрыша корректности/честности; отбросил 3 (детектор declared-vs-real размеров атласа — реальный +
релевантный, но нужна откалиброванная толерантность к ложным срабатываниям + 9-локальный каталог, это способность а не замкнутый фикс,
пересмотреть как собственный раунд; format-заметка RGBA4444/RGB565 — спекулятивно про поведение лоадера, нельзя честно
двигать VRAM, риск инварианта 3; сохранять `meta.related_multi_packs` при multipack-passthrough — подтверждённый реальный
слом на ПЛАТНОМ пути, но охватывает 3 пакета со scope-creep-ом регенерации sibling-списка, заслуживает собственного ограниченного раунда).
Дизайны в `docs/improvements/round27-*.md`.

- **cross-atlas-redundancy: схлопнуть каждый атлас в ОДНУ репрезентативную единицу — прекратить двойной учёт собственных
  внутри-атласных дублей атласа как cross-sheet освобождённых копий** (`docs/improvements/round27-crossatlas-deoverlap.md`)
  — `crossAtlasRedundancyFinding` (`folder.ts`) ключевал свой per-cluster distinct-unit guard по `${atlas}|${rect}`,
  так что атлас, упаковавший один и тот же фрейм в N различных rect-ов, которые ТАКЖЕ повторяются на другом шите, вносил N единиц
  → `freed` пере-считывал N−1 внутри-атласных дублей, которые `frameRedundancyFinding` уже возвращает per-rect. Два
  finding-а дважды считали одни и те же пиксели в своих показаниях `dupes`/`recoverableArea`/`vram`/`diskEstimate`
  (показанных бок-о-бок как будто аддитивных), нарушая собственные комментарии orthogonality + HONESTY-PIN кода (инвариант
  3+5: заявленное число должно равняться тому, что доставляет фикс). **Фикс:** ключевать guard по **только имени атласа**
  (один представитель с наименьшим индексом на атлас), так что `distinctUnits` = один на атлас и `freed` = (различных атласов − 1)
  = честный cross-sheet возврат (единственная копия B алиасит общую копию A; внутренние дубли A остаются за
  frame-redundancy). Два finding-а теперь **разбивают** множество дублей с нулевым перекрытием; HONESTY-PIN
  (`dupes` == то, что доставляет cross-atlas alias-фикс) теперь ИСТИНЕН. Неиспользуемый хелпер `rectKey` удалён; сортировка
  по всему кластеру / `freed=slice(1)` / disk-цикл / `relatedRefs` по всему кластеру сохранены дословно. Исправленные числа
  ≤ старых для случая перекрытия и байт-в-байт для частого случая (≤1 различный rect на атлас). VRAM остаётся
  `recoverableArea*4` (честно), disk остаётся finding-локальным (никогда не сворачивается в `potentialDiskSaved`).
  Устаревшие комментарии (folder.ts docstring/HONESTY-PIN/orthogonality, config.ts, core/src/index.ts) исправлены на per-sheet семантику.
  **Без нового config/core-типа, без изменений воркера/UI/бэкенда, без правок i18n-каталога** (drift-фикстура использует один
  общий фрейм на атлас ⇒ схлопывание это no-op ⇒ baked-English byte-match без изменений).
  — **Тесты** (`analysis.test.ts`, TDD): регрессия перекрытия (A с 3 различными `z` rect-ами + B с 1 ⇒
  cross-atlas `dupes===1`, sheets 2, area одна ячейка — подтверждено, что FAIL-ит на 3 при старом ключевании) +
  partition-доказательство (frame-redundancy сообщает внутри-A `dupes=2`/`2×cell`, cross-atlas `dupes=1`/`1×cell`,
  непересекающиеся, суммируются в `3×cell`); все 11 ранее существующих cross-atlas тестов остаются зелёными. Вердикт ревью: **SHIP**
  (ноль блокеров/мажоров; over-claim убран, partition чистый). Gate: typecheck + analysis (150) + i18n (25) +
  полный vitest + lint зелёные.

- **(Spine) lookahead границы страниц multi-page `.atlas` — trim перед regex-ом, чтобы заголовок отступленной страницы `size:`
  на странице 2+ не был проглочен** (`docs/improvements/round27-spine-pageheader.md`)
  — page-start lookahead в `parseSpineAtlasText` тестировал `/^size\s*:/` против СЫРОЙ не-trimmed заглядываемой
  строки, тогда как каждая другая классификация в цикле использует trimmed-строку. Первая страница маскируется
  `!page` short-circuit-ом, но на **странице 2+** современный indented page-заголовок `size:` Spine 4.x проваливал
  regex → вторая текстурная страница **молча роняласьl**, фантомный full-page спрайт отравлял анализ occupancy/wasted-region
  страницы 1, а реальное изображение page-2 ошибочно помечалось как orphan — слом честности по инварианту 3
  (фабрикация + ложный негатив + ложный позитив), ничего из этого не всплывало. **Фикс:** одна строка —
  `/^size\s*:/.test((lines[j] ?? '').trim())` (trim зеркалит конвенцию цикла; `?? ''` держит его bounds-safe
  и never-throwing). Без изменений типа/контракта/воркера/UI/бэкенда. **No-op для каждой существующей фикстуры** (awk-скан
  всех 527 `.atlas` файлов репо нашёл НОЛЬ отступленных page-level `size:` заголовков; отступленные REGION `size:`
  строки следуют за строкой имени и матчатся по ключу, никогда не доходя до bare-line lookahead) ⇒ ноль golden-дрейфа.
  — **Тесты**: парсерный unit-тест над ОБОИМИ tab- и space-отступленными multi-page вариантами (pages===2, корректное
  per-page изображения/размеры/атрибуция спрайтов, `malformedRegions` undefined ⇒ нет фантома), column-0
  regression-guard, и новый ingest-интеграционный тест (`group-spine-multipage.test.ts`), утверждающий что оба page-
  изображения ссылаются и ни одно не помечено ошибочно orphan (фиксирует honesty-фикс end-to-end). parsers 46→48,
  ingest 28→29. Вердикт ревью: **SHIP** (ноль блокеров/мажоров; ревьюер перезапустил gate + воспроизвёл
  баг). Gate: typecheck + parsers (48) + ingest (29) + analysis (148) + полный vitest + lint зелёные.

## Раунд 26 — отбор (2 pick-а; все отгружены) — 2026-06-29
Отбор (строгая планка, тонкое пространство): brainstorm в 4 линзы → 11 кандидатов → скептический судья, который ПРОВЕРИЛ каждую
посылку против кода и выбрал только 2 выигрыша честности/корректности, отбросив 9 (folder-keyed bundles = спекулятивная
новая способность; minify-JSON = само-маргинально; PNG bit-depth = неизмеримая оценка; MAX_TEXTURE_SIZE проба =
редко срабатывает; wasted-alpha WebP confound = узко + только презентация; loose-transcode size guard = неопределённо;
correlateRuntimeDelta = направление moat-а, но слишком широко для замкнутого раунда; runtime-регрессионные тесты + R1
лейблинг оценки = нет user-facing способности). Дизайны в `docs/improvements/round26-*.md`.

- **#3 детектор texture-bleeding — зажигает мёртвый бирюзовый оверлей `bleeding` через чистую frame-adjacency**
  (`docs/improvements/round26-bleeding-detector.md`)
  — `OverlayZone.kind` уже включал `'bleeding'`, а FilmViewer уже стилизовал его бирюзовым, но **ничто его никогда
  не эмитило** — texture bleeding (1px цветовые швы, когда linear/mipmap-семплер GPU дотягивается через границу фрейма
  с 0-gutter, классическая ловушка PixiJS/Phaser) никогда не диагностировался, а мы уже отгружаем ФИКС (edge-extrude).
  **Новое чистое правило** `bleedingFinding(atlas, cfg)` (`packages/analysis/src/rules.ts`) сканирует `Atlas.sprites[].frame`
  (integer rect-ы, НОЛЬ декода) на ПАРЫ, делящие ребро с РОВНО 0px зазором И строго `>0` перпендикулярным перекрытием
  (corner-only касания исключены), пропуская повёрнутые + де-алиася same-rect фреймы (один GPU-регион не может bleed-ить
  сам против себя), bucketed по edge-координате для O(n·k). Гейтится `minPairs` (default 4) / `warnPairs` (16);
  эмитит ОДИН Finding с ОДНИМ `{kind:'bleeding', rects: тонкие 1px полоски шва}` оверлеем (FilmViewer рендерит его
  обобщённо — **без изменения UI**). **Честность по инварианту 5/3 (нагруженное ограничение):** он не несёт **НИКАКОЙ
  `estimate` вообще** — это finding КОРРЕКТНОСТИ, не saving (edge-extrude может УВЕЛИЧИТЬ шит, так что любая
  disk/VRAM-заявка была бы ложью); ничто не течёт в `potentialDiskSaved`/итоги. Текст это **условный честный
  hedge** («ЕСЛИ ваши спрайты используют linear/trilinear фильтрацию или mipmap-ы … nearest-neighbor pixel art не затронут»).
  Срабатывает в браузере по умолчанию (в `DEFAULT_THRESHOLDS`); **CLI байт-в-байт** (нет в `resolveThresholds` +
  guard `if (!cfg.bleeding) return null`). Детерминированно (только integer, стабильный порядок). **Без изменений воркера/UI/бэкенда.**
  — **Сверка golden (честная):** все три существующих `ATLAS_CASES` golden-а проинспектированы по координатам
  фреймов — у каждого ≥10px padding (нет касающихся пар), так что каждый остаётся тихим и его `expected.json`
  НЕИЗМЕНЁН (без blanket-обновления). **Тесты** (`analysis.test.ts`, 13 inline-кейсов): касающаяся пара посчитана + 1px
  полоска + `estimate` undefined (assertion инварианта 5); 1px-зазор padded → null; corner-only → null;
  below-minPairs → null; граница warn; повёрнутые исключены; aliased-same-rect не посчитан; no-config → null;
  `analyze()` эмитит bleeding с НИЧЕМ в `totals.potentialDiskSaved`; padded-атлас тихий. i18n:
  `find.bleeding.{title,detail,fix}` ×9 (plural на `{pairs}`, одинаковые плейсхолдеры; render-drift + catalogs
  parity зелёные). Вердикт ревью: **SHIP** (ноль блокеров/мажоров; honestyOk). Gate: typecheck + analysis (148) +
  i18n (25) + budget (31) + полный vitest + lint зелёные.

- **#6 де-overlap exact-duplicate сброшенных копий vs их собственный format/alpha/strippable saving — убирает
  headline disk over-claim** (`docs/improvements/round26-dedup-overclaim.md`)
  — `analyze.ts` суммировал exact-dedup член `perDisk*(n-1)` И, через per-ref `bestSavedByRef` running-max,
  format/alpha/strippable saving КАЖДОГО loose-изображения — **включая будущие-сброшенные дубликатные копии**.
  Те файлы исчезают при dedup-е, так что их per-ref bump-ы **фантомные**: папка из 2 байт-идентичных
  AVIF-транскодируемых PNG сообщала dup(10k)+format-b(4k фантом)+format-a(4k)=18k, когда достижимый максимум 14k.
  Это раздувало `metric.saveable` — ПЕРВОЕ число, которое видит пользователь (over-claim инварианта 5). **Фикс:** при добавлении
  exact-dup члена, для каждой группы откатывать `Σ bestSavedByRef[droppedRef]` (relatedRefs ≠ assetRef), сохраняя
  dedup-член и полный MAX-вклад СОХРАНЁННОЙ копии. Вычитание ТОЧНОЕ (финальное значение running-max
  == суммарный вклад для того ref); использует ТУ ЖЕ группировку `duplicateExactFindings`, что начисляет disk-член
  (не `buildDedupGroups`); обобщается на atlas-page дубли без branch. Исправленный итог всегда ≤ старого
  (мы только ПРЕКРАЩАЕМ over-claim, никогда не раздуваем), никогда не отрицателен. Per-finding оценки каждая остаётся честной
  отдельно; VRAM-итоги нетронуты (dup `vramBytesSaved` display-only, никогда не суммируется). **Без изменений core/contract/
  воркера/UI/бэкенда.** CLI: dup-блок ТАМ запускается (он передаёт `features` с `contentHash`), но единственный
  откатываемый per-ref saving на CLI-пути это strippable-metadata, так что он корректно откатывает фантомный
  strippable bump на сброшенной dup-копии тоже (отгруженный комментарий честен об этом — ложная «block is skipped»
  заявка, пойманная ревьюером, исправлена).
  — **Тесты** (`analysis.test.ts`, TDD): новый dup+format кейс утверждает `potentialDiskSaved===14000` (было 18000),
  three-way MAX+dup кейс `===16000` (было 22000), atlas-page dup `===14000`, плюс регрессия (dup без
  format ⇒ 10000, байт-в-байт) и non-dup sanity (разные хэши ⇒ 8000, без ложного вычитания); три
  over-claim кейса подтверждены (через git-stash) FAIL-ить при старом коде. Вердикт ревью: SHIP after one
  MAJOR fixed (ложный CLI-комментарий). Gate: typecheck + analysis (135) + полный vitest зелёные.

## Раунд 25 — отбор (3 pick-а; все отгружены) — 2026-06-29
Отбор (строгая планка): из 10 кандидатов выбрано 3 действительно ценных + непересекающихся —
**(#0)** детектор strippable-metadata, **(#1)** BMFont XML+binary парсеры, **(#2)** ресемпл
oversize-clamped ВЕРХНЕГО tier-а — а остальное отброшено (NPOT-fix net-negative на дефолтном пайплайне,
lowercaseOutputNames footgun, две latent-only/no-round очистки, два дубля). Дизайны каждый
прошли design→skeptic→adversarial-review перед impl. Дизайны лежат в `docs/improvements/round25-*.md`.

- **#0 детектор strippable-metadata (ICC / EXIF / XMP / ancillary chunks) — закрывает пробел честности free-tier-а**
  (`docs/improvements/round25-strippable-metadata-detector.md`)
  — Бесплатная диагностика мерила только mime+dims (`readImageInfo`), а `formatFinding` срабатывает только для AVIF/WebP
  при ≥25% — так что metadata-раздутый но в остальном эффективный PNG не получал **никакого вердикта**, хотя Pro-фикс
  (`transcode`/`recompressPng` → canvas re-encode / oxipng) уже срезает эту метаданную. **Фикс:** ЧИСТЫЙ,
  header-only, без декода `strippableMetadataBytes(bytes)` (`packages/parsers/src/image-size.ts`), который обходит
  chunk/marker заголовки и суммирует ТОЧНЫЕ strippable-ancillary байты — PNG allow-set `{iCCP, eXIf, tEXt, iTXt,
  zTXt, tIME}` (len+12; `tRNS/pHYs/gAMA/cHRM/sRGB/bKGD/sBIT` намеренно ИСКЛЮЧЕНЫ, так как могут влиять на
  рендеринг), JPEG `APP1..APP15`+`COM` (2+len; `APP0`/JFIF исключены; стоп на SOS/EOI), WebP `VP8X`
  `EXIF/XMP/ICCP` (size+8); AVIF/unknown → 0. Никогда не бросает, bounds-checked, bail-ит на частичное. Проброшен через
  omit-when-zero spread во **все четыре** `ImageAsset` литерала (`parseImage`, `parseAtlas`, `spine-atlas`,
  `fnt` — вкл. BMFont-рефакторенный путь). Правило `strippable-metadata` (loose + atlas page, default ≥4 KB,
  info/warn по величине) несёт **`diskBytesSaved` ТОЛЬКО ТОЧНО, НИКОГДА `vramBytesSaved`** (инвариант 5 —
  GPU декодирует в RGBA8888 независимо, так что VRAM не меняется) и называет СУЩЕСТВУЮЩИЙ oxipng/re-encode фикс
  (инвариант 3 — измеряем, ничего не генерируем). Folder rollup зеркалит `formatAggregateFinding`.
  — **Без over-claim (центральный риск):** посчитанное множество это строгое подмножество ancillary, не-пиксельных chunk-ов,
  которые фикс определённо роняет — прослежено через `fix.worker.ts`: каждая эмиссия PNG это `convertToBlob` или
  `oxipng.optimise(getImageData)` (только пиксели) БЕЗ raw-byte passthrough нигде (даже prebuilt-atlas
  PASSTHROUGH пере-декодирует через `transcode`), так что `strippableBytes` это консервативная ИСТИННАЯ НИЖНЯЯ ГРАНИЦА. Тест D
  (валидация allow-set) удовлетворён как задокументированный строгий-subset + traced-fix-path анализ (честно в
  README фикстуры, что верный canvas PNG re-encode недоступен в Vitest; oxipng `-strip` это якорь).
  — **De-overlap рефактор:** два ad-hoc `if (x > fmtSaved) potentialDiskSaved += x − fmtSaved` места в
  `analyze.ts` заменены ОДНИМ per-ref `bestSavedByRef` running-max (`bumpBest`), так что format ∩ wasted-alpha ∩
  strippable вносит **MAX, не SUM** (ref с fmt=4000/alpha=6000/strip=5000 ⇒ 6000, не 7000); три
  ранее существующих exact-`potentialDiskSaved` теста остаются зелёными. **CLI байт-в-байт** (`strippableMetadata`
  нет в `resolveThresholds` ⇒ авто-сброшен). **Без изменений воркера/UI/бэкенда.**
  — **Тесты/i18n/фикстура**: 8 новых парсерных кейсов (inline byte arrays + truncation + плюмбинг `parseImage`) +
  11 новых analysis-кейсов (warn/info, `diskBytesSaved` set & `vramBytesSaved` undefined, below-min/absent/no-config
  → null, срабатывает-через-`analyze`, three-way MAX===6000, folder rollup); 6 новых i18n-ключей ×9 каталогов с
  одинаковыми плейсхолдерами (`render.test` drift + `catalogs.test` parity зелёные; текст говорит только DISK/DOWNLOAD);
  вручную написанная `fixtures/sample-projects/strippable-metadata/metadata.png` (реальный 8443-байтный валидный PNG с
  инъецированными `iCCP`+`tEXt`+`tIME`=8347 посчитанных strippable байт + непосчитанный `pHYs`), golden-тестированный через
  parse→analyze. Вердикт ревью: **SHIP** (overClaimSafe; ноль блокеров/мажоров; ревьюер перезапустил полный gate
  + независимо проследил no-passthrough fix-путь). Gate: typecheck + parsers (46) + analysis (130) + i18n
  (25) + budget (31) + полный vitest + lint зелёные.

- **#1 BMFont XML + binary `.fnt` парсеры — завершение паритета TEXT-формата**
  (`docs/improvements/round25-bmfont-xml-binary-parsers.md`)
  — `packages/ingest` детектил XML (`<`-led) и binary (`BMF`+0x03) `.fnt` по magic-у и сбрасывал ОБА в
  `unparsed[]` как «not in TEXT format» — хотя binary это **дефолтный** вывод BMFont.exe/libGDX и
  несёт идентичные данные шрифта + глифов. **Фикс:** `parseFntXml(text)` + `parseFntBinary(bytes)` в
  `packages/parsers/src/fnt.ts`, оба производящие **байт-идентичные `FntPage[]`** к `parseFntText`. Сначала
  behavior-preserving рефактор поднимает общую page-assembly + glyph-routing + recovery в
  `buildFntPages(raw: RawFnt)`, так что все три front-end-а делят ОДНУ реализацию recovery (byte-identity по
  построению; все ранее существующие TEXT-тесты + фикстура `bmfont-sparse` проходят без изменений). `parseFntXml` это
  dep-free, DOM-free, worker-safe attribute-сканер с той же `num/fin` NaN-сохраняющей дисциплиной + минимальным
  entity-декодом. `parseFntBinary` это bounds-checked AngelCode **BMF v3** block-walker (info `fontName`@14;
  common `lineHeight` u16@0/`scaleW`@4/`scaleH`@6; pages uniform-stride NUL-terminated; char 20B `id` u32@0,
  `x/y/w/h` u16@4-10, `page` u8@18; kerning 10B), который **никогда не бросает** — каждое multi-byte чтение bounds-checked,
  обход стопится на любом коротком/OOB чтении и строит на собранном; wrong-magic / v1-v2 / truncated всё
  деградирует в `[]` ⇒ честный `unparsed` (никогда silent-dropped). Ingest теперь диспатчит по bounds-safe magic-у с
  try/catch backstop-ом. **Без изменений core/воркера/UI/бэкенда** (downstream `parseFntPage` → worker → `font-glyph-page`
  readout → per-glyph `malformedGlyphs` recovery переиспользован дословно); чистый, детерминированный.
  — **Фикстуры/тесты**: расширен СУЩЕСТВУЮЩИЙ генератор (`fixtures/_generator/generate.mjs` Case 12, единственный
  источник правды) хелпером `encodeBmfBinary` + два sibling `bmfont-sparse-xml/` и `bmfont-sparse-bin/`,
  эмитированных из ТЕХ ЖЕ данных глифов + ТОГО ЖЕ `font.png` + ТОГО ЖЕ `expected.json` (все три байт-идентичны, md5
  `8714885c…`; воспроизводимо через `node fixtures/_generator/generate.mjs`). Парсерные unit-тесты утверждают
  `toEqual(parseFntText(...))` byte-identity для XML + binary, binary OOB-glyph recovery, XML quote/entity, и
  binary/XML defensive кейсы; два `group-fnt.test.ts` XML/binary кейса переписаны утверждать bmfont
  атлас (+ binary-no-page → missing, junk-`BMF\x03` → unparsed); single-fixture analysis bmfont тест стал
  `it.each` 3-dir циклом, утверждающим идентичный `expected.json` через РЕАЛЬНЫЙ путь `groupFiles → parseFntPage →
  analyze`. Вердикт ревью: **SHIP** (ноль блокеров/мажоров; ревьюер перезапустил gate + перепроверил каждый
  binary offset против AngelCode-спеки). Gate: typecheck + parsers (37) + ingest (28) + analysis (119) +
  полный vitest + lint зелёные.

- **#2 ресемпл oversize-clamped ВЕРХНЕГО tier-а (effectiveScale<1) — закрыть пробел r24#0**
  (`docs/improvements/round25-resample-oversize-clamped-top-tier.md`)
  — r24 lanczos3 resample post-pass гейтил свой candidate-push и честную hash-skip заметку на
  `tier.scale < 1`. Но OVERSIZE источник clamp-ится `clampToMaxEdge`, так что ВЕРХНИЙ tier (`tier.scale === 1`)
  всё равно downscale-ит: `effectiveScale < 1`, `dst < src`, и `c2d.drawImage` запускает kernel браузера — однако
  лучший lanczos3 кандидат пропускался (и при `hashFilenames` skip-заметка не эмитилась) именно на
  крупнейшей, highest-download странице. **Фикс:** один per-tier локальный `tierIsDownscale = dst.w < srcW || dst.h < srcH`
  (DECODED-source-rect истинное условие, устойчивое к малформ-манифесту, чей `srcSize` расходится с
  реальным PNG), вычисленный сразу после `dst`, заменяющий guard `tier.scale < 1` на ОБОИХ data-flow местах (
  candidate push + hash-skip заметка). Место `recordResampleCandidate` (гейтнутое на
  `resampleTierTargets.length > 0`) оставлено текстуально неизменным и наследует фикс транзитивно (тот массив
  заполняется только на теперь-фикснутом push-е); комментарий это записывает, чтобы никто не правил его избыточно. Два
  теперь-ложных комментария (заявляющих что верхний tier всегда пропускается) исправлены. **Дефолтный путь байт-в-байт**:
  resample остаётся полностью opt-in (backend + per-run consent + `op` + token + `hashFilenames` OFF); `vramSaved`
  нетронут (инвариант 5 — те же dims, нет VRAM/disk-заявки, только ИЗМЕРЕННАЯ HF-energy дельта). Без
  изменений contract/wire/backend/i18n.
  — **Тесты** (`apps/web/test/tier-worker.test.ts`): `runTierLoop` теперь моделирует `resampleCandidates` с
  `srcW=srcSize.w` и параметризованным `maxEdge` (само-калиброванный `floor(max(banner.w,banner.h)*0.6)=60` из
  реального 100×50 `banner.png`), воспроизводя дефект через РЕАЛЬНЫЙ путь `clampToMaxEdge`. **T14** —
  clamped верхний tier производит top-tier кандидата (banner count===3; FAIL-ит при старой модели `tier.scale<1`);
  **T15** — нет top-tier кандидата когда не oversized (count===2, over-fire guard); **T16** — gate off ⇒ 0
  кандидатов; плюс assertion эквивалентности `effectiveScale<1 ⇔ dst<src`. Вердикт ревью: **SHIP** (ноль
  блокеров/мажоров; ревьюер перезапустил gate). Gate: typecheck + `tier-worker` (7) + полный vitest зелёные
  (web 476 +1 skipped, fix 429, analysis 117, …).

## Раунд 24 — отбор (#0 отгружено) — 2026-06-29
Pick: **(#0) sidecar-op libvips lanczos3 resample + честный измеренный quality-чек** — путь scale-tier
DOWNSCALE использует canvas-ресемплер браузера, который нельзя направить на конкретный kernel. Это добавляет
OPT-IN backend `resample` op (libvips lanczos3), который downscale-ит full-res верхний tier высококачественным
kernel-ом и ЗАМЕНЯЕТ браузерную плитку при ТЕХ ЖЕ размерах/формате. Только DISK/QUALITY (инвариант 5: те же
dims ⇒ нет VRAM, нет disk-saving); чек несёт ТОЛЬКО ИЗМЕРЕННУЮ дельту удержания high-frequency-energy
(инвариант 3: факт, никогда вердикт «sharper/cleaner» — лишняя HF-энергия lanczos3 включает ringing).

- **#0 op libvips lanczos3 resample (sidecar) + measured high-frequency-energy чек**
  (`docs/improvements/round24-libvips-lanczos3-resample-op-sidec.md`)
  — **Sidecar** (`apps/encoder`): новый `Resample` op + профиль `vips-lanczos3` в закрытых allowlist-ах
  (`encode.go`), mock-тестируемый `ResampleEncoder`, шеллящий в pinned `vips` через `/dev/stdin`→`/dev/stdout`
  (без temp-файлов; `thumbnail_source … --size force` для ТОЧНЫХ tier-dims, `.png[strip]` детерминированный;
  `resample.go`), Dispatcher arm + `VipsPath` config + `main.go` wiring, и pinned `libvips-tools` apt-
  пакет + стабильный `/usr/local/bin/vips` symlink в Dockerfile. op-agnostic gateway (`apps/api`)
  потребовал НОЛЬ изменений (проверено). ASYMMETRY W/H: для resample они это OUTPUT-target, в который full-res источник
  downscale-ится ДО (задокументировано; протестировано). **Client**: `'resample'` в `NativeOpKind` + `profileForOp` +
  `RESAMPLE_PROFILE`; pure Node-тестированный HF-energy measure (mean |Laplacian| по luma → clamped retention
  delta, `resample-quality.ts`) + чистый гейтнутый предикат (`resample-collect.ts`); ГЕЙТНУТЫЙ worker tier post-pass,
  который загружает full-res верхний tier (PNG-re-encoded, M2), получает vips-плитку, измеряет дельту, пере-кодирует
  в каждый tier-формат и заменяет браузерную плитку IN PLACE. **B1 (cache-busting integrity)**: выбран
  design-accepted более простой v1 — resample ГЕЙТНУТ OFF когда `hashFilenames` включён (in-place замена под
  content-hash именами оставила бы хэш описывающим СТАРЫЕ байты), с честной tier-path skip-заметкой;
  никогда безусловная in-place замена. **B2**: ОТДЕЛЬНЫЙ новый ключ `fix.backend.resampleTierHint` только на
  tier-пути — `whyNoKernel` оставлен НЕТРОНУТЫМ (всё ещё истинен на своих 2 non-tier местах). **M1**: поле чека это
  `qualityHfEnergyDelta` («сохранено N% больше high-frequency content при том же размере файла»), clamped
  ≥0, ≤0 оставляет браузерную плитку (delta 0, не failed); НЕТ VRAM/disk поля. ADDITIVE: backend off / op не
  выбран / declined / hashFilenames on ⇒ существующий OffscreenCanvas tier downscale запускается ⇒ байт-в-байт.
  SAFETY (паритет round12/13): opt-in, per-run consent, entitlement-gated, sidecar non-root/RO/stdin-stdout.
  Live e2e отложен (deploy creds-blocked); отгружено за mock Encoder-ом + чистыми хелперами как toktx/pngquant.
  — **Тесты**: sidecar `resample_test.go` (closed flags, op/profile/dims reject pre-exec, missing-binary
  no-byte-leak, `/bin/cat` stdin→stdout passthrough, empty-output fail, Dispatcher routing) + allowlist-
  assertion-ы + `server_test.go` (op-propagation success, op×profile 415, full-res caps 413/415); TS
  `resample-quality.test.ts` (sharp>blur, identical=0, ≤0 clamp, flat=0, determinism) +
  `resample-collect.test.ts` (opt-in gate + взаимодействие B1 hashFilenames) + i18n drift (6 новых ключей × 9
  каталогов; `whyNoKernel` утверждён неизменным). Вердикт ревью: SALVAGEABLE → все 2 блокера + 2 мажора фикснуты.
  Gate: typecheck + vitest + lint + `go build/vet/test` (encoder + api) зелёные.

- **#1 batch очистки reviewer-MINOR — FilmViewer no-flicker · cross-atlas comparator · gzipLen 0-byte guard**
  (`docs/improvements/round24-reviewer-minor-cleanup-batch-filmv.md`)
  — Низкорисковая полировка; каждый фикс аддитивный + честный + детерминированный, БЕЗ изменения измеренного числа.
  **(1) FilmViewer keep-last-frame:** эффект повторного чтения выбранного фильма (`App.tsx`) жадно вызывал
  `setSelectedBytes(null)` на SUCCESS-пути, размонтируя FilmViewer (render gate → no-image) на одно повторное чтение
  → пустая вспышка на каждом клике по строке / arrow-scrub. Решение swap-а теперь ЧИСТАЯ тотальная функция
  `filmSelectionAction(hasSelection, hasReader) → 'clear'|'read'` (`apps/web/src/lib/film-selection.ts`,
  Node-тестируемо, так как в apps/web нет React-harness-а); эффект диспатчит по ней и УБИРАЕТ success-path
  clear, так что прежний реальный атлас остаётся смонтированным пока новые байты не резолвятся. Cancel-флаг сохранён
  (новейшее чтение всегда побеждает; быстрое A→B→A никогда не stale-lock-ится). `'clear'` всё ещё срабатывает на подлинном no-selection /
  no-reader (честный no-image, никогда сфабрикованный фильм). **(2) унификация cross-atlas comparator-а:**
  `crossAtlasRedundancyFinding` (`folder.ts`) упорядочивал кластеры + выбирал представителя под
  `localeCompare`, но сортировал OUTPUT-множества (`relatedRefs`, `atlases`, `assetRef` anchor) под bare
  `.sort()` (code-unit) — они могут РАСХОДИТЬСЯ на mixed-case / non-ASCII именах. Оба output-sort-а теперь используют
  `localeCompare`, так что все четыре места упорядочивания делят ОДНУ collation (совпадает с `manifest.ts`). Output неизменен на
  pure-ASCII входах (обе collation-ы согласны). **(3) gzipLen 0-byte guard + extraction:** inline `gzipLen`
  (worker, includeFileSizes='gzip') вынесен в ЧИСТЫЙ модуль (`apps/web/src/worker/gzip-len.ts`) с
  ведущим guard-ом `bytes.length===0 ⇒ 0` — у пустого файла нет транспортируемых байт, так что прежний ~20-байтный gzip-
  frame overhead его завышал (тот же класс, что правило manifest-а missing⇒0). Место вызова байт-в-байт.
  **(4) resample top-tier gate:** ПРОПУЩЕНО — вне объёма этого дизайна (отсутствует; resample-работа это
  Round 24 #0). — **Тесты**: `film-selection.test.ts` (нагруженный `(true,true)==='read'` regression-
  lock + clear-кейсы), `gzip-len.test.ts` (empty⇒0; compressible >0 и ≤ raw; single-byte >0; determinism,
  реальный `CompressionStream` не замокан), `analysis.test.ts` cross-atlas mixed-case anchor (`B.png`/`a.png`:
  anchor='a.png' под localeCompare, code-unit выбрал бы 'B.png'); существующие ASCII golden-ы не сдвинуты.
  Gate: typecheck + vitest + lint зелёные.

## Раунд 23 — отбор (#0 отгружено) — 2026-06-29
Pick: **(#0) парсер bitmap-font (.fnt BMFont) + ingest-группировка + glyph-page аудит** — AngelCode BMFont
glyph-шиты были нераспознанным типом файла (молча сбрасывались). Распарсенная `.fnt` страница структурно это
атлас, так что это учит пайплайн её ингестить и всплывает font-специфичный readout РЯДОМ с обобщёнными
atlas-finding-ами, которые она уже триггерит.

- **#0 парсер Bitmap-font (.fnt BMFont) + ingest + glyph-page readout**
  (`docs/improvements/round23-bitmap-font-fnt-bmfont-parser-inge.md`)
  — новый чистый `parseFntText(text) → FntPage[]` / `parseFntPage(page, image, opts) → ParseResult`
  (`packages/parsers/src/fnt.ts`), верное **зеркало модуля Spine `.atlas`**: никогда не бросает,
  per-glyph recovery через `FntPage.malformedGlyphs` (читается воркером ровно как
  `SpinePage.malformedRegions`), NaN-сохраняющие numeric-чтения (non-finite required поле роняет глиф,
  никогда не coerce-ится в 0), OOB/degenerate-rect recovery, quote-aware `face=`/`file=`. **Только TEXT-формат**; XML
  (leading `<`) + binary (`BMF\x03`) `.fnt` → честный `unparsed[]`, никогда silent-dropped. **Multi-page
  ключуется по `char.page` id** (в BMFont TEXT каждая `char` строка следует за ВСЕМИ `page` строками, так что правило «most-recent
  page» сбросило бы каждый глиф на последнюю страницу — дефект корректности/детерминизма, помеченный скептиком);
  страницы эмитятся id-sorted. Whitespace-глиф (`width=0 height=0`, напр. id=32) пропускается, не ошибка.
  Каждый `char` → `Sprite` (frame x,y,width,height; sourceSize из width/height; `trimmed:false` —
  xoffset/yoffset это layout-offset-ы, НЕ in-page trim, так что occupancy остаётся честным packed-покрытием).
  — ingest `groupFiles` распознаёт `.fnt`, резолвит каждое page-изображение **dir-aware** (переиспользуя
  `resolve`/`keyOf`/`atlasName`), маршрутизирует его как `GroupedAtlas.kind: 'bmfont'`; XML/binary/empty `.fnt` →
  `unparsed[]` (`packages/ingest/src/index.ts`).
  — core: `AtlasSourceKind += 'bmfont'`, `Rule += 'font-glyph-page'`, `ThresholdConfig.fontGlyphPage?:
  { minChars, occupancyWarn }` (default `{ 16, 0.5 }`). новый analysis `fontGlyphPageFinding`
  (`packages/analysis/src/font.ts`): glyph-page occupancy + glyph count + kerning-present, positive-guarded
  на `source.kind === 'bmfont'`; `analyze.ts` пробрасывает новую dep `AnalyzeDeps.fontPages` (face + kerning,
  ключуется по atlas.name).
  — worker маршрутизирует `a.kind === 'bmfont'` → `parseFntPage` + per-glyph `<page>#<id>` recovery + строит
  `fontPages` (`apps/web/src/worker/analyze.worker.ts`). i18n `find.font-glyph-page.{title,detail,fix}` во
  всех 9 каталогах (drift-guarded + 9-локальный паритет). Golden-фикстура
  `fixtures/sample-projects/bmfont-sparse/` (16-glyph sparse `.fnt` + PNG, whitespace-глиф + OOB
  recovery глиф) прогнана через **РЕАЛЬНЫЙ путь** (`groupFiles → parseFntPage → analyze` с
  `fontPages`), утверждающая что finding `font-glyph-page` **СРАБАТЫВАЕТ** (warn) рядом с обобщённым occupancy
  (crit) + wasted-regions (info) finding-ами.
  **ТОЛЬКО ДИАГНОЗ** (инвариант 3 — ничего не генерируется). **Инвариант 5 (без двойного учёта):** `estimate` readout-а
  несёт **только** `occupancyPct` — обобщённые occupancy/oversize finding-и владеют VRAM (w·h·4)
  на ТОЙ ЖЕ странице; НЕТ сфабрикованного disk/VRAM-saved. **Fix-путь БЕЗОПАСЕН с НУЛЕВЫМ изменением** (проверено): фикс
  ветвится только на `opts.kind === 'spine'` и **эмитит** `source.kind`, никогда не читает входящий
  `AtlasSourceKind`, так что `'bmfont'` атлас не нуждается в fix-wiring. **Аддитивно:** нет `.fnt` ⇒ весь вывод
  байт-в-байт (CLI/headless не затронуты — `fontGlyphPage` НЕ перечислен в `resolveThresholds`).
  **Скептик-фиксы (нагруженные):** (1) multi-page glyph-attachment ключуется по `char.page`, НЕ most-recent
  page; (2) сфабрикованная задача App.tsx source-kind label-а ОТБРОШЕНА (такого UI нет — `atlas.source`
  никогда не рендерится).
  - Gate: `pnpm typecheck && pnpm test && pnpm lint` зелёные.

- **#1 Ре-синк генератора untrimmed-padding для идемпотентности (Case 20 repack-блок)**
  (`docs/improvements/round23-re-sync-the-untrimmed-padding-gene.md`)
  — `fixtures/_generator/generate.mjs` Case 20 (`untrimmed-padding`) строил `regions`/`recoverableArea`/
  `vramBytesSaved`, но **больше не эмитил** r20 `repack` блок, который закоммиченный
  golden `untrimmed-padding/expected.json` несёт (`trimmedSprites`/`trimmedAreaReclaimed`/`perSprite`), так что
  обычный пере-запуск `node generate.mjs` **молча его ронял** — латентная неидемпотентность генератора, которая сломала бы
  двух `repack` читателей (`packages/fix/test/fix.test.ts`, `apps/web/src/lib/perceptual.test.ts`
  trim-on-repack e2e).
  — Заново добавлена эмиссия `repack` **ВЫВЕДЕННАЯ из тех же `specs[]`**, что строят regions:
  `trimmedSprites = untrimmedSpecs.length`, `trimmedAreaReclaimed = recoverableArea` (уже-вычисленный
  Σ(frame−bbox) по untrimmed-spec-ам), `perSprite[].{packedSize=(bw,bh), sourceSize=(CELL,CELL),
  spriteSourceSize=(mx,my,bw,bh)}` — вычислено, **никогда не hand-copied числа**; `trimmed_0` исключён через
  `!s.trimmed`. Порядок ключей сохранён (`repack` между `vramBytesSaved` и `findings`).
  — Регенерирован golden, так что вывод генератора **=== закоммиченному golden-у**: единственное byte-change это
  переформатирование `perSprite` блока из hand-authored single-line в canonical `JSON.stringify(_,null,2)`
  multi-line (семантически идентично — проверено whitespace-stripped equal; все 6 читателей `JSON.parse`).
  **ТОЛЬКО ГЕНЕРАТОР/ФИКСТУРА** — без изменения source/behavior/contract. **Идемпотентность ПРОВЕРЕНА:** после staging-а,
  `node fixtures/_generator/generate.mjs` производит НОЛЬ дальнейшего git diff по всем фикстурам (детерминированно:
  статические `specs[]`, `.filter/.reduce/.map` порядко-сохраняющие, integer-арифметика, без randomness/time/FS-order).
  Trim-margin e2e остаётся зелёным.
  - Gate: `pnpm typecheck && pnpm test && pnpm lint` зелёные; `node fixtures/_generator/generate.mjs &&
    git status --short` → нет fixture-diff.

- **#2 `includeFileSizes` → `progressSize` в PixiJS-манифесте (паритет AssetPack)**
  (`docs/improvements/round23-includefilesizes-progresssize-in-t.md`)
  — OPT-IN, DEFAULT OFF. Когда включено, каждый `src` кандидат в эмитированном PixiJS-v8 `manifest.json` становится
  `{ src, progressSize }` вместо bare-строки — **РЕАЛЬНОЕ поле, которое эмитит AssetPack 1.7.0**
  (`pixiManifest.js:139-142`, проверено на диске дизайном), так что PixiJS показывает точный `Assets.load`
  прогресс по транспорту. `progressSize` это размер в **KB до 2 знаков после запятой**: `getFileSizeInKB` AssetPack-а
  делит длину в байтах на 1024 в **обеих** ветках (`utils.js:24-42`), так что `'raw'` =
  uncompressed KB (`statBytes/1024`) и `'gzip'` = gzipped KB (`gzipBytes/1024`) — **оба это KB**, никогда
  bytes-out.
  — ЧИСТЫЙ builder (`packages/fix/src/pixi-manifest.ts`): новый `PixiSizedSrc { src; progressSize }`,
  `PixiUnresolvedAsset.src` расширен до `string[] | PixiSizedSrc[]`, `BuildPixiManifestOptions.includeFileSizes?:
  false | 'raw' | 'gzip'` + `srcBytes?: ReadonlyMap<string, number>` (ФИНАЛЬНАЯ эмитированная длина в байтах per `src`,
  поставляемая воркером). Одна ветка в per-tier цикле мапит каждый sorted `src` в `{ src, progressSize:
  kbOf(srcBytes.get(s) ?? 0) }`. **`EmittedVariant` неизменён** (нет per-variant `bytes` — размер приходит из
  post-replace byte-map воркера, не из push-места). Реэкспортирован `PixiSizedSrc` из `index.ts`.
  — Worker (`apps/web/src/worker/fix.worker.ts`): ЕДИНСТВЕННАЯ правка в месте build-а манифеста — строит
  `srcBytes` над **`dedupedOut`** (ФИНАЛЬНЫЕ отгруженные байты, ключуются по точным путям, которые использует `src`
  манифеста), так что pngquant/KTX2 **in-place page replacement отражается честно** (без устаревшего lossless-размера). Новый
  top-level `gzipLen()` через стандартный Worker `CompressionStream('gzip')` (без сети, без native-lib —
  инвариант 1) поставляет `'gzip'` byte-source. Вызов builder-а **spread-gated**, так что OFF ⇒ ни одна опция
  не доходит до builder-а.
  — `FixOptions.includeFileSizes?: 'raw' | 'gzip'` (`fix-protocol.ts`); App.tsx `includeFileSizes`
  state + `<select>` (Off / Uncompressed KB / Gzip KB) **отключён пока Pixi-манифест не эмитится**
  (`effectiveEmitManifest`), проброшен через `buildOptions` (UI-значения ЕСТЬ contract-значения — без remap).
  i18n: 5 новых ключей (`fix.includeFileSizes`, `…Hint`, `.off/.raw/.gzip`) во всех 9 каталогах (drift-guarded).
  — **ЧЕСТНОСТЬ (инвариант 3):** оба режима ИЗМЕРЕНЫ из фактически-отгруженных байт; ничего не оценено или
  сфабриковано. **АДДИТИВНОСТЬ:** absent/`'off'` ⇒ bare-string `src` ⇒ манифест **БАЙТ-В-БАЙТ** к сегодняшнему
  (нет поля `progressSize` нигде). **Инвариант 5:** `progressSize` это disk/download размер, никогда не суммируется в
  VRAM или какой-либо saving. **ДЕТЕРМИНИЗМ:** чистая математика для `'raw'`; gzip-длина platform-stable (golden-тесты
  утверждают `'raw'` точно, gzip только как границу).
  — Тесты (`packages/fix/test/pixi-manifest.test.ts`, T17-T24): off-path byte-identity (srcBytes игнорируется когда
  флаг отсутствует), `'raw'` shape + KB-значения + порядок форматов, KB-rounding паритет (1536→1.5, 300→0.29,
  0→0), sheet ⇒ sidecar size (изображение не в src), детерминизм под shuffled-input-ом, missing-src ⇒ 0,
  field-name lock (`progressSize` присутствует, `fileSize`/`size` отсутствуют), и real-path multi-tier+atlas фикстура,
  доказывающая что оно срабатывает end-to-end.
  - Gate: `pnpm typecheck && pnpm test && pnpm lint` зелёные.

---

## Раунд 22 — отбор (#0 отгружено) — 2026-06-29
Pick: **(#0) ДЕТЕКТОР cross-atlas frame-redundancy** — folder-scope сиблинг within-atlas
frame-redundancy. Region-хэши уже вычислялись folder-wide в `analyze.ts`, но потреблялись только
per-atlas, отбрасывая cross-atlas сравнение; это кластеризует их по ВСЕМ шитам.

- **#0 детектор cross-atlas frame-redundancy** (`docs/improvements/round22-cross-atlas-frame-redundancy-detec.md`)
  — новый folder-scope `crossAtlasRedundancyFinding(atlases, frameHashByRef, byteByRef, cfg)` (`packages/analysis/src/folder.ts`)
  кластеризует ТЕ ЖЕ per-atlas region-хэши, что потребляет within-atlas правило (построенные folder-wide в `analyze.ts`
  ~:119, ранее читались только per-atlas ~:174) и срабатывает ТОЛЬКО когда кластер охватывает ≥2 РАЗЛИЧНЫХ атласа
  (single-atlas кластеры остаются работой `frame-redundancy` — без двойного репорта). Сообщает счёт cross-sheet
  дубликатных копий + **`vramBytesSaved = recoverableArea × 4` ТОЧНО** — зеркалит отгруженный within-atlas
  прецедент `frameRedundancyFinding` (rules.ts:232) с ТЕМ ЖЕ distinct-rect guard-ом (pre-aliased rect = одна
  единица, применяется per atlas). Новый `Rule` `'cross-atlas-redundancy'`; новый config `crossAtlasRedundancy?: { minDuplicates }`
  (default 2 — у cross-sheet повторения нет оправдания in-sheet-aliasing-ом); distinct `messageKey`
  `'cross-atlas-redundancy'` + `find.cross-atlas-redundancy.{title,detail,fix}` во всех 9 каталогах (drift-guarded).
  Golden-фикстура `fixtures/sample-projects/cross-atlas-redundant/` (два шита, делящие байт-идентичный textured
  фрейм) воспроизведена через РЕАЛЬНЫЙ decode-путь (decode → чистый `extractFrameRegions` → SHA → finding) в
  `apps/web/src/lib/perceptual.test.ts`. **ТОЛЬКО ДИАГНОЗ** (cross-atlas ФИКС это отдельный кусок — инвариант
  3, мы ничего не генерируем). **Аддитивно:** несётся только в finding-е, НЕ свёрнуто в `potentialDiskSaved`
  (инвариант 5); absent-хэши / нет cross-sheet дублей ⇒ нет finding ⇒ байт-в-байт к сегодняшнему.
  **Скептик-BLOCKER-ы (нагруженные):** (B2 honesty) НЕТ POT-tier VRAM-gate / packer-а — реальный MaxRects-pack
  объединённого множества приземляется на БОЛЬШИЙ bin, чем area-floor, так что bin-tier delta OVER-claim-ила бы saving, который
  не доставляет ни один реальный merge (инвариант 5); VRAM это ТОЧНЫЕ duplicate-region px × 4, без `pack()` импорта, без inline-
  sizer-а, без POT-conditional-а. (B1) `messageKey` это РАЗЛИЧНОЕ значение `'cross-atlas-redundancy'` (неверный ключ
  молча рендерит within-atlas шаблон) — pinned + утверждён в unit + e2e тестах. (M3) текст ограничивает
  заявку только областью DUPLICATE-FRAME и документирует ортогональность к atlas-merge (который возвращает
  ПУСТОЕ пространство — другие px, аддитивно а не тот же выигрыш). Disk = area-пропорциональная ОЦЕНКА, атрибутированная per freed
  copy её СОБСТВЕННОМУ атласу, никогда не conflate-ится с VRAM (инвариант 5). Детерминизм: стабильный представитель кластера
  (наименьший `(atlasName, spriteIndex)`) + sorted ref/atlas-списки. Honesty pin: `dupes = Σ(distinctUnits − 1)` =
  точный `framesAliased`, который будущий cross-atlas фикс сообщил бы.

- **#1 cross-atlas frame dedup во время MERGE** (`docs/improvements/round22-cross-atlas-frame-dedup-during-mer.md`)
  — Pro-ФИКС для детектора #0: во время агрессивного atlas-MERGE дедуплицировать байт-идентичные фреймы, охватывающие
  НЕСКОЛЬКО source-шитов — упаковать ОДИН регион на cross-sheet кластер и указать каждое дублирующее имя фрейма (по
  ВСЕМ объединённым шитам) на тот один регион в объединённом манифесте. Новый чистый `buildMergeAliasMap(group,
  frameHashByRef, minDistinctRects)` (`packages/fix/src/alias.ts`) — WHOLE-GROUP аналог within-atlas
  `buildAtlasAliasMap`: кластеризует region-хэши по группе в ОДНОМ плоском `(atlasName, frameName)` keyspace.
  **B1 (нагруженное):** distinct-rect guard **ATLAS-QUALIFIED** (`${atlasName}|x,y,w,h`, зеркалит
  детектор в `folder.ts:365`) — два байт-идентичных фрейма на случайно-равных координатах на РАЗНЫХ шитах это
  две физически-различные копии ⇒ два различных rect-а (bare within-atlas rectKey ошибочно схлопнул бы их
  в один и никогда не сработал бы); pre-aliased rect ВНУТРИ одного атласа всё ещё схлопывается (без двойного учёта). `repackAtlases`
  получает опциональный плоский `mergeAliasMap` arg (`packages/fix/src/repack.ts`): он упаковывает ОДИН rep на cross-sheet
  кластер, эмитит Sprite для КАЖДОГО дублирующего имени на финальном rect-е rep-а (копируя СОБСТВЕННЫЕ имени
  trim/pivot/sourceSize), один Blit на rep. **ЧЕСТНОСТЬ:** `vramBytesBefore/After` ТОЧНЫЕ из реального
  `repackAtlases` объединённой группы; новый `RepackResult.vramReclaimedBytes` (= no-alias БАЗОВЫЙ pack
  полного item-set той же группы − deduped-bin) + `potTierDropped` изолируют РЕАЛЬНУЮ измеренную VRAM-дельту merge-а —
  НЕ area-floor/POT-gate, которого ДЕТЕКТОР (#0) избегал, потому что merge фактически производит bin. Когда
  dedup НЕ роняет POT-tier, выигрыш disk-only и сообщается как таковой (`crossSheetVramReclaimedBytes:0`,
  инвариант 5). **B2 (worker):** `fix.worker.ts` лениво хэширует любой group-шит, отсутствующий в `frameHashByRef`
  в merge-ветке (upfront `≥minDuplicates` pre-filter голодает headline many-small-sheets кейс) и
  кэширует обратно, затем строит merge-map на cross-atlas `minDuplicates` gate (default 2) и пробрасывает её
  в оба merge `repackAtlases` вызова + extrude no-gutter baseline (B3). Новые поля чека
  `crossSheetFramesDeduped` / `crossSheetVramReclaimedBytes` / `crossSheetPotTierDropped` + рендер `App.tsx`
  (VRAM-tier vs disk-only текст) + 2 новых i18n-ключа × 9 каталогов. **DROP-IN / БЕЗ DANGLING REF:** каждое оригинальное
  имя фрейма из каждого объединённого шита всё ещё резолвится в эмитированном TexturePacker JSON (round-trip протестировано);
  фрейм, чей шит сброшен, резолвится в объединённый регион. **АДДИТИВНОСТЬ:** нет merge / нет cross-sheet дублей /
  aggressive-merge off / `mergeAliasMap` отсутствует ⇒ байт-в-байт (no-alias поля опущены; no-op map
  deep-equals `repackAtlases(group, opts)`). **ДЕТЕРМИНИЗМ:** стабильный rep (наименьший плоский индекс) + sorted emit.
  Тесты: `alias.test.ts` (T1 group-кластеризация + per-atlas under-alias контраст, T1b atlas-qualified key, pre-
  aliased схлопывание, sub-gate carve-out, fail-safe missing-хэши) + `fix.test.ts` (T2 one-region-every-name-
  resolves + one-Blit-per-rep + no-alias контраст, T2-roundtrip, T3 POT-tier-drop ТОЧНЫЙ vram vs same-tier
  disk-only, T4 additivity deep-equal). Едет на существующем пути aggressive atlas-merge; rotated-mismatch +
  name-collision guard-ы унаследованы от merge-пути без изменений.

- **#2 честный fix-simulation footprint preview на Plan-карте** (`docs/improvements/round22-honest-fix-simulation-footprint-pr.md`)
  — dry-run Plan-карта теперь всплывает ЧЕСТНЫЙ before→after footprint preview рядом со счётами op-ов, разделённый на
  две сложенных строки, которые никогда не фабрикуют итог. Новый ЧИСТЫЙ `summarizeFixPlanFootprint(report, ops, excluded)`
  (`apps/web/src/lib/plan-footprint.ts`) агрегирует ТОЛЬКО дельты, познаваемые ДО compose, из уже-
  ИЗМЕРЕННОЙ finding-геометрии: **measured now** — DISK = `format`/`format-lossless` srcBytes−bestBytes для ref-а с
  ВЫЖИВШИМ transcode-op-ом (lossy q0.9 оценка ⇒ `estimated`, UI префиксует `~`) + `wasted-alpha` srcBytes−opaqueBytes
  для ВЫЖИВШЕГО opaque transcode-а (измеренный channel-drop); VRAM = `dimensions-oversize` `params.vram` − to.w·h·4 для
  ВЫЖИВШЕГО resize-а (ТОЧНО). **computed at execute** — `deferredOps` считает repack/merge/pack/dedup + worker-
  свёрнутый scale-tier множитель (размеры, которые encode/pack один резолвит) → «+N more computed at download». Новый опциональный
  `FixPlanFootprint` + `FixPlanSummary.footprint?` (`fix-protocol.ts`); worker прикрепляет его в plan-блоке над
  `countedOps`+`excluded` и сворачивает `tierAssets` в `deferredOps` когда tiering выживает маску. `PlanCard`
  (`App.tsx`) рендерит две строки, disk vs VRAM ВИЗУАЛЬНО РАЗЛИЧНЫЕ (VRAM в собственном бирюзовом token-е), каждый сегмент только
  когда >0 (VRAM-only план никогда не показывает сфабрикованный «disk −0 B»).
  **ЧЕСТНОСТЬ (нагруженное, инварианты 3/5):** preview суммирует ТОЛЬКО pre-compose-познаваемые числа; disk и VRAM
  держатся РАЗЛИЧНЫМИ (никогда комбинированный headline); transcode никогда не питает VRAM а resize никогда не питает disk; **npot/solid
  ИСКЛЮЧЕНЫ полностью** (planFix не эмитит op для них, а resize не достигает ни их POT-padding-а ни 1×1
  reclaim-а — разные non-additive baseline-ы, сфабриковали бы выигрыш, который run никогда не производит); op, который вносит
  ничего познаваемого, исключён и честно посчитан как deferred. Объективность ДИАГНОЗА сохранена — это fix-PLAN
  preview (план существует; он ничего не генерирует). **АДДИТИВНО:** ничего измеримого ⇒ `undefined` ⇒ нет footprint-а
  прикреплено ⇒ Plan-карта байт-в-байт к сегодняшней. **ДЕТЕРМИНИЗМ:** стабильные Set/Map суммы над детерминированно-
  упорядоченными finding-ами/op-ами, без Date/random. i18n: 3 новых ключа (`fix.plan.measuredNow` label + `measuredNowDisk`/
  `measuredNowVram` с `{disk:bytes}`/`{vram:bytes}` hint-ами, разделённые так что VRAM-only план не показывает disk-строку + `alsoRuns`
  plural `{n}`) × 9 каталогов (drift + plural-render guarded); `fix.plan.deferredNote` расширен estimate vs
  exact + at-download caveat-ом. Тесты: ЧИСТЫЙ `apps/web/test/plan-footprint.test.ts` (корректные bucket-ы, disk≠VRAM,
  разделение инварианта 5, op-gating, format∩wasted-alpha-once, mask-обнуление, BLOCKER-1 npot/solid 0-VRAM регрессия,
  deferredOps, empty⇒undefined, negative-clamp, детерминизм) + `plan-worker.test.ts` (переписанный honesty-assertion —
  опциональный top-level footprint с РАЗЛИЧНЫМИ disk/VRAM, repack-is-deferred headline honesty, mask-all⇒undefined).

---

## Раунд 21 — отбор (#0 отгружено) — 2026-06-29
Pick: **(#0) standalone trim-margin → repack scheduling** — снимает кэп с r20 trim-on-repack ФИКСА, так что он срабатывает
даже когда никакой occupancy/frame-redundancy/merge repack уже не запланирован.

- **#0 standalone trim-margin → repack scheduling** (`docs/improvements/round21-standalone-trim-margin-repack-sche.md`)
  — finding `trim-margin` теперь эмитит СОБСТВЕННЫЙ pass-1 `repack` op (`PlanOptions.trimMargin`, default ON), так что
  padded-но-ПОЛНОСТЬЮ-УПАКОВАННЫЙ атлас (нет occupancy/wasted finding-а ⇒ нет repack сегодня) наконец trim-ится. Переиспользует
  r20 trim-on-repack execute-путь (`buildTrimArrays` → `repackAtlases({trim})`): точный `vramSaved`
  before−after, disk-число остаётся оценкой (инвариант 5), `trimmedSprites` всплывает в чеке.
  Защищён от double-emit с occupancy И frame-redundancy путями через общий `repacked` set
  (order-free — finding-и SORTED), и pre-excluded из tiering-а как другие repack-driving finding-и.
  **Скептик-BLOCKER B0/B1 (нагруженный):** FIX-worker сам перезапускает `analyze()`, но его локальный
  `hashAtlasFrames` возвращал ТОЛЬКО хэши (без bbox-ов) и НИКОГДА не передавал `frameTrims`, так что trim-margin finding
  срабатывал в FREE diagnosis-worker-е, но **никогда** в fix-worker-е → фича была бы no-op (мёртвый toggle).
  Фикснуто портированием `{hashes,bboxes}` shape-а analyze-worker-а в fix-worker и подачей
  `frameTrims` (ключ `bboxes`) в его `analyze()` вызов; diagnosis decode-проход теперь запускается когда
  `frameRedundancyOn || trimMarginOn` (общий page-decode — один decode в любом случае) и держит каждый массив
  независимо (run `frameRedundancy:false, trimMargin:true` всё равно получает trim-bbox-ы; `trimMargin:false` ⇒
  байт-в-байт). `FixOptions.trimMargin` + App toggle (default ON) + i18n ×9. Тесты прогоняют РЕАЛЬНЫЙ
  analyze→plan путь (synthetic decoded RGBA → реальный `alphaBBox` → `frameTrims` → `analyze` → `planFix`):
  полностью-упакованный padded-атлас ⇒ ровно один repack-op + `trimmedSprites > 0` реализован; без double-emit когда
  occupancy тоже срабатывает; аддитивно (off ⇒ байт-в-байт). АДДИТИВНО — default-on но absent-field ⇒ нет plan/byte
  изменения когда ничего не квалифицируется.

- **#1 per-frame recovery для TexturePacker/Pixi атласов** (`docs/improvements/round21-per-frame-recovery-for-texturepack.md`)
  — `parseAtlasManifest` раньше WHOLE-REJECT-ил шит на первом непригодном фрейме (`{ok:false}`), теряя 499
  хороших фреймов из-за 1 повреждённого. Теперь он ВОССТАНАВЛИВАЕТ хорошие спрайты и собирает каждый сброшенный фрейм в
  `malformedFrames[] {name, reason}` — симметрично с уже-отгруженным Spine per-region recovery. Циклы
  array/hash фреймов и out-of-bounds проход стали per-frame partition-ами (skip + surface) вместо
  whole-manifest bail-ов; analyze-worker fan-ит `res.malformedFrames` в существующий канал `unparsed[]`
  как `<atlas>#<frame>` (детерминированно, sorted). ЧЕСТНОСТЬ (инвариант 3): каждый сброшенный фрейм сообщён с
  reason-ом — ничего молча не сброшено или clamp-нуто. АДДИТИВНОСТЬ: полностью-валидный атлас парсится байт-в-байт (те же
  спрайты, тот же порядок, нет поля `malformedFrames`); ПУСТОЙ `frames` объект всё равно возвращает `{ok:true,
  sprites:[]}` (zero-survivor guard гейтнут на `malformedFrames.length>0`); ALL-bad манифест всё равно
  wholesale-fail-ит сегодняшней first-failure ошибкой (сохраняет F3 single-frame-sheet тесты). СТРУКТУРНЫЕ
  сбои (плохой JSON / нет frames-объекта / нет `meta.image`) всё равно wholesale-fail-ят на ingest/parse как раньше.
  Contract аддитивный только: опциональный `malformedFrames` на ok-ветке `AtlasParseResult` + локальное расширение return-а
  на `parseAtlas` (без изменения `@asset-doctor/core` / `ParseResult`; все остальные callers деструктурируют
  `{ok,asset}` и игнорируют лишний prop). Новая фикстура `fixtures/sample-projects/atlas-frame-recovery/`
  (Hash с degenerate `w:0` фреймом + Array с OOB-фреймом, воспроизведено через РЕАЛЬНЫЙ parse-путь) +
  golden `expected.json`. Тесты: 5 парсерных unit-ов (Hash/Array recovery, zero-survivor всё ещё `{ok:false}`,
  empty-frames byte-identity, clean-sheet не имеет поля) + 1 e2e worker-path `it` (group→parse→fan-out→analyze
  всплывает `sheet.png#bad.png` + `sheet.png#over.png` пока хорошие фреймы остаются диагностированными).
  **Gate:** `pnpm typecheck` + `pnpm test` (parsers 17→22, apps/web 407→408; все пакеты зелёные) + `pnpm lint` чисто.

- **#2 ограничить resident-байты analyze (FREE-path) воркера** (`docs/improvements/round21-bound-the-analyze-free-path-worker.md`)
  — убивает подлинную ~2× source-byte копию на free diagnosis-пути и делает ранее-ТИХИЕ oversize-scan
  пропуски честными. **(a) Transfer + lazy re-read.** `runAnalysis` теперь ПЕРЕДАЁТ каждый `PickedFile.bytes` в
  analyze-worker (worker становится ЕДИНСТВЕННОЙ resident-копией) когда КАЖДЫЙ файл несёт re-readable `file` (
  аддитивный `PickedFile.file?: File`, заполняемый всеми тремя ingest-путями); иначе он КЛОНИРУЕТ (сегодняшнее поведение), так что
  legacy-callers остаются корректными. Main-thread больше не держит eager dir-aware byte-`map` (который захватил
  `f.bytes` ДО transfer-а ⇒ держал бы DETACHED буферы — sequencing-BLOCKER) — он ПЕРЕ-ЧИТЫВАЕТ с
  диска по требованию через новый чистый `lib/source-bytes.ts` (`readSourceBytes` / `sourceReaders`, ключуется ТЕМ ЖЕ
  `keyOf`). FilmViewer-selection (async-резолвится в state, cancel-guarded; null ⇒ честная «no image»
  ветка, никогда сфабрикованный фильм), render-probe (`attachProbeReadings` `bytesOf` расширен в async + 
  дополнительный post-re-read abort-guard), и fix-путь (FixCard пере-source-ит свежие байты перед `planFix`/`runFix`;
  любой null ⇒ честный refuse, никогда повреждённый zip) — все читают через него. **(b) честные oversize-пропуски + cap unify.**
  Full-resolution `decodeFeatures` alpha-scan воркера и `hashAtlasFrames` page-read гейтятся
  общим `pageExceedsScanBudget` / всплывают через `scanSkipReason` (новый в `lib/bitmap-budget.ts` как
  single-sourced `ANALYZE_PAGE_MAX_PX` — `perceptual.FRAME_HASH_MAX_PX` теперь его реэкспортирует; inline
  `ALPHA_SCAN_MAX_PX` воркера удалён, заканчивая byte-identical-but-forked дрейф). Oversize-страница теперь приземляет
  `{ref, reason}` в существующий `unparsed[]` (px-cap vs sprite-cap держатся как ДВА различных reason-а через
  discriminated `hashAtlasFrames` результат) вместо тихого исчезновения; `unparsed.sort()` поднят
  ПОСЛЕ обоих push-циклов, так что порядок детерминирован. **Нет `BitmapBudget` LRU-инстанса в analyze-воркере** — его
  декодированные битмапы уже `close()`-ятся eagerly (нет много-живого working-set-а, в отличие от FIX-воркера), так что LRU
  здесь был бы dead-кодом; честное, no-fork переиспользование `bitmap-budget.ts` это его px-cap ПОЛИТИЧЕСКАЯ половина (
  задокументированная working-set граница, Инв 5 — никогда VRAM/saving число). ЧЕСТНОСТЬ (Инв 3/5): пере-читанные байты
  байт-идентичны оригиналу ⇒ идентичные finding-и/report/overlay; cap-значение неизменно ⇒ те же
  страницы сканируются ⇒ без дрейфа измеренного числа. АДДИТИВНОСТЬ: под cap-ом ничего не пропускается и нет `unparsed`
  записи; legacy `PickedFile` (без `file`) всё ещё клонирует. Инв 1: transfer intra-process, re-read
  локальный диск — ноль сети. Инв 4: transfer дешевле клона, а re-read-ы ленивые (selected/probed/fix)
  ⇒ вне ≤10с критического пути. Тесты: расширен `bitmap-budget.test.ts` (cap-предикат граница/degenerate,
  `scanSkipReason` детерминизм, drift-guard `perceptual.FRAME_HASH_MAX_PX === ANALYZE_PAGE_MAX_PX`); новый
  чистый `source-bytes.test.ts` (точные байты, null-on-missing-file, null-on-reject, dir-aware ключи, ленивость); новый
  `analyze-transfer-skip.test.ts` (runAnalysis постит непустой transfer-list когда у всех файлов есть `file`, пустой
  когда у одного его нет; whole-page skip-маппинг воркера срабатывает ВЫБОРОЧНО, всплывает два различных reason-а,
  и сортирует детерминированно).
  **Gate:** `pnpm typecheck` + `pnpm test` + `pnpm lint`.

## Раунд 20 — отбор (#0 отгружено) — 2026-06-29
Pick: **(#0) trim-on-repack ФИКС** (отгружен ниже) — превращает r19 trim-margin ДЕТЕКТОР в Pro-фикс.

- **#0 trim-on-repack ФИКС** (`docs/improvements/round20-trim-on-repack-fix-auto-trim-untri.md`) — когда repack
  запускается, каждый UNtrimmed-спрайт, несущий reclaimable transparent-padding, теперь подтягивается к своим opaque-границам.
  Едет на СУЩЕСТВУЮЩЕМ repack-op-е (free-rider граница — occupancy/frame-redundancy/merge-scheduled repack-и тоже
  trim-ят; нет отдельного trim-margin→repack scheduling в v1). `repackAtlases` получил `RepackOptions.trim?`
  (per-atlas, index-aligned frame-relative bbox-ы из `alphaBBox`) + `trimAsSpineOffset?`: shrinkable untrimmed-
  спрайт упакован при БОЛЕЕ ТЕСНОМ `{bbox.w,bbox.h}`, Blit читает INSET source sub-region, а
  эмитированный Sprite несёт `trimmed:true` + `sourceSize`(full) + `spriteSourceSize`/offset (TP top-left или
  Spine bottom-left Y-flip через `spineOffsetFrom`) — корректный НЕ-деструктивный shrink (рендерится идентично
  in-engine с меньшего шита). Три скептик-BLOCKER-а свёрнуты: **B1** нет `minMarginPx` gate в фиксе
  (trimming любого shrinkable-спрайта всегда корректен) и чек сообщает ИЗМЕРЕННЫЙ reclaim («reclaimed N
  px»), никогда «up to» обещание детектора; **B2** UNtrimmed АЛИАС trimmed-представителя НАСЛЕДУЕТ
  trim rep-а (байт-идентичные пиксели ⇒ тот же bbox) — эмиссия tight-rect-а с алиасом всё ещё помеченным untrimmed
  была бы СЛОМАННЫМ манифестом; **B3** no-gutter `extrudeVramDelta` baseline repack-вызовы (Spine + rect/merge)
  получают ИДЕНТИЧНЫЙ trim, так что delta изолирует ТОЛЬКО gutter (иначе знак переворачивается). Worker `buildTrimArrays`
  декодирует каждую atlas-page однажды (LRU-cached/pinned) и вычисляет bbox per untrimmed-фрейм через ТОТ ЖЕ чистый
  `alphaBBox`, что использует analyze-проход; подано во все 5 `repackAtlases` вызовов. Новые `RepackResult.trimmedSprites`/
  `trimmedAreaReclaimed` + поля `FixReceipt` + receipt-строка App + `fix.trimmedOnRepack` i18n ×9 (зеркалит
  `framesAliased`). Аддитивно: нет shrinkable untrimmed-спрайта / trim отсутствует ⇒ байт-в-байт. Тесты: чистый
  `fix.test.ts` (TP tighter-pack + эмитированная метаданная, Spine Y-flip, B2 alias-inherits-trim, null/full/already-
  trimmed дословно, additivity pin, fixture golden) + E2E `perceptual.test.ts` (decode→alphaBBox→repack реализует
  дефект: reclaimed ≥ recoverableArea, точный per-sprite packedSize===bbox, parser+pixel round-trip) + worker
  control-flow `trim-on-repack-worker.test.ts`; фикстура `untrimmed-padding/expected.json` расширена
  аддитивным `repack` golden-ом. Gate: typecheck + test + lint зелёные.

- **#1 prebuilt-atlas passthrough-транскод — закрывает баг DANGLING-REFERENCE**
  (`docs/improvements/round20-prebuilt-atlas-passthrough-transco.md`) — `analyze.ts` размеряет ATLAS-страницы тоже
  (`addFormat(atlas.name, image)`), так что ХОРОШО-УПАКОВАННЫЙ (high-occupancy) + корректно-размеренный (POT, не oversize)
  prebuilt-шит, чья страница транскодируется меньше, зарабатывает `format` finding на своей СТРАНИЦЕ → standalone `transcode`
  op БЕЗ repack/resize. Старый worker трактовал тот op как LOOSE-изображение: он переименовывал `sheet.png` →
  `sheet.webp`, но НИКОГДА не репойнтил sidecar — `sheet.json` `meta.image` / Spine `.atlas` texture-строка
  всё ещё говорили `sheet.png` ⇒ лоадер резолвил файл, который больше не существует (**dangling reference / сломанный
  drop-in**). НОВАЯ atlas-aware ветка в `fix.worker.ts` (после profile-fanout блока; loose-путь теперь
  достигается ТОЛЬКО для non-atlas ref-ов): пере-кодировать существующую страницу ДОСЛОВНО (без recompose — frame/trim/pivot/mesh
  нетронуты), репойнтить `meta.image` sidecar-а (TP) / Spine texture-строку на новую страницу через новый ЧИСТЫЙ
  `repointAtlasImage` (`packages/fix/src/atlas-transcode.ts`, проверенный `relativeImageRef` inverse → резолвит
  обратно через `@asset-doctor/parsers`), пере-эмитить sidecar детерминированно, и СБРОСИТЬ старую страницу
  (`replaced.add`). Скептик-блокеры свёрнуты: **B1** KTX2-кандидат записывается ТОЛЬКО для TexturePacker
  (post-pass хардкодит `.json`→`.ktx2.json` + `emitTexturePackerJson`, так что Spine `.atlas` отгрузил бы
  малформ `.ktx2.json`); **B2** общий size-loss guard (`enc >= src` ПЛЮС opaque `transcodeIsSizeLoss`
  паритет) ДЕРЖИТ оригинальную страницу + оригинальный sidecar когда пере-кодировка не меньше — фикс, который чинит
  dangling-ref-ы, никогда не СОЗДАЁТ один отгружая худшую страницу; **M1** `recordVariant`/`repackChanges`/
  `referencesChanged` срабатывают БЕЗУСЛОВНО (transcode ВСЕГДА переименовывает страницу по расширению — НЕ
  `hashOn`-гейтнутый stable-name drop-in, что использует resize-atlas); **M3** транскодированная atlas-страница, которая retained dedup-
  OWNER, обновляет `ownerActualName`/`ownerActualUnhashed`, так что Phase-C репойнтит CONSUMER-ы на реальную страницу. Fail-safe
  честные пропуски: missing sidecar, multi-page Spine (`emitSpineAtlasText` пишет ОДНУ страницу), encode-unavailable.
  ЧЕСТНОСТЬ (инвариант 5): идентичные pixel-dims ⇒ идентичный RGBA8888 VRAM ⇒ НЕТ `vramSaved` инкремента (disk-only).
  Dry-run preview обновлён предсказывать `referencesChanged` для atlas-транскода (совпадает с execute). АДДИТИВНОСТЬ:
  off / no-atlas-target ⇒ байт-в-байт (loose-путь нетронут; non-atlas ref никогда не входит в блок).
  Тесты: чистый `packages/fix/test/atlas-transcode.test.ts` (TP/Spine repoint round-trip через `parseAtlasManifest`
  / `parseSpineAtlasText` + `resolveImageRef` вкл. same-dir / cross-dir / cache-busted; no-dangling-ref
  membership; frame-verbatim) + worker-seam `apps/web/test/atlas-transcode-worker.test.ts` (Harness A: реальный
  analyze→plan путь даёт ровно один transcode-op на atlas-странице без repack/resize; Harness B: emit→
  parse→resolve не оставляет dangling-ref; Harness C: B2 size-loss / multi-page Spine / sidecar-unavailable / B1
  Spine-no-KTX2 / M3 dedup-owner decision-предикаты; аддитивность: loose-transcode не эмитит sidecar). Gate:
  typecheck + test + lint зелёные.

- **#2 закрыть dynamic-key слепые зоны i18n-app-keys guard-а** (test-only hardening,
  `docs/improvements/round20-close-the-i18n-app-keys-guard-s-dy.md`) — guard `apps/web/test/i18n-app-keys.test.ts`
  сканировал только `App.tsx + FilmViewer + VerdictBar + TriageLedger` и раскрывал только
  `fix.pack.{mode,grouping}.*` + `triage.{filter,sort,scope}.*` dynamic-шаблоны, так что **четыре** других
  класса `t(`prefix.${…}`)` рендерили raw dotted-ключи на будущем rename, не обнаруженные catalog-drift тестом:
  `severity.${f.severity}` (App.tsx + ранее-несканированный Findings.tsx), `license.err.${…}` (несканированный
  LicensePanel.tsx), и `fix.lazy.${s}` + `fix.op.${…}` (оба УЖЕ внутри сканированного App.tsx но без
  expansion-ветки). ТЕПЕРЬ: Findings.tsx + LicensePanel.tsx добавлены в `appSrc`; четыре новых `expandedDynamicKeys`
  ветки — `fix.op.*` import-backed живым `OP_KIND_ORDER` verb-set-ом (+`'other'` UI-bucket), так что он
  само-поддерживается, `severity.*`/`license.err.*`/`fix.lazy.*` зеркалят type-only union / private `KNOWN_CODES` Set,
  каждая pinned per-class drift-guard `it()` блоком, утверждающим что каждый суффикс резолвится в `CATALOGS.en`. Все
  упомянутые ключи уже существуют в en (и во всех 9 локалях) ⇒ чистое regression-hardening, БЕЗ изменения каталога, БЕЗ изменения
  поведения app-а; guard теперь красный на любом будущем rename этих ключей. Gate: typecheck + test + lint зелёные.

---

## Раунд 19 — отбор (3 pick-а; #0 отгружено) — 2026-06-29
Pick-и: **(a) frame-redundancy ФИКС** (отгружен, #0 ниже); **(b) fix-worker memory bounds**; **(c) trim-margin
детектор**. Дизайны для (b)/(c) в ожидании.

- **#0 frame-redundancy ФИКС** (`docs/improvements/round19-frame-redundancy-fix.md`) — превращает r18-детектор
  в Pro-фикс: алиасит N байт-идентичных animation-фреймов внутри атласа на ОДИН упакованный регион в repack-е
  (один Blit на представителя; каждое оригинальное имя всё ещё резолвится через манифест), точный VRAM before→after
  (без оценки), drop-in по построению. Вердикт ревью от собственного скептика дизайна: **SALVAGEABLE +
  BLOCKER B1 fixed** — frame-redundant атлас обычно ПОЛНОСТЬЮ упакован (его дубли заполняют шит ⇒ нет
  occupancy/wasted finding-а ⇒ нет repack сегодня), так что сам FINDING теперь эмитит СОБСТВЕННЫЙ `repack` op (переиспользует
  `repack` OpKind ⇒ tally/manifest/selective-fix/receipt неизменны), а WORKER пре-хэширует квалифицирующиеся merged
  atlas-страницы ПЕРЕД `analyze()` (один decode/квалифицирующуюся страницу, ≥minDuplicates pre-filter, уважает cancel), так что
  finding фактически срабатывает. `repackAtlases` получил опциональный `aliasMaps` arg: упаковывает ОДНОГО представителя на
  байт-идентичный кластер, эмитит Sprite для каждого alias-имени на общем rect-е, копируя СОБСТВЕННЫЕ алиаса
  trim/pivot/sourceSize, с DUAL occupancy-аккумулятором (source=все спрайты до, packed=rep-ы после).
  Чистый `packages/fix/src/alias.ts` зеркалит distinct-rect guard детектора байт-в-байт (pre-aliased rect-ы
  никогда не double-count-ятся; `aliasedFrames` === `dupes` finding-а). Новый `FixOptions.frameRedundancy`
  (default ON) + App toggle + `PlanOptions.frameRedundancy` + `RepackResult.aliasedFrames` +
  `FixReceipt.framesAliased` + receipt-строка + i18n ×9. Аддитивно: absent/false ⇒ нет хэширования, нет нового op-а, нет
  алиасинга ⇒ байт-в-байт. Тесты: чистый `alias.test.ts` (8) + end-to-end на полностью-упакованной
  `frame-redundant` фикстуре (B1 op срабатывает, все 8 имён резолвятся, 4 idle делят один rect, точный VRAM, honesty pin
  `aliasedFrames === dupes`) + synthetic POT-tier VRAM-drop доказательство. Gate: typecheck + test (388 fix) + lint зелёные.

- **#1 fix-worker memory bounds** (`docs/improvements/round19-fix-worker-memory-bounds.md`) — ограничивает
  decoded-source resident-set fix-воркера, так что multi-dozen-page Pro-фикс не может навалить сотни МБ декодированных
  ImageBitmap-ов resident и OOM-нуть вкладку (худший сбой на ПЛАТНОМ пути: старый `bmpCache` в `bitmapOf`
  никогда не `.close()`-ил/evict-ил/drain-ил, держа каждый decode весь run). Новая ЧИСТАЯ Node-тестируемая политика
  `apps/web/src/lib/bitmap-budget.ts`: `BitmapBudget<Closeable>` — LRU ключуемый по ref, ограниченный
  задокументированным byte-budget-ом (`BITMAP_BUDGET_BYTES` = 256 MB ≈ 16 полных 2048² RGBA-страниц, Σ w·h·4), с
  close-callback-ом, `pin`/`unpinAll` set-ом для source-ref-ов in-flight op-а (LRU НИКОГДА не evict-ит pinned-
  битмап), и `drain()`, который close()-ит + очищает всё. Over-budget insert close()+evict-ит UNPINNED LRU-
  запись (≠ только-что-вставленный ref) пока не под budget-ом ИЛИ остаются только pinned/this (одна страница > 
  всего budget-а admit-ится; all-pinned-over-budget толерируется — корректность над границей, всплывает через
  `peakCount`). Worker-wiring: `bitmapOf` маршрутизирует через него; `bmpBudget` поднят в верх `runFix`, а
  всё тело обёрнуто в `try { … } finally { bmpBudget?.drain() }`, так что finished/superseded run (вкл.
  каждый round18 cancel `return` и брошенную ошибку) освобождает native-память немедленно (компонует с
  abortable-workers cancel-путём; plan-mode / pre-decode cancel ⇒ `bmpBudget` undefined ⇒ drain no-op). 
  `teardownPrevOp()` в ВЕРХУ каждой `plan.ops` итерации (и однажды после) unpin-ит + дропает предыдущего op-а
  per-op `maskCache`/`meshCache`/`trimCache` записи — ОДНО место, что срабатывает независимо от 20+ `continue` exit-ов
  тела. `pin(srcRefs)` рано в merge/polygon (group-атласы) + pack (`group.regions`)
  ветках останавливает re-decode storm внутри одного multi-source op-а. Опциональная описательная receipt-заметка
  `FixReceipt.decodeWorkingSet { decodedPages, budgetBytes }` (гейтнута на `peakCount > 0`; НИКОГДА VRAM/saving
  число — инвариант 5). КОРРЕКТНОСТЬ: miss пере-декодирует безопасно из whole-run-retained `bytesByRef` (
  ошибочно-evict-нутая запись стоит CPU, никогда неверный пиксель); LRU никогда не evict-ит ref, который текущий op ещё нужен.
  АДДИТИВНОСТЬ: под byte-budget-ом ничего не evict-ится ⇒ тот же decode-set + порядок ⇒ вывод байт-в-байт к прежнему.
  ДЕТЕРМИНИЗМ: eviction только освобождает память (recency = call-order, ties по Map-insertion order). Тесты: ЧИСТЫЙ
  headless `apps/web/src/lib/bitmap-budget.test.ts` (13) — eviction-over-budget + close-fires +
  nothing-under-budget + recency-refresh + never-evict-the-pinned-ref (+ unpin делает его evictable, all-pinned
  толерируется) + single-oversized-admitted + drain-closes-once/idempotent + replace-frees-stale + peakCount +
  детерминизм. Аддитивно: под budget-ом ⇒ байт-в-байт. Gate: typecheck + test (web 389) + lint зелёные.

- **#2 per-atlas trim-margin детектор** (`docs/improvements/round19-trim-margin-detector.md`) — DETECTION-only
  сиблинг r18 frame-redundancy детектора: для каждого спрайта НЕ уже trimmed (нет `spriteSourceSize` —
  его `frame` ЕСТЬ полное untrimmed изображение), ИЗМЕРЬ transparent-margin, который он несёт (frame area − opaque
  alpha bbox area), и сообщи суммированную recoverable area × 4 как ТОЧНЫЙ VRAM (atlas-пространство, что padding пинит,
  которое trimmed-repack возвращает), плюс area-пропорциональную DISK-оценку (инвариант 5 — несётся отдельно,
  НИКОГДА не свёрнута в `potentialDiskSaved`), и ОДНУ `transparent` (жёлтую) overlay-зону per-side border-
  полосок в atlas-px. INSTANT-WOW: worker вычисляет каждый opaque-bbox через чистый `alphaBBox`
  (`@asset-doctor/fix`) с ТОЙ ЖЕ уже-декодированной страницы, что читает frame-redundancy проход — `hashAtlasFrames`
  теперь возвращает `{ hashes, bboxes }` из ОДНОГО decode-а, так что trim-фича добавляет НОЛЬ лишнего decode-а и переиспользует
  ТЕ ЖЕ px/sprite кэпы. ЧЕСТНОСТЬ: gate на `Sprite.trimmed === false` (конъюнкт `&& spriteSourceSize === undefined`
  оставлен только как задокументированный redundant-by-parser-construction guard); пропускать уже-trimmed-спрайты;
  distinct-rect alias guard считает общие packed-rect-ы однажды; `null` bbox на untrimmed-спрайте =
  полностью-transparent фрейм (весь фрейм recoverable). Rotation-инвариантно (area + per-side margin читается над
  размещённым регионом; полоски рисуются в placed-page пространстве). Новый core `AtlasFrameTrims` contract + `'trim-margin'`
  Rule + `trimMargin` ThresholdConfig (`{minMarginPx:4, minRecoverablePct:0.05}`, browser-only — НЕ в
  resolveThresholds); `trimMarginFinding` пробрасывается в `analyze()` как `frameHashes` (absent ⇒ байт-в-байт
  ⇒ CLI/headless не затронуты). i18n ×9 (текст говорит «reclaims **up to**» — uniform-cell padding иногда
  намеренный) + render-drift guard. Golden-фикстура `untrimmed-padding/` (textured-ядра в transparent-
  margin-ах, один уже-trimmed спрайт, который детектор пропускает) через генератор. Тесты: analysis-unit + golden
  (skip-trimmed, null-bbox whole-frame, alias-once, below-floor/thin-margin/length-mismatch/no-config ⇒ null,
  disk-not-folded) + web e2e (fixture PNG → реальный `alphaBBox` → правило). Gate: typecheck + test + lint зелёные.

## Раунд 18 — robustness + moat + analysis depth — 2026-06-29
- `4870cc1` **Abortable workers** — `AbortSignal` seam через analyze + fix воркеры + клиенты; кооперативный cancel-флаг; superseded-drop абортит предыдущий run. Аддитивно (нет signal ⇒ байт-в-байт). Review SHIP.
- `1c6902d` **correlateFix(receipt)** — измеренная before→after fix-проба → один локализованный doctor-вердикт (переиспользует `CorrelatedFinding` + variant-suffixed i18n; measured-only, честно). Review SHIP.
- `c3950ae` **frame-redundancy детектор** — дублирующие фреймы внутри атласа (per-region SHA, instant-wow кэпы + flat-guard; точная VRAM-area трата). Review FIX_THEN_SHIP — оба MAJOR-а фикснуты (фикстура теперь воспроизводит дефект через реальный flat-guarded путь; worker decode-путь протестирован).

## Раунд 17 — moat / parity / honesty — 2026-06-28
- `3be0d6a` **render-probe произведённого фикса** — измеренные before→after draw calls + decoded VRAM per sheet (3-й probe-сиблинг); честный badge держится отдельно от статических чисел. Review SHIP.
- `01e5950` **per-image measured best-format pick** — нести measured smallest-encode победителя диагностики в fix-план (default OFF; precedence profile>override>bestMime>global). Review FIX_THEN_SHIP — MAJOR фикснут (dedup owner-name prediction уважает per-op mime).
- `bb2fd38` **opaque fan-out size-loss guard** — никогда не отгружать большую same-format opaque страницу. Review SHIP (ноль finding-ов).

## Раунд 16 — консолидация (round-15 MINOR-ы) — 2026-06-28
- `2fe9828` — honesty double-count de-overlap (`potentialDiskSaved` MAX не SUM для format+wasted-alpha ref-ов); keep-original-on-size-loss guard для opaque-транскода; `ktx2-probe-collect` извлечён+протестирован; gl-instrument 9-arg форма; loader-текст смягчён ×9. Review SHIP.

## Раунд 15 — отбор (3 pick-а) — 2026-06-28
- `b297290` **измерить РЕАЛЬНЫЙ KTX2 GPU VRAM on-device** — `compressedTexImage2D` instrument + `probeKtx2` + self-hosted transcoder (без CDN); показан рядом с worst-case ceiling-ом, device-local. Review FIX_THEN_SHIP.
- `84b8ea7` **KTX2 loader-migration сниппет** — эмитить `import 'pixi.js/ktx2'` когда фикс произвёл `.ktx2` (чинит баг manifest-refs-`.ktx2`-but-loader-can't-decode; Phaser честная NOTE). Review SHIP.
- `21710a0` **wasted-alpha детектор + opaque-encode фикс** — full-frame opaque проход (short-circuit/size-capped/worker = instant-wow safe); disk-only saving, никогда VRAM. Review SHIP.

## Раунд 14 — консолидация (round-11→13 MINOR-ы) — 2026-06-28
- `b5c1405` — i18n-app-keys guard расширен на новые компоненты; highlightId debounced; общий `defaultSelectOpts`; `countCandidates` (без per-keystroke re-sort); consent upload count/preview; авто-пара Pixi-манифеста когда backend-op включён; gateway на одну body-копию меньше; подавить пустую all-quality-floor запись. Review SHIP.

## Раунд 13 — native→backend #2 — 2026-06-28
- `a872dd0` **pngquant lossy-PNG** disk-only op на sidecar-е (browser-impossible); нулевое VRAM-поле (декодирует в RGBA); quality-floor decline kept-not-failed; Op проброшен; `backendNative` массив; PNG dup-key split. Review FIX_THEN_SHIP (MAJOR фикснут: честный skip на tiered-пути).

## Раунд 12 — native→backend #1 (поправка инварианта 1/2) — 2026-06-28
- `25f7af0` **KTX2 GPU-texture sidecar** (`apps/encoder`, Go toktx) через `apps/api` entitlement-gated reverse proxy; opt-in, default OFF, явный upload consent; честный VRAM ceiling; two-json-sidecar манифест; инварианты CLAUDE.md 1&2 поправлены. Review FIX_THEN_SHIP (2 MAJOR-а фикснуты: manifest order + worker/client test coverage). Go: apps/api + apps/encoder build/vet/test зелёные.

## Раунд 11 — UI/UX — 2026-06-28
- `6c17ffd` **triage-first масштабируемый results view** — чистый `triage.ts` (O(assets+findings) индекс, убивает per-render O(N×F) скан) + zero-dep виртуализация; VerdictBar + virtualized TriageLedger (search/sort/filter/group, честные rollup-ы) заменяющий chip-wall; sticky film-detail с debounced decode; схлопнута двойная ArrayBuffer-копия. Чинит many-images хаос. Review FIX_THEN_SHIP (MAJOR фикснут: show-clean эмитит реальные clean-строки).

## Раунд 10 — паритет asset-builder — 2026-06-28
- `8af0247` **per-folder/prefix export overrides** — `ExportProfile.overrides[]` (exact-or-prefix match) накладывает formats/quality/lossless/AVIF-4:4:4 (fonts→4:4:4); чистый `resolveProfileForRef`; default OFF ⇒ байт-в-байт. Review SHIP.

## Раунд 9 — AssetPack-дуга — 2026-06-28
- `8c478d4` **content-hash cache-busting** (`hashFilenames`) — 8-hex content-hash сцеплен через atlas `meta.image`, Spine `.atlas` строку, Pixi-манифест, dedup consumer-изображения, loader-строки. Скептик поймал 3 блокера + 4 мажора pre-code; ревьюер поймал ещё 1 (dedup→loose-owner 404) — все фикснуты.

## Раунд 8 — AssetPack-дуга — 2026-06-28
- `0727449` **эмиттер PixiJS manifest.json** — реальные v8 `{bundles}` (одна alias-suffixed запись per tier; sheets→sidecar; без сфабрикованного `data.resolution`); делает variant fan-out загружаемым одним `Assets.init`. Review SHIP.

## Раунд 7 — паритет asset-builder / AssetPack-дуга — 2026-06-28
- `f3b3cc9` **config-driven export profile** — произвольные resolutions × formats × per-format compression, заменяющий фиксированную 3-tier лестницу; first-class format fan-out; lossless по-настоящему проброшен. Скептик поймал 3 реальных дефекта pre-code. Review FIX_THEN_SHIP.

## Связка backend ↔ frontend — 2026-06-28
- `e59916d` — связан React-app с Go license-бэкендом (`:8088`): `.env.local` (gitignored) + `apps/api/tools/devmint` (dev-license) + `tools/verify/license-connect-run.mjs` (доказывает activate→sign→offline-verify против живого бэкенда). LICENSE_CONNECT PASS.

## Раунд 6 + fss-фикс — 2026-06-28
- `7eca731` **Round 6** — F1 before/after FilmViewer sheet-diff (визуальное доказательство), F2 solid-fill детектор, F3 surface-unparsed-files + parser hardening.
- `7499fb7` **fss-баг** — упаковывать ВСЕ spine-регионы (не ронять большие через статический `maxSpriteEdgePx` фильтр).

## Более ранние раунды (раунды 2–5, та же ветка) — 2026-06-26/27
- `e09c539` engine-aware loader-migration guide · `bd3d8e0` zip UTF-8 флаг + occupancy clamp · `fb7fbc7` content-class format-suitability · `411b9de` per-texture VRAM/probe breakdown · `8074226` polygon-pack content-extent trim (без пустого низа) · `9411b44` probe-into-verdict (measured GPU footprint) · `a5f7864` selective fix · `ae51c15` atlas fragmentation score · `e9d18ca` dry-run plan preview · `416828f` edge-extrude (bleed).
- (Pre-branch фундаменты — Phase 1 diagnosis, render-probe, runtime profiler, MV3 extension, correlate, CLI + budget-gate, i18n, Phase-2 browser fix, polygon packer, Part B dedup, scale-tiers, Slice B Go billing — см. `docs/` + git-историю.)
