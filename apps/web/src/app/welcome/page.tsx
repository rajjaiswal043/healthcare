import type { Metadata } from 'next';
import { WelcomePage } from './welcome-page';

/**
 * The public landing page.
 *
 * A server file only so it can carry its own title: the page itself is all
 * client-side (queue demo, workflow stepper, role tabs), and lives next door.
 */
export const metadata: Metadata = {
  title: 'DoctorDesk',
  description: 'Patient registration and records for Indian clinics',
};

export default function Page() {
  return <WelcomePage />;
}
