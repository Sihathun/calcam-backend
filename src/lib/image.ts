import sharp from 'sharp';
import { AppError } from './errors';

export type ImageKind = 'jpeg' | 'png' | 'webp' | 'heic';

/** Detects the real file type from magic bytes. The Content-Type header is never trusted. */
export function sniffImageKind(buf: Buffer): ImageKind | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12);
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return 'heic';
  }
  return null;
}

export interface ProcessedImage {
  full: Buffer;
  thumb: Buffer;
  width: number;
  height: number;
}

async function toJpeg(input: Buffer, maxDim: number, quality: number): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(input, { failOn: 'error', limitInputPixels: 100_000_000 })
    .rotate() // apply EXIF orientation before the metadata is dropped
    .resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality, mozjpeg: true })
    // sharp drops EXIF/GPS metadata unless .withMetadata() is called, so none is written.
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Resizes to at most `maxDimension` px, strips EXIF (including GPS) and re-encodes as JPEG. Also makes a thumbnail. */
export async function processImage(input: Buffer, kind: ImageKind, maxDimension: number): Promise<ProcessedImage> {
  try {
    let full: { data: Buffer; width: number; height: number };
    try {
      full = await toJpeg(input, maxDimension, 82);
    } catch (err) {
      if (kind !== 'heic') throw err;
      // Prebuilt sharp binaries usually cannot decode HEVC. Reading the metadata can succeed while the decode
      // still fails, so any failure on a HEIC file falls back to a pure-JS decoder.
      const { default: convert } = await import('heic-convert');
      const jpeg = Buffer.from(await convert({ buffer: input, format: 'JPEG', quality: 0.92 }));
      full = await toJpeg(jpeg, maxDimension, 82);
    }
    const thumb = await toJpeg(full.data, 320, 72);
    return { full: full.data, thumb: thumb.data, width: full.width, height: full.height };
  } catch {
    throw new AppError(422, 'INVALID_IMAGE', 'The image could not be read. Please try another photo.');
  }
}
