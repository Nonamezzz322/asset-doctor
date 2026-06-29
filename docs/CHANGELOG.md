# Asset Doctor — журнал изменений (по раундам)

Живой лог автономного цикла улучшений. Одна запись на раунд; каждый раунд = цикл
design→skeptic→impl→adversarial-review→fix, независимо проверенный «зелёным» и закоммиченный
мелко в ветке `feat/asset-pipeline` (= локальный `main`). Новые сверху.
**Каждый новый раунд ОБЯЗАН дописать свою запись сюда.** `origin/main` находится на `54c1a3a` (деплой заблокирован: нет
GitHub-кредов — пушит пользователь); хэши коммитов ниже отсчитываются от этой базы.

> Convention: `commit` · что отгружено · вердикт ревью · gate. Дизайны лежат в `docs/improvements/round*.md`.

---

## UX-раунд 1 — дизайн/удобство (отбор 3 pick) — 2026-06-29
Новая тема цикла по запросу пользователя: **не расширение функционала, а дизайн и удобство использования (UX/доступность)** — та же машинерия (brainstorm в 4 UX-линзы → строгий судья → скептик-дизайн → impl→ревью→fix). 4 линзы (иерархия/состояния · взаимодействие при масштабе · визуальная полировка/бренд · доступность и ясность) → 16 кандидатов → судья выбрал 3 ответственных, высокоуверенных, неперекрывающихся улучшения и отложил единственный среднерисковый пункт (клавиатурная arrow-навигация по строкам ledger — лучше после того, как приземлится focus-ring). Дизайны в `docs/improvements/ux1-*.md`. Жёсткие UX-инварианты: честность (disk≠VRAM, без фейков), instant-wow ≤10s, a11y (ARIA/клавиатура/reduced-motion/контраст/focus-visible/цвет-не-единственный-сигнал), perf при 1000+ ассетов, верность токенам бренда (`apps/web/src/index.css`). Поскольку в apps/web НЕТ React-харнесса, UX-логика выносится в ЧИСТЫЕ Node-тестируемые функции; чисто-визуальные правки — token-driven и аддитивные.

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
