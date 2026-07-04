// Imperative Pixi-v8 + spine-pixi-v8 glue for the #spine viewer. ZERO React: SpineViewer.tsx constructs one
// SpineEngine, hands it the mount host + dropped PickedFile[], and drives it through the plain method API
// below; the engine calls back with the loaded animation/skin/slot lists (or an error key). Keeping all Pixi
// state (Application, the current Spine, the marker containers, the SpineDebugRenderer) out of the React tree
// is the repo pattern — React never touches a Pixi object, so there is no reconciliation hazard.
//
// INVARIANT 1 (assets never leave the device): every byte is read from the in-memory PickedFile ArrayBuffer
// (Blob → blob.text() / createImageBitmap). No fetch, no URL, no upload — the whole load path is local.
//
// spine-pixi-v8 API (grounded against the installed 4.3.9 .d.ts — path:line cited inline):
//   new TextureAtlas(atlasText)                        — SINGLE-arg ctor (no image callback in 4.3.9)
//   page.setTexture(SpineTexture.from(pixiTexture.source))  — wire a decoded Pixi source into each atlas page
//   new AtlasAttachmentLoader(atlas, /*allowMissingRegions*/ true)
//   new SkeletonJson(loader).readSkeletonData(parsedJson)   — accepts a parsed object
//   spine.state.setAnimation(track,name,loop) / setEmptyAnimation(track,mix) / clearTrack(track) / timeScale
//   spine.state.data.defaultMix / setMix(from,to,dur)  — AnimationStateData
//   spine.skeleton.setSkin(Skin|null) / setupPoseSlots() / updateWorldTransform(Physics.update)
//   spine.skeleton.slots[i].appliedPose.getAttachment()     — Posed.appliedPose → SlotPose.getAttachment()
//   spine.debug = new SpineDebugRenderer() (registers) / spine.debug = undefined (unregisters)
//   spine.addSlotObject(slot, container) / removeSlotObject(container) / removeSlotObjects()

import { Application, Container, Graphics, Text, Texture, type Ticker } from 'pixi.js';
import {
  Spine,
  SpineTexture,
  TextureAtlas,
  AtlasAttachmentLoader,
  SkeletonJson,
  SpineDebugRenderer,
  Skin,
  Physics,
  MeshAttachment,
  RegionAttachment,
  ClippingAttachment,
  BoundingBoxAttachment,
  PathAttachment,
  type AnimationStateListener,
  type TrackEntry,
  type SkeletonData,
} from '@esotericsoftware/spine-pixi-v8';
import type { PickedFile } from './import';
import {
  modifyAtlasText,
  buildAtlasFromImages,
  groupSpineFiles,
  getTextureLineKey,
  type Dim,
  type SkeletonLike,
} from './spine-files';
import {
  classifyAttachment,
  classifyEntityType,
  emptyEntityIndex,
  addToQueue,
  clearQueue,
  removeFromQueue,
  nextQueueIndex,
  queueEntryLoop,
  trimWrapTrackTime,
  clampScrub,
  DEBUG_ENTITY_TYPES,
  type DebugEntityType,
  type EntityIndex,
  type EntitySelection,
  type SlotInfo,
} from './spine-inspect';

export interface SpineLoadResult {
  animations: string[];
  skins: string[];
  slots: SlotInfo[];
  firstAnimation: string | null;
  skeletonName: string;
  /** All bone names, in skeleton order (data-derived, rendered verbatim — the bone inspector list). */
  bones: string[];
  /** Every `slot/attachment` key per granular debug bucket, deduped, built once at load. */
  entities: EntityIndex;
}

export type SpineErrorKey = 'noJson' | 'load' | 'read';

export interface SpineCallbacks {
  onLoaded(r: SpineLoadResult): void;
  onError(key: SpineErrorKey): void;
  /** Skin-driven re-classification push: attachment kinds can change when the active skin(s) change. */
  onSlots?(slots: SlotInfo[]): void;
  /** Queue auto-advance / finish: the new cursor (-1 = no queued entry active) + its animation (null at -1). */
  onQueueIndex?(index: number, animation: string | null): void;
  /** Track-0 timeline readout (throttled to centisecond changes; duration from the live TrackEntry). */
  onTimeline?(time: number, duration: number): void;
  /** ~1 Hz FPS push from the Application ticker (real measured frames — never fabricated). */
  onFps?(fps: number): void;
}

/** The eight SpineDebugRenderer entity toggles the UI exposes. Short union ⇒ clean i18n key derivation;
 *  DEBUG_FIELD maps each to the verbatim renderer field. */
export type DebugKey = 'bones' | 'regions' | 'meshTriangles' | 'meshHull' | 'clipping' | 'boundingBoxes' | 'paths' | 'events';

const baseName = (p: string): string => p.split('/').pop() ?? p;

export class SpineEngine {
  private readonly cb: SpineCallbacks;
  private app: Application | null = null;
  private spine: Spine | null = null;
  private placeholderTex: Texture | null = null;
  /** Page textures decoded for the CURRENT skeleton — destroyed (with their GPU source) on the next reload /
   *  teardown so successive loads do not leak VRAM (each 2048² page = 16 MB; invariant 5 is about VRAM honesty). */
  private pageTextures: Texture[] = [];
  /** slot name → the INNER marker Graphics (the child whose local scale survives the per-frame
   *  setFromMatrix the engine writes onto the attached OUTER wrapper — see attachMarker). */
  private readonly markers = new Map<string, Graphics>();

