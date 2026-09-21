import crypto from 'crypto';
import { randomUUID } from 'crypto';

import { DEFAULT_ACCOUNT_PLAN, isAccountPlanId, type AccountPlanId } from '../config/accountPlans';
import { isConfiguredAdmin, resolveAdminIdentity } from '../config/adminIdentity';
import type { AccountUpdate, UserAccount, UserRole } from '../types/account';
import { getDb } from './sqlite';

/**
 * Accounts, sessions and the emailed login codes.
 *
 * Three tables, one module, because they are one subject: a session is only
 * meaningful against an account, and a login code exists only to become one.
 * Splitting them would mean three files that each import the other two.
 */

type UserRow = {
  id: string;
  email: string;
  name: string;
  picture: string;
  role: string;
  plan: string;
  credits: number;
  google_sub: string | null;
  disabled: number;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
  sheet_id: string | null;
  sheet_url: string | null;
  sheet_tab_date: string | null;
  sheet_tab_gid: string | null;
  sheet_shared_at: string | null;
  notifications_seen_at: string | null;
  stripe_customer_id: string | null;
};

const USER_COLUMNS =
  'id, email, name, picture, role, plan, credits, google_sub, disabled, created_at, updated_at, ' +
  'last_login_at, sheet_id, sheet_url, sheet_tab_date, sheet_tab_gid, sheet_shared_at, ' +
  'notifications_seen_at, stripe_customer_id';

function now(): string {
  return new Date().toISOString();
}

/**
 * The one place an address becomes a lookup key.
 *
 * Every path in - Google's token, a typed address, an admin's invite - goes
 * through this, so "Alice@Example.com " and "alice@example.com" are one
 * account. Skipping it anywhere would create the second account silently, and
 * the person would simply find their profiles gone.
 */
export function normalizeEmail(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function isRole(value: unknown): value is UserRole {
  return value === 'user' || value === 'admin';
}

function toAccount(row: UserRow): UserAccount {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    picture: row.picture,
    role: isRole(row.role) ? row.role : 'user',
    // Coerced rather than trusted: a row naming a plan this build removed must
    // read as the smallest plan, not as an entitlement nobody granted.
    plan: (isAccountPlanId(row.plan) ? row.plan : DEFAULT_ACCOUNT_PLAN) as AccountPlanId,
    credits: Number.isFinite(row.credits) ? row.credits : 0,
    disabled: row.disabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.last_login_at ? { lastLoginAt: row.last_login_at } : {}),
    ...(row.sheet_id ? { sheetId: row.sheet_id } : {}),
    ...(row.sheet_url ? { sheetUrl: row.sheet_url } : {}),
    ...(row.sheet_tab_date ? { sheetTabDate: row.sheet_tab_date } : {}),
    ...(row.sheet_tab_gid ? { sheetTabGid: row.sheet_tab_gid } : {}),
    ...(row.sheet_shared_at ? { sheetSharedAt: row.sheet_shared_at } : {}),
  };
}

/**
 * Claims the Stripe customer for this account, or reports who won.
 *
 * Conditional on the column still being empty, because two payments started in
 * two tabs both create a customer at Stripe and both try to record one. The
 * loser uses the winner's id and leaves an orphan customer behind at Stripe,
 * which costs nothing and is preferable to two customers both holding half of
 * somebody's saved cards.
 */
/**
 * The Stripe customer this account's saved cards hang off, or ''.
 *
 * A read of its own rather than a field on `UserAccount`, and that is the
 * point: `routes/auth.ts` and `routes/accounts.ts` both serialize an account
 * by spreading it, so anything on that type is served to a browser - and an
 * administrator's account list would have carried every customer's handle.
 * It is not a secret (nothing can be done with it without the secret key,
 * which is not in this database) but it is a handle at a third party with no
 * business leaving this process, which is the same rule `GET /payments/cards`
 * follows for the payment-method id beside it.
 */
export function getStripeCustomerId(userId: string): string {
  const row = getDb()
    .prepare('SELECT stripe_customer_id FROM users WHERE id = ?')
    .get(userId) as { stripe_customer_id: string | null } | undefined;
  return row?.stripe_customer_id || '';
}

export function claimStripeCustomer(userId: string, customerRef: string): string {
  const db = getDb();
  db.prepare(
    `UPDATE users SET stripe_customer_id = @ref, updated_at = @at
     WHERE id = @id AND (stripe_customer_id IS NULL OR stripe_customer_id = '')`
  ).run({ id: userId, ref: customerRef, at: now() });

  const row = db
    .prepare('SELECT stripe_customer_id FROM users WHERE id = ?')
    .get(userId) as { stripe_customer_id: string | null } | undefined;
  return row?.stripe_customer_id || customerRef;
}

