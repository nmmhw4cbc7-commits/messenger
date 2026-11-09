// Haven stickers: drawn as SVG in the app's dot-matrix style, so they are tiny,
// crisp at any size, and need no image files. Used in chats and on photos.

/** 5×7 dot font: each char is 7 rows of 5 bits. */
const FONT: Record<string, string> = {
  '0': '01110100011001110101110011000101110', '1': '00100011000010000100001000010001110', '2': '01110100010000100010001000100011111',
  '3': '11111000100010000010000011000101110', '4': '00010001100101010010111110001000010', '5': '11111100001111000001000011000101110',
  '6': '00110010001000011110100011000101110', '7': '11111000010001000100010000100001000', '8': '01110100011000101110100011000101110',
  '9': '01110100011000101111000010001001100', A: '01110100011000111111100011000110001', B: '11110100011000111110100011000111110',
  C: '01110100011000010000100001000101110', D: '11100100101000110001100011001011100', E: '11111100001000011110100001000011111',
  F: '11111100001000011110100001000010000', G: '01110100011000010111100011000101111', H: '10001100011000111111100011000110001',
  I: '01110001000010000100001000010001110', J: '00111000100001000010000101001001100', K: '10001100101010011000101001001010001',
  L: '10000100001000010000100001000011111', M: '10001110111010110101100011000110001', N: '10001100011100110101100111000110001',
  O: '01110100011000110001100011000101110', P: '11110100011000111110100001000010000', Q: '01110100011000110001101011001001101',
  R: '11110100011000111110101001001010001', S: '01111100001000001110000010000111110', T: '11111001000010000100001000010000100',
  U: '10001100011000110001100011000101110', V: '10001100011000110001100010101000100', W: '10001100011000110101101011010101010',
  X: '10001100010101000100010101000110001', Y: '10001100010101000100001000010000100', Z: '11111000010001000100010001000011111',
  ':': '00000011000110000000011000110000000', '!': '00100001000010000100001000000000100', '?': '01110100010000100010001000000000100',
  '%': '11000110010001000100010001001100011', '.': '00000000000000000000000000110001100', '-': '00000000000000011111000000000000000',
  ' ': '00000000000000000000000000000000000', '/': '00001000010001000100010001000010000', '+': '00000001000010011111001000010000000',
};

/** Dots for a line of text, as SVG circles. Returns the markup and its width in dots. */
function dotText(text: string, x0: number, y0: number, pitch: number, fill: string) {
  let out = '';
  let col = 0;
  for (const ch of text.toUpperCase()) {
    const bits = FONT[ch] ?? FONT[' '];
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 5; c++) {
        if (bits[r * 5 + c] === '1') out += `<circle cx="${x0 + (col + c) * pitch + pitch / 2}" cy="${y0 + r * pitch + pitch / 2}" r="${pitch * 0.42}" fill="${fill}"/>`;
      }
    }
    col += 6;
  }
  return { svg: out, cols: Math.max(0, col - 1) };
}

const INK = '#141412';
const PAPER = '#f8f7f3';
const RED = '#d71921';
const MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";

/** A dot-matrix label on a rounded card. */
function card(text: string, opts: { bg?: string; fg?: string; accent?: boolean; sub?: string } = {}) {
  const pitch = 6;
  const pad = 18;
  const t = dotText(text, 0, 0, pitch, opts.fg ?? PAPER);
  const w = Math.max(t.cols * pitch + pad * 2, opts.sub ? opts.sub.length * 8.4 + pad * 2 : 0);
  const h = 7 * pitch + pad * 2 + (opts.sub ? 20 : 0);
  const textX = (w - t.cols * pitch) / 2;
  const dot = opts.accent ? `<circle cx="${w - 13}" cy="13" r="5" fill="${RED}"/>` : '';
  const sub = opts.sub ? `<text x="${w / 2}" y="${h - 14}" text-anchor="middle" font-family="${MONO}" font-size="12" letter-spacing="2" fill="${opts.fg ?? PAPER}" opacity="0.7">${opts.sub}</text>` : '';
  return {
    w, h,
    body: `<rect width="${w}" height="${h}" rx="${Math.min(22, h / 2)}" fill="${opts.bg ?? INK}"/><g transform="translate(${textX} ${pad})">${t.svg}</g>${dot}${sub}`,
  };
}

function heart() {
  const rows = ['0110110', '1111111', '1111111', '0111110', '0011100', '0001000'];
  const p = 18;
  let dots = '';
  rows.forEach((r, y) => [...r].forEach((b, x) => { if (b === '1') dots += `<circle cx="${x * p + p / 2 + 10}" cy="${y * p + p / 2 + 10}" r="${p * 0.42}" fill="${RED}"/>`; }));
  return { w: 7 * p + 20, h: 6 * p + 20, body: dots };
}