  private playing = true;
  private speed = 1;
  private scaleFactor = 1;
  private markerScale = 1;
  private fitScale = 1;

  // ── Queue (playlist) — the ENGINE is authoritative (auto-advance happens inside the Pixi `complete`
  //    listener); React mirrors via onQueueIndex. The queue owns track 0 while non-empty; baseAnimation is
  //    the track-0 fallback the queue returns to when emptied (upstream semantics). ──
  private queue: string[] = [];
  private queueIndex = -1;
  private queueLoop = false;
  private baseAnimation = '';
  private completeListener: AnimationStateListener | null = null;
  /** Last user-set alpha per track — applyAnimation falls back to it so a queue advance / base resume never
   *  silently snaps a faded layer back to 1 while the React slider still shows the old value. */
  private trackAlphas = new Map<number, number>();

  // Trim sub-range loop (track 0). Wrapping happens in onTick via trimWrapTrackTime — pure, tested.
  private trim = { enabled: false, start: 0, end: 0 };

  // onTick throttles: timeline pushes only on DECIsecond change (10 Hz — a per-frame centisecond push would
  // re-render the whole inspector at 60 Hz); FPS accumulates to ~1 Hz.
  private lastTimePushed = -1;
  private lastDurPushed = -1;
  private fpsAccumMs = 0;

  // View transform (single source of truth; see applyTransform). All in Pixi SCREEN px == CSS px (autoDensity).
  private userZoom = 1; // clamped [0.1, 8]
  private userOffset = { x: 0, y: 0 }; // drag pan
  private pivotCenter = { x: 0, y: 0 }; // bounds-center, cached at fit

  // Drag state + bound pointer/wheel handlers (stored so destroy() can removeEventListener).
  private dragging = false;
  private dragLast = { x: 0, y: 0 };
  private onPointerDown!: (e: PointerEvent) => void;
  private onPointerMove!: (e: PointerEvent) => void;
  private onPointerUp!: (e: PointerEvent) => void;
  private onWheel!: (e: WheelEvent) => void;

  // Lazy debug renderer — attached only on the first enabled flag (no idle per-frame cost while all off).
  private debug: SpineDebugRenderer | null = null;
  private static readonly DEBUG_FIELD: Record<DebugKey, keyof SpineDebugRenderer> = {
    bones: 'drawBones',
    regions: 'drawRegionAttachments',
    meshTriangles: 'drawMeshTriangles',
    meshHull: 'drawMeshHull',
    clipping: 'drawClipping',
    boundingBoxes: 'drawBoundingBoxes',
    paths: 'drawPaths',
    events: 'drawEvents',
  };

  // ── Granular per-entity overlay (D3): a SECOND, independent Container added as a child of this.spine
  //    (skeleton-local coordinates — same attach point as SpineDebugRenderer's parentDebugContainer, so no
  //    manual worldTransform math). zIndex 9_999_998 keeps it just below the global overlay (9999999). ──
  private granularRoot: Container | null = null;
  private granG: {
    bones: Graphics;
    regions: Graphics;
    meshTri: Graphics;
    meshHull: Graphics;
    pathCurve: Graphics;
    pathLine: Graphics;
    bbox: Graphics;
    clip: Graphics;
  } | null = null;
  private granSel: { showBones: boolean; bones: Set<string>; ent: Record<DebugEntityType, Set<string>> } | null = null;

  /** destroy() flips this; init() re-checks it AFTER its async await so a StrictMode dev double-mount
   *  (mount → cleanup-mid-init → remount) cannot leave a zombie Application/canvas in the host. */
  private disposed = false;

  /** THE single ticker callback (one registration in init(), one removal in destroy() — one teardown path):
   *  (1) FPS accumulate → ~1 Hz push, (2) track-0 timeline read + trim wrap + throttled push, (3) granular
   *  overlay redraw. Null-guards everything, so it is safe across reloads (reset() only nulls the state). */
  private onTick = (tk: Ticker): void => {
    this.fpsAccumMs += tk.deltaMS;
    if (this.fpsAccumMs >= 1000) {
      this.fpsAccumMs = 0;
      this.cb.onFps?.(Math.round(tk.FPS));
    }
    const e = this.spine?.state.getTrack(0);
    if (e) {
      const time = e.getAnimationTime();
      const dur = e.animation ? e.animation.duration : 0;
      if (this.trim.enabled && dur > 0) {
        const nt = trimWrapTrackTime(time, e.trackTime, this.trim.start, this.trim.end);
        if (nt !== null) e.trackTime = nt;
      }
      const ds = Math.round(time * 10); // decisecond bucket — 10 Hz max push rate while playing
      if (ds !== this.lastTimePushed || dur !== this.lastDurPushed) {
        this.lastTimePushed = ds;
        this.lastDurPushed = dur;
        this.cb.onTimeline?.(time, dur);
      }
    }
    if (this.granSel && this.granularRoot) this.renderGranular();
  };

  constructor(cb: SpineCallbacks) {
    this.cb = cb;
  }

