'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { setUnauthorizedHandler } from '@/lib/api';
import { authApi, type Account } from '@/lib/auth';

/**
 * Who is signed in, for the whole app.
 *
 * One fetch of `/auth/me` on mount, shared by every page, rather than each page
 * asking. The distinction that matters is between "loading" and "signed out" -
 * they look identical to a component that only checks for an account, and a
 * page that renders the login form during the first fetch flashes it at
 * somebody who is already signed in.
 */

type AuthState = {
  account: Account | null;
  /** True until the first `/auth/me` settles. Not the same as signed out. */
  loading: boolean;
  /** Set when the server could not be reached at all. */
  error: string | null;
  isAdmin: boolean;
  signedIn: boolean;
  /** Re-reads the account, for after a change that alters plan or profile use. */
  refresh: () => Promise<void>;
  /** Records a sign-in that already happened, without a second round trip. */
  adopt: (account: Account) => void;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Guards against a refresh that resolves after the component is gone, which
  // React warns about and which would also overwrite a newer sign-in.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const { account: next } = await authApi.me();
      if (!alive.current) return;
      setAccount(next);
      setError(null);
    } catch (caught) {
      if (!alive.current) return;
      // Signed out is not an error - `/auth/me` answers 200 with a null
      // account for that - so anything thrown here is the backend being
      // unreachable, and saying "sign in" would send the reader to a page that
      // cannot work either.
      setAccount(null);
      setError(caught instanceof Error ? caught.message : 'Could not reach the server.');
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * A 401 from anywhere drops the account.
   *
   * Without this, a session that expired mid-session leaves the app rendering
   * a signed-in shell whose every request fails - the user sees errors on each
   * panel instead of being told, once, to sign in again.
   */
  useEffect(() => {
    setUnauthorizedHandler(() => {
      if (alive.current) setAccount(null);
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const signOut = useCallback(async () => {
    await authApi.logout();
    if (alive.current) setAccount(null);
  }, []);

  const adopt = useCallback((next: Account) => setAccount(next), []);

  const value = useMemo<AuthState>(
    () => ({
      account,
      loading,
      error,
      isAdmin: account?.role === 'admin',
      signedIn: account !== null,
      refresh,
      adopt,
      signOut,
    }),
    [account, loading, error, refresh, adopt, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used inside <AuthProvider>. It is mounted in the root layout.');
  }
  return context;
}
