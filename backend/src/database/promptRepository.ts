import { DocumentTable } from './documentTable';
import { getSetting, setSetting } from './settingsRepository';

/** JSON document persisted for a custom prompt or for a built-in prompt override. */
export type StoredPrompt = {
  id: string;
  name?: string;
  description?: string;
  featureKey?: string;
  responseFormat?: string;
  modelProvider?: string;
  modelName?: string;
  allowedVariables?: unknown[];
  content: string;
  isBuiltIn: boolean;
  createdAt: string;
  updatedAt: string;
};

const ACTIVE_PROMPTS_SETTING_KEY = 'active-prompts';

const prompts = new DocumentTable<StoredPrompt>('prompts', (prompt) => ({
  feature_key: prompt.featureKey ?? '',
  is_built_in: prompt.isBuiltIn ? 1 : 0,
}));

export function getStoredPrompt(id: string): StoredPrompt | null {
  return prompts.get(id);
}

export function hasStoredPrompt(id: string): boolean {
  return prompts.has(id);
}

export function listCustomPrompts(): StoredPrompt[] {
  return prompts.list().filter((prompt) => !prompt.isBuiltIn);
}

export function saveStoredPrompt(prompt: StoredPrompt): StoredPrompt {
  return prompts.save(prompt);
}

export function deleteStoredPrompt(id: string): boolean {
  return prompts.delete(id);
}

export function readActivePrompts(): Record<string, string> {
  const stored = getSetting<Record<string, unknown>>(ACTIVE_PROMPTS_SETTING_KEY);
  const active: Record<string, string> = {};
  for (const [key, value] of Object.entries(stored ?? {})) {
    if (typeof value === 'string' && value.trim()) {
      active[key] = value.trim();
    }
  }
  return active;
}

export function writeActivePrompts(active: Record<string, string>): void {
  setSetting(ACTIVE_PROMPTS_SETTING_KEY, active);
}
