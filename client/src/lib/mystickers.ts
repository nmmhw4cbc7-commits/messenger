// My own stickers (made from photos, or saved from chats). Only on this device.

import * as idb from './idb';
import { randomId } from './crypto';

const LIST = 'myStickers';
const key = (id: string) => `sticker:${id}`;
const urls = new Map<string, string>();

export type MySticker = { id: string; at: number };

export async function myStickers(): Promise<MySticker[]> {
  return (await idb.get<MySticker[]>('meta', LIST).catch(() => undefined)) ?? [];
}

export async function addMySticker(blob: Blob): Promise<string> {
  const id = randomId();
  await idb.put('files', blob, key(id));
  const list = await myStickers();
  await idb.put('meta', [{ id, at: Date.now() }, ...list].slice(0, 200), LIST);
  return id;
}

export async function removeMySticker(id: string) {
  await idb.del('files', key(id)).catch(() => {});
  await idb.put('meta', (await myStickers()).filter((s) => s.id !== id), LIST);
  const u = urls.get(id);
  if (u) URL.revokeObjectURL(u);
  urls.delete(id);
}

export async function myStickerBlob(id: string): Promise<Blob | undefined> {
  return idb.get<Blob>('files', key(id));
}

export async function myStickerUrl(id: string): Promise<string | null> {
  const known = urls.get(id);
  if (known) return known;
  const blob = await myStickerBlob(id);
  if (!blob) return null;
  const u = URL.createObjectURL(blob);
  urls.set(id, u);
  return u;
}
