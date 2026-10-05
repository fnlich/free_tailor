import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';

/**
 * Credits became dollars, and this is the one-time switch.
 *
 * Before it, a credit was a whole unit bought at a price (50c by default, $1
 * bought two) and a model cost a whole number of them. Since, a credit IS a
 * dollar, counted in thousandths (utils/money.ts): balances, prices, charges
 * and refunds are integer milli-dollars, in NEW columns beside the old ones
 * (sqlite.ts). The owner's decision for what was already there (M1) is a
 * RESET, not a conversion: every balance goes to $0, every model's price goes
 * to $0.000 until an administrator sets real ones, and the payments and the
 * old history stay as read-only records of what happened in credits.
 *
 * What the switch does, in one IMMEDIATE transaction:
 *
 *   - every account with a non-zero old balance, or credits held by a run in
 *     progress, gets a `reset` row in its history taking that balance to
 *     zero, in the old unit, so the jump is explained where somebody looks
 *     for it; `users.credits` is zeroed. One whose credits were ALL held (a
 *     balance of 0, spent on a run still going) gets the row too, moving
 *     nothing: its run is about to stop refunding, and without the row its
 *     history would end at the reserve with no word on why. An account whose
 *     balance predates the ledger (migration 004 has not run - the chain
 *     waits at 003 for an administrator) first gets the opening row 004 would
 *     have written, under 004's own key, so its old history still adds up and
 *     004 finds nothing left to do.
 *   - every reservation still open in credits is CLOSED. Its run goes on and
 *     finishes on the credits it was paid with before the switch; a resume of
 *     it that fails gives back nothing, because the credits it would give
 *     back were reset with the balance. Neither free (it was paid for) nor
 *     charged twice (nothing is taken in dollars).
 *   - every queued or finished task gets `payload.costMilli = 0`, which says
 *     the same thing on the task: what it was charged in dollars, which is
 *     nothing, so no refund hook can ever give dollars back for credits. Its
 *     `creditCost` is left as the record of what it cost then.
 *   - every PENDING payment is stamped with what it will credit, at a dollar
 *     a dollar: a checkout opened before the switch and paid after it gets
 *     exactly what was charged. A paid one is history and is left alone.
 *
 * Every model's price goes to $0.000 BY RULE, not by a write: the price is
 * `pricePerResumeMilli`, which no record had before this build, and a record
 * without one reads as $0.000 (config/pricePerResume.ts); its old
 * `creditsPerResume` - another unit - is never read as a price. So the
 * settings row is left exactly as it was. Rewriting it here, outside the
 * migration chain, would change what migration 001 snapshots for `npm run
 * ai:rollback` on an install that has not run it yet, and would be the one
 * write to that row that bypasses the settings module; it would also change
 * nothing anybody could observe. Admin -> Models lists every enabled model at
 * $0.000 in red until it is priced, and its next save writes the field.
 *
 * Everything it changed is kept, before the change, in
 * `app_settings["migration-log.credits-to-dollars"]` - balances, held
 * credits, reservations, tasks, pending payments, model prices and the old
 * pricing settings - and `schema_meta.credit_unit = 'usd-milli'` records that
 * it ran, so it runs once.
 *
 * In getDb() and NOT in the numbered chain: the chain waits at 003 until an
 * administrator exists, for as long as nobody signs in, while this build
 * already reads balances from `balance_milli`. Never fatal, and harmless to
 * have not run: every dollar column starts at 0, a task without `costMilli`
 * refunds nothing, and a model without `pricePerResumeMilli` reads as free -
 * so until it runs, the old data already reads as reset. It only makes that
 * explicit, and leaves the rows that explain it. A switch that fails is tried
 * again at the next start.
 */

export const DOLLAR_SWITCH_MARKER = 'credit_unit';
export const DOLLAR_SWITCH_UNIT = 'usd-milli';
export const DOLLAR_SWITCH_LOG_KEY = 'migration-log.credits-to-dollars';

const APP_SETTINGS_KEY = 'app-settings';

