'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/auth-provider';
import { WelcomePage } from './welcome/welcome-page';

/**
 * What the bare domain shows.
 *
 * thedoctordesk.in is the front door of the product, so a visitor who has never
 * heard of us gets the landing page rather than a sign-in box. Until 28 Oct
 * 2026 the root was the clinic console and an anonymous visitor was bounced
 * straight to `/login`, which answered a question nobody had asked.
 *
 * SIGNED-IN STAFF ARE SENT ON to `/home`, and that redirect is what makes the
 * whole arrangement work. The landing page carries an "Open console" button
 * pointing at `/` — it was written expecting the console to live there — so
 * without this, staff pressing it would land back on marketing. They pass
 * through instead. It also means every bookmark of the old root still reaches
 * the board.
 *
 * The page renders while the session is still being checked rather than
 * blanking. A visitor should not wait on an auth call to see what this is, and
 * the brief moment of it that staff see costs them one redirect they were
 * taking anyway.
 */
export function Landing() {
  const { session, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && session) router.replace('/home');
  }, [loading, session, router]);

  return <WelcomePage />;
}
