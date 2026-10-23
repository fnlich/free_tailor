const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

// Every seat is a counting stub here, and a failed resume is not retried: a
// refund is one of the cases. Both before any dist module loads.
process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli,codex-cli,gemini-cli';
process.env.GENERATION_MAX_ATTEMPTS = '1';

const { seedProfileWithResumes, storeJobAnalysis, useAdminEmails, useTempStorage, writeStaticJson } = require('./helpers');

/**
 * The three builder modes, end to end through the real routes and the real
 * queue (v4.2, F2; decisions 7, 8 and 10).
 *
 *   Choose Suitable Resume - the profile's best-matching resume for each job,
 *                            built AS WRITTEN. The only model call is the cover
 *                            letter, which every run writes.
 *   Partial Tailor         - the same pick, then the tailoring (the resume's
 *                            own Building prompt, else the built-in), and the
 *                            revise pass when it is due.
 *   Fully Tailor           - the profile's EFFECTIVE DEFAULT resume (the chosen
 *                            one while it is enabled, else the oldest enabled,
 *                            else the oldest), tailored by Tailor Resume
 *                            (Fully), then the revise pass.
 *
 * A run names exactly ONE profile, on every tier, administrators included.
 * The price is per mode, the same for every model, and a run costs exactly
 * jobs x the mode's price. The choice is made at submit, recorded on the
 * task's label and on the order item, and never made again.
 *
 * Written from the contract (C:/Users/Kelvin/.claude/plans/v42-materials/F2/
 * contract.md) and design F2.12, not from the implementation. The seats are
 * stubs that COUNT their calls per call site, the output writers are
 * recorders (nothing prints a PDF, so nothing starts a browser), and what a
 * "printed" resume says is read from the preview HTML rendered with the very
 * resume, template and tailored content the task handed the PDF writer.
 *
 * The fixture is the design's worked example: Jane Doe has a DEFAULT resume
 * ("Data Engineer", the oldest) and a "Backend Engineer" resume that is not
 * the default. A Go/Kubernetes backend posting is best matched by the
 * Backend resume; a Spark/Airflow data posting by the default. A third resume
 * is a disabled copy of the Backend one, newer than it: the one a matcher
 * that forgot to look at "enabled" would pick on a tie.
 */

const config = require('../dist/config/aiModelConfig');
const credits = require('../dist/services/credits');
const users = require('../dist/database/userRepository');
const orders = require('../dist/database/orderRepository');
const generationStore = require('../dist/database/generationRepository');
const queueModule = require('../dist/services/queue/index');

const SHIPPED = path.join(__dirname, '..', 'static');

/** Per resume, in thousandths of a dollar. Three different figures so a mixed-up mode is a different charge. */
const PRICES = { suitable: 10, partial: 30, full: 20 };
const LABELS = { suitable: 'Choose Suitable Resume', partial: 'Partial Tailor', full: 'Fully Tailor' };
const DOLLARS = { suitable: '0.010', partial: '0.030', full: '0.020' };

const ONE_PROFILE = 'Choose one profile to build for.';
const MARKERS = '[[jobAnalysisJson]]\nHead the soft skills [[softSkillGroupHeading]].';

/* ----------------------------------------------------------------- the seats */

/**
 * Every seat, counting, answering each prompt BY ITS CALL SITE. The tailoring
 * answer names the prompt that was asked (`TAILORED-BY-partial`, `-variant` for
 * the resume's own Building prompt, `-full`), so what a built resume says shows
 * which prompt wrote it. A call site it does not know fails loudly.
 */
function countingSeats(ai) {
  ai.resetRegistryForTests();
  const state = { calls: [], holdTailoring: false };
  const bySite = (site) => () => state.calls.filter((call) => call.callSite === site);
  state.tailorings = bySite('tailor-resume');
  state.revisions = bySite('revise-resume-coverage');
  state.letters = bySite('generate-cover-letter');
  state.others = () =>
    state.calls.filter(
      (call) => !['tailor-resume', 'revise-resume-coverage', 'generate-cover-letter'].includes(call.callSite)
    );

  for (const id of ['claude-cli', 'codex-cli', 'gemini-cli']) {
    ai.registerAdapter(id, () => ({
      id,
      capabilities: {
        id, label: 'stub', temperature: false, maxOutputTokens: false,
        nativeJsonMode: 'json-schema', systemBlocks: true, maxConcurrency: 8,
      },
      defaultModelName: () => `${id}-default`,
      health: async () => ({ ok: true, detail: 'stub', checkedAt: new Date().toISOString() }),
      async complete(request) {
        state.calls.push({ ...request, adapterId: id });
        const reply = (text) => ({
          text, resolvedModel: request.modelName, providerId: id, droppedParams: [], latencyMs: 1,
        });
        if (request.callSite === 'tailor-resume') {
          // A process that dies mid-tailoring: the call never answers.
          if (state.holdTailoring) await new Promise(() => {});
          const asked = `${request.stableSystem ?? ''}\n${request.userBody ?? ''}`;
          const which = /FULLY PROMPT/.test(asked) ? 'full' : /MY VARIANT/.test(asked) ? 'variant' : 'partial';
          return reply(
            JSON.stringify({
              title: 'Engineer',
              summary: `TAILORED-BY-${which}`,
              experience: [],
              skillGroups: [{ category: 'Languages', skills: ['Go'] }],
              coverLetter: `LETTER-WRITTEN-WITH-TAILORING-${which}`,
            })
          );
        }
        if (request.callSite === 'revise-resume-coverage') return reply('{}');
        if (request.callSite === 'generate-cover-letter') return reply('LETTER-BODY-FROM-LETTER-CALL');
        throw new Error(`stub seat: no answer for call site "${request.callSite}"`);
      },
    }));
  }
  return state;
}

/** What a request sent the model, as one string. */
const sent = (request) => `${request.stableSystem ?? ''}\n${request.userBody ?? ''}`;

/**
 * Swaps what would print a file or touch the output directory for recorders.
 * `built` holds what each task handed the resume writer, with the HTML the
 * preview renderer draws from exactly that; `letters` the letters it saved.
 */
function installRecorders(rootDir) {
  const pdf = require('../dist/generators/pdfGenerator');
  const docx = require('../dist/generators/docxGenerator');
  const letterWriter = require('../dist/generators/coverLetterGenerator');
  const paths = require('../dist/utils/generatedPath');
  const render = pdf.generatePreviewHTML;
  const built = [];
  const letters = [];
  const swaps = [];
  const swap = (module, name, fake) => {
    swaps.push([module, name, module[name]]);
    module[name] = fake;
  };
  swap(paths, 'getGeneratedOutputPath', async () => ({ storagePathBase: 'x', absoluteDir: rootDir }));
  swap(letterWriter, 'saveCoverLetter', async (resume, body) => {
    letters.push({ resumeId: resume.id, body });
    return 'x/cover.pdf';
  });
  swap(letterWriter, 'saveCoverLetterDOCX', async () => 'x/cover.docx');
  swap(pdf, 'generateResumePDF', async (resume, template, tailoredContent, _path, companyName, role) => {
    built.push({
      resumeId: resume.id,
      companyName,
      role,
      tailored: Boolean(tailoredContent),
      tailoredSummary: tailoredContent?.summary,
      html: await render(resume, template, tailoredContent),
    });
    return 'x/resume.pdf';
  });
  swap(docx, 'generateResumeDOCX', async () => 'x/resume.docx');
  return {
    built,
    letters,
    restore: () => {
      for (const [module, name, original] of swaps.reverse()) module[name] = original;
    },
  };
}

/* ---------------------------------------------------------------- the fixture */

function resumeInput(id, extra = {}) {
  return {
    id,
    name: 'Jane Doe',
    title: 'Engineer',
    skills: [],
    contact: { email: 'jane@example.com', phone: '555-0100', location: 'Remote' },
    summary: 'A summary.',
    experience: [],
    strengths: [],
    education: [],
    ...extra,
  };
}

function roleOf(title, company, description) {
  return {
    title,
    company,
    startDate: '01/2019',
    endDate: 'Present',
    location: 'Remote',
    // The only place a figure stands: a tailoring that writes none leaves the
    // revise pass something to put back.
    description,
    achievements: [],
    skills: [],
  };
}

const POSTINGS = [
  {
    companyName: 'Acme Payments',
    role: 'Senior Backend Engineer',
    jobDescription: 'Posting one: a senior backend engineer to build Go microservices on Kubernetes for payments.',
    jobLink: 'https://jobs.example.com/acme-payments/1',
    analysis: {
      jobMeta: { title: 'Senior Backend Engineer', seniority: 'senior', industry: 'Fintech', department: 'Platform' },
      skills: {
        technical: ['distributed systems'], required: ['Go', 'Kubernetes'], preferred: [],
        tools: ['Docker'], soft: [], technologies: [],
      },
      technologies: ['Go', 'Kubernetes', 'gRPC', 'PostgreSQL', 'Docker'],
      keywords: { actionVerbs: [], buzzwords: [], mustInclude: ['Go', 'Kubernetes'] },
    },
  },
  {
    companyName: 'Datalake Inc',
    role: 'Data Engineer',
    jobDescription: 'Posting two: a data engineer to run Spark pipelines scheduled in Airflow on Kafka streams.',
    jobLink: 'https://jobs.example.com/datalake/2',
    analysis: {
      jobMeta: { title: 'Data Engineer', seniority: 'mid', industry: 'Analytics', department: 'Data' },
      skills: {
        technical: ['data pipelines'], required: ['Python', 'Apache Spark'], preferred: [],
        tools: ['dbt'], soft: [], technologies: [],
      },
      technologies: ['Python', 'Apache Spark', 'Airflow', 'Kafka'],
      keywords: { actionVerbs: [], buzzwords: [], mustInclude: ['Python', 'Apache Spark'] },
    },
  },
];

