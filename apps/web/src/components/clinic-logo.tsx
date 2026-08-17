/**
 * The clinic's logo.
 *
 * One default for every clinic today. Per-clinic upload is phase C of
 * docs/06-platform-onboarding-and-users-plan.md and waits on a storage module —
 * so this is the single place that will need to change when a tenant can carry
 * its own: give it a `src` prop fed from `tenant.logoObjectKey`, keep the
 * constant below as the fallback, and every surface follows.
 *
 * To swap the default image, replace apps/web/public/branding/clinic-logo.svg.
 * See the README beside it.
 */

/** The only reference to the file. Change it here to swap the image. */
const DEFAULT_LOGO = '/branding/clinic-logo.jpeg';

export function ClinicLogo({
  size = 40,
  className,
  alt = '',
}: {
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
  return (
    // A plain <img> rather than next/image on purpose: this is a fixed-size
    // static asset that also has to render inside a print stylesheet, and
    // next/image wraps it and lazy-loads it — neither of which survives
    // printing reliably.
    <img
      src={DEFAULT_LOGO}
      alt={alt}
      height={size}
      className={className}
      style={{ height: size, width: 'auto', objectFit: 'contain' }}
    />
  );
}
