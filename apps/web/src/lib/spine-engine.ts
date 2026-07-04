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

import { Application, Container, Graphics, Text, Texture } from 'pixi.js';
import {
  Spine,
  SpineTexture,
  TextureAtlas,
  AtlasAttachmentLoader,
  SkeletonJson,
  SpineDebugRenderer,
  Skin,
  Physics,
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
import { classifyAttachment, type SlotInfo } from './spine-inspect';

export interface SpineLoadResult {
  animations: string[];
  skins: string[];
  slots: SlotInfo[];
  firstAnimation: string | null;
  skeletonName: string;
}

export type SpineErrorKey = 'noJson' | 'load' | 'read';

export interface SpineCallbacks {
  onLoaded(r: SpineLoadResult): void;
  onError(key: SpineErrorKey): void;
  /** Skin-driven re-classification push: attachment kinds can change when the active skin(s) change. */
  onSlots?(slots: SlotInfo[]): void;
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
    this.app = app;
    const canvas = app.canvas as unknown as HTMLCanvasElement;
    host.appendChild(canvas);
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', host.getAttribute('aria-label') ?? 'Spine animation preview');
    // z-0 ⇒ the canvas is the BOTTOM layer. React controls (drop overlay, on-canvas islands) sit above via
    // z-10, so their clicks land on the button; a pointerdown anywhere else hits the canvas and pans (drag).
    canvas.classList.add('absolute', 'inset-0', 'z-0', 'block', 'h-full', 'w-full', 'cursor-grab', 'touch-none');
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

      this.cb.onLoaded({
        animations,
        skins,
        slots,
        firstAnimation,
        skeletonName: baseName(group.jsonName),
      });
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
  setTrackAnimation(track: number, name: string, loop: boolean): void {
    if (!this.spine) return;
    this.spine.state.setAnimation(track, name, loop);
    this.spine.state.timeScale = this.playing ? this.speed : 0; // preserve pause/speed
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
      if (this.debug) this.spine.debug = undefined; // unregisterSpine before the Spine is destroyed
      this.spine.removeSlotObjects();
      this.app?.stage.removeChild(this.spine);
      this.spine.destroy();
      this.spine = null;
    }
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
