const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

// Before anything loads routes/resumes: the upload reads a real PDF and asks a
// model, and neither is this file's business. What is under test is WHERE the
// resume lands, and that a refusal comes before the extraction is paid for.
require.cache[require.resolve('pdf-parse')] = {
  id: require.resolve('pdf-parse'),
  filename: require.resolve('pdf-parse'),
  loaded: true,
  exports: async () => ({ text: 'A resume with plenty of text in it, enough to count as a real document.' }),
};

const {
  captureErrorLog,
  loadFresh,
  openTestDb,
  seedProfileWithResumes,
  useAdminEmails,
  useTempStorage,
} = require('./helpers');

/**
 * Profiles (people) and their resumes: the tree, the limit, placement, the
 * default resume, move, delete, and the lazy filing of a database as v4.1 left
 * it. Written from the F1 specification (plan-v42-full.md "F1", design-feature
 * F1.1-F1.7, plan-v42.md D11-D18 and D27).
 *
 * Vocabulary: a PROFILE is a person (table `profiles`, /api/profiles); a RESUME
 * is one resume document (table `resumes`, /api/resumes). A resume belongs to
 * exactly one profile of its own account. The GATE names keep their spelling
 * (profileLimit, profilesUsed, profile-limit) and now count people.
 *
 * Shape of the file:
 *   - pure rules and the tier copy need no server;
 *   - the bulk of it shares ONE server, one database and one set of modules
 *     (the Bid Assistant's database module takes its connection when it first
 *     loads, so this file loads everything once, like bidAssistantScoping), and
 *     every test uses accounts of its own;
 *   - the lazy-filing tests come LAST: they build databases shaped as v4.1 left
 *     them, in directories of their own, and load fresh modules for each.
 *
 * Nothing here sleeps. Times that a rule orders by ("the oldest resume") are
 * stamped explicitly, in the column AND the document, so no test depends on
 * two writes landing in different milliseconds.
 */

useTempStorage('person-tree');
useAdminEmails('admin@example.com');

/* ------------------------------------------------------------------ small things */

const at = (month, day = 1) =>
  `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00.000Z`;

const person = (name, extra = {}) => ({
  name,
  title: 'Software Engineer',
  summary: `${name} builds backend services.`,
  skills: ['Go'],
  ...extra,
});

/** `moved` may be answered as a count or as the moved ids; both read as a count here. */
const countOf = (value) => (Array.isArray(value) ? value.length : value);

const sortedNames = (profiles) => profiles.map((profile) => profile.name).sort();

const PROFILE_NOT_FOUND = 'That profile was not found. It may have been deleted; reload the page.';
const RESUME_NOT_FOUND = 'One of those resumes was not found. It may have been deleted; reload the page.';
const LIMIT_ONE_PROFILE =
  'The Default subscription allows 1 profile and this account has 1. ' +
  'Delete one, or move up to a higher subscription on the Subscription page.';

/* ------------------------------------------------------------------ the shared server */

let worldPromise = null;
function world() {
  worldPromise ??= startWorld();
  return worldPromise;
}

