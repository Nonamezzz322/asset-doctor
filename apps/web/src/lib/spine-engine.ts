// Imperative Pixi-v8 + spine-pixi-v8 glue for the #spine viewer. ZERO React: SpineViewer.tsx constructs one
// SpineEngine, hands it the mount host + dropped PickedFile[], and drives it through the plain method API
// below; the engine calls back with the loaded animation/skin/slot lists (or an error key). Keeping all Pixi
// state (Application, the current Spine, the marker containers) out of the React tree is the repo pattern —
// React never touches a Pixi object, so there is no reconciliation hazard.
//
// INVARIANT 1 (assets never leave the device): every byte is read from the in-memory PickedFile ArrayBuffer
// (Blob → blob.text() / createImageBitmap). No fetch, no URL, no upload — the whole load path is local.
//
// spine-pixi-v8 API (grounded against the installed 4.3.9 .d.ts):
//   new TextureAtlas(atlasText)                        — SINGLE-arg ctor (no image callback in 4.3.9)
//   page.setTexture(SpineTexture.from(pixiTexture.source))  — wire a decoded Pixi source into each atlas page
//   new AtlasAttachmentLoader(atlas, /*allowMissingRegions*/ true)
//   new SkeletonJson(loader).readSkeletonData(parsedJson)   — accepts a parsed object
//   new Spine(skeletonData)                            — ctor takes SkeletonData directly
//   spine.state.setAnimation(0, name, true) / spine.state.timeScale / spine.skeleton.setSkin(name)
//   spine.skeleton.setupPoseSlots()                    — reset slots after a skin swap (NOT setSlotsToSetupPose)
//   spine.skeleton.updateWorldTransform(Physics.update)     — the enum arg is required in 4.x
//   spine.addSlotObject(slot, container) / removeSlotObject(container) / removeSlotObjects()
//                                                      — maps the slot bone world transform onto the container each frame

import { Application, Container, Graphics, Text, Texture } from 'pixi.js';
import {
  Spine,
  SpineTexture,
  TextureAtlas,
  AtlasAttachmentLoader,
  SkeletonJson,
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

export interface SpineLoadResult {
  animations: string[];
  skins: string[];
  slots: string[];
  firstAnimation: string | null;
  skeletonName: string;
}

export type SpineErrorKey = 'noJson' | 'load' | 'read';

export interface SpineCallbacks {
  onLoaded(r: SpineLoadResult): void;
  onError(key: SpineErrorKey): void;
}

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
    canvas.classList.add('absolute', 'inset-0', 'block', 'h-full', 'w-full');
    this.placeholderTex = this.makePlaceholder();
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
      const slots = spine.skeleton.slots.map((slot) => slot.data.name);
      const firstAnimation = animations[0] ?? null;

      if (firstAnimation) spine.state.setAnimation(0, firstAnimation, true);
      // Honor the CURRENT play state on every (re)load. this.playing already encodes the reduced-motion
      // start-paused default (init: playing = !reducedMotion), so a user who pressed Play keeps playing across a
      // reload — and the React Play/Pause control never lies about a frozen frame (matches setAnimation()).
      spine.state.timeScale = this.playing ? this.speed : 0;
      spine.autoUpdate = true; // Ticker.shared drives the AnimationState + Skeleton
      this.recenter();

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

  /** Auto-fit + center. Bounds are frame-dependent, so this runs one frame after a load / skin swap, once the
   *  skeleton's world transform has been applied. Scaling around the bounds-center pivot keeps it centered as
   *  the user's Scale slider multiplies fitScale. */
  private recenter(): void {
    const app = this.app;
    const spine = this.spine;
    if (!app || !spine) return;
    requestAnimationFrame(() => {
      if (this.app !== app || this.spine !== spine || spine.destroyed) return;
      spine.skeleton.updateWorldTransform(Physics.update);
      const b = spine.getLocalBounds();
      if (b.width <= 0 || b.height <= 0) return;
      spine.pivot.set(b.x + b.width / 2, b.y + b.height / 2);
      spine.position.set(app.screen.width / 2, app.screen.height / 2);
      const fit = Math.min(app.screen.width / b.width, app.screen.height / b.height) * 0.85;
      this.fitScale = fit;
      spine.scale.set(fit * this.scaleFactor);
    });
  }

  setPlaying(p: boolean): void {
    this.playing = p;
    if (this.spine) this.spine.state.timeScale = p ? this.speed : 0;
  }

  setSpeed(v: number): void {
    this.speed = v;
    if (this.playing && this.spine) this.spine.state.timeScale = v;
  }

  setScale(v: number): void {
    this.scaleFactor = v;
    if (this.spine) this.spine.scale.set(this.fitScale * v);
  }

  setAnimation(name: string): void {
    if (!this.spine) return;
    this.spine.state.setAnimation(0, name, true);
    this.spine.state.timeScale = this.playing ? this.speed : 0;
  }

  setSkin(name: string): void {
    if (!this.spine) return;
    this.spine.skeleton.setSkin(name);
    this.spine.skeleton.setupPoseSlots();
    this.recenter();
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

  /** Tear down the current spine + its markers (a reload); keeps the Application alive. */
  reset(): void {
    if (this.spine) {
      this.spine.removeSlotObjects();
      this.app?.stage.removeChild(this.spine);
      this.spine.destroy();
      this.spine = null;
    }
    // Free each page's GPU source (Texture.destroy(true)); the Spine is already gone so nothing references them.
    // The shared 2×2 placeholderTex is created once in init() and is NOT tracked here, so it survives reloads.
    for (const tex of this.pageTextures) tex.destroy(true);
    this.pageTextures = [];
    this.markers.clear();
  }

  destroy(): void {
    this.reset();
    if (this.app) {
      this.app.destroy();
      this.app = null;
    }
  }
}
