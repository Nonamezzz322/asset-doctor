// Serve apps/web/dist under a path prefix to simulate a GitHub Pages project site
// (https://user.github.io/<repo>/). Used to verify the relative-base build before deploying.
// Usage: PREFIX=/asset-doctor PORT=4178 node tools/verify/serve-sub.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../../apps/web/dist', import.meta.url));
const PREFIX = process.env.PREFIX || '/asset-doctor';
const PORT = Number(process.env.PORT || 4178);

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

createServer(async (req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p.startsWith(PREFIX)) p = p.slice(PREFIX.length);
  if (p === '' || p === '/') p = '/index.html';
  const file = normalize(join(DIST, p));
  if (!file.startsWith(DIST)) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    const buf = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}).listen(PORT, () => {
  console.log(`serving ${DIST} at http://localhost:${PORT}${PREFIX}/`);
});
