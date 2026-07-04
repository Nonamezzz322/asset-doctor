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
  addTrackModel,
  defaultTracks,
  filterSlotInfos,
  removeTrackModel,
  toggleSkin,
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
  }, []);
  const onError = useCallback((key: SpineErrorKey) => setErrorKey(key), []);
  const onSlots = useCallback((next: SlotInfo[]) => setSlots(next), []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const eng = new SpineEngine({ onLoaded, onError, onSlots });
    engineRef.current = eng;
    readyRef.current = eng.init(host, { reducedMotion: reducedMotion() });
    return () => {
      eng.destroy();
      engineRef.current = null;
    };
  }, [onLoaded, onError, onSlots]);

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
      const loop = tracks.find((t) => t.index === index)?.loop ?? true;
      engineRef.current?.setTrackAnimation(index, name, loop);
    }
  };
  const onTrackLoop = (index: number, loop: boolean): void => {
    setTracks((ts) => ts.map((t) => (t.index === index ? { ...t, loop } : t)));
    const anim = tracks.find((t) => t.index === index)?.animation ?? '';
    if (anim !== '') engineRef.current?.setTrackAnimation(index, anim, loop);
  };
  const onTrackRemove = (index: number): void => {
    engineRef.current?.clearTrack(index);
    setTracks((ts) => removeTrackModel(ts, index));
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
                  <div className="space-y-2">
                    {tracks.map((track, i) => (
                      <div key={track.index} className="flex items-center gap-2 rounded border border-line px-2 py-1.5">
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
                    <li key={slot} className="flex items-center justify-between gap-2 rounded border border-line px-2 py-1">
                      <span className="truncate font-mono text-[13px] text-ink">{slot}</span>
                      <button
                        type="button"
                        aria-label={t('spine.marker.remove', { slot })}
                        onClick={() => {
                          engineRef.current?.removeMarker(slot);
                          setAttached((a) => a.filter((s) => s !== slot));
                        }}
                        className="shrink-0 rounded border border-line px-2 font-mono text-[13px] text-crit-text hover:border-crit-text"
                      >
                        ✕
                      </button>
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
