# V2 — spine-unreferenced-regions (дизайн, NARROWED PROCEED, 2026-07-12)

Атлас-регионы, на которые не ссылается ни один аттачмент ни одного СПАРЕННОГО скелета —
**раскрытие** (info, БЕЗ estimate; числа только в params), с хеджем на runtime `setAttachment`
и невидимые бинарные `.skel`. Дизайн-скептик опроверг две премизы брифа и нашёл три ловушки.

## Ключевые факты (проверено file:line дизайн-агентом)
- Скелетный `.json` сегодня ТИХО игнорируется ингестом (`packages/ingest/src/index.ts:174` —
  `looksLikeManifest` false ⇒ continue; НЕ попадает в unparsed). `looksLikeSkeleton` уже существует
  (`:272-284`), его JSON.parse уже оплачен ⇒ сбор скелетов бесплатен.
- **Анимации парсить не нужно**: attachment-таймлайны именуют ПЛЕЙСХОЛДЕРЫ скинов (spine-core 4.3.9
  SkeletonJson.js: name = map.name ?? placeholderKey; AtlasAttachmentLoader ищет регион по `path`).
  Объединение по ВСЕМ скинам = полное статически-достижимое множество.
- Match-ключ: `path ?? name ?? placeholderKey`, точное равенство с `Sprite.name`.
- **Sequences (4.1+)**: `sequence:{count,start,digits}` ⇒ реальные регионы = path+паддед-индекс ⇒
  ридер эмитит base-path в `prefixes`; предикат: `name.startsWith(p) && /^\d+$/.test(rest)`.
- **`.skel`-подавление**: бинарный скелет в той же папке ⇒ NO binding (он может ссылаться на что
  угодно). Требует добавить `skel` в `RELEVANT_RE` (`apps/web/src/lib/import.ts:19`) — `.skel`
  инертно проходит все ветки groupFiles.
- **Pairing-trust гейт**: matchedFraction = совпавшие различные имена / все различные имена по ВСЕМУ
  .atlas-файлу; ниже `minMatchedFraction` ⇒ тишина (чужой скелет матчит ~0 и не должен давать
  «всё мёртвое»). Структурно запрещает all-dead клейм.
- Типы `boundingbox|path|point|clipping` НЕ собирают; НЕЗНАКОМЫЙ тип — СОБИРАЕТ (пере-сбор только
  сужает мёртвое множество). Любая незнакомая форма ⇒ null ⇒ правило не срабатывает.

## Строится
1. core: Rule += 'spine-unreferenced-regions'; тип `SpineSkeletonBinding { atlasRefs, refNames,
   refPrefixes, skeletonRefs }` (прецедент AtlasFrameHashes); ThresholdConfig +=
   `spineUnreferencedRegions?: { minMatchedFraction; minDeadRegions }`; OverlayZone.kind += 'dead-region'.
   Atlas/Sprite/Asset НЕ меняются.
2. parsers: НОВЫЙ `src/spine-skeleton.ts` — `readSkeletonAttachmentRefs(json): {names,prefixes}|null`
   (skins array 3.8/4.x С `attachments`-обёрткой И legacy object; консервативный null).
3. ingest: `GroupedAtlas.manifestRef?` (во всех 3 ветках) + `Grouped.skeletons?: {ref,json}[]`
   (на существующей точке `:174`, сортировано по ref).
4. worker: спаривание same-dir (dirOf(skeleton ref) === dirOf(manifestRef)), объединение всех валидных
   скелетов, `.skel`-подавление; deps.spineBindings в analyze (паттерн frameHashes).
5. rules: `spineUnreferencedRegionsFindings(atlases, bindings, cfg)` — per-PAGE finding
   `${atlasRef}:spine-unreferenced-regions`, info, БЕЗ estimate, params { dead, total, areaPx, areaPct,
   skeletons, names (сортировано, усечено ~8 + '…') }, overlay [{kind:'dead-region', rects}] —
   реальные frame-ректы AS PLACED, де-алиас по различному ректу (прецедент bleeding). detail-копия:
   хедж «другой скелет (вкл. нечитаемый .skel) или runtime setAttachment могут использовать».
6. config: `spineUnreferencedRegions: { minMatchedFraction: 0.5, minDeadRegions: 1 }` // CALIBRATE.
7. film-viewer: ZONE_STYLE 'dead-region' = info-blue #2b8fc9 fill 0.18 (shared-hue/distinct-label
   прецедент с gutter 0.14; лендинг-спесимен: +1 зона — тест Set-равенства!); ZONE_KIND_ORDER +
   LABEL_KEY 'legend.deadRegion'; пины film-legend.test (6→7).
8. i18n ×10: find.spine-unreferenced-regions.{title,detail,fix} + rule.* + legend.deadRegion;
   drift в render.test.ts (нужен SpineSkeletonBinding-фикстурный вызов реального правила).
9. Фикстура `fixtures/sample-projects/spine-unreferenced-regions/`: sheet.atlas (4 региона: head/body/
   arm/fx_unused), НАСТОЯЩИЙ мелкий sheet.png (структурная проверка!), рукописный skeleton.json
   (4.x array-skins; body через placeholderKey, head через path-override, arm через name-override;
   fx_unused нигде), expected.json { deadCount 1, matchedFraction 0.75 }, README.
10. Тесты: parsers (формы схемы/цепочка ключей/типы/sequence/null), ingest (skeletons collected,
    manifestRef, TP-манифест не собран), analysis (trust-гейт тишина, all-dead тишина, multi-skeleton
    union, rotated rect, дедуп, e2e через groupFiles→analyze).

## Голден-фоллаут: НОЛЬ
Ни одна фикстура не пара .atlas+skeleton; CLI в v1 НЕ подключён (нет deps.spineBindings в
pipeline.ts) ⇒ CLI байт-идентичен; ключ порога инертен в budget-пути.

## Отложено честно
CLI-подключение (нужна `.skel`-история в walkDir); парсинг бинарного .skel (никогда);
«в скине, но не в анимации» (статически недоказуемо); cross-dir спаривание (мис-пары).
