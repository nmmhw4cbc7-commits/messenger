// Serves the built client from memory. Every file is loaded once at startup
// into an exact-match table, so a request path can never reach the disk and
// path traversal is impossible by construction.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname, sep } from 'node:path';
import { brotliCompressSync, gzipSync, constants as zlib } from 'node:zlib';
import { createHash } from 'node:crypto';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.webmanifest', '.svg', '.txt']);

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

export function loadStatic(root) {
  const files = new Map();
  if (!existsSync(root)) return files;
  for (const full of walk(root)) {
    const ext = extname(full).toLowerCase();
    const type = TYPES[ext];
    if (!type) continue;
    const urlPath = '/' + relative(root, full).split(sep).join('/');
    const raw = readFileSync(full);
    const entry = {
      type,
      raw,
      etag: `"${createHash('sha256').update(raw).digest('base64url').slice(0, 27)}"`,
      // Hashed build output never changes; everything else must be revalidated
      // so a new service worker and index.html are picked up right away.
      cache: urlPath.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    };
    if (COMPRESSIBLE.has(ext) && raw.length > 1024) {
      entry.br = brotliCompressSync(raw, { params: { [zlib.BROTLI_PARAM_QUALITY]: 11 } });
      entry.gzip = gzipSync(raw, { level: 9 });
    }
    files.set(urlPath, entry);
  }
  return files;
}

export function staticRoutes(app, root) {
  const files = loadStatic(root);
  const index = files.get('/index.html');

  app.get('/*', (request, reply) => {
    const path = request.url.split('?')[0];
    if (path.startsWith('/api/')) return reply.code(404).send({ error: 'not_found', message: 'Not found.' });
    let file = files.get(path === '/' ? '/index.html' : path);
    // Unknown paths (outside /assets) fall back to the app shell.
    if (!file && !path.startsWith('/assets/') && !extname(path)) file = index;
    if (!file) return reply.code(404).type('text/plain; charset=utf-8').send('Not found');

    reply.header('Cache-Control', file.cache).header('ETag', file.etag).header('Vary', 'Accept-Encoding');
    if (path === '/sw.js') reply.header('Service-Worker-Allowed', '/');
    if (request.headers['if-none-match'] === file.etag) return reply.code(304).send();

    const accept = String(request.headers['accept-encoding'] || '');
    reply.type(file.type);
    if (file.br && /\bbr\b/.test(accept)) return reply.header('Content-Encoding', 'br').send(file.br);
    if (file.gzip && /\bgzip\b/.test(accept)) return reply.header('Content-Encoding', 'gzip').send(file.gzip);
    return reply.send(file.raw);
  });

  return files.size;
}
