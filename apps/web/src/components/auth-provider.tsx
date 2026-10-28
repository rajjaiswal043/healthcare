'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { api, setUnauthorizedHandler, type CurrentSession } from '@/lib/api';
import { clearDraft } from '@/lib/registration-draft';
import { roleSignature, type RoleSignature } from '@/lib/role-signature';

type Session = CurrentSession;

interface AuthState {
  session: Session | null;
  loading: boolean;
  can: (permission: string) => boolean;
  /** Which persona the console is wearing. Never null — falls back to the house teal. */
  signature: RoleSignature;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

/**
 * Pages anybody may see, session or not.
 *
 * A public landing page was tried on 28 Oct 2026 and taken out again the same
 * day. It is not the page that was wrong — it is that the console lives at
 * `/`, and its tabs, paging and date links are all written relative to that
 * (`/?tab=...`), so giving the bare domain to marketing moved the console to
 * `/home` and put that into every URL. The clean way to have both is a
 * separate host for the app rather than a second path on this one.
 */
const PUBLIC_PATHS = ['/login'];

/**
 * Routes this provider has no business redirecting.
 *
 * It is mounted in the ROOT layout, so it sees every page in the application —
 * but it only governs the clinic console. Two other things live in this app and
 * answer to nobody here:
 *
 *   /platform  doctorsdesk.in's own console. A different realm with a different
 *              table, a different token and its own sign-in. A clinic session is
 *              meaningless to it, and bouncing it to /login sends platform staff
 *              to the wrong door.
 *   /display   a television in a waiting room. It holds a screen key, not a
 *              user session, and there is nobody there to sign in — redirecting
 *              it puts a login form on a wall in front of patients.
 *
 * Prefix-matched rather than listed exactly, so a second platform page does not
 * silently reintroduce this.
 */
const OTHER_REALMS = ['/platform', '/display'];

function governedByThisProvider(pathname: string): boolean {
  return !OTHER_REALMS.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const pathname = usePathname();

  /**
   * The clinic's name in the browser tab.
   *
   * Set imperatively rather than through Next's metadata API, because the
   * clinic is only known once /auth/me has answered and metadata is resolved on
   * the server. Left alone on the realms this provider does not govern — the
   * platform console and a waiting-room television are not this clinic.
   */
  useEffect(() => {
    if (!governedByThisProvider(pathname)) return;
    if (session?.tenant?.name) document.title = session.tenant.name;
  }, [session, pathname]);

  const load = useCallback(async () => {
    try {
      setSession(await api.me());
    } catch {
      setSession(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // No point asking who the clinic user is on a screen that has no clinic
    // user — and on the waiting-room display that would be a 401 every reload.
    if (!governedByThisProvider(pathname)) {
      setLoading(false);
      return;
    }

    void load();
  }, [load, pathname]);

  /*
   * A 401 from any call means the session ENDED — expired, revoked, or signed
   * out in another tab. Bounce to sign-in rather than leaving a shell of a page
   * that silently fails every request.
   *
   * Straight to /login, deliberately, and not to the landing page like the
   * case below: this is somebody who was working a moment ago and knows
   * exactly who they are. Showing them the product's front door would be
   * answering a question they did not ask.
   */
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setSession(null);
      if (!PUBLIC_PATHS.includes(pathname) && governedByThisProvider(pathname)) {
        router.replace('/login');
      }
    });
    return () => setUnauthorizedHandler(null);
  }, [pathname, router]);

  /*
   * ARRIVED WITHOUT A SESSION, which is a different thing from losing one.
   *
   * Nobody is signed in, so there is nowhere in the console to be.
   */
  useEffect(() => {
    if (
      !loading &&
      !session &&
      !PUBLIC_PATHS.includes(pathname) &&
      governedByThisProvider(pathname)
    ) {
      router.replace('/login');
    }
  }, [loading, session, pathname, router]);

  /**
   * A temporary password buys exactly one screen.
   *
   * Gated here rather than in the shell so it holds for every route at once,
   * including ones added later — and read from `/auth/me` rather than the login
   * response, so reloading the page does not step around it. The server is the
   * real boundary: it refuses every write from an account in this state.
   */
  useEffect(() => {
    if (
      !loading &&
      session?.mustChangePassword &&
      pathname !== '/change-password' &&
      governedByThisProvider(pathname)
    ) {
      router.replace('/change-password');
    }
  }, [loading, session, pathname, router]);

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      /**
       * Nothing of this person's work is left on the machine.
       *
       * The registration draft holds a patient's name, mobile and address for
       * somebody who has not consented to anything yet, and the front desk is a
       * shared computer. Left behind, the next receptionist to sign in would
       * open Register and find the previous one's half-typed patient already in
       * the form — which is both confusing and a disclosure nobody authorised.
       *
       * Signing out is the one moment the draft is definitely finished with: it
       * already clears on a completed registration and expires after twelve
       * hours, and this closes the case in between.
       */
      clearDraft();
      setSession(null);
      router.replace('/login');
    }
  }, [router]);

  const value = useMemo<AuthState>(
    () => ({
      session,
      loading,
      // Permission checks in the UI are for EXPERIENCE only — hiding a button
      // the user cannot use. The server re-checks every one of them; the golden
      // rule in the checklist is that the frontend is untrusted.
      can: (permission: string) => session?.permissions.includes(permission) ?? false,
      signature: roleSignature(session?.roles),
      signOut,
      refresh: load,
    }),
    [session, loading, signOut, load],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
