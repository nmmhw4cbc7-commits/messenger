// Renders the PNG app icons from SVG with the preinstalled Chromium.
// Usage: node scripts/icons.cjs
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const src = path.join(__dirname, 'icon-src');
const out = path.join(__dirname, '..', 'client', 'public', 'icons');
const jobs = [
  ['mark', path.join(out, 'mark.svg'), 192, 'icon-192.png', true],
  ['mark', path.join(out, 'mark.svg'), 512, 'icon-512.png', true],
  ['full', path.join(src, 'full.svg'), 180, 'apple-touch-icon.png', false],
  ['mask', path.join(src, 'maskable.svg'), 512, 'maskable-512.png', false],
  ['badge', path.join(src, 'badge.svg'), 96, 'badge-96.png', true],
];
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const [, file, size, name, transparent] of jobs) {
    const svg = fs.readFileSync(file, 'utf8');
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
    await page.screenshot({ path: path.join(out, name), omitBackground: transparent, clip: { x: 0, y: 0, width: size, height: size } });
  }
  await browser.close();
})();
