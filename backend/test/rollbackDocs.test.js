const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const Database = require('better-sqlite3');

const { loadFresh, useTempStorage, useAdminEmails } = require('./helpers');

/**
 * The README's "Rolling back this release" is a procedure an operator runs
 * against their only copy of the data, so what it says to run is pinned here
 * against the schema this build writes - taken out of the README itself rather
 * than repeated, so the README cannot drift from what is tested.
 *
 * It has two targets, each written by checking every step against that
 * build's own code:
 *
 *  - the release before this one (commit 5177fc3) needs NO change to the
 *    database - this release renamed nothing it reads - only a check, before
 *    stopping this build, that the two things it cannot finish are done: no
 *    payout request still open (it reads one as a resume's refund request and
 *    can neither pay nor close it) and no edited analysis prompt naming
 *    [[industryList]] (it refuses the prompt, and every new analysis fails).
 *    The check must list both while they stand and nothing once they are dealt
 *    with, its way to build from All there must be one its sheet panel takes,
 *    and that build's own reads - and its lake insert - must still run
 *    against this build's schema, the next start filling in what it wrote;
 *  - going further back, to 90adbaf, takes three statements: what is left
 *    must be a database that build can read.
 *
 * What can drift afterwards is this build's side - a column renamed, a request
 * stored under another kind, a notice stored some other way, the template
 * move's record under another key - and then the documented statements would
 * fail, or worse, succeed and leave a database the older build cannot read.
 */

const README = path.join(__dirname, '..', '..', 'README.md');
const SHIPPED_STATIC = path.join(__dirname, '..', 'static');

/* ------------------------------------------- 5177fc3, the previous release -- */
// Frozen on purpose: what that build selects and writes, word for word from
// its repositories. A column this build drops or renames that it still names
// makes the corresponding read or write fail outright.

/** userRepository.ts USER_COLUMNS at 5177fc3. */
const PREVIOUS_BUILD_USER_COLUMNS = [
  'id', 'email', 'name', 'picture', 'role', 'subscription', 'credits', 'balance_milli', 'google_sub', 'disabled',
  'created_at', 'updated_at', 'last_login_at', 'sheet_id', 'sheet_url', 'sheet_tab_date', 'sheet_tab_gid',
  'sheet_shared_at', 'notifications_seen_at', 'stripe_customer_id',
];
/** refundRequestRepository.ts COLUMNS at 5177fc3. */
const PREVIOUS_BUILD_REFUND_COLUMNS = [
  'id', 'reference', 'account_id', 'kind', 'item_key', 'payment_id', 'order_item_id', 'task_id', 'reservation_id',
  'label', 'amount_milli', 'refunded_milli', 'attempt_milli', 'hold_key', 'reason', 'state', 'decline_reason',
  'decided_by', 'decided_at', 'refunded_by', 'refunded_at', 'created_at', 'updated_at',
];
/** jobLakeRepository.ts LIST_COLUMNS at 5177fc3. */
const PREVIOUS_BUILD_LAKE_LIST_COLUMNS = [
  'id', 'job_hash', 'hash_version', 'company', 'company_key', 'job_field_id', 'title', 'salary_min', 'salary_max',
  'salary_currency', 'salary_period', 'salary_raw', 'job_url', 'analysis_id', 'requested_by', 'source', 'created_at',
  'updated_at', 'seen_count', 'last_seen_at', 'sheet_synced_at', 'reward_milli', 'reward_rate_milli',
  'reward_revoked_milli', 'reward_revoked_at',
];
/** Its insert of a new lake job (jobLakeRepository.ts mergeIntoLake at 5177fc3): none of this release's columns. */
const PREVIOUS_BUILD_LAKE_INSERT = `INSERT INTO job_lake (
             job_hash, hash_version, company, company_key, job_field_id, title,
             salary_min, salary_max, salary_currency, salary_period, salary_raw,
             job_url, job_description, analysis_id, requested_by, source, report_ref,
             created_at, updated_at, seen_count, last_seen_at
           ) VALUES (
             @job_hash, @hash_version, @company, @company_key, @job_field_id, @title,
             @salary_min, @salary_max, @salary_currency, @salary_period, @salary_raw,
             @job_url, @job_description, @analysis_id, @requested_by, @source, @report_ref,
             @now, @now, 1, @now
           ) ON CONFLICT (job_hash) DO NOTHING`;
