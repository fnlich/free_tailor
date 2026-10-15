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
 *   E2E_OUTPUT_DIR      where the run's files go - keep them out of the
 *                       repository's generated/ folder. Handed to the app as
 *                       OUTPUT_BASE_DIR (when that is not set already), the
 *                       .env default under the admin Output folder setting,
 *                       so nothing is stored and the page reads
 *                       "From .env (OUTPUT_BASE_DIR)"
 */

const path = require('path');

process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli';
const DIST = process.env.E2E_DIST || path.join(__dirname, '..', '..', 'dist');
const ai = require(path.join(DIST, 'services', 'ai', 'index'));

const DELAY = Number(process.env.E2E_STUB_DELAY_MS || 2500);

// An analysis is two calls (services/jobAnalysis/gate.ts). The analysis
// prompt answers the posting's keywords...
const ANALYSIS = JSON.stringify({
  jobMeta: { title: 'Senior Engineer', seniority: 'senior', industry: 'SaaS', department: 'Platform' },
  skills: { technical: ['TypeScript', 'Docker'], tools: [], soft: ['Adaptable'] },
  responsibilities: ['container build pipeline delivery'],
  domainKnowledge: [],
  keywords: { actionVerbs: [], buzzwords: [], mustInclude: [] },
});

// ...and the Job Facts (Filter) prompt its facts, top-level snake_case, plus
// the job field the code asks for - so a page that shows them (the
// builder's "Analysed as", the previews, a reporter's run) has something to
// show: a remote Backend job at a SaaS company (Technology), no clearance.
// No currency: that prompt asks for none.
const FACTS = JSON.stringify({
  job_type: 'remote',
  onsite_interview: 'not_specified',
  company_category: 'saas',
  seniority: 'senior',
  clearance_required: 'none',
  salary: { min: 120000, max: 140000, period: 'annual', raw: null },
  region: 'us',
  us_state: null,
  job_field: 'backend',
});

const ANSWERS = {
  'analyze-job-description': ANALYSIS,
  'filter-google-sheet-job': FACTS,
  'generate-cover-letter': 'Dear team, I build things.',
  // The revise pass (the tailoring's second call): no change.
  'revise-resume-coverage': '{}',
};

// The tailoring, in the shape the shipped prompt asks for: no description, the
// skills block in groups with the posting's soft skills last. Its summary
// carries every term of the analysis above, so a profile whose role this is
// gets no revise pass - the run takes the calls it always took.
const TAILORED = JSON.stringify({
  title: 'Senior Engineer',
  summary: 'Adaptable engineer building reliable TypeScript services shipped with Docker.',
  experience: [
    {
      title: 'Engineer',
      company: 'Acme',
      startDate: '01/2020',
      endDate: 'Present',
      location: 'Remote',
      description: '',
      achievements: ['Cut build time by 37% by caching container layers.'],
    },
  ],
  skillGroups: [
    { category: 'Languages', skills: ['TypeScript', 'JavaScript'] },
    { category: 'Cloud & Infrastructure', skills: ['Docker', 'AWS'] },
    { category: 'Soft Skills', skills: ['Adaptable', 'Communication'] },
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
    // Answered by call site; one this seat does not know fails loudly, so a
    // new model call is never answered with another prompt's text unnoticed.
    const text = request.callSite === 'tailor-resume' ? TAILORED : ANSWERS[request.callSite];
    if (text === undefined) throw new Error(`[e2e stub] no answer for call site "${request.callSite}"`);
    return { text, resolvedModel: request.modelName, providerId: 'claude-cli', droppedParams: [], latencyMs: DELAY };
  },
}));

// Before the app loads, so config/env.ts sees it set: the environment wins
// over .env, as it does for every variable.
if (process.env.E2E_OUTPUT_DIR && !process.env.OUTPUT_BASE_DIR) {
  process.env.OUTPUT_BASE_DIR = path.resolve(process.env.E2E_OUTPUT_DIR);
}
