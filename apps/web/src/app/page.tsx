import type { Metadata } from 'next';
import { Landing } from './landing';

/**
 * The public landing page, on the bare domain.
 *
 * A server file only so it can carry its own title — the page itself is all
 * client-side and decides between marketing and the console from the session.
 * The same split `welcome/page.tsx` makes, for the same reason.
 */
export const metadata: Metadata = {
  title: 'DoctorDesk',
  description: 'Patient registration and records for Indian clinics',
};

export default function Page() {
  return <Landing />;
}
