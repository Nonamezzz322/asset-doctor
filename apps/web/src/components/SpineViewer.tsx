// #spine view — the pixi-spine viewer in Asset Doctor's rentgen-cabinet design. React owns ONLY the shell +
// the accessible controls; all Pixi/Spine state lives in the imperative SpineEngine (lib/spine-engine.ts),
// which this component constructs once and drives through its method API. Every dropped Spine export is read
// locally (import.ts PickedFile bytes) and rendered in-browser — zero network (invariant 1). Exactly one h1
// (ad-spine-h1, the view's focus anchor). All labels via t(); data-derived animation/skin/slot names are
// rendered verbatim (never translated). Reduced-motion starts paused. Tokens only — no inline styles.
//
// LAYOUT: a fixed two-column grid — a tall hero stage (the focusable pan/zoom surface) + a sticky inspector
// rail. The inspector is a DISCLOSURE accordion (Playback/Tracks/Skins/Debug/Slots): every section <h2> stays
// permanently in the DOM outline (monotonic h1 → h2×5), collapse is aria-expanded/hidden. The canvas is z-0
// (engine); the pre-load drop overlay + on-canvas islands are z-10 so their buttons are the topmost element at
// their location (fixes the dead load buttons). Drag/wheel pan+zoom live on app.canvas (engine listeners);
// keyboard equivalents (arrows/±/0/F) are wired on the focusable stage here.

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../lib/i18n';
import { filesFromDataTransfer, filesFromInput, pickFolder, supportsDirectoryPicker, type PickedFile } from '../lib/import';
import { SpineEngine, type DebugKey, type SpineErrorKey, type SpineLoadResult } from '../lib/spine-engine';
import {
  addToQueue,
  addTrackModel,
  clampTrimEnd,
  clampTrimStart,
  clearEntities,
  DEBUG_ENTITY_TYPES,
  defaultTracks,
  emptyEntityIndex,
  emptyEntitySelection,
  filterNames,
  filterSlotInfos,
  removeFromQueue,
  removeTrackModel,
  selectAllEntities,
  setTrackAlphaModel,
  toggleEntity,
  toggleName,
  toggleSkin,
  type DebugEntityType,
  type EntityIndex,
  type EntitySelection,
  type SlotInfo,
  type TrackModel,
} from '../lib/spine-inspect';
import { Switch } from './controls';

const reducedMotion = (): boolean =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const STEP = 24; // keyboard pan step (screen px)
const DEBUG_KEYS: DebugKey[] = ['bones', 'regions', 'meshTriangles', 'meshHull', 'clipping', 'boundingBoxes', 'paths', 'events'];
const noDebug = (): Record<DebugKey, boolean> => ({
  bones: false,
  regions: false,
  meshTriangles: false,
  meshHull: false,
  clipping: false,
  boundingBoxes: false,
  paths: false,
  events: false,
});