  async init(host: HTMLElement, opts: { reducedMotion: boolean }): Promise<void> {
    this.playing = !opts.reducedMotion; // reduced-motion ⇒ start paused (frame 0 posed, not auto-playing)
    const app = new Application();
    await app.init({
      resizeTo: host,
      backgroundAlpha: 0,
      antialias: true,
      preference: 'webgl',
      resolution: (typeof window !== 'undefined' && window.devicePixelRatio) || 1,
      autoDensity: true,
    });
    if (this.disposed) {
      app.destroy(); // destroy() ran while app.init() was in flight — do not mount a zombie
      return;
    }
    this.app = app;
    const canvas = app.canvas as unknown as HTMLCanvasElement;
    host.appendChild(canvas);
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', host.getAttribute('aria-label') ?? 'Spine animation preview');
    // z-0 ⇒ the canvas is the BOTTOM layer. React controls (drop overlay, on-canvas islands) sit above via
    // z-10, so their clicks land on the button; a pointerdown anywhere else hits the canvas and pans (drag).
    // pointer-events-none until a skeleton loads: before load the canvas has NO pointer job (nothing to pan),
    // so it physically cannot intercept the Open-files/Open-folder buttons in ANY stacking configuration.
    canvas.classList.add('absolute', 'inset-0', 'z-0', 'block', 'h-full', 'w-full', 'cursor-grab', 'touch-none', 'pointer-events-none');
    this.placeholderTex = this.makePlaceholder();

    // Pan/zoom listeners on the canvas itself — they work regardless of where the (separate-column) inspector
    // UI is. Drag → userOffset; wheel → userZoom (center-zoom). preventDefault on wheel ⇒ no page scroll.
    this.onPointerDown = (e) => {
      this.dragging = true;
      this.dragLast = { x: e.clientX, y: e.clientY };
      canvas.classList.add('cursor-grabbing');
      canvas.setPointerCapture?.(e.pointerId);
    };
    this.onPointerMove = (e) => {
      if (!this.dragging) return;
      this.nudge(e.clientX - this.dragLast.x, e.clientY - this.dragLast.y);
      this.dragLast = { x: e.clientX, y: e.clientY };
    };
    this.onPointerUp = () => {
      this.dragging = false;
      canvas.classList.remove('cursor-grabbing');
    };
    this.onWheel = (e) => {
      e.preventDefault();
      this.zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
    };
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointerleave', this.onPointerUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });

    // ONE ticker callback for FPS + timeline/trim + granular overlay (removed in destroy()).
    app.ticker.add(this.onTick);
  }

  /** Honest 2×2 texture wired into any atlas page whose image genuinely could not be resolved — the region
   *  still exists so the skeleton loads, but nothing is fabricated (it renders as a tiny neutral square). */
  private makePlaceholder(): Texture {
    const c = document.createElement('canvas');
    c.width = 2;
    c.height = 2;
    const ctx = c.getContext('2d');
    if (ctx) {
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.fillRect(0, 0, 2, 2);
    }
    return Texture.from(c);
  }

