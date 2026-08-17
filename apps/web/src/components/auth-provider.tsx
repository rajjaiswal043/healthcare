'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { api, setUnauthorizedHandler, type CurrentSession } from '@/lib/api';
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

  // A 401 from any call means the session ended — expired, revoked, or signed
  // out in another tab. Bounce to sign-in rather than leaving a shell of a page
  // that silently fails every request.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setSession(null);
      if (!PUBLIC_PATHS.includes(pathname) && governedByThisProvider(pathname)) {
        router.replace('/login');
      }
    });
    return () => setUnauthorizedHandler(null);
  }, [pathname, router]);

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
