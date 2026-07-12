# V4 — applied-fix vs LIVE runtime: агрегатный A/B двух сессий (дизайн, 2026-07-12)

МОАТ-фича, финальный пункт V-бэклога. НЕ V3 (пер-правильная атрибуция — ABORT по доказательствам):
здесь **агрегатный A/B** — пользователь записывает живую сессию своей игры ДО применения фикса и ещё
одну ПОСЛЕ поставки исправленных ассетов; мы сравниваем два `RuntimeReport`.

## Проверенные факты
- `RuntimeReport` НЕСЁТ `frames` и `durationMs` (runtime.ts:64-65) ⇒ гейты сопоставимости возможны.
- Live-корреляция живёт ТОЛЬКО в оверлее расширения (inject.ts); в вебе `correlate-harness.ts` — dev-
  харнесс. Потока экспорта/импорта RuntimeReport НЕ существует ⇒ v1 добавляет его.
- `timing` уже помечен `deviceDependent: true` — честный флаг для A/B-хеджа.
- vramBytes растровой стороны — формула w·h·4 с ОБЕИХ сторон A/B ⇒ дельта той же measurement-базы —
  честное сравнение (в отличие от V3, где ярлык «measured» переклеивался на оценку).

## Честность: классы метрик × что можно утверждать
| Метрика | Класс | Хедж |
|---|---|---|
| drawCalls.avg, textureBinds.avg | per-frame | нормированы по кадрам, но чувствительны к СЦЕНЕ — сравнение честно только при аттестации «та же сцена» |
| liveTextures, vramBytes | state (снимок) | наименее чувствительны к нагрузке; vram-дельта — одна и та же формула с обеих сторон |
| redundantBinds, uploadsDuringGameplay, shaderCompilesDuringGameplay | session-total | чувствительны к длительности ⇒ жёсткий duration-гейт |
| timing (fps, frameTimeMs*) | device | сравнимо ТОЛЬКО на том же устройстве; deviceDependent уже в типе |
| hitches | качественная | бок-о-бок счётчики, без дельта-вердикта |

**Никогда не утверждаем причинность**: вердикт — «сессия B намерила на X меньше, чем A; нагрузку
контролировали вы», + аттестация пользователя (same scene / same device) как явный вход, не вывод.

## Гейты сопоставимости (опции с экспортируемыми дефолтами, COMPARE_DEFAULTS)
- `minFrames` (120): короче — 'too-short' (не сравниваем; шум).
- `maxDurationSkewPct` (0.30): |dA−dB|/max > 30% ⇒ 'duration-skewed' — session-total метрики помечаются
  несопоставимыми (per-frame и state остаются со своими хеджами).
- Вердикт: 'comparable' | 'duration-skewed' | 'too-short' (each side).

## Строится (порядок)
1. **[core, этот раунд]** packages/correlate/src/compare.ts — ЧИСТЫЙ compareRuntimeReports(before,
   after, opts?) → RuntimeComparison { verdict, скью-метрики, rows: per-metric { key, class, before,
   after, delta, comparable } }; COMPARE_DEFAULTS; экспорт из index; исчерпывающие тесты.
2. **[extension]** кнопка «Экспорт отчёта сессии» в оверлее — download/copy JSON RuntimeReport
   (данные уже в profiler.report(); ноль новой инструментовки; байты страницы не покидают устройство —
   пользователь сам сохраняет свой отчёт).
3. **[web]** compare-страница/секция: загрузить A и B (JSON), чекбоксы аттестации («та же сцена»,
   «то же устройство»), таблица rows с хеджами по классам; timing показывается только при аттестации
   устройства. i18n ×10. fail-closed парс отчёта (shape-валидация; мусор ⇒ отказ, не NaN-таблица).

## Что НЕ меняется
RuntimeReport shape (frames/durationMs уже есть — аддитивных полей НЕ нужно); correlate()/correlateFix;
инструмент GL. CLI не затронут.

## Голден-фоллаут: ноль (новый чистый модуль + новые поверхности).
