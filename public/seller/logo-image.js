const INPUT_LIMIT = 8 * 1024 * 1024;
const TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

function fail(code) { return Object.assign(new Error(code), { code }); }

export function planLogoSize(width, height, max = 512) {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export async function prepareLogo(file, { max = 512, limit = 250 * 1024, env = {} } = {}) {
  if (!TYPES.has(file.type)) throw fail('unsupported_type');
  if (file.size > INPUT_LIMIT) throw fail('input_too_large');
  let bitmap;
  try {
    bitmap = await (env.createImageBitmap || globalThis.createImageBitmap)(file);
    if (!bitmap.width || !bitmap.height) throw new Error('empty image');
  } catch { throw fail('decode_failure'); }
  try {
    const canvas = env.createCanvas ? env.createCanvas() : document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    let size = planLogoSize(bitmap.width, bitmap.height, max);
    let transparent;
    for (;;) {
      canvas.width = size.width; canvas.height = size.height;
      context.drawImage(bitmap, 0, 0, size.width, size.height);
      if (transparent === undefined) {
        const pixels = context.getImageData(0, 0, size.width, size.height).data;
        transparent = false;
        for (let i = 3; i < pixels.length; i += 4) if (pixels[i] < 255) { transparent = true; break; }
      }
      const types = transparent ? ['image/png'] : ['image/webp', 'image/jpeg'];
      for (const type of types) {
        const qualities = transparent ? [undefined] : [0.92, 0.85, 0.78, 0.7, 0.6, 0.5];
        for (const quality of qualities) {
          const blob = await new Promise(resolve => canvas.toBlob(resolve, type, quality));
          if (blob && blob.type === type && blob.size > 0 && blob.size <= limit) return { blob, type, ...size };
        }
      }
      const longest = Math.max(size.width, size.height);
      if (longest <= 128) break;
      size = planLogoSize(bitmap.width, bitmap.height, Math.max(128, Math.floor(longest * 0.8)));
    }
    throw fail('cannot_compress');
  } catch (error) {
    if (error.code === 'cannot_compress') throw error;
    throw fail('decode_failure');
  } finally { bitmap.close?.(); }
}
