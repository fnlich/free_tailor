const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { Worker } = require('node:worker_threads');

const Database = require('better-sqlite3');
const ts = require('typescript');

const { loadFresh, useTempStorage } = require('./helpers');

/**
 * The account tier was called a plan, and is a subscription everywhere now:
 * the column, the API, the pages.
 *
 * What is worth pinning is the part that runs once against somebody's real
 * data - `users.plan` renamed to `users.subscription` in place by getDb() - and
 * that it is decided from the table itself, so a second start does nothing and
 * a database renamed back for a rollback is renamed forward again. And, on the
 * frontend, that the old Settings address still leads somewhere and that no
 * code or copy still calls the tier a plan.
 */

/**
 * `users` exactly as the build before the rename created it (v4.1, 90adbaf),
 * frozen here on purpose: the point is a database this build did not make.
 */
const PRE_RENAME_USERS = `
  CREATE TABLE users (
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
    sheet_id       TEXT,
    sheet_url      TEXT,
    sheet_tab_date TEXT,
    sheet_tab_gid  TEXT,
    sheet_shared_at TEXT,
    notifications_seen_at TEXT,
    stripe_customer_id TEXT
  );
`;

const OLD_ACCOUNTS = [
  ['u-default', 'default@example.com', 'default'],
  ['u-premium', 'premium@example.com', 'premium'],
  ['u-plus', 'plus@example.com', 'premium-plus'],
  ['u-max', 'max@example.com', 'premium-max'],
];

