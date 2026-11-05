// Shared input validation helpers and JSON schema fragments.

import { webcrypto } from 'node:crypto';

export const B64URL = '^[A-Za-z0-9_-]+$';
export const ID = { type: 'string', pattern: '^[A-Za-z0-9_-]{16,40}$' };
export const PHONE_INPUT = { type: 'string', minLength: 3, maxLength: 32 };
export const PUBLIC_KEY = { type: 'string', pattern: B64URL, minLength: 87, maxLength: 87 }; // 65 raw bytes

// Characters that can be used to visually spoof text: bidirectional overrides
// and isolates, plus C0/C1 control characters. Zero-width joiners stay, emoji need them.
const SPOOF = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩‎‏؜]/g;

/** Clean a single-line display string: no control/bidi characters, single spaces, NFC. */
export function cleanLine(value, maxLength) {
  return String(value).normalize('NFC').replace(SPOOF, '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, maxLength);
}

/** True if the string is an uncompressed P-256 public key that lies on the curve. */
export async function isValidP256Key(b64, algorithm) {
  try {
    const raw = Buffer.from(b64, 'base64url');
    if (raw.length !== 65 || raw[0] !== 0x04) return false;
    const usages = algorithm === 'ECDSA' ? ['verify'] : [];
    await webcrypto.subtle.importKey('raw', raw, { name: algorithm, namedCurve: 'P-256' }, true, usages);
    return true;
  } catch {
    return false;
  }
}
