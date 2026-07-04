// #spine view — the pixi-spine viewer in Asset Doctor's rentgen-cabinet design. React owns ONLY the shell +
// the accessible controls; all Pixi/Spine state lives in the imperative SpineEngine (lib/spine-engine.ts),
// which this component constructs once and drives through its method API. Every dropped Spine export is read
// locally (import.ts PickedFile bytes) and rendered in-browser — zero network (invariant 1). Exactly one h1
// (ad-spine-h1, the view's focus anchor). All labels via t(); data-derived animation/skin/slot names are
// rendered verbatim (never translated). Reduced-motion starts paused. Tokens only — no inline styles.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../lib/i18n';
import { filesFromDataTransfer, filesFromInput, pickFolder, supportsDirectoryPicker, type PickedFile } from '../lib/import';
import { filterSlots } from '../lib/spine-files';
import { SpineEngine, type SpineErrorKey, type SpineLoadResult } from '../lib/spine-engine';

const reducedMotion = (): boolean =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

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
  const [slots, setSlots] = useState<string[]>([]);
  const [selectedAnimation, setSelectedAnimation] = useState('');
  const [selectedSkin, setSelectedSkin] = useState('');
  const [attached, setAttached] = useState<string[]>([]);
  const [slotFilter, setSlotFilter] = useState('');
  const [playing, setPlaying] = useState(() => !reducedMotion());
  const [speed, setSpeed] = useState(1);
  const [scale, setScale] = useState(1);
  const [markerScale, setMarkerScale] = useState(1);

  const onLoaded = useCallback((r: SpineLoadResult) => {
    setLoaded(true);
    setErrorKey(null);
    setSkeletonName(r.skeletonName);
    setAnimations(r.animations);
    setSkins(r.skins);
    setSlots(r.slots);
    setSelectedAnimation(r.firstAnimation ?? '');
    setSelectedSkin(r.skins[0] ?? '');
    setAttached([]);
  }, []);
  const onError = useCallback((key: SpineErrorKey) => setErrorKey(key), []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const eng = new SpineEngine({ onLoaded, onError });
    engineRef.current = eng;
    readyRef.current = eng.init(host, { reducedMotion: reducedMotion() });
    return () => {
      eng.destroy();
      engineRef.current = null;
    };
  }, [onLoaded, onError]);

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

  const filtered = filterSlots(slots, slotFilter).filter((s) => !attached.includes(s));

  return (
    <div className="space-y-5">
      <div>
        <h1 id="ad-spine-h1" tabIndex={-1} className="ad-focus-anchor font-display text-2xl font-semibold tracking-tight text-ink">
          {t('spine.title')}
        </h1>
        <p className="mt-2 max-w-xl font-mono text-[13px] leading-relaxed text-ink-soft">{t('spine.subtitle')}</p>
      </div>

      <div className={loaded ? 'grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]' : ''}>
        {/* ── Film stage ─────────────────────────────────────────────────── */}
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

            {/* canvas mount */}
            <div
              ref={hostRef}
              role="group"
              aria-label={t('spine.stage.label')}
              className="ad-grid relative aspect-[4/3] w-full overflow-hidden rounded-[10px]"
            >
              {!loaded ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-[10px] border-2 border-dashed border-film-border p-6 text-center">
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
                // Mouse-convenience on-canvas toggle — the ACCESSIBLE toggle is the Playback panel button, so
                // this one is hidden from the AOM and the tab order (aria-hidden + tabIndex -1).
                <button
                  type="button"
                  aria-hidden="true"
                  tabIndex={-1}
                  onClick={togglePlay}
                  className="absolute bottom-2 left-2 rounded-lg border border-film-border bg-film-2 px-3 py-1.5 font-mono text-[13px] text-film-soft hover:border-film-soft"
                >
                  {playing ? '❚❚' : '▶'}
                </button>
              )}
            </div>

            {errorKey ? (
              <p role="alert" className="mt-2 px-1.5 font-mono text-[12px] text-crit-text">
                {t(`spine.error.${errorKey}`)}
              </p>
            ) : null}
            <p className="mt-3 px-1.5 font-mono text-[11px] text-film-mute">{t('dropzone.privacy')}</p>
          </div>
        </div>

        {/* ── Controls panel (post-load) ─────────────────────────────────── */}
        {loaded ? (
          <div className="space-y-4">
            {/* (a) Playback */}
            <section className="rounded-2xl border border-line bg-panel p-6 text-left">
              <h2 className="ad-label text-teal-text">{t('spine.section.playback')}</h2>
              <div className="mt-3 space-y-2">
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
              </div>
            </section>

            {/* (b) Display */}
            <section className="rounded-2xl border border-line bg-panel p-6 text-left">
              <h2 className="ad-label text-teal-text">{t('spine.section.display')}</h2>
              <div className="mt-3 space-y-2">
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
              </div>
            </section>

            {/* (c) Animation */}
            <section className="rounded-2xl border border-line bg-panel p-6 text-left">
              <h2 className="ad-label text-teal-text">{t('spine.section.animation')}</h2>
              <div className="mt-3 space-y-2">
                {animations.length === 0 ? (
                  <p className="font-mono text-[13px] text-ink-soft">{t('spine.animation.none')}</p>
                ) : (
                  <select
                    aria-label={t('spine.section.animation')}
                    value={selectedAnimation}
                    onChange={(e) => {
                      setSelectedAnimation(e.target.value);
                      engineRef.current?.setAnimation(e.target.value);
                    }}
                    className="w-full rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[13px] text-ink-soft hover:border-teal focus:border-teal"
                  >
                    {animations.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </section>

            {/* (d) Skin — only when the skeleton actually has more than one */}
            {skins.length > 1 ? (
              <section className="rounded-2xl border border-line bg-panel p-6 text-left">
                <h2 className="ad-label text-teal-text">{t('spine.section.skin')}</h2>
                <div className="mt-3 space-y-2">
                  <select
                    aria-label={t('spine.section.skin')}
                    value={selectedSkin}
                    onChange={(e) => {
                      setSelectedSkin(e.target.value);
                      engineRef.current?.setSkin(e.target.value);
                    }}
                    className="w-full rounded border border-line bg-panel px-1.5 py-0.5 font-mono text-[13px] text-ink-soft hover:border-teal focus:border-teal"
                  >
                    {skins.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </div>
              </section>
            ) : null}

            {/* (e) Slot markers */}
            <section className="rounded-2xl border border-line bg-panel p-6 text-left">
              <h2 className="ad-label text-teal-text">{t('spine.section.markers')}</h2>
              <div className="mt-3 space-y-2">
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
              </div>
            </section>

            {/* (f) Slots */}
            <section className="rounded-2xl border border-line bg-panel p-6 text-left">
              <h2 className="ad-label text-teal-text">{t('spine.section.slots')}</h2>
              <div className="mt-3 space-y-2">
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
                    {filtered.map((slot) => (
                      <li key={slot} className="flex items-center justify-between gap-2 rounded border border-line px-2 py-1">
                        <span className="truncate font-mono text-[13px] text-ink">{slot}</span>
                        <button
                          type="button"
                          aria-label={t('spine.marker.attach', { slot })}
                          onClick={() => {
                            engineRef.current?.attachMarker(slot);
                            setAttached((a) => [...a, slot]);
                          }}
                          className="shrink-0 rounded border border-line px-2 font-mono text-[13px] text-teal-text hover:border-teal"
                        >
                          +
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          </div>
        ) : null}
      </div>

      {/* Hidden native inputs — files (multi-select) + a folder fallback for browsers without the FS Access
          API. webkitdirectory/directory are spread as raw attrs (they are not in the React input prop types). */}
      <input
        ref={filesInputRef}
        type="file"
        multiple
        accept=".json,.atlas,.png,.jpg,.jpeg,.webp"
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
