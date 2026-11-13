import type { Metadata } from 'next';
import localFont from 'next/font/local';
import './globals.css';
import { AuthProvider } from '@/components/auth-provider';

/**
 * Three typefaces, each doing one job:
 *
 *   display — headings. A little character where the eye lands first.
 *   sans    — body and UI. Chosen for legibility at 13-15px, which is where
 *             this interface actually lives.
 *   mono    — UHIDs, mobile numbers, labels. Anything that must align in a
 *             column or be read digit by digit.
 *
 * The files live in src/fonts and are served from our own origin, so there is
 * no request to Google at runtime — which keeps the content-security posture
 * simple and means the app renders correctly on a clinic's flaky connection.
 *
 * Committed rather than fetched by next/font/google at BUILD time, since
 * 13 Nov 2026: Google served Netlify's US builders an extensionless font URL
 * for one family, next/font crashed parsing it, and the deploy failed. The
 * same build passed from India. A build should not depend on what a third
 * party decides to serve that day. Latin subset, variable weight axis — the
 * same files the google loader was downloading.
 */
const display = localFont({
  src: '../fonts/bricolage-grotesque-latin.woff2',
  weight: '200 800',
  variable: '--font-display',
  display: 'swap',
});

const sans = localFont({
  src: '../fonts/instrument-sans-latin.woff2',
  weight: '400 700',
  variable: '--font-sans',
  display: 'swap',
});

const mono = localFont({
  src: '../fonts/spline-sans-mono-latin.woff2',
  weight: '300 700',
  variable: '--font-mono',
  display: 'swap',
  fallback: ['ui-monospace', 'monospace'],
  adjustFontFallback: false,
});

/**
 * The title before a session exists.
 *
 * Neutral rather than ours: under full white-label a clinic never meets our
 * name, and the browser tab is somewhere they look all day. `AuthProvider`
 * replaces this with the clinic's own name as soon as the session loads.
 */
export const metadata: Metadata = {
  title: 'Clinic console',
  description: 'Patient registration and records for Indian clinics',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    /**
     * `suppressHydrationWarning` is for browser extensions, not for us.
     *
     * QuillBot (and others) stamp attributes onto <html> before React loads —
     * `data-qb-installed`, and ironically a lowercase `suppresshydrationwarning`
     * of their own that React ignores. React then sees attributes the server
     * never sent and reports a mismatch, which in the worst case costs the page
     * its event handlers: buttons render and do nothing.
     *
     * This suppresses the check for THIS ELEMENT'S attributes only — not its
     * children, and not any mismatch inside the app. The cost is that a genuine
     * attribute mismatch we introduced on <html> would go unreported; we set
     * none, which is what makes the trade acceptable.
     */
    <html
      lang="en-IN"
      suppressHydrationWarning
      className={`${display.variable} ${sans.variable} ${mono.variable}`}
    >
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