const DATA = 'res-data'; // Jane's default (the oldest) - Streamly
const BACKEND = 'res-backend'; // not the default - Ledgerly, the resume's own Building prompt
const DISABLED = 'res-backend-off'; // a newer, disabled copy of Backend

/**
 * A served install with the fixture: Alice (Default subscription) with Jane's
 * three resumes, Kim's three (the chosen default disabled), a person with
 * nothing enabled, an administrator with a profile of their own, and Bob's
 * profile for "somebody else's".
 */
async function serve(name, { balance = 1_000 } = {}) {
  const storage = useTempStorage(`build-modes-${name}`);
  fs.cpSync(path.join(SHIPPED, 'skills'), path.join(storage.staticDir, 'skills'), { recursive: true });
  fs.cpSync(path.join(SHIPPED, 'prompts'), path.join(storage.staticDir, 'prompts'), { recursive: true });
  fs.mkdirSync(path.join(storage.staticDir, 'templates'), { recursive: true });
  fs.copyFileSync(
    path.join(SHIPPED, 'templates', 'default.json'),
    path.join(storage.staticDir, 'templates', 'default.json')
  );
  const writePrompt = (id, content) =>
    writeStaticJson(storage.staticDir, `prompts/${id}.json`, {
      id,
      content,
      createdAt: '2026-10-21T00:00:00.000Z',
      updatedAt: '2026-10-21T00:00:00.000Z',
    });
  writePrompt('tailor-resume', `PARTIAL PROMPT.\n[[profileJson]]\n${MARKERS}`);
  writePrompt('tailor-resume-full', `FULLY PROMPT.\n[[profileJson]]\n${MARKERS}`);
  writePrompt('revise-resume-coverage', 'REVISE.\n[[draftJson]]\nMISSING [[missingTermsJson]]\nFIGURES [[figuresNote]]');
  writePrompt('generate-cover-letter', 'LETTER.\n[[profileJson]]\n[[companyName]] [[role]]');

  useAdminEmails('admin@example.com');
  config.invalidateSettingsCache();
  queueModule.resetGenerationQueueForTests();
  require('../dist/services/jobAnalysis/gate').resetAnalysisGateForTests();

  const ai = require('../dist/services/ai/index');
  const seats = countingSeats(ai);
  const recorders = installRecorders(storage.rootDir);

  const admin = users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  const bob = users.createUser({ email: 'bob@example.com' });
  credits.setBalance(alice.id, balance, admin.id);

  // The resume's own Building prompt: a Partial run uses it, a Fully run does not.
  const promptService = require('../dist/services/promptService');
  const variant = await promptService.createPrompt({
    name: 'Backend variant',
    featureKey: 'tailor-resume',
    content: `MY VARIANT.\n[[profileJson]]\n${MARKERS}`,
  });

  const janeSeed = seedProfileWithResumes(alice, 'Jane Doe', [
    resumeInput(DATA, {
      title: 'Data Engineer',
      summary: 'SUMMARY-DATA: builds batch and streaming pipelines.',
      skills: ['Python', 'Apache Spark', 'Airflow', 'Kafka'],
      experience: [roleOf('Data Engineer', 'Streamly', 'Ran the pipelines. Cut runtime from 3 hours to 20 minutes.')],
    }),
    resumeInput(BACKEND, {
      title: 'Backend Engineer',
      summary: 'SUMMARY-BACKEND: builds payment services.',
      skills: ['Go', 'Kubernetes', 'gRPC', 'PostgreSQL', 'Docker'],
      experience: [roleOf('Backend Engineer', 'Ledgerly', 'Owned the payment services. Cut deploys from 40 minutes to 6.')],
      resumeSettings: { resumePromptId: variant.id },
    }),
    resumeInput(DISABLED, {
      title: 'Backend Engineer',
      summary: 'SUMMARY-DISABLED: a copy that is switched off.',
      skills: ['Go', 'Kubernetes', 'gRPC', 'PostgreSQL', 'Docker'],
      experience: [roleOf('Backend Engineer', 'Ledgerly', 'Owned the payment services.')],
    }),
  ]);
  const { getResume, saveEditedResume } = require('../dist/database/resumeRepository');
  const switchOff = (id, owner) => saveEditedResume({ ...getResume(id), disabled: true }, owner.id);
  switchOff(DISABLED, alice);

  // Kim: the CHOSEN default (the oldest, Z) is disabled afterwards. The oldest
  // ENABLED one is X; Y is the newest.
  const kimInput = (id, title) =>
    resumeInput(id, { name: 'Kim Lee', title, summary: `SUMMARY-${id}`, experience: [roleOf(title, `Co-${id}`, '')] });
  const kimSeed = seedProfileWithResumes(alice, 'Kim Lee', [
    kimInput('kim-z', 'Role-Z Engineer'),
    kimInput('kim-x', 'Role-X Engineer'),
    kimInput('kim-y', 'Role-Y Engineer'),
  ]);
  require('../dist/database/profileRepository').updateProfileFor(alice, kimSeed.profileId, { defaultResumeId: 'kim-z' });
  switchOff('kim-z', alice);

  const emptySeed = seedProfileWithResumes(alice, 'Empty Person', [
    resumeInput('empty-1', { name: 'Empty Person', title: 'Nothing' }),
  ]);
  switchOff('empty-1', alice);

  const adminSeed = seedProfileWithResumes(admin, 'Admin Person', [
    resumeInput('admin-1', { name: 'Admin Person', title: 'Platform Engineer', skills: ['Go'] }),
  ]);
  const bobSeed = seedProfileWithResumes(bob, 'Bob Roe', [resumeInput('bob-1', { name: 'Bob Roe', title: 'Tester' })]);

  await config.updateAppSettings({
    suitablePriceUsd: DOLLARS.suitable,
    partialPriceUsd: DOLLARS.partial,
    fullPriceUsd: DOLLARS.full,
  });

  // The postings were analysed already (a job names its analysis by id), so the
  // run makes no analysis call and every call counted below is the build's own.
  const jobs = POSTINGS.map(({ analysis, ...job }) => ({
    ...job,
    analysisId: storeJobAnalysis(analysis, { jobDescription: job.jobDescription, jobLink: job.jobLink }),
  }));

  const tokens = {
    admin: users.createSession(admin.id),
    alice: users.createSession(alice.id),
    bob: users.createSession(bob.id),
  };
  const { attachUser } = require('../dist/middleware/auth');
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(attachUser);
  app.use('/api/generation', require('../dist/routes/generation').default);
  app.use('/api/resume', require('../dist/routes/resume').default);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;

  const batches = [];
  const send = (who, route, body) =>
    fetch(`${base}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[who]}` },
      body: JSON.stringify(body),
    });

  return {
    ...storage,
    admin,
    alice,
    bob,
    seats,
    built: recorders.built,
    savedLetters: recorders.letters,
    jobs,
    jane: janeSeed.profileId,
    kim: kimSeed.profileId,
    empty: emptySeed.profileId,
    adminProfile: adminSeed.profileId,
    bobProfile: bobSeed.profileId,
    variantId: variant.id,
    switchOff,
    post: async (who, route, body) => {
      const response = await send(who, route, body);
      const answer = { status: response.status, body: await response.json() };
      if (route === '/generation/batches' && answer.status === 202) batches.push(answer.body.batchId);
      return answer;
    },
    postRaw: async (who, route, body) => {
      const response = await send(who, route, body);
      return { status: response.status, text: await response.text() };
    },
    balance: (account) => users.getUserById(account.id).balanceMilli,
    ledger: (account, reason) => credits.getLedger(account.id, 500).filter((entry) => !reason || entry.reason === reason),
    queue: () => queueModule.getGenerationQueue(),
    /** Every batch the test queued, so `close` can let them finish before the recorders come off. */
    batches,
    /**
     * Lets whatever is still building finish BEFORE the recorders come off: a
     * task that outlived them would reach the real writers and start a browser.
     */
    close: async () => {
      try {
        for (const batchId of batches) {
          await until(() => {
            const snapshot = queueModule.getGenerationQueue().snapshot(batchId);
            return !snapshot || snapshot.state !== 'running';
          }, `batch ${batchId} to stop running`);
        }
      } catch (error) {
        console.warn(`[buildModes.test] ${error.message}`);
      } finally {
        server.close();
        recorders.restore();
        queueModule.resetGenerationQueueForTests();
        ai.resetRegistryForTests();
      }
    },
  };
}

