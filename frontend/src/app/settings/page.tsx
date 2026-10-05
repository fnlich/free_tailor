'use client';

import { useEffect, useState } from 'react';

import { Field, Section, SettingsPage, StaticValue, Status } from '@/components/settings/SettingsParts';
import { useAuth } from '@/contexts/AuthContext';
import { authApi } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { messageWithDetail } from '@/lib/userMessage';

/**
 * Settings > Profile: who you are signed in as, and the one thing about that
 * you may change yourself.
 *
 * Read-mostly on purpose. The only thing a user may change about themselves is
 * their display name - subscription, credits and role are an administrator's
 * to set, and a form that let somebody pick their own subscription would be a
 * form that lies.
 */
export default function ProfileSettingsPage() {
  const { account, adopt, signOut } = useAuth();

  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  useEffect(() => {
    if (account) setName(account.name);
  }, [account]);

  if (!account) return null;

  const saveName = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      adopt((await authApi.updateName(name)).account);
      setSaved(true);
    } catch (caught) {
      setError(messageWithDetail(caught, 'Could not save that name.'));
    } finally {
      setSaving(false);
    }
  };

  const endSession = async () => {
    setSigningOut(true);
    setSignOutError(null);
    try {
      // On success the account goes to null and AuthGate replaces this page
      // with the sign-in screen, so there is nothing to reset afterwards.
      await signOut();
    } catch (caught) {
      setSignOutError(messageWithDetail(caught, 'Could not sign out.'));
      setSigningOut(false);
    }
  };

  return (
    <SettingsPage>
      <Section title="Profile" description="This information is shown on your account.">
        <Field
          label="Email"
          hint="The address you sign in with. It cannot be changed here."
        >
          {/* Not editable. It is the identity both sign-in paths prove, so
              changing it here would mean changing which account you are. */}
          <StaticValue>{account.email}</StaticValue>
        </Field>

        <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
          <Field label="Role">
            <StaticValue>{account.role === 'admin' ? 'Administrator' : 'User'}</StaticValue>
          </Field>
          <Field label="Member since">
            <StaticValue>{formatDate(account.createdAt, { empty: 'Never' })}</StaticValue>
          </Field>
          <Field label="Last signed in">
            <StaticValue>{formatDate(account.lastLoginAt, { empty: 'Never' })}</StaticValue>
          </Field>
        </div>

        <form onSubmit={saveName}>
          <Field label="Display name" htmlFor="settings-name">
            <input
              id="settings-name"
              value={name}
              maxLength={120}
              disabled={saving}
              autoComplete="name"
              onChange={(event) => {
                setName(event.target.value);
                setSaved(false);
              }}
              className="tl-input"
            />
          </Field>
          <button
            type="submit"
            disabled={saving || !name.trim() || name === account.name}
            className="tl-button mt-4"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
          {saved && <Status tone="ok">Saved.</Status>}
          {error && <Status tone="error">{error}</Status>}
        </form>
      </Section>

      <Section title="Sign out" description="End this session on this device.">
        <div>
          <button
            type="button"
            onClick={() => void endSession()}
            disabled={signingOut}
            className="tl-button-quiet"
          >
            {signingOut ? 'Signing out...' : 'Sign out'}
          </button>
          {signOutError && <Status tone="error">{signOutError}</Status>}
        </div>
      </Section>
    </SettingsPage>
  );
}
