const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

const { loadFresh, useAdminEmails, useTempStorage } = require('./helpers');

/**
 * Whose Bid Assistant data is whose.
 *
 * The Bid Assistant was a single-user tool. v2 put it behind a sign-in and
 * gave its profiles owners, but none of its other tables: any signed-in account
 * could rename or delete anybody's saved sheet source, read every account's
 * saved answers for a job (keyed by profile id) and delete them, rewrite the
 * one Ask AI template every account uses, and delete a job off the shared
 * board together with everybody's answers for it.
 *
 * Now: a source belongs to the account that saved it, and one saved before
 * sources had owners is listed for everybody and changed only by an
 * administrator, as is one whose account was deleted, listed to administrators
 * alone; answers are read and deleted through the reader's own profiles, go
 * with the profile, and are what a job's "Answered" flag counts; the template
 * and job deletion are an administrator's. The job board itself stays shared.
 *
 * Modules are required once, not loaded fresh: the Bid Assistant's database
 * module takes its connection when it is first loaded, so this file has one
 * database and every test in it uses labels of its own.
 */

async function serve() {
  const { dbDir } = useTempStorage('bid-assistant-scoping');
  useAdminEmails('admin@example.com');

  const users = require('../dist/database/userRepository');
  const admin = users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  const bob = users.createUser({ email: 'bob@example.com' });
  const tokens = {
    admin: users.createSession(admin.id),
    alice: users.createSession(alice.id),
    bob: users.createSession(bob.id),
  };

  const { attachUser } = require('../dist/middleware/auth');
  const { publicErrorHandler } = require('../dist/middleware/publicError');
  const routes = require('../dist/routes/bidAssistant');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/bid-assistant', routes.default ?? routes);
  // The profiles page's own door into the same table, for deleting and
  // importing a profile the other way.
  app.use('/api/profiles', require('../dist/routes/profiles').default);
  app.use(publicErrorHandler);
  const server = app.listen(0);
  const port = server.address().port;

  /** Another ordinary account, signed in as `who`. Each has room for one profile. */
  const addAccount = (who) => {
    const account = users.createUser({ email: `${who}@example.com` });
    tokens[who] = users.createSession(account.id);
    return account;
  };

  // `route` under /api/bid-assistant, or a whole /api/... path.
  const call = async (who, method, route, body) => {
    const url = route.startsWith('/api/') ? route : `/api/bid-assistant${route}`;
    const response = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[who]}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: response.status, body: parsed };
  };
  return { call, addAccount, users, close: () => server.close(), dbDir, admin, alice, bob };
}

let shared = null;
async function server() {
  shared ??= await serve();
  return shared;
}
test.after(() => shared?.close());

