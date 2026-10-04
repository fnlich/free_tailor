'use client';

import { useEffect, useMemo, useState } from 'react';
import { groupsApi, profilesApi, Group, Profile } from '@/lib/api';
import { RequiresPlan } from '@/components/auth/AuthGate';
import chrome from '@/components/admin/profileTemplateChrome.module.css';
import { Card, Field, Notice, PageHeader, Spinner } from '@/components/ui/kit';
import { messageWithDetail } from '@/lib/userMessage';

function GroupsPageBody() {
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
      setError(messageWithDetail(err, 'Failed to load groups'));
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
      setError(messageWithDetail(err, 'Failed to save group'));
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
      setError(messageWithDetail(err, 'Failed to delete group'));
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
    return <Spinner label="Loading groups..." />;
  }

  /*
   * No <main> here: app/admin/layout.tsx already wraps every /admin/* route
   * in one, with the gutters and the width.
   */
  return (
    <div className="max-w-5xl">
      <PageHeader title="Groups" />

      {error && (
        <Notice tone="error" role="alert" className="mb-6">
          {error}
        </Notice>
      )}

      <div className="space-y-8">
        <Card title={editingGroup ? `Edit Group: ${editingGroup.name}` : 'Create Group'}>
          <div className="space-y-6">
            <Field label="Group Name" htmlFor="group-name">
              <input
                id="group-name"
                type="text"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                disabled={isSaving}
                placeholder="Group name (e.g., Backend Team)"
                className="tl-input"
              />
            </Field>
            <Field label="Members">
              <div className={`${chrome.checkBox} space-y-2.5`}>
                {profiles.map((profile) => {
                  const checked = formProfileIds.includes(profile.id);
                  return (
                    <label key={profile.id} className="flex cursor-pointer items-center gap-2.5 text-sm text-ink">
                      <input
                        type="checkbox"
                        className="tl-check"
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
            </Field>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={handleSubmit}
                disabled={isSaving}
                className="tl-button"
              >
                {editingGroup ? 'Save Changes' : 'Create Group'}
              </button>
              {editingGroup && (
                <button
                  type="button"
                  onClick={resetForm}
                  disabled={isSaving}
                  className="tl-button-quiet"
                >
                  Cancel
                </button>
              )}
            </div>
          </div>
        </Card>

        <Card title="Existing Groups" padded={false}>
          <div className={chrome.list}>
            {groups.length === 0 && (
              <p className="px-5 py-4 text-sm text-muted">No groups created yet.</p>
            )}
            {groups.map((group) => (
              <div key={group.id} className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 px-5 py-4">
                <div className="min-w-[12rem] flex-1">
                  <div className="text-sm font-semibold text-ink">{group.name}</div>
                  <div className="mt-1 text-xs text-subtle">
                    {group.profileIds.length} member(s)
                  </div>
                  <div className="mt-1 text-sm text-muted">
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
                    className="tl-button-quiet"
                    data-size="sm"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(group)}
                    className="tl-button-quiet"
                    data-size="sm"
                    data-tone="danger"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

/**
 * Included from Premium upwards.
 *
 * The gate is on the plan alone, matching `requirePlan('premium')` on the
 * routes: a page that rendered for somebody the API then refused would be a
 * worse experience than this explanation.
 */
export default function GroupsPage() {
  return (
    <RequiresPlan minimum="premium" label="Premium">
      <GroupsPageBody />
    </RequiresPlan>
  );
}
