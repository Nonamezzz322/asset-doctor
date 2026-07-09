# Asset Doctor — CLAUDE.md

**Что это.** Браузерный аудит ассетов для HTML5-игр (PixiJS/Phaser). Загрузил папку
→ за ≤10с видишь карту проблем (пустота в атласах, неоптимальные форматы, оверсайз,
лишний VRAM/draw calls) и сколько веса срезать. Phase 2 — платный фикс
(перепаковка/транскодинг). Прямых конкурентов нет; моат — глубина рендер-пайплайна
и render-probe (реальная загрузка ассета в offscreen-WebGL, замер фактического футпринта).

## 5 инвариантов (не нарушать без согласования)
1. Тяжёлое — в браузере, лёгкое — на сервере. Ассеты не покидают устройство (приватность + ноль костов).
   **Ограниченное исключение (round12):** браузер — дефолт; нативные-only операции (напр. KTX2-энкодинг) МОГУТ выполняться на opt-in бэкенде. Ассеты покидают устройство ТОЛЬКО при явном per-run согласии пользователя ("эти картинки отправляются на сервер"); по умолчанию OFF ⇒ путь мёртв ⇒ полностью локально.
2. Бэкенд тонкий: только auth/биллинг(Stripe)/история-метрик/лицензии. Без тяжёлой обработки картинок.
   **Ограниченное исключение (round12):** нативные-only операции (которые браузер физически не может) вынесены на ОТДЕЛЬНЫЙ opt-in sidecar (`apps/encoder`), проксируемый через `apps/api` (auth/quota/gateway). Биллинг-образ (distroless) остаётся тонким и нетронутым. Браузерный фикс — дефолт; бэкенд — opt-in фолбэк, entitlement-gated, с size/dimension-капами, rate-limit/quota, БЕЗ персистентности и без логирования байт картинок.
3. Объективность: только измеряем и выдаём вердикты по порогам, ничего не генерируем.
4. Instant wow: первый ценный результат ≤10с после drag-drop, без регистрации.
5. Вес на диске ≠ нагрузка на GPU. PNG 2048² = 16 МБ VRAM (w×h×4), +33% с мипмапами. Мы это показываем.

## Стек
TS · React · Vite · PixiJS v8 (render-probe/WebGL) · Web Workers (анализ вне main-thread)
· WASM-кодеки (libwebp — позже) · File System Access API (+фолбэк webkitdirectory) · Tailwind v4.
Тесты: Vitest (ядро) · Playwright (e2e, позже). ESLint/Prettier.
Бэкенд (Slice B): **Go** (chi · pure-Go SQLite `modernc.org/sqlite` · stripe-go · ed25519). Решено и реализовано.

## Раскладка монорепо (pnpm workspaces)
`apps/{web,extension,cli}` · `apps/api`(Slice B: Go thin-биллинг — реализован) · `packages/{core,parsers,ingest,analysis,probe,correlate,budget,i18n,fix}`
· `action.yml`(composite GH Action) · `fixtures/sample-projects` + `fixtures/budgets`
- `core` — общие TS-контракты (atlas + analysis модель). **Единственный источник правды**, без дрейфа.
- `parsers` — TexturePacker JSON (Hash/Array) + Pixi + одиночные + Spine `.atlas` → норм. `Atlas`-модель. Pure, worker-safe.
- `ingest` — группировка файлов (manifest/spine + image, dir-aware) → `Asset`. Pure; web и extension реюзают.
- `analysis` — occupancy · wasted-regions (грид) · format-audit (canvas→webp) · dimensions (NPOT/oversize)
  · folder-rules (dup-exact/similar, should-atlas, atlas-merge, integrity) · variants/VRAM. **Пороги — в конфиге.**
