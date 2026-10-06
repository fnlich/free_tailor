const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const Database = require('better-sqlite3');

const { loadFresh, useTempStorage } = require('./helpers');

/**
 * The README's "Rolling back this release" is a procedure an operator runs
 * against their only copy of the data, so its statements are pinned here
 * against the schema this build writes.
 *
 * The section was written by checking every step against the older build's own
 * code (commit 90adbaf) and running it against a database this build made. What
 * can drift afterwards is this build's side - a column renamed again, a notice
 * stored some other way, the template move's record under another key - and
 * then the documented statements would fail, or worse, succeed and leave a
 * database the older build still cannot read. So the test takes the statements
 * out of the README itself rather than repeating them.
 */

const README = path.join(__dirname, '..', '..', 'README.md');

/**
 * What the older build reads, frozen on purpose: its `users` and
 * `notifications` SELECTs (userRepository.ts / notificationRepository.ts at
 * 90adbaf). A column this build drops or renames that the older build still
 * selects makes every one of its account reads fail.
 */
const OLDER_BUILD_USER_COLUMNS = [
  'id', 'email', 'name', 'picture', 'role', 'plan', 'credits', 'google_sub', 'disabled', 'created_at',
  'updated_at', 'last_login_at', 'sheet_id', 'sheet_url', 'sheet_tab_date', 'sheet_tab_gid',
  'sheet_shared_at', 'notifications_seen_at', 'stripe_customer_id',
];
const OLDER_BUILD_NOTIFICATION_COLUMNS = ['id', 'title', 'body', 'author_id', 'author_name', 'created_at', 'updated_at'];
/** The roles the older build knows; anything else it reads as `user`. */
const OLDER_BUILD_ROLES = ['user', 'admin'];

function rollbackSection() {
  const readme = fs.readFileSync(README, 'utf8');
  const start = readme.indexOf('## ⏪ Rolling back this release');
  assert.notEqual(start, -1, 'README.md has a "Rolling back this release" section');
  const end = readme.indexOf('\n## ', start + 1);
  return readme.slice(start, end === -1 ? undefined : end);
}

/** The statements of the documented step, from both of its spellings, which must agree. */
function documentedStatements(section) {
  const shell = /sqlite3 "\$DB_DIR\/free_tailor\.db" "(ALTER TABLE users[^"]+)"/.exec(section);
  const node = /\.exec\(\\"(ALTER TABLE users[^\\]+)\\"\)/.exec(section);
  assert.ok(shell, 'the section gives the statements for the sqlite3 shell');
  assert.ok(node, 'and for node, without the shell');
  const split = (sql) =>
    sql
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean);
  assert.deepEqual(split(shell[1]), split(node[1]), 'the two spellings run the same statements');
  return split(node[1]);
}

function quietly(action) {
  const realLog = console.log;
  const realWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    return action();
  } finally {
    console.log = realLog;
    console.warn = realWarn;
  }
}

test("the README's rollback statements leave a database the older build can read", () => {
  const { dbDir } = useTempStorage('rollback-docs');
  const at = new Date().toISOString();

  // This build's database, with what only this build writes in it.
  const db = quietly(() => loadFresh('../dist/database/sqlite').getDb());
  const addUser = db.prepare(
    `INSERT INTO users (id, email, name, role, subscription, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  addUser.run('u-admin', 'admin@example.com', 'Admin', 'admin', 'default', at, at);
  addUser.run('u-ada', 'ada@example.com', 'Ada', 'user', 'premium', at, at);
  addUser.run('u-rep', 'rep@example.com', 'Rep', 'reporter', 'default', at, at);
  const notes = loadFresh('../dist/database/notificationRepository');
  notes.createNotification({ title: 'Refund made', body: 'Your refund request was refunded.', recipientId: 'u-ada' });
  notes.createNotification({ title: 'New refund request', body: 'ada@example.com asks...', recipientId: 'u-admin' });
  notes.createNotification({ title: 'Maintenance tonight', body: 'For everybody.' });
  db.close();

  const statements = documentedStatements(rollbackSection());
  const file = path.join(dbDir, 'free_tailor.db');
  const raw = new Database(file);
  try {
    raw.exec(statements.join('; '));

    const userColumns = raw.prepare('PRAGMA table_info(users)').all().map((column) => column.name);
    for (const column of OLDER_BUILD_USER_COLUMNS) {
      assert.ok(userColumns.includes(column), `users.${column}, which the older build selects, is there`);
    }
    assert.ok(!userColumns.includes('subscription'), 'renamed back, not a second column beside it');
    raw.prepare(`SELECT ${OLDER_BUILD_USER_COLUMNS.join(', ')} FROM users`).all();

    const notificationColumns = raw.prepare('PRAGMA table_info(notifications)').all().map((column) => column.name);
    for (const column of OLDER_BUILD_NOTIFICATION_COLUMNS) {
      assert.ok(notificationColumns.includes(column), `notifications.${column} is there`);
    }
    // The older build has no recipient filter, so whatever is left is in every bell.
    assert.deepEqual(
      raw.prepare('SELECT title FROM notifications').all().map((row) => row.title),
      ['Maintenance tonight'],
      'only the announcement is left for the older build to show everybody'
    );

    // Every account the older build would read as a user, and is not one, cannot sign in.
    const unknownRoles = raw
      .prepare(`SELECT email FROM users WHERE role NOT IN (${OLDER_BUILD_ROLES.map(() => '?').join(', ')}) AND disabled = 0`)
      .all(...OLDER_BUILD_ROLES);
    assert.deepEqual(unknownRoles, [], 'no enabled account holds a role the older build does not know');
    assert.deepEqual(
      raw.prepare('SELECT email, plan, disabled FROM users ORDER BY email').all(),
      [
        { email: 'ada@example.com', plan: 'premium', disabled: 0 },
        { email: 'admin@example.com', plan: 'default', disabled: 0 },
        { email: 'rep@example.com', plan: 'default', disabled: 1 },
      ],
      'every subscription is kept under the old name, and only the reporter is disabled'
    );
  } finally {
    raw.close();
  }

  // Upgrading again: renamed forward by itself, and the reporter is still a
  // reporter for an administrator to enable.
  const again = quietly(() => loadFresh('../dist/database/sqlite').getDb());
  try {
    assert.deepEqual(again.prepare("SELECT role, subscription, disabled FROM users WHERE id = 'u-rep'").get(), {
      role: 'reporter',
      subscription: 'default',
      disabled: 1,
    });
  } finally {
    again.close();
  }
});

test('the rollback section names the template move record and the settings log this build writes', () => {
  const section = rollbackSection();
  const { TEMPLATE_MOVE_MARKER } = loadFresh('../dist/database/templateFileMove');
  const { DOLLAR_SWITCH_LOG_KEY } = loadFresh('../dist/database/dollarSwitch');
  assert.ok(
    section.includes(`SELECT value FROM schema_meta WHERE key = '${TEMPLATE_MOVE_MARKER}'`),
    'it reads the renames from the record the move writes'
  );
  assert.ok(
    section.includes(`DELETE FROM schema_meta WHERE key = '${TEMPLATE_MOVE_MARKER}'`),
    'and deletes that record to run the move again'
  );
  assert.ok(section.includes(`app_settings["${DOLLAR_SWITCH_LOG_KEY}"]`), 'it points at the old prices where the switch kept them');
});