export type DollarSwitchReport = {
  switchedAt: string;
  /** Accounts that held credits or had credits held, before the switch. */
  accounts: Array<{ userId: string; email: string; credits: number; held: number }>;
  /** How many `reset` rows were written: one per account with a non-zero balance, or credits held by a run. */
  resetRows: number;
  /** Reservations closed, as they were. */
  reservations: Array<{ id: string; userId: string; kind: string; units: number; refunded: number }>;
  /** Tasks still to run or running, given `costMilli: 0`, with the credit cost they carried. */
  tasks: Array<{ id: string; batchId: string; state: string; creditCost: number | null }>;
  /** Every task row given `costMilli: 0`, finished ones included. */
  tasksPriced: number;
  /** Pending payments stamped with what they will credit. */
  pendingPayments: Array<{ id: string; reference: string; amountCents: number; credits: number }>;
  /** Stored models, with the price each had - every one of which now reads as $0.000. */
  models: Array<{ id: string; name: string; creditsPerResume: unknown }>;
  /** The retired pricing settings, as stored - a credit's price, the purchase bounds, the fees. */
  pricing: Record<string, unknown> | null;
  /** True when the settings row could not be parsed, so no model price was recorded. */
  settingsUnreadable: boolean;
};

const REQUIRED_COLUMNS: ReadonlyArray<[string, string]> = [
  ['users', 'balance_milli'],
  ['credit_ledger', 'delta_milli'],
  ['credit_reservations', 'units_milli'],
  ['payments', 'credit_milli'],
];

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((entry) => entry.name === column);
}

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function alreadySwitched(db: Database.Database): boolean {
  if (!tableExists(db, 'schema_meta')) return false;
  return Boolean(db.prepare('SELECT 1 FROM schema_meta WHERE key = ?').get(DOLLAR_SWITCH_MARKER));
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * The sentence a reset row adds for credits a run still held - why that run's
 * failures stop giving anything back. Empty when nothing was held.
 */
function heldNote(held: number, more: boolean): string {
  if (held <= 0) return '';
  return (
    ` ${plural(held, more ? 'more credit' : 'credit')} ${held === 1 ? 'was' : 'were'} held by a run in progress, ` +
    'which finishes on them; a resume of it that fails gives nothing back.'
  );
}

function resetAccounts(db: Database.Database, timestamp: string, report: DollarSwitchReport): void {
  const accounts = db.prepare('SELECT id, email, credits FROM users ORDER BY created_at, id').all() as Array<{
    id: string;
    email: string;
    credits: number;
  }>;
  const heldBy = new Map<string, number>(
    (
      db
        .prepare(
          `SELECT user_id AS userId, COALESCE(SUM(units - refunded), 0) AS held
             FROM credit_reservations WHERE state = 'open' GROUP BY user_id`
        )
        .all() as Array<{ userId: string; held: number }>
    ).map((row) => [row.userId, row.held])
  );

  const hasLedger = db.prepare('SELECT 1 FROM credit_ledger WHERE user_id = ? LIMIT 1');
  const insertRow = db.prepare(
    `INSERT OR IGNORE INTO credit_ledger
       (id, user_id, delta, balance_after, delta_milli, balance_after_milli, reason, ref_kind, ref_id,
        actor_id, note, idempotency_key, created_at)
     VALUES (@id, @userId, @delta, @balanceAfter, 0, 0, @reason, 'user', @userId, NULL, @note, @key, @createdAt)`
  );
  const zero = db.prepare('UPDATE users SET credits = 0 WHERE id = ?');

  for (const account of accounts) {
    const credits = Number.isSafeInteger(account.credits) ? account.credits : 0;
    const held = heldBy.get(account.id) ?? 0;
    if (credits === 0 && held === 0) continue;
    report.accounts.push({ userId: account.id, email: account.email, credits, held });

    if (credits === 0) {
      // Everything it had is in a run still going. Nothing to take to zero -
      // but closing that reservation below means a resume of it that fails
      // now gives nothing back, which it did a moment ago, and this row is
      // the one place the account can read why. It moves nothing (delta 0),
      // so the old history still sums to the old column, and it is read as
      // a row in credits like every other reset row (creditRepository's
      // toEntry), not as a "+$0.000" movement. No opening row: a balance of
      // 0 has nothing to carry over.
      insertRow.run({
        id: `led_${randomUUID()}`,
        userId: account.id,
        delta: 0,
        balanceAfter: 0,
        reason: 'reset',
        note: `Credits became dollars: this account's balance was already 0 credits.${heldNote(held, false)}`,
        key: `reset:dollars:${account.id}:${timestamp}`,
        createdAt: timestamp,
      });
      report.resetRows += 1;
      continue;
    }

    // A balance from before the ledger, with no row behind it: the row 004
    // writes, under 004's key, so the old history sums to the balance the
    // reset row then takes away - and 004, whenever the chain reaches it,
    // finds this account explained already.
    if (!hasLedger.get(account.id)) {
      insertRow.run({
        id: `led_${randomUUID()}`,
        userId: account.id,
        delta: credits,
        balanceAfter: credits,
        reason: 'opening-balance',
        note: 'Balance carried over from before the ledger existed.',
        key: `opening:${account.id}`,
        createdAt: timestamp,
      });
    }

    insertRow.run({
      id: `led_${randomUUID()}`,
      userId: account.id,
      delta: -credits,
      balanceAfter: 0,
      reason: 'reset',
      note:
        `Credits became dollars: this account's ${plural(credits, 'credit')} ${credits === 1 ? 'was' : 'were'} ` +
        `reset to $0.000.${heldNote(held, true)}`,
      // Per pass: the marker stops a second one, and a pass run again on
      // purpose (the marker deleted by hand, after a rollback that granted
      // credits again) explains its own reset rather than zeroing silently.
      key: `reset:dollars:${account.id}:${timestamp}`,
      createdAt: timestamp,
    });
    report.resetRows += 1;
    zero.run(account.id);
  }
}

function closeOpenReservations(db: Database.Database, timestamp: string, report: DollarSwitchReport): void {
  const open = db
    .prepare(
      `SELECT id, user_id AS userId, kind, units, refunded FROM credit_reservations
        WHERE state = 'open' AND units_milli = 0 ORDER BY created_at`
    )
    .all() as DollarSwitchReport['reservations'];
  if (open.length === 0) return;
  report.reservations = open;
  db.prepare(
    "UPDATE credit_reservations SET state = 'closed', updated_at = ? WHERE state = 'open' AND units_milli = 0"
  ).run(timestamp);
}

function priceTasks(db: Database.Database, report: DollarSwitchReport): void {
  const rows = db.prepare('SELECT id, batch_id AS batchId, state, data FROM generation_tasks').all() as Array<{
    id: string;
    batchId: string;
    state: string;
    data: string;
  }>;
  const write = db.prepare('UPDATE generation_tasks SET data = ? WHERE id = ?');
  for (const row of rows) {
    let data: Record<string, unknown> | null;
    try {
      data = objectOrNull(JSON.parse(row.data));
    } catch {
      continue;
    }
    const payload = objectOrNull(data?.payload);
    if (!data || !payload || payload.costMilli !== undefined) continue;
    write.run(JSON.stringify({ ...data, payload: { ...payload, costMilli: 0 } }), row.id);
    report.tasksPriced += 1;
    if (row.state === 'queued' || row.state === 'running') {
      report.tasks.push({
        id: row.id,
        batchId: row.batchId,
        state: row.state,
        creditCost: typeof payload.creditCost === 'number' ? payload.creditCost : null,
      });
    }
  }
}

function stampPendingPayments(db: Database.Database, report: DollarSwitchReport): void {
  report.pendingPayments = db
    .prepare(
      `SELECT id, reference, amount_cents AS amountCents, credits FROM payments
        WHERE state = 'pending' AND credit_milli = 0`
    )
    .all() as DollarSwitchReport['pendingPayments'];
  db.prepare(
    "UPDATE payments SET credit_milli = amount_cents * 10 WHERE state = 'pending' AND credit_milli = 0"
  ).run();
}

/** The keys of the stored settings that priced a credit, kept in the log as they were. */
const RETIRED_PRICING_KEYS = ['creditPriceCents', 'creditMinCredits', 'creditMaxCredits', 'paymentLimits'];

/** The old prices and pricing settings, into the snapshot. Reads only - see the module note. */
function snapshotModelPrices(db: Database.Database, report: DollarSwitchReport): void {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(APP_SETTINGS_KEY) as
    | { value: string }
    | undefined;
  if (!row) return;
  let settings: Record<string, unknown> | null;
  try {
    settings = objectOrNull(JSON.parse(row.value));
  } catch {
    settings = null;
  }
  if (!settings) {
    // A row nobody can parse is the settings reader's to report, not this one's.
    report.settingsUnreadable = true;
    return;
  }

  const pricing: Record<string, unknown> = {};
  for (const key of RETIRED_PRICING_KEYS) {
    if (settings[key] !== undefined) pricing[key] = settings[key];
  }
  report.pricing = Object.keys(pricing).length > 0 ? pricing : null;

  if (!Array.isArray(settings.aiModels)) return;
  for (const entry of settings.aiModels) {
    const model = objectOrNull(entry);
    if (!model) continue;
    report.models.push({
      id: typeof model.id === 'string' ? model.id : '',
      name: typeof model.name === 'string' ? model.name : '',
      creditsPerResume: model.creditsPerResume ?? null,
    });
  }
}

/** Runs the switch once. Returns what it did, or null when it had already run (or could not). */
export function switchCreditsToDollars(db: Database.Database): DollarSwitchReport | null {
  let report: DollarSwitchReport | null = null;
  try {
    // Read first, outside any lock: every start after the switch finds the
    // marker here and should not queue for the write lock to learn it.
    if (alreadySwitched(db)) return null;
    for (const [table, column] of REQUIRED_COLUMNS) {
      if (!tableExists(db, table) || !hasColumn(db, table, column)) {
        console.warn(
          `[credits] ${table}.${column} is missing, so credits could not be switched to dollars yet; ` +
            'trying again at the next start.'
        );
        return null;
      }
    }

    db.transaction(() => {
      // Again under the lock: a second process opening the same file waits
      // here for the first, then finds the marker it wrote.
      if (alreadySwitched(db)) return;
      const timestamp = new Date().toISOString();
      const done: DollarSwitchReport = {
        switchedAt: timestamp,
        accounts: [],
        resetRows: 0,
        reservations: [],
        tasks: [],
        tasksPriced: 0,
        pendingPayments: [],
        models: [],
        pricing: null,
        settingsUnreadable: false,
      };

      resetAccounts(db, timestamp, done);
      closeOpenReservations(db, timestamp, done);
      priceTasks(db, done);
      stampPendingPayments(db, done);
      snapshotModelPrices(db, done);

      db.prepare(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      ).run(DOLLAR_SWITCH_LOG_KEY, JSON.stringify(done), timestamp);
      db.prepare(
        `INSERT INTO schema_meta (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      ).run(DOLLAR_SWITCH_MARKER, DOLLAR_SWITCH_UNIT, timestamp);
      report = done;
    }).immediate();
  } catch (error) {
    console.warn(
      '[credits] Could not switch credits to dollars; balances read as $0 until it runs, and it is tried ' +
        'again at the next start.',
      error
    );
    return null;
  }

  const result = report as DollarSwitchReport | null;
  if (result) describeSwitch(result);
  return result;
}

function describeSwitch(report: DollarSwitchReport): void {
  // A fresh database has nothing to say beyond the unit.
  const changed =
    report.resetRows > 0 ||
    report.reservations.length > 0 ||
    report.tasksPriced > 0 ||
    report.pendingPayments.length > 0 ||
    report.models.length > 0;
  if (!changed) {
    console.log('[credits] Credits are dollars, counted in thousandths ($0.001).');
    return;
  }
  const parts = [
    `${plural(report.resetRows, 'account')} reset to $0.000, with a reset row in each one's history`,
    ...(report.reservations.length > 0
      ? [`${plural(report.reservations.length, 'run')} in progress settled on the credits already paid`]
      : []),
    ...(report.tasks.length > 0
      ? [`${plural(report.tasks.length, 'queued resume')} priced at $0.000, so a failure gives back nothing`]
      : []),
    ...(report.pendingPayments.length > 0
      ? [`${plural(report.pendingPayments.length, 'unpaid checkout')} set to credit exactly what it charges`]
      : []),
    ...(report.models.length > 0 ? [`${plural(report.models.length, 'model')} now priced at $0.000`] : []),
  ];
  console.log(`[credits] Credits are dollars now: ${parts.join('; ')}.`);
  if (report.models.length > 0) {
    console.warn(
      '[credits] Every model is FREE until it is priced: set a price per resume for each under Admin -> Models.'
    );
  }
  console.log(`[credits] What was there before is kept in app_settings["${DOLLAR_SWITCH_LOG_KEY}"].`);
}
