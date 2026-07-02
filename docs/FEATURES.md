# Asset Doctor — каталог возможностей

Браузерный аудит ассетов для HTML5-игр (PixiJS/Phaser) + Pro-движок фикса, с opt-in
нативным бэкендом. Бесплатный диагноз работает на 100% в браузере (ассеты не покидают устройство);
Pro-фикс генерирует оптимизированный вывод; нативные-only операции выполняются на opt-in бэкенде (с согласием).

---

## 1. Диагноз — бесплатный аудит (в браузере, объективно, ≤10s)

- **Импорт целой папки** — File System Access API + фолбэк `webkitdirectory` + drag-drop; dir-aware группировка (manifest/spine + image) в нормализованную модель `Asset`.
- **Парсеры** — TexturePacker JSON (Hash + Array), PixiJS atlas, одиночные PNG/WebP/JPG/AVIF (размеры из заголовка), Spine/libGDX `.atlas` (legacy + modern, multi-page, rotation/trim) и BMFont `.fnt` во **всех трёх сериализациях — TEXT, XML и binary** (байт-в-байт `FntPage[]`; binary — дефолт BMFont.exe/libGDX). Pure и worker-safe.
- **Карта occupancy + wasted-region** — грид-карта покрытия по каждому атласу; подсвечивает пустое пространство (оверлей film-viewer).
- **Аудит размеров** — NPOT (гейт на реальном POT-padding-waste) + oversize (откалиброванный краевой порог).
- **Аудит форматов** — пробует реальный энкод AVIF/WebP и сообщает только об экономии, которую фактически измерил.
- **Content-class** — flat/alpha-арт получает lossless-вердикт (безопасно для инварианта 4, переиспользует дешёвый сэмпл).
- **Честность VRAM** — вес на диске ≠ VRAM: PNG 2048² = 16 MB на GPU (w·h·4), +33% с мипмапами; показывается явно.
- **VRAM с учётом мипмапов** — учёт base + ceiling (`vramBytesMipmapped`).
- **Folder rules** — duplicate-exact (SHA-256), duplicate-similar (dHash, flat-guarded), should-atlas, atlas-merge, integrity (отсутствующее изображение), format-aggregate.
- **Shared-page merge** — атласы, разрешающиеся в одно изображение, объединяются + считаются один раз (убивает фантомный двойной учёт VRAM).
- **Variant-aware VRAM** — кластеризует варианты `name_res[_fmt]`; один логический ассет грузится один раз → `loadedVramBytes` (worst-case tier).
- **Фрагментация атласа** — оценка разброса используемого vs свободного пространства.
- **Детектор сплошной заливки** — одноцветные изображения, держащие VRAM ради одного цвета (переиспользует декодированный сэмпл 9×8).
- **Детектор wasted-alpha** — полностью непрозрачные изображения, несущие альфа-канал (полнокадровый проход на непрозрачность, short-circuit, безопасно для instant-wow); экономия только на диске.
- **Детектор frame-redundancy** — байт-в-байт дубликаты кадров *внутри* атласа (per-region SHA, flat-guarded, instant-wow капы); точная wasted atlas-area/VRAM.
- **Детектор strippable-metadata** — чистый header-only байт-проход (без декода), суммирующий ТОЧНОЕ число вырезаемых вспомогательных байтов (PNG `iCCP/eXIf/tEXt/iTXt/zTXt/tIME`, JPEG `APP1..15`+`COM`, WebP `EXIF/XMP/ICCP`; чанки, влияющие на рендер, исключены); экономия **только на диске** (GPU всё равно декодирует в RGBA8888), MAX-де-оверлап против находок format/wasted-alpha, называет существующий фикс oxipng/re-encode. Консервативная истинная нижняя граница (никогда не завышает).
- **Детектор texture-bleeding** — чистая целочисленная смежность кадров (без декода): помечает пары кадров атласа, упакованные с 0px gutter (общая грань + перпендикулярное перекрытие; угловые касания и rotated/aliased кадры исключены), которые могут давать 1px-швы при linear/mipmap-сэмплинге. Это находка **корректности** БЕЗ экономии (edge-extrude может увеличить лист — инвариант 5), с условной честной оговоркой; зажигает бирюзовый оверлей `bleeding` и указывает на существующий фикс edge-extrude.
- **Детектор declared-vs-real dimension-mismatch** — всегда включённый статический собрат метки render-probe: сравнивает объявленный в манифесте `meta.size` (Spine page `size:`) с РЕАЛЬНЫМ декодированным заголовком пикселей (без декода), за пределами небольшого абсолютного допуска. Direction-aware (real<declared с кадром за реальной гранью = crit; в пределах границ = warn; real>declared = info). Это находка **корректности** БЕЗ оценки — приводит два измерения (declared vs real) и раскрывает, что статическая оценка VRAM считается по объявленному размеру (никогда не заявка на экономию от фикса).
- **Surfacing неразобранных файлов** — файлы, выглядящие как манифест, но не поддающиеся парсингу, показываются честно (никогда не отбрасываются молча) + усиленные парсеры кадров/Spine (отвергают neg/zero/OOB rect; Spine `numsRaw` per-region recovery).

