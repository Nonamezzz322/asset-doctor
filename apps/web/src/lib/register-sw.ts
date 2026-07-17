// Service-worker registration — PRODUCTION only (a SW + Vite HMR fight in dev). Registered from the app
// root's directory (`./sw.js`), so under the GH Pages subpath the SW scope is exactly the app's subpath.
// `updateViaCache: 'none'` makes the browser always revalidate the SW script itself, so a new deploy's
// sw.js (new precache version) is picked up on the next visit — the supersede-on-deploy guarantee. Fully
// best-effort: any failure (unsupported, blocked, insecure context) is swallowed — the app runs online
// exactly as before; the SW is a pure offline/enhancement layer, never a dependency (invariant 1: it only
// caches our own shell, never user assets, and there is no off-device path).

export function registerServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  if (typeof window === 'undefined') return;
  window.addEventListener('load', () => {
    // `import.meta.url` resolves against the built entry chunk (…/assets/index-*.js), so `../sw.js` lands
    // at the app root beside index.html regardless of the deploy subpath — no hard-coded base.
    // @vite-ignore: sw.js is emitted by scripts/pwa-plugin.mjs, so Vite can't resolve it at build time —
    // it MUST stay a runtime URL relative to this entry chunk (…/assets/index-*.js → …/sw.js at the root).
    const swUrl = new URL(/* @vite-ignore */ '../sw.js', import.meta.url);
    void navigator.serviceWorker.register(swUrl, { updateViaCache: 'none' }).catch(() => {
      /* best-effort: offline is an enhancement, never required */
    });
  });
}
