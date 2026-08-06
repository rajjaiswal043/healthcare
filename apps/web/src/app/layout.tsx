import type { Metadata } from 'next';
import { Bricolage_Grotesque, Instrument_Sans, Spline_Sans_Mono } from 'next/font/google';
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
 * next/font self-hosts these at build time, so there is no request to Google at
 * runtime — which keeps the content-security posture simple and means the app
 * renders correctly on a clinic's flaky connection.
 */
const display = Bricolage_Grotesque({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
});

const sans = Instrument_Sans({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});

const mono = Spline_Sans_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'HealthCloud — Staff Console',
  description: 'Patient registration and records for Indian clinics',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
