// Generates a realistic photo of the finished dish.
//
// Anthropic's API does not generate images, so the photo comes from
// Pollinations — a free, keyless image-generation service with permissive
// CORS. The result is downscaled to a phone-friendly JPEG and stored as a
// data URL so it can live in localStorage and be embedded in the export.

const IMAGE_ENDPOINT = 'https://image.pollinations.ai/prompt/';
const MAX_EDGE = 1024;
const JPEG_QUALITY = 0.82;

function photographyPrompt(recipe) {
  const subject = recipe.imagePrompt || `${recipe.title}. ${recipe.description}`;
  return (
    `Professional food photography, realistic photo of ${subject} ` +
    'Beautifully plated, natural soft window light, shallow depth of field, ' +
    'appetizing, high detail, no text, no watermark, no people.'
  );
}

function buildImageUrl(recipe, seed) {
  const prompt = encodeURIComponent(photographyPrompt(recipe));
  const params = new URLSearchParams({
    width: '1024',
    height: '768',
    model: 'flux',
    nologo: 'true',
    seed: String(seed),
  });
  return `${IMAGE_ENDPOINT}${prompt}?${params}`;
}

async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read the image.'));
    reader.readAsDataURL(blob);
  });
}

/** Downscales and re-encodes to JPEG so one photo stays well under 300KB. */
async function toJpegDataUrl(blob) {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  // toDataURL can silently fall back to PNG; a PNG here means something is off
  // with JPEG encoding, and the original bytes are the safer keep.
  if (!dataUrl.startsWith('data:image/jpeg')) return blobToDataUrl(blob);
  return dataUrl;
}

/**
 * Generates a dish photo for the recipe.
 *
 * @param {object} recipe recipe in this app's shape (uses imagePrompt/title)
 * @param {{seed?: number, signal?: AbortSignal}} [options]
 *   Pass a new random seed to get a different photo of the same dish.
 * @returns {Promise<string>} a data: URL containing a JPEG
 */
export async function generateDishPhoto(recipe, { seed = Date.now() % 100000, signal } = {}) {
  let response;
  try {
    response = await fetch(buildImageUrl(recipe, seed), { signal });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new Error('Could not reach the image service — check your connection.');
  }
  if (!response.ok) throw new Error(`The image service returned an error (${response.status}).`);

  const blob = await response.blob();
  if (!blob.type.startsWith('image/')) throw new Error('The image service returned something that is not an image.');

  try {
    return await toJpegDataUrl(blob);
  } catch {
    // createImageBitmap or canvas failed; keep the original image instead.
    return blobToDataUrl(blob);
  }
}

/** Extracts the raw base64 payload of a data: URL (what Paprika stores). */
export function dataUrlToBase64(dataUrl) {
  const comma = typeof dataUrl === 'string' ? dataUrl.indexOf(',') : -1;
  return comma >= 0 ? dataUrl.slice(comma + 1) : '';
}
