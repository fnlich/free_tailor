const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ts = require('typescript');

const { useTempStorage } = require('./helpers');

/**
 * What the pages send back of a tailoring, run against the server's own code:
 * the builder's "Manual Edits (JSON)" box (frontend/src/lib/tailoredDraft.ts)
 * against the parse that finishes held content
 * (services/resumeService.ts `parseTailoredResumeContent`), and the profile
 * editor's saved and previewed settings (lib/profileDraft.ts) against the
 * settings the server reads. The box offers only what an edit can change,
 * plus each role's company, title and dates, which only say which role its
 * bullets are (the server restores them from the profile, and the note says
 * so); a copy that held more would show fields whose edits the server undoes,
 * and one that held less would lose an edit or swap two stints' bullets.
 *
 * Loaded the way frontendHelpers.test.js loads its modules: transpiled with
 * the backend's TypeScript, importing nothing at runtime.
 */

const SRC = path.join(__dirname, '..', '..', 'frontend', 'src');

function loadFrontendModule(relative) {
  const file = path.join(SRC, relative);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: file,
  });
  const module = { exports: {} };
  const refuse = (specifier) => {
    throw new Error(`${relative} imports ${specifier}; it is meant to import nothing at runtime`);
  };
  new Function('module', 'exports', 'require', outputText)(module, module.exports, refuse);
  return module.exports;
}

const storage = useTempStorage('frontend-tailoring');
fs.cpSync(path.join(__dirname, '..', 'static', 'skills'), path.join(storage.staticDir, 'skills'), { recursive: true });

const { parseJobAnalysisKeywords, parseTailoredResumeContent } = require('../dist/services/resumeService');
const { buildPreviewProfile, normalizeProfileSettings } = require('../dist/services/profileService');
const draftBox = loadFrontendModule('lib/tailoredDraft.ts');
const profileDraft = loadFrontendModule('lib/profileDraft.ts');

const POSTING = 'We are hiring a senior engineer to ship TypeScript services packaged with Docker. You are Adaptable.';

const ANALYSIS = parseJobAnalysisKeywords(
  JSON.stringify({
    jobMeta: { title: 'Senior Platform Engineer', seniority: 'senior', industry: 'SaaS', department: 'Platform' },
    skills: { technical: ['TypeScript', 'Docker'], tools: [], soft: ['Adaptable'] },
    responsibilities: ['container build pipeline delivery'],
    domainKnowledge: [],
    keywords: { actionVerbs: [], buzzwords: [], mustInclude: [] },
  }),
  POSTING
);

