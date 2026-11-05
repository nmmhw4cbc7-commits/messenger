import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

// Writes the service worker with the exact list of build files to precache,
// and a version derived from their content, so each deploy updates cleanly.
function serviceWorker() {
  let outDir;
  return {
    name: 'haven-service-worker',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map'));
      const shell = ['/', '/manifest.webmanifest', '/icons/icon-192.png', ...files.map((f) => `/${f}`)];
      const version = createHash('sha256').update(files.sort().join('|')).digest('hex').slice(0, 12);
      const template = readFileSync(resolve('client/sw.template.js'), 'utf8');
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: template.replace('__VERSION__', version).replace('__SHELL__', JSON.stringify(shell)),
      });
    },
  };
}

export default defineConfig({
  root: 'client',
  publicDir: 'public',
  plugins: [preact(), serviceWorker()],
  build: {
    outDir: resolve('dist/client'),
    emptyOutDir: true,
    target: ['es2022', 'safari16'],
    sourcemap: false,
    // Inline assets would need a looser CSP; keep everything as files.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8080', ws: true, changeOrigin: false },
    },
  },
});
