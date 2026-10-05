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

/** An analysis answer as the model writes it, with the job field and facts the prompt asks for. */
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

const TAILOR_ANSWER = JSON.stringify({
  title: 'Senior Engineer',
  summary: 'Engineer building reliable services.',
  experience: [],
  strengths: [],
  coverLetter: 'I build things.',
});

/** A posting long enough to analyse, distinct per `n`. */
function posting(n = 0, extra = '') {
  return `Posting ${n}: a senior backend engineer to build TypeScript services on Node.js for a SaaS platform. ${extra}`.trim();
}

/**
 * Every seat, counting. `calls` holds each request as the seat got it; the
 * analysis ones are those whose callSite is the analysis prompt's. `hold`
 * makes the next analysis wait until released; `failNext` makes the next
 * analysis fail; `holdTailoring` parks every tailoring call for ever (a
 * process that died mid-run).
 */
function countingSeats(ai, options = {}) {
  ai.resetRegistryForTests();
  const state = {
    calls: [],
    holdAnalysis: null,
    failAnalyses: 0,
    failTailorings: 0,
    holdTailoring: false,
    answer: options.answer ?? (() => analysisAnswer()),
  };
  const release = { analysis: null };
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
  state.analyses = () => state.calls.filter((call) => call.callSite === 'analyze-job-description');
  state.tailorings = () => state.calls.filter((call) => call.callSite === 'tailor-resume');

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
          if (state.holdAnalysis) await state.holdAnalysis;
          if (state.failAnalyses > 0) {
            state.failAnalyses -= 1;
            throw new Error('The seat is down (stub).');
          }
          return reply(id, request, state.answer(request));
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
        return reply(id, request, 'Dear team, I build things.');
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
  freshInstall,
  posting,
  serveInstall,
  stubOutputs,
  TAILOR_ANSWER,
  until,
  untilFinished,
};