## 2. Render-probe и рантайм-профайлер (moat)

- **Render-probe** — загружает атлас в offscreen PixiJS v8 WebGL, инструментирует GL-контекст и считывает **измеренные** draw calls + VRAM (Σ baseTexture w·h·4).
- **Runtime profiler SDK** — патчит `getContext` + оборачивает RAF; per-frame draw calls, избыточные binds, uploads/shader-compiles (hitches), live textures, VRAM, fps.
- **MV3 Chrome-расширение** — инжектит профайлер в живую игру (MAIN world) + on-page HUD + «load folder & correlate» в оверлее.
- **Слой correlate** — `correlate(static, runtime)` → один вердикт (статическая фрагментация × живые draw calls/binds, резидентность VRAM, upload/shader hitches, избыточный state).
- **Probe-в-вердикт** — диагноз может показать измеренный GPU-футпринт (declared vs measured).
- **Карта per-texture VRAM/probe breakdown**.

## 3. Pro-движок фикса (браузер — генерирует оптимизированный вывод)

- **Atlas repack** — собственный MaxRects/BSSF, smallest-area POT bin, rotation/padding/spill; более плотный лист, переэмитированный манифест (drop-in).
- **Binary polygon packer** — nesting по occupancy через bitmap-mask (trace alpha → conservative RDP → ear-clip → bitmap nesting + mesh-clip compose); TexturePacker-совместимый mesh-манифест (`vertices/verticesUV/triangles`); честный VRAM-гейт, rect-фолбэк; trim по content-extent (без пустого низа).
- **Resize** — даунскейл оверсайз loose-изображений + атласов (кадры clamped); drop-in.
- **Transcode** — WebP/PNG (нативный `convertToBlob`) + AVIF + lossless-WebP + oxipng (через `@jsquash`, честный фолбэк).
- **Spine repack** — более плотный single-page Spine-лист + переэмитированный `.atlas`.
- **Aggressive dedup** — модель owner/consumer (pools/skin, lazy-aware), отбрасывает exact + near-дубликаты, перепривязка ссылок.
- **Edge-extrude (bleed)** — симметричный gutter для устранения bilinear-швов.
- **Per-image выбор измеренного лучшего формата** — переносит в фикс измеренного в диагнозе победителя по наименьшему энкоду.
- **Opaque-encode** — переэнкод wasted-alpha изображений без альфы (только диск; guard keep-original-on-size-loss).
- **Selective fix** — выбор, какие находки фиксить (masked preview).
- **Dry-run превью плана** — увидеть план перед скачиванием.
- **Receipt + per-file манифест изменений** — disk/VRAM before→after, трейл операций, честные предупреждения «references changed».
- **Engine-aware гид по миграции лоадера** — copy-paste сниппеты Pixi/Phaser, когда фикс переписывает вызовы лоадера (включая сниппет KTX2 `import 'pixi.js/ktx2'`).
- **Before/after FilmViewer sheet-diff** — две side-by-side рентген-плёнки на каждый перепакованный лист + оверлей пустого пространства (визуальное доказательство, не экономия).
- **Render-probe произведённого фикса** — измеренные before→after draw calls + декодированный VRAM на лист (3-й собрат probe).
- **correlateFix** — превращает измеренный probe фикса в локализованный вердикт доктора.
- **Собственный zero-dep store-only ZIP** (CRC32, UTF-8 flag, overflow guards). Вывод скачивается как `optimized-folder.zip`.

## 4. AssetPack-дуга / сборщик ассетов — config-driven пайплайн экспорта

> **Сценарий «сырьё → конфиг → готовая папка»** (паритет с asset-builder, всё в браузере): загрузить папку сырых ассетов → настроить профиль (форматы, степени сжатия, качество, **субсемплинг**, уровни скейла с **выбором суффиксов**) → скачать `optimized-folder.zip` ТОЙ ЖЕ структуры с готовыми спрайтшитами / Spine-`.atlas` / Pixi-JSON. Конфиг можно сохранить/загрузить как версионированный JSON.

