import { BadRequestException } from '@nestjs/common';
import sharp from 'sharp';
import type { Metadata } from 'sharp';

/**
 * Turning whatever a clinic sent into a logo we are willing to serve.
 *
 * This file is the security boundary of the whole branding feature, because of
 * where its output ends up: served from OUR origin, to a page nobody has
 * authenticated on, to anyone who asks. Everything below follows from that.
 *
 * The rule is **re-encode, never store what arrived.** Not "validate then
 * store" — decoding to raw pixels and encoding fresh PNG bytes means whatever
 * was in the original file did not survive the trip. That is what makes an
 * uploaded SVG a non-event rather than a stored-XSS vector: an SVG is a
 * document, it can carry `<script>`, and sanitising SVG is a game that gets
 * lost slowly. We decline to play it.
 *
 * The database enforces the same conclusion with a CHECK on `logo_mime_type`,
 * so a future caller that skips this file writes nothing.
 */

/** Bytes accepted from the wire, before decode. */
export const MAX_UPLOAD_BYTES = 512 * 1024;

/**
 * Bound on the DECODED image, checked before any pixels are processed.
 *
 * The upload cap alone does not protect the encoder: a few hundred kilobytes of
 * PNG can decode to hundreds of megapixels. sharp is given this limit up front
 * so the bomb is refused at parse time rather than in memory.
 */
export const MAX_DECODED_PIXELS = 40_000_000;

/**
 * The longest edge we keep.
 *
 * Clinics send photographs of their signboard. 512px is generous for something
 * rendered at 40px in a header and 56px on a television, and it is what keeps
 * "logos live in the database" an honest argument rather than one that degrades
 * with every customer.
 */
export const MAX_EDGE_PX = 512;

export const LOGO_MIME_TYPE = 'image/png';

export interface NormalisedLogo {
  bytes: Buffer;
  mimeType: typeof LOGO_MIME_TYPE;
  width: number;
  height: number;
}

/**
 * Decode, bound, re-encode.
 *
 * Throws `BadRequestException` for anything that is not an image we can render
 * — including an SVG, which sharp would otherwise happily rasterise. We reject
 * it explicitly rather than converting it, so the clinic gets "send a PNG"
 * instead of a silently different-looking logo.
 */
export async function normaliseLogo(input: Buffer): Promise<NormalisedLogo> {
  if (input.length === 0) {
    throw new BadRequestException('The logo file is empty.');
  }

  if (input.length > MAX_UPLOAD_BYTES) {
    throw new BadRequestException(
      `That logo is ${Math.round(input.length / 1024)}KB. The limit is ${MAX_UPLOAD_BYTES / 1024}KB.`,
    );
  }

  const image = sharp(input, { limitInputPixels: MAX_DECODED_PIXELS, animated: false });

  let meta: Metadata;
  try {
    meta = await image.metadata();
  } catch {
    // sharp's own error text names its internals and would be meaningless to a
    // receptionist. It is also the wrong thing to echo back from an endpoint
    // that accepts arbitrary bytes.
    throw new BadRequestException('That file is not an image we can read. PNG or JPEG, please.');
  }

  // Read the format sharp DETECTED, never the filename or the declared
  // Content-Type. This is the magic-byte check; there is no separate one.
  if (meta.format === 'svg') {
    throw new BadRequestException(
      'SVG logos are not accepted. Please send a PNG or JPEG — an SVG can carry script, ' +
        'and this image is shown on the sign-in page before anyone has signed in.',
    );
  }

  if (!meta.format || !['png', 'jpeg', 'webp', 'gif', 'avif', 'tiff'].includes(meta.format)) {
    throw new BadRequestException('That file is not an image we can read. PNG or JPEG, please.');
  }

  if (!meta.width || !meta.height) {
    throw new BadRequestException('That image has no readable dimensions.');
  }

  const output = await image
    // `inside` scales down without cropping and never scales up, so a clinic
    // with a small mark keeps it crisp instead of being blurred to fit.
    .resize({ width: MAX_EDGE_PX, height: MAX_EDGE_PX, fit: 'inside', withoutEnlargement: true })
    // Transparency is the common case for a logo, so keep the alpha channel.
    .png({ compressionLevel: 9 })
    .toBuffer({ resolveWithObject: true });

  // Belt and braces: a pathological input could in principle re-encode larger
  // than it arrived. The database has the same limit as a CHECK; failing here
  // gives the clinic a sentence instead of a constraint violation.
  if (output.data.length > MAX_UPLOAD_BYTES) {
    throw new BadRequestException(
      'That image is too detailed to store as a logo. A simpler or smaller image will work.',
    );
  }

  return {
    bytes: output.data,
    mimeType: LOGO_MIME_TYPE,
    width: output.info.width,
    height: output.info.height,
  };
}
