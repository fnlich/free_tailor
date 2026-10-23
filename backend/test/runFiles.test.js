const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { useTempStorage, writeSettingRaw } = require('./helpers');

/**
 * A run's files, once they are on disk:
 *
 *  - two resumes of ONE run never share a file. The default folder path
 *    (`/{{date}}/{{profile_name}}/{{company_name}}/{{role}}`) renders one
 *    folder for two postings with one title at one company - rows 5 and 9 of
 *    a sheet - and the generators overwrite, so each task claims its file
 *    stems first (services/queue/runFiles.ts) and the second gets `_2`;
 *  - a run keeps the output folder it was placed in, and is found there: an
 *    administrator who changes the Output folder strands neither a run built
 *    before nor one still queued then (utils/generatedPath.ts `runBaseDir`,
 *    `resolveRunFile`), and the retention sweep deletes it there too.
 */

const ANALYSIS = {
  jobMeta: { title: 'Software Engineer', seniority: 'mid', industry: '', department: '' },
  skills: { technical: [], required: [], preferred: [], tools: [], soft: [], technologies: [] },
  technologies: [],
  protocols: [],
  methodologies: [],
  architecturePatterns: [],
  responsibilities: [],
  domainKnowledge: [],
  keywords: { actionVerbs: [], buzzwords: [], mustInclude: [] },
  softSkills: [],
};

const RESUME_RECORD = {
  id: 'p1',
  name: 'Bob Smith',
  title: 'Engineer',
  contact: { email: 'b@acme.com', phone: '1', location: 'X' },
  summary: 's',
  experience: [],
  strengths: [],
  skills: ['Python'],
  education: [],
  createdAt: '',
  updatedAt: '',
  resumeSettings: {},
};

function setUp(name) {
  const storage = useTempStorage(name);
  fs.mkdirSync(path.join(storage.staticDir, 'templates'), { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, '..', 'static', 'templates', 'default.json'),
    path.join(storage.staticDir, 'templates', 'default.json')
  );
  const out = path.join(storage.rootDir, 'out-a');
  writeSettingRaw(storage.dbDir, 'app-settings', JSON.stringify({ outputBaseDir: out }));
  return { storage, out };
}

test('two resumes of one run at one company with one role land on two files, and keep them', async () => {
  const { out } = setUp('run-files-claim');
  const users = require('../dist/database/userRepository');
  const orders = require('../dist/database/orderRepository');
  const { planRunOutput } = require('../dist/services/outputPath');
  const resumeService = require('../dist/services/resumeService');
  const coverLetters = require('../dist/generators/coverLetterGenerator');
  const gate = require('../dist/services/jobAnalysis/gate');
  const { runResumeTask } = require('../dist/services/queue/resumeTask');
  const { forgetRunFileClaims } = require('../dist/services/queue/runFiles');

  // Only the model calls and the Chrome-drawn cover letter are stubbed: the
  // path, the claim and the DOCX writers are the real ones.
  gate.loadAnalysis = (id) => ({ id, analysis: { ...ANALYSIS, _marker: id } });
  resumeService.tailorResume = async (_resume, analysis) => ({
    title: 'Software Engineer',
    summary: `SUMMARY FOR ${analysis._marker}`,
    experience: [],
    coverLetter: `COVER LETTER FOR ${analysis._marker}`,
  });
  coverLetters.saveCoverLetter = async () => undefined;

  const bob = users.createUser({ email: 'bob@acme.com' });
  const plan = await planRunOutput(bob);
  const batchId = 'bat_two_rows';
  const item = { resumeId: 'p1', resumeName: 'Bob Smith', companyName: 'Amazon', role: 'Software Engineer' };
  const order = orders.createOrder(
    { userId: bob.id, batchId, retentionDays: 5, kind: 'order', outputRootFor: plan.rootFor },
    [{ seq: 0, ...item }, { seq: 1, ...item }]
  );
  const place = plan.placeFor(order.number);
  const build = (seq, row) =>
    runResumeTask(
      {
        resume: RESUME_RECORD,
        job: { companyName: 'Amazon', role: 'Software Engineer', jobDescription: `posting at row ${row}`, sourceRowNumber: row },
        format: 'docx',
        includeCoverLetterDocx: true,
        choice: { provider: 'claude-cli', modelName: 'sonnet' },
        analysisId: `analysis-row-${row}`,
        output: place,
        claim: { batchId, seq },
      },
      { signal: new AbortController().signal }
    );

  const first = await build(0, 5);
  const second = await build(1, 9);
  assert.match(first.docx, /\/Bob_Smith\.docx$/);
  assert.match(second.docx, /\/Bob_Smith_2\.docx$/, 'the second resume of the folder is named apart');
  assert.match(second.coverLetterDocx, /\/Bob_Smith_cover_letter_2\.docx$/);
  assert.equal(path.dirname(first.docx), path.dirname(second.docx), 'one folder, as the folder path says');
  const contents = (relative) => fs.readFileSync(path.join(out, ...relative.split('/')));
  assert.notDeepEqual(contents(first.docx), contents(second.docx), 'neither overwrote the other');

  // A retry keeps the name it claimed.
  assert.equal((await build(1, 9)).docx, second.docx);

  // After a restart nothing is claimed in memory, but a finished resume's
  // item recorded its files: they are still taken, and a task's own are its.
  orders.recordItemOutcome(batchId, 0, {
    state: 'done',
    files: [
      { kind: 'resume-docx', path: first.docx },
      { kind: 'cover-letter-docx', path: first.coverLetterDocx },
    ],
  });
  forgetRunFileClaims(batchId);
  assert.equal((await build(1, 9)).docx, second.docx);
  assert.equal((await build(0, 5)).docx, first.docx);

  // Another run is another folder: its first resume takes the plain name.
  const other = orders.createOrder(
    { userId: bob.id, batchId: 'bat_other', retentionDays: 5, kind: 'order', outputRootFor: plan.rootFor },
    [{ seq: 0, ...item }]
  );
  const elsewhere = await runResumeTask(
    {
      resume: RESUME_RECORD,
      job: { companyName: 'Amazon', role: 'Software Engineer', jobDescription: 'posting', sourceRowNumber: 5 },
      format: 'docx',
      includeCoverLetterDocx: false,
      choice: { provider: 'claude-cli', modelName: 'sonnet' },
      analysisId: 'analysis-row-5',
      output: plan.placeFor(other.number),
      claim: { batchId: 'bat_other', seq: 0 },
    },
    { signal: new AbortController().signal }
  );
  assert.match(elsewhere.docx, /\/Bob_Smith\.docx$/);
});

