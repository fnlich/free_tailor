import { Group } from '../types/group';
import { DocumentTable } from './documentTable';

const groups = new DocumentTable<Group>('profile_groups', (group) => ({ name: group.name }));

export function listGroups(): Group[] {
  return groups.list();
}

export function getGroup(id: string): Group | null {
  return groups.get(id);
}

export function saveGroup(group: Group): Group {
  return groups.save(group);
}

export function deleteGroup(id: string): boolean {
  return groups.delete(id);
}
