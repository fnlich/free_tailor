import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { switchCreditsToDollars } from './dollarSwitch';
import { moveTemplateRowsToFiles } from './templateFileMove';
import { runDataMigrations } from './migrations';

const POSIX_DEFAULT_DATABASE_DIR = '/data/db';

/**
 * Where the database lives when `DB_DIR` is not set.
 *
 * `/data/db` is the container convention this app was built around, and it
 * stays the default everywhere it means something. On Windows it means
 * nothing: `path.resolve('/data/db')` is `C:\data\db`, and creating a
 * directory at the root of the system drive needs administrator rights, so the
 * first `getDb()` fails with EPERM before the server has done anything.
 * Windows gets the platform's own answer for per-user application data
 * instead, which is writable without elevation and survives reinstalls.
 */
export function getDefaultDatabaseDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir
): string {
  if (platform !== 'win32') {
    return POSIX_DEFAULT_DATABASE_DIR;
  }

  // LOCALAPPDATA is the roaming-excluded profile store and is set on every
  // supported Windows; APPDATA and the profile are only fallbacks for a
  // stripped service environment.
  const base = env.LOCALAPPDATA?.trim() || env.APPDATA?.trim();
  if (base) {
    return path.win32.join(base, 'free_tailor', 'db');
  }
  return path.win32.join(homedir(), 'AppData', 'Local', 'free_tailor', 'db');
}

