// Zero-dep PWA build plugin: emit dist/sw.js from sw.template.js with a precache list of the SHELL assets
// (index.html + the entry JS/CSS + fonts) and a VERSION = short hash of that list's content. The version
// changes iff a shipped shell chunk changes, so a new deploy always supersedes the old service worker and
// its activate step purges stale caches — the cache-invalidation safety story. Deliberately EXCLUDES the
// heavy on-demand chunks (wasm codecs, KTX transcoder, demo-data, the fix/spine lazy chunks): precaching
// megabytes most users never hit would bloat install; the SW runtime-caches them cache-first on first use.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(HERE, '..', 'sw.template.js');

// Shell = the MINIMAL set the free diagnosis needs to boot + run offline: index.html, the entry JS + its
// CSS, and the analyze worker. Everything else is runtime-cached cache-first on first use:
//   • fonts (44 @fontsource files across locales/formats) — the browser only fetches the ones the active
//     locale needs via unicode-range; precaching all of them would download megabytes most users never
//     see AND bloat the atomic install. Offline before a font is cached → the system-font fallback.
//   • the transcode wasm / avif-dec / KTX transcoder / demo-data / fix+spine lazy chunks — big, opt-in.
// Keeping the precache small also shrinks the addAll 404-blast-radius (one bad URL fails the whole install).
const SHELL_RE = [/^assets\/index-[\w-]+\.(js|css)$/, /^assets\/analyze\.worker-[\w-]+\.js$/];

export function pwaPlugin() {
  return {
    name: 'asset-doctor-pwa',
    apply: 'build',
    generateBundle(_options, bundle) {
      const emitted = Object.keys(bundle).sort();
      const shell = ['index.html', ...emitted.filter((f) => SHELL_RE.some((re) => re.test(f)))];
      // dedup + keep index.html first (the SW's navigation fallback reads PRECACHE[0]).
      const precache = [...new Set(shell)];
      const version = createHash('sha256').update(precache.join('\n')).digest('hex').slice(0, 12);

      const template = readFileSync(TEMPLATE, 'utf8');
      const sw = template
        .replace('__SW_VERSION__', version)
        .replace('__SW_PRECACHE__', JSON.stringify(precache));

      this.emitFile({ type: 'asset', fileName: 'sw.js', source: sw });
      console.log(`[pwa] sw.js v${version} · precache ${precache.length}: ${precache.join(', ')}`);
    },
  };
}
