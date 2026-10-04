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
import { DEFAULT_UPLOAD_MAX_MB, readUploadMaxMb } from '@/lib/upload';
import { userMessage } from '@/lib/userMessage';

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
  /**
   * The largest PDF the server accepts, in MB - its UPLOAD_MAX_MB, served on
   * this same `/auth/me` so an upload page can say the limit and check it
   * before sending. The old fixed 10 until the first answer, and from a
   * server too old to send it.
   */
  uploadMaxMb: number;
  /**
   * Re-reads the upload cap and resolves with it - for an upload page about to
   * refuse a file on the number above, which may be from before a backend
   * restart changed UPLOAD_MAX_MB (see lib/upload.ts `pdfSizeRefusal`). Resolves
   * with the number it already had when the server cannot be asked.
   */
  refreshUploadMaxMb: () => Promise<number>;
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
  const [uploadMaxMb, setUploadMaxMb] = useState(DEFAULT_UPLOAD_MAX_MB);
  // The same number, for refreshUploadMaxMb's fallback: a callback that read
  // the state would see the value from when it was created.
  const uploadMaxMbRef = useRef(DEFAULT_UPLOAD_MAX_MB);

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
      const { account: next, uploadMaxMb: limit } = await authApi.me();
      if (!alive.current) return;
      setAccount(next);
      uploadMaxMbRef.current = readUploadMaxMb(limit);
      setUploadMaxMb(uploadMaxMbRef.current);
      setError(null);
    } catch (caught) {
      if (!alive.current) return;
      // Signed out is not an error - `/auth/me` answers 200 with a null
      // account for that - so anything thrown here is the backend being
      // unreachable, and saying "sign in" would send the reader to a page that
      // cannot work either.
      setAccount(null);
      setError(userMessage(caught, 'Could not reach the server.'));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const refreshUploadMaxMb = useCallback(async () => {
    try {
      const { uploadMaxMb: limit } = await authApi.me();
      const fresh = readUploadMaxMb(limit);
      uploadMaxMbRef.current = fresh;
      if (alive.current) setUploadMaxMb(fresh);
      return fresh;
    } catch {
      return uploadMaxMbRef.current;
    }
  }, []);

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
      uploadMaxMb,
      refreshUploadMaxMb,
      refresh,
      adopt,
      signOut,
    }),
    [account, loading, error, uploadMaxMb, refreshUploadMaxMb, refresh, adopt, signOut]
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
