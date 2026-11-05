import sharp from 'sharp';

export async function image(format = 'png', options = {}) {
  const { width = 24, height = 16, orientation, ...formatOptions } = options;
  let pipeline = sharp({ create: { width, height, channels: 4, background: { r: 32, g: 90, b: 180, alpha: 0.75 } } });
  if (orientation) pipeline = pipeline.withMetadata({ orientation });
  return pipeline.toFormat(format, formatOptions).toBuffer();
}
