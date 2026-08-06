'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { api, setUnauthorizedHandler } from '@/lib/api';

interface Session {
  userId: string;
  tenantId: string;
  permissions: string[];
}

interface AuthState {
  session: Session | null;
  loading: boolean;
  can: (permission: string) => boolean;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

const PUBLIC_PATHS = ['/login'];

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
    void load();
  }, [load]);

  // A 401 from any call means the session ended — expired, revoked, or signed
  // out in another tab. Bounce to sign-in rather than leaving a shell of a page
  // that silently fails every request.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setSession(null);
      if (!PUBLIC_PATHS.includes(pathname)) router.replace('/login');
    });
    return () => setUnauthorizedHandler(null);
  }, [pathname, router]);

  useEffect(() => {
    if (!loading && !session && !PUBLIC_PATHS.includes(pathname)) {
      router.replace('/login');
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