test('a run is found in the output folder it was placed in after the folder changes, and purged there', async () => {
  const { storage, out } = setUp('run-files-base');
  const users = require('../dist/database/userRepository');
  const orders = require('../dist/database/orderRepository');
  const config = require('../dist/config/aiModelConfig');
  const { planRunOutput } = require('../dist/services/outputPath');
  const { getGeneratedFilePath, getGeneratedOutputPath, runBaseDir } = require('../dist/utils/generatedPath');
  const { purgeExpiredOrders } = require('../dist/services/orders/retention');

  const ada = users.createUser({ email: 'ada@example.com' });
  const plan = await planRunOutput(ada);
  const order = orders.createOrder(
    { userId: ada.id, batchId: 'bat_moved', retentionDays: 5, kind: 'order', outputRootFor: plan.rootFor },
    [{ seq: 0, resumeId: 'p1', resumeName: 'Bob Smith', companyName: 'Acme', role: 'Engineer' }]
  );
  const place = plan.placeFor(order.number);

  // The administrator moves the output folder while the run is queued...
  const moved = path.join(storage.rootDir, 'out-b');
  await config.updateAppSettings({ outputBaseDir: moved });

  // ...and the run goes on writing where it began.
  const info = await getGeneratedOutputPath(RESUME_RECORD, 'Acme', 'Engineer', { output: place });
  assert.ok(info.absoluteDir.startsWith(out + path.sep), info.absoluteDir);
  fs.mkdirSync(info.absoluteDir, { recursive: true });
  const recorded = `${info.storagePathBase}/Bob_Smith.pdf`;
  fs.writeFileSync(path.join(info.absoluteDir, 'Bob_Smith.pdf'), 'resume');
  orders.recordItemOutcome('bat_moved', 0, { state: 'done', files: [{ kind: 'resume-pdf', path: recorded }] });

  const root = orders.getOrder(order.id).outputRoot;
  assert.equal(runBaseDir(root, recorded), path.resolve(out));
  assert.equal(runBaseDir(root, 'elsewhere/file.pdf'), null, 'a path that shares no folder with the root');
  assert.equal(runBaseDir(null, recorded), null);
  assert.equal(await getGeneratedFilePath(recorded), null, 'not under the folder in effect');
  assert.equal(await getGeneratedFilePath(recorded, root), path.join(out, ...recorded.split('/')));

  // An administrator who moved the tree across finds it where it now is.
  const across = path.join(moved, ...recorded.split('/'));
  fs.mkdirSync(path.dirname(across), { recursive: true });
  fs.renameSync(path.join(out, ...recorded.split('/')), across);
  assert.equal(await getGeneratedFilePath(recorded, root), across);
  fs.renameSync(across, path.join(out, ...recorded.split('/')));

  // The sweep deletes it where it is, and prunes what that empties - up to
  // the output folder it was found under, which stays.
  orders.settleOrderIfFinished(order.id);
  orders.setOrderExpiryForTests(order.id, new Date(Date.now() - 1000).toISOString());
  const report = await purgeExpiredOrders();
  assert.deepEqual(report, { orders: 1, filesRemoved: 1, filesMissing: 0 });
  assert.equal(fs.existsSync(path.join(out, ...recorded.split('/'))), false);
  assert.equal(fs.existsSync(root), false, "the run's emptied folder is pruned");
  assert.equal(fs.existsSync(out), true, 'the output folder itself stays');
});
