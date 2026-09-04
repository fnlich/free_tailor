import { Profile } from '../types/profile';
import { DocumentTable } from './documentTable';

const profiles = new DocumentTable<Profile>('profiles', (profile) => ({
  name: profile.name,
  disabled: profile.disabled ? 1 : 0,
}));

export function listProfiles(options: { includeDisabled?: boolean } = {}): Profile[] {
  const all = profiles.list();
  return options.includeDisabled ? all : all.filter((profile) => !profile.disabled);
}

export function getProfile(id: string): Profile | null {
  return profiles.get(id);
}

export function hasProfile(id: string): boolean {
  return profiles.has(id);
}

export function saveProfile(profile: Profile): Profile {
  return profiles.save(profile);
}

export function deleteProfile(id: string): boolean {
  return profiles.delete(id);
}