/**
 * How it reads a prompt's variables (promptService.ts VARIABLE_PATTERN at
 * 5177fc3): spaces inside the brackets are allowed, so `[[ industryList ]]`
 * is the variable it refuses as surely as `[[industryList]]`.
 */
const PREVIOUS_BUILD_VARIABLE_PATTERN = /\[\[\s*([a-zA-Z0-9_.-]+)\s*\]\]/g;
/**
 * Build Resumes' sheet panel at 5177fc3: the own sheet's layout it starts on
 * (lib/sheetRows.ts OWN_SHEET_LAYOUT - the four columns it maps; Job Field,
 * Salary and Analysis are not this check's), and the check its `load()` makes
 * of the Advanced columns (components/SheetsSourcePanel.tsx): the From/To
 * columns are what is loaded, and Company or Job Description outside them is
 * refused by name, Job Title or Job Link quietly left out.
 */
const PREVIOUS_BUILD_OWN_SHEET_LAYOUT = {
  fromCol: 'B', toCol: 'E', company: 'B', jobTitle: 'C', jobLink: 'D', jobDescription: 'E',
};
function previousBuildPanelColumns(layout) {
  const column = (letters) => letters.split('').reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0);
  const firstCol = column(layout.fromCol);
  const lastCol = column(layout.toCol);
  if (lastCol < firstCol) throw new Error('To column must be From column or a column after it.');
  const range = `${layout.fromCol}:${layout.toCol}`;
  const offset = (label, letters, required) => {
    const at = column(letters);
    if (at >= firstCol && at <= lastCol) return at;
    if (required) throw new Error(`The ${label} column (${letters}) is outside the columns loaded (${range}).`);
    return null;
  };
  return {
    company: offset('Company', layout.company, true),
    jobTitle: offset('Job Title', layout.jobTitle, false),
    jobLink: offset('Job Link', layout.jobLink, false),
    jobDescription: offset('Job Description', layout.jobDescription, true),
  };
}
/** The item types it knows (REFUND_ITEM_TYPES at 5177fc3). */
const PREVIOUS_BUILD_ITEM_TYPES = ['payment', 'order-item', 'task', 'charge'];

/** How it reads a request's kind and item (refundRequestRepository.ts toRequest at 5177fc3). */
function previousBuildReadsRequest(row) {
  const itemType = row.item_key.slice(0, row.item_key.indexOf(':'));
  return {
    kind: row.kind === 'purchase' ? 'purchase' : 'resume',
    itemType: PREVIOUS_BUILD_ITEM_TYPES.includes(itemType) ? itemType : 'payment',
  };
}

/* --------------------------------------------- 90adbaf, the one before that -- */

/**
 * What 90adbaf reads, frozen on purpose: its `users` and `notifications`
 * SELECTs (userRepository.ts / notificationRepository.ts at 90adbaf).
 */
const EARLIER_BUILD_USER_COLUMNS = [
  'id', 'email', 'name', 'picture', 'role', 'plan', 'credits', 'google_sub', 'disabled', 'created_at',
  'updated_at', 'last_login_at', 'sheet_id', 'sheet_url', 'sheet_tab_date', 'sheet_tab_gid',
  'sheet_shared_at', 'notifications_seen_at', 'stripe_customer_id',
];
const EARLIER_BUILD_NOTIFICATION_COLUMNS = ['id', 'title', 'body', 'author_id', 'author_name', 'created_at', 'updated_at'];
/** The roles 90adbaf knows; anything else it reads as `user`. */
const EARLIER_BUILD_ROLES = ['user', 'admin'];

/* ---------------------------------------------------------------- helpers -- */

function rollbackSection() {
  const readme = fs.readFileSync(README, 'utf8');
  const start = readme.indexOf('## ⏪ Rolling back this release');
  assert.notEqual(start, -1, 'README.md has a "Rolling back this release" section');
  const end = readme.indexOf('\n## ', start + 1);
  return readme.slice(start, end === -1 ? undefined : end);
}