- `probe` — render-probe + рантайм-профайлер (draw calls/VRAM из offscreen/live Pixi). `correlate` — линтер→доктор (static×runtime).
- `budget` — Phase-3 чистое ядро гейта: metric-registry, JSON-конфиг (fail-closed), evaluate, serialize (json/sarif/summary). `apps/cli` — тонкий bin `asset-doctor`.
- `i18n` — zero-dep локализация (Intl.PluralRules/NumberFormat), общий каталог для web+extension. Findings несут `messageKey`+`params`; en — источник (drift-тест воспроизводит baked); CLI остаётся EN. **9 языков:** en/ru/de/es/pt/fr/it/zh/hi.
- `fix` — **Phase 2 платный фикс (PURE половина):** MaxRects-упаковка (`pack.ts`), геометрия-репак (`repack.ts`, недеструктивно), детерминированный TexturePacker-манифест (`manifest.ts`), findings→FixPlan (`plan.ts`) + **бинарный полигональный упаковщик** (`geom`/`mask`/`trace`/`simplify`/`triangulate`/`mesh`/`polygon-pack` + `repackAtlasesPolygon`/`polygonWins`; integer-exact предикаты, детерминированный; conservative mesh ⊆ dilated-footprint; спека `docs/polygon-packer-design.md`). Грязная половина — `apps/web/src/worker/fix.worker.ts` (crop→pack→compose→encode→zip; polygon-mode: extract-alpha→trace→mesh-clip compose) + `zip.ts` (свой store-only zip, zero-dep). Транскод: нативный WebP/PNG + AVIF через lazy `@jsquash/avif`. Кнопка Pro → скачать оптимизированную папку. **Build-config (AB-R5):** save/load экспорт-профиля + global encode-кнобов как версионированный JSON (`apps/web/src/lib/build-config.ts` — `serializeBuildConfig`/`parseBuildConfig` fail-closed через тот же `validateProfile`; `buildProfileFromState` — единый маппинг UI→`ExportProfile`, который зовёт и memo, без дрейфа). Браузер-only, ноль байт ассетов; backend-тогглы и consent НЕ персистятся (consent per-run). **Единый конфиг + страница `#settings`:** все ручки оптимизации вынесены из `FixCard` в ОДИН `BuildSettings` (`apps/web/src/lib/build-settings.ts` — `settingsDefaults()` воспроизводит дефолт байт-в-байт; `buildFixOptions` — вынесенное тело `buildOptions`) на отдельной hash-роут-странице (`route.ts` `viewOfHash`, ссылка «Настройки» в шапке, основное дерево под `hidden`); карточки-секции как у asset-builder (Форматы · Разрешения · Упаковка · Мипмапы · Правила · Вывод · Бэкенд · Конфиг). Конфиг **v2** (`build-config.ts`) — save/load всей поверхности, v1-миграция, backend/consent НЕ сериализуются. **Формат страниц атласа профиль-осознанный** (`packages/fix/sheetTarget.ts` `sheetPageTarget` — чистое решение, воркер зовёт verbatim): repack/merge/pack honor `formats[0]` при профиле ON, иначе legacy-lossless-WebP/legacy-target БЕЗУСЛОВНО (дефолт байт-в-байт); `spinePageFormat` `'png'|'profile'`. Мипмапы честно: растровые форматы НЕ хранят мипы (GPU генерит, +33% VRAM меряет `mipmap-cost`), KTX2-бэкенд печёт настоящие; в UI только копирайт + extrude/KTX2, пиксели не генерируются.
- `apps/api` — **Slice B: Go thin-биллинг** (chi · pure-Go SQLite · stripe-go · ed25519). Эндпоинты: `/v1/stripe/webhook` (sig-verify + идемпотентный mint), `/v1/{activate,refresh,deactivate}` (лимит сидов, kill-switch на refund), `/v1/key?session_id` (доставка ключа без email-провайдера). **Лицензия = опак-ключ (lookup); entitlement = ed25519-токен, верифицируется в браузере ОФЛАЙН** (`apps/web/src/lib/license.ts`, WebCrypto). Кросс-язык-фикстура (`fixtures/license/`) гарантирует байт-контракт Go↔WebCrypto. **Гейт OFF по умолчанию** (`VITE_PRO_GATE`) — фикс бесплатен в бете; деплой Fly.io + Stripe = документирован, секреты у юзера. Тонкий: НИКАКОЙ обработки ассетов (инвариант 1–2). 30 Go-тестов.