/** A database file as the pre-rename build left it, with an account on every tier. */
function writePreRenameDatabase(dbDir) {
  const db = new Database(path.join(dbDir, 'free_tailor.db'));
  try {
    // That build opened every database in WAL mode, and the mode is stored in
    // the file, so an upgraded install starts in it.
    db.pragma('journal_mode = WAL');
    db.exec(PRE_RENAME_USERS);
    const insert = db.prepare(
      `INSERT INTO users (id, email, role, plan, credits, created_at, updated_at)
       VALUES (?, ?, 'user', ?, 3, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
    );
    for (const row of OLD_ACCOUNTS) insert.run(...row);
  } finally {
    db.close();
  }
}

function columnsOf(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all();
}

/** Opens the app's connection the way a fresh process would, capturing what it logs. */
function boot() {
  const logged = [];
  const warned = [];
  const realLog = console.log;
  const realWarn = console.warn;
  console.log = (...args) => logged.push(args.join(' '));
  console.warn = (...args) => warned.push(args.join(' '));
  try {
    // A fresh module is a fresh connection map: the same as a restart.
    const sqlite = loadFresh('../dist/database/sqlite');
    const db = sqlite.getDb();
    return { db, logged, warned };
  } finally {
    console.log = realLog;
    console.warn = realWarn;
  }
}

const renameLines = (lines) => lines.filter((line) => line.includes('[db] Renamed users.plan to subscription'));

test('a database made before the rename keeps every account on its tier, renamed exactly once', () => {
  const { dbDir } = useTempStorage('subscription-rename-old');
  writePreRenameDatabase(dbDir);

  const first = boot();
  const columns = columnsOf(first.db, 'users');
  const names = columns.map((column) => column.name);
  assert.ok(names.includes('subscription'), names.join(', '));
  assert.ok(!names.includes('plan'), 'the old column is renamed, not copied beside the new one');
  // Renamed in place, so the column keeps what made it safe to insert without
  // naming it: NOT NULL and the Default tier.
  const subscription = columns.find((column) => column.name === 'subscription');
  assert.equal(subscription.notnull, 1);
  assert.equal(subscription.dflt_value, "'default'");
  assert.equal(renameLines(first.logged).length, 1, first.logged.join('\n'));

  // Every value where it was.
  const stored = first.db.prepare('SELECT id, subscription, credits FROM users ORDER BY id').all();
  assert.deepEqual(
    stored.map((row) => [row.id, row.subscription]),
    OLD_ACCOUNTS.map(([id, , tier]) => [id, tier]).sort((a, b) => a[0].localeCompare(b[0]))
  );
  // The balance is the one thing that did move, and not by the rename: the
  // same start switched credits to dollars (database/dollarSwitch.ts), which
  // resets every balance and says so in each account's history.
  assert.ok(stored.every((row) => row.credits === 0), 'the switch to dollars reset the old balances');
  const resets = first.db.prepare("SELECT user_id, delta FROM credit_ledger WHERE reason = 'reset'").all();
  assert.equal(resets.length, OLD_ACCOUNTS.length);
  assert.ok(resets.every((row) => row.delta === -3));

  // And read through the repository, as the app reads it.
  const users = loadFresh('../dist/database/userRepository');
  assert.equal(users.getUserById('u-premium').subscription, 'premium');
  assert.equal(users.getUserById('u-plus').subscription, 'premium-plus');
  assert.equal(users.getUserById('u-max').subscription, 'premium-max');
  assert.equal(users.getUserById('u-default').subscription, 'default');
  assert.equal('plan' in users.getUserById('u-premium'), false);
  // A new account on the renamed table lands on Default, as before.
  const created = users.createUser({ email: 'new@example.com' });
  assert.equal(created.subscription, 'default');
  // And a change writes the new column.
  assert.equal(users.updateUser('u-default', { subscription: 'premium' }).subscription, 'premium');
  first.db.close();

  // The second start: nothing to rename, nothing logged, nothing moved.
  const second = boot();
  assert.equal(renameLines(second.logged).length, 0, second.logged.join('\n'));
  assert.equal(second.warned.length, 0, second.warned.join('\n'));
  const after = second.db.prepare('SELECT id, subscription FROM users ORDER BY id').all();
  assert.deepEqual(
    Object.fromEntries(after.map((row) => [row.id, row.subscription])),
    {
      'u-default': 'premium',
      'u-max': 'premium-max',
      'u-plus': 'premium-plus',
      'u-premium': 'premium',
      [created.id]: 'default',
    }
  );
  second.db.close();
});

test('a fresh database is created with the new name and has nothing to rename', () => {
  useTempStorage('subscription-rename-fresh');
  const { db, logged, warned } = boot();
  const names = columnsOf(db, 'users').map((column) => column.name);
  assert.ok(names.includes('subscription'));
  assert.ok(!names.includes('plan'));
  assert.equal(renameLines(logged).length, 0);
  assert.equal(warned.length, 0, warned.join('\n'));
  db.close();
});

test('a database renamed back for a rollback is renamed forward again on the next upgrade', () => {
  // The reason the guard is the table and not a schema_meta marker: a marker
  // would still say "done" here, skip the rename, and leave every account read
  // failing on a column that is not there.
  const { dbDir } = useTempStorage('subscription-rename-rollback');
  writePreRenameDatabase(dbDir);
  boot().db.close();

  // The documented way down (README, "Plans are now subscriptions"), and the older
  // build then writing under the old name.
  const raw = new Database(path.join(dbDir, 'free_tailor.db'));
  raw.exec('ALTER TABLE users RENAME COLUMN subscription TO plan');
  raw.prepare("UPDATE users SET plan = 'premium-max' WHERE id = 'u-default'").run();
  raw.close();

  const again = boot();
  assert.equal(renameLines(again.logged).length, 1);
  const users = loadFresh('../dist/database/userRepository');
  assert.equal(users.getUserById('u-default').subscription, 'premium-max', 'what the older build wrote is kept');
  assert.equal(users.getUserById('u-premium').subscription, 'premium');
  again.db.close();
});

test('with both columns present the new one is read and the old one left alone, with a warning', () => {
  // A plan column ADDED back by hand instead of renamed. Neither is merged into
  // the other on a guess; the operator is told, and README says what to run.
  const { dbDir } = useTempStorage('subscription-rename-both');
  writePreRenameDatabase(dbDir);
  boot().db.close();
  const raw = new Database(path.join(dbDir, 'free_tailor.db'));
  raw.exec("ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'default'");
  raw.prepare("UPDATE users SET plan = 'premium-max' WHERE id = 'u-premium'").run();
  raw.close();

  const { db, logged, warned } = boot();
  const names = columnsOf(db, 'users').map((column) => column.name);
  assert.ok(names.includes('subscription') && names.includes('plan'));
  assert.equal(renameLines(logged).length, 0);
  assert.equal(warned.length, 1);
  assert.match(warned[0], /users has both "plan" and "subscription"; reading "subscription"/);
  const users = loadFresh('../dist/database/userRepository');
  assert.equal(users.getUserById('u-premium').subscription, 'premium');
  db.close();
});

/**
 * A second opener of the same file - another server on the same DB_DIR, or
 * `migrate:legacy` started beside the backend - that renames the column while
 * this one is booting, in its own thread.
 *
 * A thread and not a process because getDb() waits for the lock synchronously,
 * inside SQLite's busy handler: nothing on this thread can run until it
 * returns, so the peer has to commit from somewhere else. It holds its write
 * transaction, renamed but not committed, until it is told getDb() is about to
 * start, then commits a moment later - while the boot is already under way.
 */
function startPeerRename(dbFile) {
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(
    `
      const { parentPort, workerData } = require('node:worker_threads');
      const Database = require(workerData.betterSqlite3);
      const db = new Database(workerData.dbFile);
      db.exec('BEGIN IMMEDIATE');
      db.exec('ALTER TABLE users RENAME COLUMN plan TO subscription');
      parentPort.postMessage('holding');
      Atomics.wait(workerData.gate, 0, 0);
      // Long enough for the boot to have read the table (before the fix) or to
      // be queued on the lock (after it); far inside its five-second wait.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
      db.exec('COMMIT');
      db.close();
    `,
    { eval: true, workerData: { dbFile, gate, betterSqlite3: require.resolve('better-sqlite3') } }
  );
  const exited = new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`peer exited with ${code}`))));
  });
  const holding = new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });
  const release = () => {
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
  };
  return { holding, release, exited };
}

test('a boot that loses the rename to another opener of the same file starts anyway, renamed once', async () => {
  // The check and the rename are one write transaction. Read outside one, the
  // table said "plan" here, the peer's rename landed, and this start died with
  // "no such column" and advice to check the file was writable - though it was,
  // and the rename it reported failing had already happened.
  const { dbDir } = useTempStorage('subscription-rename-race');
  writePreRenameDatabase(dbDir);
  const peer = startPeerRename(path.join(dbDir, 'free_tailor.db'));
  await peer.holding;

  peer.release();
  const { db, logged, warned } = boot();
  await peer.exited;

  // The peer renamed it; this start found it renamed and did nothing.
  assert.equal(renameLines(logged).length, 0, logged.join('\n'));
  assert.equal(warned.length, 0, warned.join('\n'));
  const names = columnsOf(db, 'users').map((column) => column.name);
  assert.ok(names.includes('subscription') && !names.includes('plan'), names.join(', '));
  const users = loadFresh('../dist/database/userRepository');
  for (const [id, , tier] of OLD_ACCOUNTS) assert.equal(users.getUserById(id).subscription, tier);
  db.close();
});

// -- the frontend --------------------------------------------------------- //

const FRONTEND_SRC = path.join(__dirname, '..', '..', 'frontend', 'src');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

/**
 * Loads a frontend module, resolving its `@/` imports to other frontend
 * modules and refusing anything else - the frontendHelpers.test.js loader, made
 * to follow `@/` so navModel (which imports the tier order) can be loaded.
 */
function loadFrontend(relative, seen = new Map()) {
  const file = path.join(FRONTEND_SRC, relative);
  if (seen.has(file)) return seen.get(file).exports;
  const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: file,
  });
  const module = { exports: {} };
  seen.set(file, module);
  const requireFrontend = (specifier) => {
    if (!specifier.startsWith('@/')) throw new Error(`${relative} imports ${specifier} at runtime`);
    const base = specifier.slice(2);
    const candidate = ['.ts', '.tsx'].map((ext) => `${base}${ext}`).find((name) => fs.existsSync(path.join(FRONTEND_SRC, name)));
    if (!candidate) throw new Error(`${relative}: cannot resolve ${specifier}`);
    return loadFrontend(candidate, seen);
  };
  new Function('module', 'exports', 'require', outputText)(module, module.exports, requireFrontend);
  return module.exports;
}

/** Strips comments, so a comment about the history of a name is not a hit. */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ''))
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

test('Settings > Subscription is a tab, and the old Settings > Plan address redirects to it', () => {
  const nav = loadFrontend('components/shell/navModel.ts');
  assert.deepEqual(
    nav.SETTINGS_ACCOUNT_TABS.find((tab) => tab.href === '/settings/subscription'),
    { href: '/settings/subscription', label: 'Subscription' }
  );
  assert.equal(nav.SETTINGS_ITEMS.some((tab) => tab.href === '/settings/plan'), false);
  // Longest match: the subscription page lights its own tab, not Profile.
  assert.equal(nav.activeHref('/settings/subscription', nav.SETTINGS_ACCOUNT_TABS), '/settings/subscription');
  assert.equal(nav.isSettingsRoute('/settings/subscription'), true);

  // An entry a tier includes is shown from that tier up, to any builder on it
  // (the role half is test/frontendRoles.test.js's).
  const premiumOnly = { href: '/x', label: 'X', icon: 'build', needs: 'premium' };
  assert.equal(nav.canSee(premiumOnly, 'user', 'default'), false);
  assert.equal(nav.canSee(premiumOnly, 'user', 'premium-plus'), true);
  assert.equal(nav.canSee(premiumOnly, 'user', 'premium-ultra'), false, 'an unknown tier ranks lowest');

  assert.ok(fs.existsSync(path.join(FRONTEND_SRC, 'app/settings/subscription/page.tsx')));
  // Nothing at the old address but the redirect: no page of its own to drift.
  const old = codeOnly(fs.readFileSync(path.join(FRONTEND_SRC, 'app/settings/plan/page.tsx'), 'utf8'));
  assert.match(old, /import \{ redirect \} from 'next\/navigation'/);
  assert.match(old, /redirect\('\/settings\/subscription'\)/);
  assert.doesNotMatch(old, /<\w/, 'renders no markup');

  // And the old account page's #subscription anchor goes straight there.
  const account = fs.readFileSync(path.join(FRONTEND_SRC, 'app/account/page.tsx'), 'utf8');
  assert.match(account, /'#subscription'\) return '\/settings\/subscription'/);
});

/**
 * Words ("Plan", "plans", "/settings/plan"), and the name at either end of an
 * identifier (planLabel, invitePlan, RequiresPlan, PlanPill, PlanId,
 * PLAN_ORDER) - the rename covered the code as well as the copy. A word that
 * only begins with the letters (Planner, activePlanner) is not the tier.
 */
const TIER_PLAN = [/\bplans?\b/i, /[a-z]Plans?(?![a-z])/, /\b[pP]lans?[A-Z0-9_]/, /\bPLANS?_|_PLANS?\b/];
const namesTierPlan = (line) => TIER_PLAN.some((pattern) => pattern.test(line));

test('the plan guard catches the name in every identifier position, and nothing that merely starts with it', () => {
  // Pinned on its own because a guard that misses a shape passes silently: a
  // later <PlanPill> would have gone through before the leading-capital case
  // was added.
  for (const line of [
    'Plan',
    'your plans',
    "href: '/settings/plan'",
    'planLabel',
    'const invitePlan = 1;',
    'function RequiresPlan() {}',
    '<PlanPill tone="sky" />',
    'const PlanBadge = 1;',
    'type PlanId = string;',
    'export default function PlanSettingsPage() {',
    'PLAN_ORDER',
    'ACCOUNT_PLANS',
  ]) {
    assert.equal(namesTierPlan(line), true, `not caught: ${line}`);
  }
  for (const line of ['activePlanner', 'Planner', '<PlannerView />', 'plannerSubCalendarCount', 'explanation', 'airplane']) {
    assert.equal(namesTierPlan(line), false, `wrongly caught: ${line}`);
  }
});

test('no frontend code or copy still calls the account tier a plan', () => {
  // The redirect page is the one file allowed to exist under the old name, and
  // its code names only the new one.
  const hits = [];
  for (const file of walk(FRONTEND_SRC)) {
    if (!/\.(tsx?|jsx?|css)$/.test(file)) continue;
    const relative = path.relative(FRONTEND_SRC, file);
    codeOnly(fs.readFileSync(file, 'utf8'))
      .split('\n')
      .forEach((line, index) => {
        if (namesTierPlan(line)) hits.push(`${relative}:${index + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(hits, []);

  const pathsNamedPlan = walk(FRONTEND_SRC)
    .map((file) => path.relative(FRONTEND_SRC, file).split(path.sep).join('/'))
    .filter((relative) => /(^|\/)plans?(\.|\/|$)/i.test(relative));
  assert.deepEqual(pathsNamedPlan, ['app/settings/plan/page.tsx']);
});
