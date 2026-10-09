import { apiFetch, removeToken, setToken } from './api';
import type { LedgerEntry } from './credits';
import type { ConfiguredAdminSource, UserRole } from './roles';
import type { AccountSubscriptionId } from './subscriptions';

export type { AccountSubscriptionId } from './subscriptions';
export type { UserRole } from './roles';

/**
 * Signing in, and what the app knows about who is signed in.
 *
 * The types here mirror what `/api/auth` returns rather than restating the
 * subscriptions: the subscription's label, its profile limit and how many
 * profiles the account has all arrive with the account, so a page never has to work out an
 * entitlement for itself and cannot work it out differently from the server.
 */

export type Account = {
  id: string;
  email: string;
  name: string;
  picture: string;
  role: UserRole;
  /** The account's tier. */
  subscription: AccountSubscriptionId;
  subscriptionLabel: string;
  subscriptionSummary: string;
  /** null means unlimited. */
  profileLimit: number | null;
  profilesUsed: number;
  /** The credit balance, in thousandths of a dollar: 3977 is $3.977. Show it with `formatMoney`. */
  balanceMilli: number;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
  /**
   * The account's own Google spreadsheet, once one has been allocated - the
   * link a reporter's menu offers until the shell's own read of /sheet (which
   * opens the All tab) arrives.
   */
  sheetUrl?: string;
};

export type AccountSubscription = {
  id: AccountSubscriptionId;
  label: string;
  profileLimit: number | null;
  summary: string;
  order: number;
};

/**
 * Which ways in this server offers. Only whether each is available: which
 * settings a missing one lacks is the operator's business, and the sign-in
 * screen is shown to people nobody has identified yet.
 */
