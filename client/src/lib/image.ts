// Profile pictures are cropped to a square and re-encoded on the device.
// Re-encoding through a canvas drops all metadata (EXIF location, camera
// serial numbers) before anything is uploaded.

export async function openPicture(file: File): Promise<ImageBitmap> {
  if (!file.type.startsWith('image/')) throw new Error('Please choose a picture.');
  if (file.size > 25 * 1024 * 1024) throw new Error('This picture is too large.');
  return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => {
    throw new Error('This picture could not be opened.');
  });
}

/** A square region of the picture, in its own pixels. */
export type Crop = { sx: number; sy: number; side: number };

export async function prepareAvatar(file: File, size = 512): Promise<Blob> {
  return renderAvatar(await openPicture(file), null, size);
}

/** Cut the crop out of the picture (centre square by default) and encode it as JPEG. Closes the bitmap. */
export async function renderAvatar(bitmap: ImageBitmap, crop: Crop | null, size = 512): Promise<Blob> {
  const side = crop?.side ?? Math.min(bitmap.width, bitmap.height);
  const sx = crop?.sx ?? (bitmap.width - side) / 2;
  const sy = crop?.sy ?? (bitmap.height - side) / 2;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  const k = size / side; // output px per picture px
  const covers = sx >= 0 && sy >= 0 && sx + side <= bitmap.width && sy + side <= bitmap.height;
  if (!covers) {
    // Zoomed out: fill the square with a blurred copy of the picture first.
    // (Drawing it tiny and scaling it back up blurs it, and works in every browser.)
    const small = document.createElement('canvas');
    small.width = small.height = 24;
    const sctx = small.getContext('2d')!;
    const cover = Math.min(bitmap.width, bitmap.height);
    sctx.drawImage(bitmap, (bitmap.width - cover) / 2, (bitmap.height - cover) / 2, cover, cover, 0, 0, 24, 24);
    ctx.drawImage(small, -size * 0.05, -size * 0.05, size * 1.1, size * 1.1);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.12)';
    ctx.fillRect(0, 0, size, size);
  }
  ctx.drawImage(bitmap, -sx * k, -sy * k, bitmap.width * k, bitmap.height * k);
  bitmap.close();

  for (const quality of [0.86, 0.78, 0.68, 0.55]) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (blob && blob.size <= 280 * 1024) return blob;
  }
  throw new Error('This picture could not be prepared.');
}
