import { apiFetch, removeToken, setToken } from './api';
import type { LedgerEntry } from './credits';

/**
 * Signing in, and what the app knows about who is signed in.
 *
 * The types here mirror what `/api/auth` returns rather than restating the
 * plans: the plan's label, its profile limit and how many profiles the account
 * has all arrive with the account, so a page never has to work out an
 * entitlement for itself and cannot work it out differently from the server.
 */

export type UserRole = 'user' | 'admin';

export type AccountPlanId = 'default' | 'premium' | 'premium-plus' | 'premium-max';

export type Account = {
  id: string;
  email: string;
  name: string;
  picture: string;
  role: UserRole;
  plan: AccountPlanId;
  planLabel: string;
  planSummary: string;
  /** null means unlimited. */
  profileLimit: number | null;
  profilesUsed: number;
  credits: number;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
};

export type AccountPlan = {
  id: AccountPlanId;
  label: string;
  profileLimit: number | null;
  summary: string;
  order: number;
};

export type SignInOptions = {
  google: { available: boolean; clientId: string };
  email: { available: boolean; missing: string[] };
};

export type SignInResponse = {
  token: string;
  account: Account;
  created: boolean;
};

/** Keeps the header copy of the token in step with every sign-in. */
function remember(result: SignInResponse): SignInResponse {
  setToken(result.token);
  return result;
}

export const authApi = {
  options: () => apiFetch<SignInOptions>('/auth/options'),

  plans: () => apiFetch<{ plans: AccountPlan[] }>('/auth/plans'),

  me: () => apiFetch<{ account: Account | null }>('/auth/me'),

  google: (credential: string) =>
    apiFetch<SignInResponse>('/auth/google', {
      method: 'POST',
      body: JSON.stringify({ credential }),
    }).then(remember),

  requestCode: (email: string) =>
    apiFetch<{ sent: true; email: string; expiresInMinutes: number; message: string }>(
      '/auth/email/request',
      { method: 'POST', body: JSON.stringify({ email }) }
    ),

  verifyCode: (email: string, code: string) =>
    apiFetch<SignInResponse>('/auth/email/verify', {
      method: 'POST',
      body: JSON.stringify({ email, code }),
    }).then(remember),

  logout: async () => {
    try {
      await apiFetch<{ ok: true }>('/auth/logout', { method: 'POST' });
    } finally {
      // Cleared whatever the server said. A logout that leaves the token
      // behind because the request failed is the one case where the user is
      // most sure they logged out.
      removeToken();
    }
  },

  updateName: (name: string) =>
    apiFetch<{ account: Account }>('/auth/account', {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),
};

/* --------------------------------------------------- admin account management */

export type ManagedAccount = Account & { planLabel: string };

export const accountsApi = {
  /**
   * Adds to a balance, rather than setting it.
   *
   * `amount` is a DELTA - positive adds, negative takes away. Distinct from
   * `update({credits})`, which sets an absolute number: "give them ten more"
   * and "make it ten" are different intentions, and making an admin do the
   * arithmetic to express the first is how somebody takes credits away by
   * accident.
   */
  grantCredits: (id: string, amount: number, note?: string) =>
    apiFetch<{ account: ManagedAccount; balance: number }>(
      `/admin/accounts/${encodeURIComponent(id)}/credits`,
      { method: 'POST', body: JSON.stringify({ amount, note }) }
    ),

  /** Every movement on one account, so an admin can explain a balance. */
  ledger: (id: string) =>
    apiFetch<{ balance: number; entries: LedgerEntry[] }>(
      `/admin/accounts/${encodeURIComponent(id)}/credits`
    ),

  list: () => apiFetch<{ accounts: ManagedAccount[]; plans: AccountPlan[] }>('/admin/accounts'),

  create: (input: { email: string; name?: string; role?: UserRole; plan?: AccountPlanId; credits?: number }) =>
    apiFetch<{ account: ManagedAccount }>('/admin/accounts', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  update: (
    id: string,
    patch: { role?: UserRole; plan?: AccountPlanId; credits?: number; disabled?: boolean; name?: string }
  ) =>
    apiFetch<{ account: ManagedAccount }>(`/admin/accounts/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  signOutEverywhere: (id: string) =>
    apiFetch<{ ended: number }>(`/admin/accounts/${encodeURIComponent(id)}/sign-out`, {
      method: 'POST',
    }),

  remove: (id: string) =>
    apiFetch<{ deleted: true; orphanedProfiles: number; note?: string }>(
      `/admin/accounts/${encodeURIComponent(id)}`,
      { method: 'DELETE' }
    ),
};

/**
 * "2 of 5", or "2 of unlimited".
 *
 * An ADMIN is exempt from the cap, so their plan's number is not a limit they
 * have - saying "5 of 1" to somebody who can freely make a sixth would be
 * simply false, and it is the common case, since every account starts on the
 * one-profile Default plan.
 */
export function describeProfileUsage(account: Account): string {
  if (account.role === 'admin' || account.profileLimit === null) {
    return `${account.profilesUsed} of unlimited`;
  }
  return `${account.profilesUsed} of ${account.profileLimit}`;
}

/** True when the account is at its plan's profile limit. */
export function isAtProfileLimit(account: Account): boolean {
  if (account.role === 'admin') return false;
  return account.profileLimit !== null && account.profilesUsed >= account.profileLimit;
}
