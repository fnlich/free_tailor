const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { useTempStorage } = require('./helpers');

/**
 * A queued resume with no role takes the posting's own title from the
 * analysis - in the cover letter, the file path, the rendered files and the
 * task's result - as /resume/generate always has.
 *
 * The builder used to paper over an empty Job Title with a "Fallback Role"
 * typed on the page; that box is gone, so the queue is where an empty role is
 * filled now. Everything that would print a file or ask a model is stubbed
 * at its module export, which is what the compiled task calls through.
 */

const storage = useTempStorage('queued-role');
fs.mkdirSync(path.join(storage.staticDir, 'templates'), { recursive: true });
fs.copyFileSync(
  path.join(__dirname, '..', 'static', 'templates', 'default.json'),
  path.join(storage.staticDir, 'templates', 'default.json')
);

const resumeService = require('../dist/services/resumeService');
const generatedPath = require('../dist/utils/generatedPath');
const coverLetters = require('../dist/generators/coverLetterGenerator');
const pdfGenerator = require('../dist/generators/pdfGenerator');
const docxGenerator = require('../dist/generators/docxGenerator');
const gate = require('../dist/services/jobAnalysis/gate');
const { runResumeTask, resolveTaskRole, resetResumeTaskStateForTests } = require('../dist/services/queue/resumeTask');

const ANALYSIS = {
  jobMeta: { title: '  Staff Platform Engineer ', seniority: 'staff', industry: '', department: '' },
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

const PROFILE = {
  id: 'p1',
  name: 'Ada',
  title: 'Engineer',
  contact: { email: 'a@b.c', phone: '1', location: 'X' },
  summary: 's',
  experience: [],
  strengths: [],
  skills: ['Python'],
  education: [],
  createdAt: '',
  updatedAt: '',
};

/** Swaps module exports for recorders, and puts them back. */
function stubOutputs() {
  const seen = { coverLetter: [], path: [], pdf: [], docx: [], analysed: 0 };
  const originals = [];
  const swap = (module, name, fake) => {
    originals.push([module, name, module[name]]);
    module[name] = fake;
  };
  // The job's analysis comes through the gate: by the stored id a task
  // carries, else the gate's own lookup-or-analyse, counted here.
  swap(gate, 'loadAnalysis', (id) => (id === 'stored-analysis' ? { id, analysis: ANALYSIS } : null));
  swap(gate, 'getOrCreateAnalysis', async () => {
    seen.analysed += 1;
    return { id: 'fresh-analysis', analysis: ANALYSIS };
  });
  swap(resumeService, 'tailorResume', async () => ({ summary: 's', experience: [], coverLetter: '' }));
  swap(resumeService, 'generateCoverLetter', async (_profile, _company, role) => {
    seen.coverLetter.push(role);
    return 'Dear team';
  });
  swap(generatedPath, 'getGeneratedOutputPath', async (_profile, _company, role) => {
    seen.path.push(role);
    return { storagePathBase: 'x', absoluteDir: storage.rootDir, roleSlug: role };
  });
  swap(coverLetters, 'saveCoverLetter', async () => 'x/cover.pdf');
  swap(coverLetters, 'saveCoverLetterDOCX', async () => 'x/cover.docx');
  swap(pdfGenerator, 'generateResumePDF', async (_p, _t, _c, _i, _company, role) => {
    seen.pdf.push(role);
    return 'x/resume.pdf';
  });
  swap(docxGenerator, 'generateResumeDOCX', async (_p, _t, _c, _i, _company, role) => {
    seen.docx.push(role);
    return 'x/resume.docx';
  });
  return {
    seen,
    restore: () => {
      for (const [module, name, original] of originals.reverse()) module[name] = original;
    },
  };
}

function run(job, format = 'both', analysisId) {
  resetResumeTaskStateForTests();
  return runResumeTask(
    {
      profile: PROFILE,
      job,
      format,
      includeCoverLetterDocx: true,
      choice: { provider: 'claude-cli', modelName: 'sonnet' },
      ...(analysisId ? { analysisId } : {}),
    },
    { signal: new AbortController().signal }
  );
}

test('the rule: a typed role wins, trimmed; an empty one is the analysed title; else empty', () => {
  assert.equal(resolveTaskRole('  Data Engineer ', ANALYSIS), 'Data Engineer');
  assert.equal(resolveTaskRole('', ANALYSIS), 'Staff Platform Engineer');
  assert.equal(resolveTaskRole('   ', ANALYSIS), 'Staff Platform Engineer');
  assert.equal(resolveTaskRole(undefined, ANALYSIS), 'Staff Platform Engineer');
  assert.equal(resolveTaskRole('', undefined), '');
  assert.equal(resolveTaskRole('', { ...ANALYSIS, jobMeta: { ...ANALYSIS.jobMeta, title: ' ' } }), '');
});

test('an empty role is filled from the analysis the task carries, everywhere it is used', async () => {
  const stubs = stubOutputs();
  try {
    const result = await run({ companyName: 'Acme', role: '', jobDescription: 'x' }, 'both', 'stored-analysis');
    assert.equal(result.role, 'Staff Platform Engineer');
    assert.deepEqual(stubs.seen.coverLetter, ['Staff Platform Engineer']);
    assert.deepEqual(stubs.seen.path, ['Staff Platform Engineer']);
    assert.deepEqual(stubs.seen.pdf, ['Staff Platform Engineer']);
    assert.deepEqual(stubs.seen.docx, ['Staff Platform Engineer']);
    assert.equal(stubs.seen.analysed, 0, 'the stored analysis the task named was used, not asked for again');
  } finally {
    stubs.restore();
  }
});

test('and from the analysis the task obtains through the gate, when it carried none', async () => {
  const stubs = stubOutputs();
  try {
    const result = await run(
      { companyName: 'Acme', role: '  ', jobDescription: 'A posting long enough to be analysed by the task. '.repeat(3) },
      'docx'
    );
    assert.equal(stubs.seen.analysed, 1);
    assert.equal(result.role, 'Staff Platform Engineer');
    assert.deepEqual(stubs.seen.path, ['Staff Platform Engineer']);
    assert.deepEqual(stubs.seen.docx, ['Staff Platform Engineer']);
  } finally {
    stubs.restore();
  }
});

test('a role the sheet or the form gave is kept as given', async () => {
  const stubs = stubOutputs();
  try {
    const result = await run({ companyName: 'Acme', role: 'Data Engineer', jobDescription: 'x' }, 'pdf', 'stored-analysis');
    assert.equal(result.role, 'Data Engineer');
    assert.deepEqual(stubs.seen.coverLetter, ['Data Engineer']);
    assert.deepEqual(stubs.seen.pdf, ['Data Engineer']);
  } finally {
    stubs.restore();
  }
});