- **Отдельная страница настроек (`#settings`)** — все ручки оптимизации собраны в ОДИН `BuildSettings` на отдельной hash-роут-странице (ссылка «Настройки» в шапке, результаты анализа переживают переход), карточками-секциями как у asset-builder: Форматы · Разрешения · Упаковка · Мипмапы · Правила · Вывод · Бэкенд · Конфиг. `settingsDefaults()` воспроизводит прежнее поведение байт-в-байт. Конфиг **v2** save/load покрывает всю поверхность (v1-файлы мигрируют); backend-тоглы и per-run consent НЕ сериализуются.
- **Форматы страниц атласа honor профиль** — перепакованные/смерженные/собранные листы теперь кодируются в выбранный формат (webp/avif/quality/субсемплинг), а не жёстко lossless-WebP/PNG; при профиле OFF repack/merge держит lossless-WebP (геометрический lossless-фикс), pack — legacy-таргет ⇒ дефолт байт-в-байт. Spine-страницы: политика `png` (безопасно, дефолт) / `profile` (+честная заметка о рантайм-декоде).
- **Честная секция мипмапов** — растровые PNG/WebP/AVIF физически НЕ хранят мип-уровни (GPU генерит при загрузке, ≈+33% VRAM — это меряет находка `mipmap-cost`); opt-in KTX2-бэкенд печёт настоящие мипы, extrude лечит швы. UI даёт копирайт + существующие ручки, НЕ генерирует пиксели (инвариант 3).
- **Config-driven профиль экспорта** — произвольные разрешения × форматы (png/webp/avif, lossless+lossy) × per-format компрессия (quality/near/effort); + глобальные encode-ручки (effort/scaleAwareQuality/pngRecompressLevel) и **пикер AVIF-субсемплинга (4:4:4/4:2:2/4:2:0)** в UI, с fail-closed валидацией. Заменяет фиксированную 3-tier лестницу. Аддитивно (off ⇒ байт-в-байт).
- **Сохранение структуры папок** — вывод зеркалит входное дерево сквозняком (нетронутые файлы проходят по своему пути; трансформированные меняют только базовое имя/расширение).
- **Принудительный формат на предсобранных атласах** — при single-format профиле КАЖДЫЙ подходящий атлас конвертируется в выбранный формат (а не только заработавшие находку), с keep-original-on-size-loss; больше нет «смешанной» папки.
- **Пользовательские суффиксы уровней скейла** — безопасный charset (буквы/цифры/`_`/`-`, не имя формата); resolution-суффиксы по-прежнему кластеризуются на ре-ингесте, кастомные показываются как отдельные ассеты (консервативно).
- **Импорт/экспорт build-конфига** — сохранить/загрузить весь профиль + глобальные ручки как версионированный JSON; fail-closed через тот же `validateProfile`; backend-тоглы и consent НЕ сохраняются (per-run), без localStorage.
- **Первоклассный аффорданс «Оптимизировать эту папку»** — заголовок + якорь на экране результатов, раскрывающий панель экспорта (обнаруживаемость; instant-wow-диагноз не задет).
- **Per-folder/prefix оверрайды** — матч ассета по пути и оверрайд forматов/quality/lossless/AVIF-4:4:4 (например, `fonts → 4:4:4`); паритет с asset-builder в честном браузерном подмножестве.
- **Per-folder/prefix оверрайды** — матч ассета по пути и оверрайд forматов/quality/lossless/AVIF-4:4:4 (например, `fonts → 4:4:4`); паритет с asset-builder в честном браузерном подмножестве.
- **Multi-resolution scale-tiers** — `_1080p/_720p/_540p` (теперь config-driven) с честным disk-only fan-out.
- **Эмиттер PixiJS manifest.json** — настоящий Pixi v8 `AssetsManifest`, чтобы весь оптимизированный вывод грузился одним `Assets.init({ manifest })` (одна alias-suffixed запись на каждый tier разрешения; листы указывают на сайдкар `.json`/`.atlas`).
- **Content-hash cache-busting** — добавляет content-хеш к эмитируемым именам файлов, прокинутый через atlas `meta.image`, строку Spine `.atlas`, манифест Pixi, dedup-consumer изображения и строки миграции лоадера.
- **Упаковка loose-ассетов в спрайтшиты** — с нуля: статический TexturePacker JSON + корректная композиция Spine `.atlas`, multi-page spill.
- **Multipack round-trip safety** — `meta.related_multi_packs` TexturePacker (связка sibling-`.json`, которую Pixi v8 авто-загружает) проносится дословно через байт-стабильный passthrough/resize re-emit и честно вырезается (со skip-нотой) на каждом пути, переименовывающем siblings (tier-суффиксы, KTX2, content-hashed имена) — так что page-0 мультипака продолжает грузить страницы 1+ вместо их молчаливого отбрасывания.
- **Animation-map round-trip** — top-level карта `animations` спрайтшита (group → упорядоченный список имён кадров = порядок воспроизведения, из которого строится `AnimatedSprite`) проносится дословно (никогда не сортируется) через каждый Pro re-emit; поскольку она ссылается на КЛЮЧИ кадров (не имена файлов), она переживает cache-bust/KTX2 переименования нетронутой и по построению отсутствует при repack/merge (без синтеза). Не даёт фиксу молча сломать анимации.

