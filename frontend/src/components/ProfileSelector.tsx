'use client';

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
      <label className="block text-sm font-medium text-black mb-2">
        Select Profile
      </label>
      <select
        value={selectedId || ''}
        onChange={(e) => onChange(e.target.value)}
        disabled={isLoading}
        className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white disabled:bg-gray-100 disabled:cursor-not-allowed"
      >
        <option value="">Choose a profile...</option>
        {profiles.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {profile.name}
          </option>
        ))}
      </select>
      {profiles.length === 0 && !isLoading && (
        <p className="mt-2 text-sm text-gray-700">
          No profiles available. Create one in the{' '}
          <a href="/admin/profiles" className="text-blue-600 hover:underline">
            admin panel
          </a>
          .
        </p>
      )}
    </div>
  );
}