/** The subsection for going back to 90adbaf, which must be inside the rollback section. */
function earlierBuildSection(section) {
  const start = section.indexOf('### Going back further, to 90adbaf');
  assert.notEqual(start, -1, 'the rollback section has a "Going back further, to 90adbaf" subsection');
  return { previous: section.slice(0, start), earlier: section.slice(start) };
}

function split(sql) {
  return sql
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/** The check before going back to 5177fc3, from both of its spellings, which must agree. */
function documentedCheck(section) {
  const shell = /sqlite3 "\$DB_DIR\/free_tailor\.db" "(SELECT [^"]+)"/.exec(section);
  const node = /\.prepare\(\\"(SELECT [^\\]+)\\"\)/.exec(section);
  assert.ok(shell, 'the section gives the check for the sqlite3 shell');
  assert.ok(node, 'and for node, without the shell');
  assert.equal(shell[1], node[1], 'the two spellings run the same query');
  assert.equal(split(shell[1]).length, 1, 'one query, so node can print every line it answers');
  return shell[1];
}

/** The statements for going back to 90adbaf, from both of their spellings, which must agree. */
function documentedStatements(section) {
  const shell = /sqlite3 "\$DB_DIR\/free_tailor\.db" "(ALTER TABLE users[^"]+)"/.exec(section);
  const node = /\.exec\(\\"(ALTER TABLE users[^\\]+)\\"\)/.exec(section);
  assert.ok(shell, 'the section gives the statements for the sqlite3 shell');
  assert.ok(node, 'and for node, without the shell');
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

async function quietlyAsync(action) {
  const realLog = console.log;
  const realWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    return await action();
  } finally {
    console.log = realLog;
    console.warn = realWarn;
  }
}

/* ------------------------------------------------------------------ tests -- */

