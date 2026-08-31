import { BadRequestException } from '@nestjs/common';

/**
 * What a file actually is, read from its first bytes.
 *
 * **Never from the filename, never from the declared Content-Type.** Both are
 * supplied by the caller and both are trivially wrong — by accident when a
 * radiographer renames a file, and on purpose when somebody uploads a script
 * called `knee.jpg`. The bytes are the only part of an upload that cannot lie
 * about what it is.
 *
 * Written by hand rather than pulled from a library. The set of formats a clinic
 * attaches is small and closed — an X-ray export or a scanned report — and the
 * signatures are four bytes each. A dependency here would be more code to audit
 * than the thing it replaces, and `file-type` is already the source of two open
 * advisories in this repository's own audit.
 *
 * Note what is deliberately NOT accepted: SVG, HTML, and anything else that a
 * browser would execute. This differs from the clinic logo, which is re-encoded
 * to PNG and so cannot carry script whatever arrives. A 25MB X-ray cannot be
 * re-encoded cheaply, so it is stored as-is — which means the type check is the
 * only defence, and it has to be a strict allow-list rather than a deny-list.
 */

export interface DetectedType {
  contentType: string;
  extension: string;
}

/**
 * The allow-list. Anything not here is refused.
 *
 * `offset` exists for WebP, whose marker sits at byte 8 after the RIFF header.
 */
const SIGNATURES: Array<{
  bytes: number[];
  offset?: number;
  contentType: string;
  extension: string;
}> = [
  { bytes: [0x25, 0x50, 0x44, 0x46], contentType: 'application/pdf', extension: '.pdf' }, // %PDF
  { bytes: [0x89, 0x50, 0x4e, 0x47], contentType: 'image/png', extension: '.png' },
  { bytes: [0xff, 0xd8, 0xff], contentType: 'image/jpeg', extension: '.jpg' },
  { bytes: [0x47, 0x49, 0x46, 0x38], contentType: 'image/gif', extension: '.gif' },
  { bytes: [0x49, 0x49, 0x2a, 0x00], contentType: 'image/tiff', extension: '.tif' }, // little-endian
  { bytes: [0x4d, 0x4d, 0x00, 0x2a], contentType: 'image/tiff', extension: '.tif' }, // big-endian
  { bytes: [0x57, 0x45, 0x42, 0x50], offset: 8, contentType: 'image/webp', extension: '.webp' },
];

export function detectFileType(bytes: Buffer): DetectedType {
  for (const signature of SIGNATURES) {
    const offset = signature.offset ?? 0;
    if (bytes.length < offset + signature.bytes.length) continue;

    const matches = signature.bytes.every((byte, i) => bytes[offset + i] === byte);
    if (matches) return { contentType: signature.contentType, extension: signature.extension };
  }

  throw new BadRequestException(
    'That file is not a type we can store. Accepted: PDF, JPEG, PNG, TIFF, WebP or GIF.',
  );
}