  async load(files: PickedFile[]): Promise<void> {
    if (!this.app) return;
    const group = groupSpineFiles(files.map((f) => f.path));
    if (!group.jsonName) {
      this.cb.onError('noJson');
      return;
    }
    // Read the skeleton JSON + (optional) atlas text + decode every image page — all from the local bytes.
    let jsonData: SkeletonLike & Record<string, unknown>;
    const textures = new Map<string, Texture>();
    const dims = new Map<string, Dim>();
    try {
      const jsonFile = files.find((f) => f.path === group.jsonName)!;
      jsonData = JSON.parse(await this.textOf(jsonFile)) as SkeletonLike & Record<string, unknown>;
      for (const name of group.imageNames) {
        const f = files.find((x) => x.path === name);
        if (!f) continue;
        const bitmap = await createImageBitmap(new Blob([f.bytes]));
        textures.set(name, Texture.from(bitmap));
        dims.set(name, { w: bitmap.width, h: bitmap.height });
      }
    } catch {
      for (const tex of textures.values()) tex.destroy(true); // free any pages decoded before the failure
      this.cb.onError('read');
      return;
    }

    try {
      const atlasText = group.atlasName
        ? await this.textOf(files.find((f) => f.path === group.atlasName)!)
        : buildAtlasFromImages(jsonData, dims);

      this.reset();
      this.pageTextures = [...textures.values()]; // own them now ⇒ freed by the next reset() even if the build throws
      const atlas = new TextureAtlas(modifyAtlasText(atlasText));
      const keys = [...textures.keys()];
      for (const page of atlas.pages) {
        const key = getTextureLineKey(page.name, keys);
        const pixiTex = (key && textures.get(key)) || this.placeholderTex!;
        page.setTexture(SpineTexture.from(pixiTex.source));
      }
      const loader = new AtlasAttachmentLoader(atlas, true);
      const skeletonData = new SkeletonJson(loader).readSkeletonData(jsonData);
      const spine = new Spine(skeletonData);
      this.spine = spine;
      this.app.stage.addChild(spine);

      const animations = skeletonData.animations.map((a) => a.name);
      const skins = skeletonData.skins.map((s) => s.name);
      const firstAnimation = animations[0] ?? null;
      const firstDuration = skeletonData.animations[0]?.duration ?? 0;

      // Fresh playback state for the fresh skeleton (reset() already cleared the previous listener/queue).
      this.baseAnimation = firstAnimation ?? '';
      this.queue = [];
      this.queueIndex = -1;
      this.trackAlphas.clear(); // React resets every track row to alpha 1 on load
      this.trim = { enabled: false, start: 0, end: firstDuration };
      this.lastTimePushed = -1;
      this.lastDurPushed = -1;

      // Queue auto-advance: a track-0 `complete` steps the cursor (pure nextQueueIndex) and starts the next
      // queued animation via applyAnimation (NOT setTrackAnimation — the public setter resets the queue).
      this.completeListener = {
        complete: (entry: TrackEntry) => {
          if (entry.trackIndex !== 0 || this.queue.length === 0) return;
          // Parked-finished (cursor === length): the LAST entry was left looping and spine-core fires
          // `complete` on EVERY loop cycle — without this guard each cycle would restart the whole queue.
          if (this.queueIndex >= this.queue.length) return;
          const next = nextQueueIndex(this.queueIndex, this.queue.length, this.queueLoop);
          this.queueIndex = next;
          if (next < this.queue.length) this.applyAnimation(0, this.queue[next]!, queueEntryLoop(next, this.queue.length, this.queueLoop));
          this.cb.onQueueIndex?.(next, next < this.queue.length ? this.queue[next]! : null);
        },
      };
      spine.state.addListener(this.completeListener);

      if (firstAnimation) this.setTrackAnimation(0, firstAnimation, true);
      // Honor the CURRENT play state on every (re)load. this.playing already encodes the reduced-motion
      // start-paused default (init: playing = !reducedMotion), so a user who pressed Play keeps playing across a
      // reload — and the React Play/Pause control never lies about a frozen frame.
      spine.state.timeScale = this.playing ? this.speed : 0;
      spine.autoUpdate = true; // Ticker.shared drives the AnimationState + Skeleton

      // Sync world transform so appliedPose is populated ⇒ classifySlots is deterministic (no rAF race).
      spine.skeleton.updateWorldTransform(Physics.update);
      const slots = this.classifySlots();

      // A fresh skeleton ⇒ a fresh view: clear any prior pan/zoom, then fit the new bounds.
      this.userOffset = { x: 0, y: 0 };
      this.userZoom = 1;
      this.fit();

      // A skeleton is on stage ⇒ the canvas now has a pointer job (drag-pan / wheel-zoom).
      (this.app.canvas as unknown as HTMLCanvasElement).classList.remove('pointer-events-none');

      this.cb.onLoaded({
        animations,
        skins,
        slots,
        firstAnimation,
        skeletonName: baseName(group.jsonName),
        bones: skeletonData.bones.map((b) => b.name),
        entities: this.classifyEntities(skeletonData),
      });
      // Seed the timeline so the scrubber renders immediately (before the first tick pushes).
      this.cb.onTimeline?.(0, firstDuration);
    } catch {
      this.cb.onError('load');
    }
  }

  private async textOf(f: PickedFile): Promise<string> {
    return new Blob([f.bytes]).text();
  }

  // ── View transform ────────────────────────────────────────────────────────
  /** The ONE place spine.pivot/position/scale are written. Final scale = fitScale × Scale-slider × userZoom;
   *  final position = screen center + drag offset; pivot = the cached bounds-center. */
  private applyTransform(): void {
    const { app, spine } = this;
    if (!app || !spine) return;
    spine.pivot.set(this.pivotCenter.x, this.pivotCenter.y);
    spine.position.set(app.screen.width / 2 + this.userOffset.x, app.screen.height / 2 + this.userOffset.y);
    spine.scale.set(this.fitScale * this.scaleFactor * this.userZoom);
  }

  /** Re-fit to the current bounds. PRESERVES userOffset/userZoom (auto-fit must not fight a panned user).
   *  Bounds are frame-dependent, so this runs one frame after a load / skin swap. */
  private fit(): void {
    const app = this.app;
    const spine = this.spine;
    if (!app || !spine) return;
    requestAnimationFrame(() => {
      if (this.app !== app || this.spine !== spine || spine.destroyed) return;
      spine.skeleton.updateWorldTransform(Physics.update);
      const b = spine.getLocalBounds();
      if (b.width <= 0 || b.height <= 0) return;
      this.pivotCenter = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      this.fitScale = Math.min(app.screen.width / b.width, app.screen.height / b.height) * 0.85;
      this.applyTransform();
    });
  }

  /** Reset/Fit button + keys 0/F: clear the user pan/zoom and re-fit. */
  resetView(): void {
    this.userOffset = { x: 0, y: 0 };
    this.userZoom = 1;
    this.fit();
  }

  /** Pan by a screen-px delta (drag move / arrow keys). */
  nudge(dx: number, dy: number): void {
    this.userOffset.x += dx;
    this.userOffset.y += dy;
    this.applyTransform();
  }

  /** Multiply the user zoom, clamped [0.1, 8] (wheel / +− keys). */
  zoomBy(mult: number): void {
    this.userZoom = Math.min(8, Math.max(0.1, this.userZoom * mult));
    this.applyTransform();
  }

  setScale(v: number): void {
    this.scaleFactor = v;
    this.applyTransform();
  }

  setPlaying(p: boolean): void {
    this.playing = p;
    if (this.spine) this.spine.state.timeScale = p ? this.speed : 0;
  }