test("the README's check before going back to 5177fc3 lists what that build cannot finish, and nothing once it is done", async () => {
  const { dbDir, staticDir } = useTempStorage('rollback-docs-check');
  fs.cpSync(path.join(SHIPPED_STATIC, 'prompts'), path.join(staticDir, 'prompts'), { recursive: true });
  fs.cpSync(path.join(SHIPPED_STATIC, 'skills'), path.join(staticDir, 'skills'), { recursive: true });
  useAdminEmails('admin@example.com');

  quietly(() => loadFresh('../dist/database/sqlite').getDb());
  loadFresh('../dist/database/dailySequence');
  loadFresh('../dist/database/settingsRepository');
  loadFresh('../dist/database/generationRepository');
  const users = loadFresh('../dist/database/userRepository');
  loadFresh('../dist/database/creditRepository');
  loadFresh('../dist/database/paymentRepository');
  loadFresh('../dist/database/orderRepository');
  loadFresh('../dist/database/refundRequestRepository');
  loadFresh('../dist/database/notificationRepository');
  const credits = loadFresh('../dist/services/credits');
  loadFresh('../dist/config/aiModelConfig');
  loadFresh('../dist/services/payments');
  loadFresh('../dist/services/queue/index').resetGenerationQueueForTests();
  const refunds = loadFresh('../dist/services/refunds');
  const promptService = loadFresh('../dist/services/promptService');

  const admin = users.createUser({ email: 'admin@example.com', name: 'Admin' });
  const scout = users.createUser({ email: 'scout@example.com', name: 'Scout', role: 'reporter' });
  const ranger = users.createUser({ email: 'ranger@example.com', name: 'Ranger', role: 'reporter' });
  assert.equal(admin.role, 'admin');
  credits.grantCredits(scout.id, 5_000, admin.id, 'Job rewards');
  credits.grantCredits(ranger.id, 2_000, admin.id, 'Job rewards');

  // One payout request left open, one already decided - only the first is
  // anything the older build cannot finish.
  const open = refunds.createPayoutRequest(scout, { reason: 'PayPal, please.' });
  const decided = refunds.createPayoutRequest(ranger, {});
  refunds.declineRefund(decided.id, admin, { reason: 'Paid in cash at the office.' });

  // An analysis prompt edited under this release: the shipped text, which
  // names the industry list.
  const shipped = JSON.parse(fs.readFileSync(path.join(SHIPPED_STATIC, 'prompts', 'analyze-job-description.json'), 'utf8'));
  assert.match(shipped.content, /\[\[industryList\]\]/, 'the shipped analysis prompt names the industry list');
  await quietlyAsync(() =>
    promptService.updatePrompt('analyze-job-description', { content: `${shipped.content}\nAnd be brief.` })
  );

  // An analysis variant an older build created, edited here: its text never
  // names the industry list, but this build stores the feature's variables
  // beside it - industryList among them - so only the TEXT may be looked at.
  const { saveStoredPrompt } = require('../dist/database/promptRepository');
  const now = new Date().toISOString();
  saveStoredPrompt({
    id: 'custom-old-analysis',
    name: 'Old analysis variant',
    featureKey: 'analyze-job-description',
    content: 'Old [[jobDescription]]',
    isBuiltIn: false,
    createdAt: now,
    updatedAt: now,
  });
  await quietlyAsync(() =>
    promptService.updatePrompt('custom-old-analysis', { content: 'Old, and brief: [[jobDescription]]' })
  );

  const check = documentedCheck(earlierBuildSection(rollbackSection()).previous);
  const file = path.join(dbDir, 'free_tailor.db');
  const run = () => {
    const raw = new Database(file, { readonly: true });
    try {
      return raw.prepare(check).pluck().all();
    } finally {
      raw.close();
    }
  };

  const variantRow = (() => {
    const raw = new Database(file, { readonly: true });
    try {
      return raw.prepare("SELECT data FROM prompts WHERE id = 'custom-old-analysis'").pluck().get();
    } finally {
      raw.close();
    }
  })();
  assert.match(variantRow, /industryList/, 'the variant\'s stored row names industryList outside its text');
  assert.doesNotMatch(JSON.parse(variantRow).content, /industryList/);

  assert.deepEqual(
    run(),
    [`Open payout request ${open.reference}`, 'Prompt naming [[industryList]]: analyze-job-description'],
    'the open payout request and the edited prompt, and neither the payout request already decided nor the variant'
  );

  // Written with spaces inside the brackets, this build takes it - and so
  // does the older build, as the same variable it refuses - so the check
  // must still list it.
  const spaced = shipped.content.replace('[[industryList]]', '[[ industryList ]]');
  assert.notEqual(spaced, shipped.content);
  await quietlyAsync(() =>
    promptService.updatePrompt('analyze-job-description', { content: `${spaced}\nAnd be brief.` })
  );
  assert.ok(promptService.extractPromptVariables(spaced).includes('industryList'), 'this build reads it as the variable');
  assert.ok(
    Array.from(spaced.matchAll(PREVIOUS_BUILD_VARIABLE_PATTERN), (match) => match[1]).includes('industryList'),
    'and so does 5177fc3'
  );
  assert.deepEqual(
    run(),
    [`Open payout request ${open.reference}`, 'Prompt naming [[industryList]]: analyze-job-description'],
    'the prompt naming [[ industryList ]] is listed too'
  );

  // Step 1: the payout recorded. Step 2: the variable and its heading taken out.
  await quietlyAsync(() => refunds.refundRequest(open.id, admin, { amountUsd: '5', note: 'Sent by PayPal.' }));
  const withoutIndustries = shipped.content.replace('INDUSTRIES (id: label):\n[[industryList]]\n\n', '');
  assert.doesNotMatch(withoutIndustries, /industryList/, 'the README names the heading the shipped text puts it under');
  await quietlyAsync(() =>
    promptService.updatePrompt('analyze-job-description', { content: `${withoutIndustries}\nAnd be brief.` })
  );

  assert.deepEqual(run(), [], 'nothing left once both steps are done');
});