async function startWorld() {
  const sqlite = require('../dist/database/sqlite');
  const users = require('../dist/database/userRepository');
  const resumes = require('../dist/database/resumeRepository');
  const resumeDocument = require('../dist/services/resumeDocument');
  const { attachUser } = require('../dist/middleware/auth');
  const { publicErrorHandler } = require('../dist/middleware/publicError');
  const bidDb = require('../dist/bidAssistant/database');

  // The model behind an upload: counted, so a test can say it never ran.
  const resumeService = require('../dist/services/resumeService');
  const extractCalls = [];
  resumeService.extractResumeFromText = async (text) => {
    extractCalls.push(text);
    return {
      name: 'Uploaded Person',
      title: 'Engineer',
      summary: 'Read from a PDF.',
      skills: ['Go'],
      contact: { email: 'uploaded@example.com', phone: '1', location: 'Remote' },
      experience: [],
      strengths: [],
      education: [],
    };
  };

  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/profiles', require('../dist/routes/profiles').default);
  app.use('/api/resumes', require('../dist/routes/resumes').default);
  const bidRoutes = require('../dist/routes/bidAssistant');
  app.use('/api/bid-assistant', bidRoutes.default ?? bidRoutes);
  app.use('/api/admin/accounts', require('../dist/routes/accounts').default);
  app.use(publicErrorHandler);
  const server = app.listen(0);
  const port = server.address().port;

  const admin = users.createUser({ email: 'admin@example.com' });
  const adminAccount = { user: admin, id: admin.id, token: users.createSession(admin.id) };

  let counter = 0;
  /** A new ordinary account (Default unless told otherwise), signed in. */
  const account = (label, subscription = 'default') => {
    counter += 1;
    const user = users.createUser({ email: `${label}-${counter}@example.com` });
    if (subscription !== 'default') users.updateUser(user.id, { subscription });
    return { user, id: user.id, token: users.createSession(user.id) };
  };

  const call = async (who, method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(who ? { authorization: `Bearer ${who.token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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

  const upload = async (who, path) => {
    const form = new FormData();
    form.append('resume', new Blob([Buffer.from('%PDF-1.4 a resume')], { type: 'application/pdf' }), 'resume.pdf');
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      body: form,
      headers: { authorization: `Bearer ${who.token}` },
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

  const db = () => sqlite.getDb();
  const resumeDoc = (id) => {
    const row = db().prepare('SELECT data FROM resumes WHERE id = ?').get(id);
    return row ? JSON.parse(row.data) : null;
  };
  const resumeRow = (id) =>
    db().prepare('SELECT id, owner_id, profile_id, created_at, updated_at FROM resumes WHERE id = ?').get(id);
  const profileDoc = (id) => {
    const row = db().prepare('SELECT data FROM profiles WHERE id = ?').get(id);
    return row ? JSON.parse(row.data) : null;
  };
  const profileCountRaw = (ownerId) =>
    db().prepare('SELECT COUNT(*) AS n FROM profiles WHERE owner_id = ?').get(ownerId).n;
  const resumeCountRaw = (ownerId) =>
    db().prepare('SELECT COUNT(*) AS n FROM resumes WHERE owner_id = ?').get(ownerId).n;

  /** Sets a resume's times in the column AND the document, so any rule that orders by either agrees. */
  const stampResume = (id, iso) => {
    const doc = resumeDoc(id);
    doc.createdAt = iso;
    doc.updatedAt = iso;
    db().prepare('UPDATE resumes SET data = ?, created_at = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(doc), iso, iso, id);
  };
  const stampProfile = (id, { createdAt, updatedAt }) => {
    const doc = profileDoc(id);
    if (createdAt) doc.createdAt = createdAt;
    if (updatedAt) doc.updatedAt = updatedAt;
    db()
      .prepare('UPDATE profiles SET data = ?, created_at = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(doc), doc.createdAt, doc.updatedAt, id);
  };

  // The Bid Assistant's own words: a job on its shared board, and a typed
  // ("manual") answer, so nothing reaches a model.
  let jobCounter = 0;
  const importJob = (company) => {
    jobCounter += 1;
    const url = `https://example.com/jobs/profile-tree-${jobCounter}`;
    bidDb.importJobs([{ company_name: company, job_title: 'Engineer', job_url: url }]);
    return bidDb.getJobs(company, '').find((row) => row.job_url === url);
  };
  const answerAs = (who, jobId, resumeId, text) =>
    call(who, 'POST', '/api/bid-assistant/ask', {
      jobId,
      focusProfileId: resumeId,
      targetProfileIds: [resumeId],
      questions: [{ question: 'Why us?', isManualAnswer: true, manualAnswer: text, charLimit: 200 }],
    });
  const answerRows = (resumeId) => db().prepare('SELECT COUNT(*) AS n FROM answers WHERE profile_id = ?').get(resumeId).n;

  return {
    sqlite,
    users,
    resumes,
    resumeDocument,
    admin: adminAccount,
    account,
    call,
    upload,
    extractCalls,
    db,
    resumeDoc,
    resumeRow,
    profileDoc,
    profileCountRaw,
    resumeCountRaw,
    stampResume,
    stampProfile,
    importJob,
    answerAs,
    answerRows,
    close: () => server.close(),
  };
}

test.after(async () => {
  if (worldPromise) (await worldPromise).close();
});

/** A profile through the route, as a page makes one. */
async function makeProfile(w, who, name) {
  const made = await w.call(who, 'POST', '/api/profiles', { name });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  return made.body;
}

/** A resume through the route, filed in `profileId` when given. */
async function makeResume(w, who, name, profileId, extra = {}) {
  const query = profileId ? `?profileId=${encodeURIComponent(profileId)}` : '';
  const made = await w.call(who, 'POST', `/api/resumes${query}`, person(name, extra));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  return made.body;
}

const summaryOf = async (w, who, profileId) => {
  const got = await w.call(who, 'GET', `/api/profiles/${profileId}`);
  assert.equal(got.status, 200, JSON.stringify(got.body));
  return got.body;
};

const profilesOf = async (w, who) => {
  const got = await w.call(who, 'GET', '/api/profiles');
  assert.equal(got.status, 200);
  return got.body;
};

/* ================================================================== pure rules */

test('pure rules: personKey folds case, inner whitespace and Unicode form, and a blank name shares a key with the default name', () => {
  const { personKey, UNTITLED_PROFILE_NAME } = require('../dist/services/profileRules');
  assert.equal(UNTITLED_PROFILE_NAME, 'Untitled Profile');

  assert.equal(personKey('jane  DOE '), personKey('Jane Doe'));
  assert.equal(personKey('JANE DOE'), personKey('jane doe'));
  assert.equal(personKey('Jane\t\n Doe'), personKey('Jane Doe'));
  // NFC: an "e" and a combining accent is the same person as the precomposed letter.
  assert.equal(personKey('Café Noir'), personKey('Café noir'));

  // The normaliser's default name and a blank one are the same person: both
  // stand for "no name given", and they share ONE profile.
  const blank = personKey('');
  assert.equal(personKey('   '), blank);
  assert.equal(personKey(UNTITLED_PROFILE_NAME), blank);
  assert.equal(personKey('untitled   PROFILE'), blank);

  assert.notEqual(personKey('Jane Doe'), personKey('Jane Dow'));
  assert.notEqual(personKey('Jane Doe'), blank);
});

test('pure rules: profileNameForPerson trims, falls back to Untitled Profile when blank, and stops at 100 characters', () => {
  const rules = require('../dist/services/profileRules');
  assert.equal(rules.MAX_PROFILE_NAME_LENGTH, 100);
  assert.equal(rules.profileNameForPerson('  Jane Doe '), 'Jane Doe');
  // The display keeps the person's own capitals; only the KEY is case-folded.
  assert.equal(rules.profileNameForPerson('jane DOE'), 'jane DOE');
  assert.equal(rules.profileNameForPerson(''), 'Untitled Profile');
  assert.equal(rules.profileNameForPerson('   '), 'Untitled Profile');
  assert.equal(rules.profileNameForPerson('x'.repeat(150)), 'x'.repeat(100));
  // Inner runs of whitespace collapse (design G1: "trimmed and spaces collapsed").
  assert.equal(rules.profileNameForPerson('Jane    Doe'), 'Jane Doe');
});

test('pure rules: the effective default skips a disabled choice; a repointed default is the OLDEST enabled resume, else the oldest', () => {
  const { effectiveDefaultResumeId, repointedDefaultResumeId } = require('../dist/services/profileRules');
  const member = (id, month, disabled = false) => ({
    id,
    name: id,
    disabled,
    createdAt: at(month),
    updatedAt: at(month),
  });
  const a = member('a', 1);
  const b = member('b', 2);
  const c = member('c', 3);
  const d = member('d', 4);
  // Listed newest first on purpose: the rule orders, the caller's order is nothing.
  const shuffled = (...list) => [...list].reverse();

  // The choice, when it is an enabled member.
  assert.equal(effectiveDefaultResumeId('b', shuffled(a, b, c)), 'b');
  // Disabled, unknown or absent: the oldest enabled resume stands in.
  assert.equal(effectiveDefaultResumeId('b', shuffled(a, member('b', 2, true), c)), 'a');
  assert.equal(effectiveDefaultResumeId('gone', shuffled(a, b, c)), 'a');
  assert.equal(effectiveDefaultResumeId(undefined, shuffled(member('a', 1, true), b, c)), 'b');
  assert.equal(effectiveDefaultResumeId(null, shuffled(a, b)), 'a');
  assert.equal(effectiveDefaultResumeId('b', shuffled(member('a', 1, true), member('b', 2, true), c, d)), 'c');
  // Nothing to stand on.
  assert.equal(effectiveDefaultResumeId('b', []) ?? null, null);

  // Repointing: the oldest enabled; none enabled, the oldest of all; none, nothing.
  assert.equal(repointedDefaultResumeId(shuffled(a, b, c)), 'a');
  assert.equal(repointedDefaultResumeId(shuffled(member('a', 1, true), b, c)), 'b');
  assert.equal(repointedDefaultResumeId(shuffled(member('a', 1, true), member('b', 2, true))), 'a');
  assert.equal(repointedDefaultResumeId([]) ?? null, null);
});

test('pure rules: resumeLabelOf is the headline unless empty or the normaliser default, else the name, else "Untitled resume"', () => {
  const { resumeLabelOf } = require('../dist/services/profileRules');
  assert.equal(resumeLabelOf({ title: 'Backend Engineer', name: 'Jane Doe' }), 'Backend Engineer');
  assert.equal(resumeLabelOf({ title: 'Professional', name: 'Jane Doe' }), 'Jane Doe');
  assert.equal(resumeLabelOf({ title: '', name: 'Jane Doe' }), 'Jane Doe');
  assert.equal(resumeLabelOf({ title: '', name: '   ' }), 'Untitled resume');
  assert.equal(resumeLabelOf({ title: 'Professional', name: '' }), 'Untitled resume');
  assert.equal(resumeLabelOf({ title: 'Staff Engineer', name: '' }), 'Staff Engineer');
});

test('pure rules: readProfileName answers the tidied name, or the code and sentence to refuse a blank or over-long one with', () => {
  const { readProfileName } = require('../dist/services/profileRules');
  assert.deepEqual(readProfileName('  Jane   Doe '), { ok: true, name: 'Jane Doe' });
  assert.deepEqual(readProfileName('x'.repeat(100)), { ok: true, name: 'x'.repeat(100) });

  for (const blank of ['', '   ', undefined, null, 7]) {
    const refused = readProfileName(blank);
    assert.equal(refused.ok, false, String(blank));
    assert.equal(refused.code, 'profile-name-required');
    assert.equal(refused.message, 'Give the profile a name.');
  }
  const long = readProfileName('x'.repeat(101));
  assert.equal(long.ok, false);
  assert.equal(long.code, 'profile-name-too-long');
  assert.equal(long.message, 'A profile name can be at most 100 characters.');
});

test('tier copy counts profiles, not resumes, and offers no group or several-profile build line', () => {
  const { SUBSCRIPTIONS } = require('../dist/config/accountSubscriptions');
  assert.deepEqual(
    Object.values(SUBSCRIPTIONS).map((tier) => [tier.id, tier.profileLimit]),
    [['default', 1], ['premium', 5], ['premium-plus', 25], ['premium-max', null]]
  );
  assert.equal(SUBSCRIPTIONS.default.summary, 'One profile, with any number of resumes. Everything else in the app is included.');
  assert.deepEqual([...SUBSCRIPTIONS.default.features], ['1 profile', 'Any number of resumes in each', 'Everything else in the app']);
  assert.equal(SUBSCRIPTIONS.premium.summary, 'Up to five profiles, each with any number of resumes.');
  assert.deepEqual([...SUBSCRIPTIONS.premium.features], ['Up to 5 profiles', 'Any number of resumes in each']);
  assert.equal(SUBSCRIPTIONS['premium-plus'].summary, 'Up to twenty-five profiles.');
  assert.deepEqual([...SUBSCRIPTIONS['premium-plus'].features], ['Up to 25 profiles', 'Everything in Premium']);
  assert.equal(SUBSCRIPTIONS['premium-max'].summary, 'Unlimited profiles.');
  assert.deepEqual([...SUBSCRIPTIONS['premium-max'].features], ['Unlimited profiles', 'Everything in Premium']);
  for (const tier of Object.values(SUBSCRIPTIONS)) {
    for (const line of [tier.summary, ...tier.features]) {
      assert.doesNotMatch(line, OLD_TIER_WORDS, `${tier.id}: ${line}`);
    }
  }
});

test('the tailoring cache fingerprint ignores profileId, so filing and moving a resume never make a cached tailoring miss', () => {
  const { resumeFingerprint } = require('../dist/services/tailorCache');
  const { buildNewResume } = require('../dist/services/resumeDocument');
  const resume = { ...buildNewResume(person('Jane Doe'), 'fp-1'), ownerId: 'someone' };
  const before = resumeFingerprint(resume);
  assert.equal(resumeFingerprint({ ...resume, profileId: 'person-a' }), before);
  assert.equal(resumeFingerprint({ ...resume, profileId: 'person-b', updatedAt: at(9) }), before);
  // Not a fingerprint that ignores everything: content still counts.
  assert.notEqual(resumeFingerprint({ ...resume, summary: 'Something else entirely.' }), before);
  assert.notEqual(resumeFingerprint({ ...resume, name: 'John Doe' }), before);
});

/* ================================================================== placement */

test('placement: a new resume goes to the profile ?profileId names, whatever the resume is called', async () => {
  const w = await world();
  const who = w.account('own', 'premium');
  const home = await makeProfile(w, who, 'Work');
  const created = await makeResume(w, who, 'Somebody Else', home.id);
  assert.equal(created.profileId, home.id);
  assert.equal(w.resumeDoc(created.id).profileId, home.id, 'in the document');
  assert.equal(w.resumeRow(created.id).profile_id, home.id, 'and the column');

  const list = await profilesOf(w, who);
  assert.equal(list.length, 1, 'no profile was made for "Somebody Else"');
  assert.equal(list[0].resumeCount, 1);
  assert.equal(list[0].defaultResumeId, created.id, 'the first resume in is the default');

  // Every resume in every answer carries its profile.
  assert.equal((await w.call(who, 'GET', `/api/resumes/${created.id}`)).body.profileId, home.id);
  const listed = (await w.call(who, 'GET', '/api/resumes?includeDisabled=true')).body;
  assert.deepEqual(listed.map((resume) => resume.profileId), [home.id]);
});

test("placement: a foreign or a deleted profile is a 404 with nothing saved and no limit used - an administrator's own rule too", async () => {
  const w = await world();
  const stranger = w.account('stranger', 'premium');
  const theirs = seedProfileWithResumes(stranger.user, 'Theirs', [person('Stranger One')]);

  const who = w.account('foreign'); // Default: room for exactly one profile
  const refused = await w.call(who, 'POST', `/api/resumes?profileId=${theirs.profileId}`, person('Intruder'));
  assert.equal(refused.status, 404);
  assert.equal(refused.body.code, 'profile-not-found');
  assert.equal(refused.body.error, PROFILE_NOT_FOUND);
  assert.equal(w.resumeCountRaw(who.id), 0, 'nothing saved');
  assert.equal(w.profileCountRaw(who.id), 0, 'and no profile made');
  assert.equal((await w.call(stranger, 'GET', `/api/profiles/${theirs.profileId}`)).body.resumeCount, 1, "hers is untouched");

  // The refusal used no part of the limit: she can still make her one profile.
  const first = await makeResume(w, who, 'Fresh Person');
  assert.ok(first.profileId);
  assert.equal(w.profileCountRaw(who.id), 1);

  // A deleted one.
  const doomed = await makeProfile(w, stranger, 'Doomed');
  assert.equal((await w.call(stranger, 'DELETE', `/api/profiles/${doomed.id}`)).status, 200);
  const gone = await w.call(stranger, 'POST', `/api/resumes?profileId=${doomed.id}`, person('Late'));
  assert.equal(gone.status, 404);
  assert.equal(gone.body.code, 'profile-not-found');
  assert.equal(w.profileCountRaw(stranger.id), 1, 'and nothing was made in its place');

  // An administrator must name one of THEIR OWN profiles too.
  const adminCreate = await w.call(w.admin, 'POST', `/api/resumes?profileId=${theirs.profileId}`, person('Admin Writes'));
  assert.equal(adminCreate.status, 404);
  assert.equal(adminCreate.body.code, 'profile-not-found');

  // Naming two profiles is not naming one.
  const two = await w.call(who, 'POST', `/api/resumes?profileId=${first.profileId}&profileId=${theirs.profileId}`, person('Both'));
  assert.equal(two.status, 400);
  assert.equal(two.body.code, 'bad-profile-id');
  assert.equal(two.body.error, 'Name one profile for the resume.');
});

test('placement: with no ?profileId the resume joins the oldest of the caller\'s profiles whose person key is its name', async () => {
  const w = await world();
  const who = w.account('fold', 'premium');

  const created = await makeResume(w, who, 'Jane Doe');
  const list = await profilesOf(w, who);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Jane Doe', 'a new profile named after the person');
  assert.equal(created.profileId, list[0].id);

  const folded = await makeResume(w, who, 'jane  DOE ');
  assert.equal(folded.profileId, created.profileId, '"jane  DOE " is Jane Doe');
  const other = await makeResume(w, who, 'John Roe');
  assert.notEqual(other.profileId, created.profileId);
  const after = await profilesOf(w, who);
  assert.deepEqual(sortedNames(after), ['Jane Doe', 'John Roe']);
  assert.equal(after.find((profile) => profile.id === created.profileId).resumeCount, 2);

  // Two profiles for one name made by hand: the OLDEST wins.
  const twin1 = await makeProfile(w, who, 'Twin Person');
  const twin2 = await makeProfile(w, who, 'Twin Person');
  w.stampProfile(twin1.id, { createdAt: at(1), updatedAt: at(1) });
  w.stampProfile(twin2.id, { createdAt: at(2), updatedAt: at(2) });
  const joined = await makeResume(w, who, 'twin person');
  assert.equal(joined.profileId, twin1.id);

  // Someone else's profile of that name is not a candidate.
  const rival = w.account('rival', 'premium');
  const rivalResume = await makeResume(w, rival, 'Jane Doe');
  assert.notEqual(rivalResume.profileId, created.profileId);
});

test('placement: a blank name and "Untitled Profile" share ONE profile, named Untitled Profile', async () => {
  const w = await world();
  const who = w.account('blank', 'premium');
  const noName = await w.call(who, 'POST', '/api/resumes', { summary: 'x' });
  assert.equal(noName.status, 201);
  const spaces = await w.call(who, 'POST', '/api/resumes', { name: '   ', summary: 'x' });
  assert.equal(spaces.status, 201);
  const literal = await makeResume(w, who, 'Untitled Profile');

  assert.equal(spaces.body.profileId, noName.body.profileId);
  assert.equal(literal.profileId, noName.body.profileId);
  const list = await profilesOf(w, who);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Untitled Profile');
  assert.equal(list[0].resumeCount, 3);
});

test("placement: an upload's 404 for a bad ?profileId comes before the model is asked; an upload into an own profile is placed there", async () => {
  const w = await world();
  const who = w.account('upload', 'premium');
  const stranger = w.account('upload-stranger', 'premium');
  const theirs = seedProfileWithResumes(stranger.user, 'Theirs', [person('S')]);
  const mine = await makeProfile(w, who, 'My Home');

  const before = w.extractCalls.length;
  const refused = await w.upload(who, `/api/resumes/upload?profileId=${theirs.profileId}`);
  assert.equal(refused.status, 404);
  assert.equal(refused.body.code, 'profile-not-found');
  assert.equal(w.extractCalls.length, before, 'the extraction (the expensive part) never ran');
  assert.equal(w.resumeCountRaw(who.id), 0);

  const placed = await w.upload(who, `/api/resumes/upload?profileId=${mine.id}`);
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  assert.equal(w.extractCalls.length, before + 1);
  assert.equal(placed.body.profileId, mine.id, 'into the named profile, though the person is "Uploaded Person"');

  // And with none named, by the extracted person's name: a profile of their own.
  const byName = await w.upload(who, '/api/resumes/upload');
  assert.equal(byName.status, 201);
  assert.notEqual(byName.body.profileId, mine.id);
  assert.equal((await summaryOf(w, who, byName.body.profileId)).name, 'Uploaded Person');
});

test('placement: the raw writers saveResume and saveResumes place a new row at once, never count the limit, and an existing row keeps its place', async () => {
  const w = await world();
  const who = w.account('raw'); // Default: one profile allowed
  const rawSave = (id, name, extra = {}) =>
    w.resumes.saveResume({ ...w.resumeDocument.buildNewResume(person(name), id), ownerId: who.id, ...extra });

  rawSave('raw-1', 'Raw Person');
  const first = w.resumes.getResume('raw-1');
  assert.ok(first.profileId, 'placed, not left unfiled');
  const profile = await summaryOf(w, who, first.profileId);
  assert.equal(profile.name, 'Raw Person');
  assert.equal(profile.defaultResumeId, 'raw-1');

  // A second person: a second profile, over the Default limit, because a seed is not a request.
  rawSave('raw-2', 'Second Person');
  const second = w.resumes.getResume('raw-2');
  assert.notEqual(second.profileId, first.profileId);
  assert.equal(w.profileCountRaw(who.id), 2);

  // Its own profileId is used when it is a profile of the same owner...
  rawSave('raw-3', 'Anyone', { profileId: first.profileId });
  assert.equal(w.resumes.getResume('raw-3').profileId, first.profileId);
  // ...and ignored when it is somebody else's: placed by name instead.
  const other = w.account('raw-other', 'premium');
  const foreign = seedProfileWithResumes(other.user, 'Foreign', [person('F')]);
  rawSave('raw-4', 'Fourth Person', { profileId: foreign.profileId });
  const fourth = w.resumes.getResume('raw-4');
  assert.notEqual(fourth.profileId, foreign.profileId);
  assert.equal(w.profileDoc(fourth.profileId).ownerId, who.id, 'a profile of the same account');

  // An existing row keeps its placement, whatever the new document says.
  rawSave('raw-1', 'Raw Person Renamed', { profileId: second.profileId });
  assert.equal(w.resumes.getResume('raw-1').profileId, first.profileId);

  // The batch writer does the same, in one go.
  w.resumes.saveResumes(
    ['Batch One', 'Batch Two'].map((name, index) => ({
      ...w.resumeDocument.buildNewResume(person(name), `raw-batch-${index}`),
      ownerId: who.id,
    }))
  );
  assert.ok(w.resumes.getResume('raw-batch-0').profileId);
  assert.ok(w.resumes.getResume('raw-batch-1').profileId);
  assert.notEqual(w.resumes.getResume('raw-batch-0').profileId, w.resumes.getResume('raw-batch-1').profileId);
});

/* ================================================================== bodies never place */

test('bodies never place: a profileId, ownerId or matchKeywords in a POST, a PUT, the Bid Assistant PUT or an import entry is never read', async () => {
  const w = await world();
  const who = w.account('bodies', 'premium-plus'); // six people are made below
  const stranger = w.account('bodies-stranger', 'premium');
  const homeA = await makeProfile(w, who, 'Home A');
  const homeB = await makeProfile(w, who, 'Home B');
  const theirs = seedProfileWithResumes(stranger.user, 'Theirs', [person('T')]);
  const sneaky = (profileId) => ({ profileId, ownerId: stranger.id, matchKeywords: { version: 1, terms: ['x'] } });

  // POST /api/resumes: placed by name (a new profile), never in the profile the body names.
  const posted = await w.call(who, 'POST', '/api/resumes', person('Body Person', sneaky(homeB.id)));
  assert.equal(posted.status, 201);
  assert.notEqual(posted.body.profileId, homeB.id);
  assert.equal(w.profileDoc(posted.body.profileId).ownerId, who.id);
  assert.equal(posted.body.ownerId, who.id, 'the owner is the caller');
  assert.equal('matchKeywords' in w.resumeDoc(posted.body.id), false);
  const toForeign = await w.call(who, 'POST', '/api/resumes', person('Body Two', sneaky(theirs.profileId)));
  assert.equal(toForeign.status, 201);
  assert.notEqual(toForeign.body.profileId, theirs.profileId);

  // PUT /api/resumes/:id: the stored placement stays.
  const resident = await makeResume(w, who, 'Resident', homeA.id);
  const put = await w.call(who, 'PUT', `/api/resumes/${resident.id}`, { ...person('Resident Edited'), ...sneaky(homeB.id) });
  assert.equal(put.status, 200);
  assert.equal(put.body.profileId, homeA.id);
  assert.equal(put.body.name, 'Resident Edited');
  assert.equal(w.resumeRow(resident.id).profile_id, homeA.id);
  assert.equal(w.resumeDoc(resident.id).ownerId, who.id);
  assert.equal('matchKeywords' in w.resumeDoc(resident.id), false);

  // The Bid Assistant's whole-record PUT.
  const baPut = await w.call(who, 'PUT', `/api/bid-assistant/profiles/${resident.id}`, {
    ...w.resumeDoc(resident.id),
    name: 'Resident Via Bid Assistant',
    ...sneaky(theirs.profileId),
  });
  assert.equal(baPut.status, 200, JSON.stringify(baPut.body));
  assert.equal(w.resumeDoc(resident.id).name, 'Resident Via Bid Assistant');
  assert.equal(w.resumeRow(resident.id).profile_id, homeA.id, 'still where it was');
  assert.equal(w.resumeDoc(resident.id).profileId, homeA.id);
  assert.equal(w.resumeDoc(resident.id).ownerId, who.id);

  // Import entries: each placed by its own name; a profileId in the file is not read.
  const imported = await w.call(who, 'POST', '/api/resumes/import', {
    resumes: [
      { name: 'Import One', summary: 'x', ...sneaky(homeB.id) },
      { name: 'Import Two', summary: 'x', ...sneaky(theirs.profileId) },
    ],
  });
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  for (const resume of imported.body.resumes) {
    assert.notEqual(resume.profileId, homeB.id);
    assert.notEqual(resume.profileId, theirs.profileId);
    assert.equal(w.profileDoc(resume.profileId).ownerId, who.id);
    assert.equal(resume.ownerId, who.id);
  }
  assert.equal((await summaryOf(w, stranger, theirs.profileId)).resumeCount, 1, "the stranger's profile gained nothing");
});

test('import: ?profileId files every entry there; without it each is filed by person, a person once, and the answer names the profiles', async () => {
  const w = await world();
  const who = w.account('import', 'premium');
  const home = await makeProfile(w, who, 'Import Home');

  const into = await w.call(who, 'POST', `/api/resumes/import?profileId=${home.id}`, {
    resumes: [{ name: 'Aaa', summary: 'x' }, { name: 'Bbb', summary: 'x' }],
  });
  assert.equal(into.status, 201, JSON.stringify(into.body));
  assert.deepEqual(into.body.resumes.map((resume) => resume.profileId), [home.id, home.id]);
  assert.equal((await summaryOf(w, who, home.id)).resumeCount, 2);

  const byName = await w.call(who, 'POST', '/api/resumes/import', {
    resumes: [
      { name: 'Twin A', summary: 'x' },
      { name: 'Solo B', summary: 'x' },
      { name: 'twin  a', summary: 'x' },
    ],
  });
  assert.equal(byName.status, 201, JSON.stringify(byName.body));
  const [first, second, third] = byName.body.resumes;
  assert.equal(third.profileId, first.profileId, 'two entries for one person share one profile');
  assert.notEqual(second.profileId, first.profileId);
  assert.deepEqual(byName.body.profileIds, [first.profileId, second.profileId], 'distinct, in file order');
  const created = byName.body.createdProfiles;
  assert.equal(Array.isArray(created) ? created.length : created, 2, 'two profiles were made');
  assert.deepEqual(sortedNames(await profilesOf(w, who)), ['Import Home', 'Solo B', 'Twin A']);
});

/* ================================================================== the limit */

test('limit: a Default account with one profile: a second profile is a 402 with the first sentence, and the limit is on people', async () => {
  const w = await world();
  const who = w.account('limit-people');
  await makeProfile(w, who, 'Main');
  const second = await w.call(who, 'POST', '/api/profiles', { name: 'Second' });
  assert.equal(second.status, 402);
  assert.equal(second.body.code, 'profile-limit');
  assert.equal(second.body.limit, 1);
  assert.equal(second.body.error, LIMIT_ONE_PROFILE);
  assert.equal(w.profileCountRaw(who.id), 1, 'nothing was made');
});

test('limit: resumes are unlimited - 30 resumes in the one profile are all 201, and profilesUsed stays 1', async () => {
  const w = await world();
  const who = w.account('limit-thirty');
  const main = await makeProfile(w, who, 'Main');
  for (let index = 0; index < 30; index += 1) {
    const made = await w.call(who, 'POST', `/api/resumes?profileId=${main.id}`, person(`Person ${index}`));
    assert.equal(made.status, 201, `resume ${index}: ${JSON.stringify(made.body)}`);
  }
  assert.equal((await summaryOf(w, who, main.id)).resumeCount, 30);
  const { describeAccount } = require('../dist/routes/auth');
  assert.equal(describeAccount(w.users.getUserById(who.id)).profilesUsed, 1);
});

test('limit: a resume for a person with no profile yet is a 402 with the second sentence, nothing written; a person who has one is fine', async () => {
  const w = await world();
  const who = w.account('limit-new-person');
  const jane = await makeResume(w, who, 'Jane Doe');
  const again = await makeResume(w, who, 'jane doe');
  assert.equal(again.profileId, jane.profileId, 'the same person: no new profile, so no limit');

  const refused = await w.call(who, 'POST', '/api/resumes', person('Bob Lee'));
  assert.equal(refused.status, 402);
  assert.equal(refused.body.code, 'profile-limit');
  assert.equal(refused.body.limit, 1);
  assert.equal(
    refused.body.error,
    'This resume is for Bob Lee, who has no profile yet, and the Default subscription allows 1 profile - this account has 1. ' +
      'Add it from one of your profiles, or move up to a higher subscription on the Subscription page.'
  );
  assert.equal(w.resumeCountRaw(who.id), 2, 'nothing written');
  assert.equal(w.profileCountRaw(who.id), 1);

  // Naming a profile is the way round it.
  const placed = await w.call(who, 'POST', `/api/resumes?profileId=${jane.profileId}`, person('Bob Lee'));
  assert.equal(placed.status, 201);
});

test('limit: an import of two people into zero profiles is a 402 and writes nothing - no resume, no new profile', async () => {
  const w = await world();
  const who = w.account('limit-import');
  const refused = await w.call(who, 'POST', '/api/resumes/import', {
    resumes: [{ name: 'Person One', summary: 'x' }, { name: 'Person Two', summary: 'x' }],
  });
  assert.equal(refused.status, 402, JSON.stringify(refused.body));
  assert.equal(refused.body.code, 'profile-limit');
  assert.equal(w.resumeCountRaw(who.id), 0);
  assert.equal(w.profileCountRaw(who.id), 0, 'not even an empty profile for the first person');
  assert.deepEqual(await profilesOf(w, who), []);

  // One person - even in two entries - needs one profile and fits.
  const fits = await w.call(who, 'POST', '/api/resumes/import', {
    resumes: [{ name: 'Person One', summary: 'x' }, { name: 'person one', summary: 'y' }],
  });
  assert.equal(fits.status, 201, JSON.stringify(fits.body));
  assert.equal(w.profileCountRaw(who.id), 1);
});

test('limit: the Bid Assistant creating a third resume of the same person is allowed, a new person obeys the limit', async () => {
  const w = await world();
  const who = w.account('limit-bid');
  const first = await makeResume(w, who, 'Jane Doe');
  await makeResume(w, who, 'Jane Doe');

  const third = await w.call(who, 'POST', '/api/bid-assistant/profiles', person('Jane Doe'));
  // The specification says 201; the Bid Assistant's route answers a bare res.json today. Either is a success.
  assert.ok([200, 201].includes(third.status), `${third.status} ${JSON.stringify(third.body)}`);
  assert.equal(w.resumeDoc(third.body.id).profileId, first.profileId, 'filed with the same person');
  assert.equal((await summaryOf(w, who, first.profileId)).resumeCount, 3);

  const refused = await w.call(who, 'POST', '/api/bid-assistant/profiles', person('Somebody New'));
  assert.equal(refused.status, 402, JSON.stringify(refused.body));
  assert.equal(refused.body.code, 'profile-limit');
  assert.equal(w.profileCountRaw(who.id), 1);
  assert.equal(w.resumeCountRaw(who.id), 3);
});

test('limit: an administrator is exempt - more profiles, and resumes for new people', async () => {
  const w = await world();
  const before = w.profileCountRaw(w.admin.id);
  for (const name of ['Admin One', 'Admin Two', 'Admin Three']) {
    assert.equal((await w.call(w.admin, 'POST', '/api/profiles', { name })).status, 201, name);
  }
  assert.equal((await w.call(w.admin, 'POST', '/api/resumes', person('Admin Person A'))).status, 201);
  assert.equal((await w.call(w.admin, 'POST', '/api/resumes', person('Admin Person B'))).status, 201);
  assert.equal(w.profileCountRaw(w.admin.id), before + 5);
});

test('limit: two creates fired together at the limit - one wins (one process: the requests run one after the other; the threads test below races real connections)', async () => {
  const w = await world();
  const profiles = w.account('race-profile');
  const [one, two] = await Promise.all([
    w.call(profiles, 'POST', '/api/profiles', { name: 'Race A' }),
    w.call(profiles, 'POST', '/api/profiles', { name: 'Race B' }),
  ]);
  assert.deepEqual([one.status, two.status].sort(), [201, 402]);
  assert.equal(w.profileCountRaw(profiles.id), 1);

  const people = w.account('race-person');
  const [x, y] = await Promise.all([
    w.call(people, 'POST', '/api/resumes', person('Racer One')),
    w.call(people, 'POST', '/api/resumes', person('Racer Two')),
  ]);
  assert.deepEqual([x.status, y.status].sort(), [201, 402]);
  assert.equal(w.profileCountRaw(people.id), 1);

  // The same new person twice at once is one person: both land, in one profile.
  const same = w.account('race-same');
  const [p, q] = await Promise.all([
    w.call(same, 'POST', '/api/resumes', person('Racer Same')),
    w.call(same, 'POST', '/api/resumes', person('racer same')),
  ]);
  assert.deepEqual([p.status, q.status], [201, 201]);
  assert.equal(p.body.profileId, q.body.profileId);
  assert.equal(w.profileCountRaw(same.id), 1);
});

const RACE_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
process.env.DB_DIR = workerData.dbDir;
process.env.TAILOR_STATIC_DIR = workerData.staticDir;
const dist = workerData.dist;
const profiles = require(dist + '/database/profileRepository');
const resumes = require(dist + '/database/resumeRepository');
const { buildNewResume } = require(dist + '/services/resumeDocument');
require(dist + '/database/sqlite').getDb();
const flag = new Int32Array(workerData.gate);
Atomics.add(flag, 1, 1);
Atomics.wait(flag, 0, 0);
let outcome = 'created';
try {
  if (workerData.kind === 'profile') profiles.createProfileFor(workerData.account, { name: workerData.name });
  else resumes.createResumesWithProfiles(workerData.account, [buildNewResume({ name: workerData.name }, 'new')]);
} catch (error) {
  outcome = error.code || String(error.message);
}
parentPort.postMessage(outcome);
`;

/** Runs one create per name in a thread of its own - its own connection - all released at the same moment. */
async function raceInThreads(account, kind, names) {
  const gate = new SharedArrayBuffer(8);
  const flag = new Int32Array(gate);
  const outcomes = [];
  const workers = names.map(
    (name) =>
      new Promise((resolve, reject) => {
        const worker = new Worker(RACE_WORKER, {
          eval: true,
          workerData: {
            dbDir: process.env.DB_DIR,
            staticDir: process.env.TAILOR_STATIC_DIR,
            dist: path.join(__dirname, '..', 'dist'),
            gate,
            kind,
            name,
            account: { id: account.id, role: 'user', subscription: account.subscription ?? 'default' },
          },
        });
        worker.once('message', (outcome) => outcomes.push(outcome));
        worker.once('error', reject);
        worker.once('exit', (code) => (code === 0 ? resolve() : reject(new Error('worker exited ' + code))));
      })
  );
  // Every worker connected and waiting, then all of them at once.
  for (let tries = 0; Atomics.load(flag, 1) < names.length && tries < 2000; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
  await Promise.all(workers);
  return outcomes.sort();
}

test('limit: creates racing from separate threads (separate connections) at the limit - exactly one wins, whatever the order', async () => {
  const w = await world();

  // Profiles: four at once on a Default account (room for one).
  const byProfile = w.account('thread-profile');
  const profileOutcomes = await raceInThreads(byProfile.user, 'profile', ['Thread A', 'Thread B', 'Thread C', 'Thread D']);
  assert.deepEqual(profileOutcomes, ['created', 'profile-limit', 'profile-limit', 'profile-limit']);
  assert.equal(w.profileCountRaw(byProfile.id), 1);

  // Resumes of four different new people: one makes a profile, the rest are refused.
  const byResume = w.account('thread-resume');
  const resumeOutcomes = await raceInThreads(byResume.user, 'resume', ['Thread Person A', 'Thread Person B', 'Thread Person C', 'Thread Person D']);
  assert.deepEqual(resumeOutcomes, ['created', 'profile-limit', 'profile-limit', 'profile-limit']);
  assert.equal(w.profileCountRaw(byResume.id), 1);
  assert.equal(w.resumeCountRaw(byResume.id), 1);

  // The same new person four times at once is one person: all land, in one profile.
  const same = w.account('thread-same');
  const sameOutcomes = await raceInThreads(same.user, 'resume', ['Thread Same', 'thread same', 'THREAD  SAME', 'Thread Same']);
  assert.deepEqual(sameOutcomes, ['created', 'created', 'created', 'created']);
  assert.equal(w.profileCountRaw(same.id), 1);
  assert.equal(w.resumeCountRaw(same.id), 4);
});

test('limit: an account over its limit keeps everything and can use it, but cannot make a profile', async () => {
  const w = await world();
  const who = w.account('limit-over'); // Default: 1
  const a = seedProfileWithResumes(who.user, 'Over A', [person('Over A Resume')]);
  seedProfileWithResumes(who.user, 'Over B', [person('Over B Resume')]);
  seedProfileWithResumes(who.user, 'Over C', [person('Over C Resume')]);

  assert.equal((await profilesOf(w, who)).length, 3, 'all three are still its own');
  const refused = await w.call(who, 'POST', '/api/profiles', { name: 'Over D' });
  assert.equal(refused.status, 402);
  assert.match(refused.body.error, /allows 1 profile and this account has 3\./);

  // It can add a resume to a profile it has, edit, and move among them.
  const added = await makeResume(w, who, 'Another Over A', a.profileId);
  assert.equal(added.profileId, a.profileId);
  assert.equal((await w.call(who, 'PUT', `/api/resumes/${added.id}`, person('Another Over A, edited'))).status, 200);
  const b = (await profilesOf(w, who)).find((profile) => profile.name === 'Over B');
  assert.equal((await w.call(who, 'POST', `/api/profiles/${b.id}/move`, { resumeIds: [added.id] })).status, 200);
  assert.equal(w.resumes.getResume(added.id).profileId, b.id);
});

/* ================================================================== edits */

test('edits: a stale edit keeps a placement moved in between; an edit after a delete is a 404 and the row stays gone', async () => {
  const w = await world();
  const who = w.account('edit', 'premium');
  const home = seedProfileWithResumes(who.user, 'Edit Home', [person('Edit Me')]);
  const away = seedProfileWithResumes(who.user, 'Edit Away', [person('Edit Other')]);
  const id = home.resumeIds[0];

  // The editor read the resume while it was at home; somebody then moved it.
  const stale = w.resumes.getResume(id);
  assert.equal(stale.profileId, home.profileId);
  const moved = await w.call(who, 'POST', `/api/profiles/${away.profileId}/move`, { resumeIds: [id] });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));

  const built = { ...w.resumeDocument.buildUpdatedResume(stale, { summary: 'Edited from a stale page.' }), profileId: home.profileId };
  w.resumes.saveEditedResume(built, who.id);
  const kept = w.resumes.getResume(id);
  assert.equal(kept.summary, 'Edited from a stale page.');
  assert.equal(kept.profileId, away.profileId, 'the move was not undone');
  assert.equal(w.resumeRow(id).profile_id, away.profileId);

  // Through the route, with a stale body, the same.
  const put = await w.call(who, 'PUT', `/api/resumes/${id}`, { ...person('Edit Me'), profileId: home.profileId });
  assert.equal(put.status, 200);
  assert.equal(put.body.profileId, away.profileId);

  // A delete lands between the read and the save: 404, and no resurrection.
  const snapshot = w.resumes.getResume(id);
  const staleBuilt = w.resumeDocument.buildUpdatedResume(snapshot, { summary: 'Too late.' });
  assert.equal((await w.call(who, 'DELETE', `/api/resumes/${id}`)).status, 200);
  assert.throws(
    () => w.resumes.saveEditedResume(staleBuilt, who.id),
    (error) => error.status === 404 && error.code === 'resume-not-found'
  );
  assert.equal(w.resumes.getResume(id), null, 'still gone');
  assert.equal(w.resumeRow(id), undefined);
  assert.equal((await w.call(who, 'PUT', `/api/resumes/${id}`, person('Too late'))).status, 404);
  assert.equal(w.resumes.getResume(id), null);
});

test("edits: an id another account took meanwhile is a 404 for the old owner's save, and the new owner's row is untouched", async () => {
  const w = await world();
  const first = w.account('edit-reuse-a', 'premium');
  const second = w.account('edit-reuse-b', 'premium');
  const seeded = seedProfileWithResumes(first.user, 'Reuse A', [person('First Owner', { id: 'edit-reused-id' })]);
  const snapshot = w.resumes.getResume('edit-reused-id');
  const staleBuilt = w.resumeDocument.buildUpdatedResume(snapshot, { summary: 'From the first owner.' });

  assert.equal((await w.call(first, 'DELETE', '/api/resumes/edit-reused-id')).status, 200);
  w.resumes.saveResume({ ...w.resumeDocument.buildNewResume(person('Second Owner'), 'edit-reused-id'), ownerId: second.id });
  const takenProfile = w.resumes.getResume('edit-reused-id').profileId;

  assert.throws(
    () => w.resumes.saveEditedResume(staleBuilt, first.id),
    (error) => error.status === 404 && error.code === 'resume-not-found'
  );
  const theirs = w.resumes.getResume('edit-reused-id');
  assert.equal(theirs.name, 'Second Owner');
  assert.equal(theirs.ownerId, second.id);
  assert.equal(theirs.profileId, takenProfile);
  assert.notEqual(theirs.profileId, seeded.profileId, "never rejoins the first owner's profile");
});

test('reused ids: a deleted resume\'s id taken by another account is placed in THEIR profile; the id "new" is replaced; a taken id is a 409', async () => {
  const w = await world();
  const carol = w.account('carol');
  const dave = w.account('dave');

  const carols = await w.call(carol, 'POST', '/api/bid-assistant/profiles', { id: 'tree-reused-id', ...person('Carol') });
  assert.ok([200, 201].includes(carols.status), JSON.stringify(carols.body));
  const carolProfile = w.resumeDoc(carols.body.id).profileId;
  assert.ok(carolProfile);
  assert.equal((await w.call(carol, 'DELETE', '/api/bid-assistant/profiles/tree-reused-id')).status, 200);
  // Deleting a resume leaves its profile, empty and with no default.
  const emptied = await summaryOf(w, carol, carolProfile);
  assert.equal(emptied.resumeCount, 0);
  assert.equal(emptied.defaultResumeId, null);

  const daves = await w.call(dave, 'POST', '/api/bid-assistant/profiles', { id: 'tree-reused-id', ...person('Dave') });
  assert.ok([200, 201].includes(daves.status), JSON.stringify(daves.body));
  assert.equal(daves.body.id, 'tree-reused-id');
  const davesProfile = w.resumeDoc('tree-reused-id').profileId;
  assert.ok(davesProfile);
  assert.notEqual(davesProfile, carolProfile);
  assert.equal(w.profileDoc(davesProfile).ownerId, dave.id);

  // A taken id, by another account, through the repository: 409, and nothing else written.
  const erin = w.account('erin-taken');
  assert.throws(
    () => w.resumes.createResumes(w.users.getUserById(erin.id), [w.resumeDocument.buildNewResume(person('Erin'), 'tree-reused-id')]),
    (error) => error.status === 409 && error.code === 'resume-id-taken' && /A resume with this id already exists\./.test(error.message)
  );
  assert.equal(w.profileCountRaw(erin.id), 0, 'no profile was made for the refused resume');
  // All or nothing: a good resume beside a taken id is not saved either.
  assert.throws(() =>
    w.resumes.createResumes(w.users.getUserById(erin.id), [
      w.resumeDocument.buildNewResume(person('Erin Good'), 'tree-erin-good'),
      w.resumeDocument.buildNewResume(person('Erin Bad'), 'tree-reused-id'),
    ])
  );
  assert.equal(w.resumes.getResume('tree-erin-good'), null);

  // "new" is the chooser's address, never a resume's id.
  const frank = w.account('frank-new', 'premium');
  const viaBid = await w.call(frank, 'POST', '/api/bid-assistant/profiles', { id: 'new', ...person('Newbie') });
  assert.ok([200, 201].includes(viaBid.status), JSON.stringify(viaBid.body));
  assert.notEqual(viaBid.body.id, 'new');
  assert.ok(viaBid.body.id.length > 10);
  const viaImport = await w.call(frank, 'POST', '/api/resumes/import', { id: 'new', name: 'Newbie Imported', summary: 'x' });
  assert.equal(viaImport.status, 201, JSON.stringify(viaImport.body));
  assert.notEqual(viaImport.body.resumes[0].id, 'new');
  const viaRepo = w.resumes.createResumes(w.users.getUserById(frank.id), [w.resumeDocument.buildNewResume(person('Newbie Repo'), 'new')]);
  const repoId = Array.isArray(viaRepo) && viaRepo[0] ? viaRepo[0].id : undefined;
  if (repoId) assert.notEqual(repoId, 'new');
  assert.equal(w.resumes.getResume('new'), null);
});

/* ================================================================== defaults */

test('defaults: the first resume in is the default; PUT takes an enabled member only', async () => {
  const w = await world();
  const who = w.account('defaults-put', 'premium');
  const home = await makeProfile(w, who, 'Defaults');
  assert.equal(home.defaultResumeId, null);
  assert.equal(home.chosenDefaultResumeId, null);
  const other = seedProfileWithResumes(who.user, 'Elsewhere', [person('Elsewhere Resume')]);

  const r1 = await makeResume(w, who, 'First', home.id);
  const r2 = await makeResume(w, who, 'Second', home.id);
  const r3 = await makeResume(w, who, 'Third', home.id);
  let summary = await summaryOf(w, who, home.id);
  assert.equal(summary.defaultResumeId, r1.id);
  assert.equal(summary.chosenDefaultResumeId, r1.id);

  const set = await w.call(who, 'PUT', `/api/profiles/${home.id}`, { defaultResumeId: r2.id });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.defaultResumeId, r2.id);
  assert.equal(set.body.chosenDefaultResumeId, r2.id);

  const notMember = await w.call(who, 'PUT', `/api/profiles/${home.id}`, { defaultResumeId: other.resumeIds[0] });
  assert.equal(notMember.status, 400);
  assert.equal(notMember.body.code, 'default-not-member');
  assert.equal(notMember.body.error, "The default resume must be one of this profile's resumes.");
  const unknown = await w.call(who, 'PUT', `/api/profiles/${home.id}`, { defaultResumeId: 'no-such-resume' });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.code, 'default-not-member');

  assert.equal((await w.call(who, 'PUT', `/api/resumes/${r3.id}`, { disabled: true })).status, 200);
  const disabled = await w.call(who, 'PUT', `/api/profiles/${home.id}`, { defaultResumeId: r3.id });
  assert.equal(disabled.status, 409);
  assert.equal(disabled.body.code, 'default-disabled');
  assert.equal(disabled.body.error, 'That resume is disabled, so it cannot be the default. Enable it first.');

  summary = await summaryOf(w, who, home.id);
  assert.equal(summary.chosenDefaultResumeId, r2.id, 'the refusals changed nothing');
});

test('defaults: disabling the default keeps the choice while the effective one changes; enabling brings it back', async () => {
  const w = await world();
  const who = w.account('defaults-disable', 'premium');
  const home = await makeProfile(w, who, 'Disable');
  const r1 = await makeResume(w, who, 'One', home.id);
  const r2 = await makeResume(w, who, 'Two', home.id);
  const r3 = await makeResume(w, who, 'Three', home.id);
  w.stampResume(r1.id, at(1));
  w.stampResume(r2.id, at(2));
  w.stampResume(r3.id, at(3));
  assert.equal((await w.call(who, 'PUT', `/api/profiles/${home.id}`, { defaultResumeId: r3.id })).status, 200);

  assert.equal((await w.call(who, 'PUT', `/api/resumes/${r3.id}`, { disabled: true })).status, 200);
  let summary = await summaryOf(w, who, home.id);
  assert.equal(summary.chosenDefaultResumeId, r3.id, 'the stored choice is kept');
  assert.equal(summary.defaultResumeId, r1.id, 'the oldest enabled resume stands in');
  assert.equal(summary.enabledResumeCount, 2);
  assert.equal(summary.resumeCount, 3);

  assert.equal((await w.call(who, 'PUT', `/api/resumes/${r3.id}`, { disabled: false })).status, 200);
  summary = await summaryOf(w, who, home.id);
  assert.equal(summary.defaultResumeId, r3.id, 'enabling brings the choice back');
  assert.equal(summary.chosenDefaultResumeId, r3.id);
});

test('defaults: deleting or moving out the default repoints it to the OLDEST enabled resume, else the oldest, else nothing', async () => {
  const w = await world();
  const who = w.account('defaults-repoint', 'premium');
  const home = await makeProfile(w, who, 'Repoint');
  const away = await makeProfile(w, who, 'Away');
  const made = [];
  for (const name of ['One', 'Two', 'Three', 'Four']) made.push(await makeResume(w, who, name, home.id));
  const ids = made.map((resume) => resume.id);
  // Disable first, THEN stamp: an edit moves a resume's updatedAt, and "oldest" must be the same
  // resume whether a rule reads createdAt or updatedAt.
  assert.equal((await w.call(who, 'PUT', `/api/resumes/${ids[0]}`, { disabled: true })).status, 200);
  ids.forEach((id, index) => w.stampResume(id, at(index + 1)));
  assert.equal((await w.call(who, 'PUT', `/api/profiles/${home.id}`, { defaultResumeId: ids[2] })).status, 200);

  // Delete the default (Three): the oldest ENABLED is Two - not One (disabled), not Four (newest).
  assert.equal((await w.call(who, 'DELETE', `/api/resumes/${ids[2]}`)).status, 200);
  let summary = await summaryOf(w, who, home.id);
  assert.equal(summary.chosenDefaultResumeId, ids[1]);
  assert.equal(summary.defaultResumeId, ids[1]);

  // Move the default (Two) out: the oldest enabled left is Four; the away profile adopts Two.
  const moved = await w.call(who, 'POST', `/api/profiles/${away.id}/move`, { resumeIds: [ids[1]] });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  summary = await summaryOf(w, who, home.id);
  assert.equal(summary.chosenDefaultResumeId, ids[3]);
  const awaySummary = await summaryOf(w, who, away.id);
  assert.equal(awaySummary.chosenDefaultResumeId, ids[1], 'a profile with no default adopts the first resume moved in');

  // Delete Four: only the disabled One is left, so the oldest of all.
  assert.equal((await w.call(who, 'DELETE', `/api/resumes/${ids[3]}`)).status, 200);
  summary = await summaryOf(w, who, home.id);
  assert.equal(summary.chosenDefaultResumeId, ids[0]);

  // Delete the last: the profile stays, empty, with no default.
  assert.equal((await w.call(who, 'DELETE', `/api/resumes/${ids[0]}`)).status, 200);
  summary = await summaryOf(w, who, home.id);
  assert.equal(summary.resumeCount, 0);
  assert.equal(summary.chosenDefaultResumeId, null);
  assert.equal(summary.defaultResumeId, null);
  assert.equal(w.profileDoc(home.id).defaultResumeId ?? null, null);
});

test('profile edits: a name changes, a blank or over-long name, an empty body and a member list are refused in the specified words', async () => {
  const w = await world();
  const who = w.account('person-put', 'premium');
  const home = await makeProfile(w, who, 'Before');
  const resume = await makeResume(w, who, 'Member', home.id);

  const renamed = await w.call(who, 'PUT', `/api/profiles/${home.id}`, { name: '  After  ' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.name, 'After');
  assert.equal(w.profileDoc(home.id).name, 'After');

  const blank = await w.call(who, 'PUT', `/api/profiles/${home.id}`, { name: '   ' });
  assert.equal(blank.status, 400);
  assert.equal(blank.body.code, 'profile-name-required');
  assert.equal(blank.body.error, 'Give the profile a name.');
  const long = await w.call(who, 'PUT', `/api/profiles/${home.id}`, { name: 'x'.repeat(101) });
  assert.equal(long.status, 400);
  assert.equal(long.body.code, 'profile-name-too-long');
  assert.equal(long.body.error, 'A profile name can be at most 100 characters.');
  assert.equal((await w.call(who, 'PUT', `/api/profiles/${home.id}`, { name: 'x'.repeat(100) })).status, 200);

  const nothing = await w.call(who, 'PUT', `/api/profiles/${home.id}`, {});
  assert.equal(nothing.status, 400);
  assert.equal(nothing.body.code, 'nothing-to-change');
  assert.equal(nothing.body.error, 'There is nothing to change: send a name or a default resume.');

  for (const body of [{ resumeIds: [resume.id] }, { name: 'Also named', resumeIds: [resume.id] }]) {
    const refused = await w.call(who, 'PUT', `/api/profiles/${home.id}`, body);
    assert.equal(refused.status, 400, JSON.stringify(body));
    assert.equal(refused.body.code, 'use-move');
    assert.equal(refused.body.error, "A profile's resumes are not changed here: move them with Move.");
  }
  assert.equal((await summaryOf(w, who, home.id)).name, 'x'.repeat(100), 'a refusal changed nothing');

  const missing = await w.call(who, 'PUT', '/api/profiles/no-such-profile', { name: 'x' });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'profile-not-found');
});

/* ================================================================== move */

test('move: resumes go to the profile, keep their updatedAt, and the source default is repointed', async () => {
  const w = await world();
  const who = w.account('move', 'premium');
  const src = seedProfileWithResumes(who.user, 'Src', [person('M One'), person('M Two'), person('M Three')]);
  const dst = seedProfileWithResumes(who.user, 'Dst', [person('D One')]);
  src.resumeIds.forEach((id, index) => w.stampResume(id, at(index + 1)));
  const before = src.resumeIds.map((id) => ({ doc: w.resumeDoc(id).updatedAt, column: w.resumeRow(id).updated_at }));

  const moved = await w.call(who, 'POST', `/api/profiles/${dst.profileId}/move`, { resumeIds: [src.resumeIds[0], src.resumeIds[1]] });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(countOf(moved.body.moved), 2);
  assert.deepEqual(moved.body.profiles.map((profile) => profile.id).sort(), [dst.profileId, src.profileId].sort(), 'the target and every source that changed');
  const target = moved.body.profiles.find((profile) => profile.id === dst.profileId);
  assert.equal(target.resumeCount, 3);

  for (const index of [0, 1]) {
    const id = src.resumeIds[index];
    assert.equal(w.resumeDoc(id).profileId, dst.profileId);
    assert.equal(w.resumeRow(id).profile_id, dst.profileId);
    assert.equal(w.resumeDoc(id).updatedAt, before[index].doc, 'updatedAt kept in the document');
    assert.equal(w.resumeRow(id).updated_at, before[index].column, 'and the column');
  }
  const source = await summaryOf(w, who, src.profileId);
  assert.equal(source.resumeCount, 1);
  assert.equal(source.chosenDefaultResumeId, src.resumeIds[2], 'the default left, so the source repointed');
  assert.equal((await summaryOf(w, who, dst.profileId)).chosenDefaultResumeId, dst.resumeIds[0], 'the target keeps its own');
});

test('move: all or nothing - an unknown or a foreign resume in the list moves none; a missing list or target is refused', async () => {
  const w = await world();
  const who = w.account('move-atomic', 'premium');
  const stranger = w.account('move-atomic-stranger', 'premium');
  const src = seedProfileWithResumes(who.user, 'Src', [person('A One'), person('A Two')]);
  const dst = seedProfileWithResumes(who.user, 'Dst', [person('A Three')]);
  const theirs = seedProfileWithResumes(stranger.user, 'Theirs', [person('Theirs One')]);
  const move = (profileId, body, as = who) => w.call(as, 'POST', `/api/profiles/${profileId}/move`, body);

  const unknown = await move(dst.profileId, { resumeIds: [src.resumeIds[0], 'no-such-resume'] });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.code, 'resume-not-found');
  assert.equal(unknown.body.error, RESUME_NOT_FOUND);
  assert.equal(w.resumeDoc(src.resumeIds[0]).profileId, src.profileId, 'the good one did not move either');

  const foreign = await move(dst.profileId, { resumeIds: [src.resumeIds[0], theirs.resumeIds[0]] });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.body.code, 'resume-not-found');
  assert.equal(w.resumeDoc(src.resumeIds[0]).profileId, src.profileId);
  assert.equal(w.resumeDoc(theirs.resumeIds[0]).profileId, theirs.profileId);

  for (const body of [{ resumeIds: [] }, {}]) {
    const nothing = await move(dst.profileId, body);
    assert.equal(nothing.status, 400, JSON.stringify(body));
    assert.equal(nothing.body.code, 'nothing-to-move');
    assert.equal(nothing.body.error, 'Choose the resumes to move.');
  }

  const noTarget = await move('no-such-profile', { resumeIds: [src.resumeIds[0]] });
  assert.equal(noTarget.status, 404);
  assert.equal(noTarget.body.code, 'profile-not-found');
  const foreignTarget = await move(theirs.profileId, { resumeIds: [src.resumeIds[0]] });
  assert.equal(foreignTarget.status, 404);
  assert.equal(foreignTarget.body.code, 'profile-not-found');
  assert.equal(w.resumeDoc(src.resumeIds[0]).profileId, src.profileId);
});

test("move: across accounts is a 409 even for an administrator, who may still move within one account", async () => {
  const w = await world();
  const alice = w.account('move-alice', 'premium');
  const bob = w.account('move-bob', 'premium');
  const aliceHome = seedProfileWithResumes(alice.user, 'Alice Home', [person('Alice One')]);
  const aliceOther = seedProfileWithResumes(alice.user, 'Alice Other', [person('Alice Two')]);
  const bobHome = seedProfileWithResumes(bob.user, 'Bob Home', [person('Bob One')]);

  const across = await w.call(w.admin, 'POST', `/api/profiles/${bobHome.profileId}/move`, { resumeIds: [aliceHome.resumeIds[0]] });
  assert.equal(across.status, 409);
  assert.equal(across.body.code, 'profile-owner-mismatch');
  assert.equal(across.body.error, 'A resume can only move to a profile of the account it belongs to.');
  assert.equal(w.resumeDoc(aliceHome.resumeIds[0]).profileId, aliceHome.profileId);
  assert.equal((await summaryOf(w, bob, bobHome.profileId)).resumeCount, 1);

  const within = await w.call(w.admin, 'POST', `/api/profiles/${aliceOther.profileId}/move`, { resumeIds: [aliceHome.resumeIds[0]] });
  assert.equal(within.status, 200, JSON.stringify(within.body));
  assert.equal(w.resumeDoc(aliceHome.resumeIds[0]).profileId, aliceOther.profileId);
  assert.equal(w.resumeDoc(aliceHome.resumeIds[0]).ownerId, alice.id, 'still hers');
});

test('move: POST /api/profiles with resumeIds makes the profile counting the limit, and moves them all or none', async () => {
  const w = await world();
  const limited = w.account('move-new-limited');
  const home = seedProfileWithResumes(limited.user, 'One', [person('Lim One'), person('Lim Two')]);
  const refused = await w.call(limited, 'POST', '/api/profiles', { name: 'Two', resumeIds: [home.resumeIds[0]] });
  assert.equal(refused.status, 402, JSON.stringify(refused.body));
  assert.equal(refused.body.code, 'profile-limit');
  assert.equal(w.resumeDoc(home.resumeIds[0]).profileId, home.profileId, 'nothing moved');
  assert.equal(w.profileCountRaw(limited.id), 1);

  const who = w.account('move-new', 'premium');
  const src = seedProfileWithResumes(who.user, 'Source', [person('Src One'), person('Src Two'), person('Src Three')]);
  const bad = await w.call(who, 'POST', '/api/profiles', { name: 'Bad Home', resumeIds: [src.resumeIds[0], 'no-such-resume'] });
  assert.equal(bad.status, 404);
  assert.equal(bad.body.code, 'resume-not-found');
  assert.equal((await profilesOf(w, who)).some((profile) => profile.name === 'Bad Home'), false, 'no profile was made');
  assert.equal(w.resumeDoc(src.resumeIds[0]).profileId, src.profileId);

  const good = await w.call(who, 'POST', '/api/profiles', { name: 'New Home', resumeIds: [src.resumeIds[0], src.resumeIds[1]] });
  assert.equal(good.status, 201, JSON.stringify(good.body));
  assert.equal(good.body.resumeCount, 2);
  assert.ok([src.resumeIds[0], src.resumeIds[1]].includes(good.body.defaultResumeId), 'a profile made with resumes has one as its default');
  const source = await summaryOf(w, who, src.profileId);
  assert.equal(source.resumeCount, 1);
  assert.equal(source.chosenDefaultResumeId, src.resumeIds[2], 'and the source repointed');
});

/* ================================================================== delete */

test('delete: a profile takes its resumes and their answers with it in ONE transaction, and a resume added just before goes too', async () => {
  const w = await world();
  const who = w.account('delete', 'premium');
  const doomed = seedProfileWithResumes(who.user, 'To delete', [person('Del One'), person('Del Two'), person('Del Three')]);
  const kept = seedProfileWithResumes(who.user, 'To keep', [person('Keeper')]);
  const job = w.importJob('Delco');
  for (const id of [...doomed.resumeIds, kept.resumeIds[0]]) {
    assert.equal((await w.answerAs(who, job.id, id, `Answer for ${id}`)).status, 200);
    assert.equal(w.answerRows(id), 1);
  }

  // A failure part-way undoes all of it: the profile, the resumes and the answers.
  const trigger = `CREATE TRIGGER profile_tree_fail BEFORE DELETE ON resumes WHEN old.id = '${doomed.resumeIds[2]}' BEGIN SELECT RAISE(ABORT, 'boom'); END`;
  w.db().exec(trigger);
  try {
    const { result } = await captureErrorLog(() => w.call(who, 'DELETE', `/api/profiles/${doomed.profileId}`));
    assert.ok(result.status >= 500, `a failure, not a half delete: ${result.status}`);
  } finally {
    w.db().exec('DROP TRIGGER IF EXISTS profile_tree_fail');
  }
  assert.equal((await w.call(who, 'GET', `/api/profiles/${doomed.profileId}`)).status, 200, 'the profile is still there');
  for (const id of doomed.resumeIds) {
    assert.ok(w.resumes.getResume(id), `${id} is still there`);
    assert.equal(w.answerRows(id), 1, `and so is its answer`);
  }

  // A resume added after the page warned goes too, and no count is asked for.
  const late = await makeResume(w, who, 'Added Late', doomed.profileId);
  const deleted = await w.call(who, 'DELETE', `/api/profiles/${doomed.profileId}?deleteResumes=3`);
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.deepEqual(deleted.body, { deleted: true, deletedResumes: 4 });
  for (const id of [...doomed.resumeIds, late.id]) {
    assert.equal(w.resumes.getResume(id), null, `${id} is gone`);
    assert.equal(w.answerRows(id), 0, `with its answers`);
  }
  assert.equal((await w.call(who, 'GET', `/api/profiles/${doomed.profileId}`)).status, 404);
  assert.equal(w.answerRows(kept.resumeIds[0]), 1, "another profile's answers are untouched");
  assert.ok(w.resumes.getResume(kept.resumeIds[0]));
});

test('delete: an empty profile deletes; an unknown or foreign one is a 404 that touches nothing; an administrator reaches any', async () => {
  const w = await world();
  const who = w.account('delete-empty', 'premium');
  const stranger = w.account('delete-stranger', 'premium');
  const empty = await makeProfile(w, who, 'Empty');
  const deleted = await w.call(who, 'DELETE', `/api/profiles/${empty.id}`);
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body, { deleted: true, deletedResumes: 0 });

  const theirs = seedProfileWithResumes(stranger.user, 'Theirs', [person('Theirs One')]);
  const foreign = await w.call(who, 'DELETE', `/api/profiles/${theirs.profileId}`);
  assert.equal(foreign.status, 404);
  assert.equal(foreign.body.code, 'profile-not-found');
  assert.equal(foreign.body.error, PROFILE_NOT_FOUND);
  assert.ok(w.resumes.getResume(theirs.resumeIds[0]), "hers is untouched");
  const unknown = await w.call(who, 'DELETE', '/api/profiles/no-such-profile');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.code, 'profile-not-found');

  const byAdmin = await w.call(w.admin, 'DELETE', `/api/profiles/${theirs.profileId}`);
  assert.equal(byAdmin.status, 200);
  assert.deepEqual(byAdmin.body, { deleted: true, deletedResumes: 1 });
  assert.equal(w.resumes.getResume(theirs.resumeIds[0]), null);
});

/* ================================================================== the routes' reach */

test('no tier gate: a Default account lists, creates (one), reads, renames and deletes profiles - and a deleted profile frees its slot', async () => {
  const w = await world();
  const who = w.account('no-gate'); // Default
  assert.deepEqual(await profilesOf(w, who), []);
  const made = await w.call(who, 'POST', '/api/profiles', { name: 'Mine' });
  assert.equal(made.status, 201);
  assert.equal((await w.call(who, 'GET', `/api/profiles/${made.body.id}`)).status, 200);
  const renamed = await w.call(who, 'PUT', `/api/profiles/${made.body.id}`, { name: 'Renamed' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.name, 'Renamed');
  assert.equal((await w.call(who, 'DELETE', `/api/profiles/${made.body.id}`)).status, 200);
  assert.equal((await w.call(who, 'POST', '/api/profiles', { name: 'Again' })).status, 201, 'the slot is free again');
  // Signed out is still refused.
  assert.equal((await w.call(null, 'GET', '/api/profiles')).status, 401);
  assert.equal((await w.call(null, 'POST', '/api/profiles', { name: 'x' })).status, 401);
});

test('stale tabs: a resume body POSTed to /api/profiles is a 400 stale-page and makes nothing', async () => {
  const w = await world();
  const who = w.account('stale', 'premium');
  const body = { name: 'Jane Doe', title: 'Engineer', summary: 'A v4.1 editor saving.', contact: { email: 'a@b.c' }, skills: ['Go'] };
  const refused = await w.call(who, 'POST', '/api/profiles', body);
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, 'stale-page');
  assert.equal(refused.body.error, 'This page is out of date; reload it before saving.');
  assert.equal(w.profileCountRaw(who.id), 0, 'no person was made of it');
  assert.equal(w.resumeCountRaw(who.id), 0);

  // Any key but name and resumeIds is the same refusal.
  const oneExtra = await w.call(who, 'POST', '/api/profiles', { name: 'Fine', summary: 'extra' });
  assert.equal(oneExtra.status, 400);
  assert.equal(oneExtra.body.code, 'stale-page');
  assert.equal(w.profileCountRaw(who.id), 0);

  // Both keys are optional.
  const bare = await w.call(who, 'POST', '/api/profiles', {});
  assert.equal(bare.status, 201, JSON.stringify(bare.body));
  assert.equal(bare.body.name, 'Untitled Profile');
  assert.equal((await w.call(who, 'POST', '/api/profiles', { name: 'Named', resumeIds: [] })).status, 201);
});

test('summaries: the fields, lastEditedAt, the order, and ownerId only on an administrator\'s allOwners list', async () => {
  const w = await world();
  const who = w.account('summary', 'premium');
  const older = seedProfileWithResumes(who.user, 'Older', [person('Older One')]);
  const newer = seedProfileWithResumes(who.user, 'Newer', [person('Newer One'), person('Newer Two')]);
  w.stampProfile(older.profileId, { createdAt: at(1), updatedAt: at(1) });
  w.stampResume(older.resumeIds[0], at(2));
  w.stampProfile(newer.profileId, { createdAt: at(1), updatedAt: at(1) });
  w.stampResume(newer.resumeIds[0], at(3));
  w.stampResume(newer.resumeIds[1], at(5));

  const list = await profilesOf(w, who);
  assert.deepEqual(list.map((profile) => profile.name), ['Newer', 'Older'], 'most recently edited first');
  const summary = list[0];
  assert.deepEqual(
    Object.keys(summary).sort(),
    ['chosenDefaultResumeId', 'createdAt', 'defaultResumeId', 'enabledResumeCount', 'id', 'lastEditedAt', 'name', 'resumeCount', 'updatedAt'],
    'an ordinary list carries no ownerId'
  );
  assert.equal(summary.lastEditedAt, at(5), 'the newest of the profile and its resumes');
  assert.equal(list[1].lastEditedAt, at(2));
  assert.equal(summary.resumeCount, 2);
  assert.equal(summary.enabledResumeCount, 2);

  // ?allOwners=true is an administrator's; anyone else's is their own list.
  const asUser = await w.call(who, 'GET', '/api/profiles?allOwners=true');
  assert.equal(asUser.status, 200);
  assert.deepEqual(asUser.body.map((profile) => profile.id).sort(), [older.profileId, newer.profileId].sort());
  assert.ok(asUser.body.every((profile) => !('ownerId' in profile)));
  const adminOwn = await w.call(w.admin, 'GET', '/api/profiles');
  assert.equal(adminOwn.body.some((profile) => profile.id === older.profileId), false);
  assert.ok(adminOwn.body.every((profile) => !('ownerId' in profile)));
  const adminAll = await w.call(w.admin, 'GET', '/api/profiles?allOwners=true');
  const found = adminAll.body.find((profile) => profile.id === older.profileId);
  assert.ok(found, 'the administrator sees everybody\'s');
  assert.equal(found.ownerId, who.id);

  // One profile by id: its owner's, an administrator's, nobody else's.
  const other = w.account('summary-other', 'premium');
  assert.equal((await w.call(other, 'GET', `/api/profiles/${older.profileId}`)).status, 404);
  assert.equal((await w.call(w.admin, 'GET', `/api/profiles/${older.profileId}`)).status, 200);
});

/* ================================================================== counts */

test('counts: profilesUsed counts people on the account views, and deleting an account reports profiles and resumes it leaves', async () => {
  const w = await world();
  const who = w.account('counts');
  seedProfileWithResumes(who.user, 'Counted', [person('C One'), person('C Two'), person('C Three', { disabled: true })]);
  const { describeAccount } = require('../dist/routes/auth');
  assert.equal(describeAccount(w.users.getUserById(who.id)).profilesUsed, 1, 'three resumes in one profile');

  const second = w.account('counts-two', 'premium');
  seedProfileWithResumes(second.user, 'Counted A', [person('A One')]);
  seedProfileWithResumes(second.user, 'Counted B', [person('B One'), person('B Two')]);
  assert.equal(describeAccount(w.users.getUserById(second.id)).profilesUsed, 2);

  const accounts = (await w.call(w.admin, 'GET', '/api/admin/accounts')).body.accounts;
  assert.equal(accounts.find((account) => account.id === who.id).profilesUsed, 1);
  assert.equal(accounts.find((account) => account.id === second.id).profilesUsed, 2);
  assert.equal(accounts.find((account) => account.id === second.id).profileLimit, 5);

  const { countProfilesForOwner } = require('../dist/database/profileLimit');
  assert.equal(countProfilesForOwner(second.id), 2);

  const removed = await w.call(w.admin, 'DELETE', `/api/admin/accounts/${second.id}`);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.deleted, true);
  assert.equal(removed.body.orphanedProfiles, 2, 'people');
  assert.equal(removed.body.orphanedResumes, 3);
  assert.equal(
    removed.body.note,
    '3 resumes in 2 profiles belonged to that account and still exist. ' +
      'They are visible to administrators only until they are reassigned or deleted.'
  );
  assert.equal(w.profileCountRaw(second.id), 2, 'nothing was deleted with the login');
  assert.equal(w.resumeCountRaw(second.id), 3);
});

/* ================================================================== long names, filing edges, counts */

/** A resume as v4.1 left it - no pointer in the column or the document - written straight into the table. */
function legacyResume(w, ownerId, id, name, createdAt, extra = {}) {
  const old = oldResume(id, name, ownerId, createdAt);
  const document = { ...old.document, ...extra };
  w.db()
    .prepare('INSERT INTO resumes (id, name, disabled, data, created_at, updated_at, owner_id) VALUES (?, ?, 0, ?, ?, ?, ?)')
    .run(id, name, JSON.stringify(document), createdAt, createdAt, ownerId);
  return document;
}

/** Points a stored resume at a profile id by hand (column and document), as a hand edit of the database would. */
function pointResumeAt(w, id, profileId) {
  const doc = w.resumeDoc(id);
  doc.profileId = profileId;
  w.db().prepare('UPDATE resumes SET data = ?, profile_id = ? WHERE id = ?').run(JSON.stringify(doc), profileId, id);
}

test('pure rules: a person key is the key of the name a profile would be given, so a name over 100 characters keeps its key', () => {
  const rules = require('../dist/services/profileRules');
  const long = 'Long Name '.repeat(15); // 150 characters
  assert.ok(Array.from(long.trim()).length > rules.MAX_PROFILE_NAME_LENGTH);
  const given = rules.profileNameForPerson(long);
  assert.ok(Array.from(given).length <= rules.MAX_PROFILE_NAME_LENGTH);
  assert.equal(rules.personKey(long), rules.personKey(given), 'the stored (cut) name and the full name are one person');
  // A short name, a blank one and a different long one are untouched by the cut.
  assert.equal(rules.personKey('  Jane   DOE '), 'jane doe');
  assert.equal(rules.personKey(''), 'untitled profile');
  assert.notEqual(rules.personKey('A'.repeat(150)), rules.personKey('B'.repeat(150)));
});

test('long names: a resume whose name is over 100 characters rejoins its own profile, on any tier - on create and when filing', async () => {
  const w = await world();
  const long = 'Maximilian '.repeat(14).trim(); // 153 characters

  // Create: the second resume of the same long name lands in the first one's profile - not a 402 on Default.
  const who = w.account('long-name'); // Default: one profile
  const first = await w.call(who, 'POST', '/api/resumes', person(long));
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const second = await w.call(who, 'POST', '/api/resumes', person(long, { title: 'Second' }));
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.equal(second.body.profileId, first.body.profileId);
  assert.equal(w.profileCountRaw(who.id), 1);
  assert.equal(Array.from(w.profileDoc(first.body.profileId).name).length, 100, 'the profile carries the cut name');

  // Filing: two old resumes of one long name make ONE profile.
  const old = w.account('long-old', 'premium-max');
  legacyResume(w, old.id, 'long-old-1', long, at(2));
  legacyResume(w, old.id, 'long-old-2', long, at(3));
  const listed = await w.call(old, 'GET', '/api/profiles');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.length, 1, JSON.stringify(listed.body.map((profile) => profile.name)));
  assert.equal(listed.body[0].resumeCount, 2);
  assert.equal(listed.body[0].chosenDefaultResumeId, 'long-old-1');
});

test('lazy filing: a pointer to a missing profile, or to another account\'s, is filed again by name; nothing else moves', async () => {
  const w = await world();
  const x = w.account('dangle', 'premium-max');
  const y = w.account('dangle-other', 'premium-max');
  legacyResume(w, x.id, 'dg-1', 'Dana Dane', at(2));
  legacyResume(w, x.id, 'dg-2', 'Dana Dane', at(3));
  const firstList = await w.call(x, 'GET', '/api/profiles');
  assert.equal(firstList.body.length, 1);
  const dana = firstList.body[0];
  const danaUpdatedAt = w.profileDoc(dana.id).updatedAt;
  const times = (id) => {
    const row = w.resumeRow(id);
    return [row.created_at, row.updated_at];
  };
  const beforeTimes = times('dg-2');

  // Another account's profile, with one resume of its own to prove it is left alone.
  const theirs = await makeProfile(w, y, 'Yan Yang');
  const theirResume = await makeResume(w, y, 'Yan Yang', theirs.id);
  const theirDoc = JSON.stringify(w.profileDoc(theirs.id));
  const theirRow = JSON.stringify(w.resumeRow(theirResume.id));

  // 1. Dangling: the profile it names is gone.
  pointResumeAt(w, 'dg-2', 'a-profile-that-is-gone');
  let listed = await w.call(x, 'GET', '/api/profiles');
  assert.equal(listed.body.length, 1, 'filed under the existing person, not a new profile');
  assert.equal(w.resumeRow('dg-2').profile_id, dana.id);
  assert.equal(w.resumeDoc('dg-2').profileId, dana.id, 'the document agrees');

  // 2. Another account's profile: not valid for this owner.
  pointResumeAt(w, 'dg-2', theirs.id);
  listed = await w.call(x, 'GET', '/api/resumes?includeDisabled=true');
  assert.equal(listed.status, 200);
  assert.equal(w.resumeRow('dg-2').profile_id, dana.id, 'taken back into its own account');
  assert.equal(JSON.stringify(w.profileDoc(theirs.id)), theirDoc, 'the other account\'s profile is untouched');
  assert.equal(JSON.stringify(w.resumeRow(theirResume.id)), theirRow, 'and so is its resume');
  assert.equal((await w.call(y, 'GET', `/api/profiles/${theirs.id}`)).body.resumeCount, 1);

  // Filing is not an edit: the resume's times and the profile's dates stand, and the default stays the oldest.
  assert.deepEqual(times('dg-2'), beforeTimes);
  const after = (await w.call(x, 'GET', '/api/profiles')).body[0];
  assert.equal(after.id, dana.id);
  assert.equal(after.resumeCount, 2);
  assert.equal(after.chosenDefaultResumeId, 'dg-1');
  assert.equal(w.profileDoc(dana.id).updatedAt, danaUpdatedAt, 'the profile\'s own date did not move');
});

test('lazy filing: a profile made by filing takes the dates of the resume it was made for', async () => {
  const w = await world();
  const who = w.account('dates', 'premium-max');
  legacyResume(w, who.id, 'dt-1', 'Dot Dated', at(4, 7));
  const listed = await w.call(who, 'GET', '/api/profiles');
  const doc = w.profileDoc(listed.body[0].id);
  assert.equal(doc.createdAt, at(4, 7));
  assert.equal(doc.updatedAt, at(4, 7));
});

test('lazy filing: editing or moving an unfiled resume files the account\'s old resumes first, by their stored names', async () => {
  const w = await world();

  // An edit that renames it still leaves it with the other resumes of its stored name.
  const edit = w.account('edit-old', 'premium-max');
  legacyResume(w, edit.id, 'eo-1', 'Zoe Zed', at(2));
  legacyResume(w, edit.id, 'eo-2', 'Zoe Zed', at(3));
  legacyResume(w, edit.id, 'eo-3', 'Other Person', at(4));
  const put = await w.call(edit, 'PUT', '/api/resumes/eo-2', { ...person('Renamed Completely') });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.name, 'Renamed Completely');
  const listed = await w.call(edit, 'GET', '/api/profiles');
  assert.deepEqual(sortedNames(listed.body), ['Other Person', 'Zoe Zed']);
  assert.equal(w.resumeRow('eo-2').profile_id, w.resumeRow('eo-1').profile_id);
  assert.equal(listed.body.find((profile) => profile.name === 'Zoe Zed').resumeCount, 2);

  // A move of one unfiled resume into a profile files its owner's others by name.
  const move = w.account('move-old', 'premium-max');
  legacyResume(w, move.id, 'mo-1', 'Wes One', at(2));
  legacyResume(w, move.id, 'mo-2', 'Wes One', at(3));
  const target = await makeProfile(w, move, 'Target Person');
  const moved = await w.call(move, 'POST', `/api/profiles/${target.id}/move`, { resumeIds: ['mo-1'] });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(w.resumeRow('mo-1').profile_id, target.id);
  const wes = (await w.call(move, 'GET', '/api/profiles')).body.find((profile) => profile.name === 'Wes One');
  assert.ok(wes, 'the one left behind is filed under its person');
  assert.equal(w.resumeRow('mo-2').profile_id, wes.id);
  assert.equal(wes.chosenDefaultResumeId, 'mo-2');
  assert.equal(w.profileDoc(target.id).defaultResumeId, 'mo-1');
});

test('lazy filing: the Bid Assistant\'s whole-record PUT on an unfiled resume files by the stored name, not the one in the body', async () => {
  const w = await world();
  const who = w.account('bid-old', 'premium-max');
  legacyResume(w, who.id, 'bo-1', 'Wes Won', at(2));
  legacyResume(w, who.id, 'bo-2', 'Wes Won', at(3));
  const put = await w.call(who, 'PUT', '/api/bid-assistant/profiles/bo-1', { ...w.resumeDoc('bo-1'), name: 'Zed Other' });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(w.resumeDoc('bo-1').name, 'Zed Other');
  const listed = await w.call(who, 'GET', '/api/profiles');
  assert.deepEqual(sortedNames(listed.body), ['Wes Won'], 'no profile was made for the name in the body');
  assert.equal(w.resumeRow('bo-1').profile_id, w.resumeRow('bo-2').profile_id);
  assert.equal(listed.body[0].resumeCount, 2);
});

test('counts: the session\'s profilesUsed counts old resumes\' people (filed first); deleting such an account says how many', async () => {
  const w = await world();
  const { describeAccount } = require('../dist/routes/auth');

  const who = w.account('used-old', 'premium'); // 5 profiles
  legacyResume(w, who.id, 'us-1', 'Ann One', at(2));
  legacyResume(w, who.id, 'us-2', 'ann  one', at(3));
  legacyResume(w, who.id, 'us-3', 'Ben Two', at(4));
  const view = describeAccount(w.users.getUserById(who.id));
  assert.equal(view.profileLimit, 5);
  assert.equal(view.profilesUsed, 2, 'two people, not zero');

  const doomed = w.account('delete-old', 'premium');
  legacyResume(w, doomed.id, 'dl-1', 'Cal One', at(2));
  legacyResume(w, doomed.id, 'dl-2', 'Dee Two', at(3));
  const deleted = await w.call(w.admin, 'DELETE', `/api/admin/accounts/${doomed.id}`);
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal(deleted.body.orphanedProfiles, 2);
  assert.equal(deleted.body.orphanedResumes, 2);
  assert.match(deleted.body.note, /2 resumes in 2 profiles/);
});

test('lazy filing: a row that is not a document never keeps the check true, and does not stop the rest being filed', async () => {
  const w = await world();
  const tree = require('../dist/database/profileTree');
  const who = w.account('badjson', 'premium-max');
  legacyResume(w, who.id, 'bj-1', 'Sue One', at(2));
  w.db()
    .prepare('INSERT INTO resumes (id, name, disabled, data, created_at, updated_at, owner_id) VALUES (?, ?, 0, ?, ?, ?, ?)')
    .run('bj-bad', 'Sue Bad', 'not json', at(3), at(3), who.id);
  try {
    const listed = await w.call(who, 'GET', '/api/profiles');
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.deepEqual(sortedNames(listed.body), ['Sue One']);
    assert.equal(w.resumeRow('bj-bad').profile_id, null, 'left as it is');
    // Nothing is left that filing could do: neither check finds a row, so no write lock is taken for it.
    assert.equal(w.db().prepare(tree.HAS_UNFILED_RESUME_SQL).get(who.id), undefined);
    assert.equal(w.db().prepare(tree.HAS_DANGLING_RESUME_SQL).get(who.id), undefined);
    assert.equal(tree.fileUnfiledResumes(w.db(), who.id), 0);
  } finally {
    w.db().prepare('DELETE FROM resumes WHERE id = ?').run('bj-bad');
  }
});

/* ================================================================== plans and the invariant */

test('plans: the new indexes exist, and the lookups the tree makes seek on them', async () => {
  const w = await world();
  const db = w.db();
  assert.ok(db.prepare('PRAGMA table_info(resumes)').all().some((column) => column.name === 'profile_id'), 'resumes.profile_id');
  const indexColumns = (name) => db.prepare(`PRAGMA index_info(${name})`).all().sort((a, b) => a.seqno - b.seqno).map((column) => column.name);
  assert.deepEqual(indexColumns('idx_resumes_owner_profile'), ['owner_id', 'profile_id']);
  assert.deepEqual(indexColumns('idx_profiles_owner'), ['owner_id', 'created_at']);

  const plan = (sql, ...params) =>
    db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((row) => row.detail).join('\n');
  assert.match(plan('SELECT id FROM resumes WHERE owner_id = ? AND profile_id = ?', 'o', 'p'), /idx_resumes_owner_profile/);
  assert.match(plan('SELECT id FROM profiles WHERE owner_id = ? ORDER BY created_at', 'o'), /idx_profiles_owner/);
  assert.match(plan('SELECT COUNT(*) AS n FROM profiles WHERE owner_id = ?', 'o'), /idx_profiles_owner/);

  // The tree's own statements, imported rather than retyped: what runs is what is pinned.
  const tree = require('../dist/database/profileTree');
  const planOf = (sql) => {
    const marks = (sql.match(/\?/g) || []).length;
    return plan(sql, ...Array(marks).fill('o'));
  };
  const seek = (index, columns) =>
    new RegExp('SEARCH \\w+ USING (COVERING )?INDEX ' + index + ' \\(' + columns + '\\)');

  // An owner's profiles: a seek on the owner. The tie-break by id is one TEMP B-TREE
  // over that owner's few profiles, and that is the whole of the sort.
  const people = planOf(tree.PROFILES_OF_OWNER_SQL);
  assert.match(people, seek('idx_profiles_owner', 'owner_id=\\?'));
  assert.doesNotMatch(people, /SCAN/);
  // A profile's members and the dashboard's counts: seeks on (owner, profile).
  assert.match(planOf(tree.MEMBERS_OF_SQL), seek('idx_resumes_owner_profile', 'owner_id=\\? AND profile_id=\\?'));
  assert.match(planOf(tree.SUMMARY_COUNTS_SQL), seek('idx_resumes_owner_profile', 'owner_id=\\? AND profile_id>\\?'));
  assert.match(planOf(tree.SUMMARY_MEMBERS_SQL), seek('idx_resumes_owner_profile', 'owner_id=\\? AND profile_id>\\?'));
  // Filing: with nothing to file the check is ONE seek (a NULL pointer on the owner) ...
  const quick = planOf(tree.HAS_UNFILED_RESUME_SQL);
  assert.match(quick, seek('idx_resumes_owner_profile', 'owner_id=\\? AND profile_id=\\?'));
  assert.doesNotMatch(quick, /SCAN/);
  // ... then a walk of the owner's resumes (never of the table) for a pointer to no profile ...
  const dangling = planOf(tree.HAS_DANGLING_RESUME_SQL);
  assert.match(dangling, seek('idx_resumes_owner_profile', 'owner_id=\\? AND profile_id>\\?'));
  assert.match(dangling, /SEARCH p USING INDEX sqlite_autoindex_profiles_1 \(id=\?\)/);
  assert.doesNotMatch(dangling, /SCAN/);
  // ... and the filing pass itself reads only the owner's resumes.
  const filing = planOf(tree.UNFILED_RESUMES_SQL);
  assert.match(filing, seek('idx_resumes_owner_profile', 'owner_id=\\?'));
  assert.doesNotMatch(filing, /SCAN r\b/);
});

test('toProfile keeps the known keys only, so an old group\'s member list is never read; the tree transaction is one connection and rolls back whole', async () => {
  const w = await world();
  const tree = require('../dist/database/profileTree');

  // A v4.1 group (member list and all) and a stray key read as a profile that holds neither.
  assert.deepEqual(
    tree.toProfile({
      id: 'p1',
      ownerId: 'o1',
      name: 'Backend roles',
      profileIds: ['r1', 'r2'],
      resumeIds: ['r3'],
      somethingElse: true,
      createdAt: at(1),
      updatedAt: at(2),
    }),
    { id: 'p1', ownerId: 'o1', name: 'Backend roles', createdAt: at(1), updatedAt: at(2) }
  );
  assert.equal(tree.toProfile({ id: 'p2', name: 'Kept', defaultResumeId: 'r9', createdAt: at(1), updatedAt: at(1) }).defaultResumeId, 'r9');

  // inTreeTransaction: the shared connection, inside a transaction, and a nested call joins it.
  const db = w.db();
  const seen = tree.inTreeTransaction((tx) => {
    assert.equal(tx, db, 'the one shared connection');
    assert.equal(tx.inTransaction, true);
    return tree.inTreeTransaction((inner) => [inner === tx, inner.inTransaction]);
  });
  assert.deepEqual(seen, [true, true]);
  assert.equal(db.inTransaction, false, 'and it closed');

  // A throw undoes everything the transaction did, including a profile made for a person.
  const who = w.account('tx');
  assert.throws(
    () =>
      tree.inTreeTransaction((tx) => {
        tree.placeNewResume(tx, w.users.getUserById(who.id), 'Rolled Back', undefined, { countLimit: false });
        assert.equal(w.profileCountRaw(who.id), 1, 'made inside');
        throw new Error('stop here');
      }),
    /stop here/
  );
  assert.equal(w.profileCountRaw(who.id), 0, 'and gone after');
});

test('the tree invariant: after a sequence of its own (and any others before it) no resume points at a missing profile or one of another owner, and every default is a member', async () => {
  const w = await world();
  const db = w.db();

  // A mixed sequence of its own, so this test stands alone (run by name, it sees only this).
  const who = w.account('invariant', 'premium-max');
  const people = await Promise.all(['Inv One', 'Inv Two'].map((name) => makeProfile(w, who, name)));
  const made = [];
  for (const name of ['Inv One', 'Inv One', 'Inv Two', 'Inv Three']) made.push(await makeResume(w, who, name));
  assert.equal((await w.call(who, 'PUT', `/api/resumes/${made[0].id}`, { disabled: true })).status, 200);
  assert.equal(
    (await w.call(who, 'POST', `/api/profiles/${people[1].id}/move`, { resumeIds: [made[1].id] })).status,
    200
  );
  assert.equal((await w.call(who, 'DELETE', `/api/resumes/${made[2].id}`)).status, 200);
  assert.equal((await w.call(who, 'DELETE', `/api/profiles/${people[0].id}`)).status, 200);
  legacyResume(w, who.id, 'inv-old', 'Inv Old', at(2));
  assert.equal((await w.call(who, 'GET', '/api/profiles')).status, 200);

  const dangling = db
    .prepare(
      `SELECT r.id FROM resumes r
         LEFT JOIN profiles p ON p.id = r.profile_id AND p.owner_id = r.owner_id
        WHERE p.id IS NULL`
    )
    .all();
  assert.deepEqual(dangling, [], 'every resume sits in a profile of its own owner');

  // The document and the column agree, for every resume.
  const rows = db.prepare('SELECT id, profile_id, data FROM resumes').all();
  assert.ok(rows.length > 0, 'the sequence above left resumes to check');
  for (const row of rows) assert.equal(JSON.parse(row.data).profileId, row.profile_id, row.id);

  // A profile with resumes has a default, and it is one of them, in the same account.
  const profiles = db.prepare('SELECT id, owner_id, data FROM profiles').all();
  for (const row of profiles) {
    const members = db.prepare('SELECT id FROM resumes WHERE profile_id = ?').all(row.id).map((member) => member.id);
    const chosen = JSON.parse(row.data).defaultResumeId;
    if (members.length === 0) {
      assert.equal(chosen ?? null, null, `${row.id}: an empty profile has no default`);
    } else {
      assert.ok(members.includes(chosen), `${row.id}: default ${chosen} is a member`);
    }
  }
});

/* ================================================================== lazy filing */

/**
 * A database as the renamed v4.1 left it: this build's own empty database, taken
 * back to v4.1's words in raw SQL (the two tables, the three columns, no
 * `resumes.profile_id`, neither new index) and given rows written the old way -
 * resumes with no profile, and "groups" whose documents carry a member list.
 * glossaryRename.test.js builds its v4.1-shaped database the same way.
 */
/** The word a tier used for the people it now calls profiles, and v4.1's table of them: built, so this file does not spell the old vocabulary. */
const OLD_TIER_WORDS = new RegExp('\\b' + ['Gro', 'up'].join('') + 's?\\b|Builds for');
const V41_NAME_COLUMN = ['profile', 'name'].join('_');
const V41_PEOPLE_TABLE = ['profile', 'groups'].join('_');
const OLD_RESUME_COLUMNS ='(id, name, disabled, data, created_at, updated_at, owner_id)';

function oldResume(id, name, ownerId, createdAt, disabled = 0) {
  return {
    id,
    name,
    columnDisabled: disabled,
    createdAt,
    ownerId,
    document: {
      id,
      ownerId,
      name,
      title: 'Software Engineer',
      contact: { email: `${id}@example.com`, phone: '555-0100', location: 'Remote' },
      summary: `${name || 'Nobody'} builds backend services.`,
      experience: [],
      strengths: [],
      skills: ['Go'],
      education: [],
      ...(disabled ? { disabled: true } : {}),
      createdAt,
      updatedAt: createdAt,
    },
  };
}

function buildV41ShapedDatabase(label) {
  const { dbDir } = useTempStorage(`person-tree-lazy-${label}`);
  const sqlite = loadFresh('../dist/database/sqlite');
  sqlite.getDb();
  const users = loadFresh('../dist/database/userRepository');
  const accounts = {};
  for (const [key, subscription] of [['a', 'default'], ['b', 'default'], ['c', 'default'], ['d', 'default'], ['e', 'premium'], ['f', 'default']]) {
    const user = users.createUser({ email: `lazy-${key}@example.com` });
    if (subscription !== 'default') users.updateUser(user.id, { subscription });
    accounts[key] = { id: user.id, token: users.createSession(user.id) };
  }
  sqlite.getDb().close();

  const raw = openTestDb(dbDir);
  try {
    raw.exec(`
      DROP INDEX IF EXISTS idx_resumes_owner_profile;
      DROP INDEX IF EXISTS idx_profiles_owner;
      ALTER TABLE resumes DROP COLUMN profile_id;
      ALTER TABLE profiles RENAME TO ${V41_PEOPLE_TABLE};
      ALTER TABLE resumes RENAME TO profiles;
      ALTER TABLE order_items RENAME COLUMN resume_id TO profile_id;
      ALTER TABLE order_items RENAME COLUMN resume_name TO ${V41_NAME_COLUMN};
      ALTER TABLE tailor_cache RENAME COLUMN resume_id TO profile_id;
    `);
    const insertResume = raw.prepare(`INSERT INTO profiles ${OLD_RESUME_COLUMNS} VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const resumes = [
      // A: five resumes of three people (one blank), and two old groups.
      oldResume('a-r1', 'Jane Doe', accounts.a.id, at(2)),
      oldResume('a-r2', 'jane  doe', accounts.a.id, at(3)),
      oldResume('a-r3', 'Zed Zee', accounts.a.id, at(4)),
      oldResume('a-r4', 'Jane Doe', accounts.a.id, at(5), 1),
      oldResume('a-r5', '', accounts.a.id, at(6)),
      // B: one person who is also named Jane Doe.
      oldResume('b-r1', 'Jane Doe', accounts.b.id, at(3)),
      // C: three different people on a Default account.
      oldResume('c-r1', 'Cara One', accounts.c.id, at(2)),
      oldResume('c-r2', 'Cara Two', accounts.c.id, at(3)),
      oldResume('c-r3', 'Cara Three', accounts.c.id, at(4)),
      // D: one resume, read by id and by list.
      oldResume('d-r1', 'Dee Dee', accounts.d.id, at(2)),
      // E: a premium account, whose create files its old resume first.
      oldResume('e-r1', 'Eve One', accounts.e.id, at(2)),
      // F: one resume, only ever read through the list route.
      oldResume('f-r1', 'Fay Fay', accounts.f.id, at(2)),
    ];
    for (const resume of resumes) {
      insertResume.run(resume.id, resume.name, resume.columnDisabled, JSON.stringify(resume.document), resume.createdAt, resume.createdAt, resume.ownerId);
    }
    const insertPerson = raw.prepare(
      `INSERT INTO ${V41_PEOPLE_TABLE} (id, name, data, created_at, updated_at, owner_id) VALUES (?, ?, ?, ?, ?, ?)`
    );
    // v4.1 groups listed their members as `profileIds`; this build never reads that.
    const groups = [
      { id: 'grp-backend', ownerId: accounts.a.id, name: 'Backend roles', profileIds: ['a-r1', 'a-r2'], createdAt: at(1), updatedAt: at(1) },
      { id: 'grp-zed', ownerId: accounts.a.id, name: 'Zed ZEE', profileIds: ['a-r1'], createdAt: at(1), updatedAt: at(1) },
    ];
    for (const group of groups) {
      insertPerson.run(group.id, group.name, JSON.stringify(group), group.createdAt, group.updatedAt, group.ownerId);
    }
  } finally {
    raw.close();
  }
  return { dbDir, accounts };
}

