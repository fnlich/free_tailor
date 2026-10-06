/*
 * A stand-in for the Claude subscription seat, for the browser walkthroughs
 * that need resumes actually built (immediate-run.js).
 *
 * Loaded with `node --require` before the app, like fake-providers.js, so the
 * app's registry finds this adapter instead of the CLI one. Nothing is
 * spawned: a machine with a signed-in `claude` must not spend its owner's
 * subscription on a test, and one without it could not build at all. Every
 * route, the queue, the tab lease, the order rows, the PDFs and their
 * downloads are the shipping code; only the model's answer is canned.
 *
 *   E2E_STUB_DELAY_MS   how long each model call takes (default 2500) - long
 *                       enough to press Stop, close a tab or leave the page
 *                       while a run is going. Only a call that reaches this
 *                       seat waits: a posting already analysed, or a
 *                       tailoring the cache holds for the same profile and
 *                       model, never gets here, so a script that needs a run
 *                       still going gives every job a posting of its own
 *                       (immediate-run.js's `postingsFor`)
 *   E2E_OUTPUT_DIR      where the run's files go (the admin Output folder
 *                       setting, written at boot) - keep them out of the
 *                       repository's generated/ folder
 */

const path = require('path');

process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli';
const DIST = process.env.E2E_DIST || path.join(__dirname, '..', '..', 'dist');
const ai = require(path.join(DIST, 'services', 'ai', 'index'));

const DELAY = Number(process.env.E2E_STUB_DELAY_MS || 2500);

// With the job field, salary and filter facts the analysis prompt asks for,
// so a page that shows them (the builder's "Analysed as", the previews) has
// something to show.
const ANALYSIS = JSON.stringify({
  jobMeta: { title: 'Senior Engineer', seniority: 'senior', industry: 'SaaS', department: 'Platform' },
  skills: { technical: ['TypeScript', 'Docker'], tools: [], soft: ['Adaptable'] },
  responsibilities: ['container build pipeline delivery'],
  domainKnowledge: [],
  keywords: { actionVerbs: [], buzzwords: [], mustInclude: [] },
  jobField: 'backend',
  salary: { min: 120000, max: 140000, currency: 'USD', period: 'annual', raw: null },
  filter: {
    jobType: 'remote',
    onsiteInterview: 'not_specified',
    companyCategory: 'saas',
    clearanceRequired: 'none',
    region: 'us',
    usState: null,
  },
});

const TAILORED = JSON.stringify({
  title: 'Senior Engineer',
  summary: 'Engineer building reliable services.',
  experience: [
    {
      title: 'Engineer',
      company: 'Acme',
      startDate: '01/2020',
      endDate: 'Present',
      location: 'Remote',
      description: 'Built product services.',
      achievements: ['Cut build time by 37% by caching container layers.'],
    },
  ],
  coverLetter: 'I build things.',
});

let calls = 0;

ai.registerAdapter('claude-cli', () => ({
  id: 'claude-cli',
  capabilities: {
    id: 'claude-cli',
    label: 'e2e stub',
    temperature: false,
    maxOutputTokens: false,
    nativeJsonMode: 'json-schema',
    systemBlocks: true,
    maxConcurrency: 1,
  },
  defaultModelName: () => 'sonnet',
  health: async () => ({ ok: true, detail: 'e2e stub seat', checkedAt: new Date().toISOString() }),
  async complete(request) {
    calls += 1;
    console.log(`[e2e stub] call ${calls}: ${request.callSite}`);
    // Honours an abort like the real seat, so Stop and a closed tab stop the
    // resume being built instead of letting it finish. A signal that is
    // ALREADY aborted is refused before anything is timed, as runner.ts does:
    // 'abort' never fires for it, so a task released while it waited on
    // another run's analysis used to be built - and charged - after its run
    // was cancelled.
    await new Promise((resolve, reject) => {
      const aborted = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
      if (request.signal?.aborted) {
        reject(aborted());
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(aborted());
      };
      const timer = setTimeout(() => {
        request.signal?.removeEventListener('abort', onAbort);
        resolve();
      }, DELAY);
      request.signal?.addEventListener('abort', onAbort, { once: true });
    });
    const text =
      request.callSite === 'tailor-resume'
        ? TAILORED
        : request.callSite === 'generate-cover-letter'
          ? 'Dear team, I build things.'
          : ANALYSIS;
    return { text, resolvedModel: request.modelName, providerId: 'claude-cli', droppedParams: [], latencyMs: DELAY };
  },
}));

if (process.env.E2E_OUTPUT_DIR) {
  require(path.join(DIST, 'config', 'aiModelConfig'))
    .updateAppSettings({ outputBaseDir: process.env.E2E_OUTPUT_DIR })
    .catch((error) => console.error('[e2e stub] could not set the output folder:', error));
}
