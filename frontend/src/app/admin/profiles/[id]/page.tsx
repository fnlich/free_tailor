'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import ProfileEditor from '@/components/profile/ProfileEditor';
import { ErrorNotice, Spinner } from '@/components/ui/kit';
import { profilesApi, type Profile } from '@/lib/api';

/**
 * Editing one profile, with its live preview.
 *
 * A route of its own rather than the dialog it used to be, so the editor has
 * the width for a form and a page side by side, and a profile can be linked to
 * and survives a reload. No <main>: app/admin/layout.tsx draws it.
 */
export default function EditProfilePage() {
  const params = useParams<{ id: string }>();
  const profileId = typeof params?.id === 'string' ? params.id : '';

  const [loaded, setLoaded] = useState<{
    id: string;
    profile: Profile | null;
    accountProfiles: Profile[];
    error: unknown;
  } | null>(null);

  useEffect(() => {
    if (!profileId) return;
    let live = true;
    Promise.all([
      profilesApi.getById(profileId),
      // Only for which templates the account's other profiles use: a failure
      // here costs the "used by" labels, never the editor.
      profilesApi.getAll({ includeDisabled: true }).catch(() => [] as Profile[]),
    ]).then(
      ([profile, accountProfiles]) => {
        if (live) setLoaded({ id: profileId, profile, accountProfiles, error: null });
      },
      (error) => {
        if (live) setLoaded({ id: profileId, profile: null, accountProfiles: [], error: error ?? 'Failed to load the profile.' });
      }
    );
    return () => {
      live = false;
    };
  }, [profileId]);

  if (!loaded || loaded.id !== profileId) {
    return <Spinner label="Loading the profile..." />;
  }

  if (!loaded.profile) {
    return (
      <div className="space-y-4">
        <ErrorNotice error={loaded.error} fallback="Could not load this profile" />
        <Link href="/admin/profiles" className="tl-button-quiet">
          Back to profiles
        </Link>
      </div>
    );
  }

  return <ProfileEditor key={loaded.profile.id} profile={loaded.profile} accountProfiles={loaded.accountProfiles} />;
}
