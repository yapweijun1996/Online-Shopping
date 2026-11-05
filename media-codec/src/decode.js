import sharp from 'sharp';
import { CODEC, CodecError, MAX_SOURCE, MAX_THUMBNAIL, MAX_PIXELS, MAX_SIDE, MIME, sha256, sourceContract } from './contract.js';
import { requireStillContainer } from './still-format.js';

sharp.cache(false);
sharp.concurrency(1);
sharp.block({ operation: ['VipsForeignLoad'] });
sharp.unblock({ operation: ['VipsForeignLoadJpegBuffer', 'VipsForeignLoadPngBuffer', 'VipsForeignLoadWebpBuffer'] });
const inputOptions = { failOn: 'warning', limitInputPixels: MAX_PIXELS, unlimited: false };

/** Trusted fixed codec policy. No file/URL input or caller-selected native options. */
export async function decodeImage(bytes, mime, digest) {
  sourceContract(bytes, mime, digest);
  requireStillContainer(bytes, mime);
  try {
    const metadata = await sharp(bytes, inputOptions).metadata();
    if (MIME[metadata.format] !== mime || !Number.isInteger(metadata.width) ||
        !Number.isInteger(metadata.height) || metadata.width > MAX_SIDE || metadata.height > MAX_SIDE ||
        metadata.width * metadata.height > MAX_PIXELS || metadata.channels > 4 ||
        metadata.depth !== 'uchar' || (metadata.pages ?? 1) !== 1 || metadata.loop !== undefined) throw 0;
    // Metadata is only a preflight. Force decompression of every actual pixel.
    const { data, info } = await sharp(bytes, inputOptions).timeout({ seconds: 3 })
      .autoOrient().ensureAlpha().raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
    if (info.channels !== 4 || info.width < 1 || info.height < 1 || info.width > MAX_SIDE ||
        info.height > MAX_SIDE || info.width * info.height > MAX_PIXELS ||
        data.length !== info.width * info.height * 4) throw 0;
    const raw = { width: info.width, height: info.height, channels: 4 };
    let imagePipeline = sharp(data, { raw }).timeout({ seconds: 3 });
    if (metadata.format === 'png') imagePipeline = imagePipeline.png({ compressionLevel: 9 });
    if (metadata.format === 'jpeg') imagePipeline = imagePipeline.jpeg({ quality: 100, chromaSubsampling: '4:4:4' });
    if (metadata.format === 'webp') imagePipeline = imagePipeline.webp({ lossless: true, effort: 3 });
    const image = await imagePipeline.toBuffer();
    if (!image.length || image.length > MAX_SOURCE) throw 0;
    // A fixed128px PNG preserves alpha and has a bounded raw raster, without a quality fallback.
    const thumbnail = await sharp(data, { raw }).timeout({ seconds: 3 })
      .resize(128, 128, { fit: 'inside', withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer();
    if (!thumbnail.length || thumbnail.length > MAX_THUMBNAIL) throw 0;
    return { version: 1, codec: CODEC, sourceSha256: digest, mime, width: info.width, height: info.height,
      imageBytes: image.length, imageSha256: sha256(image), thumbnailMime: MIME.png,
      thumbnailBytes: thumbnail.length, thumbnailSha256: sha256(thumbnail), image, thumbnail };
  } catch { throw new CodecError(); }
}