test("the README's way to build from All under 5177fc3 is one that build's panel takes, reading All's own columns", () => {
  // Every place that says how: the rollback section and its Troubleshooting
  // row. Changing only the four columns leaves B:E loaded (Job Description F
  // refused); changing only the range leaves Company on B (refused) - so each
  // place must name both.
  const readme = fs.readFileSync(README, 'utf8').replace(/\s+/g, ' ');
  const { JOB_SHEET_COLUMNS } = require('../dist/integrations/googleSheets');
  const all = {
    company: JOB_SHEET_COLUMNS.company,
    jobTitle: JOB_SHEET_COLUMNS.jobTitle,
    jobLink: JOB_SHEET_COLUMNS.jobLink,
    jobDescription: JOB_SHEET_COLUMNS.jobDescription,
  };
  const places = [];
  for (let at = readme.indexOf('to build from All there'); at !== -1; at = readme.indexOf('to build from All there', at + 1)) {
    places.push(readme.slice(at, at + 400).split(/[.)]/)[0]);
  }
  assert.ok(places.length >= 2, 'the rollback section and the Troubleshooting row both say how');
  for (const place of places) {
    const named = (label) => new RegExp(`${label} ([A-Z]+)\\b`).exec(place)?.[1];
    const layout = { ...PREVIOUS_BUILD_OWN_SHEET_LAYOUT };
    for (const [key, label] of [
      ['fromCol', 'From column'], ['toCol', 'To column'], ['company', 'Company'],
      ['jobTitle', 'Job Title'], ['jobLink', 'Job Link'], ['jobDescription', 'Job Description'],
    ]) {
      layout[key] = named(label) ?? layout[key];
    }
    assert.deepEqual(previousBuildPanelColumns(layout), all, `followed as written, it reads All's columns: "${place}"`);
  }
});

test('the previous build (5177fc3) still reads and writes what this build left, and the next start fills in what it wrote', () => {
  const { dbDir } = useTempStorage('rollback-docs-previous');
  const at = new Date().toISOString();

  // This build's database, with what only this build writes in it.
  const db = quietly(() => loadFresh('../dist/database/sqlite').getDb());
  const addUser = db.prepare(
    `INSERT INTO users (id, email, name, role, subscription, created_at, updated_at, sheet_id, sheet_layout,
       sheet_all_gid, sheet_temp_gid)
     VALUES (?, ?, ?, ?, 'default', ?, ?, ?, ?, ?, ?)`
  );
  addUser.run('u-admin', 'admin@example.com', 'Admin', 'admin', at, at, 'sheet-a', 2, '0', '1');
  addUser.run('u-rep', 'rep@example.com', 'Rep', 'reporter', at, at, 'sheet-r', 2, '0', '1');
  const requests = loadFresh('../dist/database/refundRequestRepository');
  const payout = requests.insertRefundRequest({
    accountId: 'u-rep',
    kind: 'payout',
    itemType: 'payout',
    itemId: 'u-rep',
    label: 'Payout of earnings',
    amountMilli: 5_000,
    reason: '',
  });
  const analyses = loadFresh('../dist/database/jobAnalysisRepository');
  const stored = analyses.insertJobAnalysisIfAbsent({
    contentHash: 'hash-of-the-posting',
    linkKey: null,
    jobLink: '',
    analysis: {
      jobField: 'backend',
      jobMeta: { title: 'Backend Engineer' },
      filter: { jobType: 'remote', clearanceRequired: 'secret', companyCategory: 'fintech' },
      sourceJobDescription: 'A backend posting, long enough to be one.',
    },
    modelId: 'claude-cli',
    promptHash: 'p',
    source: 'ai',
    createdBy: 'u-rep',
  }).row;
  db.close();

  // The older build, against it: its reads, and a job it adds while rolled back.
  const file = path.join(dbDir, 'free_tailor.db');
  const raw = new Database(file);
  try {
    raw.prepare(`SELECT ${PREVIOUS_BUILD_USER_COLUMNS.join(', ')} FROM users`).all();
    const row = raw.prepare(`SELECT ${PREVIOUS_BUILD_REFUND_COLUMNS.join(', ')} FROM refund_requests WHERE id = ?`).get(payout.id);
    assert.equal(row.kind, 'payout', 'a payout request is stored under its own kind - what the check looks for');
    assert.deepEqual(
      previousBuildReadsRequest(row),
      { kind: 'resume', itemType: 'payment' },
      'and the older build reads it as a resume refund naming a payment - which is why it is decided first'
    );
    raw
      .prepare(PREVIOUS_BUILD_LAKE_INSERT)
      .run({
        job_hash: 'older-build-hash',
        hash_version: 1,
        company: 'Acme',
        company_key: 'acme',
        job_field_id: 'backend',
        title: 'Backend Engineer',
        salary_min: null,
        salary_max: null,
        salary_currency: null,
        salary_period: null,
        salary_raw: null,
        job_url: '',
        job_description: 'A backend posting, long enough to be one.',
        analysis_id: stored.id,
        requested_by: 'u-rep',
        source: 'report',
        report_ref: 'sheet-r:12:03/01/2026',
        now: at,
      });
    const listed = raw.prepare(`SELECT ${PREVIOUS_BUILD_LAKE_LIST_COLUMNS.join(', ')} FROM job_lake`).all();
    assert.equal(listed.length, 1);
  } finally {
    raw.close();
  }

  // Upgrading again: the job it added gets this release's facts from its
  // analysis, and its report is remembered. (jobLakeStore.test.js covers the
  // older build's replacements and deletes as well.)
  const again = quietly(() => loadFresh('../dist/database/sqlite').getDb());
  try {
    assert.deepEqual(
      again.prepare("SELECT job_type, clearance, industry FROM job_lake WHERE job_hash = 'older-build-hash'").get(),
      { job_type: 'remote', clearance: 1, industry: 'finance' }
    );
    assert.deepEqual(
      again.prepare('SELECT account_id, analysis_id, outcome FROM job_reports').all(),
      [{ account_id: 'u-rep', analysis_id: stored.id, outcome: 'added' }]
    );
  } finally {
    again.close();
  }
});

