const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { captureErrorLog, useAdminEmails, useTempStorage } = require('./helpers');

/**
 * Write Entry Bullets: the resume editor's Write with AI / Improve with AI,
 * `POST /api/resumes/entries/bullets` (services/entryBullets.ts).
 *
 *   - the prompt is given exactly its four variables - the entry as typed,
 *     five facts about the person (never contact details), the code's task
 *     sentence and the person's note ('' when none);
 *   - a refusal about the entry is specific and by code: the kind, the task,
 *     an entry with nothing that names it, an Improve with nothing to improve;
 *   - the answer is held to a tailoring's rule: bold tags out, dashes
 *     backstopped, employer-voiced sentences dropped, repeats gone, at most
 *     eight bullets of at most 300 characters;
 *   - a reporter is refused by role before any model is asked, and so is
 *     somebody signed out; a second call for the same account while one runs
 *     is 409 and another account's goes through; every seat locked is the
 *     AI-unavailable sentence with no ref; an unparsable answer is the generic
 *     sentence with a ref and the cause in the log;
 *   - nothing is written and no credit moves - the editor holds the bullets
 *     until the person saves.
 */

const SHIPPED = path.join(__dirname, '..', 'static');
const CALL_SITE = 'write-entry-bullets';

function entry(extra = {}) {
  return {
    title: 'Senior DevOps Engineer',
    company: 'G2O',
    startDate: '12/2022',
    endDate: 'Present',
    location: 'Columbus, OH',
    description: 'Owns the Azure landing zones for client teams.',
    achievements: [],
    skills: ['Terraform', 'Azure'],
    ...extra,
  };
}

const RESUME_RECORD = {
  name: 'Samuel A',
  title: 'Senior DevOps Engineer',
  totalYearsExperience: 10,
  summary: 'Builds and supports cloud infrastructure.',
  skills: ['Terraform', 'Azure', 'AKS'],
  contact: { email: 'never@sent.example', phone: '000' },
  experience: [{ title: 'Not sent' }],
};

/** The three seats stubbed: one answer per call site, recorded, holdable. */
function stubSeats(ai) {
  ai.resetRegistryForTests();
  const state = { calls: [], answer: () => JSON.stringify({ bullets: ['Built the thing'] }), hold: null, release: null };
  state.holdNext = () => {
    state.hold = new Promise((resolve) => {
      state.release = resolve;
    });
  };
  for (const id of ['claude-cli', 'codex-cli', 'gemini-cli']) {
    ai.registerAdapter(id, () => ({
      id,
      capabilities: { id, label: 'stub', temperature: false, maxOutputTokens: false, nativeJsonMode: 'json-schema', systemBlocks: true, maxConcurrency: 8 },
      defaultModelName: () => `${id}-default`,
      health: async () => ({ ok: true, detail: 'stub', checkedAt: new Date().toISOString() }),
      async complete(request) {
        state.calls.push({ provider: id, ...request });
        if (request.callSite !== CALL_SITE) throw new Error(`stub seat: no answer for call site "${request.callSite}"`);
        if (state.hold) {
          const gate = state.hold;
          state.hold = null;
          await gate;
        }
        return { text: state.answer(request), resolvedModel: request.modelName, providerId: id, droppedParams: [], latencyMs: 1 };
      },
    }));
  }
  return state;
}

async function serve(name) {
  const { staticDir } = useTempStorage(`entry-bullets-${name}`);
  fs.cpSync(path.join(SHIPPED, 'prompts'), path.join(staticDir, 'prompts'), { recursive: true });
  fs.cpSync(path.join(SHIPPED, 'skills'), path.join(staticDir, 'skills'), { recursive: true });
  useAdminEmails('admin@example.com');
  delete process.env.AI_LOCKED_PROVIDERS;

  const ai = require('../dist/services/ai/index');
  const seats = stubSeats(ai);
  require('../dist/services/entryBullets').resetEntryBulletsForTests();

  const users = require('../dist/database/userRepository');
  const admin = users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  const bob = users.createUser({ email: 'bob@example.com' });
  const rita = users.createUser({ email: 'rita@example.com', role: 'reporter' });
  const tokens = {
    admin: users.createSession(admin.id),
    alice: users.createSession(alice.id),
    bob: users.createSession(bob.id),
    rita: users.createSession(rita.id),
  };

  const { attachUser } = require('../dist/middleware/auth');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(attachUser);
  app.use('/api/resumes', require('../dist/routes/resumes').default);
  const server = app.listen(0);
  const port = server.address().port;

  const call = async (who, body) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/resumes/entries/bullets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(who ? { authorization: `Bearer ${tokens[who]}` } : {}) },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: response.status, body: parsed };
  };
  return { call, seats, close: () => server.close(), users, alice, bob, rita };
}