/** A source saved before sources had owners: a row with no account. */
function insertOwnerlessSource(label, sheetId) {
  const { getDb } = require('../dist/database/sqlite');
  const now = new Date().toISOString();
  const result = getDb()
    .prepare('INSERT INTO google_sheets (label, sheet_id, sheet_gid, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(label, sheetId, '', now, now);
  return Number(result.lastInsertRowid);
}

test("a saved source is its owner's: another account neither sees it nor reaches it by id", async () => {
  const { call } = await server();

  const saved = await call('alice', 'POST', '/google-sheets', { label: 'Alice jobs', sheetId: 'shared-sheet-a' });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.canEdit, true);
  assert.equal('account_id' in saved.body, false, "the owner's id never leaves the server");
  const id = saved.body.id;

  const hers = await call('alice', 'GET', '/google-sheets');
  assert.deepEqual(
    hers.body.filter((row) => row.label === 'Alice jobs').map((row) => [row.id, row.canEdit, 'account_id' in row]),
    [[id, true, false]]
  );

  const bobs = await call('bob', 'GET', '/google-sheets');
  assert.equal(bobs.body.some((row) => row.id === id), false, 'not in his list');
  for (const [method, route, body] of [
    ['PUT', `/google-sheets/${id}`, { label: 'Renamed by Bob', sheetId: 'shared-sheet-a' }],
    ['DELETE', `/google-sheets/${id}`],
    ['GET', `/google-sheets/${id}/tabs`],
    ['POST', `/google-sheets/${id}/import`, { tabName: 'Jobs' }],
  ]) {
    const refused = await call('bob', method, route, body);
    assert.equal(refused.status, 404, `${method} ${route}`);
    assert.deepEqual(refused.body, { error: 'Google Sheet source not found.' }, `${method} ${route}`);
  }

  // Untouched, and still hers to change.
  const renamed = await call('alice', 'PUT', `/google-sheets/${id}`, { label: 'Alice jobs, renamed', sheetId: 'shared-sheet-a' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.label, 'Alice jobs, renamed');
  assert.equal(renamed.body.canEdit, true);
  // Her own import gets as far as checking what she asked for.
  const range = await call('alice', 'POST', `/google-sheets/${id}/import`, { tabName: 'Jobs', fromRow: 0 });
  assert.equal(range.status, 400);
  assert.equal((await call('alice', 'DELETE', `/google-sheets/${id}`)).status, 200);
});

test('a source saved before sources had owners is listed for everybody, and only an administrator changes it', async () => {
  const { call } = await server();
  const id = insertOwnerlessSource('Team board', 'shared-sheet-legacy');

  for (const who of ['alice', 'bob']) {
    const listed = (await call(who, 'GET', '/google-sheets')).body.find((row) => row.id === id);
    assert.ok(listed, `${who} still sees it`);
    assert.equal(listed.canEdit, false, who);
  }
  const forAdmin = (await call('admin', 'GET', '/google-sheets')).body.find((row) => row.id === id);
  assert.equal(forAdmin.canEdit, true);

  for (const [method, body] of [['PUT', { label: 'Mine now', sheetId: 'shared-sheet-legacy' }], ['DELETE']]) {
    const refused = await call('alice', method, `/google-sheets/${id}`, body);
    assert.equal(refused.status, 403, method);
    assert.match(refused.body.error, /only an administrator can change it/, method);
  }
  // Importing from it is still everybody's: past the owner check, the import
  // gets as far as validating its range, short of Google, rather than a 404.
  assert.equal((await call('bob', 'POST', `/google-sheets/${id}/import`, { tabName: 'Jobs', fromRow: 0 })).status, 400);

  const renamed = await call('admin', 'PUT', `/google-sheets/${id}`, { label: 'Team board (admin)', sheetId: 'shared-sheet-legacy' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.label, 'Team board (admin)');
  assert.equal((await call('admin', 'DELETE', `/google-sheets/${id}`)).status, 200);
  assert.equal((await call('alice', 'GET', '/google-sheets')).body.some((row) => row.id === id), false);
});

test("saved answers are read and deleted through the reader's own profiles", async () => {
  const { call } = await server();
  const bidDb = require('../dist/bidAssistant/database');
  bidDb.importJobs([{ company_name: 'Acme', job_title: 'Engineer', job_url: 'https://example.com/jobs/answers' }]);
  const job = bidDb.getJobs('Acme', '').find((row) => row.job_url === 'https://example.com/jobs/answers');

  const aliceProfile = (await call('alice', 'POST', '/profiles', { name: 'Alice' })).body;
  const bobProfile = (await call('bob', 'POST', '/profiles', { name: 'Bob' })).body;
  assert.ok(aliceProfile.id && bobProfile.id);

  // Typed answers ("MA"), so nothing reaches a model.
  const answer = (who, profileId, text) =>
    call(who, 'POST', '/ask', {
      jobId: job.id,
      focusProfileId: profileId,
      targetProfileIds: [profileId],
      questions: [{ question: 'Why us?', isManualAnswer: true, manualAnswer: text, charLimit: 200 }],
    });
  assert.equal((await answer('alice', aliceProfile.id, "Alice's answer")).status, 200);
  assert.equal((await answer('bob', bobProfile.id, "Bob's answer")).status, 200);
  // Nor can an answer be written for somebody else's profile.
  assert.equal((await answer('bob', aliceProfile.id, 'Bob, as Alice')).status, 404);

  const forBob = (await call('bob', 'GET', `/answers/${job.id}`)).body;
  assert.deepEqual(Object.keys(forBob), [bobProfile.id], "Alice's profile id and answer are not his to read");
  assert.equal(forBob[bobProfile.id][0].answer, "Bob's answer");
  const forAlice = (await call('alice', 'GET', `/answers/${job.id}`)).body;
  assert.deepEqual(Object.keys(forAlice), [aliceProfile.id]);

  const refused = await call('bob', 'DELETE', `/answers/${job.id}?profileId=${encodeURIComponent(aliceProfile.id)}&question=${encodeURIComponent('Why us?')}`);
  assert.equal(refused.status, 404);
  assert.deepEqual(refused.body, { error: 'Profile not found.' });
  assert.equal((await call('alice', 'GET', `/answers/${job.id}`)).body[aliceProfile.id][0].answer, "Alice's answer", 'it survived');

  const deleted = await call('alice', 'DELETE', `/answers/${job.id}?profileId=${encodeURIComponent(aliceProfile.id)}&question=${encodeURIComponent('Why us?')}`);
  assert.equal(deleted.status, 200);
  assert.deepEqual((await call('alice', 'GET', `/answers/${job.id}`)).body, {});
  assert.equal((await call('bob', 'GET', `/answers/${job.id}`)).body[bobProfile.id].length, 1, "Bob's is untouched");
});

test('the job board stays shared; deleting a job, and everybody\'s answers with it, is an administrator\'s', async () => {
  const { call } = await server();
  const bidDb = require('../dist/bidAssistant/database');
  bidDb.importJobs([{ company_name: 'Globex', job_title: 'Designer', job_url: 'https://example.com/jobs/delete' }]);
  const job = bidDb.getJobs('Globex', '').find((row) => row.job_url === 'https://example.com/jobs/delete');

  // Shared: everybody sees it and may mark it as an error.
  for (const who of ['alice', 'bob']) {
    assert.ok((await call(who, 'GET', '/jobs?search=Globex')).body.some((row) => row.id === job.id), who);
  }
  const marked = await call('bob', 'PUT', `/jobs/${job.id}/error`, { isError: true, errorReason: 'Closed' });
  assert.equal(marked.status, 200);

  const refused = await call('alice', 'DELETE', `/jobs/${job.id}`);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'not-an-admin');
  assert.ok(bidDb.getJobById(job.id), 'still on the board');

  assert.equal((await call('admin', 'DELETE', `/jobs/${job.id}`)).status, 200);
  assert.equal(bidDb.getJobById(job.id), null);
});

/** Imports one job with a URL of its own and returns its row. */
function importJob(company, url) {
  const bidDb = require('../dist/bidAssistant/database');
  bidDb.importJobs([{ company_name: company, job_title: 'Engineer', job_url: url }]);
  return bidDb.getJobs(company, '').find((row) => row.job_url === url);
}

/** A typed ("MA") answer, so nothing reaches a model. */
function answerAs(call, who, jobId, profileId, text) {
  return call(who, 'POST', '/ask', {
    jobId,
    focusProfileId: profileId,
    targetProfileIds: [profileId],
    questions: [{ question: 'Why us?', isManualAnswer: true, manualAnswer: text, charLimit: 200 }],
  });
}

function answerRowsFor(profileId) {
  const { getDb } = require('../dist/database/sqlite');
  return getDb().prepare('SELECT COUNT(*) AS n FROM answers WHERE profile_id = ?').get(profileId).n;
}

test("a profile's answers go with it, so an account that takes its id later reads none of them", async () => {
  // Answers are keyed by profile id alone, and an id comes back: the Bid
  // Assistant creates a profile with the id the client chose, and an import
  // keeps any free one. They used to outlive the profile, and whoever took
  // the id next read - and could delete - them as their own.
  const { call, addAccount } = await server();
  for (const who of ['carol', 'dave', 'erin']) addAccount(who);
  const job = importJob('Initech', 'https://example.com/jobs/reused-id');

  // Through the Bid Assistant's own profile delete.
  assert.equal((await call('carol', 'POST', '/profiles', { id: 'reused-profile-id', name: 'Carol' })).status, 200);
  assert.equal((await answerAs(call, 'carol', job.id, 'reused-profile-id', "Carol's answer")).status, 200);
  assert.equal((await call('carol', 'DELETE', '/profiles/reused-profile-id')).status, 200);
  assert.equal(answerRowsFor('reused-profile-id'), 0, 'deleted with the profile');

  assert.equal((await call('dave', 'POST', '/profiles', { id: 'reused-profile-id', name: 'Dave' })).status, 200);
  assert.deepEqual((await call('dave', 'GET', `/answers/${job.id}`)).body, {});

  // And through the profiles page's, then an import that keeps the id.
  assert.equal((await call('carol', 'POST', '/profiles', { id: 'imported-profile-id', name: 'Carol' })).status, 200);
  assert.equal((await answerAs(call, 'carol', job.id, 'imported-profile-id', "Carol's other answer")).status, 200);
  assert.equal((await call('carol', 'DELETE', '/api/profiles/imported-profile-id')).status, 200);
  assert.equal(answerRowsFor('imported-profile-id'), 0, 'deleted with the profile');

  const imported = await call('erin', 'POST', '/api/profiles/import', { id: 'imported-profile-id', name: 'Erin', summary: 'x' });
  assert.equal(imported.status, 201);
  assert.equal(imported.body.keptIds, 1, 'the id was free, so the import kept it');
  assert.deepEqual((await call('erin', 'GET', `/answers/${job.id}`)).body, {});
});

test('answers an earlier build left behind a deleted profile are swept when the Bid Assistant loads', async () => {
  const { call, addAccount } = await server();
  addAccount('frank');
  const job = importJob('Hooli', 'https://example.com/jobs/orphans');
  const kept = (await call('frank', 'POST', '/profiles', { name: 'Frank' })).body;
  assert.equal((await answerAs(call, 'frank', job.id, kept.id, "Frank's answer")).status, 200);

  const { getDb } = require('../dist/database/sqlite');
  getDb()
    .prepare('INSERT INTO answers (job_id, profile_id, question, answer, char_limit, question_order, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(job.id, 'profile-deleted-long-ago', 'Why us?', 'Left behind', 200, 0, new Date().toISOString());

  const realLog = console.log;
  const logged = [];
  console.log = (...args) => logged.push(args.join(' '));
  try {
    loadFresh('../dist/bidAssistant/database');
  } finally {
    console.log = realLog;
  }
  assert.equal(answerRowsFor('profile-deleted-long-ago'), 0);
  assert.equal(answerRowsFor(kept.id), 1, "a live profile's answer stays");
  assert.ok(logged.some((line) => /Removed 1 saved answer\(s\) whose profile no longer exists/.test(line)), logged.join('\n'));
});

test("a job reads as answered only to an account that answered it, on the board and from Set Error", async () => {
  // The board is shared and the answers are not: counted over everybody's,
  // the flag marked a job "Answered" for an account with nothing on it, and
  // told it which jobs other accounts had answered.
  const { call, addAccount } = await server();
  addAccount('gina');
  addAccount('hugo');
  const job = importJob('Vandelay', 'https://example.com/jobs/answered-flag');
  const profile = (await call('gina', 'POST', '/profiles', { name: 'Gina' })).body;
  assert.equal((await answerAs(call, 'gina', job.id, profile.id, "Gina's answer")).status, 200);

  const flagFor = async (who) =>
    (await call(who, 'GET', '/jobs?search=Vandelay')).body.find((row) => row.id === job.id).has_answers;
  assert.equal(await flagFor('gina'), true);
  assert.equal(await flagFor('hugo'), false);
  assert.equal(await flagFor('admin'), false, 'an administrator is a reader like any other here');

  const markedByHugo = await call('hugo', 'PUT', `/jobs/${job.id}/error`, { isError: true, errorReason: 'Closed' });
  assert.equal(markedByHugo.status, 200);
  assert.equal(markedByHugo.body.has_answers, false);
  const markedByGina = await call('gina', 'PUT', `/jobs/${job.id}/error`, { isError: false });
  assert.equal(markedByGina.body.has_answers, true);
});

test("a deleted account's sources are the administrator's to see and free, and nobody else's", async () => {
  // Deleting an account leaves its sources, as it leaves its profiles. Listed
  // only to their owner, they were in nobody's list - the administrator's
  // included - while their labels, unique across the table, stayed taken.
  const { call, addAccount, users } = await server();
  const ivan = addAccount('ivan');
  const saved = await call('ivan', 'POST', '/google-sheets', { label: 'Ivan jobs', sheetId: 'shared-sheet-ivan' });
  assert.equal(saved.status, 200);
  const id = saved.body.id;
  users.deleteUser(ivan.id);

  const forAdmin = (await call('admin', 'GET', '/google-sheets')).body.find((row) => row.id === id);
  assert.ok(forAdmin, "listed for the administrator");
  assert.equal(forAdmin.canEdit, true);
  assert.equal('account_id' in forAdmin, false);
  assert.equal((await call('alice', 'GET', '/google-sheets')).body.some((row) => row.id === id), false, 'and for nobody else');
  assert.equal((await call('alice', 'DELETE', `/google-sheets/${id}`)).status, 404);

  // Its label is still taken until the administrator frees it.
  assert.equal((await call('alice', 'POST', '/google-sheets', { label: 'Ivan jobs', sheetId: 'shared-sheet-alice' })).status, 409);
  assert.equal((await call('admin', 'DELETE', `/google-sheets/${id}`)).status, 200);
  const reused = await call('alice', 'POST', '/google-sheets', { label: 'Ivan jobs', sheetId: 'shared-sheet-alice' });
  assert.equal(reused.status, 200);
  assert.equal((await call('alice', 'DELETE', `/google-sheets/${reused.body.id}`)).status, 200);
});
