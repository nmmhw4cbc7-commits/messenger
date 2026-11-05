import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import * as esbuild from 'esbuild';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

// Bundles the service worker (client/src/sw.ts) as one self-contained script,
// with the exact list of build files to precache and a version derived from
// their content, so each deploy updates cleanly.
function serviceWorker() {
  let outDir;
  let shell = [];
  let version = '';
  return {
    name: 'haven-service-worker',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map') && f !== 'index.html');
      shell = ['/', '/manifest.webmanifest', '/icons/icon-192.png', ...files.map((f) => `/${f}`)];
      version = createHash('sha256').update(files.sort().join('|')).digest('hex').slice(0, 12);
    },
    async writeBundle() {
      await esbuild.build({
        entryPoints: [resolve('client/src/sw.ts')],
        bundle: true,
        format: 'iife',
        target: ['es2022', 'safari16'],
        minify: true,
        outfile: resolve(outDir, 'sw.js'),
        define: { __VERSION__: JSON.stringify(version), __SHELL__: JSON.stringify(shell) },
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
      '/api': { target: 'https://dufmhzcqixajtneiktin.supabase.co/functions/v1', changeOrigin: true },
    },
  },
});
