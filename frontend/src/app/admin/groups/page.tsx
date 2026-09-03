'use client';

import { useEffect, useMemo, useState } from 'react';
import { groupsApi, profilesApi, Group, Profile } from '@/lib/api';

export default function GroupsPage() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [formName, setFormName] = useState('');
  const [formProfileIds, setFormProfileIds] = useState<string[]>([]);
  const [editingGroup, setEditingGroup] = useState<Group | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const [groupsData, profilesData] = await Promise.all([
        groupsApi.getAll(),
        profilesApi.getAll({ includeDisabled: true }),
      ]);
      setGroups(groupsData);
      setProfiles(profilesData.filter((p) => !p.disabled));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load groups');
    } finally {
      setIsLoading(false);
    }
  };

  const resetForm = () => {
    setFormName('');
    setFormProfileIds([]);
    setEditingGroup(null);
  };

  const handleSubmit = async () => {
    if (!formName.trim()) {
      setError('Group name is required');
      return;
    }
    if (formProfileIds.length === 0) {
      setError('Select at least one profile');
      return;
    }

    setIsSaving(true);
    setError('');

    try {
      if (editingGroup) {
        await groupsApi.update(editingGroup.id, {
          name: formName.trim(),
          profileIds: formProfileIds,
        });
      } else {
        await groupsApi.create({
          name: formName.trim(),
          profileIds: formProfileIds,
        });
      }
      await loadData();
      resetForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save group');
    } finally {
      setIsSaving(false);
    }
  };

  const handleEdit = (group: Group) => {
    setEditingGroup(group);
    setFormName(group.name);
    setFormProfileIds(group.profileIds);
  };

  const handleDelete = async (group: Group) => {
    if (!confirm(`Delete group "${group.name}"?`)) return;
    try {
      await groupsApi.delete(group.id);
      await loadData();
      if (editingGroup?.id === group.id) {
        resetForm();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete group');
    }
  };

  const profileLookup = useMemo(() => {
    const map = new Map<string, Profile>();
    for (const profile of profiles) {
      map.set(profile.id, profile);
    }
    return map;
  }, [profiles]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Groups</h1>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      <div className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
        <div className="text-lg font-semibold text-gray-900">
          {editingGroup ? `Edit Group: ${editingGroup.name}` : 'Create Group'}
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Group Name</label>
          <input
            type="text"
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            disabled={isSaving}
            placeholder="Group name (e.g., Backend Team)"
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Members</label>
          <div className="max-h-48 overflow-y-auto border border-gray-200 rounded-md p-3 space-y-2">
            {profiles.map((profile) => {
              const checked = formProfileIds.includes(profile.id);
              return (
                <label key={profile.id} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setFormProfileIds((prev) => [...prev, profile.id]);
                      } else {
                        setFormProfileIds((prev) => prev.filter((id) => id !== profile.id));
                      }
                    }}
                    disabled={isSaving}
                  />
                  <span>{profile.name}</span>
                </label>
              );
            })}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={isSaving}
            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-blue-400"
          >
            {editingGroup ? 'Save Changes' : 'Create Group'}
          </button>
          {editingGroup && (
            <button
              type="button"
              onClick={resetForm}
              disabled={isSaving}
              className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      <div className="bg-white rounded-lg border border-gray-200">
        <div className="p-4 border-b">
          <h2 className="text-lg font-semibold text-gray-900">Existing Groups</h2>
        </div>
        <div className="divide-y">
          {groups.length === 0 && (
            <div className="p-4 text-sm text-gray-500">No groups created yet.</div>
          )}
          {groups.map((group) => (
            <div key={group.id} className="p-4 flex items-start justify-between gap-4">
              <div>
                <div className="text-sm font-semibold text-gray-900">{group.name}</div>
                <div className="text-xs text-gray-500 mt-1">
                  {group.profileIds.length} member(s)
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  {group.profileIds
                    .map((id) => profileLookup.get(id)?.name)
                    .filter(Boolean)
                    .join(', ') || 'No members'}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleEdit(group)}
                  className="px-3 py-2 text-sm bg-gray-800 text-white rounded-md hover:bg-gray-900"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(group)}
                  className="px-3 py-2 text-sm bg-red-600 text-white rounded-md hover:bg-red-700"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
