# Asset Doctor — CLAUDE.md

**Что это.** Браузерный аудит ассетов для HTML5-игр (PixiJS/Phaser). Загрузил папку
→ за ≤10с видишь карту проблем (пустота в атласах, неоптимальные форматы, оверсайз,
лишний VRAM/draw calls) и сколько веса срезать. Phase 2 — платный фикс
(перепаковка/транскодинг). Прямых конкурентов нет; моат — глубина рендер-пайплайна
и render-probe (реальная загрузка ассета в offscreen-WebGL, замер фактического футпринта).

## 5 инвариантов (не нарушать без согласования)
1. Тяжёлое — в браузере, лёгкое — на сервере. Ассеты не покидают устройство (приватность + ноль костов).
2. Бэкенд тонкий: только auth/биллинг(Stripe)/история-метрик/лицензии. Без тяжёлой обработки картинок.
3. Объективность: только измеряем и выдаём вердикты по порогам, ничего не генерируем.
4. Instant wow: первый ценный результат ≤10с после drag-drop, без регистрации.
5. Вес на диске ≠ нагрузка на GPU. PNG 2048² = 16 МБ VRAM (w×h×4), +33% с мипмапами. Мы это показываем.

## Стек
TS · React · Vite · PixiJS v8 (render-probe/WebGL) · Web Workers (анализ вне main-thread)
· WASM-кодеки (libwebp — позже) · File System Access API (+фолбэк webkitdirectory) · Tailwind v4.
Тесты: Vitest (ядро) · Playwright (e2e, позже). ESLint/Prettier.
Бэкенд (Phase 2): Go или NestJS — решение фиксируем перед Phase 2.

## Раскладка монорепо (pnpm workspaces)
`apps/{web,extension,cli}` · `apps/api`(P2-биллинг, Go, позже) · `packages/{core,parsers,ingest,analysis,probe,correlate,budget,i18n,fix}`
· `action.yml`(composite GH Action) · `fixtures/sample-projects` + `fixtures/budgets`
- `core` — общие TS-контракты (atlas + analysis модель). **Единственный источник правды**, без дрейфа.
- `parsers` — TexturePacker JSON (Hash/Array) + Pixi + одиночные + Spine `.atlas` → норм. `Atlas`-модель. Pure, worker-safe.
- `ingest` — группировка файлов (manifest/spine + image, dir-aware) → `Asset`. Pure; web и extension реюзают.
- `analysis` — occupancy · wasted-regions (грид) · format-audit (canvas→webp) · dimensions (NPOT/oversize)
  · folder-rules (dup-exact/similar, should-atlas, atlas-merge, integrity) · variants/VRAM. **Пороги — в конфиге.**
- `probe` — render-probe + рантайм-профайлер (draw calls/VRAM из offscreen/live Pixi). `correlate` — линтер→доктор (static×runtime).
- `budget` — Phase-3 чистое ядро гейта: metric-registry, JSON-конфиг (fail-closed), evaluate, serialize (json/sarif/summary). `apps/cli` — тонкий bin `asset-doctor`.
- `i18n` — zero-dep локализация (Intl.PluralRules/NumberFormat), общий каталог для web+extension. Findings несут `messageKey`+`params`; en — источник (drift-тест воспроизводит baked); CLI остаётся EN. **9 языков:** en/ru/de/es/pt/fr/it/zh/hi.
- `fix` — **Phase 2 платный фикс (PURE половина):** MaxRects-упаковка (`pack.ts`), геометрия-репак (`repack.ts`, недеструктивно), детерминированный TexturePacker-манифест (`manifest.ts`), findings→FixPlan (`plan.ts`). Грязная половина — `apps/web/src/worker/fix.worker.ts` (crop→pack→compose→encode→zip) + `zip.ts` (свой store-only zip, zero-dep). Транскод: нативный WebP/PNG + AVIF через lazy `@jsquash/avif`. Кнопка Pro → скачать оптимизированную папку. **Без монетизации пока** (Go-биллинг = Slice B позже).

## Фаза
**Phase 1 (диагноз) — готов и задеплоен** (https://nonamezzz322.github.io/asset-doctor/, GH Pages). Полный
клиентский срез (ноль сети): parsers+ingest+analysis, Web Worker, film-viewer; AVIF + whole-folder + Spine;
пороги откалиброваны на реальном слот-гейме. Render-probe **GO**. Поверх: рантайм-профайлер + MV3-расширение
(моат замкнут в странице: live-рантайм + загрузка папки → корреляция в оверлее) + слой `correlate`.
**Phase 3 (CLI + GitHub Action budget-gate) — реализован**: `asset-doctor audit|budget|init` реюзает ядро в
Node (assets не покидают машину), VRAM=Σw×h×4, exact-dup через node:crypto; JSON-конфиг fail-closed на
browser-only метрики; composite `action.yml` с before/after через git worktree. Verified: 88 тестов + live CLI.
**Дальше:** Phase 2 (платный фикс: MaxRects-репак + транскод + Stripe + Go/Nest бэкенд — решить перед стартом).

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
CLI (Phase 3): `pnpm --filter @asset-doctor/cli build` → `node apps/cli/dist/cli.js audit|budget|init <dir>`
(exit: 0 pass/advisory · 1 over-budget · 2 config/fail-closed · 3 input · 4 internal).

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
