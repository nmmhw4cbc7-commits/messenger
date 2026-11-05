// Profile pictures are cropped to a square and re-encoded on the device.
// Re-encoding through a canvas drops all metadata (EXIF location, camera
// serial numbers) before anything is uploaded.

export async function prepareAvatar(file: File, size = 512): Promise<Blob> {
  if (!file.type.startsWith('image/')) throw new Error('Please choose a picture.');
  if (file.size > 25 * 1024 * 1024) throw new Error('This picture is too large.');
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => {
    throw new Error('This picture could not be opened.');
  });
  const side = Math.min(bitmap.width, bitmap.height);
  const sx = (bitmap.width - side) / 2;
  const sy = (bitmap.height - side) / 2;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size);
  bitmap.close();

  for (const quality of [0.86, 0.78, 0.68, 0.55]) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (blob && blob.size <= 280 * 1024) return blob;
  }
  throw new Error('This picture could not be prepared.');
}
