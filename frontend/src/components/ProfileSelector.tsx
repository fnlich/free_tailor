'use client';

import Link from 'next/link';
import type { ProfileSummary } from '@/lib/api';

/**
 * The profile (a person) a run builds for: one select. The page passes only
 * the profiles that have an enabled resume, newest edit first; each option
 * says how many resumes it would choose among.
 */
interface ProfileSelectorProps {
  profiles: ProfileSummary[];
  selectedId: string | null;
  onChange: (id: string) => void;
  isLoading?: boolean;
  /** What the end-to-end scripts find the select by (`manual-profile`, `sheets-profile`, `order-profile`). */
  id?: string;
  disabled?: boolean;
  label?: string;
}

function resumeCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'resume' : 'resumes'}`;
}

export default function ProfileSelector({
  profiles,
  selectedId,
  onChange,
  isLoading,
  id,
  disabled = false,
  label = 'Select Profile',
}: ProfileSelectorProps) {
  return (
    <div>
      <label className="tl-label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        value={selectedId || ''}
        onChange={(e) => onChange(e.target.value)}
        disabled={isLoading || disabled}
        className="tl-input mt-2"
      >
        <option value="">Choose a profile...</option>
        {profiles.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {profile.name} ({resumeCountLabel(profile.enabledResumeCount)})
          </option>
        ))}
      </select>
      {profiles.length === 0 && !isLoading && (
        <p className="mt-2 text-sm text-muted">
          You have no profile with an enabled resume. Add one under{' '}
          {/* A Link, not an <a>: it is a page of this app, which a plain
              anchor reloads from scratch - and next lint has flagged it
              since the editor gained child routes (now under /admin/resumes). */}
          <Link href="/admin/profiles" className="tl-link">
            Profiles
          </Link>
          .
        </p>
      )}
    </div>
  );
}