const body = (extra = {}) => ({ kind: 'experience', entry: entry(), resume: RESUME_RECORD, task: 'write', ...extra });

/* -------------------------------------------------------- prompt values */

test('the prompt is given exactly its four variables: the entry as typed, five facts about the person, the task sentence, the note', () => {
  useTempStorage('entry-bullets-values');
  const bullets = require('../dist/services/entryBullets');

  const read = bullets.readEntryForBullets('experience', entry({ achievements: ['Cut provisioning time by 45%'] }));
  assert.deepEqual(read, {
    kind: 'experience',
    title: 'Senior DevOps Engineer',
    organization: 'G2O',
    startDate: '12/2022',
    endDate: 'Present',
    location: 'Columbus, OH',
    description: 'Owns the Azure landing zones for client teams.',
    bullets: ['Cut provisioning time by 45%'],
    skills: ['Terraform', 'Azure'],
  });
  // A project is its name and role; a volunteering entry its role and organisation.
  assert.deepEqual(
    bullets.readEntryForBullets('project', { name: 'Lakehouse', role: 'Lead', achievements: ['Fast'] }).title,
    'Lakehouse'
  );
  assert.equal(bullets.readEntryForBullets('project', { name: 'Lakehouse', role: 'Lead' }).organization, 'Lead');
  assert.equal(bullets.readEntryForBullets('volunteering', { role: 'Mentor', organization: 'Code Club' }).organization, 'Code Club');

  const resume = bullets.readResumeForBullets(RESUME_RECORD);
  assert.deepEqual(resume, {
    name: 'Samuel A',
    title: 'Senior DevOps Engineer',
    totalYearsExperience: 10,
    summary: 'Builds and supports cloud infrastructure.',
    skills: ['Terraform', 'Azure', 'AKS'],
  });

  const values = bullets.buildWriteEntryBulletsPromptValues(read, resume, 'write', '');
  assert.deepEqual(Object.keys(values).sort(), ['entryJson', 'instructions', 'profileJson', 'task']);
  assert.doesNotMatch(values.entryJson + values.profileJson, /never@sent|Not sent|000/);
  assert.equal(values.instructions, '');
  assert.match(values.task, /^Write 3 to 8 new bullets for this entry from the facts in it\. Its current bullets are notes/);
  assert.match(bullets.taskSentence('write', { ...read, bullets: [] }), /It has no bullets yet\.$/);
  assert.match(bullets.taskSentence('improve', read), /^Improve the entry's existing bullets: keep every fact and figure/);
  assert.equal(bullets.readBulletInstructions('  lead with  the cost savings  '), 'lead with the cost savings');
  assert.equal(bullets.readBulletInstructions('x'.repeat(600)).length, 500);
});

test('an entry with nothing that names it, a bad kind, a bad task and an Improve with no bullets are refused by code', () => {
  useTempStorage('entry-bullets-refusals');
  const bullets = require('../dist/services/entryBullets');
  const code = (fn) => {
    try {
      fn();
    } catch (error) {
      return `${error.status} ${error.code}: ${error.message}`;
    }
    return 'no error';
  };
  assert.equal(code(() => bullets.readEntryForBullets('education', {})), '400 bad-kind: kind must be experience, project or volunteering.');
  assert.equal(
    code(() => bullets.readEntryForBullets('experience', { title: ' ', company: '' })),
    '400 entry-incomplete: Give the role a title or a company before asking for bullets.'
  );
  assert.equal(code(() => bullets.readEntryForBullets('project', { role: 'Lead' })), '400 entry-incomplete: Give the project a name before asking for bullets.');
  assert.equal(
    code(() => bullets.readEntryForBullets('volunteering', {})),
    '400 entry-incomplete: Give the volunteering entry a role or an organisation before asking for bullets.'
  );
  const read = bullets.readEntryForBullets('experience', entry());
  assert.equal(code(() => bullets.readBulletsTask('rewrite', read)), '400 bad-task: task must be write or improve.');
  assert.equal(code(() => bullets.readBulletsTask('improve', read)), '400 nothing-to-improve: The entry has no bullets to improve yet. Choose Write instead.');
  assert.equal(bullets.readBulletsTask('improve', { ...read, bullets: ['One'] }), 'improve');
  // A title alone, or a company alone, is enough to write from.
  assert.equal(bullets.readEntryForBullets('experience', { title: 'Engineer' }).organization, '');
  assert.equal(bullets.readEntryForBullets('experience', { company: 'Acme' }).title, '');
});

/* ------------------------------------------------------------ the route */

test('a builder gets sanitised bullets back: bold out, dashes backstopped, an employer-voiced line dropped, repeats gone, eight at most, 300 characters each', async () => {
  const h = await serve('happy');
  try {
    h.seats.answer = () =>
      JSON.stringify({
        bullets: [
          'Built 80+ reusable <b>Terraform</b> modules for Azure networking and compute',
          'Cut provisioning time by 45% – a vetted starting point for every client team',
          'We shipped the landing zones together as a team',
          'Ran AKS clusters for client workloads with Helm charts and private ingress',
          'Ran AKS clusters for client workloads with Helm charts and private ingress',
          `Wrote ${'runbooks and documentation '.repeat(20)}for every client`,
          'Set up landing-zone guardrails for healthcare clients',
          'Built Log Analytics workspaces and alerts',
          'Paired with data consultants on Databricks environments',
          'Owned Azure DevOps pipeline templates for plan and apply',
          'Reviewed Azure spend with clients monthly',
        ],
      });
    const response = await h.call('alice', body({ instructions: 'Lead with the cost savings.' }));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const { bullets } = response.body;
    assert.ok(Array.isArray(bullets) && bullets.length === 8, `eight bullets, got ${bullets.length}`);
    assert.ok(bullets.every((bullet) => !/<b>|–/.test(bullet)), 'no bold tag and no em dash survive');
    assert.ok(bullets.every((bullet) => bullet.length <= 300), 'each at most 300 characters');
    assert.ok(!bullets.some((bullet) => /^We shipped/.test(bullet)), 'an employer-voiced line is dropped');
    assert.equal(new Set(bullets).size, bullets.length, 'no repeat');
    assert.equal(bullets[0], 'Built 80+ reusable Terraform modules for Azure networking and compute');
    // The dash backstop: a dash that is not a range (no digit on both sides)
    // becomes a comma, as in a tailored resume.
    assert.equal(bullets[1], 'Cut provisioning time by 45%, a vetted starting point for every client team');

    // The seat was asked once, on the app default model, with the entry and
    // the note in the prompt and nothing from the contact details.
    assert.equal(h.seats.calls.length, 1);
    const [call] = h.seats.calls;
    assert.equal(call.callSite, CALL_SITE);
    assert.equal(call.responseFormat, 'json');
    const prompt = `${call.stableSystem}\n${call.volatileSystem}\n${call.userBody}`;
    assert.match(prompt, /G2O/);
    assert.match(prompt, /Lead with the cost savings\./);
    assert.match(prompt, /It has no bullets yet\./, 'the task sentence');
    assert.doesNotMatch(prompt, /never@sent|Not sent/);
    // The shipped text's rules travel in the stable part, before the first variable.
    assert.match(call.stableSystem, /achievement bullets of ONE entry/);

    // Nothing stored.
    const { listResumesFor } = require('../dist/database/resumeRepository');
    assert.deepEqual(listResumesFor(h.alice, { includeDisabled: true }), []);
  } finally {
    h.close();
  }
});

test('a reporter and somebody signed out are refused before any model is asked; the refusals about the entry arrive by code', async () => {
  const h = await serve('access');
  try {
    const reporter = await h.call('rita', body());
    assert.equal(reporter.status, 403);
    assert.equal(reporter.body.code, 'role-not-allowed');
    const anonymous = await h.call(null, body());
    assert.equal(anonymous.status, 401);
    assert.equal(h.seats.calls.length, 0, 'no model asked');

    const incomplete = await h.call('alice', body({ entry: entry({ title: '', company: '' }) }));
    assert.equal(incomplete.status, 400);
    assert.deepEqual([incomplete.body.code, incomplete.body.error], ['entry-incomplete', 'Give the role a title or a company before asking for bullets.']);
    const improve = await h.call('alice', body({ task: 'improve' }));
    assert.deepEqual([improve.status, improve.body.code], [400, 'nothing-to-improve']);
    const kind = await h.call('alice', body({ kind: 'education' }));
    assert.deepEqual([kind.status, kind.body.code], [400, 'bad-kind']);
    const task = await h.call('alice', body({ task: 'rewrite' }));
    assert.deepEqual([task.status, task.body.code], [400, 'bad-task']);
    assert.equal(h.seats.calls.length, 0, 'a refusal never reaches the model');
  } finally {
    h.close();
  }
});

test('one call per account at a time: a second is 409 while the first runs, another account goes through', async () => {
  const h = await serve('one-at-a-time');
  try {
    h.seats.holdNext();
    const first = h.call('alice', body());
    // Let the first call reach the seat and be held there.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await h.call('alice', body());
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'already-running');
    assert.match(second.body.error, /already running for your account/);
    const other = await h.call('bob', body());
    assert.equal(other.status, 200, JSON.stringify(other.body));
    h.seats.release();
    const done = await first;
    assert.equal(done.status, 200, JSON.stringify(done.body));
    // And once it is done, the account may ask again.
    assert.equal((await h.call('alice', body())).status, 200);
  } finally {
    h.close();
  }
});