function star() {
  const rows = ['0001000', '0001000', '0011100', '1111111', '0111110', '0110110', '1100011'];
  const p = 16;
  let dots = '';
  rows.forEach((r, y) => [...r].forEach((b, x) => { if (b === '1') dots += `<circle cx="${x * p + p / 2 + 8}" cy="${y * p + p / 2 + 8}" r="${p * 0.42}" fill="${INK}" stroke="${PAPER}" stroke-width="2"/>`; }));
  return { w: 7 * p + 16, h: 7 * p + 16, body: dots };
}

function rec() {
  const t = dotText('REC', 0, 0, 5, PAPER);
  const w = t.cols * 5 + 64;
  const h = 7 * 5 + 28;
  return { w, h, body: `<rect width="${w}" height="${h}" rx="${h / 2}" fill="${INK}"/><circle cx="24" cy="${h / 2}" r="8" fill="${RED}"/><g transform="translate(42 14)">${t.svg}</g>` };
}

export interface StickerDef {
  id: string;
  label: string;
  /** Live value at the time it is sent or placed (e.g. the time). */
  live?: () => string;
  draw: (value?: string) => { w: number; h: number; body: string };
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const DAYS_DE = ['SO', 'MO', 'DI', 'MI', 'DO', 'FR', 'SA'];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const MONTHS_DE = ['JAN', 'FEB', 'MAR', 'APR', 'MAI', 'JUN', 'JUL', 'AUG', 'SEP', 'OKT', 'NOV', 'DEZ'];
const isDe = () => { try { return (localStorage.getItem('haven.lang') ?? navigator.language).startsWith('de'); } catch { return false; } };

export const STICKERS: StickerDef[] = [
  { id: 'time', label: 'Time', live: () => { const d = new Date(); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }, draw: (v) => card(v || '12:00', { accent: true }) },
  { id: 'date', label: 'Date', live: () => { const d = new Date(); return isDe() ? `${DAYS_DE[d.getDay()]} ${pad2(d.getDate())} ${MONTHS_DE[d.getMonth()]}` : `${DAYS[d.getDay()]} ${pad2(d.getDate())} ${MONTHS[d.getMonth()]}`; }, draw: (v) => card(v || 'MON 01 JAN', { bg: PAPER, fg: INK }) },
  { id: 'haven', label: 'Haven', draw: () => card('HAVEN', { accent: true, sub: 'END-TO-END' }) },
  { id: 'heart', label: 'Heart', draw: heart },
  { id: 'rec', label: 'Rec', draw: rec },
  { id: 'gm', label: 'Good morning', draw: () => card('GM', { bg: PAPER, fg: INK, sub: isDe() ? 'GUTEN MORGEN' : 'GOOD MORNING' }) },
  { id: 'gn', label: 'Good night', draw: () => card('GN', { sub: isDe() ? 'GUTE NACHT' : 'GOOD NIGHT' }) },
  { id: 'lol', label: 'LOL', draw: () => card('LOL', { bg: RED, fg: PAPER }) },
  { id: 'omg', label: 'OMG', draw: () => card('OMG', { accent: true }) },
  { id: 'brb', label: 'BRB', draw: () => card('BRB', { bg: PAPER, fg: INK }) },
  { id: 'ok', label: 'OK', draw: () => card('OK!', { bg: RED, fg: PAPER }) },
  { id: 'wtf', label: '?!', draw: () => card('?!', { bg: PAPER, fg: RED }) },
  { id: 'vlog', label: 'Vlog', draw: () => card('VLOG', { accent: true, sub: 'YOUR DAY' }) },
  { id: 'mood', label: 'Mood', draw: () => card('100%', { bg: PAPER, fg: INK, sub: 'MOOD' }) },
  { id: 'star', label: 'Star', draw: star },
];

export const stickerById = (id: string) => STICKERS.find((s) => s.id === id);

/** SVG markup for a sticker (with its frozen value, e.g. the time it was sent). */
export function stickerSvg(id: string, value?: string) {
  const def = stickerById(id);
  if (!def) return null;
  const { w, h, body } = def.draw(value);
  const m = 6; // room for the outline shadow
  return {
    w: w + m * 2,
    h: h + m * 2,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${w + m * 2}" height="${h + m * 2}" viewBox="${-m} ${-m} ${w + m * 2} ${h + m * 2}"><g filter="url(#s)">${body}</g><defs><filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="1.5" stdDeviation="2" flood-opacity="0.25"/></filter></defs></svg>`,
  };
}

export function stickerUrl(id: string, value?: string): string | null {
  const s = stickerSvg(id, value);
  return s ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(s.svg)}` : null;
}