/** A body that builds the fixture's job(s) for one profile, as an order unless it says otherwise. */
function run(h, extra = {}) {
  return { profileId: h.jane, jobs: h.jobs, mode: 'order', format: 'pdf', includeCoverLetterDocx: false, ...extra };
}

async function submit(h, who, body) {
  const response = await h.post(who, '/generation/batches', body);
  assert.equal(response.status, 202, JSON.stringify(response.body));
  return response.body;
}

async function until(condition, what, tries = 2_000) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function untilFinished(batchId) {
  let snapshot;
  await until(() => {
    snapshot = queueModule.getGenerationQueue().snapshot(batchId);
    return snapshot && snapshot.state !== 'running';
  }, `batch ${batchId} to finish`);
  return snapshot;
}

const done = (snapshot) => snapshot.tasks.filter((task) => task.state === 'done').length;
const tasksOf = (batchId) => queueModule.getGenerationQueue().getBatch(batchId).tasks;
const builtFor = (h, company) => h.built.find((entry) => entry.companyName === company);

/** The state after a quiet, successful run: nothing refunded, nothing failed. */
async function finishAll(h, batchId, count) {
  const snapshot = await untilFinished(batchId);
  assert.equal(done(snapshot), count, JSON.stringify(snapshot.tasks.map((task) => task.error)));
  return snapshot;
}

/** The process "dies" with tasks queued on disk: everything in memory goes. */
function crash(h) {
  queueModule.resetGenerationQueueForTests();
  require('../dist/services/jobAnalysis/gate').resetAnalysisGateForTests();
  config.invalidateSettingsCache();
}

/* ------------------------------------------------------- Choose Suitable Resume */