export type SignInOptions = {
  google: { available: boolean; clientId: string };
  email: { available: boolean };
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

  subscriptions: () => apiFetch<{ subscriptions: AccountSubscription[] }>('/auth/subscriptions'),

  /**
   * Who is signed in, and the PDF upload cap (`uploadMaxMb`, UPLOAD_MAX_MB on
   * the server). The cap is beside the account rather than in it because it is
   * the server's, not the account's, and is answered signed out too. Read it
   * through `readUploadMaxMb` in lib/upload.ts, which never lets a value that
   * is not a positive whole number become the cap.
   */
  me: () => apiFetch<{ account: Account | null; uploadMaxMb: number }>('/auth/me'),

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

export type ManagedAccount = Account & {
  subscriptionLabel: string;
  /** "User", "Reporter", "Administrator" - the server's label for `role`. */
  roleLabel: string;
  /**
   * A reporter's own pay per accepted job, in thousandths of a dollar; null
   * means the installation's global rate. On every row, whatever the role: an
   * account made a user keeps the figure, for if it is made a reporter again.
   */
  reportRateMilli: number | null;
  /**
   * The address is named by ADMIN_EMAILS (or is the SMTP_USER fallback), so
   * the server makes it an administrator again at its next sign-in and every
   * restart, whatever role is set here.
   */
  configuredAdmin: boolean;
  /**
   * Which of the two names it, null when neither does; the row names it
   * (lib/roles.ts `configuredAdminNotes`).
   */
  configuredAdminSource: ConfiguredAdminSource | null;
};

/** A role as the accounts list offers it: `{ id: 'reporter', label: 'Reporter' }`. */
export type RoleOption = { id: UserRole; label: string };

/**
 * A change the server made and kept, with `note` when it will not last: the
 * address is named by ADMIN_EMAILS (or SMTP_USER), so a role other than
 * administrator is undone at its next sign-in.
 */
export type AccountChange = { account: ManagedAccount; note?: string };

/** What recording a payout answers. `recorded: false` is a repeat of one already recorded. */
export type PayoutResult = {
  account: ManagedAccount;
  balanceMilli: number;
  entry: LedgerEntry;
  recorded: boolean;
  /**
   * The reporter's open payout request this payout answered, closed as paid
   * in the same step - so the queue cannot pay it a second time. Null when
   * none was open.
   */
  closedRequestId: string | null;
};

export const accountsApi = {
  /**
   * Adds to a balance, rather than setting it.
   *
   * `amountUsd` is a DELTA in dollars, as the administrator typed it ("0.25",
   * "-1.5") - positive adds, negative takes away, and the server stops at
   * $0. Distinct from `update({ balanceUsd })`, which sets an absolute
   * amount: "give them ten dollars more" and "make it ten dollars" are
   * different intentions, and making an admin do the arithmetic to express the
   * first is how somebody takes credit away by accident.
   */
  grantCredits: (id: string, amountUsd: string, note?: string) =>
    apiFetch<{ account: ManagedAccount; balanceMilli: number }>(
      `/admin/accounts/${encodeURIComponent(id)}/credits`,
      { method: 'POST', body: JSON.stringify({ amountUsd, note }) }
    ),

  /** Every movement on one account, so an admin can explain a balance. */
  ledger: (id: string) =>
    apiFetch<{ balanceMilli: number; entries: LedgerEntry[] }>(
      `/admin/accounts/${encodeURIComponent(id)}/credits`
    ),

  /**
   * `roles` is the server's catalog. `globalReportRateMilli` is the rate a
   * reporter with no rate of their own is paid (Admin -> Job Lake), which the
   * empty rate boxes name.
   */
  list: () =>
    apiFetch<{
      accounts: ManagedAccount[];
      subscriptions: AccountSubscription[];
      roles: RoleOption[];
      globalReportRateMilli: number;
    }>('/admin/accounts'),

  create: (input: {
    email: string;
    name?: string;
    role?: UserRole;
    subscription?: AccountSubscriptionId;
    /** An opening balance, in dollars as typed. Absent or '' opens at none. */
    balanceUsd?: string;
    /** A reporter's own rate per job, in dollars as typed. Absent or '' is the global rate. */
    reportRateUsd?: string;
  }) =>
    apiFetch<AccountChange>('/admin/accounts', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  update: (
    id: string,
    patch: {
      role?: UserRole;
      subscription?: AccountSubscriptionId;
      /** The balance to SET, in dollars as typed ("3.977"); never below $0. */
      balanceUsd?: string;
      disabled?: boolean;
      name?: string;
      /**
       * A reporter's own rate per job, in dollars as typed ("0.075"); '' clears
       * it, back to the global rate. Refused (409 `not-a-reporter`) on an
       * account that will not be a reporter after this change.
       */
      reportRateUsd?: string;
    }
  ) =>
    apiFetch<AccountChange>(`/admin/accounts/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  /**
   * Records money ALREADY paid to a reporter outside the app (owner decision
   * A4): a `reporter-payout` deduction carrying `note`. Never more than the
   * balance (409 `insufficient-balance`), and only for a reporter (409
   * `not-a-reporter`). `requestId` is minted once per form
   * (`mintPayoutRequestId`), so pressing twice records it once.
   */
  recordPayout: (id: string, input: { amountUsd: string; note: string; requestId: string }) =>
    apiFetch<PayoutResult>(`/admin/accounts/${encodeURIComponent(id)}/payout`, {
      method: 'POST',
      body: JSON.stringify(input),
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
 * An ADMIN is exempt from the cap, so their subscription's number is not a
 * limit they have - saying "5 of 1" to somebody who can freely make a sixth
 * would be simply false, and it is the common case, since every account starts
 * on the one-profile Default subscription.
 */
export function describeProfileUsage(account: Account): string {
  if (account.role === 'admin' || account.profileLimit === null) {
    return `${account.profilesUsed} of unlimited`;
  }
  return `${account.profilesUsed} of ${account.profileLimit}`;
}

/** True when the account is at its subscription's profile limit. */
export function isAtProfileLimit(account: Account): boolean {
  if (account.role === 'admin') return false;
  return account.profileLimit !== null && account.profilesUsed >= account.profileLimit;
}
