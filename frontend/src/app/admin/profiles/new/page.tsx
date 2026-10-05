'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import ProfileEditor from '@/components/profile/ProfileEditor';
import { ErrorNotice, Notice, PageHeader, Spinner } from '@/components/ui/kit';
import { useAuth } from '@/contexts/AuthContext';
import { profilesApi, type Profile } from '@/lib/api';
import { isAtProfileLimit } from '@/lib/auth';

/**
 * A new profile, with its live preview.
 *
 * The subscription's limit is checked before the form is shown, against the account's
 * live list rather than the sign-in snapshot (which goes stale the moment a
 * profile is deleted) - letting somebody fill in a whole profile and then
 * refusing the save is what the gate is for. The server checks again on save.
 */
export default function NewProfilePage() {
  const { account, loading: authLoading } = useAuth();
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let live = true;
    profilesApi.getAll({ includeDisabled: true }).then(
      (list) => live && setProfiles(list),
      (err) => {
        if (!live) return;
        setError(err ?? 'Failed to load your profiles.');
        setProfiles([]);
      }
    );
    return () => {
      live = false;
    };
  }, []);

  if (authLoading || profiles === null) {
    return <Spinner label="Checking your subscription..." />;
  }

  const liveAccount = account ? { ...account, profilesUsed: profiles.length } : null;
  if (liveAccount && !error && isAtProfileLimit(liveAccount)) {
    return (
      <div>
        <PageHeader title="New Profile" />
        <Notice tone="warn">
          <p className="font-semibold">
            You are using all {liveAccount.profileLimit} profile{liveAccount.profileLimit === 1 ? '' : 's'} on the{' '}
            {liveAccount.subscriptionLabel} subscription.
          </p>
          <p className="mt-1">
            Delete one to make room, or ask an administrator of this installation to move your account to a higher
            subscription.{' '}
            <Link href="/admin/profiles" className="font-medium underline underline-offset-2">
              Back to profiles
            </Link>
          </p>
        </Notice>
      </div>
    );
  }

  return (
    <>
      {/* The list failed: the form still works, and the server still enforces the limit on save. */}
      <ErrorNotice error={error} className="mb-4" />
      <ProfileEditor profile={null} accountProfiles={profiles} />
    </>
  );
}