const DATABASE_FILE_NAME = 'free_tailor.db';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS profiles (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    disabled   INTEGER NOT NULL DEFAULT 0,
    data       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS profile_groups (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    data       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS templates (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    disabled   INTEGER NOT NULL DEFAULT 0,
    data       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS template_overrides (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    disabled   INTEGER NOT NULL DEFAULT 0,
    data       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS prompts (
    id          TEXT PRIMARY KEY,
    feature_key TEXT,
    is_built_in INTEGER NOT NULL DEFAULT 0,
    data        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS skills (
    type      TEXT NOT NULL,
    skill_key TEXT NOT NULL,
    skill     TEXT NOT NULL,
    priority  INTEGER,
    category  TEXT,
    PRIMARY KEY (type, skill_key)
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT
  );

  /**
   * Generation batches, so a run survives the server restarting.
   *
   * Two tables rather than one blob per batch, because the write pattern is
   * lopsided: a batch is written once and read rarely, while its tasks change
   * state four times each. Thirty resumes is a hundred and twenty transitions,
   * and re-writing the whole batch each time would mean re-writing every job
   * description with it - about a megabyte a transition for a sheet import.
   *
   * The job descriptions live HERE, on the batch, once. A task refers to its job
   * by index rather than carrying a copy, which is the same saving again: thirty
   * tasks on one job would otherwise hold thirty copies of its posting.
   */
  CREATE TABLE IF NOT EXISTS generation_batches (
    id         TEXT PRIMARY KEY,
    state      TEXT NOT NULL,
    data       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS generation_tasks (
    id         TEXT PRIMARY KEY,
    batch_id   TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    state      TEXT NOT NULL,
    data       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_generation_tasks_batch
    ON generation_tasks (batch_id, seq);

  /*
   * Orders, and why they are not the generation batch that produces them.
   *
   * A batch is a unit of WORK and is deliberately short-lived: evictFinished
   * drops it an hour after it settles, or once twenty newer batches exist, and
   * deletes the rows above with it. That is right for a queue - nobody needs a
   * finished dispatcher record - and useless for the thing a person came back
   * for three days later.
   *
   * So an order is the unit of DELIVERY, and it outlives its batch. It keeps
   * batch_id to reach the live queue while the work is running (to cancel
   * it), and nothing it shows a user depends on that batch still existing:
   * counts come from the item rows, which is why "122 of 300" still reads
   * correctly long after the dispatcher has forgotten the run.
   *
   * expires_at is written at creation rather than computed from created_at,
   * so changing the retention window cannot silently reach back and delete
   * files somebody was promised for five days.
   *
   * kind is 'order' (the Order button) or 'immediate' (a Generate Immediately
   * run, filed here so its files are owner-checked and swept like an order's,
   * and never listed on /orders). An immediate run's files go
   * IMMEDIATE_FILE_RETENTION_MS after finished_at, not at expires_at. Also in
   * addMissingColumns, for an orders table made before it.
   */
  CREATE TABLE IF NOT EXISTS orders (
    id         TEXT PRIMARY KEY,
    number     TEXT NOT NULL UNIQUE,
    user_id    TEXT NOT NULL,
    batch_id   TEXT,
    label      TEXT NOT NULL DEFAULT '',
    total      INTEGER NOT NULL,
    state      TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT,
    expires_at TEXT NOT NULL,
    purged_at  TEXT,
    kind       TEXT NOT NULL DEFAULT 'order'
  );

  CREATE INDEX IF NOT EXISTS idx_orders_user
    ON orders (user_id, created_at DESC);

  /* A finishing task knows its batch, not its order. This is that lookup. */
  CREATE INDEX IF NOT EXISTS idx_orders_batch
    ON orders (batch_id);

  /*
   * One row per resume the order asked for - one profile against one job.
   *
   * cost_milli is what that resume was charged, in thousandths of a dollar,
   * copied from its task when the order is placed. The task and its batch are
   * evicted an hour after the run settles, or sooner once twenty newer batches
   * have finished, and a refund request for the resume
   * can come days later; NULL on an item placed before the column existed,
   * which is then priced from its task only while the queue still holds it.
   *
   * seq is the position in the batch's task list, and it is how a finished
   * task finds its row: the queue hands back (batchId, seq) and nothing else
   * that survives a restart. files is a JSON array rather than a third table
   * because a file is never asked about on its own, only ever through its item,
   * and its kind gives it a stable address in a download URL.
   */
  CREATE TABLE IF NOT EXISTS order_items (
    id                TEXT PRIMARY KEY,
    order_id          TEXT NOT NULL,
    seq               INTEGER NOT NULL,
    task_id           TEXT,
    profile_id        TEXT NOT NULL DEFAULT '',
    profile_name      TEXT NOT NULL DEFAULT '',
    company_name      TEXT NOT NULL DEFAULT '',
    role              TEXT NOT NULL DEFAULT '',
    source_row_number INTEGER,
    state             TEXT NOT NULL,
    error             TEXT,
    files             TEXT NOT NULL DEFAULT '[]',
    cost_milli        INTEGER,
    provider_id       TEXT,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_order_items_order
    ON order_items (order_id, seq);

  /*
   * Money coming in, and what it bought.
   *
   * The ledger already records every credit that MOVES; this records the
   * purchase behind the ones that arrive. They are separate on purpose: a
   * ledger row is an accounting fact and must never be rewritten, while a
   * payment has a lifecycle - pending, then paid or failed or expired, then
   * perhaps refunded - and is updated as the provider reports it.
   *
   * unit_price_cents is stored per payment rather than looked up later. A
   * receipt has to say what the price WAS, and an administrator changing the
   * price must not rewrite what somebody already paid.
   *
   * UNIQUE (provider, provider_ref) is a guard, not a convenience: it is what
   * stops two rows ever claiming the same Stripe session or Cryptomus invoice.
   */
  CREATE TABLE IF NOT EXISTS payments (
    id               TEXT PRIMARY KEY,
    reference        TEXT NOT NULL UNIQUE,
    user_id          TEXT NOT NULL,
    method           TEXT NOT NULL,
    provider         TEXT NOT NULL,
    provider_ref     TEXT,
    credits          INTEGER NOT NULL,
    amount_cents     INTEGER NOT NULL,
    currency         TEXT NOT NULL,
    unit_price_cents INTEGER NOT NULL,
    state            TEXT NOT NULL,
    failure          TEXT NOT NULL DEFAULT '',
    credited_at      TEXT,
    refunded_at      TEXT,
    refunded_credits INTEGER NOT NULL DEFAULT 0,
    /*
     * The fee taken, and what was actually credited.
     *
     * Both snapshotted for the same reason unit_price_cents is: a receipt has
     * to say what happened, and an administrator changing a fee must not
     * rewrite an order somebody already paid.
     *
     * credits_granted is distinct from credits because they answer different
     * questions - credits is what was QUOTED, credits_granted is what the
     * ledger actually received. They differ when a fee is taken - and they
     * could differ more widely on the retired on-chain path, where a transfer
     * could arrive for something other than the quoted amount. Measured, not
     * assumed, exactly as refunded_credits is.
     */
    fee_cents        INTEGER NOT NULL DEFAULT 0,
    credits_granted  INTEGER NOT NULL DEFAULT 0,
    /*
     * The same three figures since credits became dollars, in thousandths of
     * a dollar: what this payment credits (quoted), what the ledger actually
     * received, and what a refund took back. A purchase credits exactly what
     * it charges, so credit_milli is amount_cents times ten.
     *
     * NEW columns rather than the old ones reinterpreted. credits,
     * credits_granted, refunded_credits and unit_price_cents still say what a
     * payment made before the switch bought - N credits at 50c - which is what
     * its receipt has to keep saying; a payment made since writes 0 into all
     * four, so an older build that is rolled back to reads it as crediting
     * nothing rather than as a thousand times what was paid.
     */
    credit_milli     INTEGER NOT NULL DEFAULT 0,
    credited_milli   INTEGER NOT NULL DEFAULT 0,
    refunded_milli   INTEGER NOT NULL DEFAULT 0,
    /*
     * What the refund returned to the buyer, in cents - the whole charge for a
     * refund from the payments list, the unspent part for one a refund request
     * asked for. 0 on a payment refunded before refunds could be partial, which
     * every one of them was: read as amount_cents (paymentRepository).
     */
    refund_cents     INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_payments_user
    ON payments (user_id, created_at DESC);

  CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_provider_ref
    ON payments (provider, provider_ref);

  /*
   * Every webhook this server accepted, and the outer half of paying once.
   *
   * A payment provider guarantees AT LEAST once, not exactly once: it retries
   * until it gets a 2xx, and it will happily send an event twice for reasons of
   * its own. UNIQUE (provider, event_id) is what makes the second delivery a
   * no-op rather than a second helping of credits.
   *
   * The ledger's own idempotency_key is the inner half, and the two are not
   * redundant: this one stops the work being done twice, that one stops the
   * MONEY moving twice even if something ever gets past this.
   *
   * The payload is kept because when a payment is disputed months later, what
   * the provider actually said is the only evidence there is.
   */
  CREATE TABLE IF NOT EXISTS payment_events (
    id          TEXT PRIMARY KEY,
    payment_id  TEXT,
    provider    TEXT NOT NULL,
    event_id    TEXT NOT NULL,
    type        TEXT NOT NULL DEFAULT '',
    payload     TEXT NOT NULL DEFAULT '',
    received_at TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_events_unique
    ON payment_events (provider, event_id);

  CREATE INDEX IF NOT EXISTS idx_payment_events_payment
    ON payment_events (payment_id, received_at);

  /*
   * chain_invoices, chain_cursors and chain_orphans were here.
   *
   * They belonged to the non-custodial path - one address per chain, an exact
   * amount per order, and a watcher reading four blockchains to match them up.
   * Crypto goes through a hosted provider now and nothing reads any of them.
   *
   * The statements are gone; the TABLES are not dropped. A database that
   * already has them keeps them, untouched, because those rows are somebody's
   * record of money that arrived. A new install simply never creates them.
   *
   * TWO OF THOSE STATES OUTLIVE A PAYMENT, and losing their only reader is
   * the one cost of this deletion worth writing down. An ORPHAN is coin that
   * arrived and matched no single order; a HELD invoice is coin that arrived
   * against an order it could not be credited to. Neither is transient -
   * both waited for a person, and the admin queue that showed them went with
   * the rest. They are still here, and still readable:
   *
   *   SELECT * FROM chain_orphans WHERE resolved_at IS NULL;
   *   SELECT * FROM chain_invoices WHERE state = 'held';
   *
   * An operator with rows in either had money to account for before this
   * shipped. The README says the same thing where they would go looking.
   *
   * (NO BACKTICKS ANYWHERE IN THIS FILE - the whole schema below is one
   * template literal, and a backtick in a comment ends it. The warning lived
   * in the chain_cursors comment that went with the tables; it is repeated
   * here because it is still true of every line after this one, and it is
   * cheaper to read than the syntax errors it prevents.)
   */

  /**
   * Accounts.
   *
   * The EMAIL is the identity, not the Google subject id: the two sign-in paths
   * must land on the SAME account, and somebody who signed in with a code on
   * Monday and with Google on Tuesday has one account, not two. google_sub is
   * recorded when Google is used so a later address change on the Google side
   * does not strand them, but it is not what rows are found by.
   *
   * Stored lowercased and trimmed, and UNIQUE, so the database refuses the
   * duplicate rather than trusting every caller to normalize first.
   */
  /**
   * Every movement of a credit, append-only.
   *
   * A table rather than a column that is simply written: "you have three" is not
   * an answer anybody can check. Rows are never updated and never deleted, so the
   * balance on users is a cache of SUM(delta) and any disagreement is visible.
   *
   * seq is an AUTOINCREMENT integer and not created_at, because created_at is an
   * ISO string at millisecond resolution and two entries written in the same tick
   * tie. A ledger whose order is ambiguous is not a ledger.
   *
   * idempotency_key is UNIQUE and is the whole safety story. A refund is written
   * by a queue hook that can fire again after a restart; the key is what makes the
   * second write a no-op instead of a gift.
   */
  /*
   * delta and balance_after are WHOLE CREDITS, the unit before credits became
   * dollars; delta_milli and balance_after_milli are thousandths of a dollar,
   * the unit since. A row is in exactly one of them: one written before the
   * switch has its amount in delta and 0 in delta_milli, one written since has
   * it in delta_milli and 0 in delta - so a row's own columns say which it is,
   * and the history keeps reading as what happened at the time. The switch's
   * reset row (reason reset) is the last row in credits: it takes the old
   * balance to zero, and the dollar figures start from nothing after it.
   */
  CREATE TABLE IF NOT EXISTS credit_ledger (
    seq             INTEGER PRIMARY KEY AUTOINCREMENT,
    id              TEXT NOT NULL UNIQUE,
    user_id         TEXT NOT NULL,
    delta           INTEGER NOT NULL,
    balance_after   INTEGER NOT NULL,
    delta_milli         INTEGER NOT NULL DEFAULT 0,
    balance_after_milli INTEGER NOT NULL DEFAULT 0,
    reason          TEXT NOT NULL,
    ref_kind        TEXT NOT NULL DEFAULT '',
    ref_id          TEXT NOT NULL DEFAULT '',
    actor_id        TEXT,
    note            TEXT NOT NULL DEFAULT '',
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at      TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_credit_ledger_user ON credit_ledger (user_id, seq DESC);
  CREATE INDEX IF NOT EXISTS idx_credit_ledger_ref  ON credit_ledger (ref_kind, ref_id);

  /**
   * What an administrator has announced to everybody on this installation -
   * and, since refund requests, what the app has to tell ONE account.
   *
   * recipient_id NULL is an announcement: every signed-in account reads it,
   * exactly as before the column existed, and every row an older build wrote
   * reads that way. A recipient_id is a notice for that account alone - a
   * refund request decided, or (to each administrator) a new one asked for.
   * Still not a mailbox: "have I seen these" stays one timestamp on users
   * rather than a row per account per notice, which would be a table that
   * grows with the product of the two and answers no question this app asks.
   * The feed and its unread count read recipient_id IS NULL OR recipient_id =
   * the reader, through idx_notifications_recipient - created in getDb()
   * after addMissingColumns, because on an upgraded database the column does
   * not exist until then.
   *
   * link is an app path the notice is about ('' for none), so the panel can
   * take somebody to their refund requests rather than describe where they are.
   *
   * author_id is kept for the admin list, so somebody can see who posted a
   * notice they disagree with. It is not a foreign key - nothing in this
   * schema is - and an account that is later deleted simply leaves its name
   * behind on the notice, which is the right outcome for a published thing.
   */
  /*
   * A card somebody chose to keep, and nothing that identifies it as money.
   *
   * There is no card number here and there never can be: the form is an iframe
   * served by Stripe and the details go straight to them. What this table holds
   * is a HANDLE - the payment-method id Stripe gave us - plus the brand, the
   * last four digits and the expiry, which are the only things a person needs
   * to recognise their own card in a list. The handle is useless without the
   * secret key, which is not in the database either.
   *
   * detached_at is a soft delete rather than a DELETE, because a payment made
   * with a card that has since been removed still has to be explainable. The
   * row stops being offered the moment it is set.
   *
   * The UNIQUE index is on (provider, method_ref) rather than on the id: the
   * same card entered twice at Stripe is the same payment method, and two rows
   * for it would show a buyer their card twice and let them delete half of it.
   */
  CREATE TABLE IF NOT EXISTS saved_cards (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    provider     TEXT NOT NULL DEFAULT 'stripe',
    customer_ref TEXT NOT NULL,
    method_ref   TEXT NOT NULL,
    brand        TEXT NOT NULL DEFAULT '',
    last4        TEXT NOT NULL DEFAULT '',
    exp_month    INTEGER NOT NULL DEFAULT 0,
    exp_year     INTEGER NOT NULL DEFAULT 0,
    detached_at  TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_cards_method
    ON saved_cards (provider, method_ref);

  CREATE INDEX IF NOT EXISTS idx_saved_cards_user
    ON saved_cards (user_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS notifications (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL DEFAULT '',
    author_id   TEXT NOT NULL DEFAULT '',
    author_name TEXT NOT NULL DEFAULT '',
    recipient_id TEXT,
    link        TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications (created_at DESC);

  /*
   * Somebody asking for money back - for a purchase (the unspent part of it,
   * returned to the card or sent back by hand) or for one resume's charge
   * (credited back to the balance) - and what an administrator decided.
   *
   * The money itself never moves here. A refunded resume is a credit_ledger
   * row keyed refund-request:<id>, written in the same transaction as the
   * state change; a refunded purchase is the payment's own refund. This row is
   * the request and its decision: state is requested, approved, declined or
   * refunded, and the last two are final.
   *
   * item_key names WHAT is being refunded in one string, so one rule can
   * cover it: payment:<id>, order-item:<id>, task:<id> (a queued resume not
   * placed as an order, while its batch is held) or charge:<reservation id>
   * (one synchronously built resume). idx_refund_requests_open_item is the
   * rule "one open request per item": a partial UNIQUE index over the open
   * states, so a second request for the same item is refused by the database
   * however the two arrive, and a declined one does not stop the next.
   *
   * amount_milli is what was refundable when asked; refunded_milli what was
   * actually returned (a purchase is re-measured when it is refunded, never
   * above what was asked). attempt_milli is the amount a card refund was sent
   * to Stripe with, and hold_key the ledger key its credit was taken off the
   * balance under - both written BEFORE the call, with the payment's claim, so
   * the credit cannot be spent while the money is on its way back, and a retry
   * after a dropped answer sends the same amount under the same idempotency
   * key without taking the credit twice. Both are cleared when Stripe refuses
   * and the credit goes back.
   */
  CREATE TABLE IF NOT EXISTS refund_requests (
    id             TEXT PRIMARY KEY,
    reference      TEXT NOT NULL UNIQUE,
    account_id     TEXT NOT NULL,
    kind           TEXT NOT NULL,
    item_key       TEXT NOT NULL,
    payment_id     TEXT,
    order_item_id  TEXT,
    task_id        TEXT,
    reservation_id TEXT,
    label          TEXT NOT NULL DEFAULT '',
    amount_milli   INTEGER NOT NULL,
    refunded_milli INTEGER NOT NULL DEFAULT 0,
    attempt_milli  INTEGER,
    hold_key       TEXT,
    reason         TEXT NOT NULL,
    state          TEXT NOT NULL DEFAULT 'requested',
    decline_reason TEXT NOT NULL DEFAULT '',
    decided_by     TEXT,
    decided_at     TEXT,
    refunded_by    TEXT,
    refunded_at    TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_refund_requests_open_item
    ON refund_requests (item_key) WHERE state IN ('requested', 'approved');

  CREATE INDEX IF NOT EXISTS idx_refund_requests_state
    ON refund_requests (state, created_at);

  CREATE INDEX IF NOT EXISTS idx_refund_requests_account
    ON refund_requests (account_id, created_at);

  CREATE INDEX IF NOT EXISTS idx_refund_requests_item
    ON refund_requests (item_key, state);

  /**
   * A run that has been charged and has not finished being accounted for.
   *
   * The refunded <= units invariant lives here rather than in the code that
   * refunds, because that code is called from a queue hook which can fire more
   * than once and from a boot reconciler which cannot see it. A cap in SQL cannot
   * be reasoned past.
   *
   * The id IS the batch id for a queued run. That is what lets a hook holding only
   * task.batchId find the account to credit, with no owner column on
   * generation_batches and no user id on the task payload.
   */
  CREATE TABLE IF NOT EXISTS credit_reservations (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    kind       TEXT NOT NULL,
    units      INTEGER NOT NULL,
    refunded   INTEGER NOT NULL DEFAULT 0,
    /*
     * What the run holds and has given back, in thousandths of a dollar. units
     * and refunded are the same in whole credits, written 0 since the switch;
     * the switch closed every reservation that was still open in them.
     */
    units_milli    INTEGER NOT NULL DEFAULT 0,
    refunded_milli INTEGER NOT NULL DEFAULT 0,
    state      TEXT NOT NULL DEFAULT 'open',
    label      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_credit_reservations_open
    ON credit_reservations (state, created_at);

  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL DEFAULT '',
    picture       TEXT NOT NULL DEFAULT '',
    role          TEXT NOT NULL DEFAULT 'user',
    /*
     * The account's tier: default, premium, premium-plus or premium-max
     * (config/accountSubscriptions.ts). Earlier builds called it plan;
     * renameColumns below renames it in place on a database they made.
     */
    subscription  TEXT NOT NULL DEFAULT 'default',
    /*
     * credits is the balance in whole credits, from before credits became
     * dollars; the switch reset it to 0 and nothing writes it since.
     * balance_milli is the balance now, in thousandths of a dollar - a cache of
     * SUM(credit_ledger.delta_milli), written only by creditRepository.
     */
    credits       INTEGER NOT NULL DEFAULT 0,
    balance_milli INTEGER NOT NULL DEFAULT 0,
    google_sub    TEXT,
    disabled      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    last_login_at TEXT,
    /*
     * The account's own Google spreadsheet, and the last date tab prepared in
     * it. The date is a cache, not a record: it lets a repeat sign-in on the
     * same day decide it has nothing to do without asking Google. Visibility is
     * deliberately absent - Drive owns that, and a copy here would go stale the
     * first time somebody changed the sharing in Google's own UI.
     */
    sheet_id       TEXT,
    sheet_url      TEXT,
    sheet_tab_date TEXT,
    sheet_tab_gid  TEXT,
    sheet_shared_at TEXT,
    /*
     * When this account last opened the notifications panel. NULL means never,
     * which is the correct starting state - a new account genuinely has not
     * seen the announcements posted before it existed, and the alternative
     * (stamping it at creation) would silently hide them.
     *
     * One timestamp rather than a read receipt per notification, because a
     * notification here is an announcement to everybody and the only question
     * worth answering is "anything since I last looked".
     */
    notifications_seen_at TEXT,
    /*
     * The Stripe customer saved cards hang off, created on the first save.
     *
     * NULL means this account has never kept a card - not that it has never
     * paid. A customer is only needed to store a payment method for reuse, and
     * a guest checkout stores nothing.
     */
    stripe_customer_id TEXT,
    /*
     * A reporter's pay per job the lake accepts, in thousandths of a dollar
     * (config/reportRate.ts). NULL means the installation's global rate, which
     * is every account until an administrator sets one. Read by its own
     * query, never through USER_COLUMNS: it is served to administrators only.
     */
    report_rate_milli INTEGER
  );

  /**
   * Live sign-ins, one row per session token.
   *
   * A table rather than a self-contained signed token, because logging out has
   * to MEAN something. A stateless token cannot be withdrawn before it expires,
   * so "disable this account" would leave whoever holds one signed in for the
   * rest of the day - and disabling an account is exactly the moment that must
   * not be true.
   *
   * Only the hash is kept. A stolen database then yields no usable session.
   */
  CREATE TABLE IF NOT EXISTS user_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_seen  TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions (user_id);

  /**
   * Six-digit codes sent by email, hashed the same way and for the same reason.
   *
   * The attempt count is on the row rather than in memory so the limit
   * survives a restart - otherwise restarting the server is a way to reset
   * somebody's guess counter.
   */
  CREATE TABLE IF NOT EXISTS login_codes (
    id         TEXT PRIMARY KEY,
    email      TEXT NOT NULL,
    code_hash  TEXT NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_login_codes_email ON login_codes (email, created_at);

  /**
   * Every job posting this install has analysed, once each, for ever
   * (owner decision J0). The ONLY source of truth for an analysis: no TTL, no
   * cap, no eviction and no overwrite - a posting is analysed again by
   * nothing, whichever user, profile, model, prompt edit, retry or restart
   * asks. Written by services/jobAnalysis/gate.ts alone.
   *
   * A posting is ONE row however it is reached: its whitespace-normalised
   * text (content_hash, SHA-256 hex) and its normalised job link (link_key,
   * NULL when it had none) are each unique, through the indexes below -
   * which is also what makes two simultaneous inserts of one posting keep
   * one row (INSERT ... ON CONFLICT DO NOTHING, then read the winner back).
   *
   * analysis_json is the normalised JobAnalysis without the posting's text,
   * which is job_description beside it. job_field_id is a config/jobFields.ts
   * id or 'unclassified'; the salary columns are only what the posting
   * stated (NULL otherwise). model_id and prompt_hash record which model and
   * which prompt text produced it - an audit, never part of its identity.
   * source is 'ai' (one model call) or 'sheet' (read from a protected Analysis
   * cell of an app sheet, registered with no call). merged_at is the Job Data
   * Lake's (Phase 7): NULL until an administrator merges the row.
   *
   * The indexes are created after addMissingColumns (INDEXES_AFTER_COLUMNS),
   * like every index over a table a later build may add a column to.
   */
  CREATE TABLE IF NOT EXISTS job_analyses (
    id               TEXT PRIMARY KEY,
    content_hash     TEXT NOT NULL,
    link_key         TEXT,
    job_link         TEXT NOT NULL DEFAULT '',
    job_description  TEXT NOT NULL DEFAULT '',
    analysis_json    TEXT NOT NULL,
    job_field_id     TEXT NOT NULL DEFAULT 'unclassified',
    job_title        TEXT NOT NULL DEFAULT '',
    salary_min       REAL,
    salary_max       REAL,
    salary_currency  TEXT,
    salary_period    TEXT,
    salary_raw       TEXT,
    model_id         TEXT NOT NULL DEFAULT '',
    prompt_hash      TEXT NOT NULL DEFAULT '',
    source           TEXT NOT NULL DEFAULT 'ai',
    created_by       TEXT,
    created_at       TEXT NOT NULL,
    merged_at        TEXT,
    company_name     TEXT NOT NULL DEFAULT ''
  );

  /**
   * The Job Data Lake (Phase 7; database/jobLakeRepository.ts): one row per
   * JOB - a company hiring in a job field - not per posting.
   *
   * job_hash is services/jobLake/identity.ts's SHA-256 of the versioned
   * (normalised company, job field id), UNIQUE: the duplicate check is one
   * seek on it, inside the same IMMEDIATE transaction as the insert, so two
   * reporters adding the same job at once get one row. company and the other
   * values are stored as they were reported; company_key is the normalised
   * company the hash was made from, for the admin page's company filter.
   *
   * A row is REPLACED, not duplicated, when its job is reported again after
   * the duplicate window (J2b): its previous content goes to
   * job_lake_history first, and requested_by, updated_at and the reward move
   * to the new report. Within the window only seen_count and last_seen_at
   * move. sheet_synced_at is the admin sheet's outbox: NULL until the row's
   * current version was appended there, and NULL again after a replacement.
   *
   * reward_milli is what the current version paid its reporter (0: a merge,
   * an administrator's report, a rate of $0.000, or the daily cap), at
   * reward_rate_milli - the rate in effect then, snapshotted (J7) - and
   * reward_revoked_milli what an administrator took back (reward_revoked_at
   * set even when the balance had nothing left to take). The ledger row is
   * keyed job-lake:<id>:<updated_at>, so a replacement can pay again and the
   * same version never twice.
   *
   * report_ref names the sheet row a reporter's run reported the current
   * version from (spreadsheet, row and tab; NULL for a merge): a later run that
   * finds the job within the window from that SAME row is that report again -
   * its Lake Status never reached the sheet - while the same posting on any
   * other row, tab or day is a duplicate like any other.
   *
   * INTEGER ids rather than the UUIDs elsewhere: the full-text index below
   * points at rows by rowid, which VACUUM may renumber on a table without an
   * INTEGER PRIMARY KEY. AUTOINCREMENT, so a deleted row's id is never handed
   * to another job and its ledger key never meets a new one.
   */
  CREATE TABLE IF NOT EXISTS job_lake (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    job_hash             TEXT NOT NULL,
    hash_version         INTEGER NOT NULL,
    company              TEXT NOT NULL DEFAULT '',
    company_key          TEXT NOT NULL DEFAULT '',
    job_field_id         TEXT NOT NULL,
    title                TEXT NOT NULL DEFAULT '',
    salary_min           REAL,
    salary_max           REAL,
    salary_currency      TEXT,
    salary_period        TEXT,
    salary_raw           TEXT,
    job_url              TEXT NOT NULL DEFAULT '',
    job_description      TEXT NOT NULL DEFAULT '',
    analysis_id          TEXT,
    requested_by         TEXT,
    source               TEXT NOT NULL DEFAULT 'report',
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL,
    seen_count           INTEGER NOT NULL DEFAULT 1,
    last_seen_at         TEXT,
    sheet_synced_at      TEXT,
    reward_milli         INTEGER NOT NULL DEFAULT 0,
    reward_rate_milli    INTEGER,
    reward_revoked_milli INTEGER NOT NULL DEFAULT 0,
    reward_revoked_at    TEXT,
    report_ref           TEXT
  );

  /** A lake row's earlier versions, each copied here the moment a later report replaced it. */
  CREATE TABLE IF NOT EXISTS job_lake_history (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    lake_id              INTEGER NOT NULL,
    job_hash             TEXT NOT NULL,
    hash_version         INTEGER NOT NULL,
    company              TEXT NOT NULL DEFAULT '',
    job_field_id         TEXT NOT NULL,
    title                TEXT NOT NULL DEFAULT '',
    salary_min           REAL,
    salary_max           REAL,
    salary_currency      TEXT,
    salary_period        TEXT,
    salary_raw           TEXT,
    job_url              TEXT NOT NULL DEFAULT '',
    job_description      TEXT NOT NULL DEFAULT '',
    analysis_id          TEXT,
    requested_by         TEXT,
    source               TEXT NOT NULL DEFAULT 'report',
    version_at           TEXT NOT NULL,
    seen_count           INTEGER NOT NULL DEFAULT 1,
    reward_milli         INTEGER NOT NULL DEFAULT 0,
    reward_rate_milli    INTEGER,
    reward_revoked_milli INTEGER NOT NULL DEFAULT 0,
    reward_revoked_at    TEXT,
    replaced_at          TEXT NOT NULL
  );

  /**
   * Free-text search over the lake's company, title and description, for the
   * admin page. External content: the text lives once, in job_lake, and the
   * three triggers keep the index in step with every insert, replacement and
   * delete - nothing else writes it.
   */
  CREATE VIRTUAL TABLE IF NOT EXISTS job_lake_fts USING fts5(
    company, title, job_description,
    content = 'job_lake', content_rowid = 'id', tokenize = 'unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER IF NOT EXISTS job_lake_fts_insert AFTER INSERT ON job_lake BEGIN
    INSERT INTO job_lake_fts (rowid, company, title, job_description)
      VALUES (new.id, new.company, new.title, new.job_description);
  END;
  CREATE TRIGGER IF NOT EXISTS job_lake_fts_delete AFTER DELETE ON job_lake BEGIN
    INSERT INTO job_lake_fts (job_lake_fts, rowid, company, title, job_description)
      VALUES ('delete', old.id, old.company, old.title, old.job_description);
  END;
  CREATE TRIGGER IF NOT EXISTS job_lake_fts_update AFTER UPDATE OF company, title, job_description ON job_lake BEGIN
    INSERT INTO job_lake_fts (job_lake_fts, rowid, company, title, job_description)
      VALUES ('delete', old.id, old.company, old.title, old.job_description);
    INSERT INTO job_lake_fts (rowid, company, title, job_description)
      VALUES (new.id, new.company, new.title, new.job_description);
  END;

  /**
   * Tailored content kept for reuse (owner decision P6; services/tailorCache.ts,
   * database/tailorCacheRepository.ts its only reader and writer): the model's
   * answer to a tailoring or a cover-letter call, under a key that is the
   * SHA-256 of everything that answer was made from - the profile as it was
   * (content, section switches, layout), the template, the posting's stored
   * analysis, the model record and model name, and the prompt's text. A
   * generation that would ask the same question again reads the answer here
   * instead, and is charged as usual; any one of those changing is another
   * key. cache_key is UNIQUE (the lookup is one seek on it, pinned by a test),
   * and rows older than TAILOR_CACHE_DAYS are pruned on created_at.
   *
   * kind is 'resume' or 'cover-letter'. model_id, analysis_id and profile_id
   * say what a row was for - an audit, never part of how it is found.
   */
  CREATE TABLE IF NOT EXISTS tailor_cache (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    cache_key    TEXT NOT NULL,
    kind         TEXT NOT NULL,
    content      TEXT NOT NULL,
    model_id     TEXT NOT NULL DEFAULT '',
    analysis_id  TEXT,
    profile_id   TEXT,
    created_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS schema_meta (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT
  );
`;

const connections = new Map<string, Database.Database>();

export function getDatabaseDir(): string {
  const configured = process.env.DB_DIR?.trim();
  return configured ? path.resolve(configured) : getDefaultDatabaseDir();
}

export function getDatabasePath(): string {
  return path.join(getDatabaseDir(), DATABASE_FILE_NAME);
}

/**
 * Columns renamed in place on a database an older build made.
 *
 * `CREATE TABLE IF NOT EXISTS` writes the new name on a fresh database and does
 * nothing to an old one, so without this an upgraded install would keep the
 * old column and every query naming the new one would fail. SQLite renames a
 * column without copying a row, and carries its values, its DEFAULT and any
 * index or trigger naming it along.
 *
 * Guarded by the table's own columns rather than a `schema_meta` marker, and
 * deliberately: the column IS the state. A marker would say "done" after an
 * operator rolled back to an older build and renamed the column back for it -
 * the documented way down - and the next upgrade would then skip the rename
 * and fail on every account read. Asking PRAGMA table_info costs nothing and is
 * right every time. Not a numbered migration either: those wait in a chain
 * behind 003, which waits for an administrator, and nobody can sign in to
 * become one while `users` names a column this build does not read.
 *
 * Fatal, unlike `addMissingColumns`: a column this build failed to ADD leaves
 * the app reading the table as the previous build did, but one it failed to
 * RENAME leaves nothing able to read an account at all, and the reason belongs
 * at startup rather than on every request.
 */
const COLUMN_RENAMES: ReadonlyArray<{ table: string; from: string; to: string; why: string }> = [
  // The account tier is a subscription everywhere - UI, API and here.
  { table: 'users', from: 'plan', to: 'subscription', why: 'the account tier is called a subscription' },
];

function renameColumns(db: Database.Database): void {
  for (const rename of COLUMN_RENAMES) {
    let renamed = false;
    try {
      // The check and the rename are ONE write transaction, taken before the
      // check reads anything. Two openers of the same file are expected - a
      // second server on the same DB_DIR, or `migrate:legacy` started beside
      // the backend - and read outside a transaction both see the old column,
      // the first renames it, and the second's ALTER dies with "no such
      // column" on a rename that already happened. Holding the write lock
      // first, the second waits out busy_timeout and then reads the new name.
      db.transaction(() => {
        const columns = db.prepare(`PRAGMA table_info(${rename.table})`).all() as Array<{ name: string }>;
        const names = new Set(columns.map((column) => column.name));
        // No table yet (a fresh database: SCHEMA is about to create it with
        // the new name), or one already renamed.
        if (!names.has(rename.from)) return;
        if (names.has(rename.to)) {
          // Both: somebody ADDED the old column back by hand to roll back,
          // rather than renaming it. The new one is what this build reads; the
          // old one is left for whoever added it, never merged into the new on
          // a guess.
          console.warn(
            `[db] ${rename.table} has both "${rename.from}" and "${rename.to}"; reading "${rename.to}" and ` +
              `leaving "${rename.from}" alone.`
          );
          return;
        }
        db.exec(`ALTER TABLE ${rename.table} RENAME COLUMN ${rename.from} TO ${rename.to}`);
        renamed = true;
      }).immediate();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not rename ${rename.table}.${rename.from} to ${rename.to} in ${getDatabasePath()}: ${reason}. ` +
          'This build reads the new name; check that the database file is writable and not open in another ' +
          'program, then start the server again.'
      );
    }
    if (renamed) console.log(`[db] Renamed ${rename.table}.${rename.from} to ${rename.to}: ${rename.why}.`);
  }
}

/**
 * Columns added to tables that already exist.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op against a database that has the
 * table, so a column added to SCHEMA later never reaches an existing install -
 * it appears on a fresh checkout and nowhere else, which is the kind of
 * difference that only shows up in production. `ALTER TABLE ADD COLUMN` is what
 * reaches both, and SQLite makes it cheap: it rewrites no rows.
 *
 * Run before any migration and before any query, since a data migration that
 * writes one of these columns needs it to exist first.
 */
function addMissingColumns(db: Database.Database): void {
  const additions: Array<{ table: string; column: string; definition: string }> = [
    // Ownership. NULL means "from before accounts existed", which migration 003
    // then hands to the first admin - it is not a valid state to stay in, but it
    // is the state every upgraded row starts in and the column has to allow it.
    { table: 'profiles', column: 'owner_id', definition: "TEXT" },
    { table: 'profile_groups', column: 'owner_id', definition: 'TEXT' },
    // The per-account spreadsheet. NULL means "not allocated yet", which is
    // every row on an install that upgrades into this build; the sheets service
    // fills them in on sign-in, and the boot backfill catches the rest.
    { table: 'users', column: 'sheet_id', definition: 'TEXT' },
    { table: 'users', column: 'sheet_url', definition: 'TEXT' },
    { table: 'users', column: 'sheet_tab_date', definition: 'TEXT' },
    // The gid of that tab, so the account page can link straight to the day
    // rather than to whichever tab Google decides to open first.
    { table: 'users', column: 'sheet_tab_gid', definition: 'TEXT' },
    // When the owner's own Drive grant was confirmed. NULL means "not yet", and
    // that is what makes sign-in retry it; once set, sign-in stops asking Drive
    // about it at all.
    { table: 'users', column: 'sheet_shared_at', definition: 'TEXT' },
    // The fee taken and the credits actually granted. Zero on every row
    // written before they existed, which reads correctly: those payments took
    // no fee, and `credits_granted || credits` covers the granted count.
    // The Stripe customer this account's saved cards hang off. NULL until the
    // first card is kept, which is also the only time one is created.
    { table: 'users', column: 'stripe_customer_id', definition: 'TEXT' },
    { table: 'payments', column: 'fee_cents', definition: 'INTEGER NOT NULL DEFAULT 0' },
    { table: 'payments', column: 'credits_granted', definition: 'INTEGER NOT NULL DEFAULT 0' },
    // When this account last opened the notifications panel. NULL means never,
    // which is what every upgraded row starts as and is also correct: an
    // account that has never looked has not seen anything.
    { table: 'users', column: 'notifications_seen_at', definition: 'TEXT' },
    // Credits are dollars, counted in thousandths. New columns beside the old
    // whole-credit ones, never the old ones reinterpreted: an older build
    // rolled back to keeps reading its own columns, and reads a balance of 0
    // rather than a thousand times what somebody holds. Zero on every
    // upgraded row, which is what the switch below makes true anyway - it
    // resets every balance to $0 (database/dollarSwitch.ts).
    { table: 'users', column: 'balance_milli', definition: 'INTEGER NOT NULL DEFAULT 0' },
    { table: 'credit_ledger', column: 'delta_milli', definition: 'INTEGER NOT NULL DEFAULT 0' },
    { table: 'credit_ledger', column: 'balance_after_milli', definition: 'INTEGER NOT NULL DEFAULT 0' },
    { table: 'credit_reservations', column: 'units_milli', definition: 'INTEGER NOT NULL DEFAULT 0' },
    { table: 'credit_reservations', column: 'refunded_milli', definition: 'INTEGER NOT NULL DEFAULT 0' },
    { table: 'payments', column: 'credit_milli', definition: 'INTEGER NOT NULL DEFAULT 0' },
    { table: 'payments', column: 'credited_milli', definition: 'INTEGER NOT NULL DEFAULT 0' },
    { table: 'payments', column: 'refunded_milli', definition: 'INTEGER NOT NULL DEFAULT 0' },
    // Refund requests. A notice for one account (NULL, every upgraded row, is
    // an announcement to all of them, which is what they all were), the app
    // path it is about, a partial refund's amount, and what an order's resume
    // was charged - NULL on an older item, which reads as "not on record".
    { table: 'notifications', column: 'recipient_id', definition: 'TEXT' },
    { table: 'notifications', column: 'link', definition: "TEXT NOT NULL DEFAULT ''" },
    { table: 'payments', column: 'refund_cents', definition: 'INTEGER NOT NULL DEFAULT 0' },
    { table: 'order_items', column: 'cost_milli', definition: 'INTEGER' },
    // The credit a card refund holds off the balance until Stripe answers.
    // In the CREATE TABLE too; here for a refund_requests table made before it.
    { table: 'refund_requests', column: 'hold_key', definition: 'TEXT' },
    // Which kind of run an order row records: every upgraded row was placed
    // with the Order button, which is what the default says. `immediate` rows
    // (Generate Immediately) are never listed on /orders.
    { table: 'orders', column: 'kind', definition: "TEXT NOT NULL DEFAULT 'order'" },
    // A reporter's own rate per accepted job. NULL, every upgraded row, is
    // "the global rate", which is what every account was paid before there
    // was a per-account one - there was no reporter before it either.
    { table: 'users', column: 'report_rate_milli', definition: 'INTEGER' },
    // The company a posting was built or reported for, which the analysis
    // itself never reads off the posting - and the lake's merge needs, to
    // hash the job. '' on every row stored before it, which the merge tab
    // does not offer until a build or a report of the posting names one.
    { table: 'job_analyses', column: 'company_name', definition: "TEXT NOT NULL DEFAULT ''" },
    // The sheet row a lake row's current version was reported from. In the
    // CREATE TABLE too; here for a job_lake table made before it. NULL reads
    // as "no row": such a job found again is a duplicate, never `already`.
    { table: 'job_lake', column: 'report_ref', definition: 'TEXT' },
    // The provider an order's resume was last built on (Phase 9: providers of
    // one type at several sign-ins). NULL on every upgraded row, which reads
    // as "not recorded" - they all ran on the one provider each type had.
    { table: 'order_items', column: 'provider_id', definition: 'TEXT' },
  ];

  for (const addition of additions) {
    try {
      const columns = db.prepare(`PRAGMA table_info(${addition.table})`).all() as Array<{ name: string }>;
      if (columns.length === 0) continue;
      if (columns.some((column) => column.name === addition.column)) continue;
      db.exec(`ALTER TABLE ${addition.table} ADD COLUMN ${addition.column} ${addition.definition}`);
    } catch (error) {
      // Never fatal, for the same reason the data migrations are not: a column
      // this build wanted and could not add leaves the app reading the table
      // exactly as the previous build did.
      console.error(
        `[db] Could not add ${addition.table}.${addition.column}; continuing without it.`,
        error
      );
    }
  }
}

/**
 * Indexes over columns `addMissingColumns` may have just added.
 *
 * Not in SCHEMA: on an upgraded database SCHEMA runs while the column does not
 * exist yet, and an index naming it there fails every boot of that install
 * while passing on every fresh one. Never fatal, like the columns themselves -
 * a missing index is a slower query, not a wrong one.
 */
const INDEXES_AFTER_COLUMNS: ReadonlyArray<{ name: string; table: string; columns: string[]; sql: string }> = [
  // The feed and its unread count: recipient_id IS NULL OR recipient_id = me.
  {
    name: 'idx_notifications_recipient',
    table: 'notifications',
    columns: ['recipient_id', 'created_at'],
    sql: 'CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications (recipient_id, created_at)',
  },
  // The minute-by-minute sweep of Generate Immediately runs whose files are
  // due (listFinishedImmediateRuns). Partial, so it holds only the runs that
  // still HAVE files: one row per run is a lot of rows, and the sweep must
  // not read every run anybody ever made, every minute, to find none.
  {
    name: 'idx_orders_immediate_unpurged',
    table: 'orders',
    columns: ['kind', 'finished_at', 'purged_at'],
    sql:
      'CREATE INDEX IF NOT EXISTS idx_orders_immediate_unpurged ON orders (finished_at) ' +
      "WHERE kind = 'immediate' AND purged_at IS NULL",
  },
  // The analysis gate's two lookups, each one index seek whatever the size of
  // the table (test/jobAnalysisStore.test.js pins the plans). UNIQUE, because
  // they are also what keeps a posting to one row when two callers race to
  // store it.
  {
    name: 'idx_job_analyses_content_hash',
    table: 'job_analyses',
    columns: ['content_hash'],
    sql: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_job_analyses_content_hash ON job_analyses (content_hash)',
  },
  // Partial: many postings have no link, and NULL is not a key.
  {
    name: 'idx_job_analyses_link_key',
    table: 'job_analyses',
    columns: ['link_key'],
    sql:
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_job_analyses_link_key ON job_analyses (link_key) ' +
      'WHERE link_key IS NOT NULL',
  },
  // The Job Data Lake's merge tab: analysed, not merged yet, oldest first.
  {
    name: 'idx_job_analyses_merge',
    table: 'job_analyses',
    columns: ['merged_at', 'created_at'],
    sql: 'CREATE INDEX IF NOT EXISTS idx_job_analyses_merge ON job_analyses (merged_at, created_at)',
  },
  // The lake page's field filter.
  {
    name: 'idx_job_analyses_job_field',
    table: 'job_analyses',
    columns: ['job_field_id'],
    sql: 'CREATE INDEX IF NOT EXISTS idx_job_analyses_job_field ON job_analyses (job_field_id)',
  },
  // The Job Data Lake (test/jobLakeStore.test.js pins every plan below).
  // The duplicate check: one seek, and UNIQUE, so a second row for one job
  // cannot exist however two writers interleave.
  {
    name: 'idx_job_lake_hash',
    table: 'job_lake',
    columns: ['job_hash'],
    sql: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_job_lake_hash ON job_lake (job_hash)',
  },
  // The admin page's default order, newest first.
  {
    name: 'idx_job_lake_updated',
    table: 'job_lake',
    columns: ['updated_at'],
    sql: 'CREATE INDEX IF NOT EXISTS idx_job_lake_updated ON job_lake (updated_at)',
  },
  // The admin page's field and company filters, each still in that order.
  {
    name: 'idx_job_lake_field_updated',
    table: 'job_lake',
    columns: ['job_field_id', 'updated_at'],
    sql: 'CREATE INDEX IF NOT EXISTS idx_job_lake_field_updated ON job_lake (job_field_id, updated_at)',
  },
  {
    name: 'idx_job_lake_company_updated',
    table: 'job_lake',
    columns: ['company_key', 'updated_at'],
    sql: 'CREATE INDEX IF NOT EXISTS idx_job_lake_company_updated ON job_lake (company_key, updated_at)',
  },
  // "Requested by" - a reporter's own jobs, and the admin page's filter.
  {
    name: 'idx_job_lake_requested_by',
    table: 'job_lake',
    columns: ['requested_by'],
    sql: 'CREATE INDEX IF NOT EXISTS idx_job_lake_requested_by ON job_lake (requested_by)',
  },
  // The admin sheet's outbox: partial, so it holds only the rows still to
  // append - none, most of the time - however large the lake grows.
  {
    name: 'idx_job_lake_unsynced',
    table: 'job_lake',
    columns: ['id', 'sheet_synced_at'],
    sql: 'CREATE INDEX IF NOT EXISTS idx_job_lake_unsynced ON job_lake (id) WHERE sheet_synced_at IS NULL',
  },
  {
    name: 'idx_job_lake_history_lake',
    table: 'job_lake_history',
    columns: ['lake_id'],
    sql: 'CREATE INDEX IF NOT EXISTS idx_job_lake_history_lake ON job_lake_history (lake_id)',
  },
  {
    name: 'idx_tailor_cache_key',
    table: 'tailor_cache',
    columns: ['cache_key'],
    sql: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_tailor_cache_key ON tailor_cache (cache_key)',
  },
  {
    name: 'idx_tailor_cache_created',
    table: 'tailor_cache',
    columns: ['created_at'],
    sql: 'CREATE INDEX IF NOT EXISTS idx_tailor_cache_created ON tailor_cache (created_at)',
  },
];

function addIndexesAfterColumns(db: Database.Database): void {
  for (const index of INDEXES_AFTER_COLUMNS) {
    try {
      const columns = db.prepare(`PRAGMA table_info(${index.table})`).all() as Array<{ name: string }>;
      const names = new Set(columns.map((column) => column.name));
      if (!index.columns.every((column) => names.has(column))) continue;
      db.exec(index.sql);
    } catch (error) {
      console.error(`[db] Could not create ${index.name}; continuing without it.`, error);
    }
  }
}

/**
 * Returns the shared SQLite connection for the configured database directory.
 * The connection is opened lazily and the schema is created on first use.
 */
export function getDb(): Database.Database {
  const filePath = getDatabasePath();
  const existing = connections.get(filePath);
  if (existing) {
    return existing;
  }

  const directory = path.dirname(filePath);
  try {
    fs.mkdirSync(directory, { recursive: true });
  } catch (error) {
    // The single most common first-run failure, and the raw EACCES/EPERM says
    // nothing about what to do next. It is also where the two platforms differ
    // most: `/data/db` copied out of `.env.example` needs `sudo mkdir` on
    // Ubuntu and cannot be created at all without elevation on Windows, where
    // it means `C:\data\db`.
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot create the database directory "${directory}": ${reason}. ` +
        'Set DB_DIR in the repository .env to a writable path (for example DB_DIR=./data/db), ' +
        'or create that directory and give this user write access to it.'
    );
  }

  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  // A second connection to the same file is not hypothetical: every test that
  // calls loadFresh on this module gets a fresh `connections` map and opens one.
  // Without a timeout the loser of a write race throws SQLITE_BUSY immediately,
  // which would surface as a flaky test rather than as the refusal being tested.
  db.pragma('busy_timeout = 5000');
  // Renamed BEFORE the schema runs, so SCHEMA may index or otherwise name a
  // column by its new name: on an old database the CREATE TABLE beside it is a
  // no-op, and an index naming the new column would otherwise fail every boot
  // of an upgraded install while passing on every fresh one.
  try {
    renameColumns(db);
  } catch (error) {
    // Not registered, so the next getDb() tries again rather than handing out
    // a connection nothing can read an account through.
    db.close();
    throw error;
  }
  db.exec(SCHEMA);
  addMissingColumns(db);
  addIndexesAfterColumns(db);
  // Saved templates are files now; an older build's rows are written out
  // once, here rather than in the numbered chain, which can wait for an
  // administrator for as long as nobody signs in. Never fatal.
  moveTemplateRowsToFiles(db);
  // Credits became dollars: every balance and every model price reset to $0,
  // once, with a row in each account's history saying so. Here and not in the
  // numbered chain for the same reason: the chain can wait at 003 for an
  // administrator indefinitely, while this build already reads the dollar
  // columns. Never fatal, and safe to have not run - see the module.
  switchCreditsToDollars(db);
  // The connection is registered BEFORE the migrations run. That ordering is
  // load-bearing: a migration (or anything it logs through) that reaches for
  // getDb() would otherwise recurse into opening a second connection to the
  // same file. Do not move this line below runDataMigrations.
  connections.set(filePath, db);
  runDataMigrations(db);
  return db;
}
