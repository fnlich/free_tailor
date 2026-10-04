'use client';

import Image from 'next/image';
import Script from 'next/script';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Field, Notice } from '@/components/ui/kit';
import { useAuth } from '@/contexts/AuthContext';
import { authApi, type SignInOptions } from '@/lib/auth';
import { userMessage } from '@/lib/userMessage';

/**
 * The sign-in form.
 *
 * Two paths, and neither is a fallback for the other: whichever the server has
 * configured is offered, and an installation that has configured both shows
 * both. When it has configured NEITHER, this says so and names the variables,
 * because the alternative is a page with no way forward and no explanation.
 */

/*
 * Drawn with the shared kit (.tl-card, .tl-input, .tl-button, .tl-notice) and
 * the theme tokens, like every page behind it - so the first screen anybody
 * sees is already the app's own, in both themes, rather than a grey card the
 * dark-mode shim has to repaint.
 */

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
        setOptionsError(userMessage(caught, 'Could not reach the server.'))
      );
  }, []);

  const signInWithGoogle = useCallback(
    async (credential: string) => {
      setBusy(true);
      setError(null);
      try {
        adopt((await authApi.google(credential)).account);
      } catch (caught) {
        setError(userMessage(caught, 'That Google sign-in did not work.'));
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
      setError(userMessage(caught, 'Could not send the code.'));
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
      setError(userMessage(caught, 'That code did not work.'));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  const nothingConfigured =
    options !== null && !options.google.available && !options.email.available;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-canvas px-4 py-12">
      {options?.google.available && (
        <Script
          src="https://accounts.google.com/gsi/client"
          onReady={() => setGoogleScriptReady(true)}
          strategy="afterInteractive"
        />
      )}

      {/* The product's mark and name, set as the top bar sets them. */}
      <div className="mb-8 flex items-center gap-2.5 text-ink">
        <Image
          src="/tailor-icon.svg"
          alt=""
          width={40}
          height={40}
          className="rounded-lg"
          priority
          data-darkreader-ignore
          suppressHydrationWarning
        />
        <span className="tl-wordmark">Tailor</span>
      </div>

      <div className="tl-card w-full max-w-md p-6 sm:p-8">
        <h1 className="text-2xl font-bold tracking-tight text-ink">Sign in</h1>
        <p className="mt-2 text-sm text-muted">Tailor keeps your profiles to your own account.</p>

        {optionsError && (
          <Notice tone="error" className="mt-6">
            {optionsError}
          </Notice>
        )}

        {/*
          Who is looking is unknown here - nobody can be signed in - so this
          says only who can fix it. What to set is in the backend's startup log
          and the README, where the person who runs the server will look.
        */}
        {nothingConfigured && (
          <Notice tone="warn" className="mt-6">
            Sign-in isn&apos;t available right now. Please contact your administrator.
          </Notice>
        )}

        {options?.google.available && (
          <div className="mt-6">
            <div ref={googleButtonRef} className="flex justify-center" />
            {!googleScriptReady && (
              <p className="text-center text-sm text-subtle">Loading Google sign-in...</p>
            )}
          </div>
        )}

        {options?.google.available && options.email.available && (
          <div className="my-6 flex items-center gap-3">
            <span className="h-px flex-1 bg-[var(--line-subtle)]" />
            <span className="text-xs uppercase tracking-wide text-subtle">or</span>
            <span className="h-px flex-1 bg-[var(--line-subtle)]" />
          </div>
        )}

        {options?.email.available && stage === 'address' && (
          <form onSubmit={sendCode} className="mt-6 space-y-5">
            <Field label="Email address" htmlFor="signin-email">
              <input
                id="signin-email"
                type="email"
                required
                autoComplete="email"
                value={email}
                disabled={busy}
                onChange={(event) => setEmail(event.target.value)}
                className="tl-input"
                placeholder="you@example.com"
              />
            </Field>
            <button type="submit" disabled={busy || !email} className="tl-button w-full">
              {busy ? 'Sending...' : 'Email me a code'}
            </button>
          </form>
        )}

        {options?.email.available && stage === 'code' && (
          <form onSubmit={verifyCode} className="mt-6 space-y-5">
            <Field label="Six-digit code" htmlFor="signin-code">
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
                // Inline, because `.tl-input` sets its own font size and is
                // unlayered, so a `text-2xl` utility here would lose to it.
                style={{ fontSize: '1.5rem', lineHeight: '2rem', letterSpacing: '0.5em' }}
                className="tl-input text-center"
                placeholder="000000"
              />
            </Field>
            <div className="space-y-3">
              <button type="submit" disabled={busy || code.length !== 6} className="tl-button w-full">
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
                className="tl-button-quiet w-full"
              >
                Use a different address
              </button>
            </div>
          </form>
        )}

        {notice && !error && (
          /*
           * `break-words`, because this sentence has an email address in it.
           *
           * The server answers "A six-digit code is on its way to <address>",
           * and an address is one unbreakable word to a browser - neither `.`
           * nor `@` is a break opportunity. Without this, an ordinary
           * work address runs out of the notice, out of the card, and on a
           * phone off the side of the window, taking the page's horizontal
           * scroll with it. It starts going wrong at 39 characters.
           */
          <Notice tone="info" className="mt-5 break-words">
            {notice}
          </Notice>
        )}
        {error && (
          <Notice tone="error" className="mt-5">
            {error}
          </Notice>
        )}
      </div>
    </div>
  );
}
