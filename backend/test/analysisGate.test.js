const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

// Every seat is a stub here. Set before any dist module loads.
process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli,codex-cli,gemini-cli';

const { countingSeats, freshInstall, posting } = require('./analysisHarness');
const { writeStaticJson } = require('./helpers');

/**
 * The gate is the ONLY way to a job analysis, and the prompt it runs keeps
 * everything that does not change before the posting.
 */

const ai = require('../dist/services/ai/index');
const config = require('../dist/config/aiModelConfig');
const gate = require('../dist/services/jobAnalysis/gate');
const resumeService = require('../dist/services/resumeService');
const { assemblePrompt } = require('../dist/services/ai/promptAssembly');
const { JOB_FIELDS } = require('../dist/config/jobFields');

const SRC = path.join(__dirname, '..', 'src');

function sources(dir = SRC) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

/**
 * Where the analysis prompt may be NAMED, and why. Anything else that names
 * it - or reaches for the two halves of its completion - is a second way to
 * analyse a posting, which is exactly what the one-analysis rule forbids.
 */
const MAY_NAME_THE_PROMPT = new Map([
  ['services/jobAnalysis/gate.ts', 'the gate: the one caller'],
  ['services/promptService.ts', "declares the feature and its variables; runs nothing"],
  ['config/promptCategories.ts', 'files the feature under Extracting'],
  ['types/prompt.ts', 'the feature key type'],
  ['database/migrations/001_openrouter_to_claude_cli.ts', 'frozen history: which prompts shipped then'],
]);

const MAY_BUILD_THE_COMPLETION = new Map([
  ['services/jobAnalysis/gate.ts', 'the gate'],
  ['services/resumeService.ts', 'defines the values builder and the parser'],
]);

test('nothing but the gate names the analysis prompt or builds its completion', () => {
  const offenders = [];
  for (const file of sources()) {
    const relative = path.relative(SRC, file).split(path.sep).join('/');
    const text = fs.readFileSync(file, 'utf8');
    if (/['"`]analyze-job-description['"`]|\bANALYSIS_PROMPT_ID\b/.test(text) && !MAY_NAME_THE_PROMPT.has(relative)) {
      offenders.push(`${relative} names the analysis prompt`);
    }
    if (
      /\b(buildAnalyzeJobDescriptionPromptValues|parseJobAnalysisContent)\b/.test(text) &&
      !MAY_BUILD_THE_COMPLETION.has(relative)
    ) {
      offenders.push(`${relative} builds or parses the analysis completion`);
    }
    if (/\banalyzeJobDescription\s*\(|\banalysisCache\b|\binFlightAnalyses\b/.test(text)) {
      offenders.push(`${relative} has an analysis path of its own`);
    }
  }
  assert.deepEqual(offenders, [], 'a posting must reach a model through services/jobAnalysis/gate.ts alone');

  // And the gate does what this says it does: the analysis call is in it.
  const gateSource = fs.readFileSync(path.join(SRC, 'services', 'jobAnalysis', 'gate.ts'), 'utf8');
  assert.match(gateSource, /createPromptCompletion\(\{\s*promptId: ANALYSIS_PROMPT_ID/);
  assert.equal(fs.existsSync(path.join(SRC, 'services', 'ai', 'analysisCache.ts')), false, 'the in-memory cache is gone');
});

test('the analysis prompt keeps the field list and every unchanging line before the posting, byte for byte', async () => {
  freshInstall('prefix');
  const ref = { id: 'analyze-job-description', mode: 'exact' };
  const one = await assemblePrompt(ref, resumeService.buildAnalyzeJobDescriptionPromptValues(posting(1), 'https://a.example.com/1'));
  const two = await assemblePrompt(
    ref,
    resumeService.buildAnalyzeJobDescriptionPromptValues(`${posting(2)} Something else entirely.`, '')
  );

  assert.equal(one.stableSystem, two.stableSystem, 'the cached part is identical whatever the posting');
  for (const field of JOB_FIELDS) assert.ok(one.stableSystem.includes(`- ${field.id}: ${field.label}`), field.id);
  assert.match(one.stableSystem, /JOB FIELD, SALARY AND SCREENING FACTS/);
  assert.match(one.stableSystem, /"jobField": ""/, 'the output schema is in the cached part too');
  assert.ok(one.stableSystem.endsWith('Job link: '), 'and it stops where the posting starts');
  assert.ok(!one.stableSystem.includes('Posting 1'), 'no posting in the cached part');
  assert.ok(one.userBody.startsWith('https://a.example.com/1\nJob Description:'));
  assert.ok(one.userBody.includes(posting(1)));

  // Through a seat: the system part the CLI caches is the same turn to turn.
  config.invalidateSettingsCache();
  gate.resetAnalysisGateForTests();
  const seats = countingSeats(ai);
  await gate.getOrCreateAnalysis({ jd: posting(3) });
  await gate.getOrCreateAnalysis({ jd: posting(4), link: 'https://b.example.com/4' });
  const [first, second] = seats.analyses();
  assert.equal(first.stableSystem, second.stableSystem);
  assert.notEqual(first.userBody, second.userBody);
});

test("an administrator's analysis prompt from before job fields still gets them asked for, every turn", async () => {
  const { staticDir } = freshInstall('predates');
  writeStaticJson(staticDir, 'prompts/analyze-job-description.json', {
    id: 'analyze-job-description',
    content: 'My own analysis.\nJob Description:\n[[jobDescription]]',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  config.invalidateSettingsCache();
  gate.resetAnalysisGateForTests();
  const seats = countingSeats(ai);
  const row = await gate.getOrCreateAnalysis({ jd: posting(5) });
  const [turn] = seats.analyses();
  assert.match(turn.stableSystem, /^My own analysis\./);
  assert.match(turn.userBody, /ALSO RETURN, in the same JSON object, these three keys/);
  assert.match(turn.userBody, /- backend: Backend/);
  // The seniority words the Job Filter judges, which an older record's own list lacks.
  const seniorityLine = /"jobMeta\.seniority": exactly one of ([^\n]+)/.exec(turn.userBody)?.[1] ?? '';
  for (const word of ['intern', 'director', 'vp', 'junior', 'senior', 'not_specified']) {
    assert.ok(seniorityLine.includes(`"${word}"`), `seniority "${word}" is asked for`);
  }
  assert.match(turn.userBody, /"VP" or "Vice President" -> "vp"/);
  assert.equal(row.jobFieldId, 'backend', 'and the posting is classified');

  // The shipped prompt carries all of it in its cached part, and is sent no addendum.
  const shipped = freshInstall('predates-shipped');
  void shipped;
  config.invalidateSettingsCache();
  gate.resetAnalysisGateForTests();
  const fresh = countingSeats(ai);
  await gate.getOrCreateAnalysis({ jd: posting(6) });
  assert.doesNotMatch(fresh.analyses()[0].userBody, /ALSO RETURN/);
});
