import { Group } from '../types/group';
import type { UserAccount } from '../types/account';
import { DocumentTable } from './documentTable';

/**
 * Profile groups, scoped the same way profiles are.
 *
 * A group is a list of profile ids, so an unscoped one would name profiles the
 * reader cannot see - which is not a leak of the profiles themselves, but is a
 * leak of how many there are and what they are called.
 */

const groups = new DocumentTable<Group>('profile_groups', (group) => ({
  name: group.name,
  owner_id: group.ownerId ?? '',
}));

export type Viewer = UserAccount | null;

function canSee(viewer: Viewer, group: Group): boolean {
  if (viewer === null) return true;
  if (viewer.role === 'admin') return true;
  return Boolean(group.ownerId) && group.ownerId === viewer.id;
}

export function listGroupsFor(viewer: Viewer, options: { allOwners?: boolean } = {}): Group[] {
  return groups.list().filter((group) => {
    if (viewer === null) return true;
    if (viewer.role === 'admin' && options.allOwners) return true;
    return Boolean(group.ownerId) && group.ownerId === viewer.id;
  });
}

export function getGroupFor(viewer: Viewer, id: string): Group | null {
  const group = groups.get(id);
  if (!group) return null;
  return canSee(viewer, group) ? group : null;
}

/** Unscoped read, for the paths that have no viewer. */
export function getGroup(id: string): Group | null {
  return groups.get(id);
}

export function saveGroup(group: Group): Group {
  return groups.save(group);
}

export function deleteGroup(id: string): boolean {
  return groups.delete(id);
}

/** @deprecated Use `listGroupsFor` with the request's viewer. */
export function listGroups(): Group[] {
  return groups.list();
}