export function getUserById(id: string): UserAccount | null {
  const row = getDb()
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`)
    .get(id) as UserRow | undefined;
  return row ? toAccount(row) : null;
}

export function getUserByEmail(email: string): UserAccount | null {
  const row = getDb()
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE email = ?`)
    .get(normalizeEmail(email)) as UserRow | undefined;
  return row ? toAccount(row) : null;
}

export function listUsers(): UserAccount[] {
  const rows = getDb()
    .prepare(`SELECT ${USER_COLUMNS} FROM users ORDER BY created_at ASC`)
    .all() as UserRow[];
  return rows.map(toAccount);
}

export function countAdmins(): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0")
    .get() as { n: number };
  return row.n;
}

/** The earliest admin, which is who orphaned rows are handed to on migration. */
export function getFirstAdmin(): UserAccount | null {
  const row = getDb()
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1`)
    .get() as UserRow | undefined;
  return row ? toAccount(row) : null;
}

export type CreateUserInput = {
  email: string;
  name?: string;
  picture?: string;
  googleSub?: string;
  /** Set only by the seeding path; everything else takes the default. */
  role?: UserRole;
};

/**
 * The role a brand new account is created with.
 *
 * Configuration decides, never arrival order - see config/adminIdentity for why.
 */
function roleForNewUser(email: string, requested?: UserRole): UserRole {
  if (requested) return requested;
  // ADMIN_EMAILS, else SMTP_USER, else nobody - see config/adminIdentity. There
  // is no longer a "first account wins" rule: on a server anybody can reach,
  // that handed the installation to whoever signed up first.
  return isConfiguredAdmin(email) ? 'admin' : 'user';
}

/**
 * Promotes an account the configuration says should be an administrator.
 *
 * Promote only, never demote. A demoting version would mean a typo in .env, or
 * an SMTP provider swapped for one that uses a username, locks the operator out
 * of their own installation with no way back through the UI. Returns true when
 * it actually changed something, so the caller can say so and re-run the
 * ownership migration that waits for an admin to exist.
 */
export function promoteIfConfiguredAdmin(account: UserAccount): boolean {
  if (account.role === 'admin' || !isConfiguredAdmin(account.email)) return false;

  getDb()
    .prepare("UPDATE users SET role = 'admin', updated_at = ? WHERE id = ? AND role <> 'admin'")
    .run(now(), account.id);
  console.log(`[auth] ${account.email} is configured as an administrator; role updated.`);
  return true;
}

/** The startup pass. Same rule, applied to accounts that already existed. */
export function promoteConfiguredAdmins(): number {
  const { emails } = resolveAdminIdentity();
  let promoted = 0;
  for (const email of emails) {
    const account = getUserByEmail(email);
    if (account && promoteIfConfiguredAdmin(account)) promoted += 1;
  }
  return promoted;
}

/**
 * Credits given to a brand-new account, when an operator configured any.
 *
 * Imported lazily inside `createUser` rather than at the top of this module,
 * because services/credits imports this file to read an account back - and a
 * static import both ways is a cycle that leaves one of them half-initialised.
 */
function applyOpeningGrant(account: UserAccount): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const credits = require('../services/credits') as typeof import('../services/credits');
    credits.applySignupGrant(account);
  } catch (error) {
    // An account that exists with no welcome credits is recoverable by an
    // admin; an account that failed to be created is not.
    console.warn('[credits] Could not apply the signup grant to a new account.', error);
  }
}

export function createUser(input: CreateUserInput): UserAccount {
  const email = normalizeEmail(input.email);
  if (!email) throw new Error('An email address is required to create an account.');

  const timestamp = now();
  const account: UserRow = {
    id: randomUUID(),
    email,
    name: (input.name ?? '').trim() || email.split('@')[0],
    picture: input.picture ?? '',
    role: roleForNewUser(email, input.role),
    plan: DEFAULT_ACCOUNT_PLAN,
    // Zero, and nothing in this release spends them. The balance exists so an
    // admin can grant it and so the account page has something true to show.
    credits: 0,
    google_sub: input.googleSub ?? null,
    disabled: 0,
    created_at: timestamp,
    updated_at: timestamp,
    last_login_at: null,
    // Allocated after the account exists, by the sheets service. Creating a
    // spreadsheet is several network calls, and none of them belongs inside the
    // transaction that makes somebody an account.
    sheet_id: null,
    sheet_url: null,
    sheet_tab_date: null,
    sheet_tab_gid: null,
    sheet_shared_at: null,
    // Never looked, which is true and means the notices posted before this
    // account existed still read as new to it.
    notifications_seen_at: null,
    // Created at Stripe only when a card is first kept.
    stripe_customer_id: null,
  };

  getDb()
    .prepare(
      `INSERT INTO users (${USER_COLUMNS})
       VALUES (@id, @email, @name, @picture, @role, @plan, @credits, @google_sub, @disabled,
               @created_at, @updated_at, @last_login_at, @sheet_id, @sheet_url, @sheet_tab_date,
               @sheet_tab_gid, @sheet_shared_at, @notifications_seen_at,
               @stripe_customer_id)`
    )
    .run(account);

  const created = toAccount(account);
  applyOpeningGrant(created);
  // Re-read, so the caller sees the balance the grant left rather than the zero
  // the row was inserted with.
  return getUserById(created.id) ?? created;
}

/**
 * The account for an address, creating it on first sign-in.
 *
 * There is no separate registration step by design: both sign-in paths prove
 * control of an address, and that is the whole of what registration would have
 * established.
 */
export function findOrCreateUser(input: CreateUserInput): { account: UserAccount; created: boolean } {
  const existing = getUserByEmail(input.email);
  if (existing) {
    // Google's name and picture are refreshed on the way through; a code
    // sign-in carries neither and must not blank what Google set.
    const patch: string[] = [];
    const values: Record<string, unknown> = { id: existing.id, updated_at: now() };
    if (input.name && input.name.trim() && input.name.trim() !== existing.name) {
      patch.push('name = @name');
      values.name = input.name.trim();
    }
    if (input.picture && input.picture !== existing.picture) {
      patch.push('picture = @picture');
      values.picture = input.picture;
    }
    if (input.googleSub) {
      patch.push('google_sub = @google_sub');
      values.google_sub = input.googleSub;
    }
    if (patch.length > 0) {
      getDb()
        .prepare(`UPDATE users SET ${patch.join(', ')}, updated_at = @updated_at WHERE id = @id`)
        .run(values);
      return { account: getUserById(existing.id) ?? existing, created: false };
    }
    return { account: existing, created: false };
  }

  return { account: createUser(input), created: true };
}

export function updateUser(id: string, update: AccountUpdate): UserAccount | null {
  const existing = getUserById(id);
  if (!existing) return null;

  const patch: string[] = [];
  const values: Record<string, unknown> = { id, updated_at: now() };

  if (update.role !== undefined) {
    patch.push('role = @role');
    values.role = update.role;
  }
  if (update.plan !== undefined) {
    patch.push('plan = @plan');
    values.plan = update.plan;
  }
  // NO `credits` BRANCH. It used to be here, as an absolute SET, and that is
  // exactly why it had to go: two debits arriving together composed as "last one
  // wins" and the first spend simply vanished. Every balance change now goes
  // through creditRepository, which moves it with a conditional UPDATE inside a
  // transaction and writes a ledger row explaining the move. `setBalance` in
  // services/credits is what the admin page's field calls.
  if (update.disabled !== undefined) {
    patch.push('disabled = @disabled');
    values.disabled = update.disabled ? 1 : 0;
  }
  if (update.name !== undefined) {
    patch.push('name = @name');
    values.name = update.name.trim();
  }

  if (patch.length === 0) return existing;

  getDb()
    .prepare(`UPDATE users SET ${patch.join(', ')}, updated_at = @updated_at WHERE id = @id`)
    .run(values);
  return getUserById(id);
}

/**
 * Claims the spreadsheet slot for an account, once.
 *
 * Conditional on purpose. Two callers can reach the allocation at the same
 * moment - a sign-in and the Account page loading beside it - and both will have
 * created a spreadsheet by the time either writes. The WHERE clause makes the
 * second write a no-op rather than a silent overwrite, and returning false lets
 * the loser adopt the winner's sheet and say so in the log instead of leaving
 * two spreadsheets with one of them unreachable.
 */
export function recordAccountSheet(id: string, sheetId: string, sheetUrl: string): boolean {
  const result = getDb()
    .prepare(
      `UPDATE users SET sheet_id = @sheet_id, sheet_url = @sheet_url, updated_at = @updated_at
       WHERE id = @id AND (sheet_id IS NULL OR sheet_id = '')`
    )
    .run({ id, sheet_id: sheetId, sheet_url: sheetUrl, updated_at: now() });
  return result.changes > 0;
}

/** Remembers that today's tab is prepared, so the next sign-in calls nobody. */
export function recordSheetTabDate(id: string, date: string, gid?: number): void {
  getDb()
    .prepare('UPDATE users SET sheet_tab_date = ?, sheet_tab_gid = ?, updated_at = ? WHERE id = ?')
    .run(date, gid === undefined ? null : String(gid), now(), id);
}

/**
 * The account a spreadsheet belongs to, if any.
 *
 * The inverse lookup, and it exists for one purpose: telling a route that an id
 * it was handed is somebody's personal sheet rather than a spreadsheet shared
 * with this installation. The service account can open both, so nothing else
 * distinguishes them.
 */
export function getUserBySheetId(sheetId: string): UserAccount | null {
  const wanted = sheetId.trim();
  if (!wanted) return null;
  const row = getDb()
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE sheet_id = ?`)
    .get(wanted) as UserRow | undefined;
  return row ? toAccount(row) : null;
}