test('every seat locked is the AI-unavailable sentence with no ref; an unparsable answer is the generic sentence with a ref and the cause in the log', async () => {
  const h = await serve('failures');
  try {
    process.env.AI_LOCKED_PROVIDERS = 'claude-cli,codex-cli,gemini-cli';
    const locked = await h.call('alice', body());
    delete process.env.AI_LOCKED_PROVIDERS;
    assert.equal(locked.status, 503, JSON.stringify(locked.body));
    assert.equal(locked.body.code, 'ai-unavailable');
    // Its own sentence, not the route's fallback; a 5xx carries a ref, as every
    // public error of that status does (middleware/publicError).
    assert.doesNotMatch(locked.body.error, /Failed to write the bullets/);
    assert.match(locked.body.ref, /^ERR-[0-9A-F]{6}$/);
    assert.equal(h.seats.calls.length, 0);

    // The generic sentence, the ref beside it in the body (a stored error
    // would carry it in the text), and the cause under that ref in the log.
    const REF = /^ERR-[0-9A-F]{6}$/;
    const loggedUnder = (ref, lines) => lines.filter((line) => line.includes(`[error ${ref}]`)).join('\n');
    h.seats.answer = () => 'Sure! Here are some bullets: - built things - shipped things';
    const { result, lines } = await captureErrorLog(() => h.call('alice', body()));
    assert.equal(result.status, 500, JSON.stringify(result.body));
    assert.equal(result.body.error, 'Failed to write the bullets. Please try again, or contact your administrator.');
    assert.match(result.body.ref, REF);
    assert.match(loggedUnder(result.body.ref, lines), /POST \/api\/resumes\/entries\/bullets/);
    assert.match(loggedUnder(result.body.ref, lines), /not JSON|without a bullets list/);

    h.seats.answer = () => JSON.stringify({ bullets: ['<b></b>', '   '] });
    const empty = await captureErrorLog(() => h.call('alice', body()));
    assert.equal(empty.result.status, 500);
    assert.match(loggedUnder(empty.result.body.ref, empty.lines), /no usable bullets/);
  } finally {
    delete process.env.AI_LOCKED_PROVIDERS;
    h.close();
  }
});