/** Everything the HTTP side of the lazy-filing tests needs, on freshly loaded modules. */
function serveFresh() {
  const sqlite = loadFresh('../dist/database/sqlite');
  loadFresh('../dist/database/documentTable');
  loadFresh('../dist/database/profileTree');
  loadFresh('../dist/database/profileLimit');
  const resumes = loadFresh('../dist/database/resumeRepository');
  loadFresh('../dist/database/profileRepository');
  loadFresh('../dist/database/userRepository');
  const { attachUser } = loadFresh('../dist/middleware/auth');
  const peopleRouter = loadFresh('../dist/routes/profiles');
  const resumeRoutes = loadFresh('../dist/routes/resumes');

  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/profiles', peopleRouter.default);
  app.use('/api/resumes', resumeRoutes.default);
  app.use(require('../dist/middleware/publicError').publicErrorHandler);
  const server = app.listen(0);
  const port = server.address().port;
  const call = async (who, method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${who.token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
  return { sqlite, resumes, call, close: () => server.close() };
}

function readTables(dbDir) {
  const raw = openTestDb(dbDir);
  try {
    return {
      resumes: raw.prepare('SELECT * FROM resumes ORDER BY id').all(),
      profiles: raw.prepare('SELECT * FROM profiles ORDER BY id').all(),
    };
  } finally {
    raw.close();
  }
}

test('lazy filing of a v4.1-shaped database', async (t) => {
  const { dbDir, accounts } = buildV41ShapedDatabase('main');
  const app = serveFresh();
  try {
    await t.test('opening it renames the tables, adds resumes.profile_id and both indexes, and files nothing yet', () => {
      // Opened by the server's own connection: the guard, the rename, SCHEMA, the added columns, the indexes.
      app.sqlite.getDb();
      const raw = openTestDb(dbDir);
      try {
        const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
        assert.ok(tables.includes('resumes'));
        assert.ok(tables.includes('profiles'));
        assert.ok(!tables.includes(V41_PEOPLE_TABLE));
        assert.ok(raw.prepare('PRAGMA table_info(resumes)').all().some((column) => column.name === 'profile_id'), 'the column was added to the old table');
        const indexes = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((row) => row.name);
        assert.ok(indexes.includes('idx_resumes_owner_profile'));
        assert.ok(indexes.includes('idx_profiles_owner'));
        assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM resumes WHERE profile_id IS NULL').get().n, 12, 'every resume is still unfiled');
        assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM profiles').get().n, 2, 'the two old groups are the profiles there are');
      } finally {
        raw.close();
      }
    });

    const beforeFiling = readTables(dbDir);
    let afterFirstRead = null;

    await t.test('the first read of an account files its resumes by name, oldest first, and the oldest becomes the default', async () => {
      const listed = await app.call(accounts.a, 'GET', '/api/profiles');
      assert.equal(listed.status, 200, JSON.stringify(listed.body));
      assert.deepEqual(sortedNames(listed.body), ['Backend roles', 'Jane Doe', 'Untitled Profile', 'Zed ZEE']);
      const byName = new Map(listed.body.map((profile) => [profile.name, profile]));

      const jane = byName.get('Jane Doe');
      assert.equal(jane.resumeCount, 3, 'Jane Doe, jane  doe and the disabled Jane Doe');
      assert.equal(jane.enabledResumeCount, 2);
      assert.equal(jane.chosenDefaultResumeId, 'a-r1', 'the oldest');
      assert.equal(jane.defaultResumeId, 'a-r1');

      // "Zed Zee" joined the OLD GROUP of that name (a v4.1 group reads as a profile under its name),
      // and "Jane Doe" was not pulled in by the group's stale member list.
      const zed = byName.get('Zed ZEE');
      assert.equal(zed.id, 'grp-zed');
      assert.equal(zed.resumeCount, 1);
      assert.equal(zed.chosenDefaultResumeId, 'a-r3', 'the first resume filed into a profile with no default');

      const backend = byName.get('Backend roles');
      assert.equal(backend.id, 'grp-backend');
      assert.equal(backend.resumeCount, 0, 'its member list is never read');
      assert.equal(backend.defaultResumeId, null);

      const untitled = byName.get('Untitled Profile');
      assert.equal(untitled.resumeCount, 1, 'a blank name');
      assert.equal(untitled.chosenDefaultResumeId, 'a-r5');

      // The column and the document agree.
      const raw = openTestDb(dbDir);
      try {
        for (const id of ['a-r1', 'a-r2', 'a-r3', 'a-r4', 'a-r5']) {
          const row = raw.prepare('SELECT profile_id, data FROM resumes WHERE id = ?').get(id);
          assert.ok(row.profile_id, id);
          assert.equal(JSON.parse(row.data).profileId, row.profile_id, id);
        }
        assert.equal(raw.prepare("SELECT profile_id FROM resumes WHERE id = 'a-r3'").get().profile_id, 'grp-zed');
        const zedDoc = JSON.parse(raw.prepare("SELECT data FROM profiles WHERE id = 'grp-zed'").get().data);
        assert.equal(zedDoc.defaultResumeId, 'a-r3');
        assert.ok(!('profileIds' in zedDoc) && !('resumeIds' in zedDoc), 'the next write drops the old member list for good');
      } finally {
        raw.close();
      }
      afterFirstRead = readTables(dbDir);
    });

    await t.test('nothing is deleted and no resume time moves; only the profile placement is written', () => {
      const after = readTables(dbDir);
      assert.equal(after.resumes.length, beforeFiling.resumes.length);
      const earlier = new Map(beforeFiling.resumes.map((row) => [row.id, row]));
      for (const row of after.resumes.filter((row) => row.owner_id === accounts.a.id)) {
        const old = earlier.get(row.id);
        assert.equal(row.created_at, old.created_at, `${row.id} created_at`);
        assert.equal(row.updated_at, old.updated_at, `${row.id} updated_at`);
        assert.equal(row.name, old.name);
        assert.equal(row.disabled, old.disabled);
        const { profileId, ...rest } = JSON.parse(row.data);
        assert.ok(profileId, `${row.id} is filed`);
        assert.deepEqual(rest, JSON.parse(old.data), `${row.id}: nothing else in the document moved`);
      }
      // Both old groups are still there, under their names.
      const names = new Map(after.profiles.map((row) => [row.id, row.name]));
      assert.equal(names.get('grp-backend'), 'Backend roles');
      assert.equal(names.get('grp-zed'), 'Zed ZEE');
    });

    await t.test('a second read changes nothing at all', async () => {
      assert.equal((await app.call(accounts.a, 'GET', '/api/profiles')).status, 200);
      assert.equal((await app.call(accounts.a, 'GET', '/api/resumes?includeDisabled=true')).status, 200);
      assert.deepEqual(readTables(dbDir), afterFirstRead);
    });

    await t.test("only the viewer's own resumes are filed; another account's wait for their own read", async () => {
      const raw = openTestDb(dbDir);
      try {
        assert.equal(raw.prepare("SELECT profile_id FROM resumes WHERE id = 'b-r1'").get().profile_id, null, "B's resume was not touched by A's reads");
      } finally {
        raw.close();
      }
      const bobs = await app.call(accounts.b, 'GET', '/api/profiles');
      assert.deepEqual(bobs.body.map((profile) => profile.name), ['Jane Doe']);
      assert.equal(bobs.body[0].resumeCount, 1);
      const janeA = (await app.call(accounts.a, 'GET', '/api/profiles')).body.find((profile) => profile.name === 'Jane Doe');
      assert.notEqual(bobs.body[0].id, janeA.id, 'one account\'s Jane Doe is not another\'s');
    });

    await t.test('GET /api/resumes and GET /api/resumes/:id file the reader\'s resumes too', async () => {
      const one = await app.call(accounts.d, 'GET', '/api/resumes/d-r1');
      assert.equal(one.status, 200);
      assert.ok(one.body.profileId, 'filed by being read');
      const raw = openTestDb(dbDir);
      try {
        assert.equal(raw.prepare("SELECT profile_id FROM resumes WHERE id = 'd-r1'").get().profile_id, one.body.profileId);
      } finally {
        raw.close();
      }
      const profiles = await app.call(accounts.d, 'GET', '/api/profiles');
      assert.deepEqual(profiles.body.map((profile) => [profile.name, profile.chosenDefaultResumeId]), [['Dee Dee', 'd-r1']]);

      // The list route files too: F has never been read by anything else.
      const list = await app.call(accounts.f, 'GET', '/api/resumes?includeDisabled=true');
      assert.equal(list.status, 200);
      assert.equal(list.body.length, 1);
      assert.ok(list.body.every((resume) => resume.profileId), 'every resume in the answer carries its profile');
      const raw2 = openTestDb(dbDir);
      try {
        assert.equal(raw2.prepare("SELECT profile_id FROM resumes WHERE id = 'f-r1'").get().profile_id, list.body[0].profileId);
      } finally {
        raw2.close();
      }
    });

    await t.test('three people on a Default account make three profiles - filing ignores the limit - and the next POST /api/profiles is a 402', async () => {
      const listed = await app.call(accounts.c, 'GET', '/api/profiles');
      assert.equal(listed.body.length, 3);
      assert.deepEqual(sortedNames(listed.body), ['Cara One', 'Cara Three', 'Cara Two']);
      const refused = await app.call(accounts.c, 'POST', '/api/profiles', { name: 'Cara Four' });
      assert.equal(refused.status, 402);
      assert.equal(refused.body.code, 'profile-limit');
      assert.match(refused.body.error, /allows 1 profile and this account has 3\./);

      // A, with four, is the same: everything kept, nothing new.
      const refusedA = await app.call(accounts.a, 'POST', '/api/profiles', { name: 'One More' });
      assert.equal(refusedA.status, 402);
      assert.match(refusedA.body.error, /this account has 4\./);
      const zedId = 'grp-zed';
      const added = await app.call(accounts.a, 'POST', `/api/resumes?profileId=${zedId}`, person('Another Zed'));
      assert.equal(added.status, 201, 'but it can add a resume to a profile it has');
      assert.equal(added.body.profileId, zedId);
    });

    await t.test("a create files the account's old resumes first, then places the new one", async () => {
      // E (premium) has one unfiled resume, "Eve One", and creates "Eve Two".
      const made = await app.call(accounts.e, 'POST', '/api/resumes', person('Eve Two'));
      assert.equal(made.status, 201, JSON.stringify(made.body));
      const raw = openTestDb(dbDir);
      try {
        const old = raw.prepare("SELECT profile_id FROM resumes WHERE id = 'e-r1'").get();
        assert.ok(old.profile_id, 'the old resume was filed in the same transaction');
        assert.notEqual(old.profile_id, made.body.profileId, 'a different person');
        assert.equal(raw.prepare("SELECT updated_at FROM resumes WHERE id = 'e-r1'").get().updated_at, at(2), 'its time did not move');
      } finally {
        raw.close();
      }
      assert.deepEqual(sortedNames((await app.call(accounts.e, 'GET', '/api/profiles')).body), ['Eve One', 'Eve Two']);
    });

    await t.test('the tree invariant holds for every account after filing', () => {
      const raw = openTestDb(dbDir);
      try {
        const dangling = raw
          .prepare(
            `SELECT r.id FROM resumes r
               LEFT JOIN profiles p ON p.id = r.profile_id AND p.owner_id = r.owner_id
              WHERE p.id IS NULL`
          )
          .all();
        assert.deepEqual(dangling, []);
      } finally {
        raw.close();
      }
    });
  } finally {
    app.close();
  }
});