  setSpeed(v: number): void {
    this.speed = v;
    if (this.playing && this.spine) this.spine.state.timeScale = v;
  }

  // ── Multi-track animation ──────────────────────────────────────────────────
  /** RAW setAnimation + alpha + timeScale preservation, NO queue side-effects — used by the complete-listener
   *  and the internal queue methods (D2: the public setter below would clobber the queue cursor). alpha omitted
   *  ⇒ the LAST user-set alpha for that track (trackAlphas) — a queue advance never snaps a faded layer to 1. */
  private applyAnimation(track: number, name: string, loop: boolean, alpha?: number): void {
    if (!this.spine) return;
    const e = this.spine.state.setAnimation(track, name, loop);
    e.alpha = Math.max(0, Math.min(1, alpha ?? this.trackAlphas.get(track) ?? 1));
    this.spine.state.timeScale = this.playing ? this.speed : 0; // preserve pause/speed
  }

  /** The React entry point: picking a track-0 animation defines the queue's FALLBACK base animation and
   *  resets the queue highlight (upstream: handleAnimationSelect parks queueIndex at -1). */
  setTrackAnimation(track: number, name: string, loop: boolean, alpha = 1): void {
    if (track === 0) {
      this.baseAnimation = name;
      if (this.queueIndex !== -1) {
        this.queueIndex = -1;
        this.cb.onQueueIndex?.(-1, null);
      }
    }
    this.trackAlphas.set(track, alpha);
    this.applyAnimation(track, name, loop, alpha);
  }

  /** Live per-track alpha blend (TrackEntry.alpha), clamped [0,1]; remembered so queue advances keep it. */
  setTrackAlpha(track: number, alpha: number): void {
    this.trackAlphas.set(track, alpha);
    const e = this.spine?.state.getTrack(track);
    if (e) e.alpha = Math.max(0, Math.min(1, alpha));
  }

  // ── Queue (playlist over track 0) ──────────────────────────────────────────
  /** Append to the playlist; the CURRENT base entry stops looping so its next complete hands over. The
   *  trackTime is re-phased into the current cycle first: a looping entry accumulates trackTime across
   *  cycles, and with loop=false getAnimationTime() clamps to the end — an un-phased flip would fire
   *  `complete` on the very next frame, snapping the base out mid-pose instead of finishing its cycle. */
  enqueue(name: string): void {
    this.queue = addToQueue(this.queue, name);
    const cur = this.spine?.state.getTrack(0);
    if (cur) {
      const dur = cur.animation ? cur.animation.duration : 0;
      if (cur.loop && dur > 0) cur.trackTime = cur.trackTime % dur;
      cur.loop = false;
    }
  }

  removeFromQueueAt(i: number): void {
    const r = removeFromQueue(this.queue, i, this.queueIndex);
    this.queue = r.queue;
    this.queueIndex = r.index;
    if (r.queue.length === 0 && this.baseAnimation) this.applyAnimation(0, this.baseAnimation, true);
    this.cb.onQueueIndex?.(this.queueIndex, this.queue[this.queueIndex] ?? null);
  }

  clearQueue(): void {
    this.queue = clearQueue();
    this.queueIndex = -1;
    if (this.baseAnimation) this.applyAnimation(0, this.baseAnimation, true);
    this.cb.onQueueIndex?.(-1, null);
  }

  setQueueLoop(on: boolean): void {
    this.queueLoop = on;
  }

  // ── Timeline scrub + trim + marker visibility ──────────────────────────────
  /** Jump the track-0 playhead (paused scrubbing included — timeScale 0 freezes advance, not trackTime). */
  scrub(time: number): void {
    const e = this.spine?.state.getTrack(0);
    if (!e) return;
    const dur = e.animation ? e.animation.duration : 0;
    e.trackTime = clampScrub(time, dur);
    this.cb.onTimeline?.(e.getAnimationTime(), dur); // immediate feedback while paused
  }

  setTrim(enabled: boolean, start: number, end: number): void {
    this.trim = { enabled, start, end };
  }

  /** Hide/show one attached marker. Toggles the INNER dot Graphics — Spine's per-frame updateSlotObjects
   *  unconditionally overwrites the OUTER wrapper's .visible (= slot renderability), so toggling the wrapper
   *  would be undone on the next frame; the inner child is ours alone (same pattern as markerScale). */
  setMarkerVisible(slot: string, visible: boolean): void {
    const dot = this.markers.get(slot);
    if (dot) dot.visible = visible;
  }

  setEmptyTrack(track: number, mixDuration = 0): void {
    this.spine?.state.setEmptyAnimation(track, mixDuration);
  }

  clearTrack(track: number): void {
    this.spine?.state.clearTrack(track);
  }

  setDefaultMix(seconds: number): void {
    if (this.spine) this.spine.state.data.defaultMix = seconds;
  }

  setTrackMix(from: string, to: string, seconds: number): void {
    this.spine?.state.data.setMix(from, to, seconds);
  }

