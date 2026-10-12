const fs = require('node:fs');
const path = require('node:path');

const { useTempStorage, useAdminEmails } = require('./helpers');

/**
 * What the analyse-once tests share: a fresh install, every seat replaced by a
 * COUNTING stub that answers like the real thing, and the outputs that would
 * start a browser or touch the output directory swapped for recorders.
 *
 * Not a test file (runTests.js runs `*.test.js`): required by the ones that
 * need it. Modules are required ONCE and shared, never loaded fresh - a
 * module loaded twice holds two registries, two in-flight maps and two
 * queues, and the stub registered on one is invisible to the other.
 */

const SHIPPED = path.join(__dirname, '..', 'static');

/**
 * A posting's analysis in ONE object - the keywords AND the job field, salary
 * and filter facts - which is also the shape an analysis is stored in. A
 * stored-shape fixture as it is; through `countingSeats` it is split into
 * the two answers the two calls of an analysis get (`splitAnswer`), so a test
 * that wants a particular job field or fact still writes it here.
 */
function analysisAnswer(overrides = {}) {
  return JSON.stringify({
    jobMeta: { title: 'Senior Backend Engineer', seniority: 'senior', industry: 'SaaS', department: 'Platform' },
    jobField: 'backend',
    salary: { min: 180000, max: 220000, currency: 'USD', period: 'annual', raw: '$180k - $220k' },
    filter: {
      jobType: 'remote',
      onsiteInterview: 'no',
      companyCategory: 'saas',
      clearanceRequired: 'none',
      region: 'us',
      usState: null,
    },
    skills: { technical: ['API design'], tools: ['Docker'], soft: ['Ownership'] },
    technologies: ['TypeScript', 'Node.js'],
    protocols: ['REST'],
    methodologies: [],
    architecturePatterns: [],
    responsibilities: ['backend service delivery'],
    domainKnowledge: [],
    keywords: { actionVerbs: ['build'], buzzwords: [], mustInclude: ['TypeScript'] },
    ...overrides,
  });
}

/** The job facts call's site: the Job Facts (Filter) prompt, the analysis's second call. */
const FACTS_CALL_SITE = 'filter-google-sheet-job';
/** The revise pass's site (the tailoring's second call). */
const REVISE_CALL_SITE = 'revise-resume-coverage';

/**
 * A one-object analysis split as its two calls answer: the keyword half for
 * the analysis prompt (what its shipped text asks for), and the Job Facts
 * (Filter) prompt's top-level snake_case facts plus the `job_field` the code
 * asks for. No currency - that prompt asks for none. The seniority is the
 * one-object answer's `filter.seniority`, else its `jobMeta.seniority`; a
 * `jobField` of `undefined` leaves `job_field` out (a model ignoring the
 * code's line).
 */
function splitAnswer(combinedJson) {
  const { jobField, salary, filter = {}, industry: _industry, ...analysis } = JSON.parse(combinedJson);
  const facts = {
    job_type: filter.jobType ?? 'not_specified',
    onsite_interview: filter.onsiteInterview ?? 'not_specified',
    company_category: filter.companyCategory ?? 'other',
    seniority: filter.seniority ?? analysis.jobMeta?.seniority ?? 'not_specified',
    clearance_required: filter.clearanceRequired ?? 'none',
    salary: salary
      ? { min: salary.min ?? null, max: salary.max ?? null, period: salary.period ?? null, raw: salary.raw ?? null }
      : { min: null, max: null, period: null, raw: null },
    region: filter.region ?? 'us',
    us_state: filter.usState ?? null,
    ...(jobField === undefined ? {} : { job_field: jobField }),
  };
  return { analysis: JSON.stringify(analysis), facts: JSON.stringify(facts) };
}

/**
 * The tailoring answer, minimal and in the shipped prompt's shape: the
 * skills block in groups, the posting's soft skills last under a heading the
 * code recognises whichever was drawn. It covers little of a posting's
 * checklist, so a fresh tailoring is followed by the revise pass
 * (`revisions()`), which this stub answers with no change by default.
 */
const TAILOR_ANSWER = JSON.stringify({
  title: 'Senior Engineer',
  summary: 'Engineer building reliable services.',
  experience: [],
  skillGroups: [
    { category: 'Languages', skills: ['TypeScript'] },
    { category: 'Soft Skills', skills: ['Ownership'] },
  ],
  coverLetter: 'I build things.',
});

/** A posting long enough to analyse, distinct per `n`. */
function posting(n = 0, extra = '') {
  return `Posting ${n}: a senior backend engineer to build TypeScript services on Node.js for a SaaS platform. ${extra}`.trim();
}