## 5. UI — рентген-кабинет

- **Film-viewer** — герой: снимок атласа с подсвеченными аномалиями (пустота = красный, прозрачность = жёлтый, bleeding = бирюзовый, duplicate-frame = оттенок на кластер), readout из 4 ячеек VRAM/DISK/SIZE/OCC.
- **Triage-first масштабируемое представление результатов** — сводный VerdictBar (тэлли по severity) + **виртуализированный** TriageLedger (поиск / сортировка по severity·wasted-disk·VRAM·occupancy / только-проблемы / show-clean / group-by-folder с честными declared-only роллапами), заменяющий плоскую стену чипов. Остаётся отзывчивым при 1000+ ассетах; sticky film-деталь с debounced-декодом.
- **Бренд-система** — Space Grotesk / IBM Plex Sans / IBM Plex Mono; палитра severity; учёт reduced-motion.
- **Доступность (a11y)** — единое token-driven кольцо фокуса `:focus-visible` по всему хрому (teal на свету, film-soft на тёмной плёнке; контраст проверен); расшифрованная легенда оверлеев + `role=img`/`aria-label` на canvas-герое (цвет больше не единственный сигнал); `aria-live`-объявления прогресса анализа, готовности результата (instant-wow ≤10s для скринридеров), счётчика и ошибок (`role=alert`) — озвучиваются только числа уже на экране, без VRAM/фейков; **полная клавиатурная навигация по виртуализированному TriageLedger** (`role=listbox` + `aria-activedescendant`, Arrow/Home/End/PageUp/PageDown со scroll-into-window — достижима каждая строка, не только смонтированные ~30, без потери фокуса при размонтировании); **документ-level `<h1>` + монотонная иерархия заголовков** на экране результатов (WCAG 1.3.1); **WCAG AA контраст** вторичного текста (блёклый ink-soft поднят до полного — самый трафиковый honesty-копирайт читаем); **детерминированный прогресс-бар** анализа (`role=progressbar`, reduced-motion-safe — статичная заливка + статичный пунктирный indeterminate). UX-логика вынесена в чистые Node-тестируемые модули (`focus-ring`/`film-legend`/`announce`/`ledger-nav`/`results-heading`/`contrast`/`progress-view`).
- **Адаптивность тоталов** — заголовочные метрики disk vs VRAM (declared/measured, различимы) + saveable показываются и на узких экранах (<768px) через зеркальную `md:hidden` полосу под VerdictBar (раньше все 4 были скрыты `md:flex`), сохраняя пин честности disk≠VRAM на мобильных.
- **i18n** — 9 языков (en/ru/de/es/pt/fr/it/zh/hi); находки локализуются через `messageKey`+params без нарушения объективности; байт-точный drift-guard + 9-locale тесты паритета.

## 6. Нативное → бэкенд (opt-in, по умолчанию OFF, согласие, entitlement-gated)