// ── Disclosure section shell — every title is an <h2> with the toggle button INSIDE it, so the heading
//    outline stays monotonic (h1 → h2×5) whether the panel is open or collapsed. Tokens only. ──
function Section({ title, open, onToggle, children }: { title: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  const panelId = useId();
  return (
    <section className="rounded-2xl border border-line bg-panel text-left">
      <h2 className="m-0">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={onToggle}
          className="flex w-full items-center justify-between gap-2 rounded-2xl px-5 py-3.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal"
        >
          <span className="ad-label text-teal-text">{title}</span>
          <span aria-hidden="true" className="font-mono text-[13px] text-ink-soft">
            {open ? '▾' : '▸'}
          </span>
        </button>
      </h2>
      <div id={panelId} hidden={!open} className="space-y-2 px-5 pb-5 pt-0">
        {children}
      </div>
    </section>
  );
}

export function SpineViewer() {
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<SpineEngine | null>(null);
  const readyRef = useRef<Promise<void> | null>(null);
  const filesInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const [loaded, setLoaded] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [errorKey, setErrorKey] = useState<SpineErrorKey | null>(null);
  const [skeletonName, setSkeletonName] = useState('');
  const [animations, setAnimations] = useState<string[]>([]);
  const [skins, setSkins] = useState<string[]>([]);
  const [slots, setSlots] = useState<SlotInfo[]>([]);
  const [tracks, setTracks] = useState<TrackModel[]>([]);
  const [selectedSkins, setSelectedSkins] = useState<string[]>([]);
  const [debug, setDebug] = useState<Record<DebugKey, boolean>>(noDebug);
  const [attached, setAttached] = useState<string[]>([]);
  const [slotFilter, setSlotFilter] = useState('');
  const [playing, setPlaying] = useState(() => !reducedMotion());
  const [speed, setSpeed] = useState(1);
  const [scale, setScale] = useState(1);
  const [markerScale, setMarkerScale] = useState(1);
  const [defaultMix, setDefaultMix] = useState(0);

  // Phase A — playback parity: queue (engine-authoritative index), timeline+trim, fps, marker visibility.
  const [queue, setQueue] = useState<string[]>([]);
  const [queueIndex, setQueueIndex] = useState(-1);
  const [queueLoop, setQueueLoop] = useState(false); // user preference — survives reloads
  const [animTime, setAnimTime] = useState(0);
  const [animDuration, setAnimDuration] = useState(0);
  const [trimEnabled, setTrimEnabled] = useState(false);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [fps, setFps] = useState(0);
  const [markerHidden, setMarkerHidden] = useState<Set<string>>(new Set());
  const [queuePick, setQueuePick] = useState(''); // value-holding queue-add select (Add is an explicit button)
  // Trim source-of-truth mirror + last-seen duration, readable inside the memoized onTimeline callback.
  // end === null ⇒ not yet initialized for this skeleton (distinct from a genuine user-set 0).
  const durRef = useRef(0);
  const trimRef = useRef<{ enabled: boolean; start: number; end: number | null }>({ enabled: false, start: 0, end: null });

  // Phase B — bone inspector + granular per-entity debug selection.
  const [boneNames, setBoneNames] = useState<string[]>([]);
  const [entityIndex, setEntityIndex] = useState<EntityIndex>(emptyEntityIndex);
  // OFF by default — a clean first view, coherent with the global SpineDebugRenderer toggles (noDebug()).
  const [showBones, setShowBones] = useState(false);
  const [selBones, setSelBones] = useState<string[]>([]);
  const [selEntities, setSelEntities] = useState<EntitySelection>(emptyEntitySelection);
  const [granType, setGranType] = useState<'bones' | DebugEntityType>('bones');
  const [granFilter, setGranFilter] = useState('');

  // Accordion open state — Playback default open, the rest collapsed.
  const [open, setOpen] = useState({ playback: true, tracks: false, skins: false, debug: false, slots: false });
  const toggle = (k: keyof typeof open) => setOpen((o) => ({ ...o, [k]: !o[k] }));

  const onLoaded = useCallback((r: SpineLoadResult) => {
    setLoaded(true);
    setErrorKey(null);
    setSkeletonName(r.skeletonName);
    setAnimations(r.animations);
    setSkins(r.skins);
    setSlots(r.slots);
    setTracks(defaultTracks(r.firstAnimation));
    setSelectedSkins(r.skins[0] ? [r.skins[0]] : []);
    // Keep the render in sync with the pre-checked skin box: a multi-skin skeleton whose authored setup skin
    // is not skins[0] would otherwise show skins[0] checked while rendering a different skin until first toggle.
    if (r.skins.length > 1 && r.skins[0]) engineRef.current?.setSkins([r.skins[0]]);
    setDebug(noDebug());
    setAttached([]);
    setSlotFilter('');
    setDefaultMix(0);
    // Phase A resets — a fresh skeleton clears the playlist/timeline/trim/marker-visibility (queueLoop is a
    // user preference and survives).
    setQueue([]);
    setQueueIndex(-1);
    setAnimTime(0);
    setAnimDuration(0);
    setTrimEnabled(false);
    setTrimStart(0);
    setTrimEnd(0);
    setMarkerHidden(new Set());
    // Phase B resets + the initial granular push (everything OFF — a clean first view, like the global
    // debug toggles; the overlay is created lazily when the user first enables something).
    setBoneNames(r.bones);
    setEntityIndex(r.entities);
    setShowBones(false);
    setSelBones([]);
    setSelEntities(emptyEntitySelection());
    setGranType('bones');
    setGranFilter('');
    setQueuePick('');
    durRef.current = 0;
    trimRef.current = { enabled: false, start: 0, end: null };
    engineRef.current?.setGranularSelection({ showBones: false, bones: [], entities: emptyEntitySelection() });
  }, []);
  const onError = useCallback((key: SpineErrorKey) => setErrorKey(key), []);
  const onSlots = useCallback((next: SlotInfo[]) => setSlots(next), []);
  // Queue auto-advance mirror: the engine's complete-listener is authoritative; the track-0 selector follows
  // the currently-playing queued animation (upstream setSelectedAnimation(queue[nextIdx]) parity).
  const onQueueIndex = useCallback((i: number, anim: string | null) => {
    setQueueIndex(i);
    if (anim !== null) setTracks((ts) => ts.map((t) => (t.index === 0 ? { ...t, animation: anim } : t)));
  }, []);
  const onTimeline = useCallback((time: number, d: number) => {
    setAnimTime(time);
    // Trim is duration-scoped: reconcile ONLY when the track-0 duration actually changes (animation switch /
    // first load) — clamp the window into the new duration AND re-push it to the engine, so the teal trim
    // region never claims a range the wrap isn't enforcing. end === null ⇒ not yet initialized (a genuine
    // user-set 0 is preserved, never snapped back to full duration).
    if (durRef.current !== d) {
      durRef.current = d;
      setAnimDuration(d);
      const tr = trimRef.current;
      tr.start = Math.min(tr.start, d);
      tr.end = tr.end === null ? d : Math.min(tr.end, d);
      setTrimStart(tr.start);
      setTrimEnd(tr.end);
      if (tr.enabled) engineRef.current?.setTrim(true, tr.start, tr.end);
    }
  }, []);
  const onFps = useCallback((n: number) => setFps(n), []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const eng = new SpineEngine({ onLoaded, onError, onSlots, onQueueIndex, onTimeline, onFps });
    engineRef.current = eng;
    readyRef.current = eng.init(host, { reducedMotion: reducedMotion() });
    return () => {
      eng.destroy();
      engineRef.current = null;
    };
  }, [onLoaded, onError, onSlots, onQueueIndex, onTimeline, onFps]);

  const doLoad = useCallback(async (files: PickedFile[]) => {
    setErrorKey(null);
    await readyRef.current;
    await engineRef.current?.load(files);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      void filesFromDataTransfer(e.dataTransfer.items).then(doLoad);
    },
    [doLoad],
  );

  const openFolder = useCallback(() => {
    if (supportsDirectoryPicker()) void pickFolder().then(doLoad);
    else folderInputRef.current?.click();
  }, [doLoad]);

  const togglePlay = useCallback(() => {
    setPlaying((p) => {
      const next = !p;
      engineRef.current?.setPlaying(next);
      return next;
    });
  }, []);

  // Reset/Fit: clear pan + zoom AND the Scale slider, then re-fit — so the skeleton truly fills the frame even
  // when the user dialed Scale up (Scale × zoom compose multiplicatively, so Reset must return BOTH to 1).
  const resetView = useCallback(() => {
    setScale(1);
    const eng = engineRef.current;
    eng?.setScale(1);
    eng?.resetView();
  }, []);

  // Keyboard pan/zoom on the focusable stage — the mouseless twin of drag + wheel + Reset.
  const onStageKey = useCallback((e: React.KeyboardEvent) => {
    const eng = engineRef.current;
    if (!eng) return;
    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault();
        eng.nudge(-STEP, 0);
        break;
      case 'ArrowRight':
        e.preventDefault();
        eng.nudge(STEP, 0);
        break;
      case 'ArrowUp':
        e.preventDefault();
        eng.nudge(0, -STEP);
        break;
      case 'ArrowDown':
        e.preventDefault();
        eng.nudge(0, STEP);
        break;
      case '+':
      case '=':
        e.preventDefault();
        eng.zoomBy(1.1);
        break;
      case '-':
      case '_':
        e.preventDefault();
        eng.zoomBy(1 / 1.1);
        break;
      case '0':
      case 'f':
      case 'F':
        e.preventDefault();
        resetView();
        break;
      default:
        break;
    }
  }, [resetView]);

  // ── Track handlers ──────────────────────────────────────────────────────────
  const onTrackAnim = (index: number, name: string): void => {
    setTracks((ts) => ts.map((t) => (t.index === index ? { ...t, animation: name } : t)));
    if (name === '') engineRef.current?.setEmptyTrack(index, defaultMix);
    else {
      const row = tracks.find((t) => t.index === index);
      engineRef.current?.setTrackAnimation(index, name, row?.loop ?? true, row?.alpha ?? 1); // alpha survives (App.jsx parity)
    }
  };
  const onTrackLoop = (index: number, loop: boolean): void => {
    setTracks((ts) => ts.map((t) => (t.index === index ? { ...t, loop } : t)));
    const row = tracks.find((t) => t.index === index);
    if (row && row.animation !== '') engineRef.current?.setTrackAnimation(index, row.animation, loop, row.alpha);
  };
  const onTrackAlpha = (index: number, alpha: number): void => {
    setTracks((ts) => setTrackAlphaModel(ts, index, alpha));
    engineRef.current?.setTrackAlpha(index, alpha);
  };
  const onTrackRemove = (index: number): void => {
    engineRef.current?.clearTrack(index);
    setTracks((ts) => removeTrackModel(ts, index));
  };

  // ── Queue handlers (React mirrors the list; the engine owns the cursor + auto-advance) ─────────────────
  const onQueueAdd = (name: string): void => {
    if (name === '') return;
    engineRef.current?.enqueue(name);
    setQueue((q) => addToQueue(q, name));
  };
  const onQueueRemove = (i: number): void => {
    engineRef.current?.removeFromQueueAt(i); // pushes the reconciled cursor via onQueueIndex
    setQueue((q) => removeFromQueue(q, i, queueIndex).queue);
  };
  const onQueueClear = (): void => {
    engineRef.current?.clearQueue();
    setQueue([]);
  };

  // ── Timeline / trim handlers (pure clamps; the engine wraps trackTime in its ticker) ────────────────────
  const onScrub = (v: number): void => {
    setAnimTime(v);
    engineRef.current?.scrub(v);
  };
  // All three write through trimRef (the onTimeline reconciler reads it) and push the engine verbatim.
  const onTrimToggle = (b: boolean): void => {
    const tr = trimRef.current;
    tr.enabled = b;
    if (tr.end === null) tr.end = animDuration;
    setTrimEnabled(b);
    setTrimEnd(tr.end);
    engineRef.current?.setTrim(b, tr.start, tr.end);
  };
  const onTrimStart = (v: number): void => {
    const tr = trimRef.current;
    tr.start = clampTrimStart(v, tr.end ?? animDuration);
    setTrimStart(tr.start);
    engineRef.current?.setTrim(tr.enabled, tr.start, tr.end ?? animDuration);
  };
  const onTrimEnd = (v: number): void => {
    const tr = trimRef.current;
    tr.end = clampTrimEnd(v, tr.start, animDuration);
    setTrimEnd(tr.end);
    engineRef.current?.setTrim(tr.enabled, tr.start, tr.end);
  };

  // ── Marker visibility ────────────────────────────────────────────────────────────────────────────────
  const onMarkerVisible = (slot: string, visible: boolean): void => {
    setMarkerHidden((prev) => {
      const next = new Set(prev);
      if (visible) next.delete(slot);
      else next.add(slot);
      return next;
    });
    engineRef.current?.setMarkerVisible(slot, visible);
  };

  // ── Granular debug push — sends the WHOLE selection each time (the engine keeps Sets, React keeps lists) ─
  const pushGranular = (next: Partial<{ showBones: boolean; bones: string[]; entities: EntitySelection }>): void => {
    engineRef.current?.setGranularSelection({
      showBones: next.showBones ?? showBones,
      bones: next.bones ?? selBones,
      entities: next.entities ?? selEntities,
    });
  };

  const filtered = filterSlotInfos(slots, slotFilter).filter((s) => !attached.includes(s.name));

  return (
    <div className="space-y-5">
      <div>
        <h1 id="ad-spine-h1" tabIndex={-1} className="ad-focus-anchor font-display text-2xl font-semibold tracking-tight text-ink">
          {t('spine.title')}
        </h1>
        <p className="mt-2 max-w-xl font-mono text-[13px] leading-relaxed text-ink-soft">{t('spine.subtitle')}</p>
      </div>

      <div className={loaded ? 'grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start' : ''}>
        {/* ── Film stage (hero) ────────────────────────────────────────────── */}
        <div>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={`relative ad-clip ad-viewer-shadow rounded-2xl border bg-film p-3.5 transition-colors ${
              dragging ? 'border-teal' : 'border-film-border'
            }`}
          >
            {/* top bar (FilmViewer motif) */}
            <div className="flex items-center justify-between gap-2 px-1.5 pb-3 pt-1 font-mono">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-xs text-film-soft">{loaded ? skeletonName : t('spine.stage.empty')}</span>
                <span className="rounded bg-info px-1.5 py-0.5 text-[10px] font-semibold text-film">SPINE</span>
              </div>
              {loaded ? (
                <button
                  type="button"
                  onClick={() => filesInputRef.current?.click()}
                  className="shrink-0 rounded border border-film-border px-2 py-0.5 text-[11px] text-film-soft hover:border-film-soft"
                >
                  {t('spine.replace')}
                </button>
              ) : null}
            </div>

            {/* Focusable pan/zoom stage — tall hero. The canvas (z-0) mounts here; controls sit above at z-10. */}
            <div
              ref={hostRef}
              role="group"
              tabIndex={0}
              aria-label={t('spine.stage.label')}
              aria-describedby="ad-spine-kbdhelp"
              onKeyDown={onStageKey}
              className="ad-grid relative min-h-[60vh] w-full touch-none overflow-hidden rounded-[10px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-film-soft"
            >
              {!loaded ? (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 rounded-[10px] border-2 border-dashed border-film-border p-6 text-center">
                  <p className="font-display text-sm font-semibold text-film-soft">{t('spine.drop.title')}</p>
                  <p className="font-mono text-[11px] text-film-mute">{t('spine.drop.hint')}</p>
                  <p className="font-mono text-[11px] text-film-mute">{t('spine.drop.or')}</p>
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    <button
                      type="button"
                      onClick={() => filesInputRef.current?.click()}
                      className="rounded-lg border border-film-border bg-film-2 px-4 py-2 font-mono text-[12px] text-film-soft hover:border-film-soft"
                    >
                      {t('spine.open.files')}
                    </button>
                    <button
                      type="button"
                      onClick={openFolder}
                      className="rounded-lg border border-film-border bg-film-2 px-4 py-2 font-mono text-[12px] text-film-soft hover:border-film-soft"
                    >
                      {t('spine.open.folder')}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {/* FPS badge — real ticker.FPS pushed ~1 Hz by the engine; informational, aria-hidden (the
                      readout is decorative telemetry, not a control). Rendered only once a real frame was measured. */}
                  {fps > 0 ? (
                    <span aria-hidden="true" className="absolute right-2 top-2 z-10 rounded bg-film-2 px-2 py-0.5 font-mono text-[11px] text-film-soft">
                      {t('spine.fps', { n: fps })}
                    </span>
                  ) : null}
                  {/* Mouse-convenience on-canvas toggle — the ACCESSIBLE toggle is the Playback panel button, so
                      this one is hidden from the AOM + tab order (aria-hidden + tabIndex -1). z-10 above canvas. */}
                  <button
                    type="button"
                    aria-hidden="true"
                    tabIndex={-1}
                    onClick={togglePlay}
                    className="absolute bottom-2 left-2 z-10 rounded-lg border border-film-border bg-film-2 px-3 py-1.5 font-mono text-[13px] text-film-soft hover:border-film-soft"
                  >
                    {playing ? '❚❚' : '▶'}
                  </button>
                  <button
                    type="button"
                    aria-hidden="true"
                    tabIndex={-1}
                    onClick={resetView}
                    className="absolute bottom-2 right-2 z-10 rounded-lg border border-film-border bg-film-2 px-3 py-1.5 font-mono text-[13px] text-film-soft hover:border-film-soft"
                  >
                    {t('spine.view.reset')}
                  </button>
                </>
              )}
            </div>

            {errorKey ? (
              <p role="alert" className="mt-2 px-1.5 font-mono text-[12px] text-crit-text">
                {t(`spine.error.${errorKey}`)}
              </p>
            ) : null}
            {/* Keyboard help lives HERE (always in the DOM once loaded), not inside the collapsible Playback
                panel — so the stage aria-describedby target survives when that accordion is closed. */}
            {loaded ? (
              <p id="ad-spine-kbdhelp" className="mt-1 px-1.5 font-mono text-[11px] text-film-mute">
                {t('spine.view.kbdHelp')}
              </p>
            ) : null}
          </div>
        </div>

        {/* ── Inspector rail (sticky, self-scrolling) ──────────────────────── */}
        {loaded ? (
          <div className="space-y-3 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto lg:pr-1">
            {/* (a) Playback */}
            <Section title={t('spine.section.playback')} open={open.playback} onToggle={() => toggle('playback')}>
              <button
                type="button"
                aria-pressed={playing}
                onClick={togglePlay}
                className="w-full rounded-lg bg-cta px-5 py-2.5 font-sans text-sm font-semibold text-white shadow-[0_2px_6px_rgba(21,160,106,0.32)] hover:bg-cta-hover"
              >
                {t(playing ? 'spine.pause' : 'spine.play')}
              </button>
              <label className="block font-mono text-[12px] text-ink-soft">
                {t('spine.speed')} · {speed.toFixed(2)}×
                <input
                  type="range"
                  min={0.1}
                  max={2}
                  step={0.01}
                  value={speed}
                  aria-label={t('spine.speed')}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setSpeed(v);
                    engineRef.current?.setSpeed(v);
                  }}
                  className="mt-1 w-full accent-teal"
                />
              </label>
              <label className="block font-mono text-[12px] text-ink-soft">
                {t('spine.scale')} · {scale.toFixed(2)}×
                <input
                  type="range"
                  min={0.1}
                  max={2}
                  step={0.01}
                  value={scale}
                  aria-label={t('spine.scale')}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setScale(v);
                    engineRef.current?.setScale(v);
                  }}
                  className="mt-1 w-full accent-teal"
                />
              </label>
              {/* Timeline + trim — the REAL control is the labeled range (keyboard scrubbing for free); the
                  bar above it is a decorative aria-hidden readout. The two style attributes are the D11
                  data-driven % exceptions (FilmViewer precedent) — everything else is tokens. */}
              {animDuration > 0 ? (
                <div className="space-y-2">
                  <p className="font-mono text-[12px] text-ink-soft">
                    {t('spine.timeline.label')} ·{' '}
                    <span className="text-ink">
                      {animTime.toFixed(2)}s / {animDuration.toFixed(2)}s
                    </span>
                  </p>
                  <div aria-hidden="true" className="relative h-2 overflow-hidden rounded bg-line">
                    {trimEnabled ? (
                      <div
                        className="absolute inset-y-0 bg-teal/25"
                        style={{
                          left: `${(trimStart / animDuration) * 100}%`,
                          width: `${(Math.max(0, trimEnd - trimStart) / animDuration) * 100}%`,
                        }}
                      />
                    ) : null}
                    <div className="absolute inset-y-0 w-0.5 bg-teal-text" style={{ left: `${(Math.min(animTime, animDuration) / animDuration) * 100}%` }} />
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={animDuration}
                    step={0.01}
                    value={Math.min(animTime, animDuration)}
                    aria-label={t('spine.timeline.scrub')}
                    aria-valuetext={t('spine.timeline.pos', { t: animTime.toFixed(2), d: animDuration.toFixed(2) })}
                    onChange={(e) => onScrub(Number(e.target.value))}
                    className="w-full accent-teal"
                  />
                  <Switch label={t('spine.trim.enable')} checked={trimEnabled} onChange={onTrimToggle} />
                  {trimEnabled ? (
                    <>
                      <label className="block font-mono text-[12px] text-ink-soft">
                        {t('spine.trim.start')} · {trimStart.toFixed(2)}s
                        <input
                          type="range"
                          min={0}
                          max={animDuration}
                          step={0.01}
                          value={trimStart}
                          aria-label={t('spine.trim.start')}
                          onChange={(e) => onTrimStart(Number(e.target.value))}
                          className="mt-1 w-full accent-teal"
                        />
                      </label>
                      <label className="block font-mono text-[12px] text-ink-soft">
                        {t('spine.trim.end')} · {trimEnd.toFixed(2)}s
                        <input
                          type="range"
                          min={0}
                          max={animDuration}
                          step={0.01}
                          value={trimEnd}
                          aria-label={t('spine.trim.end')}
                          onChange={(e) => onTrimEnd(Number(e.target.value))}
                          className="mt-1 w-full accent-teal"
                        />
                      </label>
                    </>
                  ) : null}
                </div>
              ) : null}
              <button
                type="button"
                onClick={resetView}
                className="w-full rounded-lg border border-line px-3 py-2 font-mono text-[13px] text-teal-text transition hover:border-teal focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal"
              >
                {t('spine.view.reset')}
              </button>
            </Section>

            {/* (b) Tracks */}
            <Section title={t('spine.section.tracks')} open={open.tracks} onToggle={() => toggle('tracks')}>
              {animations.length === 0 ? (
                <p className="font-mono text-[13px] text-ink-soft">{t('spine.animation.none')}</p>
              ) : (
                <>
                  {/* Queue — a sequential playlist over track 0; the engine auto-advances on `complete` and
                      mirrors the cursor here. The current row is marked by aria-current + a left border
                      (never colour alone). Entry names are data-derived — rendered verbatim. */}
                  <div className="space-y-2 rounded border border-line p-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="ad-label-sm text-ink-soft">{t('spine.queue.label')}</span>
                      {queue.length > 0 ? (
                        <button
                          type="button"
                          onClick={onQueueClear}
                          className="shrink-0 rounded border border-line px-2 py-0.5 font-mono text-[12px] text-crit-text hover:border-crit-text"
                        >
                          {t('spine.queue.clear')}
                        </button>
                      ) : null}
                    </div>
                    <Switch
                      label={t('spine.queue.loop')}
                      checked={queueLoop}
                      onChange={(b) => {
                        setQueueLoop(b);
                        engineRef.current?.setQueueLoop(b);
                      }}
                    />
                    {queue.length > 0 ? (
                      <ol className="space-y-1">
                        {queue.map((name, i) => (
                          <li
                            key={`${name}-${i}`}
                            aria-current={i === queueIndex ? 'true' : undefined}
                            className={`flex items-center justify-between gap-2 rounded border border-line px-2 py-1 ${
                              i === queueIndex ? 'border-l-2 border-l-teal bg-teal/10' : ''
                            }`}
                          >
                            <span className="truncate font-mono text-[13px] text-ink">
                              {i + 1}. {name}
                            </span>
                            <button
                              type="button"
                              aria-label={t('spine.queue.remove', { n: i + 1 })}
                              onClick={() => onQueueRemove(i)}
                              className="shrink-0 rounded border border-line px-2 font-mono text-[13px] text-crit-text hover:border-crit-text"
                            >
                              ✕
                            </button>
                          </li>
                        ))}
                      </ol>
                    ) : null}
                    {/* Value-holding select + an EXPLICIT Add button — a select-as-action would enqueue on
                        every arrow keypress (keyboard users browse options via arrows on a closed select). */}
                    <div className="flex items-center gap-2">
                      <select
                        value={queuePick}
                        aria-label={t('spine.queue.add')}
                        onChange={(e) => setQueuePick(e.target.value)}
                        className="w-full rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[13px] text-ink-soft hover:border-teal focus:border-teal"
                      >
                        <option value="">{t('spine.queue.add')}</option>
                        {animations.map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={queuePick === ''}
                        aria-label={t('spine.queue.add')}
                        onClick={() => onQueueAdd(queuePick)}
                        className="shrink-0 rounded border border-line px-2 py-0.5 font-mono text-[13px] text-teal-text hover:border-teal disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        +
                      </button>
                    </div>
                  </div>
                  <div className="space-y-2">
                    {tracks.map((track, i) => (
                      <div key={track.index} className="space-y-1.5 rounded border border-line px-2 py-1.5">
                        <div className="flex items-center gap-2">
                          <select
                            aria-label={t('spine.track.animation', { n: i + 1 })}
                            value={track.animation}
                            onChange={(e) => onTrackAnim(track.index, e.target.value)}
                            className="w-full rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[13px] text-ink-soft hover:border-teal focus:border-teal"
                          >
                            <option value="">{t('spine.track.empty')}</option>
                            {animations.map((name) => (
                              <option key={name} value={name}>
                                {name}
                              </option>
                            ))}
                          </select>
                          <Switch label={t('spine.track.loop', { n: i + 1 })} checked={track.loop} onChange={(b) => onTrackLoop(track.index, b)} />
                          <button
                            type="button"
                            aria-label={t('spine.track.remove', { n: i + 1 })}
                            disabled={i === 0}
                            onClick={() => onTrackRemove(track.index)}
                            className="shrink-0 rounded border border-line px-2 font-mono text-[13px] text-crit-text hover:border-crit-text disabled:opacity-40"
                          >
                            ✕
                          </button>
                        </div>
                        <label className="block font-mono text-[12px] text-ink-soft">
                          {t('spine.track.alpha', { n: i + 1 })} · {track.alpha.toFixed(2)}
                          <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.01}
                            value={track.alpha}
                            aria-label={t('spine.track.alpha', { n: i + 1 })}
                            onChange={(e) => onTrackAlpha(track.index, Number(e.target.value))}
                            className="mt-1 w-full accent-teal"
                          />
                        </label>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => setTracks((ts) => addTrackModel(ts))}
                    className="w-full rounded-lg border border-line px-3 py-1.5 font-mono text-[13px] text-teal-text transition hover:border-teal focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal"
                  >
                    + {t('spine.track.add')}
                  </button>
                  <label className="flex items-center justify-between gap-2 font-mono text-[13px] text-ink-soft" title={t('spine.track.mixHint')}>
                    {t('spine.track.mix')}
                    <input
                      type="number"
                      min={0}
                      max={1}
                      step={0.05}
                      value={defaultMix}
                      aria-label={t('spine.track.mix')}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        setDefaultMix(v);
                        engineRef.current?.setDefaultMix(v);
                      }}
                      className="w-24 rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[13px] text-ink focus:border-teal"
                    />
                  </label>
                  <p className="font-mono text-[12px] leading-relaxed text-ink-soft">{t('spine.track.mixHint')}</p>
                </>
              )}
            </Section>

            {/* (c) Skins — only when the skeleton actually has more than one */}
            {skins.length > 1 ? (
              <Section title={t('spine.section.skins')} open={open.skins} onToggle={() => toggle('skins')}>
                <fieldset className="rounded border border-line/70 p-2">
                  <legend className="px-1 ad-label text-ink-soft">{t('spine.skins.legend')}</legend>
                  <p className="mt-1 font-mono text-[12px] leading-relaxed text-ink-soft">{t('spine.skins.hint')}</p>
                  {skins.map((name) => (
                    <label key={name} className="flex items-center gap-1.5 font-mono text-[13px] text-ink-soft">
                      <input
                        type="checkbox"
                        checked={selectedSkins.includes(name)}
                        onChange={() => {
                          const next = toggleSkin(selectedSkins, name, skins);
                          setSelectedSkins(next);
                          engineRef.current?.setSkins(next);
                        }}
                        className="accent-teal"
                      />
                      {name}
                    </label>
                  ))}
                </fieldset>
              </Section>
            ) : null}

            {/* (d) Debug — all default OFF */}
            <Section title={t('spine.section.debug')} open={open.debug} onToggle={() => toggle('debug')}>
              {DEBUG_KEYS.map((key) => (
                <Switch
                  key={key}
                  label={t(`spine.debug.${key}`)}
                  hint={t(`spine.debug.${key}Hint`)}
                  checked={debug[key]}
                  onChange={(b) => {
                    setDebug((d) => ({ ...d, [key]: b }));
                    engineRef.current?.setDebugFlag(key, b);
                  }}
                />
              ))}
              <p className="font-mono text-[12px] leading-relaxed text-ink-soft">{t('spine.debug.note')}</p>

              {/* Granular per-entity selection — a coherent SUPERSET of the global toggles above (those draw
                  ALL of a type; this highlights NAMED bones/attachments). Rows are native aria-pressed
                  buttons (keyboard-operable); selected rows add a border + tint (never colour alone). All
                  bone/entity names are data-derived — rendered verbatim, never translated. */}
              <div className="space-y-2 border-t border-line pt-3">
                <p className="ad-label-sm text-ink-soft">{t('spine.debug.gran.title')}</p>
                <p className="font-mono text-[12px] leading-relaxed text-ink-soft">{t('spine.debug.gran.hint')}</p>
                <label className="block font-mono text-[12px] text-ink-soft">
                  {t('spine.debug.gran.type')}
                  <select
                    value={granType}
                    aria-label={t('spine.debug.gran.type')}
                    onChange={(e) => {
                      setGranType(e.target.value as 'bones' | DebugEntityType);
                      setGranFilter('');
                    }}
                    className="mt-1 w-full rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[13px] text-ink-soft hover:border-teal focus:border-teal"
                  >
                    <option value="bones">{`${t('spine.debug.gran.bones')} (${boneNames.length})`}</option>
                    {DEBUG_ENTITY_TYPES.map((ty) => (
                      <option key={ty} value={ty}>
                        {`${t(`spine.debug.gran.${ty}`)} (${entityIndex[ty].length})`}
                      </option>
                    ))}
                  </select>
                </label>
                <input
                  type="text"
                  value={granFilter}
                  placeholder={t('spine.debug.gran.filter')}
                  aria-label={t('spine.debug.gran.filter')}
                  onChange={(e) => setGranFilter(e.target.value)}
                  className="w-full rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[13px] text-ink focus:border-teal"
                />
                {granType === 'bones' ? (
                  <>
                    <Switch
                      label={t('spine.debug.gran.showBones')}
                      checked={showBones}
                      onChange={(b) => {
                        setShowBones(b);
                        pushGranular({ showBones: b });
                      }}
                    />
                    {boneNames.length === 0 ? (
                      <p className="font-mono text-[12px] text-ink-soft">{t('spine.debug.gran.empty')}</p>
                    ) : (
                      <ul className="max-h-64 space-y-1 overflow-y-auto">
                        {filterNames(boneNames, granFilter).map((name) => (
                          <li key={name}>
                            <button
                              type="button"
                              aria-pressed={selBones.includes(name)}
                              onClick={() => {
                                const next = toggleName(selBones, name);
                                setSelBones(next);
                                pushGranular({ bones: next });
                              }}
                              className={`w-full truncate rounded border px-2 py-1 text-left font-mono text-[13px] ${
                                selBones.includes(name)
                                  ? 'border-line border-l-2 border-l-warn bg-warn/10 text-ink'
                                  : 'border-line text-ink-soft hover:border-teal'
                              }`}
                            >
                              {name}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                ) : (
                  <>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          const next = selectAllEntities(selEntities, granType, entityIndex[granType]);
                          setSelEntities(next);
                          pushGranular({ entities: next });
                        }}
                        className="rounded border border-line px-2 py-0.5 font-mono text-[12px] text-teal-text hover:border-teal"
                      >
                        {t('spine.debug.gran.all')}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const next = clearEntities(selEntities, granType);
                          setSelEntities(next);
                          pushGranular({ entities: next });
                        }}
                        className="rounded border border-line px-2 py-0.5 font-mono text-[12px] text-ink-soft hover:border-teal"
                      >
                        {t('spine.debug.gran.none')}
                      </button>
                    </div>
                    {granType === 'regionAttachments' ? (
                      <p className="font-mono text-[12px] leading-relaxed text-ink-soft">{t('spine.debug.gran.regionsHint')}</p>
                    ) : null}
                    {entityIndex[granType].length === 0 ? (
                      <p className="font-mono text-[12px] text-ink-soft">{t('spine.debug.gran.empty')}</p>
                    ) : (
                      <ul className="max-h-64 space-y-1 overflow-y-auto">
                        {filterNames(entityIndex[granType], granFilter).map((key) => (
                          <li key={key}>
                            <button
                              type="button"
                              aria-pressed={selEntities[granType].includes(key)}
                              onClick={() => {
                                const next = toggleEntity(selEntities, granType, key);
                                setSelEntities(next);
                                pushGranular({ entities: next });
                              }}
                              className={`w-full truncate rounded border px-2 py-1 text-left font-mono text-[13px] ${
                                selEntities[granType].includes(key)
                                  ? 'border-line border-l-2 border-l-teal bg-teal/10 text-ink'
                                  : 'border-line text-ink-soft hover:border-teal'
                              }`}
                            >
                              {key}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </div>
            </Section>

            {/* (e) Slots — folds the marker size + attached list + the filterable index */}
            <Section title={t('spine.section.slots')} open={open.slots} onToggle={() => toggle('slots')}>
              <label className="block font-mono text-[12px] text-ink-soft">
                {t('spine.marker.scale')} · {markerScale.toFixed(2)}×
                <input
                  type="range"
                  min={0.01}
                  max={2}
                  step={0.01}
                  value={markerScale}
                  aria-label={t('spine.marker.scale')}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setMarkerScale(v);
                    engineRef.current?.setMarkerScale(v);
                  }}
                  className="mt-1 w-full accent-teal"
                />
              </label>
              <p className="ad-label-sm text-ink-soft">{t('spine.marker.attached')}</p>
              {attached.length === 0 ? (
                <p className="font-mono text-[12px] text-ink-soft">{t('spine.marker.none')}</p>
              ) : (
                <ul className="space-y-1">
                  {attached.map((slot) => (
                    <li key={slot} className="space-y-1 rounded border border-line px-2 py-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-mono text-[13px] text-ink">{slot}</span>
                        <button
                          type="button"
                          aria-label={t('spine.marker.remove', { slot })}
                          onClick={() => {
                            engineRef.current?.removeMarker(slot);
                            setAttached((a) => a.filter((s) => s !== slot));
                            // No orphan hidden-state: a re-attached marker starts visible again.
                            setMarkerHidden((prev) => {
                              const next = new Set(prev);
                              next.delete(slot);
                              return next;
                            });
                          }}
                          className="shrink-0 rounded border border-line px-2 font-mono text-[13px] text-crit-text hover:border-crit-text"
                        >
                          ✕
                        </button>
                      </div>
                      <Switch label={t('spine.marker.visible', { slot })} checked={!markerHidden.has(slot)} onChange={(b) => onMarkerVisible(slot, b)} />
                    </li>
                  ))}
                </ul>
              )}
              <input
                type="text"
                value={slotFilter}
                placeholder={t('spine.slots.filter')}
                aria-label={t('spine.slots.filter')}
                onChange={(e) => setSlotFilter(e.target.value)}
                className="w-full rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[13px] text-ink focus:border-teal"
              />
              {filtered.length === 0 ? (
                <p className="font-mono text-[12px] text-ink-soft">{t('spine.slots.none')}</p>
              ) : (
                <ul className="max-h-64 space-y-1 overflow-y-auto">
                  {filtered.map((s) => (
                    <li key={s.name} className="flex items-center justify-between gap-2 rounded border border-line px-2 py-1">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-mono text-[13px] text-ink">{s.name}</span>
                        <span className="shrink-0 rounded bg-bg px-1.5 py-0.5 font-mono text-[10px] font-semibold text-ink-soft">{t(`spine.kind.${s.kind}`)}</span>
                      </span>
                      <button
                        type="button"
                        aria-label={t('spine.marker.attach', { slot: s.name })}
                        onClick={() => {
                          engineRef.current?.attachMarker(s.name);
                          setAttached((a) => [...a, s.name]);
                        }}
                        className="shrink-0 rounded border border-line px-2 font-mono text-[13px] text-teal-text hover:border-teal"
                      >
                        +
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </div>
        ) : null}
      </div>

      {/* Hidden native inputs — files (multi-select) + a folder fallback for browsers without the FS Access
          API. webkitdirectory/directory are spread as raw attrs (they are not in the React input prop types). */}
      <input
        ref={filesInputRef}
        type="file"
        multiple
        accept=".json,.atlas,.png,.jpg,.jpeg,.webp,.avif"
        className="hidden"
        onChange={(e) => {
          const list = e.target.files;
          if (list) void filesFromInput(list).then(doLoad);
        }}
      />
      <input
        ref={folderInputRef}
        type="file"
        className="hidden"
        {...{ webkitdirectory: '', directory: '' }}
        onChange={(e) => {
          const list = e.target.files;
          if (list) void filesFromInput(list).then(doLoad);
        }}
      />
    </div>
  );
}