  // ── Combined skins ─────────────────────────────────────────────────────────
  /** Set the active skin(s). Empty ⇒ the default/setup skin (never skin-less); one ⇒ that skin; many ⇒ a
   *  combined 'custom' Skin. Re-classifies slots (kinds can change with skin) and re-fits the new bounds. */
  setSkins(names: string[]): void {
    const sk = this.spine?.skeleton;
    if (!sk) return;
    if (names.length === 0) {
      sk.setSkin(null);
    } else if (names.length === 1) {
      sk.setSkin(sk.data.findSkin(names[0]!));
    } else {
      const custom = new Skin('custom');
      for (const n of names) {
        const s = sk.data.findSkin(n);
        if (s) custom.addSkin(s);
      }
      sk.setSkin(custom);
    }
    sk.setupPoseSlots();
    sk.updateWorldTransform(Physics.update); // sync ⇒ appliedPose is current for classifySlots
    this.cb.onSlots?.(this.classifySlots());
    this.fit();
  }

  // ── Debug renderer (lazy) ──────────────────────────────────────────────────
  private ensureDebug(): SpineDebugRenderer {
    if (!this.debug && this.spine) {
      const d = new SpineDebugRenderer();
      d.lineWidth = 2;
      // Colours mirror index.css tokens as hex ints (a WebGL canvas cannot read CSS vars).
      d.bonesColor = 0x0e8c8c; // teal
      d.skeletonXYColor = 0xe5484d; // crit
      d.regionAttachmentsColor = 0x2b8fc9; // info
      d.meshTrianglesColor = 0x1f9d63; // ok
      d.meshHullColor = 0x0e8c8c; // teal
      d.clippingPolygonColor = 0xd98a00; // warn
      d.boundingBoxesRectColor = 0xe5484d;
      d.boundingBoxesPolygonColor = 0xe5484d;
      d.boundingBoxesCircleColor = 0xe5484d; // crit
      d.pathsCurveColor = 0x2b8fc9; // info
      d.pathsLineColor = 0x9fb0bd; // film-soft
      d.eventFontColor = 0xd98a00; // warn
      d.eventFontSize = 22;
      // all draw* default false ⇒ a clean first view
      this.spine.debug = d; // registerSpine
      this.debug = d;
    }
    return this.debug!;
  }

  setDebugFlag(key: DebugKey, on: boolean): void {
    const d = this.ensureDebug();
    (d as unknown as Record<string, boolean>)[SpineEngine.DEBUG_FIELD[key]] = on;
  }

