import { apiFetch } from './api';
import {
  normalizeAdminProvider,
  normalizeAdminProviders,
  normalizeProviderCard,
  type AdminAIProvider,
  type ProviderCard,
} from './providerDisplay';

/**
 * Admin -> Models -> Providers: the /api/admin/ai/providers routes.
 *
 * Administrators only - every answer names folders and binaries on the server.
 * A refusal of what was typed is a 400 or a 409 carrying the sentence, a
 * `code` and the `field` it is about; the form pins it to that box
 * (lib/providerDisplay.ts `refusalField`). Bodies are built there too, so a
 * save sends only what changed.
 */

export type {
  AdminAIProvider,
  ProviderCard,
  ProviderDraft,
  ProviderField,
  ProviderProblems,
} from './providerDisplay';

/** What every change answers: the provider it was about (none after a removal), the whole list, and the work it moved. */
export type ProviderMutation = {
  provider: AdminAIProvider | null;
  providers: AdminAIProvider[];
  /** Resumes that were waiting on it and moved to another provider of its type. */
  moved: number;
};

function readMutation(answer: { provider?: unknown; providers?: unknown; moved?: unknown } | null): ProviderMutation {
  const moved = answer?.moved;
  return {
    provider: normalizeAdminProvider(answer?.provider),
    providers: normalizeAdminProviders(answer?.providers),
    moved: typeof moved === 'number' && Number.isSafeInteger(moved) && moved > 0 ? moved : 0,
  };
}

const path = (id: string) => `/admin/ai/providers/${encodeURIComponent(id)}`;

export const providersApi = {
  list: async (): Promise<AdminAIProvider[]> =>
    normalizeAdminProviders((await apiFetch<{ providers?: unknown }>('/admin/ai/providers')).providers),

  /** `{ type, label, homeDir, binaryPath?, concurrency_max_requests?, enabled }` - lib/providerDisplay's `addProviderBody`. */
  create: async (body: Record<string, unknown>): Promise<ProviderMutation> =>
    readMutation(await apiFetch('/admin/ai/providers', { method: 'POST', body: JSON.stringify(body) })),

  /** Only what changed - lib/providerDisplay's `editProviderBody` - or `{ enabled }` from the table's switch. */
  update: async (id: string, body: Record<string, unknown>): Promise<ProviderMutation> =>
    readMutation(await apiFetch(path(id), { method: 'PUT', body: JSON.stringify(body) })),

  /** Refused (409 `provider-busy`) while it is building something, and for a built-in (409 `built-in`). */
  remove: async (id: string): Promise<ProviderMutation> =>
    readMutation(await apiFetch(path(id), { method: 'DELETE' })),

  /** A fresh check, even of a provider switched off: its card as the health route draws it. */
  check: async (id: string): Promise<ProviderCard | null> =>
    normalizeProviderCard((await apiFetch<{ provider?: unknown }>(`${path(id)}/check`, { method: 'POST' })).provider),
};