/**
 * Every seat, counting, and answering each prompt BY ITS CALL SITE - a call
 * site it does not know fails loudly, so a new model call is never answered
 * with another prompt's text unnoticed. `calls` holds each request as the
 * seat got it; `analyses()`, `facts()`, `tailorings()`, `revisions()` and
 * `letters()` are the ones of each prompt.
 *
 * `answer(request)` is the posting's one-object analysis (`analysisAnswer`),
 * split for the two calls (`splitAnswer`); `factsAnswer(request)`, when
 * given, is the facts call's raw answer instead. `hold` makes the next
 * analysis call wait until released, `holdFacts` the next facts call;
 * `failAnalyses` / `failFacts` fail that many; `holdTailoring` parks every
 * tailoring call for ever (a process that died mid-run). `reviseAnswer`
 * answers the revise pass ('{}', no change, by default).
 */
function countingSeats(ai, options = {}) {
  ai.resetRegistryForTests();
  const state = {
    calls: [],
    holdAnalysis: null,
    holdFactsCall: null,
    failAnalyses: 0,
    failFacts: 0,
    failTailorings: 0,
    holdTailoring: false,
    answer: options.answer ?? (() => analysisAnswer()),
    factsAnswer: options.factsAnswer ?? null,
    reviseAnswer: options.reviseAnswer ?? (() => '{}'),
  };
  const release = { analysis: null, facts: null };
  state.hold = () => {
    state.holdAnalysis = new Promise((resolve) => {
      release.analysis = resolve;
    });
  };
  state.release = () => {
    const done = release.analysis;
    state.holdAnalysis = null;
    release.analysis = null;
    done?.();
  };
  state.holdFacts = () => {
    state.holdFactsCall = new Promise((resolve) => {
      release.facts = resolve;
    });
  };
  state.releaseFacts = () => {
    const done = release.facts;
    state.holdFactsCall = null;
    release.facts = null;
    done?.();
  };
  const bySite = (site) => () => state.calls.filter((call) => call.callSite === site);
  state.analyses = bySite('analyze-job-description');
  state.facts = bySite(FACTS_CALL_SITE);
  state.tailorings = bySite('tailor-resume');
  state.revisions = bySite(REVISE_CALL_SITE);
  state.letters = bySite('generate-cover-letter');

  // A held call gives up when its signal aborts, as a seat does.
  const held = (gate, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason ?? new Error('aborted (stub)'));
      signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted (stub)')), { once: true });
      gate.then(resolve);
    });

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
        const call = { provider: id, ...request };
        state.calls.push(call);
        if (request.callSite === 'analyze-job-description') {
          if (state.holdAnalysis) await held(state.holdAnalysis, request.signal);
          if (state.failAnalyses > 0) {
            state.failAnalyses -= 1;
            throw new Error('The seat is down (stub).');
          }
          return reply(id, request, splitAnswer(state.answer(request)).analysis);
        }
        if (request.callSite === FACTS_CALL_SITE) {
          if (state.holdFactsCall) await held(state.holdFactsCall, request.signal);
          if (state.failFacts > 0) {
            state.failFacts -= 1;
            throw new Error('The seat is down (stub).');
          }
          return reply(id, request, state.factsAnswer ? state.factsAnswer(request) : splitAnswer(state.answer(request)).facts);
        }
        if (request.callSite === 'tailor-resume') {
          // A process that dies mid-tailoring: the call never answers, so the
          // task never settles and nothing it would write is written.
          if (state.holdTailoring) await new Promise(() => {});
          if (state.failTailorings > 0) {
            state.failTailorings -= 1;
            throw new Error('Tailoring failed (stub).');
          }
          return reply(id, request, TAILOR_ANSWER);
        }
        if (request.callSite === REVISE_CALL_SITE) return reply(id, request, state.reviseAnswer(request));
        if (request.callSite === 'generate-cover-letter') return reply(id, request, 'Dear team, I build things.');
        throw new Error(`stub seat: no answer for call site "${request.callSite}"`);
      },
    }));
  }
  return state;
}

function reply(id, request, text) {
  return { text, resolvedModel: request.modelName, providerId: id, droppedParams: [], latencyMs: 1 };
}

/** A fresh install: shipped prompts, skills and the default template in a temp static dir. */
function freshInstall(name) {
  const storage = useTempStorage(`analysis-${name}-${Math.random().toString(36).slice(2, 8)}`);
  fs.cpSync(path.join(SHIPPED, 'skills'), path.join(storage.staticDir, 'skills'), { recursive: true });
  fs.cpSync(path.join(SHIPPED, 'prompts'), path.join(storage.staticDir, 'prompts'), { recursive: true });
  fs.mkdirSync(path.join(storage.staticDir, 'templates'), { recursive: true });
  fs.copyFileSync(path.join(SHIPPED, 'templates', 'default.json'), path.join(storage.staticDir, 'templates', 'default.json'));
  return storage;
}