/**
 * Remembers that the owner holds their own grant on the spreadsheet.
 *
 * The point of storing it is to stop asking. Confirming the grant costs a Drive
 * `permissions.list`, and doing that on every sign-in spends a per-minute quota
 * on a question whose answer has not changed since the account was created.
 */
export function recordOwnerGrant(id: string, at: string): void {
  getDb()
    .prepare('UPDATE users SET sheet_shared_at = ?, updated_at = ? WHERE id = ?')
    .run(at, now(), id);
}

/** Accounts from before this feature, in creation order, for the boot backfill. */
export function listAccountsWithoutSheet(): UserAccount[] {
  return (
    getDb()
      .prepare(
        `SELECT ${USER_COLUMNS} FROM users
         WHERE (sheet_id IS NULL OR sheet_id = '') AND disabled = 0
         ORDER BY created_at ASC`
      )
      .all() as UserRow[]
  ).map(toAccount);
}

export function markSignedIn(id: string): void {
  getDb().prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), id);
}

export function deleteUser(id: string): boolean {
  const db = getDb();
  // Named before the row goes, because afterwards nothing connects the file to
  // anybody. The spreadsheet is deliberately NOT deleted - it may hold months
  // of somebody's work, and an account removed by mistake is recoverable while
  // a deleted Drive file is much less so. It does keep counting against the
  // service account's quota, which is why the id is logged rather than lost.
  const orphan = getUserById(id);
  if (orphan?.sheetId) {
    console.log(
      `[sheets] ${orphan.email} is being deleted; spreadsheet ${orphan.sheetId} is now unreferenced ` +
        'and still counts against the service account quota.'
    );
  }

  return db.transaction(() => {
    db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(id);
    return db.prepare('DELETE FROM users WHERE id = ?').run(id).changes > 0;
  })();
}

