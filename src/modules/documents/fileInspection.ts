import sharp from 'sharp';
import { badRequest } from '../../lib/errors.js';

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 40_000_000; // e.g. 8000 x 5000; stops decompression bombs

export type AllowedType = 'image/jpeg' | 'image/png' | 'application/pdf';

/** Identify the real file type from its first bytes. The extension and the browser's claim are ignored. */
export function sniffType(buf: Buffer): AllowedType | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

/** PDF features that can run code or carry other files. Identity documents never need them. */
const PDF_DANGEROUS = [/\/JavaScript\b/, /\/JS\b/, /\/Launch\b/, /\/EmbeddedFile\b/, /\/OpenAction\b/, /\/AA\b/, /\/RichMedia\b/, /\/XFA\b/];

export interface CleanFile {
  body: Buffer;
  contentType: AllowedType;
  extension: 'jpg' | 'png' | 'pdf';
  width?: number;
  height?: number;
}

/**
 * Validate and clean an upload:
 *  - JPG, PNG or PDF only, by content, max 5 MB;
 *  - images are fully decoded and re-encoded, which drops all metadata (EXIF,
 *    GPS location, XMP) and anything appended after the image data; orientation
 *    is applied first so photos are not shown sideways;
 *  - PDFs must be well-formed and are refused if they contain scripts, launch
 *    actions or embedded files. PDF metadata is not rewritten (see the Phase 3 report).
 */
export async function inspectAndClean(buf: Buffer, opts: { imagesOnly?: boolean } = {}): Promise<CleanFile> {
  if (buf.length === 0) throw badRequest('empty_file', 'The file is empty.');
  if (buf.length > MAX_UPLOAD_BYTES) throw badRequest('file_too_large', 'Files must be 5 MB or smaller.');
  const type = sniffType(buf);
  if (!type) throw badRequest('unsupported_file_type', 'Upload a JPG, PNG or PDF file.');
  if (opts.imagesOnly && type === 'application/pdf') throw badRequest('unsupported_file_type', 'Upload a photo (JPG or PNG).');

  if (type === 'application/pdf') {
    const text = buf.toString('latin1');
    if (!/%%EOF\s*$/.test(text.slice(-1024))) throw badRequest('invalid_file', 'This PDF looks damaged. Export it again and retry.');
    if (/\/Encrypt\b/.test(text)) throw badRequest('invalid_file', 'Password-protected PDFs cannot be reviewed. Upload an unprotected copy.');
    if (PDF_DANGEROUS.some((re) => re.test(text))) {
      throw badRequest('invalid_file', 'This PDF contains active content that is not allowed. Print it to a new PDF or upload a photo.');
    }
    return { body: buf, contentType: type, extension: 'pdf' };
  }

  try {
    const img = sharp(buf, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'error' }).rotate();
    const out =
      type === 'image/jpeg'
        ? await img.jpeg({ quality: 88, mozjpeg: true }).toBuffer({ resolveWithObject: true })
        : await img.png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });
    if (out.data.length > MAX_UPLOAD_BYTES) throw badRequest('file_too_large', 'Files must be 5 MB or smaller.');
    return { body: out.data, contentType: type, extension: type === 'image/jpeg' ? 'jpg' : 'png', width: out.info.width, height: out.info.height };
  } catch (err) {
    if ((err as { status?: number }).status === 400) throw err;
    throw badRequest('invalid_file', 'This image could not be read. Take the photo again and retry.');
  }
}