- **KTX2 GPU-compressed текстуры** — Go-сайдкар `toktx` (`apps/encoder`) энкодит `.ktx2` (UASTC + zstd + mips); единственный фикс, режущий реальный **GPU VRAM 4–8×** (невозможно в браузере). Достигается через `apps/api` как entitlement-gated reverse-proxy (держит биллинг-бэкенд тонким). Усиленный сайдкар (non-root, RO-FS, caps, без персистентности, без логирования байт картинок).
- **Измеренный probe VRAM для KTX2** — транскодит произведённый `.ktx2` на пробирующем GPU и считывает реальную сжатую резидентность (инструмент `compressedTexImage2D`); показывается рядом с worst-case ceiling, device-local. Транскодер self-hosted (без CDN-фетча).
- **pngquant lossy-PNG** — 2-я операция сайдкара (256-color квантизация, невозможно в браузере); только диск (никогда заявка на VRAM); decline по quality-floor — kept-not-failed.
- **libvips lanczos3 ресэмпл** — 3-я операция сайдкара, даунскейлящая scale-tier высококачественным ядром, на которое нельзя направить браузерный canvas, заменяя браузерный тайл при ТЕХ ЖЕ размерах/формате; несёт ТОЛЬКО ИЗМЕРЕННУЮ дельту удержания высокочастотной энергии (факт, а не вердикт «резче» — инвариант 3) и НИКАКОЙ заявки на VRAM/диск (инвариант 5). Срабатывает на **каждом реально даунскейленном tier, включая oversize-clamped ВЕРХНИЙ tier** (`dst < src`, не только `tier.scale < 1`), с честной skip-нотой при подавлении content-hash именами.
- **Модель приватности** — ассеты покидают устройство ТОЛЬКО при явном per-run opt-in + согласии (с count/preview загрузки); по умолчанию OFF ⇒ всё остаётся локальным и байт-в-байт.

## 7. Бэкенд — Slice B (тонкий Go биллинг/лицензии)

- **apps/api** — Go (chi · pure-Go SQLite · stripe-go · ed25519). Stripe-вебхук → mint, `/v1/{activate,refresh,deactivate}` (лимиты сидов, refund kill-switch), `/v1/key`.
- **License = опак-ключ; entitlement = ed25519-токен**, верифицируемый **офлайн** в браузере (WebCrypto); device-bound. Кросс-язык байт-контракт fixture (Go ↔ WebCrypto).
- **Pro-гейт по умолчанию OFF** (`VITE_PRO_GATE`) — фикс бесплатен в бете.
- **Локальный деплой** — работает в Docker на этом PC (`:8088`), доступен по Tailscale; подключён к веб-приложению (проверено вживую: activate → sign → offline-verify). Dev-license инструмент (`devmint`) + верификатор подключения.

## 8. CLI + CI

- **CLI `asset-doctor`** — `audit | budget | init` переиспользует ядро в Node (ассеты не покидают машину); exact-dup через `node:crypto`; VRAM = Σ w·h·4.
- **GitHub Action budget-gate** — composite `action.yml` с before/after через git worktree; fail-closed JSON-конфиг на browser-only метриках; SARIF/markdown/summary вывод.

## 9. Устойчивость

- **Abortable воркеры** — шов `AbortSignal` через воркеры analyze + fix, чтобы вытесненный drop прекращал конкурировать (аддитивно, по умолчанию off).
- **Честные skip везде** — неразбираемые входы, ошибки энкода, decline по quality-floor, недоступность GPU-формата — всё surfaced (никогда молча), никогда не отгружается больший «оптимизированный» файл.
- **Де-оверлапнутая headline-экономия** — заголовок `potentialDiskSaved` никогда не дважды-считает: format ∩ wasted-alpha ∩ strippable-metadata схлопываются в per-ref MAX, а отброшенные копии exact-duplicate не заявляют ещё и свою format/alpha/strippable-экономию (фантомные байты для файлов, исчезающих при dedup). Всегда ≤ достижимого итога — продукт недообещает, а не завышает.
- **Партиционированный возврат дубликатов** — внутри-атласная frame-redundancy и кросс-атласная redundancy считают НЕПЕРЕСЕКАЮЩИЕСЯ наборы пикселей: собственные внутри-атласные дубли атласа возвращаются один раз (per-rect), а кросс-атласная считает только (distinct-sheets − 1) освобождённых копий, так что оба readout честно аддитивны (каждое сообщённое число равно тому, что соответствующий фикс реально даёт).
- **Устойчивый парсинг multi-page Spine** — lookahead границ страниц `.atlas` терпит indented page-заголовки modern Spine 4.x, так что вторая/N-я текстурная страница никогда не отбрасывается молча (без фантомного полностраничного спрайта, без false-orphan изображения).

---

*Обновлено 2026-07-03 (раунд 29 + UX-раунды 1-3 + сборщик ассетов R1-5 + единый конфиг/страница настроек + профиль-осознанные форматы упаковки). Ветка `feat/asset-pipeline` (= локальный `main`), ~84 коммита поверх `origin/main`, всё зелёное. Деплой (GH Pages) ждёт пользовательского `git push origin main`; живые бэкенд-операции требуют бинарей toktx/pngquant/vips в задеплоенном сайдкаре.*