/* ------------------------------------------------------------------ sessions */

/**
 * Only the hash is stored, so the database never holds a usable session token.
 *
 * Plain SHA-256 rather than a slow password hash, and that is the right choice
 * here for a reason worth stating: this input is 32 bytes of `randomBytes`, not
 * something a person chose. There is no dictionary to run against it, so the
 * work factor that defends a password buys nothing, and it would be paid on
 * every single authenticated request.
 */
function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function createSession(userId: string, ttlMs: number = SESSION_TTL_MS): string {
  const token = crypto.randomBytes(32).toString('base64url');
  const created = new Date();
  getDb()
    .prepare(
      `INSERT INTO user_sessions (token_hash, user_id, created_at, expires_at, last_seen)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      hashToken(token),
      userId,
      created.toISOString(),
      new Date(created.getTime() + ttlMs).toISOString(),
      created.toISOString()
    );
  return token;
}

/**
 * The account behind a session token, or null.
 *
 * A disabled account resolves to null even with a live session, which is what
 * makes disabling take effect immediately rather than at the end of the day.
 */
export function resolveSession(token: string): UserAccount | null {
  if (!token) return null;
  const db = getDb();
  const row = db
    .prepare('SELECT user_id, expires_at FROM user_sessions WHERE token_hash = ?')
    .get(hashToken(token)) as { user_id: string; expires_at: string } | undefined;
  if (!row) return null;

  if (Date.parse(row.expires_at) <= Date.now()) {
    db.prepare('DELETE FROM user_sessions WHERE token_hash = ?').run(hashToken(token));
    return null;
  }

  const account = getUserById(row.user_id);
  if (!account || account.disabled) return null;

  db.prepare('UPDATE user_sessions SET last_seen = ? WHERE token_hash = ?').run(now(), hashToken(token));
  return account;
}

export function destroySession(token: string): void {
  if (!token) return;
  getDb().prepare('DELETE FROM user_sessions WHERE token_hash = ?').run(hashToken(token));
}

/** Every session for an account. Used when disabling or deleting one. */
export function destroySessionsForUser(userId: string): number {
  return getDb().prepare('DELETE FROM user_sessions WHERE user_id = ?').run(userId).changes;
}

export function pruneExpiredSessions(): number {
  return getDb().prepare('DELETE FROM user_sessions WHERE expires_at <= ?').run(now()).changes;
}

/* --------------------------------------------------------------- login codes */

export const LOGIN_CODE_TTL_MS = 10 * 60_000;
export const LOGIN_CODE_MAX_ATTEMPTS = 5;

/**
 * A six-digit code, drawn from a cryptographic source.
 *
 * `randomInt` rather than `Math.random`, and the rejection sampling that comes
 * with it, because the whole security of this flow is that the code cannot be
 * guessed. Six digits is a million values against five attempts, which is the
 * balance the attempt cap and the ten-minute expiry are there to hold.
 */
export function generateLoginCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

export function storeLoginCode(email: string, code: string, ttlMs = LOGIN_CODE_TTL_MS): void {
  const address = normalizeEmail(email);
  const db = getDb();
  db.transaction(() => {
    // Any earlier code for this address is dropped, so a fresh request always
    // means exactly one live code - otherwise "resend" would widen the guess
    // space every time somebody clicked it.
    db.prepare('DELETE FROM login_codes WHERE email = ?').run(address);
    db.prepare(
      `INSERT INTO login_codes (id, email, code_hash, attempts, created_at, expires_at, consumed_at)
       VALUES (?, ?, ?, 0, ?, ?, NULL)`
    ).run(
      randomUUID(),
      address,
      hashToken(code),
      now(),
      new Date(Date.now() + ttlMs).toISOString()
    );
  })();
}

export type LoginCodeCheck =
  | { ok: true }
  | { ok: false; reason: 'no-code' | 'expired' | 'too-many-attempts' | 'wrong-code' };

/**
 * Checks a submitted code and consumes it on success.
 *
 * A wrong guess costs an attempt; the fifth burns the code entirely rather than
 * merely refusing that guess, so an attacker cannot keep the same code alive
 * for the full ten minutes.
 */
export function consumeLoginCode(email: string, code: string): LoginCodeCheck {
  const address = normalizeEmail(email);
  const db = getDb();
  const row = db
    .prepare('SELECT id, code_hash, attempts, expires_at, consumed_at FROM login_codes WHERE email = ?')
    .get(address) as
    | { id: string; code_hash: string; attempts: number; expires_at: string; consumed_at: string | null }
    | undefined;

  if (!row || row.consumed_at) return { ok: false, reason: 'no-code' };

  if (Date.parse(row.expires_at) <= Date.now()) {
    db.prepare('DELETE FROM login_codes WHERE id = ?').run(row.id);
    return { ok: false, reason: 'expired' };
  }

  if (row.attempts >= LOGIN_CODE_MAX_ATTEMPTS) {
    db.prepare('DELETE FROM login_codes WHERE id = ?').run(row.id);
    return { ok: false, reason: 'too-many-attempts' };
  }

  // Constant-time, so the number of leading digits that matched cannot be read
  // off how long the comparison took. Both sides are fixed-length hex digests,
  // which is what makes timingSafeEqual usable at all - it throws on a length
  // mismatch, and hashing first removes that possibility.
  const submitted = Buffer.from(hashToken(code), 'utf8');
  const stored = Buffer.from(row.code_hash, 'utf8');
  const matches = submitted.length === stored.length && crypto.timingSafeEqual(submitted, stored);

  if (!matches) {
    const attempts = row.attempts + 1;
    if (attempts >= LOGIN_CODE_MAX_ATTEMPTS) {
      db.prepare('DELETE FROM login_codes WHERE id = ?').run(row.id);
      return { ok: false, reason: 'too-many-attempts' };
    }
    db.prepare('UPDATE login_codes SET attempts = ? WHERE id = ?').run(attempts, row.id);
    return { ok: false, reason: 'wrong-code' };
  }

  db.prepare('DELETE FROM login_codes WHERE id = ?').run(row.id);
  return { ok: true };
}

/** How long ago the live code for an address was sent, or null if there is none. */
export function lastCodeSentAt(email: string): number | null {
  const row = getDb()
    .prepare('SELECT created_at FROM login_codes WHERE email = ? ORDER BY created_at DESC LIMIT 1')
    .get(normalizeEmail(email)) as { created_at: string } | undefined;
  if (!row) return null;
  const parsed = Date.parse(row.created_at);
  return Number.isFinite(parsed) ? parsed : null;
}

export function pruneExpiredLoginCodes(): number {
  return getDb().prepare('DELETE FROM login_codes WHERE expires_at <= ?').run(now()).changes;
}
