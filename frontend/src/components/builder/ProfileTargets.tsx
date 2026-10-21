'use client';

import { useMemo, useState } from 'react';

import ProfileSelector from '@/components/ProfileSelector';
import { IconLock } from '@/components/icons';
import { ChoiceCard, LOCKED_INPUT_CLASS, lockLabel } from '@/components/subscription/LockedFeature';
import MultiSelect, { type MultiSelectOption } from '@/components/ui/MultiSelect';
import type { Group, Profile } from '@/lib/api';
import type { TargetKind } from '@/lib/runChoices';
import type { LockSpec } from '@/lib/subscriptions';

/**
 * Who a run builds for: Single profile, All profiles or Specific group, as
 * `.tl-choice` cards - then the profile, or the group, for the kind chosen.
 * Build Resumes' sheet mode draws it (`name="sheetsTargetMode"`,
 * `idPrefix="sheets"`), and any page that orders resumes can. A page that
 * passes `selectedProfileIds` and `onProfileIdsChange` gets a fourth card,
 * Several profiles, and a box of the profiles to choose from (Find Jobs'
 * order) - inline, so a dialog that scrolls never clips its list.
 *
 * Every kind but Single builds for more than one profile at once, which needs
 * Premium (owner decisions B1-B3). Below it they are drawn LOCKED, not hidden
 * - and so is Select Group, as a button standing where the select would be -
 * each opening the lock (`onLocked`), which leads to the Subscription page.
 * `value` is the kind IN EFFECT, which the page derives as Single for such an
 * account (lib/runChoices.ts `targetInEffect`).
 */
export default function ProfileTargets({
  name,
  idPrefix,
  value,
  onChange,
  manyProfiles,
  lock,
  onLocked,
  profiles,
  selectedProfileId,
  onProfileChange,
  selectedProfileIds,
  onProfileIdsChange,
  groups,
  selectedGroupId,
  onGroupChange,
  disabled = false,
}: {
  /** The radios' name: what the end-to-end scripts find them by. */
  name: string;
  /** Prefixes the ids drawn here (`<idPrefix>-group-locked`, `<idPrefix>-profiles`). */
  idPrefix: string;
  value: TargetKind;
  onChange: (kind: TargetKind) => void;
  /** Whether the account may build for more than one profile at once (lib/subscriptions.ts `canBuildForManyProfiles`). */
  manyProfiles: boolean;
  /** The many-profiles lock's words (`describeLock('many-profiles', account)`). */
  lock: LockSpec;
  onLocked: (lock: LockSpec) => void;
  profiles: Profile[];
  selectedProfileId: string | null;
  onProfileChange: (id: string) => void;
  /** The profiles chosen under Several profiles; with `onProfileIdsChange`, what offers that card at all. */
  selectedProfileIds?: readonly string[];
  onProfileIdsChange?: (ids: string[]) => void;
  groups: Group[];
  selectedGroupId: string;
  onGroupChange: (id: string) => void;
  disabled?: boolean;
}) {
  const locked = manyProfiles ? null : lock;
  const several = selectedProfileIds !== undefined && onProfileIdsChange !== undefined;
  // What is typed into the Several box: it only narrows the list of profiles.
  const [profileFilter, setProfileFilter] = useState('');
  const profileOptions = useMemo<MultiSelectOption[]>(
    () => profiles.map((profile) => ({ id: profile.id, label: profile.name })),
    [profiles]
  );
  return (
    <div className="space-y-6">
      <div>
        <label className="tl-label sr-only">Build target</label>
        <div className={`grid gap-2 ${several ? 'sm:grid-cols-2' : 'sm:grid-cols-3'}`}>
          <ChoiceCard
            name={name}
            value="single"
            checked={value === 'single'}
            onSelect={() => onChange('single')}
            disabled={disabled}
            onLocked={onLocked}
          >
            Single profile
          </ChoiceCard>
          {several && (
            <ChoiceCard
              name={name}
              value="several"
              checked={value === 'several'}
              onSelect={() => onChange('several')}
              disabled={disabled}
              lock={locked}
              onLocked={onLocked}
            >
              Several profiles
            </ChoiceCard>
          )}
          <ChoiceCard
            name={name}
            value="all"
            checked={value === 'all'}
            onSelect={() => onChange('all')}
            disabled={disabled}
            lock={locked}
            onLocked={onLocked}
          >
            All profiles
          </ChoiceCard>
          <ChoiceCard
            name={name}
            value="group"
            checked={value === 'group'}
            onSelect={() => onChange('group')}
            disabled={disabled}
            lock={locked}
            onLocked={onLocked}
          >
            Specific group
          </ChoiceCard>
        </div>
      </div>

      {value === 'single' && (
        <ProfileSelector profiles={profiles} selectedId={selectedProfileId} onChange={onProfileChange} isLoading={false} />
      )}

      {several && value === 'several' && (
        <div>
          <label htmlFor={`${idPrefix}-profiles`} className="tl-label">
            Select Profiles
          </label>
          <MultiSelect
            id={`${idPrefix}-profiles`}
            label="Profiles"
            values={selectedProfileIds}
            onChange={onProfileIdsChange}
            options={profileOptions}
            inputValue={profileFilter}
            onInputChange={setProfileFilter}
            placeholder="Choose profiles..."
            emptyText={profileOptions.length === 0 ? 'You have no enabled profile.' : 'No profile matches.'}
            disabled={disabled}
            inline
          />
        </div>
      )}

      {/*
        Shown locked rather than left out, like the targets above it: the
        page says what a Premium subscription adds, instead of a Default
        account never learning groups exist. A button, not a disabled select,
        because a disabled control takes no press - and the press is what
        opens the lock.
      */}
      {locked && (
        <div>
          <label htmlFor={`${idPrefix}-group-locked`} className="tl-label">
            Select Group
          </label>
          <button
            type="button"
            id={`${idPrefix}-group-locked`}
            className={`tl-input mt-2 ${LOCKED_INPUT_CLASS}`}
            data-locked-feature={locked.feature}
            aria-haspopup="dialog"
            aria-label={`Select Group. ${lockLabel(locked)}`}
            title={lockLabel(locked)}
            onClick={() => onLocked(locked)}
          >
            <IconLock className="h-4 w-4" />
            <span>Choose a group</span>
          </button>
        </div>
      )}

      {value === 'group' && (
        <div>
          <label htmlFor={`${idPrefix}-group`} className="tl-label">
            Select Group
          </label>
          <select
            id={`${idPrefix}-group`}
            value={selectedGroupId}
            onChange={(e) => onGroupChange(e.target.value)}
            disabled={disabled}
            className="tl-input mt-2"
          >
            <option value="">Choose a group...</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name} ({group.profileIds.length})
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