  // ── Granular per-entity debug overlay (Phase B) ────────────────────────────
  /** Build the `slot/attachment` key index per bucket, walking EVERY skin's SkinEntry list once at load.
   *  D8: keyed on slot name + the LIVE attachment name (not the skin placeholder) — the draw loop below keys
   *  identically, so linked meshes / renamed placeholders still match (a deliberate upstream-bug fix). */
  private classifyEntities(sd: SkeletonData): EntityIndex {
    const index = emptyEntityIndex();
    const seen = new Set<string>();
    for (const skin of sd.skins) {
      for (const e of skin.getAttachments()) {
        const key = `${sd.slots[e.slotIndex]?.name ?? `slot_${e.slotIndex}`}/${e.attachment.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const bucket = classifyEntityType(e.attachment);
        if (bucket) index[bucket].push(key);
      }
    }
    return index;
  }

  /** Lazy overlay graph (first setGranularSelection after each load). Mirrors SpineDebugRenderer.registerSpine:
   *  a child of the Spine (skeleton-local coords), input+AOM-inert, zIndex just below the global overlay. */
  private ensureGranularOverlay(): void {
    if (this.granularRoot || !this.spine) return;
    const root = new Container();
    root.zIndex = 9_999_998; // below SpineDebugRenderer's 9999999 — both overlays coexist without fighting
    root.eventMode = 'none';
    root.interactiveChildren = false;
    root.accessibleChildren = false;
    const g = {
      bones: new Graphics(),
      regions: new Graphics(),
      meshTri: new Graphics(),
      meshHull: new Graphics(),
      pathCurve: new Graphics(),
      pathLine: new Graphics(),
      bbox: new Graphics(),
      clip: new Graphics(),
    };
    for (const gr of Object.values(g)) root.addChild(gr);
    this.spine.addChild(root);
    this.granularRoot = root;
    this.granG = g;
  }

  /** React pushes the whole selection (show-bones flag + selected bone names + per-bucket entity keys);
   *  the shared onTick redraws every frame while a selection object exists. */
  setGranularSelection(s: { showBones: boolean; bones: string[]; entities: EntitySelection }): void {
    if (!this.spine) return;
    this.ensureGranularOverlay();
    this.granSel = {
      showBones: s.showBones,
      bones: new Set(s.bones),
      ent: Object.fromEntries(DEBUG_ENTITY_TYPES.map((k) => [k, new Set(s.entities[k])])) as Record<DebugEntityType, Set<string>>,
    };
  }

  /** Per-frame granular draw. Coordinate handling mirrors the installed SpineDebugRenderer.js verbatim (D6):
   *  the overlay is a CHILD of the Spine ⇒ computeWorldVertices output feeds poly/moveTo/lineTo directly;
   *  bones add only skeleton.x/y; stroke widths divide by |spine.scale| so they stay ~constant on screen.
   *  Every vertex is read live from the skeleton — nothing fabricated. Region "highlight" is an honest quad
   *  OUTLINE (D7): spine-pixi-v8 exposes no per-slot container, so the upstream ColorMatrixFilter brighten is
   *  unreachable — we outline instead of faking it (stated in spine.debug.gran.regionsHint). */
  private renderGranular(): void {
    const spine = this.spine;
    const sel = this.granSel;
    const g = this.granG;
    if (!spine || !sel || !g) return;
    g.bones.clear();
    g.regions.clear();
    g.meshTri.clear();
    g.meshHull.clear();
    g.pathCurve.clear();
    g.pathLine.clear();
    g.bbox.clear();
    g.clip.clear();
    const k = 1 / Math.abs(spine.scale.x || spine.scale.y || 1); // renderDebug's scale division
    const lw = 2 * k;
    const skeleton = spine.skeleton;

    // Bones — line + tip dot (D10): selected = warn line + crit tip, idle = teal. Per-bone stroke (colors
    // differ per glyph); every other type accumulates its path and strokes ONCE after the slot loop.
    if (sel.showBones) {
      for (const bone of skeleton.bones) {
        if (bone.data.name === 'root' || bone.data.parent === null) continue;
        const applied = bone.appliedPose;
        const sx = skeleton.x + applied.worldX;
        const sy = skeleton.y + applied.worldY;
        const ex = skeleton.x + bone.data.length * applied.a + applied.worldX;
        const ey = skeleton.y + bone.data.length * applied.b + applied.worldY;
        const isSel = sel.bones.has(bone.data.name);
        g.bones
          .moveTo(sx, sy)
          .lineTo(ex, ey)
          .stroke({ width: (isSel ? 3 : 2) * k, color: isSel ? 0xd98a00 : 0x0e8c8c })
          .circle(ex, ey, (isSel ? 5 : 3) * k)
          .fill({ color: isSel ? 0xe5484d : 0x0e8c8c });
      }
    }

    for (const slot of skeleton.slots) {
      if (!slot.bone.active) continue;
      const att = slot.appliedPose.getAttachment();
      if (!att) continue;
      const key = `${slot.data.name}/${att.name}`;
      if (att instanceof RegionAttachment) {
        if (!sel.ent.regionAttachments.has(key)) continue;
        const v = new Float32Array(8);
        att.computeWorldVertices(slot, att.getOffsets(slot.appliedPose), v, 0, 2); // 4.3.9 5-arg + offsets form
        g.regions.poly(Array.from(v));
      } else if (att instanceof MeshAttachment) {
        if (!sel.ent.meshes.has(key)) continue;
        const v = new Float32Array(att.worldVerticesLength);
        att.computeWorldVertices(skeleton, slot, 0, att.worldVerticesLength, v, 0, 2); // 4.3.9 7-arg form
        const tri = att.triangles;
        for (let i = 0; i < tri.length; i += 3) {
          const v1 = tri[i]! * 2;
          const v2 = tri[i + 1]! * 2;
          const v3 = tri[i + 2]! * 2;
          g.meshTri.moveTo(v[v1]!, v[v1 + 1]!).lineTo(v[v2]!, v[v2 + 1]!).lineTo(v[v3]!, v[v3 + 1]!);
        }
        let hullLength = att.hullLength;
        if (hullLength > 0) {
          hullLength = (hullLength >> 1) * 2;
          let lastX = v[hullLength - 2]!;
          let lastY = v[hullLength - 1]!;
          for (let i = 0; i < hullLength; i += 2) {
            const x = v[i]!;
            const y = v[i + 1]!;
            g.meshHull.moveTo(x, y).lineTo(lastX, lastY);
            lastX = x;
            lastY = y;
          }
        }
      } else if (att instanceof ClippingAttachment) {
        if (!sel.ent.clipping.has(key)) continue;
        const nn = att.worldVerticesLength;
        const world = new Float32Array(nn);
        att.computeWorldVertices(skeleton, slot, 0, nn, world, 0, 2);
        g.clip.poly(Array.from(world));
      } else if (att instanceof BoundingBoxAttachment) {
        // D9: per-attachment polygon via the same 7-arg call (SkeletonBounds aggregates — cannot filter to one key).
        if (!sel.ent.boundingBoxes.has(key)) continue;
        const nn = att.worldVerticesLength;
        const world = new Float32Array(nn);
        att.computeWorldVertices(skeleton, slot, 0, nn, world, 0, 2);
        g.bbox.poly(Array.from(world));
      } else if (att instanceof PathAttachment) {
        if (!sel.ent.paths.has(key)) continue;
        let nn = att.worldVerticesLength;
        const world = new Float32Array(nn);
        att.computeWorldVertices(skeleton, slot, 0, nn, world, 0, 2);
        let x1 = world[2]!;
        let y1 = world[3]!;
        let x2 = 0;
        let y2 = 0;
        if (att.closed) {
          const cx1 = world[0]!;
          const cy1 = world[1]!;
          const cx2 = world[nn - 2]!;
          const cy2 = world[nn - 1]!;
          x2 = world[nn - 4]!;
          y2 = world[nn - 3]!;
          g.pathCurve.moveTo(x1, y1).bezierCurveTo(cx1, cy1, cx2, cy2, x2, y2);
          g.pathLine.moveTo(x1, y1).lineTo(cx1, cy1).moveTo(x2, y2).lineTo(cx2, cy2);
        }
        nn -= 4;
        for (let ii = 4; ii < nn; ii += 6) {
          const cx1 = world[ii]!;
          const cy1 = world[ii + 1]!;
          const cx2 = world[ii + 2]!;
          const cy2 = world[ii + 3]!;
          x2 = world[ii + 4]!;
          y2 = world[ii + 5]!;
          g.pathCurve.moveTo(x1, y1).bezierCurveTo(cx1, cy1, cx2, cy2, x2, y2);
          g.pathLine.moveTo(x1, y1).lineTo(cx1, cy1).moveTo(x2, y2).lineTo(cx2, cy2);
          x1 = x2;
          y1 = y2;
        }
      }
    }
    // ONE stroke per Graphics after the loop (reference pattern). Colors = ensureDebug()'s token palette
    // (a WebGL canvas cannot read CSS vars — same rationale, one palette across both overlays).
    g.regions.stroke({ color: 0x2b8fc9, width: lw * 1.5 }); // info, thicker — the honest region highlight (D7)
    g.meshTri.stroke({ width: lw, color: 0x1f9d63 }); // ok
    g.meshHull.stroke({ width: lw, color: 0x0e8c8c }); // teal
    g.clip.stroke({ width: lw, color: 0xd98a00, alpha: 1 }); // warn
    g.bbox.stroke({ width: lw, color: 0xe5484d }); // crit
    g.pathCurve.stroke({ width: lw, color: 0x2b8fc9 }); // info
    g.pathLine.stroke({ width: lw, color: 0x9fb0bd }); // film-soft
  }

  // ── Slot classification ────────────────────────────────────────────────────
  private classifySlots(): SlotInfo[] {
    return (this.spine?.skeleton.slots ?? []).map((slot) => ({
      name: slot.data.name,
      kind: classifyAttachment(slot.appliedPose.getAttachment()),
    }));
  }

  attachMarker(slot: string): void {
    if (!this.spine || this.markers.has(slot)) return;
    const wrapper = new Container();
    const dot = new Graphics().circle(0, 0, 200).fill({ color: 0xffffff });
    const label = new Text({
      text: slot,
      style: {
        fontFamily: 'IBM Plex Mono, monospace',
        fontSize: 80,
        fill: 0xd98a00, // --color-warn mirrored (a WebGL canvas cannot read the CSS token)
        align: 'center',
        wordWrap: true,
        wordWrapWidth: 400,
      },
    });
    label.anchor.set(0.5);
    dot.addChild(label);
    dot.scale.set(this.markerScale); // scale the INNER child — the outer wrapper's transform is overwritten each frame
    wrapper.addChild(dot);
    this.spine.addSlotObject(slot, wrapper);
    this.markers.set(slot, dot);
  }

  removeMarker(slot: string): void {
    const dot = this.markers.get(slot);
    if (!dot || !this.spine) return;
    const wrapper = dot.parent;
    if (wrapper) {
      this.spine.removeSlotObject(wrapper);
      wrapper.destroy({ children: true });
    }
    this.markers.delete(slot);
  }

  setMarkerScale(v: number): void {
    this.markerScale = v;
    for (const dot of this.markers.values()) dot.scale.set(v);
  }

  /** Tear down the current spine + its markers + its debug renderer (a reload); keeps the Application alive. */
  reset(): void {
    if (this.spine) {
      if (this.completeListener) this.spine.state.removeListener(this.completeListener); // before the Spine dies
      if (this.debug) this.spine.debug = undefined; // unregisterSpine before the Spine is destroyed
      // Destroy the granular overlay BEFORE spine.destroy() (it is a child of the Spine); the shared onTick
      // null-guards, so no ticker unhook is needed until destroy().
      this.granularRoot?.destroy({ children: true });
      this.spine.removeSlotObjects();
      this.app?.stage.removeChild(this.spine);
      this.spine.destroy();
      this.spine = null;
    }
    this.completeListener = null;
    this.queue = [];
    this.queueIndex = -1;
    this.granularRoot = null;
    this.granG = null;
    this.granSel = null;
    this.debug = null;
    // Destroy the (now-detached) marker wrappers: removeSlotObjects() above detaches them from the Spine but
    // does NOT free their Graphics/Text GPU resources, so without this they leak once per marker × reload.
    for (const dot of this.markers.values()) (dot.parent ?? dot).destroy({ children: true });
    this.markers.clear();
    // Free each page's GPU source (Texture.destroy(true)); the Spine is already gone so nothing references them.
    // The shared 2×2 placeholderTex is created once in init() and is NOT tracked here, so it survives reloads.
    for (const tex of this.pageTextures) tex.destroy(true);
    this.pageTextures = [];
  }

  destroy(): void {
    this.disposed = true; // init() re-checks after its await — see the field comment
    this.app?.ticker.remove(this.onTick); // the single ticker callback — one registration, one removal
    const canvas = this.app?.canvas as unknown as HTMLCanvasElement | undefined;
    if (canvas) {
      canvas.removeEventListener('pointerdown', this.onPointerDown);
      canvas.removeEventListener('pointermove', this.onPointerMove);
      canvas.removeEventListener('pointerup', this.onPointerUp);
      canvas.removeEventListener('pointerleave', this.onPointerUp);
      canvas.removeEventListener('wheel', this.onWheel);
    }
    this.reset();
    if (this.app) {
      this.app.destroy();
      this.app = null;
    }
  }
}