function profile(settings = {}, extra = {}) {
  return {
    id: 'p1',
    name: 'Jane Smith',
    title: '',
    contact: { email: 'jane@example.com', phone: '1', location: 'Remote' },
    summary: 'Engineer who ships.',
    experience: [
      {
        title: 'Engineer',
        company: 'Acme',
        startDate: '01/2020',
        endDate: 'Present',
        location: 'Remote',
        description: 'Built product services.',
        achievements: ['Cut build time by 37%.'],
        skills: [],
      },
      {
        title: 'Developer',
        company: 'Initech',
        startDate: '01/2017',
        endDate: '12/2019',
        location: 'Austin, TX',
        description: '',
        achievements: ['Wrote the billing jobs.'],
        skills: [],
      },
    ],
    strengths: [{ title: 'Own strength', description: 'In her own words.' }],
    skills: ['TypeScript', 'Docker'],
    softSkills: ['Persistence'],
    education: [],
    profileSettings: settings,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

/** A model's answer in the shipped prompt's shape. */
const ANSWER = JSON.stringify({
  title: 'Software Engineer',
  summary: 'Engineer building TypeScript services shipped with Docker.',
  experience: [
    {
      title: 'Engineer',
      company: 'Acme',
      startDate: '01/2020',
      endDate: 'Present',
      location: 'Remote',
      description: '',
      achievements: ['Cut build time by 37% by caching container layers.', 'Moved 12 services onto Docker.'],
    },
    {
      title: 'Developer',
      company: 'Initech',
      startDate: '01/2017',
      endDate: '12/2019',
      location: 'Austin, TX',
      description: '',
      achievements: ['Wrote the TypeScript billing jobs that ran 3 times a day.'],
    },
  ],
  skillGroups: [
    { category: 'Languages', skills: ['TypeScript', 'Go'] },
    { category: 'Containers', skills: ['Docker', 'Kubernetes'] },
    { category: 'Soft Skills', skills: ['Adaptable', 'Communication'] },
  ],
  coverLetter: 'I build things.',
});

const ON = { includeStrengths: true, includeSoftSkills: true };

test('the Manual Edits box holds what an edit can change, and every role without a description', () => {
  const content = parseTailoredResumeContent(ANSWER, profile(ON), ANALYSIS);
  const edit = JSON.parse(draftBox.tailoredDraftOf(content));
  assert.deepEqual(Object.keys(edit), ['title', 'summary', 'experience', 'skillGroups', 'coverLetter']);
  // A role's company, title and dates say which role its bullets are; its
  // place says nothing the others do not, and an edit to it would be undone.
  for (const role of edit.experience) {
    assert.deepEqual(Object.keys(role), ['title', 'company', 'startDate', 'endDate', 'achievements']);
  }
  // The groups as the server stored them, the soft one marked.
  assert.deepEqual(edit.skillGroups, content.skillGroups);
  assert.ok(edit.skillGroups.some((group) => group.soft === true));
  // Nothing derived is shown, so nothing derived can be edited and undone.
  for (const derived of ['hardSkills', 'skills', 'softSkills', 'strengths', 'softSkillGroupHeading', 'unconfirmedHardSkills']) {
    assert.equal(derived in edit, false, derived);
  }
  assert.equal(draftBox.tailoredDraftOf(null), '');
  // The note says what the box shows but the server decides.
  assert.match(draftBox.TAILORED_DRAFT_NOTE, /skillGroups/);
  assert.match(draftBox.TAILORED_DRAFT_NOTE, /title is rebuilt from the profile's headline when it has one/);
  assert.match(draftBox.TAILORED_DRAFT_NOTE, /company, title and dates only say which role/);
  // The module's own header names this file as the one that runs it, and
  // says the identifying fields are restored rather than calling them editable.
  const header = fs.readFileSync(path.join(SRC, 'lib', 'tailoredDraft.ts'), 'utf8').split('*/')[0];
  assert.match(header.replace(/\s*\*\s*/g, ' '), /backend\/test\/frontendTailoring\.test\.js runs it/);
  assert.match(header.replace(/\s*\*\s*/g, ' '), /restores all three from the profile/);
});

test('two stints under one company and title keep their own bullets through the box', () => {
  // Typed oldest first; the model lists them newest first, as the prompt asks.
  const stint = (startDate, endDate, achievements) => ({
    title: 'Engineer',
    company: 'Acme',
    startDate,
    endDate,
    location: 'Remote',
    description: '',
    achievements,
    skills: [],
  });
  const person = profile(ON, {
    experience: [stint('01/2016', '12/2018', ['Wrote the 2016 jobs.']), stint('01/2020', 'Present', ['Ran the 2020 deploys.'])],
  });
  const answer = JSON.stringify({
    ...JSON.parse(ANSWER),
    experience: [
      { title: 'Engineer', company: 'Acme', startDate: '01/2020', endDate: 'Present', achievements: ['Moved 12 services onto Docker in 2020.'] },
      { title: 'Engineer', company: 'Acme', startDate: '01/2016', endDate: '12/2018', achievements: ['Wrote 4 TypeScript jobs in 2016.'] },
    ],
  });
  const content = parseTailoredResumeContent(answer, person, ANALYSIS);
  assert.deepEqual(
    content.experience.map((role) => [role.startDate, role.achievements[0]]),
    [
      ['01/2020', 'Moved 12 services onto Docker in 2020.'],
      ['01/2016', 'Wrote 4 TypeScript jobs in 2016.'],
    ]
  );
  // The dates in the box are what tells the two apart when the edit is sent
  // back; without them each stint's bullets came back under the other's dates.
  const { content: edit } = draftBox.readTailoredDraft(draftBox.tailoredDraftOf(content));
  assert.deepEqual(parseTailoredResumeContent(JSON.stringify(edit), person, ANALYSIS), content);
});

test('the edit sent back finishes exactly as the whole content does, for every switch and layout', () => {
  for (const settings of [{}, ON, { ...ON, technicalSkillsLayout: 'flat' }, { includeSoftSkills: true }]) {
    for (const extra of [{}, { title: 'Senior Engineer' }]) {
      const person = profile(settings, extra);
      const content = parseTailoredResumeContent(ANSWER, person, ANALYSIS);
      const { content: edit, error } = draftBox.readTailoredDraft(draftBox.tailoredDraftOf(content));
      assert.equal(error, '');
      // What /resume/preview and the queue do with held content.
      assert.deepEqual(
        parseTailoredResumeContent(JSON.stringify(edit), person, ANALYSIS),
        parseTailoredResumeContent(JSON.stringify(content), person, ANALYSIS),
        JSON.stringify({ settings, extra })
      );
    }
  }
});

test('what a person edits in the box survives the server: bullets, the summary, the groups and the soft group', () => {
  const person = profile(ON);
  const content = parseTailoredResumeContent(ANSWER, person, ANALYSIS);
  const edit = JSON.parse(draftBox.tailoredDraftOf(content));
  edit.summary = 'Engineer who ships TypeScript and Docker work.';
  edit.experience[1].achievements = ['Rewrote the billing jobs in TypeScript, from 40 minutes to 6.'];
  edit.skillGroups[0].skills.push('Rust');
  const soft = edit.skillGroups.find((group) => group.soft);
  soft.skills = ['Communication'];

  const { content: sent } = draftBox.readTailoredDraft(JSON.stringify(edit));
  const finished = parseTailoredResumeContent(JSON.stringify(sent), person, ANALYSIS);
  assert.equal(finished.summary, edit.summary);
  assert.deepEqual(finished.experience[1].achievements, edit.experience[1].achievements);
  assert.deepEqual(finished.skillGroups[0].skills, ['TypeScript', 'Go', 'Rust']);
  assert.ok(finished.hardSkills.includes('Rust'), 'the technical list is worked out from the groups');
  assert.deepEqual(finished.softSkills, ['Communication'], 'and the Soft Skills section from the soft group');
  // A role's place and dates are the profile's, whatever is typed into an
  // edit: the box shows no place, and its dates only say which role it is.
  edit.experience[0].location = 'Mars';
  edit.experience[0].endDate = '04/2022';
  const read = draftBox.readTailoredDraft(JSON.stringify(edit)).content;
  assert.equal('location' in read.experience[0], false, 'the box does not carry a place');
  const moved = parseTailoredResumeContent(JSON.stringify({ ...read, experience: [{ ...read.experience[0], location: 'Mars' }, read.experience[1]] }), person, ANALYSIS);
  assert.equal(moved.experience[0].location, 'Remote');
  assert.equal(moved.experience[0].endDate, 'Present');
  assert.equal(moved.experience[0].startDate, '01/2020');
  // The title typed into the box is the headline only while the profile has none.
  const retitled = { ...read, title: 'Platform Builder' };
  assert.match(parseTailoredResumeContent(JSON.stringify(retitled), person, ANALYSIS).title, /^Platform Builder\b/);
  const headlined = profile(ON, { title: 'Staff Engineer' });
  assert.match(parseTailoredResumeContent(JSON.stringify(retitled), headlined, ANALYSIS).title, /^Staff Engineer\b/);
});

test('the box refuses what is not one JSON object, and blank is no edit', () => {
  assert.deepEqual(draftBox.readTailoredDraft(''), { content: null, error: '' });
  assert.deepEqual(draftBox.readTailoredDraft('  \n '), { content: null, error: '' });
  assert.match(draftBox.readTailoredDraft('{"title":').error, /Invalid JSON/);
  for (const value of ['[]', '"text"', '12', 'null', '[{"title":"x"}]']) {
    const read = draftBox.readTailoredDraft(value);
    assert.equal(read.content, null, value);
    assert.match(read.error, /one JSON object/, value);
  }
  // The server's parse refuses those too - and a refusal there reads like a
  // stale analysis to the builder, which would then drop the one it holds.
  assert.throws(() => parseTailoredResumeContent('[]', profile(), ANALYSIS));

  // Shapes are read leniently, as the server reads them: a group that is not
  // an object is dropped, a skill that is not text is dropped, `soft` only when true.
  const { content } = draftBox.readTailoredDraft(
    JSON.stringify({
      summary: 'S',
      experience: [{ company: 'Acme', title: 'Engineer', achievements: ['A', 3] }],
      skillGroups: ['x', { category: 'Languages', skills: ['Go', null], soft: 'yes' }, { skills: ['Kind'], soft: true }],
    })
  );
  assert.deepEqual(content.skillGroups, [
    { category: 'Languages', skills: ['Go'] },
    { category: '', skills: ['Kind'], soft: true },
  ]);
  assert.deepEqual(content.experience[0].achievements, ['A']);
  assert.equal(content.title, '');
  assert.equal('coverLetter' in content, false);
});

test('the profile editor saves and previews only settings the server reads', () => {
  const stored = profile({
    resumePromptId: 'tailor-resume',
    // What an older build saved: neither is read any more.
    hardSkillOrdering: 'job-priority',
    coverLetterPromptId: 'custom-generate-cover-letter-mine',
    technicalSkillsLayout: 'flat',
    includeSoftSkills: true,
  });
  const draft = profileDraft.draftFromProfile(stored);
  assert.equal('hardSkillOrdering' in draft.settings, false);
  assert.equal('coverLetterPromptId' in draft.settings, false);
  assert.equal('hardSkillOrdering' in profileDraft.DEFAULT_PROFILE_SETTINGS, false);
  assert.equal('coverLetterPromptId' in profileDraft.DEFAULT_PROFILE_SETTINGS, false);

  const saved = profileDraft.draftToPayload(draft, {}, []).profileSettings;
  const serverKeys = Object.keys(normalizeProfileSettings({}));
  for (const key of Object.keys(saved)) assert.ok(serverKeys.includes(key), `the server reads ${key}`);
  assert.equal(saved.technicalSkillsLayout, 'flat');
  assert.equal(saved.includeSoftSkills, true);

  // The preview is sent the render settings and nothing else - each one the
  // server's preview takes from a draft.
  const previewed = profileDraft.draftToPreviewProfile(draft, []).profileSettings;
  assert.deepEqual(Object.keys(previewed).sort(), ['includeSoftSkills', 'includeStrengths', 'technicalSkillsLayout']);
  const rendered = buildPreviewProfile({ profileSettings: previewed }, null).profileSettings;
  for (const [key, value] of Object.entries(previewed)) assert.equal(rendered[key], value, key);
});

test("the profile editor's Experience section says what a tailored role prints", () => {
  // The parse gives every tailored role an empty description, and the render
  // blanks it again: the editor once promised that tailoring writes one.
  const source = fs.readFileSync(path.join(SRC, 'components', 'profile', 'HistorySections.tsx'), 'utf8');
  const experience = source.match(/title="Experience"\s+description="([^"]*)"/);
  assert.ok(experience, 'the Experience section states its description as a literal');
  assert.doesNotMatch(experience[1], /writes a missing description/);
  assert.match(experience[1], /A tailored resume prints no role description/);

  const content = parseTailoredResumeContent(ANSWER, profile(ON), ANALYSIS);
  assert.ok(content.experience.length > 0);
  for (const role of content.experience) assert.equal(role.description, '');
});

test("the admin Skill Library page says what the library still does, and the parse reads none of it", () => {
  // It once said every account's resumes draw on the tech and soft lists; a
  // tailored resume prints the model's groups, and no resume reads the soft
  // list at all.
  const source = fs.readFileSync(path.join(SRC, 'app', 'admin', 'skills', 'page.tsx'), 'utf8');
  const intro = source.match(/Skill Library<\/h2>\s*<p[^>]*>([\s\S]*?)<\/p>/);
  assert.ok(intro, 'the page states what the library is for under its heading');
  const text = intro[1].replace(/\s+/g, ' ');
  assert.doesNotMatch(text, /resumes draw on/);
  assert.match(text, /untailored resume/);
  assert.match(text, /nothing reads the soft list but this page/);

  const backend = path.join(__dirname, '..', 'src');
  const readers = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && /\breadSkills\(/.test(fs.readFileSync(full, 'utf8'))) {
        readers.push(path.relative(backend, full).split(path.sep).join('/'));
      }
    }
  };
  walk(backend);
  assert.deepEqual(readers.sort(), ['controllers/skills.ts', 'database/skillsDatabase.ts'], 'only the listing route reads a whole list');
});