/**
 * Swaps what would print a file or touch the output directory for recorders.
 * The compiled task calls these through their module exports, so a swap is
 * what it sees.
 */
function stubOutputs(rootDir) {
  const swaps = [];
  const swap = (module, name, fake) => {
    swaps.push([module, name, module[name]]);
    module[name] = fake;
  };
  swap(require('../dist/utils/generatedPath'), 'getGeneratedOutputPath', async (_profile, _company, role) => ({
    storagePathBase: 'x',
    absoluteDir: rootDir,
    roleSlug: role,
  }));
  swap(require('../dist/generators/coverLetterGenerator'), 'saveCoverLetter', async () => 'x/cover.pdf');
  swap(require('../dist/generators/coverLetterGenerator'), 'saveCoverLetterDOCX', async () => 'x/cover.docx');
  swap(require('../dist/generators/pdfGenerator'), 'generateResumePDF', async () => 'x/resume.pdf');
  swap(require('../dist/generators/docxGenerator'), 'generateResumeDOCX', async () => 'x/resume.docx');
  return () => {
    for (const [module, name, original] of swaps.reverse()) module[name] = original;
  };
}

function profileInput(name, extra = {}) {
  return {
    name,
    title: 'Engineer',
    skills: ['TypeScript'],
    contact: { email: `${name.toLowerCase()}@example.com`, phone: '1', location: 'Remote' },
    summary: 'Engineer who ships.',
    experience: [],
    strengths: [],
    education: [],
    ...extra,
  };
}

/**
 * A served install: the resume, generation and jobs routes behind a signed-in
 * administrator (exempt from charges, so these stay tests about analyses),
 * profiles on the three seats, and the counting seats.
 */
async function serveInstall(name, options = {}) {
  const storage = freshInstall(name);
  useAdminEmails('owner@example.com');
  const express = require('express');
  const ai = require('../dist/services/ai/index');
  const config = require('../dist/config/aiModelConfig');
  const gate = require('../dist/services/jobAnalysis/gate');
  const sheets = require('../dist/services/sheets/analysisColumns');
  const queue = require('../dist/services/queue/index');
  const users = require('../dist/database/userRepository');
  const { saveProfile } = require('../dist/database/profileRepository');
  const { buildNewProfile } = require('../dist/services/profileService');

  config.invalidateSettingsCache();
  gate.resetAnalysisGateForTests();
  sheets.resetAnalysisWriteBacksForTests();
  queue.resetGenerationQueueForTests();
  const seats = countingSeats(ai, options);

  const owner = users.createUser({ email: 'owner@example.com' });
  const token = users.createSession(owner.id);
  const profiles = options.profiles ?? [
    ['p-claude', 'Ada', 'claude-cli-sonnet'],
    ['p-codex', 'Bea', 'codex-cli-default'],
    ['p-gemini', 'Cy', 'gemini-cli-auto'],
  ];
  for (const [id, profileName, modelId, settings = {}] of profiles) {
    saveProfile({
      ...buildNewProfile(profileInput(profileName, { profileSettings: { ai: { modelId }, ...settings } }), id),
      ownerId: owner.id,
    });
  }

  const restoreOutputs = stubOutputs(storage.rootDir);
  const { attachUser } = require('../dist/middleware/auth');
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(attachUser);
  app.use('/api/resume', require('../dist/routes/resume').default);
  app.use('/api/generation', require('../dist/routes/generation').default);
  app.use('/api/jobs', require('../dist/routes/jobs').default);
  const server = app.listen(0);
  const port = server.address().port;

  const post = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}/api${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  return {
    ...storage,
    seats,
    owner,
    post,
    config,
    gate,
    queue,
    users,
    close: () => {
      server.close();
      restoreOutputs();
      queue.resetGenerationQueueForTests();
      sheets.setAnalysisSheetsClientForTests();
      sheets.resetAnalysisWriteBacksForTests();
      ai.resetRegistryForTests();
    },
  };
}

/** Waits for a batch to stop running, and answers its snapshot. */
async function untilFinished(batchId, tries = 1000) {
  const { getGenerationQueue } = require('../dist/services/queue/index');
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const snapshot = getGenerationQueue().snapshot(batchId);
    if (snapshot && snapshot.state !== 'running') return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`batch ${batchId} did not finish`);
}

/** Waits for a condition rather than for a duration. */
async function until(condition, what, tries = 1000) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

module.exports = {
  analysisAnswer,
  countingSeats,
  FACTS_CALL_SITE,
  REVISE_CALL_SITE,
  splitAnswer,
  freshInstall,
  posting,
  serveInstall,
  stubOutputs,
  TAILOR_ANSWER,
  until,
  untilFinished,
};
