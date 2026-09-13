'use client';

import Script from 'next/script';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useAuth } from '@/contexts/AuthContext';
import { authApi, type SignInOptions } from '@/lib/auth';

/**
 * The sign-in form.
 *
 * Two paths, and neither is a fallback for the other: whichever the server has
 * configured is offered, and an installation that has configured both shows
 * both. When it has configured NEITHER, this says so and names the variables,
 * because the alternative is a page with no way forward and no explanation.
 */

const CARD =
  'w-full max-w-md rounded-xl border border-gray-200 bg-white p-8 shadow-sm ' +
  'dark:border-gray-700 dark:bg-gray-800';
const LABEL = 'block text-sm font-medium text-gray-700 dark:text-gray-200';
const INPUT =
  'mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 ' +
  'placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 ' +
  'disabled:bg-gray-100 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:disabled:bg-gray-800';
const BUTTON =
  'w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white ' +
  'hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-400';

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: {
            client_id: string;
            callback: (response: { credential: string }) => void;
          }) => void;
          renderButton: (parent: HTMLElement, options: Record<string, unknown>) => void;
        };
      };
    };
  }
}

type Stage = 'address' | 'code';

export default function SignInPanel() {
  const { adopt } = useAuth();

  const [options, setOptions] = useState<SignInOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);

  const [stage, setStage] = useState<Stage>('address');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [googleScriptReady, setGoogleScriptReady] = useState(false);
  const googleButtonRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    authApi
      .options()
      .then(setOptions)
      .catch((caught: unknown) =>
        setOptionsError(caught instanceof Error ? caught.message : 'Could not reach the server.')
      );
  }, []);

  const signInWithGoogle = useCallback(
    async (credential: string) => {
      setBusy(true);
      setError(null);
      try {
        adopt((await authApi.google(credential)).account);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'That Google sign-in did not work.');
      } finally {
        setBusy(false);
      }
    },
    [adopt]
  );

  /**
   * Renders Google's own button.
   *
   * It has to be Google's: the credential is issued to the client id by
   * Google's own frame, so a button we drew ourselves would have nothing to
   * hand back. Both the script and the container must exist first, which is
   * what the two conditions guard.
   */
  useEffect(() => {
    if (!googleScriptReady) return;
    if (!options?.google.available) return;
    const parent = googleButtonRef.current;
    if (!parent || !window.google) return;

    window.google.accounts.id.initialize({
      client_id: options.google.clientId,
      callback: (response) => void signInWithGoogle(response.credential),
    });
    window.google.accounts.id.renderButton(parent, {
      theme: 'outline',
      size: 'large',
      width: 320,
      text: 'signin_with',
    });
  }, [googleScriptReady, options, signInWithGoogle]);

  const sendCode = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await authApi.requestCode(email);
      setNotice(result.message);
      setStage('code');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not send the code.');
    } finally {
      setBusy(false);
    }
  };

  const verifyCode = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      adopt((await authApi.verifyCode(email, code)).account);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That code did not work.');
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  const nothingConfigured =
    options !== null && !options.google.available && !options.email.available;

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 dark:bg-gray-900">
      {options?.google.available && (
        <Script
          src="https://accounts.google.com/gsi/client"
          onReady={() => setGoogleScriptReady(true)}
          strategy="afterInteractive"
        />
      )}

      <div className={CARD}>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-50">Sign in</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
          Free Tailor keeps your profiles to your own account.
        </p>

        {optionsError && (
          <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-200">
            {optionsError}
          </p>
        )}

        {nothingConfigured && (
          <div className="mt-4 rounded-lg bg-amber-50 px-3 py-3 text-sm text-amber-900 dark:bg-amber-900/30 dark:text-amber-100">
            <p className="font-medium">This server has no way to sign anybody in yet.</p>
            <p className="mt-1">
              Set <code>GOOGLE_CLIENT_ID</code> for Google sign-in, or{' '}
              <code>{options?.email.missing.join(', ') || 'SMTP_HOST, SMTP_USER, SMTP_PASS'}</code> to
              send codes by email, then restart the backend.
            </p>
          </div>
        )}

        {options?.google.available && (
          <div className="mt-6">
            <div ref={googleButtonRef} className="flex justify-center" />
            {!googleScriptReady && (
              <p className="text-center text-sm text-gray-500">Loading Google sign-in...</p>
            )}
          </div>
        )}

        {options?.google.available && options.email.available && (
          <div className="my-6 flex items-center gap-3">
            <span className="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
            <span className="text-xs uppercase tracking-wide text-gray-400">or</span>
            <span className="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
          </div>
        )}

        {options?.email.available && stage === 'address' && (
          <form onSubmit={sendCode} className="mt-4 space-y-4">
            <div>
              <label className={LABEL} htmlFor="signin-email">
                Email address
              </label>
              <input
                id="signin-email"
                type="email"
                required
                autoComplete="email"
                value={email}
                disabled={busy}
                onChange={(event) => setEmail(event.target.value)}
                className={INPUT}
                placeholder="you@example.com"
              />
            </div>
            <button type="submit" disabled={busy || !email} className={BUTTON}>
              {busy ? 'Sending...' : 'Email me a code'}
            </button>
          </form>
        )}

        {options?.email.available && stage === 'code' && (
          <form onSubmit={verifyCode} className="mt-4 space-y-4">
            <div>
              <label className={LABEL} htmlFor="signin-code">
                Six-digit code
              </label>
              <input
                id="signin-code"
                // `inputMode` and `autoComplete` together are what let a phone
                // offer the code straight from the notification.
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                maxLength={6}
                required
                autoFocus
                value={code}
                disabled={busy}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                className={`${INPUT} text-center text-2xl tracking-[0.5em]`}
                placeholder="000000"
              />
            </div>
            <button type="submit" disabled={busy || code.length !== 6} className={BUTTON}>
              {busy ? 'Checking...' : 'Sign in'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setStage('address');
                setCode('');
                setError(null);
                setNotice(null);
              }}
              className="w-full text-sm text-gray-600 hover:text-gray-900 dark:text-gray-300"
            >
              Use a different address
            </button>
          </form>
        )}

        {notice && !error && (
          <p className="mt-4 rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-800 dark:bg-blue-900/30 dark:text-blue-100">
            {notice}
          </p>
        )}
        {error && (
          <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-200">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
