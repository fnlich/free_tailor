import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
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
    purged_at  TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_orders_user
    ON orders (user_id, created_at DESC);

  /* A finishing task knows its batch, not its order. This is that lookup. */
  CREATE INDEX IF NOT EXISTS idx_orders_batch
    ON orders (batch_id);

  /*
   * One row per resume the order asked for - one profile against one job.
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
   * stops two rows ever claiming the same Stripe session or Coinbase charge.
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
     * ledger actually received. They differ when a fee is taken, and again
     * when a chain payment arrives for something other than the quoted
     * amount. Measured, not assumed, exactly as refunded_credits is.
     */
    fee_cents        INTEGER NOT NULL DEFAULT 0,
    credits_granted  INTEGER NOT NULL DEFAULT 0,
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

  /**
   * One crypto invoice: an address, an exact amount, and a deadline.
   *
   * Separate from the payment because the payment is provider-agnostic and this
   * is entirely about chains. It hangs off payments.provider_ref, the same slot
   * a Stripe session id occupies.
   *
   * AMOUNT_ATOMIC is a TEXT column holding a decimal integer, not an INTEGER
   * column. An 18-decimal token amount exceeds what SQLite's 64-bit INTEGER can
   * hold once the numbers get large, and a silently truncated amount is a
   * payment that is never matched. Every comparison on it is string equality on
   * a canonical decimal, which is exact.
   *
   * The UNIQUE index on (chain, asset, amount_atomic) WHERE reserved = 1 is the
   * whole matching scheme. Buyers all send to ONE address per chain, so the
   * amount is the only thing distinguishing them, and two invoices quoting the
   * same amount would be two payments nobody can tell apart. The index is the
   * decision - not an application check, which two concurrent checkouts would
   * race straight past.
   */
  CREATE TABLE IF NOT EXISTS chain_invoices (
    id             TEXT PRIMARY KEY,
    payment_id     TEXT NOT NULL,
    chain          TEXT NOT NULL,
    asset          TEXT NOT NULL,
    address        TEXT NOT NULL,
    amount_atomic  TEXT NOT NULL,
    decimals       INTEGER NOT NULL,
    unit_price_usd TEXT NOT NULL DEFAULT '',
    reserved       INTEGER NOT NULL DEFAULT 1,
    quote_expires_at TEXT NOT NULL,
    monitor_until  TEXT NOT NULL,
    seen_txid      TEXT,
    seen_amount    TEXT,
    seen_at        TEXT,
    confirmations  INTEGER NOT NULL DEFAULT 0,
    state          TEXT NOT NULL DEFAULT 'waiting',
    note           TEXT NOT NULL DEFAULT '',
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_chain_invoices_slot
    ON chain_invoices (chain, asset, amount_atomic) WHERE reserved = 1;

  CREATE UNIQUE INDEX IF NOT EXISTS idx_chain_invoices_payment
    ON chain_invoices (payment_id);

  CREATE INDEX IF NOT EXISTS idx_chain_invoices_open
    ON chain_invoices (state, monitor_until);

  /**
   * How far each chain has been read.
   *
   * Without this a restart has only two options, and both lose money: rescan
   * from the beginning of the chain, which no public endpoint will serve, or
   * start from the current tip, which silently skips every transfer that
   * arrived while the process was down. Neither is recoverable afterwards,
   * because the watcher's only record of having looked IS this number.
   *
   * HEIGHT is TEXT for the same reason amount_atomic is: it is written and
   * compared as a decimal integer, and a block height is one number this code
   * should not have to promise stays inside a double forever. (No backticks
   * anywhere in this file - the whole schema is one template literal, and a
   * backtick in a comment ends it.)
   *
   * It is written in the SAME transaction as whatever that height produced.
   * Advancing the cursor first and recording the transfers afterwards is a
   * crash away from a payment nobody will ever look for again.
   */
  CREATE TABLE IF NOT EXISTS chain_cursors (
    chain      TEXT PRIMARY KEY,
    height     TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  /**
   * Money that arrived on a chain and belongs to nobody identifiable.
   *
   * Its own table because it has no invoice to live on: the whole reason a
   * transfer ends up here is that two open orders were equally close to it and
   * neither could be credited without possibly robbing the other. The invoices
   * are deliberately left alone - those buyers may still pay correctly - so
   * the record of the unattributable money has to go somewhere of its own.
   *
   * Without this the settler said "held" to a caller that only logged it, the
   * administrator's queue was permanently empty, and the promise made to the
   * buyer on the payment screen - that we hold it and get in touch - was not
   * true of anything the server actually did.
   *
   * The UNIQUE index is load-bearing in the same way the invoice slot index
   * is: the watcher re-reads the same transfer on every tick, so without it
   * one unclaimed payment would become a thousand rows.
   */
  CREATE TABLE IF NOT EXISTS chain_orphans (
    id            TEXT PRIMARY KEY,
    chain         TEXT NOT NULL,
    asset         TEXT NOT NULL,
    txid          TEXT NOT NULL,
    amount_atomic TEXT NOT NULL,
    decimals      INTEGER NOT NULL,
    reason        TEXT NOT NULL DEFAULT '',
    resolved_at   TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_chain_orphans_tx
    ON chain_orphans (chain, asset, txid);

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
  CREATE TABLE IF NOT EXISTS credit_ledger (
    seq             INTEGER PRIMARY KEY AUTOINCREMENT,
    id              TEXT NOT NULL UNIQUE,
    user_id         TEXT NOT NULL,
    delta           INTEGER NOT NULL,
    balance_after   INTEGER NOT NULL,
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
   * What an administrator has announced to everybody on this installation.
   *
   * Not addressed to anyone: there is no recipient column, because the thing
   * being modelled is a notice board rather than a mailbox. Every signed-in
   * account reads the same rows, and "have I seen these" is one timestamp on
   * users rather than a row per account per notice - which would be a table
   * that grows with the product of the two and answers no question this app
   * asks.
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
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications (created_at DESC);

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
    plan          TEXT NOT NULL DEFAULT 'default',
    credits       INTEGER NOT NULL DEFAULT 0,
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
    stripe_customer_id TEXT
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
  db.exec(SCHEMA);
  addMissingColumns(db);
  // The connection is registered BEFORE the migrations run. That ordering is
  // load-bearing: a migration (or anything it logs through) that reaches for
  // getDb() would otherwise recurse into opening a second connection to the
  // same file. Do not move this line below runDataMigrations.
  connections.set(filePath, db);
  runDataMigrations(db);
  return db;
}
