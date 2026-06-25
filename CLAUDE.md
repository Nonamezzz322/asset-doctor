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
`apps/web` · `apps/api`(P2) · `packages/{core,parsers,analysis,probe,fix(P2)}` · `workers/fix-worker`(P2)
· `fixtures/sample-projects`
- `core` — общие TS-контракты (atlas + analysis модель). **Единственный источник правды**, без дрейфа.
- `parsers` — TexturePacker JSON (Hash/Array) + Pixi + одиночные → норм. `Atlas`-модель. Pure, worker-safe.
- `analysis` — occupancy · wasted-regions (грид-карта покрытия) · format-audit (canvas→webp)
  · dimensions (NPOT/oversize). **Пороги — в конфиге.** Тесты на fixtures обязательны.
- `probe` — render-probe POC: draw calls + VRAM (Σ w×h×4) из offscreen Pixi.

## Фаза
Phase 1 (бесплатный диагноз / MVP). **Milestone 0 — готов** (скелет). **Активно: Milestone 1** —
вертикальный срез (локальная папка → реальный диагноз → film-viewer), всё клиентски, ноль сети.
Параллельно: спайк render-probe (go/no-go → `docs/render-probe-decision.md`).

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
