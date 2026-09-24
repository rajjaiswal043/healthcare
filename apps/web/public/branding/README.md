# Clinic branding

## The default logo

    apps/web/public/branding/clinic-logo.jpeg     ← live, 156 × 148, colour

Overwrite that file and every clinic picks it up on the next page load. Nothing
to rebuild, nothing to re-seed, no database change — it is served straight from
`/branding/clinic-logo.jpeg`.

Changing the FORMAT means one edit: the constant at the top of
`apps/web/src/components/clinic-logo.tsx`. There is exactly one reference to the
file anywhere in the codebase, on purpose.

Two things follow from this being a JPEG rather than a PNG or an SVG:

- **No transparency.** Its own background paints as a solid rectangle. The
  waiting-room screen therefore sets it on a deliberate white chip, so that reads
  as a badge rather than as a mistake.
- **Fixed resolution.** At 156 px wide it is comfortable on screen and close to
  the floor for print: a 14 mm logo at 300 dpi wants about 165 px. It will look
  acceptable, not crisp. If a clinic ever complains about the printed
  prescription, a 512 px version is the fix.

## What it has to survive

This file is used in two places today, and they pull in opposite directions:

| Where                | Rendered at | The constraint                                                     |
| -------------------- | ----------- | ------------------------------------------------------------------ |
| Printed prescription | ~14 mm tall | Usually a **monochrome laser**. Mid-tone colour becomes flat grey. |
| Waiting-room screen  | ~40 px tall | On a **dark background**, viewed from across a room.               |

The current file is colour, so check it twice before a clinic sees it: print a
prescription on a **monochrome** printer, and look at the waiting-room screen
from four metres. A logo that depends on hue to be legible turns to grey mush at
14 mm on a mono laser.

**Recommended for a replacement:** 512 px on the long edge, PNG with a
transparent background if you have one — transparency removes the need for the
white chip on the dark screen and prints cleaner.

Height is what the layout fixes; width follows the image's own proportions, so a
wide wordmark works as well as a square mark.

## What is still pending

This is one default for every clinic. **Per-clinic logo upload is not built** —
it is phase C of `docs/06-platform-onboarding-and-users-plan.md`, deferred by
Narveer on 17 Aug 2026 until S3 exists.

What it will need when we pick it up:

- A storage module. `STORAGE_DRIVER=local` has been in `.env` since the
  beginning and nothing implements it.
- `tenant.logoObjectKey`, already specified in the plan's data model.
- Upload validation: **PNG and JPEG only, re-encoded on upload** (Narveer's
  decision). No SVG from a clinic — this file prints on prescriptions and shows
  on a public screen, so a script-bearing SVG would be stored XSS on the most
  visible surface in the building. The SVG here is safe because we wrote it.
- Serving through the API rather than a public bucket, so a suspended or
  archived clinic's assets stop being reachable with it.