## Фаза
**Phase 1 (диагноз) — готов и задеплоен** (https://nonamezzz322.github.io/asset-doctor/, GH Pages). Полный
клиентский срез (ноль сети): parsers+ingest+analysis, Web Worker, film-viewer; AVIF + whole-folder + Spine;
пороги откалиброваны на реальном слот-гейме. Render-probe **GO**. Поверх: рантайм-профайлер + MV3-расширение
(моат замкнут в странице: live-рантайм + загрузка папки → корреляция в оверлее) + слой `correlate`.
**Phase 3 (CLI + GitHub Action budget-gate) — реализован**: `asset-doctor audit|budget|diff|init` реюзает ядро в
Node (assets не покидают машину), VRAM=Σw×h×4, exact-dup через node:crypto; JSON-конфиг fail-closed на
browser-only метрики; composite `action.yml` с before/after через git worktree. Verified: 88 тестов + live CLI.
**Phase 2 (платный фикс) — клиентский движок готов**: MaxRects-репак + resize + транскод (WebP/AVIF) + Spine-репак + [aggressive] merge/dedup + **бинарный полигональный упаковщик** (опц. polygon-mode: трассировка альфы→conservative RDP→earcut→bitmap-mask nesting + mesh-clip compose; TexturePacker-совместимый mesh-манифест `vertices/verticesUV/triangles`; honest VRAM-гейт, иначе rect-fallback; спека `docs/polygon-packer-design.md`), всё в браузере. **Slice B (Go thin-биллинг) — реализован** (`apps/api`): Stripe-вебхук→mint, ed25519-entitlement, офлайн-верификация в вебе, гейт OFF по умолчанию. Не задеплоено (нужны Stripe/Fly секреты юзера).
**Дальше:** включить монетизацию (деплой `apps/api` + Stripe + `VITE_PRO_GATE=true`), когда продукт готов к продаже. Опц.: Litestream-дюрабилити, email-доставка ключа, подписки, история-метрик UI.

## UI — рентген-кабинет
Герой — **film-viewer** (атлас-снимок с подсвеченными аномалиями), НЕ большая цифра экономии.
Токены (в `apps/web/src/index.css`, Tailwind `@theme`): bg #E7ECF1 · panel #FFF · line #DCE3EA
· ink #16202A/#566472 · film #0C1116 · teal #0E8C8C · CTA-green #15A06A.
Severity: crit #E5484D · warn #D98A00 · ok #1F9D63 · info #2B8FC9.
Шрифты: Space Grotesk (display) · IBM Plex Sans (body) · IBM Plex Mono (все числа/метрики/имена файлов).
Оверлеи: пустота — красная заливка+пунктир · прозрачные поля — жёлтый · bleeding — бирюзовый.

## Команды
`pnpm install` · `pnpm dev` (web) · `pnpm build` · `pnpm test` (vitest) · `pnpm typecheck` · `pnpm lint`
· `pnpm format`. pnpm 10 через corepack (Node ≥20.19; pnpm 11 требует Node 22+).
CLI (Phase 3): `pnpm --filter @asset-doctor/cli build` → `node apps/cli/dist/cli.js audit|budget|diff|init <dir>`
(exit: 0 pass/advisory · 1 over-budget/регрессия · 2 config/fail-closed · 3 input · 4 internal).
`diff <before> <after>` — каждый операнд: папка ИЛИ `audit --json`-файл; измеренные дельты метрик +
находки added/resolved/changed по стабильному `Finding.id`; advisory, гейт опционален (`--fail-on-new crit|warn|any`).

## Агенты и скиллы проекта (`.claude/`)
Агенты: `parsers-engineer` · `analysis-engineer` · `probe-engineer` · `film-viewer-engineer`.
Скиллы: `add-analysis-rule` · `make-fixture` · `check-invariants`.

## Конвенции
Маленькие коммиты (1 смысл). Ядро (parsers/analysis) — с тестами на эталонах. Пороги в конфиге.
Согласование ПЕРЕД: выбор либы / структура папок / схема БД / формат данных между пакетами (`core`).
Держи этот файл сжатым; обновляй при смене фазы/milestone и при новых командах/соглашениях.

## Доки
`docs/AGENT_GUIDE.md` — полный founding-бриф (роль, инварианты, режимы ингеста, фазы, задачи).
`docs/SPECIFICATION.md` — полная спека (заглушка, дописать/получить).
`docs/render-probe-decision.md` — вывод спайка render-probe (заполняется в Milestone 1).