test('Suitable builds each job\'s best-matching resume as written: no tailoring call, one cover letter per resume, nothing tailored', async () => {
  const h = await serve('suitable');
  try {
    const { batchId, buildMode } = await submit(h, 'alice', run(h, { buildMode: 'suitable' }));
    assert.equal(buildMode, 'suitable');
    const snapshot = await finishAll(h, batchId, 2);

    // Not one tailoring, revision or analysis call: the letter is the only model call.
    assert.equal(h.seats.tailorings().length, 0, 'Suitable never tailors');
    assert.equal(h.seats.revisions().length, 0, 'and has nothing to revise');
    assert.equal(h.seats.others().length, 0, 'and analyses nothing that was analysed');
    assert.equal(h.seats.letters().length, 2, 'one cover letter per resume');
    assert.deepEqual(
      h.savedLetters.map((letter) => letter.body),
      ['LETTER-BODY-FROM-LETTER-CALL', 'LETTER-BODY-FROM-LETTER-CALL'].sort(),
      'the letter is the AI\'s'
    );

    // The best match for each job, NOT the profile's default, and never the disabled copy.
    const backend = builtFor(h, 'Acme Payments');
    const data = builtFor(h, 'Datalake Inc');
    assert.equal(backend.resumeId, BACKEND, 'the Go/Kubernetes posting gets the Backend resume, though Data is the default');
    assert.equal(data.resumeId, DATA, 'the Spark/Airflow posting gets the default, which also matched best');
    assert.ok(!h.built.some((entry) => entry.resumeId === DISABLED), 'a disabled resume is never chosen');

    // Printed as written: the chosen resume's own summary, nothing the model wrote.
    for (const entry of [backend, data]) {
      assert.equal(entry.tailored, false);
      assert.equal(entry.tailoredSummary, undefined);
      assert.doesNotMatch(entry.html, /TAILORED-BY/);
    }
    assert.match(backend.html, /SUMMARY-BACKEND/);
    assert.doesNotMatch(backend.html, /SUMMARY-DATA|SUMMARY-DISABLED/);
    assert.match(data.html, /SUMMARY-DATA/);
    assert.doesNotMatch(data.html, /SUMMARY-BACKEND|SUMMARY-DISABLED/);

    // The result says so too.
    const values = tasksOf(batchId).map((task) => task.value);
    assert.deepEqual(values.map((value) => value.tailored), [false, false]);
    assert.deepEqual(values.map((value) => value.resumeId), [BACKEND, DATA]);
    assert.equal(snapshot.tasks.length, 2);
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------- Partial Tailor */

test('Partial tailors the matched resume with its own Building prompt, then revises, and the tailoring brings the letter', async () => {
  const h = await serve('partial');
  try {
    const { batchId, buildMode } = await submit(h, 'alice', run(h, { buildMode: 'partial' }));
    assert.equal(buildMode, 'partial');
    await finishAll(h, batchId, 2);

    // One tailoring per job, on the matched resume: the Backend resume's own
    // variant, the Data resume's built-in. Partial sends the resume's own text.
    const tailorings = h.seats.tailorings();
    assert.equal(tailorings.length, 2);
    const forBackend = tailorings.find((call) => /Ledgerly/.test(sent(call)));
    const forData = tailorings.find((call) => /Streamly/.test(sent(call)));
    assert.ok(forBackend && forData, 'one tailoring for each matched resume');
    assert.match(sent(forBackend), /MY VARIANT/, 'the resume\'s own Building prompt');
    assert.doesNotMatch(sent(forBackend), /FULLY PROMPT|PARTIAL PROMPT/);
    assert.match(sent(forBackend), /SUMMARY-BACKEND/, 'Partial sends the resume\'s own summary');
    assert.match(sent(forData), /PARTIAL PROMPT/, 'a resume without one runs the built-in');
    assert.doesNotMatch(sent(forData), /MY VARIANT|FULLY PROMPT/);
    assert.match(sent(forData), /SUMMARY-DATA/);
    assert.ok(!tailorings.some((call) => /Ledgerly/.test(sent(call)) && /Streamly/.test(sent(call))));

    // Each answer dropped the figure its resume states ("40 minutes to 6",
    // "3 hours to 20 minutes"), so the revise pass runs once per resume.
    assert.equal(h.seats.revisions().length, 2, 'the revise pass follows a fresh Partial tailoring');
    // The tailoring brought a cover letter, so no letter call was made.
    assert.equal(h.seats.letters().length, 0);

    const backend = builtFor(h, 'Acme Payments');
    const data = builtFor(h, 'Datalake Inc');
    assert.equal(backend.resumeId, BACKEND);
    assert.equal(data.resumeId, DATA);
    assert.equal(backend.tailored, true);
    assert.equal(backend.tailoredSummary, 'TAILORED-BY-variant');
    assert.match(backend.html, /TAILORED-BY-variant/);
    assert.equal(data.tailoredSummary, 'TAILORED-BY-partial');
    assert.match(data.html, /TAILORED-BY-partial/);
    assert.deepEqual(
      h.savedLetters.map((letter) => letter.body).sort(),
      ['LETTER-WRITTEN-WITH-TAILORING-partial', 'LETTER-WRITTEN-WITH-TAILORING-variant']
    );
    assert.deepEqual(tasksOf(batchId).map((task) => task.value.tailored), [true, true]);
  } finally {
    await h.close();
  }
});

/* -------------------------------------------------------------- Fully Tailor */

test('Fully tailors the profile\'s default resume for every job, whatever matches best, with the Fully prompt and the revise pass', async () => {
  const h = await serve('full');
  try {
    const { batchId, buildMode } = await submit(h, 'alice', run(h, { buildMode: 'full' }));
    assert.equal(buildMode, 'full');
    await finishAll(h, batchId, 2);

    // Both jobs start from the default (Data), though the first matches Backend.
    assert.deepEqual(h.built.map((entry) => entry.resumeId), [DATA, DATA]);
    const tailorings = h.seats.tailorings();
    assert.equal(tailorings.length, 2);
    for (const call of tailorings) {
      assert.match(sent(call), /FULLY PROMPT/, 'Tailor Resume (Fully)');
      assert.doesNotMatch(sent(call), /PARTIAL PROMPT|MY VARIANT/);
      assert.match(sent(call), /Streamly/, 'the default resume\'s roles');
      assert.doesNotMatch(sent(call), /Ledgerly/);
      // Fully sends titles, companies and dates only: not the resume's own text.
      assert.doesNotMatch(sent(call), /SUMMARY-DATA|Cut runtime from 3 hours/);
    }
    // The whole checklist is asked for after a Fully draft.
    assert.equal(h.seats.revisions().length, 2);
    assert.deepEqual(h.built.map((entry) => entry.tailoredSummary), ['TAILORED-BY-full', 'TAILORED-BY-full']);
    for (const entry of h.built) assert.match(entry.html, /TAILORED-BY-full/);
    assert.equal(h.seats.letters().length, 0, 'the tailoring brought the letters');
    for (const task of tasksOf(batchId)) {
      assert.equal(task.payload.buildMode, 'full');
      assert.equal(task.label.match.reason, 'default', 'the default by rule, not by a score');
      assert.equal(task.label.match.mode, 'full');
    }
  } finally {
    await h.close();
  }
});

test('Fully on a profile whose chosen default is disabled starts from the oldest ENABLED resume; no mode picks the disabled one', async () => {
  const h = await serve('disabled-default');
  try {
    const one = [h.jobs[0]];
    const fully = await submit(h, 'alice', run(h, { profileId: h.kim, buildMode: 'full', jobs: one }));
    await finishAll(h, fully.batchId, 1);
    const [call] = h.seats.tailorings();
    // X is the oldest enabled; Z (the chosen default, and the oldest of all) is off.
    assert.match(sent(call), /Role-X Engineer/);
    assert.doesNotMatch(sent(call), /Role-Z Engineer|Role-Y Engineer/);
    assert.equal(h.built[0].resumeId, 'kim-x');
    assert.equal(tasksOf(fully.batchId)[0].label.resumeId, 'kim-x');
    assert.equal(tasksOf(fully.batchId)[0].label.match.reason, 'default');

    // Suitable and Partial choose among the ENABLED resumes only.
    for (const buildMode of ['suitable', 'partial']) {
      const before = h.built.length;
      const other = await submit(h, 'alice', run(h, { profileId: h.kim, buildMode, jobs: one }));
      await finishAll(h, other.batchId, 1);
      const chosen = h.built[before].resumeId;
      assert.ok(['kim-x', 'kim-y'].includes(chosen), `${buildMode} chose ${chosen}`);
      assert.equal(tasksOf(other.batchId)[0].label.match.candidates, 2, 'two enabled resumes to choose from');
    }

    // Enabling the chosen default again brings it back: the choice was kept.
    const { getResume, saveEditedResume } = require('../dist/database/resumeRepository');
    saveEditedResume({ ...getResume('kim-z'), disabled: false }, h.alice.id);
    const again = await submit(h, 'alice', run(h, { profileId: h.kim, buildMode: 'full', jobs: one }));
    await finishAll(h, again.batchId, 1);
    assert.equal(tasksOf(again.batchId)[0].label.resumeId, 'kim-z');
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------ labels and order items */

test('task labels, snapshots and order items carry resumeLabel, profileLabel and the match with its reason', async () => {
  const h = await serve('labels');
  try {
    const { batchId, orderId } = await submit(h, 'alice', run(h, { buildMode: 'partial' }));
    await finishAll(h, batchId, 2);

    const labels = tasksOf(batchId).map((task) => task.label);
    assert.deepEqual(labels.map((label) => label.resumeId), [BACKEND, DATA]);
    assert.deepEqual(labels.map((label) => label.resumeLabel), ['Backend Engineer', 'Data Engineer']);
    assert.deepEqual(labels.map((label) => label.profileLabel), ['Jane Doe', 'Jane Doe']);
    for (const label of labels) {
      assert.equal(label.match.v, 1);
      assert.equal(label.match.mode, 'partial');
      assert.equal(label.match.candidates, 2, 'two ENABLED resumes: the disabled copy is not counted');
      assert.equal(label.match.reason, 'matched', 'each won on its score');
    }
    assert.ok(labels[0].match.matched.length > 0 && labels[0].match.matched.length <= 8);
    assert.ok(labels[0].match.matched.some((term) => /^(Go|Kubernetes)$/.test(term)), 'it says what matched');

    // They reach the page in the snapshot the queue serves.
    const snapshot = queueModule.getGenerationQueue().snapshot(batchId);
    assert.deepEqual(snapshot.tasks.map((task) => task.resumeLabel), ['Backend Engineer', 'Data Engineer']);
    assert.deepEqual(snapshot.tasks.map((task) => task.profileLabel), ['Jane Doe', 'Jane Doe']);
    assert.deepEqual(snapshot.tasks.map((task) => task.match.reason), ['matched', 'matched']);

    // And the order item keeps them, for a receipt read long after the batch is gone.
    const items = orders.listOrderItems(orderId);
    assert.deepEqual(items.map((item) => item.resumeId), [BACKEND, DATA]);
    assert.deepEqual(items.map((item) => item.resumeLabel), ['Backend Engineer', 'Data Engineer']);
    assert.deepEqual(items.map((item) => item.profileLabel), ['Jane Doe', 'Jane Doe']);
    assert.deepEqual(items.map((item) => item.match.mode), ['partial', 'partial']);
    assert.deepEqual(items.map((item) => item.match.reason), ['matched', 'matched']);
    assert.deepEqual(items.map((item) => item.match.candidates), [2, 2]);
    assert.deepEqual(items.map((item) => item.costMilli), [PRICES.partial, PRICES.partial]);
    assert.deepEqual(items[0].match.matched, labels[0].match.matched);
  } finally {
    await h.close();
  }
});

test('Suitable and Fully label their items too: the mode on the match, and "default" for Fully', async () => {
  const h = await serve('labels-modes');
  try {
    const suitable = await submit(h, 'alice', run(h, { buildMode: 'suitable' }));
    const full = await submit(h, 'alice', run(h, { buildMode: 'full' }));
    await finishAll(h, suitable.batchId, 2);
    await finishAll(h, full.batchId, 2);

    const suitableItems = orders.listOrderItems(suitable.orderId);
    assert.deepEqual(suitableItems.map((item) => item.match.mode), ['suitable', 'suitable']);
    assert.deepEqual(suitableItems.map((item) => item.resumeId), [BACKEND, DATA]);
    const fullItems = orders.listOrderItems(full.orderId);
    assert.deepEqual(fullItems.map((item) => item.match.mode), ['full', 'full']);
    assert.deepEqual(fullItems.map((item) => item.match.reason), ['default', 'default']);
    assert.deepEqual(fullItems.map((item) => item.resumeLabel), ['Data Engineer', 'Data Engineer']);
    assert.deepEqual(fullItems.map((item) => item.profileLabel), ['Jane Doe', 'Jane Doe']);
  } finally {
    await h.close();
  }
});

test('a profile with ONE enabled resume builds it for every job, and says why ("only")', async () => {
  const h = await serve('only');
  try {
    // Admin Person has one resume: there is nothing to choose between.
    const own = await submit(h, 'admin', run(h, { profileId: h.adminProfile, buildMode: 'partial', jobs: [h.jobs[0]] }));
    await finishAll(h, own.batchId, 1);
    const label = tasksOf(own.batchId)[0].label;
    assert.equal(label.resumeId, 'admin-1');
    assert.equal(label.match.reason, 'only');
    assert.equal(label.match.candidates, 1);
  } finally {
    await h.close();
  }
});

test('an order item reads a damaged match as null, and keeps the rest', async () => {
  const h = await serve('junk-match');
  try {
    const { batchId, orderId } = await submit(h, 'alice', run(h, { buildMode: 'suitable' }));
    await finishAll(h, batchId, 2);
    const db = require('../dist/database/sqlite').getDb();
    db.prepare('UPDATE order_items SET match_json = ? WHERE order_id = ? AND seq = 0').run('{not json', orderId);
    db.prepare('UPDATE order_items SET match_json = ? WHERE order_id = ? AND seq = 1').run('"a string"', orderId);
    const items = orders.listOrderItems(orderId);
    assert.deepEqual(items.map((item) => item.match), [null, null]);
    assert.deepEqual(items.map((item) => item.resumeLabel), ['Backend Engineer', 'Data Engineer']);
    assert.deepEqual(items.map((item) => item.profileLabel), ['Jane Doe', 'Jane Doe']);
  } finally {
    await h.close();
  }
});

/* ----------------------------------------------- the 202, the label, the default */

test('the 202 names the mode, not a profile count; the order label reads "{N} job(s) for {profile}, {mode}"', async () => {
  const h = await serve('answer');
  try {
    const order = await submit(h, 'alice', run(h, { buildMode: 'partial' }));
    assert.deepEqual(Object.keys(order).sort(), ['batchId', 'buildMode', 'jobCount', 'kind', 'orderId', 'orderNumber', 'total']);
    assert.equal(order.kind, 'order');
    assert.equal(order.total, 2);
    assert.equal(order.jobCount, 2);
    assert.equal('profileCount' in order, false, 'no profile count: a run has one profile');
    assert.match(order.orderNumber, /^FT-\d{8}-\d{4}$/);
    assert.equal(orders.findOrderForBatch(order.batchId).label, '2 job(s) for Jane Doe, Partial Tailor');
    assert.equal(tasksOf(order.batchId).length, 2);
    assert.equal(queueModule.getGenerationQueue().getBatch(order.batchId).shared.buildMode, 'partial');

    for (const [buildMode, label] of Object.entries(LABELS)) {
      const other = await submit(h, 'alice', run(h, { buildMode, jobs: [h.jobs[1]] }));
      assert.equal(orders.findOrderForBatch(other.batchId).label, `1 job(s) for Jane Doe, ${label}`);
      assert.equal(other.buildMode, buildMode);
    }

    // A label the caller gave stays theirs.
    const named = await submit(h, 'alice', run(h, { buildMode: 'suitable', label: 'My own words', jobs: [h.jobs[1]] }));
    assert.equal(orders.findOrderForBatch(named.batchId).label, 'My own words');

    // An immediate run answers with no order, and an administrator also sees the lanes.
    const immediate = await submit(h, 'alice', run(h, { buildMode: 'suitable', mode: 'immediate', tabId: 'tab-a', jobs: [h.jobs[1]] }));
    assert.deepEqual(Object.keys(immediate).sort(), ['batchId', 'buildMode', 'jobCount', 'kind', 'total']);
    const asAdmin = await submit(h, 'admin', run(h, { profileId: h.adminProfile, buildMode: 'suitable', jobs: [h.jobs[1]] }));
    assert.ok('queues' in asAdmin);
    assert.equal('profileCount' in asAdmin, false);
    for (const batchId of [order.batchId, immediate.batchId, asAdmin.batchId]) await untilFinished(batchId);
  } finally {
    await h.close();
  }
});

test('a run that names no buildMode uses the administrator\'s default builder mode, now', async () => {
  const h = await serve('default-mode');
  try {
    const first = await submit(h, 'alice', run(h, { jobs: [h.jobs[1]] }));
    assert.equal(first.buildMode, 'partial', 'the code default');
    await config.updateAppSettings({ defaultBuildMode: 'suitable' });
    const second = await submit(h, 'alice', run(h, { jobs: [h.jobs[1]] }));
    assert.equal(second.buildMode, 'suitable');
    assert.equal(tasksOf(second.batchId)[0].payload.buildMode, 'suitable');
    assert.equal(tasksOf(second.batchId)[0].payload.costMilli, PRICES.suitable);
    const quote = await h.post('alice', '/generation/quote', { profileId: h.jane, jobs: [h.jobs[1]] });
    assert.equal(quote.status, 200);
    assert.equal(quote.body.buildMode, 'suitable');
    assert.equal(quote.body.costMilli, PRICES.suitable);
    await config.updateAppSettings({ defaultBuildMode: 'full' });
    const third = await submit(h, 'alice', run(h, { jobs: [h.jobs[1]] }));
    assert.equal(third.buildMode, 'full');
    for (const batchId of [first.batchId, second.batchId, third.batchId]) await untilFinished(batchId);
  } finally {
    await h.close();
  }
});

test('a model named in the request wins for the resume, and changes no price', async () => {
  const h = await serve('model-wins');
  try {
    const plain = await submit(h, 'alice', run(h, { buildMode: 'partial', jobs: [h.jobs[0]] }));
    await finishAll(h, plain.batchId, 1);
    assert.equal(tasksOf(plain.batchId)[0].payload.choice.provider, 'claude-cli', 'the app default');
    const priceWithout = tasksOf(plain.batchId)[0].payload.costMilli;

    const body = run(h, { buildMode: 'partial', model: 'codex-cli-default', jobs: [h.jobs[1]] });
    const quote = await h.post('alice', '/generation/quote', body);
    assert.equal(quote.body.costMilli, priceWithout, 'the model is not part of the price');
    const named = await submit(h, 'alice', body);
    await finishAll(h, named.batchId, 1);
    const [task] = tasksOf(named.batchId);
    assert.equal(task.payload.choice.provider, 'codex-cli');
    assert.equal(task.payload.costMilli, PRICES.partial);
    assert.equal(h.seats.tailorings().at(-1).adapterId, 'codex-cli', 'and the seat that answered');

    // Full and Suitable too: a model's price was a model's property and is gone.
    const quoteFull = await h.post('alice', '/generation/quote', { ...body, buildMode: 'full' });
    assert.equal(quoteFull.body.costMilli, PRICES.full);
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------ restart, legacy, deletion */

test('a restart keeps the chosen resume and the mode, and a restored task never chooses again', async () => {
  const h = await serve('restart');
  try {
    h.seats.holdTailoring = true;
    const { batchId } = await submit(h, 'alice', run(h, { buildMode: 'partial', jobs: [h.jobs[0]] }));
    await until(() => h.seats.tailorings().length === 1, 'the task to be tailoring');

    // On disk, whole: the resume it will build, its mode, its price and its label.
    const row = generationStore.loadBatchRows().find((entry) => entry.id === batchId);
    const stored = row.tasks[0].data;
    assert.equal(stored.payload.resumeId, BACKEND);
    assert.equal(stored.payload.buildMode, 'partial');
    assert.equal(stored.payload.costMilli, PRICES.partial);
    assert.equal(stored.label.resumeLabel, 'Backend Engineer');
    assert.equal(stored.label.profileLabel, 'Jane Doe');
    assert.equal(stored.label.match.reason, 'matched');
    assert.equal(row.data.shared.buildMode, 'partial');

    crash(h);
    // While it was down the person changed the resumes: Backend no longer looks
    // like a backend resume, and the default now carries the whole stack. A
    // fresh choice would be Data's.
    const { getResume, saveEditedResume } = require('../dist/database/resumeRepository');
    saveEditedResume({ ...getResume(BACKEND), title: 'Florist', skills: [] }, h.alice.id);
    saveEditedResume(
      { ...getResume(DATA), title: 'Backend Engineer', skills: ['Go', 'Kubernetes', 'gRPC', 'PostgreSQL', 'Docker'] },
      h.alice.id
    );

    h.seats.holdTailoring = false;
    const report = await queueModule.restoreGenerationQueue();
    assert.deepEqual(report.batchIds, [batchId]);
    await finishAll(h, batchId, 1);

    const [task] = tasksOf(batchId);
    assert.equal(task.payload.resumeId, BACKEND, 'the same resume');
    assert.equal(task.payload.buildMode, 'partial', 'the same mode');
    assert.equal(task.label.resumeId, BACKEND);
    assert.equal(task.label.match.reason, 'matched', 'the explanation of the choice made at submit');
    assert.equal(h.built.length, 1);
    assert.equal(h.built[0].resumeId, BACKEND);
    assert.equal(h.built[0].tailoredSummary, 'TAILORED-BY-variant', 'tailored in Partial, by that resume\'s own prompt');
    assert.equal(h.balance(h.alice), 1_000 - PRICES.partial, 'charged once');
  } finally {
    await h.close();
  }
});

test('a queued task from before v4.2, with no buildMode, builds Partial', async () => {
  const h = await serve('legacy');
  try {
    h.seats.holdTailoring = true;
    // A Fully run on Data (the default); the upgrade left the payload without a mode.
    const { batchId } = await submit(h, 'alice', run(h, { buildMode: 'full', jobs: [h.jobs[0]] }));
    await until(() => h.seats.tailorings().length === 1, 'the task to be tailoring');
    const db = require('../dist/database/sqlite').getDb();
    const changed = db
      .prepare("UPDATE generation_tasks SET data = json_remove(data, '$.payload.buildMode') WHERE batch_id = ?")
      .run(batchId).changes;
    assert.equal(changed, 1);
    assert.equal(
      generationStore.loadBatchRows().find((entry) => entry.id === batchId).tasks[0].data.payload.buildMode,
      undefined
    );

    crash(h);
    h.seats.holdTailoring = false;
    await queueModule.restoreGenerationQueue();
    await finishAll(h, batchId, 1);

    // The restored build ran Partial: the built-in prompt, the resume's own text.
    const restored = h.seats.tailorings().at(-1);
    assert.match(sent(restored), /PARTIAL PROMPT/);
    assert.doesNotMatch(sent(restored), /FULLY PROMPT/);
    assert.match(sent(restored), /SUMMARY-DATA/, 'Partial sends the whole resume');
    assert.equal(h.built[0].resumeId, DATA);
    assert.equal(h.built[0].tailoredSummary, 'TAILORED-BY-partial');
  } finally {
    await h.close();
  }
});

test('a chosen resume deleted before its turn fails that task, and its own price is refunded', async () => {
  const h = await serve('deleted');
  try {
    h.seats.holdTailoring = true;
    const { batchId, orderId } = await submit(h, 'alice', run(h, { buildMode: 'partial' }));
    await until(() => h.seats.tailorings().length === 2, 'both tasks to be tailoring');
    assert.equal(h.balance(h.alice), 1_000 - 2 * PRICES.partial);

    crash(h);
    // The person deletes the Backend resume - the one the first job chose - and
    // the run is not re-pointed at another: that resume cannot be built.
    assert.equal(require('../dist/database/resumeRepository').deleteResume(BACKEND), true);

    h.seats.holdTailoring = false;
    await queueModule.restoreGenerationQueue();
    const snapshot = await untilFinished(batchId);
    assert.deepEqual(snapshot.tasks.map((task) => task.state), ['failed', 'done']);
    assert.match(snapshot.tasks[0].error, /deleted before it could be built/);

    const refunds = h.ledger(h.alice, 'generation-refund').map((entry) => entry.deltaMilli);
    assert.deepEqual(refunds, [PRICES.partial], 'its own price, once');
    assert.equal(h.balance(h.alice), 1_000 - PRICES.partial, 'the resume that was built stays paid for');
    assert.equal(h.built.length, 1);
    assert.equal(h.built[0].resumeId, DATA, 'and nothing else was built in its place');
    const items = orders.listOrderItems(orderId);
    assert.deepEqual(items.map((item) => item.resumeId), [BACKEND, DATA], 'the item still names what was chosen');
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------- one profile per run */

const NOT_ONE_PROFILE = (h) => [
  ['profileIds with one profile', { profileIds: [h.jane] }],
  ['profileIds with two profiles', { profileIds: [h.jane, h.kim] }],
  ['profileIds beside profileId', { profileId: h.jane, profileIds: [h.jane] }],
  ['no profile at all', { profileId: undefined }],
  ['resumeIds', { profileId: undefined, resumeIds: [BACKEND, DATA] }],
  ['resumeIds beside profileId', { resumeIds: [BACKEND] }],
];

test('a run names exactly one profile: every other shape is 400 one-profile-per-run, for everybody, on batches and quote', async () => {
  const h = await serve('one-profile');
  try {
    for (const [shape, extra] of NOT_ONE_PROFILE(h)) {
      for (const [who, profile] of [['alice', h.jane], ['admin', h.adminProfile]]) {
        const body = { profileId: profile, jobs: h.jobs, buildMode: 'partial', ...extra };
        for (const route of ['/generation/batches', '/generation/quote']) {
          const response = await h.post(who, route, body);
          const what = `${who} ${route}, ${shape}: ${JSON.stringify(response.body)}`;
          assert.equal(response.status, 400, what);
          assert.equal(response.body.code, 'one-profile-per-run', what);
          assert.equal(response.body.error, ONE_PROFILE, what);
        }
      }
    }
    // Refused before anything was charged, queued or filed.
    assert.equal(h.balance(h.alice), 1_000);
    assert.deepEqual(h.ledger(h.alice, 'generation-reserve'), []);
    assert.deepEqual(queueModule.getGenerationQueue().listBatches(false), []);
    assert.deepEqual(orders.listOrdersForUser(h.alice.id), []);
    assert.equal(h.seats.calls.length, 0);
  } finally {
    await h.close();
  }
});

test('an unknown or somebody else\'s profile is 404; a profile with no enabled resume is 400; nothing is taken', async () => {
  const h = await serve('refusals-world');
  try {
    const notFound = 'That profile was not found. It may have been deleted; reload the page.';
    for (const profileId of ['not-a-profile', h.bobProfile, h.adminProfile]) {
      for (const route of ['/generation/batches', '/generation/quote']) {
        const response = await h.post('alice', route, { profileId, jobs: h.jobs, buildMode: 'partial' });
        assert.equal(response.status, 404, `${route} ${profileId}: ${JSON.stringify(response.body)}`);
        assert.equal(response.body.code, 'profile-not-found');
        assert.equal(response.body.error, notFound);
      }
    }
    // (A quote is lenient while a form is filled in, so only the run is held to this.)
    const response = await h.post('alice', '/generation/batches', { profileId: h.empty, jobs: h.jobs, buildMode: 'suitable' });
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.code, 'no-profiles-to-build');
    assert.equal(response.body.error, 'That profile has no enabled resume to build. Add or enable a resume on its page.');
    assert.equal(h.balance(h.alice), 1_000);
    assert.deepEqual(queueModule.getGenerationQueue().listBatches(false), []);
    assert.deepEqual(h.ledger(h.alice, 'generation-reserve'), []);
  } finally {
    await h.close();
  }
});

test('a Default account builds one profile of several resumes in every mode, as an order and as an immediate run', async () => {
  const h = await serve('default-account');
  try {
    assert.equal(users.getUserById(h.alice.id).subscription, 'default');
    const ids = [];
    for (const buildMode of Object.keys(LABELS)) {
      for (const mode of ['order', 'immediate']) {
        const accepted = await submit(h, 'alice', run(h, { buildMode, mode, jobs: [h.jobs[0]] }));
        assert.equal(accepted.buildMode, buildMode);
        assert.equal(accepted.kind, mode);
        ids.push(accepted.batchId);
      }
      const quote = await h.post('alice', '/generation/quote', { profileId: h.jane, buildMode, jobs: h.jobs });
      assert.equal(quote.status, 200, JSON.stringify(quote.body));
      assert.equal(quote.body.resumes, 2);
    }
    for (const batchId of ids) await untilFinished(batchId);
  } finally {
    await h.close();
  }
});

test('a junk buildMode is refused; Suitable takes no previewed content or token', async () => {
  const h = await serve('mode-refusals');
  try {
    for (const route of ['/generation/batches', '/generation/quote']) {
      for (const buildMode of ['everything', 'Partial', 7]) {
        const response = await h.post('alice', route, run(h, { buildMode }));
        assert.equal(response.status, 400, `${route} ${JSON.stringify(buildMode)}: ${JSON.stringify(response.body)}`);
        assert.equal(response.body.code, 'bad-build-mode');
        assert.equal(response.body.error, 'buildMode must be "suitable", "partial" or "full".');
      }
    }
    const content = { summary: 'x', experience: [] };
    const contentShapes = [
      ['content', { tailoredContentByResumeId: { [BACKEND]: content } }],
      ['a token', { previewTokenByResumeId: { [BACKEND]: 'a.b' } }],
      ['both', { tailoredContentByResumeId: { [BACKEND]: content }, previewTokenByResumeId: { [BACKEND]: 'a.b' } }],
    ];
    for (const [shape, extra] of contentShapes) {
      for (const route of ['/generation/batches', '/generation/quote']) {
        const response = await h.post('alice', route, run(h, { buildMode: 'suitable', jobs: [h.jobs[0]], ...extra }));
        assert.equal(response.status, 400, `${route} ${shape}: ${JSON.stringify(response.body)}`);
        assert.equal(response.body.code, 'suitable-takes-no-content');
        assert.equal(
          response.body.error,
          'Choose Suitable Resume builds each resume as written, so it takes no previewed content.'
        );
      }
    }
    assert.equal(h.balance(h.alice), 1_000);
    assert.deepEqual(queueModule.getGenerationQueue().listBatches(false), []);
  } finally {
    await h.close();
  }
});

test('a previewedResumeId that is not the id of a resume is 400 bad-previewed-resume, on batches and quote, and costs nothing', async () => {
  const h = await serve('bad-previewed');
  try {
    for (const route of ['/generation/batches', '/generation/quote']) {
      for (const previewedResumeId of [5, ' ', true, ['res-data'], {}]) {
        const response = await h.post('alice', route, run(h, { buildMode: 'partial', previewedResumeId }));
        assert.equal(response.status, 400, `${route} ${JSON.stringify(previewedResumeId)}: ${JSON.stringify(response.body)}`);
        assert.equal(response.body.code, 'bad-previewed-resume');
      }
    }
    assert.equal(h.balance(h.alice), 1_000);
    assert.deepEqual(queueModule.getGenerationQueue().listBatches(false), []);
  } finally {
    await h.close();
  }
});

test('the wrong people are told so before the jobs are looked at: no jobs and no profile is one-profile-per-run, not "no jobs"', async () => {
  const h = await serve('people-before-jobs');
  try {
    for (const extra of [{ profileId: undefined, jobs: [] }, { profileId: undefined, jobs: undefined }, { profileIds: [h.jane], jobs: [] }, { resumeIds: [BACKEND], jobs: [] }]) {
      const response = await h.post('alice', '/generation/batches', run(h, { buildMode: 'partial', ...extra }));
      assert.equal(response.status, 400, JSON.stringify(response.body));
      assert.equal(response.body.code, 'one-profile-per-run', JSON.stringify(response.body));
    }
  } finally {
    await h.close();
  }
});

test('a queued run logs who it is for, its mode and how many resumes it chose among', async () => {
  const h = await serve('log-line');
  const lines = [];
  const realLog = console.log;
  console.log = (...args) => {
    lines.push(args.map(String).join(' '));
    realLog(...args);
  };
  let accepted;
  try {
    accepted = await submit(h, 'alice', run(h, { buildMode: 'partial', jobs: [h.jobs[0]] }));
  } finally {
    console.log = realLog;
  }
  try {
    const line = lines.find((entry) => entry.includes(accepted.batchId));
    assert.ok(line, `no log line names the run: ${lines.join(' | ')}`);
    assert.match(line, /^\[queue\] order FT-\d{8}-\d{4} \S+: 1 resume\(s\) queued \(1 job\(s\) for Jane Doe, Partial Tailor; chosen among 2 resume\(s\) in \d+ ms\)$/);
  } finally {
    await h.close();
  }
});

/* ---------------------------------------------------- previews and finalising */

async function preview(h, who, body) {
  const response = await h.post(who, '/resume/preview', { analysisId: h.jobs[0].analysisId, ...body });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
}

test('a preview that no longer matches what the run would build is 409 preview-changed, and nothing is reserved', async () => {
  const h = await serve('preview-changed');
  try {
    // Previewed on the Data resume (Fully starts there) ...
    const previewed = await preview(h, 'alice', { profileId: h.jane, buildMode: 'full' });
    assert.equal(previewed.resumeId, DATA);
    // ... but the Partial run for this posting would build the Backend resume.
    const changed = (extra) => ({
      profileId: h.jane,
      buildMode: 'partial',
      jobs: [h.jobs[0]],
      mode: 'order',
      ...extra,
    });
    const refused = [
      ['previewedResumeId alone', changed({ previewedResumeId: DATA })],
      [
        'content of another resume',
        changed({
          tailoredContentByResumeId: { [DATA]: previewed.tailoredContent },
          previewTokenByResumeId: { [DATA]: previewed.previewToken },
        }),
      ],
      [
        'both, disagreeing',
        changed({
          previewedResumeId: DATA,
          tailoredContentByResumeId: { [DATA]: previewed.tailoredContent },
          previewTokenByResumeId: { [DATA]: previewed.previewToken },
        }),
      ],
    ];
    for (const [shape, body] of refused) {
      const response = await h.post('alice', '/generation/batches', body);
      assert.equal(response.status, 409, `${shape}: ${JSON.stringify(response.body)}`);
      assert.equal(response.body.code, 'preview-changed');
      assert.equal(response.body.profileId, h.jane);
      assert.equal(response.body.resumeId, BACKEND, 'the resume this run would now build');
      assert.equal(
        response.body.error,
        "Jane Doe's resumes have changed since the preview: this run would now build Backend Engineer. Preview again."
      );
    }
    // Nothing reserved, charged, queued or filed, and no model asked again.
    assert.equal(h.balance(h.alice), 1_000);
    assert.deepEqual(h.ledger(h.alice, 'generation-reserve'), []);
    assert.deepEqual(queueModule.getGenerationQueue().listBatches(false), []);
    assert.deepEqual(orders.listOrdersForUser(h.alice.id), []);
    assert.equal(h.seats.tailorings().length, 1, 'only the preview\'s own');
  } finally {
    await h.close();
  }
});

test('a preview that agrees is finalised with no model call, built from the held content, at the mode\'s price', async () => {
  const h = await serve('finalise');
  try {
    const previewed = await preview(h, 'alice', { profileId: h.jane, buildMode: 'partial' });
    assert.equal(previewed.resumeId, BACKEND);
    assert.equal(previewed.tailored, true);
    assert.ok(previewed.previewToken);
    assert.equal(h.seats.tailorings().length, 1);

    const body = run(h, {
      buildMode: 'partial',
      jobs: [h.jobs[0]],
      previewedResumeId: BACKEND,
      tailoredContentByResumeId: { [BACKEND]: { ...previewed.tailoredContent, summary: 'EDITED-BY-HAND' } },
      previewTokenByResumeId: { [BACKEND]: previewed.previewToken },
    });
    const quote = await h.post('alice', '/generation/quote', body);
    assert.equal(quote.body.costMilli, PRICES.partial, 'a valid token for (account, resume, mode) is the mode\'s price');
    const { batchId } = await submit(h, 'alice', body);
    await finishAll(h, batchId, 1);

    assert.equal(h.seats.tailorings().length, 1, 'the model was not asked again');
    assert.equal(h.built[0].resumeId, BACKEND);
    assert.equal(h.built[0].tailoredSummary, 'EDITED-BY-HAND', 'built from what the person held');
    assert.match(h.built[0].html, /EDITED-BY-HAND/);
    assert.equal(h.balance(h.alice), 1_000 - PRICES.partial);
  } finally {
    await h.close();
  }
});

test('preview tokens bind the mode: content without a token valid for the run\'s account, resume and mode costs the dearest price', async () => {
  // Suitable 10, Partial 30, Fully 20: a Fully run with a Partial token, or none, is the floor (30).
  const h = await serve('tokens');
  try {
    const job = h.jobs[1]; // both Partial and Fully build the Data resume for this posting
    const fullPreview = await preview(h, 'alice', { profileId: h.jane, buildMode: 'full', analysisId: job.analysisId });
    const partialPreview = await preview(h, 'alice', { profileId: h.jane, buildMode: 'partial', analysisId: job.analysisId });
    assert.equal(fullPreview.resumeId, DATA);
    assert.equal(partialPreview.resumeId, DATA);
    assert.ok(fullPreview.previewToken && partialPreview.previewToken);
    assert.notEqual(fullPreview.previewToken, partialPreview.previewToken);

    const asFully = (token) => ({
      profileId: h.jane,
      buildMode: 'full',
      jobs: [job],
      previewedResumeId: DATA,
      tailoredContentByResumeId: { [DATA]: fullPreview.tailoredContent },
      ...(token === undefined ? {} : { previewTokenByResumeId: { [DATA]: token } }),
    });
    const price = async (body) => {
      const response = await h.post('alice', '/generation/quote', body);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      return response.body.costMilli;
    };
    assert.equal(await price(asFully(fullPreview.previewToken)), PRICES.full, 'its own mode\'s token');
    assert.equal(await price(asFully(partialPreview.previewToken)), PRICES.partial, 'another mode\'s token: the floor');
    assert.equal(await price(asFully(undefined)), PRICES.partial, 'no token: the floor');
    assert.equal(await price(asFully('not.a-token')), PRICES.partial, 'a forged token: the floor');

    const asPartial = {
      profileId: h.jane,
      buildMode: 'partial',
      jobs: [job],
      previewedResumeId: DATA,
      tailoredContentByResumeId: { [DATA]: partialPreview.tailoredContent },
      previewTokenByResumeId: { [DATA]: partialPreview.previewToken },
    };
    assert.equal(await price(asPartial), PRICES.partial);

    // Another account's token is nobody's.
    const bobsToken = require('../dist/services/credits/previewToken').issuePreviewToken({
      userId: h.bob.id, resumeId: DATA, buildMode: 'full',
    });
    assert.equal(await price(asFully(bobsToken)), PRICES.partial);

    // The quote is the charge.
    const before = h.balance(h.alice);
    const { batchId } = await submit(h, 'alice', {
      ...asFully(partialPreview.previewToken),
      mode: 'order',
      format: 'pdf',
      includeCoverLetterDocx: false,
    });
    const [reserve] = h.ledger(h.alice, 'generation-reserve');
    assert.equal(-reserve.deltaMilli, PRICES.partial);
    await finishAll(h, batchId, 1);
    assert.equal(h.balance(h.alice), before - PRICES.partial);
    assert.equal(tasksOf(batchId)[0].payload.costMilli, PRICES.partial, 'snapshotted on the task');
  } finally {
    await h.close();
  }
});

test('the preview token is issued per account, resume and mode, and read by nothing else', () => {
  useTempStorage('build-modes-token-unit');
  const { issuePreviewToken, readPreviewToken } = require('../dist/services/credits/previewToken');
  const token = issuePreviewToken({ userId: 'u1', resumeId: 'r1', buildMode: 'full' });
  assert.equal(readPreviewToken(token, { userId: 'u1', resumeId: 'r1' }), 'full');
  assert.equal(readPreviewToken(token, { userId: 'u2', resumeId: 'r1' }), null, 'another account');
  assert.equal(readPreviewToken(token, { userId: 'u1', resumeId: 'r2' }), null, 'another resume');
  for (const junk of [undefined, null, 7, '', 'abc', 'a.b', `${token}x`, `${token}.extra`, {}]) {
    assert.equal(readPreviewToken(junk, { userId: 'u1', resumeId: 'r1' }), null, String(junk));
  }
  assert.equal(issuePreviewToken({ userId: 'u1', resumeId: 'r1', buildMode: 'partial' }) === token, false);
  assert.equal(
    readPreviewToken(issuePreviewToken({ userId: 'u1', resumeId: 'r1', buildMode: 'partial' }), { userId: 'u1', resumeId: 'r1' }),
    'partial'
  );
  const realNow = Date.now;
  Date.now = () => realNow() + 25 * 60 * 60_000;
  try {
    assert.equal(readPreviewToken(token, { userId: 'u1', resumeId: 'r1' }), null, 'a day on, it has expired');
  } finally {
    Date.now = realNow;
  }
});

/* ------------------------------------------------------------ prices and quote */

test('the quote is jobs x the mode\'s price, equals the charge, and the history line is by mode', async () => {
  const h = await serve('quote-equals-charge');
  try {
    let expected = 1_000;
    for (const [buildMode, label] of Object.entries(LABELS)) {
      const body = run(h, { buildMode });
      const quote = await h.post('alice', '/generation/quote', body);
      assert.equal(quote.status, 200);
      assert.deepEqual(quote.body, {
        resumes: 2,
        costMilli: 2 * PRICES[buildMode],
        pricePerResumeMilli: PRICES[buildMode],
        balanceMilli: expected,
        exempt: false,
        buildMode,
      });
      assert.equal(h.balance(h.alice), expected, 'a quote takes nothing');

      const before = h.ledger(h.alice, 'generation-reserve').length;
      const { batchId } = await submit(h, 'alice', body);
      const reserves = h.ledger(h.alice, 'generation-reserve');
      assert.equal(reserves.length, before + 1);
      // "2 resumes: 2 x Partial Tailor @ $0.03 = $0.06": the line is by mode, never by model.
      const each = `\\$0\\.0${PRICES[buildMode] / 10}`;
      const line = new RegExp(`^2 resumes: 2 x ${label} @ ${each} = \\$0\\.0${(2 * PRICES[buildMode]) / 10}$`);
      const reserve = reserves.find((entry) => line.test(entry.note));
      assert.ok(reserve, `no history line for ${label}: ${reserves.map((entry) => entry.note).join(' | ')}`);
      assert.equal(-reserve.deltaMilli, quote.body.costMilli, 'charged exactly what was quoted');
      for (const task of tasksOf(batchId)) {
        assert.equal(task.payload.costMilli, PRICES[buildMode]);
        assert.equal(task.payload.buildMode, buildMode);
      }
      await finishAll(h, batchId, 2);
      expected -= quote.body.costMilli;
      assert.equal(h.balance(h.alice), expected, 'a built resume stays paid for');
    }
  } finally {
    await h.close();
  }
});

test('the quote is lenient while the form is being filled in, and refuses the same shapes the run does', async () => {
  const h = await serve('quote-lenient');
  try {
    const nothing = await h.post('alice', '/generation/quote', { profileId: h.jane, buildMode: 'partial' });
    assert.equal(nothing.status, 200, 'no jobs yet is a quote of nothing');
    assert.equal(nothing.body.resumes, 0);
    assert.equal(nothing.body.costMilli, 0);
    assert.equal(nothing.body.buildMode, 'partial');
    // A missing company name does not change the price.
    const unnamed = await h.post('alice', '/generation/quote', {
      profileId: h.jane, buildMode: 'partial', jobs: [{ companyName: '', role: '' }],
    });
    assert.equal(unnamed.status, 200);
    assert.equal(unnamed.body.costMilli, PRICES.partial);
    // But who the run is for is not lenient: even with no jobs yet.
    const unknown = await h.post('alice', '/generation/quote', { profileId: 'nobody', buildMode: 'partial' });
    assert.equal(unknown.status, 404);
    assert.equal((await h.post('alice', '/generation/quote', { buildMode: 'partial' })).status, 400);
  } finally {
    await h.close();
  }
});

test('administrators are quoted the full amount and charged nothing; a free mode takes nothing; too little credit is a 402 that moves nothing', async () => {
  const h = await serve('money-edges', { balance: 59 });
  try {
    // Admin: exempt, whatever the mode costs, but still one profile.
    const quote = await h.post('admin', '/generation/quote', {
      profileId: h.adminProfile, buildMode: 'partial', jobs: h.jobs,
    });
    assert.deepEqual(quote.body, {
      resumes: 2, costMilli: 2 * PRICES.partial, pricePerResumeMilli: PRICES.partial, balanceMilli: 0, exempt: true, buildMode: 'partial',
    });
    const adminRun = await submit(h, 'admin', run(h, { profileId: h.adminProfile, buildMode: 'partial' }));
    assert.deepEqual(h.ledger(h.admin, 'generation-reserve'), []);
    assert.equal(h.balance(h.admin), 0);
    await untilFinished(adminRun.batchId);

    // Alice has $0.059; two Partial resumes are $0.060, a thousandth short.
    const refused = await h.post('alice', '/generation/batches', run(h, { buildMode: 'partial' }));
    assert.equal(refused.status, 402, JSON.stringify(refused.body));
    assert.equal(refused.body.code, 'insufficient-credits');
    assert.equal(refused.body.neededMilli, 2 * PRICES.partial);
    assert.equal(refused.body.balanceMilli, 59);
    assert.match(refused.body.error, /needs \$0\.06 of credit and the account has \$0\.059/);
    assert.equal(h.balance(h.alice), 59);
    assert.deepEqual(h.ledger(h.alice, 'generation-reserve'), []);
    assert.deepEqual(queueModule.getGenerationQueue().listBatches(false).filter((batch) => batch.id !== adminRun.batchId), []);
    assert.equal(h.seats.tailorings().length, 2, 'only the administrator\'s own run was built');

    // A mode set to $0 takes nothing, and runs however little credit there is.
    await config.updateAppSettings({ suitablePriceUsd: '0' });
    const free = await submit(h, 'alice', run(h, { buildMode: 'suitable' }));
    assert.equal(tasksOf(free.batchId)[0].payload.costMilli, 0);
    assert.deepEqual(h.ledger(h.alice, 'generation-reserve'), []);
    await finishAll(h, free.batchId, 2);
    const quoteFree = await h.post('alice', '/generation/quote', run(h, { buildMode: 'suitable' }));
    assert.equal(quoteFree.body.costMilli, 0);
    assert.equal(quoteFree.body.pricePerResumeMilli, 0);
    assert.equal(h.balance(h.alice), 59);
  } finally {
    await h.close();
  }
});

/* -------------------------------------------------------------------- /preview */

test('/resume/preview in each mode: Suitable shows the resume as written, Partial and Fully tailor and issue a token', async () => {
  const h = await serve('preview-modes');
  try {
    const suitable = await preview(h, 'alice', { profileId: h.jane, buildMode: 'suitable' });
    assert.equal(suitable.tailored, false);
    assert.equal(suitable.tailoredContent, undefined);
    assert.equal(suitable.previewToken, undefined, 'nothing was written, so nothing is priced by a token');
    assert.equal(suitable.profileId, h.jane);
    assert.equal(suitable.profileName, 'Jane Doe');
    assert.equal(suitable.resumeId, BACKEND);
    assert.equal(suitable.resumeLabel, 'Backend Engineer');
    assert.equal(suitable.buildMode, 'suitable');
    assert.equal(suitable.match.mode, 'suitable');
    assert.equal(suitable.match.reason, 'matched');
    assert.equal(suitable.analysisId, h.jobs[0].analysisId);
    assert.match(suitable.html, /SUMMARY-BACKEND/);
    assert.doesNotMatch(suitable.html, /TAILORED-BY|SUMMARY-DISABLED/);
    assert.equal(h.seats.calls.length, 0, 'no model call at all');

    const partial = await preview(h, 'alice', { profileId: h.jane, buildMode: 'partial' });
    assert.equal(partial.resumeId, BACKEND);
    assert.equal(partial.buildMode, 'partial');
    assert.equal(partial.tailored, true);
    assert.equal(partial.tailoredContent.summary, 'TAILORED-BY-variant');
    assert.ok(partial.previewToken);
    assert.match(partial.html, /TAILORED-BY-variant/);
    assert.equal(partial.match.reason, 'matched');
    assert.equal(h.seats.tailorings().length, 1);

    const full = await preview(h, 'alice', { profileId: h.jane, buildMode: 'full' });
    assert.equal(full.resumeId, DATA, 'Fully starts from the default, whatever matches');
    assert.equal(full.resumeLabel, 'Data Engineer');
    assert.equal(full.buildMode, 'full');
    assert.equal(full.match.reason, 'default');
    assert.equal(full.tailoredContent.summary, 'TAILORED-BY-full');
    assert.ok(full.previewToken);
    assert.match(sent(h.seats.tailorings()[1]), /FULLY PROMPT/);

    // A preview is free.
    assert.equal(h.balance(h.alice), 1_000);
    assert.deepEqual(h.ledger(h.alice, 'generation-reserve'), []);
  } finally {
    await h.close();
  }
});

test('/resume/preview re-renders supplied content without a model call or a token, and refuses the shapes it cannot read', async () => {
  const h = await serve('preview-rerender');
  try {
    const first = await preview(h, 'alice', { profileId: h.jane, buildMode: 'partial' });
    const calls = h.seats.calls.length;

    const again = await h.post('alice', '/resume/preview', {
      resumeId: BACKEND,
      analysisId: h.jobs[0].analysisId,
      tailoredContent: { ...first.tailoredContent, summary: 'EDITED-ON-THE-PREVIEW-PAGE' },
    });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.match(again.body.html, /EDITED-ON-THE-PREVIEW-PAGE/);
    assert.equal(again.body.previewToken, undefined, 'content the request supplied earns no token');
    assert.equal(again.body.resumeId, BACKEND);
    assert.equal(h.seats.calls.length, calls, 'no model call');

    const refused = [
      ['nothing named', {}, 400, 'Choose a profile to preview.'],
      [
        'a resume without its content',
        { resumeId: BACKEND },
        400,
        'Send the previewed content to show it again, or name the profile to preview.',
      ],
      [
        'a profile with nothing enabled',
        { profileId: h.empty, buildMode: 'suitable' },
        400,
        'Empty Person has no enabled resume to preview. Add or enable one on the profile\'s page.',
      ],
    ];
    for (const [what, body, status, message] of refused) {
      const response = await h.post('alice', '/resume/preview', body);
      assert.equal(response.status, status, `${what}: ${JSON.stringify(response.body)}`);
      assert.equal(response.body.error, message, what);
    }
    const both = await h.post('alice', '/resume/preview', { profileId: h.jane, resumeId: BACKEND, tailoredContent: first.tailoredContent });
    assert.equal(both.status, 400, 'exactly one of a profile or a resume');
    for (const profileId of ['nobody', h.bobProfile]) {
      const response = await h.post('alice', '/resume/preview', { profileId, buildMode: 'suitable' });
      assert.equal(response.status, 404, `${profileId}: ${JSON.stringify(response.body)}`);
    }
    const junkMode = await h.post('alice', '/resume/preview', { profileId: h.jane, buildMode: 'everything' });
    assert.equal(junkMode.status, 400);
    assert.equal(h.seats.calls.length, calls, 'and none of that asked a model');
  } finally {
    await h.close();
  }
});

test('/resume/preview-all is gone: a run has one profile, so there is nothing to preview in bulk', async () => {
  const h = await serve('preview-all');
  try {
    for (const who of ['alice', 'admin']) {
      const response = await h.postRaw(who, '/resume/preview-all', { profileId: h.jane, buildMode: 'partial' });
      assert.equal(response.status, 404, response.text.slice(0, 200));
    }
    assert.equal(h.seats.calls.length, 0);
  } finally {
    await h.close();
  }
});
