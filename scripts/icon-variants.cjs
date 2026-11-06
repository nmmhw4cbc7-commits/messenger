// Renders the app icon in each colour variant (black, white, red) and writes a
// manifest per variant. The default icon files are the black variant.
// Usage: node scripts/icon-variants.cjs
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const pub = path.join(__dirname, '..', 'client', 'public');
const BUBBLE = 'M256 112c-86 0-156 61-156 137 0 40 19.5 76 50.5 101L136 404l70-27c15.6 4.6 32.4 7 50 7 86 0 156-61 156-136S342 112 256 112Z M256 196a30 30 0 0 1 16 55.4V296a16 16 0 0 1-32 0v-44.6A30 30 0 0 1 256 196Z';
const VARIANTS = {
  black: { bg: '#000000', fg: '#ffffff', dot: '#d71921' },
  white: { bg: '#f2f2f2', fg: '#000000', dot: '#d71921' },
  red: { bg: '#d71921', fg: '#ffffff', dot: '#000000' },
};
const art = (v, { rx = 0, scale = 1 } = {}) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="${rx}" fill="${v.bg}"/><g transform="translate(256 256) scale(${scale}) translate(-256 -258)"><path fill="${v.fg}" fill-rule="evenodd" d="${BUBBLE}"/><circle cx="404" cy="108" r="22" fill="${v.dot}"/></g></svg>`;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const render = async (svg, size, file, transparent) => {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
    await page.screenshot({ path: file, omitBackground: transparent, clip: { x: 0, y: 0, width: size, height: size } });
  };
  for (const [name, v] of Object.entries(VARIANTS)) {
    const dir = path.join(pub, 'icons', name);
    fs.mkdirSync(dir, { recursive: true });
    await render(art(v), 180, path.join(dir, 'apple-touch-icon.png'), false);
    await render(art(v, { rx: 114 }), 192, path.join(dir, 'icon-192.png'), true);
    await render(art(v, { rx: 114 }), 512, path.join(dir, 'icon-512.png'), true);
    await render(art(v, { scale: 0.74 }), 512, path.join(dir, 'maskable-512.png'), false);
    const manifest = JSON.parse(fs.readFileSync(path.join(pub, 'manifest.webmanifest'), 'utf8'));
    manifest.icons = [
      { src: `/icons/${name}/icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: `/icons/${name}/icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: `/icons/${name}/maskable-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ];
    fs.writeFileSync(path.join(pub, `manifest-${name}.webmanifest`), JSON.stringify(manifest, null, 2) + '\n');
  }
  // Defaults (black) at the old paths.
  for (const f of ['apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'maskable-512.png']) {
    fs.copyFileSync(path.join(pub, 'icons', 'black', f), path.join(pub, 'icons', f));
  }
  fs.writeFileSync(path.join(pub, 'icons', 'mark.svg'), art(VARIANTS.black, { rx: 114 }));
  fs.writeFileSync(path.join(__dirname, 'icon-src', 'full.svg'), art(VARIANTS.black));
  fs.writeFileSync(path.join(__dirname, 'icon-src', 'maskable.svg'), art(VARIANTS.black, { scale: 0.74 }));
  await browser.close();
})();
