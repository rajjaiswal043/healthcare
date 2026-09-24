import { createHash } from 'node:crypto';

/**
 * A short, stable, opaque version for a clinic's logo.
 *
 * Hashed rather than the raw timestamp, because this value ends up in a URL
 * that is served publicly and cached forever: the exact moment a clinic last
 * touched its settings is not something to publish. Sixteen hex characters is
 * ample for cache-busting, and this is not a security boundary — knowing the
 * version tells you nothing you could not learn by fetching the image.
 *
 * Lives in its own file because two callers need it and neither should own it:
 * `BrandingService`, which serves the public lookup, and `AuthService`, which
 * puts the same value on the session so the console can build a logo URL
 * without a second round trip.
 */
export function logoVersionOf(updatedAt: Date | null | undefined): string {
  return createHash('sha256')
    .update(updatedAt ? updatedAt.toISOString() : 'none')
    .digest('hex')
    .slice(0, 16);
}