test("the README's statements for going back to 90adbaf leave a database that build can read", () => {
  const { dbDir } = useTempStorage('rollback-docs-earlier');
  const at = new Date().toISOString();

  // This build's database, with what only later builds write in it.
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
  notes.createNotification({ title: 'New payout request', body: 'rep@example.com asks...', recipientId: 'u-admin' });
  notes.createNotification({ title: 'Payout recorded: $5', body: 'Sent by PayPal.', recipientId: 'u-rep' });
  notes.createNotification({ title: 'Maintenance tonight', body: 'For everybody.' });
  db.close();

  const statements = documentedStatements(earlierBuildSection(rollbackSection()).earlier);
  const file = path.join(dbDir, 'free_tailor.db');
  const raw = new Database(file);
  try {
    raw.exec(statements.join('; '));

    const userColumns = raw.prepare('PRAGMA table_info(users)').all().map((column) => column.name);
    for (const column of EARLIER_BUILD_USER_COLUMNS) {
      assert.ok(userColumns.includes(column), `users.${column}, which 90adbaf selects, is there`);
    }
    assert.ok(!userColumns.includes('subscription'), 'renamed back, not a second column beside it');
    raw.prepare(`SELECT ${EARLIER_BUILD_USER_COLUMNS.join(', ')} FROM users`).all();

    const notificationColumns = raw.prepare('PRAGMA table_info(notifications)').all().map((column) => column.name);
    for (const column of EARLIER_BUILD_NOTIFICATION_COLUMNS) {
      assert.ok(notificationColumns.includes(column), `notifications.${column} is there`);
    }
    // 90adbaf has no recipient filter, so whatever is left is in every bell.
    assert.deepEqual(
      raw.prepare('SELECT title FROM notifications').all().map((row) => row.title),
      ['Maintenance tonight'],
      'only the announcement is left for that build to show everybody'
    );

    // Every account it would read as a user, and is not one, cannot sign in.
    const unknownRoles = raw
      .prepare(`SELECT email FROM users WHERE role NOT IN (${EARLIER_BUILD_ROLES.map(() => '?').join(', ')}) AND disabled = 0`)
      .all(...EARLIER_BUILD_ROLES);
    assert.deepEqual(unknownRoles, [], 'no enabled account holds a role that build does not know');
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
  const { earlier } = earlierBuildSection(rollbackSection());
  const { TEMPLATE_MOVE_MARKER } = loadFresh('../dist/database/templateFileMove');
  const { DOLLAR_SWITCH_LOG_KEY } = loadFresh('../dist/database/dollarSwitch');
  assert.ok(
    earlier.includes(`SELECT value FROM schema_meta WHERE key = '${TEMPLATE_MOVE_MARKER}'`),
    'it reads the renames from the record the move writes'
  );
  assert.ok(
    earlier.includes(`DELETE FROM schema_meta WHERE key = '${TEMPLATE_MOVE_MARKER}'`),
    'and deletes that record to run the move again'
  );
  assert.ok(earlier.includes(`app_settings["${DOLLAR_SWITCH_LOG_KEY}"]`), 'it points at the old prices where the switch kept them');
});
