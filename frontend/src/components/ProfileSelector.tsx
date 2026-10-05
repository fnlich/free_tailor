'use client';

import Link from 'next/link';
import { Profile } from '@/lib/api';

interface ProfileSelectorProps {
  profiles: Profile[];
  selectedId: string | null;
  onChange: (id: string) => void;
  isLoading?: boolean;
}

export default function ProfileSelector({
  profiles,
  selectedId,
  onChange,
  isLoading,
}: ProfileSelectorProps) {
  return (
    <div>
      <label className="tl-label">
        Select Profile
      </label>
      <select
        value={selectedId || ''}
        onChange={(e) => onChange(e.target.value)}
        disabled={isLoading}
        className="tl-input mt-2"
      >
        <option value="">Choose a profile...</option>
        {profiles.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {profile.name}
          </option>
        ))}
      </select>
      {profiles.length === 0 && !isLoading && (
        <p className="mt-2 text-sm text-muted">
          No profiles available. Create one under{' '}
          {/* A Link, not an <a>: it is a page of this app, which a plain
              anchor reloads from scratch - and next lint has flagged it
              since /admin/profiles gained the editor's child routes. */}
          <Link href="/admin/profiles" className="tl-link">
            Profiles
          </Link>
          .
        </p>
      )}
    </div>
  );
}
