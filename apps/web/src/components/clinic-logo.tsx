import { logoUrlFor } from '@/lib/api';

/**
 * The clinic's logo.
 *
 * One component, one fallback, every surface. This was a single hard-coded file
 * until 26 Aug 2026; the comment it carried then described exactly this change,
 * and the shape held: it takes the clinic now, and the constant below is what
 * a clinic that has not uploaded one still gets.
 *
 * To swap the default image, replace the file at
 * `apps/web/public/branding/clinic-logo.svg`. See the README beside it.
 */

/**
 * The only reference to the bundled file. Change it here to swap the image.
 *
 * An SVG since 29 Sep 2026 (docs/10): a flat two-colour mark that prints
 * cleanly on a monochrome laser and needs no white chip on the screen. The
 * glossy shield JPEG it replaced was stock clip art, and carried a caduceus —
 * the staff of Hermes, god of commerce, not the Rod of Asclepius.
 */
const DEFAULT_LOGO = '/branding/clinic-logo.svg';

export interface LogoSource {
  slug: string;
  /** Null means the clinic has no logo of its own — the default applies. */
  logoVersion: string | null;
}

export function ClinicLogo({
  clinic,
  size = 40,
  className,
  alt = '',
}: {
  /**
   * Whose logo. Omitted on surfaces that genuinely have no clinic in hand,
   * which after phase B is none of them — but the parameter stays optional so
   * that a screen still renders while the session is loading, rather than
   * flashing an empty box.
   */
  clinic?: LogoSource | null | undefined;
  /**
   * HEIGHT, in pixels. Width follows the image's own proportions.
   *
   * Not a square box: a logo that is wider than it is tall would be letterboxed
   * inside one and render half the size everybody expected. Fixing the height
   * and letting the width fall out is the rule that works for a square mark, a
   * wide wordmark, and whatever a clinic sends next.
   */
  size?: number;
  className?: string;
  /**
   * Empty by default, and that is deliberate: on the prescription and the
   * waiting-room screen the clinic's name is already written next to this in
   * text, so a screen reader announcing it twice is noise. Pass a name only
   * where the logo stands alone.
   */
  alt?: string;
}) {
  const src =
    clinic && clinic.logoVersion ? logoUrlFor(clinic.slug, clinic.logoVersion) : DEFAULT_LOGO;

  return (
    // A plain <img> rather than next/image on purpose: this is a fixed-size
    // asset that also has to render inside a print stylesheet, and next/image
    // wraps it and lazy-loads it — neither of which survives printing reliably.
    // It is also cross-origin now (the API serves it), which next/image would
    // need configuring for and gains nothing from.
    <img
      src={src}
      alt={alt}
      height={size}
      className={className}
      style={{ height: size, width: 'auto', objectFit: 'contain' }}
    />
  );
}
