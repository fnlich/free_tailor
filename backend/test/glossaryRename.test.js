const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

// Every seat is a stub, as the golden values were computed. Set before any dist
// module loads: the settings defaults are computed at import.
process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli';

const { loadFresh, openTestDb, useTempStorage } = require('./helpers');

/**
 * The v4.2 vocabulary: what the app calls a resume, what it calls a person's
 * account, and what stayed put.
 *
 * v4.1 called a resume a "profile" and a list of resumes a "group". v4.2 moved
 * the first word to "resume" in every name, path, id, SQL text, line of copy
 * and comment (Stage R) and the second to "profile", the person (Stage G), and
 * brought a database written under the old words to the new ones once, in
 * place (database/glossaryRename.ts). This file holds what has to stay true:
 *
 *   1. a fresh database is born with the new names;
 *   2. a database as v4.1 left it - stamped by it or not yet - opens with its
 *      tables, columns and stored JSON keys moved (both tables: `profiles` to
 *      `resumes`, then `profile_groups` to `profiles`), every row intact, the
 *      queue's rows converted, a Bid Assistant answer kept through its sweep,
 *      ONE "[db] Renamed ..." line, and a second open changing nothing; a
 *      database only the first rename reached gets only the second;
 *   3. a stray empty table is dropped and two with rows are refused, by name,
 *      for the resumes and for the people alike;
 *   4. the startup guard's list of columns is build ac3df79's, in its names, and
 *      the guard still reads an unstamped database by them;
 *   5. what a model is told, and every tailoring cache key, are what v4.1
 *      computed (the golden literals);
 *   6. the Bid Assistant still reaches resumes through the renamed modules;
 *   7. nothing of the old vocabulary is left in the source: no retired name, no
 *      retired path, no old compiled module, no "Settings > Profile"; the
 *      people spellings (the `profiles` table, /api/profiles, profilesApi...)
 *      live in their own files only; and no group-sense token is left but the
 *      ones that mean something else (skill groups, the Grouped layout...) or
 *      sit in a file a feature part deletes;
 *   8. the patterns that look for all that catch each shape they are for, and
 *      never a spelling that stays.
 *
 * GATE and RUN spellings (`profileLimit`, `profileIds`,
 * the "Profiles" desk, ...) and the KEEP literals (`[[profileJson]]`, the hashed
 * key `profile:`, `{{profile_name}}`, 'Untitled Profile') are not renamed in this
 * stage, so nothing here may ask for them to be. (The one scan that is not
 * here is the bare word "profile" in copy and comments: each such line is GATE,
 * RUN, KEEP or the printed section heading, which only a reader can tell
 * apart.)
 *
 * Stage G (Group becomes Profile) reuses names Stage R vacated: `profiles`,
 * /api/profiles, profileRepository, `defaultProfileId`... Those spellings meant
 * a resume in Stage R's scans and mean a person now, so the resume-leak scans do
 * not stand down: each of those spellings is allowed in the files that are
 * about people (PEOPLE_SPELLINGS below) and fails everywhere else, and the old
 * group spellings are held to scans of their own (G-1, G-2, G-3).
 */

const REPO = path.join(__dirname, '..', '..');
const BACKEND = path.join(REPO, 'backend');
const SELF = 'backend/test/glossaryRename.test.js';

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const readBackend = (relative) => fs.readFileSync(path.join(BACKEND, relative), 'utf8');
const toPosix = (value) => value.split(path.sep).join('/');
const lineAt = (text, index) => text.slice(0, index).split('\n').length;

/**
 * Source with its comments blanked and every line kept, so a hit keeps its real line number.
 *
 * A script (everything but a stylesheet) is read by the TypeScript parser, which knows a `/*` inside
 * a string, a glob such as 'test/*.test.js', a regular expression or a `//` comment from the start
 * of a comment. A pair of regular expressions did not: the `/*` of "// /admin/* is NOT a reporter's"
 * opened a block comment that ran to the next `*` + `/`, 230 lines on, and the live test code between
 * them was never scanned (frontendRoles.test.js, the file this stage was told to fix for passing
 * falsely). A stylesheet has no line comments, no strings that hold a `/*` and no parser here, so it
 * keeps the block pattern.
 */
function withoutComments(source, { lineComments = true, fileName = 'x.ts' } = {}) {
  if (!lineComments) return source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
  const extension = path.extname(fileName);
  const scriptKind =
    extension === '.tsx'
      ? ts.ScriptKind.TSX
      : extension === '.jsx'
        ? ts.ScriptKind.JSX
        : /^\.(?:js|mjs|cjs)$/.test(extension)
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind);
  const comments = new Map();
  const collect = (ranges) => {
    for (const range of ranges || []) comments.set(range.pos, range);
  };
  const visit = (node) => {
    // JSX text is text: a `//` in it is not a comment.
    if (node.kind === ts.SyntaxKind.JsxText) return;
    collect(ts.getLeadingCommentRanges(source, node.pos));
    collect(ts.getTrailingCommentRanges(source, node.end));
    for (const child of node.getChildren(file)) visit(child);
  };
  visit(file);
  const blanked = source.split('');
  for (const { pos, end } of comments.values()) {
    for (let index = pos; index < end; index += 1) if (blanked[index] !== '\n' && blanked[index] !== '\r') blanked[index] = ' ';
  }
  return blanked.join('');
}

// -- 5. what a model is told ---------------------------------------------- //

/**
 * Computed at step 0 from backend/dist built at 71ae508 (v4.1), by
 * v42-materials/rename/golden.js: a fixed resume, a fixed posting, the
 * tailor-resume prompt values in both modes, and the tailoring cache's keys.
 * Not to be edited by hand. They hold through every stage and part, because the
 * hashed literal key `profile:`, `[[profileJson]]`, `buildPromptResume`'s
 * projection and FIGURES_NOTE_WORDING are KEEP: renaming the resume record
 * changes no byte a model reads, and every cached tailoring stays a hit.
 */
const GOLDEN = {
  analysis: {
    jobMeta: { title: 'Backend Engineer', seniority: 'Senior', industry: 'SaaS', department: 'Platform' },
    skills: {
      technical: ['TypeScript'],
      required: ['TypeScript'],
      preferred: [],
      tools: ['Docker'],
      soft: [],
      technologies: [],
    },
    technologies: ['TypeScript'],
    protocols: [],
    methodologies: [],
    architecturePatterns: [],
    responsibilities: ['backend service development'],
    domainKnowledge: [],
    softSkills: [],
    keywords: { actionVerbs: [], buzzwords: [], mustInclude: [] },
    sourceJobDescription: 'Backend Engineer: TypeScript services shipped with Docker.',
  },
  promptValuesSha256: {
    partial: 'c9811694804a0f7db49ead81b5b6aaaedafb220e2d51907819d91c14ff5b9b64',
    full: '98efeffb22462d44dbf5580556441503792faa80589147adf735fc46fe39ad00',
  },
  promptValueKeys: [
    'conceptKeywordsJson',
    'conceptToolsJson',
    'domainKnowledge',
    'jobAnalysisJson',
    'jobTitle',
    'keyResponsibilitiesJson',
    'keywordsJson',
    'profileJson',
    'skillsJSON',
    'softSkillGroupHeading',
    'targetRoleTitle',
    'topSkillsJson',
  ],
  profileJsonSha256: {
    partial: '2203908d63a1eb2c39fb593342780aea61c71e019ffe67f72c5e146f56b58ddc',
    full: 'a44a60a13cdd327328384351a0ceb432c18498306a2b99f0145c2cdd5a790de5',
  },
  fingerprint: '4f957714a3f826f1710e3c57c1fbb851cad11219e789501bac3348310c206f22',
  keys: {
    resumePartial: '64658a921651afa89a7c4cbf6d90c1a92bb381e1eef3c325479658bc67c3e213',
    resumeFull: 'a95d08ce980be4abcb9fb9ca95de8838a37b4d37398ad29251ec6d0618764294',
    coverLetter: '147299f05fffaa5cb57ad9445649627b430b1cdb3166778d7fe66fc972266068',
  },
  cacheVersion: 2,
};

/** golden.js's fixture, with `resumeSettings` where v4.1 had `profileSettings`. */
function goldenResume() {
  return {
    id: 'p1',
    name: 'Jane',
    title: 'Software Engineer',
    totalYearsExperience: 6,
    contact: { email: 'jane@example.com', phone: '555-0100' },
    summary: 'Backend engineer who writes TypeScript services.',
    experience: [
      {
        title: 'Staff Software Engineer',
        company: 'Amplitude',
        startDate: '01/2022',
        endDate: 'Present',
        location: 'San Francisco',
        description: 'Owned the TypeScript ingestion services. Cut deploys from 40 minutes to 6.',
        achievements: ['Moved the ingestion service to TypeScript, cutting p99 from 900ms to 300ms.'],
        skills: ['TypeScript', 'Kafka'],
      },
      {
        title: 'Software Engineer',
        company: 'Chalk',
        startDate: '06/2019',
        endDate: '12/2021',
        location: 'Remote',
        description: '',
        achievements: [],
        skills: [],
      },
    ],
    strengths: [],
    skills: ['TypeScript'],
    softSkills: [],
    education: [{ degree: 'BS Computer Science', institution: 'MIT' }],
    certifications: [],
    resumeSettings: { tailorMode: 'partial', includeStrengths: false },
    sectionOrder: ['summary', 'experience'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  };
}

test('what a model is told, and every tailoring cache key, are what v4.1 computed', () => {
  const storage = useTempStorage('glossary-golden');
  fs.cpSync(path.join(BACKEND, 'static', 'skills'), path.join(storage.staticDir, 'skills'), { recursive: true });
  const cache = require('../dist/services/tailorCache');
  const resumeService = require('../dist/services/resumeService');

  const resume = goldenResume();
  assert.ok('resumeSettings' in resume && !('profileSettings' in resume), 'the fixture is a resume of today');
  const analysis = () => structuredClone(GOLDEN.analysis);

  const partial = resumeService.buildTailorResumePromptValues(resume, analysis(), 'partial');
  const full = resumeService.buildTailorResumePromptValues(resume, analysis(), 'full');
  assert.deepEqual(Object.keys(partial).sort(), GOLDEN.promptValueKeys, 'a prompt variable was renamed or added');
  assert.equal(sha256(cache.canonicalJson(partial)), GOLDEN.promptValuesSha256.partial);
  assert.equal(sha256(cache.canonicalJson(full)), GOLDEN.promptValuesSha256.full);
  assert.equal(sha256(partial.profileJson), GOLDEN.profileJsonSha256.partial);
  assert.equal(sha256(full.profileJson), GOLDEN.profileJsonSha256.full);

  assert.equal(cache.TAILOR_CACHE_VERSION, GOLDEN.cacheVersion);
  assert.equal(cache.resumeFingerprint(resume), GOLDEN.fingerprint);
  // How a resume is drawn is no part of what the model is asked: its settings and its section order
  // leave the fingerprint, so changing them is a hit (and a legacy key is not stripped - the
  // normaliser moves it, glossaryRename.ts, so a stored one never reaches here).
  assert.equal(
    cache.resumeFingerprint({
      ...resume,
      resumeSettings: { tailorMode: 'full', includeStrengths: true, technicalSkillsLayout: 'flat' },
      sectionOrder: ['experience', 'summary'],
    }),
    GOLDEN.fingerprint
  );

  const choice = { provider: 'claude-cli', modelId: 'claude-cli', modelName: 'sonnet' };
  const context = { analysisId: 'analysis-1', templateId: 'default' };
  const keyOf = (kind, promptValues, extra) =>
    cache.tailorCacheKey({
      kind,
      resume,
      context,
      choice,
      promptId: kind === 'resume' ? 'tailor-resume' : 'generate-cover-letter',
      promptText: 'PROMPT [[profileJson]] [[jobAnalysisJson]]',
      promptValues,
      extra,
    });
  assert.equal(keyOf('resume', partial, { revisePrompt: 'revise-resume-coverage' }), GOLDEN.keys.resumePartial);
  assert.equal(keyOf('resume', full, { revisePrompt: 'revise-resume-coverage' }), GOLDEN.keys.resumeFull);
  assert.equal(
    keyOf('cover-letter', { profileJson: partial.profileJson }, { company: 'Acme', role: 'Backend Engineer' }),
    GOLDEN.keys.coverLetter
  );
});

test('the literals a model reads, and the hashed cache key, are the ones v4.1 had', () => {
  // The golden values above fail on a change that reaches the key or the values; these name the
  // literals themselves, so that a "helpful" rename is stopped at the word and not only at a hash.
  assert.match(
    withoutComments(readBackend('src/services/tailorCache.ts')),
    /\bprofile: resumeFingerprint\(/,
    'the key that is hashed stays `profile:`, so every cached tailoring stays a hit'
  );
  assert.ok(
    readBackend('src/services/reviseCoverage.ts').includes('FIGURES THE PROFILE STATES AND THE DRAFT DROPPED'),
    "the revise pass's figures sentence is part of its cache key and of what the model reads"
  );
  assert.ok(
    withoutComments(readBackend('src/services/resumeDocument.ts')).includes("'Untitled Profile'"),
    "a resume with no name is still 'Untitled Profile': it reaches the model and the Bid Assistant"
  );
  for (const file of [
    'src/services/promptService.ts',
    'src/services/resumeService.ts',
    'src/config/promptCategories.ts',
    'src/types/prompt.ts',
  ]) {
    assert.ok(readBackend(file).includes('extract-profile-from-resume'), `${file} names the prompt by its stored id`);
  }
  assert.ok(
    fs.existsSync(path.join(BACKEND, 'static', 'prompts', 'extract-profile-from-resume.json')),
    'the prompt file keeps its name: the file name is the id'
  );
});

// -- 6. the Bid Assistant ------------------------------------------------- //

test('the Bid Assistant reaches resumes through the renamed modules, and every member it calls exists', () => {
  useTempStorage('glossary-bid-assistant');
  const code = withoutComments(readBackend('src/routes/bidAssistant.ts'));

  assert.doesNotMatch(code, /profileRepository|profileService/, 'it requires neither retired module');
  // It is `@ts-nocheck`, so tsc does not say when a require goes stale: every relative one is a module.
  const requires = [...code.matchAll(/require\('(\.\.?\/[^']+)'\)/g)].map((match) => match[1]);
  assert.ok(requires.length >= 6, `its requires are found (${requires.length})`);
  for (const specifier of requires) {
    const compiled = path.resolve(BACKEND, 'dist', 'routes', `${specifier}.js`);
    assert.ok(fs.existsSync(compiled), `${specifier} is a compiled module (${toPosix(path.relative(REPO, compiled))})`);
  }

  const aliasOf = (specifier) =>
    new RegExp(`const\\s+(\\w+)\\s*=\\s*require\\('${specifier.replace(/\//g, '\\/')}'\\)`).exec(code)?.[1];
  const modules = {
    [aliasOf('../database/resumeRepository')]: require('../dist/database/resumeRepository'),
    [aliasOf('../services/resumeDocument')]: require('../dist/services/resumeDocument'),
  };
  assert.deepEqual(Object.keys(modules).sort(), ['resumeDocument', 'resumeRepository']);
  for (const [alias, exported] of Object.entries(modules)) {
    const members = [...new Set([...code.matchAll(new RegExp(`\\b${alias}\\.(\\w+)`, 'g'))].map((match) => match[1]))];
    assert.ok(members.length >= 2, `the route calls ${alias} (${members.join(', ')})`);
    for (const member of members) assert.equal(typeof exported[member], 'function', `${alias}.${member} is exported`);
  }

  // Its create is the resumes page's: placed under a profile (the person), the limit counted inside the
  // transaction and only when that makes a new profile - so it takes no limit of its own (F1, D18).
  assert.doesNotMatch(code, /profileLimit/, 'it requires no limit: createResumes counts it, inside the create');
  assert.match(code, /\bresumeRepository\.createResumes\(/, 'its create goes through createResumes');
  assert.doesNotMatch(code, /\bresumeRepository\.saveResume\([^)]*buildNewResume/s, 'and no longer through a raw save of a new resume');
  // The limit is GATE: it lives in database/profileLimit.ts, not in the resume repository.
  const profileLimit = require('../dist/database/profileLimit');
  for (const name of ['countProfilesForOwner', 'ProfileLimitError', 'assertCanAddProfile']) {
    assert.equal(typeof profileLimit[name], 'function', `${name} lives in database/profileLimit`);
    assert.equal(typeof modules.resumeRepository[name], 'undefined', `${name} is no longer the resume repository's`);
  }
});

test("the Bid Assistant's orphan sweep reads the resumes table", () => {
  const code = withoutComments(readBackend('src/bidAssistant/database.js'), { fileName: 'database.js' });
  assert.match(
    code,
    /DELETE FROM answers\s+WHERE NOT EXISTS \(SELECT 1 FROM resumes WHERE resumes\.id = answers\.profile_id\)/,
    'its answers are keyed by `profile_id` (its storage keeps its word) and name resume ids'
  );
  assert.doesNotMatch(code, /FROM profiles\b/);
});

// -- 1-3. the database ---------------------------------------------------- //

const NOW = '2026-02-03T04:05:06.000Z';

const tablesOf = (raw) => raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
const columnsOf = (raw, table) => raw.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
const meta = (raw, key) => raw.prepare('SELECT value FROM schema_meta WHERE key = ?').get(key)?.value ?? null;
const jsonOf = (raw, sql, ...params) => JSON.parse(raw.prepare(sql).get(...params).data);

/** Every table and every row in it, for comparing a database with itself after another open. */
function dumpOf(dbDir) {
  const raw = openTestDb(dbDir);
  try {
    const dump = {
      schema: raw.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all(),
    };
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'job_lake_fts%' ORDER BY name")
      .all();
    for (const { name } of tables) dump[name] = raw.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
    return dump;
  } finally {
    raw.close();
  }
}

/** Opens the database the way the server does, taking down what it logs; the error when it refuses. */
function openIt({ bidAssistant = true } = {}) {
  const logged = [];
  const log = console.log;
  console.log = (...args) => logged.push(args.join(' '));
  let error = null;
  try {
    const sqlite = loadFresh('../dist/database/sqlite');
    try {
      sqlite.getDb();
      // Its sweep runs as it loads: after the rename, as it does at a real start (openAtStartup).
      if (bidAssistant) loadFresh('../dist/bidAssistant/database');
      sqlite.getDb().close();
    } catch (cause) {
      error = cause;
    }
  } finally {
    console.log = log;
  }
  return { logged, error };
}

const renamedLines = (logged) => logged.filter((line) => /^\[db\] Renamed\b/.test(line));

/** Every phrase is in the line, in the order given. */
function assertRenamedLineOrder(line, phrases) {
  let from = 0;
  for (const phrase of phrases) {
    const at = line.indexOf(phrase, from);
    assert.ok(at >= 0, `"${phrase}" is in, and after the one before it: ${line}`);
    from = at + phrase.length;
  }
}

/** A resume as build 4.1 stored one: its settings under `profileSettings`. */
function v41Resume(id, name, extra = {}) {
  return {
    id,
    name,
    title: 'Software Engineer',
    contact: { email: `${id}@example.com`, phone: '555-0100', location: 'Remote' },
    summary: 'Builds backend services.',
    experience: [
      {
        title: 'Engineer',
        company: 'Acme',
        startDate: '01/2020',
        endDate: 'Present',
        description: '',
        achievements: ['Shipped it.'],
        skills: ['TypeScript'],
      },
    ],
    skills: ['TypeScript'],
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  };
}

const V41_SETTINGS = { tailorMode: 'full', technicalSkillsLayout: 'flat', includeStrengths: true };
const V41_RESUMES = [
  { id: 'res-1', name: 'Jane', disabled: 0, owner: 'user-1', document: v41Resume('res-1', 'Jane', { profileSettings: V41_SETTINGS }) },
  { id: 'res-2', name: 'Joan', disabled: 1, owner: 'user-2', document: v41Resume('res-2', 'Joan') },
];
/**
 * A group's member list is NOT moved: stored lists are unread from the features on, and the owner re-adds them.
 * The group becomes a profile, row for row, and its document is left byte for byte as it was written.
 */
const V41_GROUP = { id: 'group-1', name: 'Backend roles', profileIds: ['res-1', 'res-2'], createdAt: NOW, updatedAt: NOW };
/** The settings as v4.1 stored them: `defaultProfileId` a RESUME's id, `defaultGroupId` a group's. */
const V41_SETTINGS_ROW = { defaultProfileId: 'res-1', defaultGroupId: 'group-1', defaultTheme: 'dark' };

/** A queued batch's tasks as 4.1 stored them, and as they read once the five keys have moved. */
const V41_TASKS = [
  {
    id: 'task-1',
    seq: 0,
    state: 'done',
    before: {
      queue: 'claude-cli',
      kind: 'resume',
      label: { profileId: 'res-1', profileName: 'Jane', companyName: 'Acme', role: 'Engineer' },
      payload: { profileId: 'res-1', jobIndex: 0, costMilli: 23, analysisId: 'analysis-1' },
      value: { profileId: 'res-1', profileName: 'Jane', files: ['jane.pdf'] },
    },
    after: {
      queue: 'claude-cli',
      kind: 'resume',
      label: { resumeId: 'res-1', resumeName: 'Jane', companyName: 'Acme', role: 'Engineer' },
      payload: { resumeId: 'res-1', jobIndex: 0, costMilli: 23, analysisId: 'analysis-1' },
      value: { resumeId: 'res-1', resumeName: 'Jane', files: ['jane.pdf'] },
    },
  },
  {
    // Not built yet: no value to move.
    id: 'task-2',
    seq: 1,
    state: 'queued',
    before: {
      queue: 'claude-cli',
      kind: 'resume',
      label: { profileId: 'res-2', profileName: 'Joan', companyName: 'Acme', role: 'Engineer' },
      payload: { profileId: 'res-2', jobIndex: 0 },
    },
    after: {
      queue: 'claude-cli',
      kind: 'resume',
      label: { resumeId: 'res-2', resumeName: 'Joan', companyName: 'Acme', role: 'Engineer' },
      payload: { resumeId: 'res-2', jobIndex: 0 },
    },
  },
];

/** The shape of the table build 4.1 kept resumes in (and this build keeps them in, as `resumes`). */
const resumeTableDdl = (name) => `CREATE TABLE ${name} (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  disabled   INTEGER NOT NULL DEFAULT 0,
  data       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  owner_id   TEXT
)`;

/** The shape of the table of people: build 4.1 kept groups in it as `profile_groups`, this build as `profiles`. It has no `disabled`. */
const peopleTableDdl = (name) => `CREATE TABLE ${name} (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  data       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  owner_id   TEXT
)`;
const PEOPLE_COLUMNS = ['id', 'name', 'data', 'created_at', 'updated_at', 'owner_id'];

const insertGroup = (raw, table) =>
  raw
    .prepare(`INSERT INTO ${table} (id, name, data, created_at, updated_at, owner_id) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(V41_GROUP.id, V41_GROUP.name, JSON.stringify(V41_GROUP), NOW, NOW, 'user-1');

const putSettings = (raw, settings) =>
  raw
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('app-settings', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(JSON.stringify(settings), NOW);

/** This build's own empty database, opened once the way the server does (its tables, the Bid Assistant's, its stamp). */
function freshDatabaseDir(name) {
  const { dbDir } = useTempStorage(`glossary-${name}`);
  const sqlite = loadFresh('../dist/database/sqlite');
  sqlite.getDb();
  loadFresh('../dist/bidAssistant/database'); // its tables (jobs, answers), on the same connection
  sqlite.getDb().close();
  return dbDir;
}

/**
 * A database as build 4.1 left it, near enough: made by this build (so with every other table and
 * mark it needs), then taken back to the old words in raw SQL - the two tables, the three columns -
 * and given rows written the old way: a resume's `profileSettings`, the settings' `defaultProfileId`
 * (a resume) and `defaultGroupId`, five keys of a queued task, a group with its members, an order
 * item and a cache row naming a resume, and two Bid Assistant answers (one for a resume that is
 * there, one for a resume that is not).
 *
 * `stamped` is a database 4.1 itself opened (it wrote `baseline_build`); not stamped is one that
 * only ac3df79 finished, which the startup guard reads once and stamps. `change` then alters the
 * old-shaped database further.
 */
function buildV41Database(name, { stamped = true, change = () => {} } = {}) {
  const dbDir = freshDatabaseDir(name);

  const raw = openTestDb(dbDir);
  try {
    // v4.1 had no `resumes.profile_id` and neither index of the tree (F1), and the DROP COLUMN below needs them gone.
    raw.exec(`
      DROP INDEX IF EXISTS idx_resumes_owner_profile;
      DROP INDEX IF EXISTS idx_profiles_owner;
      ALTER TABLE resumes DROP COLUMN profile_id;
    `);
    // The people first: this build's `profiles` is the table the old resumes are about to take.
    raw.exec(`
      ALTER TABLE profiles RENAME TO profile_groups;
      ALTER TABLE resumes RENAME TO profiles;
      ALTER TABLE order_items RENAME COLUMN resume_id TO profile_id;
      ALTER TABLE order_items RENAME COLUMN resume_name TO profile_name;
      ALTER TABLE tailor_cache RENAME COLUMN resume_id TO profile_id;
    `);

    const insertResume = raw.prepare(
      'INSERT INTO profiles (id, name, disabled, data, created_at, updated_at, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    for (const row of V41_RESUMES) {
      insertResume.run(row.id, row.name, row.disabled, JSON.stringify(row.document), NOW, NOW, row.owner);
    }
    insertGroup(raw, 'profile_groups');
    raw
      .prepare(
        `INSERT INTO order_items (id, order_id, seq, task_id, profile_id, profile_name, company_name, role, state, files, created_at, updated_at)
         VALUES ('item-1', 'order-1', 0, 'task-1', 'res-1', 'Jane', 'Acme', 'Engineer', 'done', '[]', ?, ?)`
      )
      .run(NOW, NOW);
    raw
      .prepare(
        `INSERT INTO tailor_cache (cache_key, kind, content, model_id, analysis_id, profile_id, created_at)
         VALUES ('key-1', 'resume', '{}', 'model-1', 'analysis-1', 'res-1', ?)`
      )
      .run(NOW);
    raw
      .prepare('INSERT INTO generation_batches (id, state, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('batch-1', 'running', JSON.stringify({ shared: { kind: 'order' } }), NOW, NOW);
    const insertTask = raw.prepare(
      'INSERT INTO generation_tasks (id, batch_id, seq, state, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    for (const task of V41_TASKS) {
      insertTask.run(task.id, 'batch-1', task.seq, task.state, JSON.stringify(task.before), NOW, NOW);
    }
    putSettings(raw, V41_SETTINGS_ROW);
    const insertAnswer = raw.prepare(
      `INSERT INTO answers (job_id, profile_id, question, answer, char_limit, question_order, updated_at)
       VALUES (1, ?, 'Why us?', ?, 500, 0, ?)`
    );
    insertAnswer.run('res-1', 'Because.', NOW);
    insertAnswer.run('res-gone', 'An orphan.', NOW);

    if (!stamped) {
      raw.prepare("DELETE FROM schema_meta WHERE key = 'baseline_build'").run();
      raw.prepare("UPDATE schema_meta SET value = '8' WHERE key = 'provider_schema_version'").run();
    }
    change(raw);
  } finally {
    raw.close();
  }
  return dbDir;
}

/**
 * A database only Stage R reached: the resumes are `resumes` already, in this build's words, and the
 * groups are still `profile_groups` - which is how the R build left every database it opened, and
 * what the people block alone is for. `defaultGroupId` is what an administrator saved under that build.
 */
const R_ONLY_SETTINGS_ROW = { defaultResumeId: 'res-1', defaultGroupId: 'group-1', defaultTheme: 'dark' };
const R_ONLY_RESUME = v41Resume('res-1', 'Jane', { resumeSettings: V41_SETTINGS });

function buildRDatabase(name, { change = () => {} } = {}) {
  const dbDir = freshDatabaseDir(name);
  const raw = openTestDb(dbDir);
  try {
    // This build's `profiles` is empty and people-shaped: it stands in for the R build's `profile_groups`.
    raw.exec('ALTER TABLE profiles RENAME TO profile_groups');
    raw
      .prepare('INSERT INTO resumes (id, name, disabled, data, created_at, updated_at, owner_id) VALUES (?, ?, 0, ?, ?, ?, ?)')
      .run('res-1', 'Jane', JSON.stringify(R_ONLY_RESUME), NOW, NOW, 'user-1');
    insertGroup(raw, 'profile_groups');
    putSettings(raw, R_ONLY_SETTINGS_ROW);
    change(raw);
  } finally {
    raw.close();
  }
  return dbDir;
}

/** A group keeps its member list as it was - stored lists are unread from the features on - under its new table. */
function assertGroupIsProfile(raw) {
  assert.deepEqual(jsonOf(raw, "SELECT data FROM profiles WHERE id = 'group-1'"), V41_GROUP);
  assert.deepEqual(
    raw.prepare("SELECT id, name, created_at, updated_at, owner_id FROM profiles WHERE id = 'group-1'").get(),
    { id: 'group-1', name: V41_GROUP.name, created_at: NOW, updated_at: NOW, owner_id: 'user-1' }
  );
}

/** The people the repository reads, as the server would: the old group, now a profile, by its name. */
function readProfilesLikeTheServer() {
  const sqlite = loadFresh('../dist/database/sqlite');
  loadFresh('../dist/database/documentTable');
  const repository = loadFresh('../dist/database/profileRepository');
  try {
    return repository.listProfilesFor(null);
  } finally {
    sqlite.getDb().close();
  }
}

/** What opening a v4.1 database must have done to it. */
function assertRenamed(dbDir) {
  const raw = openTestDb(dbDir);
  try {
    const tables = tablesOf(raw);
    assert.ok(tables.includes('resumes'), 'the resume table is `resumes`');
    assert.ok(tables.includes('profiles'), 'and `profiles` is the table of people (what v4.1 called groups)');
    assert.ok(!tables.includes('profile_groups'), 'whose old name is gone');
    assert.deepEqual(columnsOf(raw, 'profiles'), PEOPLE_COLUMNS, 'a table of people never had `disabled`');
    // ... and a fresh `resumes` ends with the column that files a resume under its profile (F1; NULL until filed).
    assert.deepEqual(columnsOf(raw, 'resumes'), ['id', 'name', 'disabled', 'data', 'created_at', 'updated_at', 'owner_id', 'profile_id']);
    for (const [table, columns] of Object.entries({ order_items: ['resume_id', 'resume_name'], tailor_cache: ['resume_id'] })) {
      const have = columnsOf(raw, table);
      for (const column of columns) assert.ok(have.includes(column), `${table}.${column} exists`);
      for (const old of columns.map((column) => column.replace('resume_', 'profile_'))) {
        assert.ok(!have.includes(old), `${table}.${old} is gone`);
      }
    }

    // Rows intact: the same ids, names, flags, owners and timestamps.
    assert.deepEqual(
      raw.prepare('SELECT id, name, disabled, owner_id, created_at, updated_at FROM resumes ORDER BY id').all(),
      V41_RESUMES.map((row) => ({ id: row.id, name: row.name, disabled: row.disabled, owner_id: row.owner, created_at: NOW, updated_at: NOW }))
    );
    // The documents: the settings under their new key, everything else byte for byte what it was.
    const first = jsonOf(raw, "SELECT data FROM resumes WHERE id = 'res-1'");
    assert.deepEqual(first.resumeSettings, V41_SETTINGS);
    assert.ok(!('profileSettings' in first), 'the old key is gone');
    const { profileSettings: _moved, ...firstUnmoved } = V41_RESUMES[0].document;
    const { resumeSettings: _arrived, ...firstNow } = first;
    assert.deepEqual(firstNow, firstUnmoved, 'nothing else in the document moved');
    // A resume with no settings gets none made up.
    assert.deepEqual(jsonOf(raw, "SELECT data FROM resumes WHERE id = 'res-2'"), V41_RESUMES[1].document);

    assertGroupIsProfile(raw);

    // The settings: the default resume is the old default's id, and the default profile is the old
    // default GROUP's - never the resume's, which `defaultProfileId` held until a moment ago; other fields stay.
    const settings = JSON.parse(raw.prepare("SELECT value FROM app_settings WHERE key = 'app-settings'").get().value);
    assert.equal(settings.defaultResumeId, 'res-1', 'the default resume is the old default profile id');
    assert.equal(settings.defaultProfileId, 'group-1', 'the default profile is the old default group id');
    assert.ok(!('defaultGroupId' in settings), 'the old key is gone');
    assert.equal(settings.defaultTheme, 'dark');

    // Money history and the cache name the same resume, under the new columns.
    assert.deepEqual(
      raw.prepare("SELECT resume_id, resume_name, company_name FROM order_items WHERE id = 'item-1'").get(),
      { resume_id: 'res-1', resume_name: 'Jane', company_name: 'Acme' }
    );
    assert.deepEqual(
      raw.prepare("SELECT resume_id, kind, content FROM tailor_cache WHERE cache_key = 'key-1'").get(),
      { resume_id: 'res-1', kind: 'resume', content: '{}' }
    );

    // A task queued before the upgrade reads in the new words, so it restores and builds.
    for (const task of V41_TASKS) {
      assert.deepEqual(jsonOf(raw, 'SELECT data FROM generation_tasks WHERE id = ?', task.id), task.after, task.id);
    }
    assert.deepEqual(jsonOf(raw, "SELECT data FROM generation_batches WHERE id = 'batch-1'"), { shared: { kind: 'order' } });

    // The Bid Assistant: the answer for a resume that is there survived its sweep, the orphan did not.
    assert.deepEqual(
      raw.prepare('SELECT profile_id FROM answers ORDER BY profile_id').all().map((row) => row.profile_id),
      ['res-1']
    );
  } finally {
    raw.close();
  }
}

test('a fresh database is born with the new names', () => {
  const { dbDir } = useTempStorage('glossary-fresh');
  loadFresh('../dist/database/sqlite').getDb().close();
  const { RENAMED_TABLES, RENAMED_COLUMNS } = require('../dist/database/glossaryRename');

  const raw = openTestDb(dbDir);
  try {
    const tables = tablesOf(raw);
    assert.ok(tables.includes('resumes'));
    // And the people are `profiles`, in the shape the rename of the groups looks for: no `disabled`.
    assert.ok(tables.includes('profiles'));
    assert.ok(!tables.includes('profile_groups'));
    // The step tells build 4.1's table of resumes (also named `profiles`) from this one by that column ALONE: were
    // the people ever to gain one, the next start would take their table for the old resumes and rename it over `resumes`.
    assert.ok(
      !columnsOf(raw, 'profiles').includes('disabled'),
      'the table of people must never gain a `disabled` column: glossaryRename.ts takes a `profiles` that has one for the table of resumes build 4.1 kept'
    );
    assert.deepEqual(columnsOf(raw, 'profiles'), PEOPLE_COLUMNS);
    assert.ok(columnsOf(raw, 'resumes').includes('disabled'), 'the shape the resume rename looks for');

    const orderItems = columnsOf(raw, 'order_items');
    assert.ok(orderItems.includes('resume_id') && orderItems.includes('resume_name'));
    assert.ok(!orderItems.includes('profile_id') && !orderItems.includes('profile_name'));
    const cache = columnsOf(raw, 'tailor_cache');
    assert.ok(cache.includes('resume_id') && !cache.includes('profile_id'));

    // And the maps the step is driven by (and upgradeGuard.test.js translates through) say the same.
    assert.deepEqual(RENAMED_TABLES, { profiles: 'resumes', profile_groups: 'profiles' });
    assert.deepEqual(Object.keys(RENAMED_TABLES), ['profiles', 'profile_groups'], 'the resumes move first: the people take the name they vacate');
    assert.deepEqual(RENAMED_COLUMNS, {
      order_items: { profile_id: 'resume_id', profile_name: 'resume_name' },
      tailor_cache: { profile_id: 'resume_id' },
    });
    for (const to of Object.values(RENAMED_TABLES)) assert.ok(tables.includes(to), `${to} is created by SCHEMA`);
    for (const [table, columns] of Object.entries(RENAMED_COLUMNS)) {
      const have = columnsOf(raw, table);
      for (const [from, to] of Object.entries(columns)) {
        assert.ok(have.includes(to) && !have.includes(from), `${table}.${from} is ${to} here`);
      }
    }
  } finally {
    raw.close();
  }
  assert.equal(openIt().error, null, 'and it opens again, with nothing renamed');
});

test('the keys the step moves are the ones the glossary names, and no others', () => {
  const { MOVED_JSON_KEYS } = require('../dist/database/glossaryRename');
  assert.deepEqual(
    MOVED_JSON_KEYS.map((move) => `${move.table}.${move.column} ${move.from} -> ${move.to}${move.rowKey ? ` [${move.rowKey}]` : ''}`),
    [
      'resumes.data $.profileSettings -> $.resumeSettings',
      'app_settings.value $.defaultProfileId -> $.defaultResumeId [app-settings]',
      'generation_tasks.data $.label.profileId -> $.label.resumeId',
      'generation_tasks.data $.label.profileName -> $.label.resumeName',
      'generation_tasks.data $.payload.profileId -> $.payload.resumeId',
      'generation_tasks.data $.value.profileId -> $.value.resumeId',
      'generation_tasks.data $.value.profileName -> $.value.resumeName',
      // After the resume block has moved defaultProfileId away: until then the name holds a resume id.
      'app_settings.value $.defaultGroupId -> $.defaultProfileId [app-settings]',
    ]
  );
  const keys = MOVED_JSON_KEYS.map((move) => move.from);
  assert.ok(
    keys.indexOf('$.defaultProfileId') >= 0 && keys.indexOf('$.defaultProfileId') < keys.indexOf('$.defaultGroupId'),
    'the resume default moves out of defaultProfileId before the group default moves in'
  );
});

for (const stamped of [true, false]) {
  test(`a database as v4.1 left it (${stamped ? 'stamped by it' : 'not stamped yet'}) opens renamed, intact, and then is left alone`, () => {
    const dbDir = buildV41Database(stamped ? 'v41-stamped' : 'v41-unstamped', { stamped });

    // It really is the old shape before it is opened, so the checks below cannot pass for nothing.
    const before = openTestDb(dbDir);
    try {
      const tables = tablesOf(before);
      assert.ok(tables.includes('profiles') && tables.includes('profile_groups') && !tables.includes('resumes'));
      assert.ok(columnsOf(before, 'profiles').includes('disabled'), '`profiles` is the table of resumes here');
      assert.ok(!columnsOf(before, 'profile_groups').includes('disabled'));
      assert.deepEqual(JSON.parse(before.prepare("SELECT value FROM app_settings WHERE key = 'app-settings'").get().value), V41_SETTINGS_ROW);
      assert.ok(columnsOf(before, 'order_items').includes('profile_id'));
      assert.ok(columnsOf(before, 'tailor_cache').includes('profile_id'));
      assert.equal(meta(before, 'baseline_build'), stamped ? 'ac3df79' : null);
    } finally {
      before.close();
    }

    const first = openIt();
    assert.equal(first.error, null, String(first.error?.stack));
    assertRenamed(dbDir);
    // One line, once the rename has committed; and the sweep took the orphaned answer, by its own sentence.
    assert.equal(renamedLines(first.logged).length, 1, first.logged.join('\n'));
    assert.match(renamedLines(first.logged)[0], /^\[db\] Renamed for v4\.2: .*resumes/);
    // The resume block runs whole before the people block (D7: the people's moves come after the resumes'): the
    // people take the name `profiles` the resumes vacate, and their default must not land on a resume id. So the
    // line reads the resumes' table, then their default id, then the people's table, then the people's default.
    assertRenamedLineOrder(renamedLines(first.logged)[0], [
      'table profiles to resumes',
      'app_settings.value defaultProfileId to defaultResumeId (1 row(s))',
      'table profile_groups to profiles',
      'app_settings.value defaultGroupId to defaultProfileId (1 row(s))',
    ]);
    assert.ok(first.logged.some((line) => /Removed 1 saved answer/.test(line)), first.logged.join('\n'));
    // The group reads as a profile, by the repository the routes use.
    assert.deepEqual(
      readProfilesLikeTheServer().map((profile) => [profile.id, profile.name]),
      [[V41_GROUP.id, V41_GROUP.name]]
    );

    const raw = openTestDb(dbDir);
    try {
      assert.equal(meta(raw, 'baseline_build'), 'ac3df79', 'the startup guard let it in and stamped it');
      assert.equal(meta(raw, 'credit_unit'), 'usd-milli');
    } finally {
      raw.close();
    }

    // A second open changes nothing: not a row, not the schema, and it has nothing to say.
    const settled = dumpOf(dbDir);
    const second = openIt();
    assert.equal(second.error, null, String(second.error?.stack));
    assert.equal(renamedLines(second.logged).length, 0, second.logged.join('\n'));
    assert.deepEqual(dumpOf(dbDir), settled);
    assertRenamed(dbDir);
  });
}

test('an empty resumes table an unfinished start made beside the old one is dropped, and the old one is renamed', () => {
  const dbDir = buildV41Database('stray-empty-new', {
    change: (raw) => raw.exec(resumeTableDdl('resumes')),
  });
  const opened = openIt();
  assert.equal(opened.error, null, String(opened.error?.stack));
  assertRenamed(dbDir);
  assert.equal(renamedLines(opened.logged).length, 1);
  assert.match(renamedLines(opened.logged)[0], /dropped/, 'and says it dropped one');
});

test('an empty profiles table an older build made beside the renamed one is dropped, and the resumes are left as they are', () => {
  // The R build's database (resumes renamed, the groups still `profile_groups`), and then an older
  // build's SCHEMA, which runs at every start and makes the table it knows beside the one R renamed.
  const dbDir = buildRDatabase('stray-empty-old', { change: (raw) => raw.exec(resumeTableDdl('profiles')) });

  const opened = openIt();
  assert.equal(opened.error, null, String(opened.error?.stack));
  const after = openTestDb(dbDir);
  try {
    // The old shape is judged by its `disabled` column: the name `profiles` is the people's now.
    assert.ok(tablesOf(after).includes('profiles') && !tablesOf(after).includes('profile_groups'));
    assert.ok(!columnsOf(after, 'profiles').includes('disabled'), 'the old-shaped table is dropped, and the groups take its name');
    assertGroupIsProfile(after);
    assert.deepEqual(jsonOf(after, "SELECT data FROM resumes WHERE id = 'res-1'"), R_ONLY_RESUME);
  } finally {
    after.close();
  }
  assert.equal(renamedLines(opened.logged).length, 1);
  assertRenamedLineOrder(renamedLines(opened.logged)[0], [
    'dropped the empty profiles table an older build had made',
    'table profile_groups to profiles',
  ]);
});

/** A database holding BOTH tables with rows: an older build saved a resume into the table it knows. */
function buildConflictedDatabase(name) {
  return buildV41Database(name, {
    stamped: false,
    change: (raw) => {
      raw.exec(resumeTableDdl('resumes'));
      raw
        .prepare('INSERT INTO resumes (id, name, disabled, data, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?)')
        .run('res-new', 'Newer', JSON.stringify(v41Resume('res-new', 'Newer')), NOW, NOW);
    },
  });
}

test('two tables that both hold rows are refused, by name, and nothing is touched - not even the guard\'s first stamp', () => {
  const dbDir = buildConflictedDatabase('conflict');
  const before = dumpOf(dbDir);

  const opened = openIt();
  assert.ok(opened.error, 'it does not open');
  assert.equal(opened.error.name, 'VocabularyConflictError');
  assert.ok(opened.error.message.includes(path.join(dbDir, 'free_tailor.db')), 'the file is named');
  assert.match(opened.error.message, /"profiles" table .*"resumes" table, and both hold rows/);
  assert.match(opened.error.message, /Restore the backup/);
  assert.equal(renamedLines(opened.logged).length, 0, 'nothing is said to have been renamed');

  // Rolled back as one: both tables, the unstamped database still unstamped, no table made.
  assert.deepEqual(dumpOf(dbDir), before);
  const raw = openTestDb(dbDir);
  try {
    assert.equal(meta(raw, 'baseline_build'), null);
  } finally {
    raw.close();
  }
  // Asked again, refused again: no connection was kept for it.
  assert.equal(openIt().error?.name, 'VocabularyConflictError');
});

test('the server stops at that refusal with its sentence and exit code 1, before any route loads', () => {
  const dbDir = buildConflictedDatabase('conflict-server');
  const run = spawnSync(process.execPath, [path.join(BACKEND, 'dist', 'index.js')], {
    env: { ...process.env, DB_DIR: dbDir, PORT: '3146', HOST: '127.0.0.1' },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(run.status, 1, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /\[db\] The database at .* has both a "profiles" table .* and a "resumes" table/);
  assert.doesNotMatch(run.stderr, /\n\s+at /, 'a sentence, not a stack trace');
  assert.doesNotMatch(run.stdout, /listening|Database:/i, 'it never started serving');
});

// -- 2b. Stage G alone: the people ------------------------------------------ //

test('a database only the resume rename reached gets only the people rename, and is then left alone', () => {
  const dbDir = buildRDatabase('r-only');
  const resumesBefore = dumpOf(dbDir).resumes;

  const raw0 = openTestDb(dbDir);
  try {
    const tables = tablesOf(raw0);
    assert.ok(tables.includes('resumes') && tables.includes('profile_groups') && !tables.includes('profiles'));
  } finally {
    raw0.close();
  }

  const first = openIt();
  assert.equal(first.error, null, String(first.error?.stack));
  const raw = openTestDb(dbDir);
  try {
    assert.ok(tablesOf(raw).includes('profiles') && !tablesOf(raw).includes('profile_groups'));
    assert.deepEqual(columnsOf(raw, 'profiles'), PEOPLE_COLUMNS);
    assertGroupIsProfile(raw);
    assert.deepEqual(dumpOf(dbDir).resumes, resumesBefore, 'the resumes are not touched');
    // The resume default stays the resume default; the group default becomes the profile default.
    const settings = JSON.parse(raw.prepare("SELECT value FROM app_settings WHERE key = 'app-settings'").get().value);
    assert.deepEqual(settings, { defaultResumeId: 'res-1', defaultProfileId: 'group-1', defaultTheme: 'dark' });
  } finally {
    raw.close();
  }
  // ONE line, and it is about the people alone: the resume block did not run.
  assert.equal(renamedLines(first.logged).length, 1, first.logged.join('\n'));
  assertRenamedLineOrder(renamedLines(first.logged)[0], [
    'table profile_groups to profiles',
    'app_settings.value defaultGroupId to defaultProfileId (1 row(s))',
  ]);
  assert.doesNotMatch(renamedLines(first.logged)[0], /table profiles to resumes|defaultResumeId/);

  const settled = dumpOf(dbDir);
  const second = openIt();
  assert.equal(second.error, null, String(second.error?.stack));
  assert.equal(renamedLines(second.logged).length, 0, second.logged.join('\n'));
  assert.deepEqual(dumpOf(dbDir), settled, 'a second open changes nothing');
});

test('a default profile that is there already is not overwritten by a stored default group', () => {
  const dbDir = buildRDatabase('r-only-default-kept', {
    change: (raw) => putSettings(raw, { defaultResumeId: 'res-1', defaultProfileId: 'kept', defaultGroupId: 'group-1' }),
  });
  const opened = openIt();
  assert.equal(opened.error, null, String(opened.error?.stack));
  const raw = openTestDb(dbDir);
  try {
    const settings = JSON.parse(raw.prepare("SELECT value FROM app_settings WHERE key = 'app-settings'").get().value);
    assert.deepEqual(settings, { defaultResumeId: 'res-1', defaultProfileId: 'kept', defaultGroupId: 'group-1' });
  } finally {
    raw.close();
  }
  assert.doesNotMatch(renamedLines(opened.logged)[0] ?? '', /defaultGroupId/);
});

test('a v4.1 database with no default group does not get a default profile made from the default resume', () => {
  // The order the two moves run in is the point: `defaultProfileId` held a RESUME id until the resume block moved it.
  const dbDir = buildV41Database('v41-no-group-default', {
    change: (raw) => putSettings(raw, { defaultProfileId: 'res-1', defaultTheme: 'dark' }),
  });
  const opened = openIt();
  assert.equal(opened.error, null, String(opened.error?.stack));
  const raw = openTestDb(dbDir);
  try {
    const settings = JSON.parse(raw.prepare("SELECT value FROM app_settings WHERE key = 'app-settings'").get().value);
    assert.deepEqual(settings, { defaultResumeId: 'res-1', defaultTheme: 'dark' });
  } finally {
    raw.close();
  }
  assert.doesNotMatch(renamedLines(opened.logged)[0] ?? '', /defaultGroupId/);
});

test('a settings row that already holds the new resume default is left exactly as it is: the moves never overwrite and never delete', () => {
  // Not a state a v4.1 database can be in (it has no `defaultResumeId`); an older build saving the settings on
  // a database this one had upgraded can leave it, and an older build is never to be started on one. D7: a move
  // happens only where the old key is there and the new one is not, so nothing moves - `defaultProfileId` keeps
  // what it held and `defaultGroupId` stays beside it, unread. Nothing is overwritten and nothing is lost.
  const stored = { defaultProfileId: 'res-1', defaultResumeId: 'res-2', defaultGroupId: 'group-1', defaultTheme: 'dark' };
  const dbDir = buildV41Database('v41-both-resume-defaults', { change: (raw) => putSettings(raw, stored) });
  const opened = openIt();
  assert.equal(opened.error, null, String(opened.error?.stack));
  const raw = openTestDb(dbDir);
  try {
    const settings = JSON.parse(raw.prepare("SELECT value FROM app_settings WHERE key = 'app-settings'").get().value);
    assert.deepEqual(settings, stored);
  } finally {
    raw.close();
  }
  // The tables and the resumes' own documents were renamed all the same.
  assertRenamedLineOrder(renamedLines(opened.logged)[0], ['table profiles to resumes', 'table profile_groups to profiles']);
  assert.doesNotMatch(renamedLines(opened.logged)[0], /defaultResumeId|defaultGroupId|defaultProfileId/);
});

test('an empty profiles table beside profile_groups, which has rows, is dropped, and the groups are renamed', () => {
  // SCHEMA of an earlier start made the empty people table (or a half-finished upgrade did).
  const dbDir = buildRDatabase('people-stray-empty-new', { change: (raw) => raw.exec(peopleTableDdl('profiles')) });
  const opened = openIt();
  assert.equal(opened.error, null, String(opened.error?.stack));
  const raw = openTestDb(dbDir);
  try {
    assert.ok(!tablesOf(raw).includes('profile_groups'));
    assertGroupIsProfile(raw);
  } finally {
    raw.close();
  }
  assert.equal(renamedLines(opened.logged).length, 1);
  assertRenamedLineOrder(renamedLines(opened.logged)[0], [
    'dropped the empty profiles table an unfinished start had made',
    'table profile_groups to profiles',
  ]);
});

test('an empty profile_groups beside profiles, which has rows, is dropped, and the profiles are kept', () => {
  // An older build re-creates the table it knows at every start, on a database this one had upgraded.
  const dbDir = buildRDatabase('people-stray-empty-old', {
    change: (raw) => {
      raw.exec('DELETE FROM profile_groups');
      raw.exec(peopleTableDdl('profiles'));
      insertGroup(raw, 'profiles');
      putSettings(raw, { defaultResumeId: 'res-1', defaultProfileId: 'group-1', defaultTheme: 'dark' });
    },
  });
  const opened = openIt();
  assert.equal(opened.error, null, String(opened.error?.stack));
  const raw = openTestDb(dbDir);
  try {
    assert.ok(!tablesOf(raw).includes('profile_groups'), 'the stray is dropped');
    assertGroupIsProfile(raw);
    const settings = JSON.parse(raw.prepare("SELECT value FROM app_settings WHERE key = 'app-settings'").get().value);
    assert.deepEqual(settings, { defaultResumeId: 'res-1', defaultProfileId: 'group-1', defaultTheme: 'dark' });
  } finally {
    raw.close();
  }
  assert.equal(renamedLines(opened.logged).length, 1);
  assert.match(renamedLines(opened.logged)[0], /dropped the empty profile_groups table an older build had made/);
  assert.doesNotMatch(renamedLines(opened.logged)[0], /table profile_groups to profiles/);

  // And the next start has nothing left to do.
  const settled = dumpOf(dbDir);
  assert.equal(renamedLines(openIt().logged).length, 0);
  assert.deepEqual(dumpOf(dbDir), settled);
});

/** BOTH people tables with rows: an older build saved a group into the table it knows. */
function buildPeopleConflictedDatabase(name) {
  return buildRDatabase(name, {
    change: (raw) => {
      raw.exec(peopleTableDdl('profiles'));
      raw
        .prepare('INSERT INTO profiles (id, name, data, created_at, updated_at, owner_id) VALUES (?, ?, ?, ?, ?, ?)')
        .run('profile-new', 'Newer', JSON.stringify({ id: 'profile-new', name: 'Newer', resumeIds: [] }), NOW, NOW, 'user-1');
    },
  });
}

test('two people tables that both hold rows are refused, by name, and nothing is touched', () => {
  const dbDir = buildPeopleConflictedDatabase('people-conflict');
  const before = dumpOf(dbDir);

  const opened = openIt();
  assert.ok(opened.error, 'it does not open');
  assert.equal(opened.error.name, 'VocabularyConflictError');
  assert.deepEqual(opened.error.tables, ['profile_groups', 'profiles']);
  assert.ok(opened.error.message.includes(path.join(dbDir, 'free_tailor.db')), 'the file is named');
  assert.match(
    opened.error.message,
    /"profile_groups" table \(what build 4\.1 called a group of resumes\) and a "profiles" table, and both hold rows/
  );
  assert.match(opened.error.message, /Restore the backup/);
  assert.equal(renamedLines(opened.logged).length, 0, 'nothing is said to have been renamed');
  assert.deepEqual(dumpOf(dbDir), before, 'rolled back as one');
  assert.equal(openIt().error?.name, 'VocabularyConflictError', 'asked again, refused again');
});

test('the server stops at the refusal of the people tables too, with its sentence and exit code 1', () => {
  const dbDir = buildPeopleConflictedDatabase('people-conflict-server');
  const run = spawnSync(process.execPath, [path.join(BACKEND, 'dist', 'index.js')], {
    env: { ...process.env, DB_DIR: dbDir, PORT: '3147', HOST: '127.0.0.1' },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(run.status, 1, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /\[db\] The database at .* has both a "profile_groups" table .* and a "profiles" table/);
  assert.doesNotMatch(run.stderr, /\n\s+at /, 'a sentence, not a stack trace');
  assert.doesNotMatch(run.stdout, /listening|Database:/i, 'it never started serving');
});

test('a profiles table that still has the old `disabled` column is a defect of the step, not data: the people block throws', () => {
  // renameRetiredVocabulary always runs the resume block first, which renames or refuses such a table,
  // so this cannot come from a database: only from calling the people block without it.
  const dbDir = freshDatabaseDir('people-defect');
  const raw = openTestDb(dbDir);
  try {
    raw.exec('ALTER TABLE profiles RENAME TO profile_groups');
    raw.exec(resumeTableDdl('profiles'));
    const before = tablesOf(raw).sort();
    const { renamePeopleTable } = require('../dist/database/glossaryRename');
    assert.throws(() => renamePeopleTable(raw, []), /"profiles" table still has .* "disabled" column/);
    assert.deepEqual(tablesOf(raw).sort(), before, 'and it touched nothing');
  } finally {
    raw.close();
  }
});

// -- 4. the startup guard ------------------------------------------------- //

/**
 * The list as build ac3df79 wrote it (test/upgradeGuard.test.js holds the same copy): it names
 * tables as THAT build did, because the guard reads a database before glossaryRename renames it.
 */
const AC3DF79_ADDED_COLUMNS = {
  profiles: ['owner_id'],
  profile_groups: ['owner_id'],
  users: [
    'sheet_id',
    'sheet_url',
    'sheet_shared_at',
    'stripe_customer_id',
    'notifications_seen_at',
    'balance_milli',
    'sheet_layout',
    'sheet_all_gid',
    'sheet_temp_gid',
    'report_rate_milli',
  ],
  payments: ['fee_cents', 'credits_granted', 'credit_milli', 'credited_milli', 'refunded_milli', 'refund_cents'],
  credit_ledger: ['delta_milli', 'balance_after_milli'],
  credit_reservations: ['units_milli', 'refunded_milli'],
  notifications: ['recipient_id', 'link'],
  order_items: ['cost_milli', 'provider_id'],
  refund_requests: ['hold_key'],
  orders: ['kind'],
  job_analyses: ['company_name'],
  job_lake: ['job_type', 'clearance', 'industry'],
  job_lake_history: ['job_type', 'clearance', 'industry'],
  answers: ['question_order'],
  google_sheets: ['account_id'],
};

test("the guard's list of columns is build ac3df79's, in the names that build used - never the renamed ones", () => {
  const { UPGRADE_ADDED_COLUMNS } = require('../dist/database/upgradeGuard');
  const { RENAMED_TABLES } = require('../dist/database/glossaryRename');
  assert.deepEqual(UPGRADE_ADDED_COLUMNS, AC3DF79_ADDED_COLUMNS);
  // Each renamed table is asked about by its OLD name, and its new name is not in the list - except
  // `profiles`, which is ac3df79's name for the resume table AND this build's name for the people: it
  // is in the list as the first (the resume table, renamed to `resumes`), never as the second.
  for (const [from, to] of Object.entries(RENAMED_TABLES)) {
    assert.ok(from in UPGRADE_ADDED_COLUMNS, `asks about ${from}`);
    if (to !== 'profiles') assert.ok(!(to in UPGRADE_ADDED_COLUMNS), `asks about ${from}, not ${to}`);
  }
  assert.equal(RENAMED_TABLES.profiles, 'resumes', 'in that list `profiles` is the resume table');
  assert.equal(RENAMED_TABLES.profile_groups, 'profiles', 'and `profile_groups` the people');
});

test("the guard still reads an unstamped database by ac3df79's table names, before they are renamed", () => {
  // A table `profiles` that never got `owner_id` is what an unfinished upgrade looks like, and is
  // named as ac3df79 named it. (Asked of `resumes`, the guard would find no table and ask nothing.)
  const dbDir = buildV41Database('guard-names', {
    stamped: false,
    change: (raw) => raw.exec('ALTER TABLE profiles DROP COLUMN owner_id'),
  });
  const opened = openIt();
  assert.ok(opened.error, 'it does not open');
  assert.equal(opened.error.name, 'DatabaseNotUpgradedError');
  assert.match(opened.error.message, /its tables lack columns build ac3df79 adds \(profiles\.owner_id\)\. Start build ac3df79/);
  assert.equal(opened.error.problems.length, 1, opened.error.problems.join(' | '));
  assert.equal(renamedLines(opened.logged).length, 0);

  // Refused before the rename: the old names are still there.
  const raw = openTestDb(dbDir);
  try {
    const tables = tablesOf(raw);
    assert.ok(tables.includes('profiles') && !tables.includes('resumes'));
    assert.equal(meta(raw, 'baseline_build'), null);
  } finally {
    raw.close();
  }
});

// -- 7. the source -------------------------------------------------------- //

const COMPILED_MODULES_GONE = [
  'config/profileSections',
  'services/profileService',
  'services/profileImport',
  'services/sampleProfile',
  // Stage G: the group modules, which are the people modules now (the `profile` ones, in the same folders).
  'types/group',
  'database/groupRepository',
  'routes/groups',
];

test('no compiled module of a retired path is left in backend/dist', () => {
  const dist = path.join(BACKEND, 'dist');
  assert.ok(fs.existsSync(path.join(dist, 'index.js')), 'backend/dist is built (npm run build --prefix backend)');
  const left = COMPILED_MODULES_GONE.flatMap((module) =>
    ['.js', '.js.map', '.d.ts', '.d.ts.map']
      .map((extension) => `${module}${extension}`)
      .filter((file) => fs.existsSync(path.join(dist, file)))
  );
  // A build never deletes what its source no longer makes, so a stale module here would satisfy
  // a test that still requires the old path: delete backend/dist and build again.
  assert.deepEqual(left, [], 'delete backend/dist and build again');
  for (const module of [
    'database/glossaryRename',
    'database/profileLimit',
    'database/resumeRepository',
    'services/resumeDocument',
    'types/profile',
    'database/profileRepository',
    'database/profileTree',
    'services/profileRules',
    'routes/profiles',
  ]) {
    assert.ok(fs.existsSync(path.join(dist, `${module}.js`)), `${module} is compiled`);
  }
});

/** The retired paths that nothing reuses, and the files and folders the moves made. */
const PATHS_GONE = [
  'backend/src/config/profileSections.ts',
  'backend/src/services/profileService.ts',
  'backend/src/services/profileImport.ts',
  'backend/src/services/sampleProfile.ts',
  'backend/test/profileExperienceSkills.test.js',
  'backend/test/profileImport.test.js',
  'backend/test/profilePreview.test.js',
  'backend/test/profileSections.test.js',
  'frontend/src/app/admin/profiles/new',
  'frontend/src/app/admin/profiles/[id]',
  'frontend/src/components/profile',
  'frontend/src/components/admin/profileTemplateChrome.module.css',
  'frontend/src/lib/profileDraft.ts',
  'frontend/src/lib/profileGallery.ts',
  'frontend/src/lib/profileModel.ts',
  'frontend/src/lib/profileSections.ts',
  // Stage G: the group files moved to the people's names.
  'backend/src/types/group.ts',
  'backend/src/database/groupRepository.ts',
  'backend/src/routes/groups.ts',
  // F34: the Groups page, the several-profile targets, the model's price helper and the Multiple flow's previews.
  'frontend/src/app/admin/groups',
  'frontend/src/components/builder/ProfileTargets.tsx',
  'frontend/src/app/admin/models/modelPrice.ts',
  'frontend/src/lib/builderPreviews.ts',
];
const PATHS_MOVED_TO = [
  'backend/src/types/profile.ts',
  'backend/src/database/profileRepository.ts',
  'backend/src/routes/profiles.ts',
  'backend/src/types/resume.ts',
  'backend/src/database/resumeRepository.ts',
  'backend/src/database/profileLimit.ts',
  'backend/src/database/glossaryRename.ts',
  'backend/src/routes/resumes.ts',
  'backend/src/services/resumeDocument.ts',
  'backend/src/services/resumeImport.ts',
  'backend/src/services/sampleResume.ts',
  'backend/src/config/sectionCatalogue.ts',
  'backend/test/resumeExperienceSkills.test.js',
  'backend/test/resumeImport.test.js',
  'backend/test/resumeDraftPreview.test.js',
  'backend/test/sectionCatalogue.test.js',
  'frontend/src/app/admin/resumes/new/page.tsx',
  'frontend/src/app/admin/resumes/[id]/page.tsx',
  'frontend/src/components/resume/ResumeEditor.tsx',
  'frontend/src/components/resume/ResumeCards.tsx',
  'frontend/src/components/resume/ResumeDraftPreview.tsx',
  'frontend/src/components/resume/useResumeImport.ts',
  'frontend/src/components/admin/resumeTemplateChrome.module.css',
  'frontend/src/lib/resumeDraft.ts',
  'frontend/src/lib/resumeGallery.ts',
  'frontend/src/lib/resumeModelChoice.ts',
  'frontend/src/lib/sectionCatalogue.ts',
];

/**
 * Every path in the tree that names a profile. The GATE and RUN files (the limit, the desk, the selector,
 * the targets), a prompt's file name (KEEP), and the three files Stage G made out of the group files:
 * the only paths that may, because a profile is a person now and these are about people.
 */
const PATHS_STILL_NAMED_PROFILE = [
  'backend/src/database/profileLimit.ts',
  'backend/src/database/profileRepository.ts',
  // F1: the tree of people and their resumes, and the rules it keeps (the tests of it are named for it too).
  'backend/src/database/profileTree.ts',
  'backend/src/routes/profiles.ts',
  'backend/src/services/profileRules.ts',
  'backend/src/types/profile.ts',
  'backend/static/prompts/extract-profile-from-resume.json',
  'backend/test/profileTree.test.js',
  // F34: the profiles desk. A profile is a person, and these are the pages, components and helpers that draw
  // and test people (the dashboard, a profile's page, the cards, dialogs and search, the dashboard's decisions).
  'backend/test/e2e/profiles.js',
  'backend/test/frontendProfiles.test.js',
  'frontend/src/app/admin/profiles/[profileId]/page.tsx',
  'frontend/src/app/admin/profiles/page.tsx',
  'frontend/src/components/ProfileSelector.tsx',
  'frontend/src/components/profiles/KeywordChips.tsx',
  'frontend/src/components/profiles/KeywordsCard.tsx',
  'frontend/src/components/profiles/ProfileCards.tsx',
  'frontend/src/components/profiles/ProfileDialogs.tsx',
  'frontend/src/components/profiles/SearchBox.tsx',
  'frontend/src/components/profiles/ViewToggle.tsx',
  'frontend/src/components/profiles/flashNotice.ts',
  'frontend/src/components/profiles/focusAfterRemoval.ts',
  'frontend/src/components/profiles/profiles.module.css',
  'frontend/src/components/profiles/useResumeActions.tsx',
  'frontend/src/lib/profileDashboard.ts',
];

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.next', '.git', 'generated', 'fixtures']);
const SOURCE_FILE = /\.(?:tsx?|jsx?|mjs|cjs|css)$/;
const SCAN_ROOTS = ['backend/src', 'backend/scripts', 'backend/test', 'frontend/src', 'frontend/scripts', 'scripts'];

/** Files of the Bid Assistant keep its own words (owner decision 7); they are read separately. */
const isBidAssistant = (relative) =>
  relative.startsWith('frontend/src/bid-assistant/') ||
  relative.startsWith('backend/src/bidAssistant/') ||
  relative === 'backend/src/routes/bidAssistant.ts';

function walkRepo(rootRelative, keep = () => true) {
  const found = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) visit(full);
      } else if (keep(toPosix(path.relative(REPO, full)))) {
        found.push(toPosix(path.relative(REPO, full)));
      }
    }
  };
  const root = path.join(REPO, rootRelative);
  if (fs.existsSync(root)) visit(root);
  return found;
}

let scanned = null;
/** Every source file in scope, with its text and its text without comments. */
function sourceFiles() {
  if (scanned) return scanned;
  const relatives = [
    ...SCAN_ROOTS.flatMap((root) => walkRepo(root, (relative) => SOURCE_FILE.test(relative))),
    'frontend/next.config.ts',
  ].filter((relative) => fs.existsSync(path.join(REPO, relative)));
  scanned = relatives.map((relative) => {
    const text = fs.readFileSync(path.join(REPO, relative), 'utf8');
    return { relative, text, code: withoutComments(text, { lineComments: !relative.endsWith('.css'), fileName: relative }) };
  });
  return scanned;
}

/**
 * Files that may say anything: the step itself, and this file, which names every old spelling to
 * look for it. (The Bid Assistant's own test keeps its own vocabulary - `profile_id`, `profileId`,
 * `focusProfileId`, `targetProfileIds`, its `*-profile-id` ids and its relative `/profiles` routes.)
 */
const SAYS_ANYTHING = new Set([
  'backend/src/database/glossaryRename.ts',
  SELF,
  'backend/test/bidAssistantScoping.test.js',
]);

test('the paths of the old vocabulary are gone, and the moved files are where the glossary put them', () => {
  const present = (relative) => fs.existsSync(path.join(REPO, relative));
  assert.deepEqual(PATHS_GONE.filter(present), []);
  assert.deepEqual(PATHS_MOVED_TO.filter((relative) => !present(relative)), []);
  // The desk keeps its address; the chooser and the editor moved to /admin/resumes, and a profile's own page (F34)
  // is the one folder besides the dashboard.
  assert.deepEqual(fs.readdirSync(path.join(REPO, 'frontend/src/app/admin/profiles')).sort(), ['[profileId]', 'page.tsx']);
  assert.deepEqual(fs.readdirSync(path.join(REPO, 'frontend/src/app/admin/resumes')).sort(), ['[id]', 'new']);
  // There is no Groups page, not even a redirect: /admin/groups is a Next 404 (F34).
  assert.equal(fs.existsSync(path.join(REPO, 'frontend/src/app/admin/groups')), false);
});

test('R-1: no path in the tree names a profile but the GATE and RUN files, the three people files and a prompt id', () => {
  // A feature part that adds a path about people (a page, a component, a stylesheet) lists it in
  // PATHS_STILL_NAMED_PROFILE, with the reason: that is the point of the check.
  const everything = [
    ...['backend/src', 'backend/scripts', 'backend/test', 'backend/static', 'frontend/src', 'frontend/scripts', 'scripts'].flatMap((root) =>
      walkRepo(root)
    ),
    ...fs.readdirSync(REPO).filter((name) => fs.statSync(path.join(REPO, name)).isFile()),
  ];
  assert.ok(everything.length > 500, `the walk reads the tree (${everything.length})`);
  const named = everything.filter((relative) => /profile/i.test(relative));
  assert.deepEqual(named.sort(), [...PATHS_STILL_NAMED_PROFILE].sort());
});

/**
 * The people spellings: words and paths that meant a RESUME in v4.1 and mean a PERSON since Stage G
 * (the `profiles` table, /api/profiles, routes/profiles, profileRepository, types/profile, profilesApi,
 * the settings' default-profile id...). Each is allowed ONLY in the files that are about people - its
 * own files, the files that mount or call them, and the settings that name the default profile - and
 * a resume-sense use anywhere else still fails, which is what keeps the leak scans working after
 * the word changed meaning. A feature part that gives people a new home (a page, a component, a
 * route) adds its file here, with the pattern it is allowed to use.
 *
 * A set of files, or a function of (relative path, the code, the index of the hit) for a rule that is
 * about a part of a file.
 */
const PROFILES_API_CLIENT = 'frontend/src/lib/api.ts';
/** True where `index` is inside the `profilesApi` client of lib/api.ts, and nowhere else in that file. */
function insideProfilesApi(code, index) {
  const start = code.indexOf('export const profilesApi = {');
  if (start < 0) return false;
  const end = code.indexOf('\n};', start);
  return index > start && index < (end < 0 ? code.length : end);
}
/**
 * The people router has `/` and `/:id`; these sub-paths belong to the RESUME router alone (routes/resumes.ts).
 * A quoted `/profiles/preview` is a resume-sense call the rename left behind, even in the files that mount or
 * call the people router, whose other `/profiles` paths are the people's. `index` is the opening quote's.
 */
const RESUME_ONLY_SUBPATH_RE = /^['"\x60]\/(?:api\/)?profiles\/(?:preview|import|upload|entries)(?![\w-])/;
const namesResumeOnlySubpath = (code, index) => RESUME_ONLY_SUBPATH_RE.test(code.slice(index, index + 80));
const PEOPLE_FILES = {
  // The three files of the people, and the places that mount, call or store them.
  // F1: the tree (database/profileTree.ts) declares the table of people and writes it with the repository.
  repository: new Set(['backend/src/database/profileRepository.ts', 'backend/src/database/profileTree.ts']),
  // (F1: publicErrors.test.js makes a person with the repository's own create, to prove the limit's refusal is public.)
  routerAndRepository: new Set([
    'backend/src/database/profileRepository.ts',
    'backend/src/routes/profiles.ts',
    'backend/test/profileTree.test.js',
    'backend/test/publicErrors.test.js',
  ]),
  // F1: the files that read or write the people's table in SQL - the tree, the repository and the limit's count.
  tableOfPeople: new Set([
    'backend/src/database/profileLimit.ts',
    'backend/src/database/profileRepository.ts',
    'backend/src/database/profileTree.ts',
    // The seed helper writes a person by raw SQL (seedProfileWithResumes).
    'backend/test/helpers.js',
    // The tree's test reads and writes the table of people, and files resumes under them, by SQL.
    'backend/test/profileTree.test.js',
  ]),
  // F1: `resumes.profile_id`, the column that files a resume under its profile: the schema, the tree and the two repositories.
  // (`DELETE FROM answers WHERE profile_id = ?` in resumeRepository.ts is the Bid Assistant's storage, the older reason.)
  treeColumn: new Set([
    'backend/src/database/profileRepository.ts',
    'backend/src/database/profileTree.ts',
    'backend/src/database/resumeRepository.ts',
    'backend/src/database/sqlite.ts',
    // The tree's test reads `resumes.profile_id` to check where a resume is filed.
    'backend/test/profileTree.test.js',
  ]),
  // F1: the files that name the people's type to move one around: the tree, the repositories and the router.
  // F2: the run's target (services/resumeChoice.ts) holds a `Profile` - the person a run builds for.
  peopleType: new Set([
    'backend/src/database/profileRepository.ts',
    'backend/src/database/profileTree.ts',
    'backend/src/database/resumeRepository.ts',
    'backend/src/routes/profiles.ts',
    'backend/src/services/resumeChoice.ts',
  ]),
  // F2: the test that gives a PERSON the id 'profile-N' (a profile id in a settings body, not a DOM id or
  // class): the settings tests' `defaultProfileId: 'profile-1'`. (The build modes' and keywords' fixtures say
  // 'refusals-world' and 'person-9', so a real 'profile-x' DOM id in those files is still caught; the R-4 test
  // checks this list is still used.)
  // F34: the profiles desk's test gives its fixture resume a profile 'profile-1' (a person's id).
  profileFixtureIds: new Set([
    'backend/test/aiModelConfig.test.js',
    'backend/test/frontendProfiles.test.js',
    // ... and the editor's helpers' fixture resume, filed under 'profile-1' (Duplicate drops it).
    'backend/test/frontendEditorHelpers.test.js',
  ]),
  // F34: the dialogs that name, rename and choose a person draw them with DOM ids of their own
  // (`profile-name-form`, the `profile-target` radio group of Move and New resume).
  profileDomIds: new Set(['frontend/src/components/profiles/ProfileDialogs.tsx', 'backend/test/e2e/profiles.js']),
  // F34: a profile's own page, /admin/profiles/<id>: the helper that builds the address and the desk test that
  // checks it. (The resume editor's and chooser's old addresses under it - /new and /[id] - are still a leak there.)
  profilePage: new Set([
    'frontend/src/lib/profileDashboard.ts',
    'backend/test/frontendProfiles.test.js',
    // The rail and desk route tests, and the browser script that opens a profile that is not there.
    'backend/test/frontendRoles.test.js',
    'backend/test/e2e/profiles.js',
    'backend/test/e2e/shell.js',
  ]),
  // ... and the type they share, which declares the people's DTO.
  people: new Set(['backend/src/database/profileRepository.ts', 'backend/src/routes/profiles.ts', 'backend/src/types/profile.ts']),
  schema: new Set(['backend/src/database/sqlite.ts']),
  // (F1: the tree's test mounts the people router and calls /api/profiles.)
  mount: new Set([
    'backend/src/index.ts',
    'backend/test/profileTree.test.js',
    'backend/test/routeAccess.test.js',
    'backend/test/sectionPermissions.test.js',
    // F34: the desk's test mounts the people router and calls it through the real client.
    'backend/test/frontendProfiles.test.js',
  ]),
  // The pages and components that read or write the people with profilesApi (F34: the Groups page is gone; the
  // dashboard, a profile's page, the new-resume page, the editor and the builder's and Find Jobs' pickers load them).
  profilesApiUsers: new Set([
    PROFILES_API_CLIENT,
    'frontend/src/app/admin/profiles/[profileId]/page.tsx',
    'frontend/src/app/admin/profiles/page.tsx',
    'frontend/src/app/admin/resumes/new/page.tsx',
    'frontend/src/app/admin/settings/page.tsx',
    'frontend/src/app/jobs/OrderJobsDialog.tsx',
    'frontend/src/app/page.tsx',
    'frontend/src/components/profiles/ProfileDialogs.tsx',
    'frontend/src/components/profiles/useResumeActions.tsx',
    'frontend/src/components/resume/ResumeEditor.tsx',
    // The tests that run the client against the real routes or pin which page loads the people.
    'backend/test/frontendFindJobs.test.js',
    'backend/test/frontendProfiles.test.js',
    'backend/test/frontendRoles.test.js',
  ]),
  // The administrator's default profile (`defaultProfileId`, `#default-profile`): the settings type and its
  // readers, the settings page, and the tests of the settings.
  defaultProfile: new Set([
    'backend/src/config/aiModelConfig.ts',
    'frontend/src/lib/api.ts',
    'frontend/src/lib/runChoices.ts',
    'frontend/src/app/admin/settings/page.tsx',
    'backend/test/aiModelConfig.test.js',
    'backend/test/settingDefaults.test.js',
    'backend/test/userModelAccess.test.js',
    'backend/test/frontendHelpers.test.js',
    'backend/test/frontendFindJobs.test.js',
    // F34: the settings tests send and read the default profile with the rest of the Builder Defaults.
    'backend/test/frontendSettings.test.js',
  ]),
  // (... and the browser script that reads the select's tag.)
  defaultProfileId: new Set([
    'frontend/src/app/admin/settings/page.tsx',
    'backend/test/e2e/profiles.js',
    'backend/test/e2e/shell.js',
    'backend/test/frontendSettings.test.js', // pins the box's id in the page's source
  ]),
  // F34: a person's card (`ProfileCard`), the dashboard that draws it and the component that defines it.
  profileCards: new Set(['frontend/src/app/admin/profiles/page.tsx', 'frontend/src/components/profiles/ProfileCards.tsx']),
  // F34: the pages that hold the list of people in state (`setProfiles`) and the one that reads it (`profilesData`).
  profileState: new Set([
    'frontend/src/app/admin/profiles/page.tsx',
    'frontend/src/app/admin/settings/page.tsx',
    'frontend/src/app/jobs/OrderJobsDialog.tsx',
    'frontend/src/app/page.tsx',
  ]),
  profileAnswer: new Set(['frontend/src/app/admin/settings/page.tsx', 'frontend/src/app/page.tsx']),
  // F34: the browser script that opens the OLD chooser address, /admin/profiles/new, to check that it still reaches the
  // new-resume page with its query string (a profile's page hands it on); nobody else may name it.
  oldAddress: new Set(['backend/test/e2e/profiles.js']),
  // F34: the browser scripts that call the people's routes (`/profiles` against /api, signed in) to make a person, list
  // them or read their counts; the resume router's sub-paths are still a leak there, as in any file that mounts it.
  peopleCalls: new Set([
    'backend/test/e2e/find-jobs.js',
    'backend/test/e2e/preview-vibration.js',
    'backend/test/e2e/profiles.js',
    'backend/test/e2e/providers.js',
    'backend/test/e2e/section-switches.js',
    'backend/test/e2e/shell.js',
    'backend/test/e2e/skills-layouts.js',
    'backend/test/e2e/subscription.js',
  ]),
  // F34: the builder's chosen person (`selectedProfile`).
  profileChoice: new Set(['frontend/src/app/page.tsx']),
};

/**
 * R-4: strings TypeScript cannot see - SQL text, bound parameters, paths, module names, DOM ids -
 * that still carry the old word. `people` marks a spelling that is a person's now: where it may
 * stand (see PEOPLE_FILES). `catches` are samples each must match (see the self-test).
 */
const R4_PATTERNS = [
  {
    // The schema may CREATE the table of people (`... IF NOT EXISTS profiles`) and does nothing else with the name.
    label: 'SQL: a table named profiles',
    re: /\b(?:FROM|INTO|UPDATE|JOIN|TABLE|EXISTS)\s+profiles\b/g,
    people: (relative, code, index) =>
      PEOPLE_FILES.tableOfPeople.has(relative) ||
      (PEOPLE_FILES.schema.has(relative) && /^EXISTS\s+profiles\b/.test(code.slice(index, index + 40))),
    catches: ['SELECT * FROM profiles', 'INSERT INTO profiles (id)', 'UPDATE profiles SET x = 1', 'JOIN profiles ON a = b', 'CREATE TABLE IF NOT EXISTS profiles ('],
  },
  {
    // The people's repository alone names the table; and what it opens is the people's type.
    label: "SQL: DocumentTable<...>('profiles') outside the people's repository",
    re: /DocumentTable<[^>]*>\(\s*'profiles'/g,
    people: PEOPLE_FILES.repository,
    catches: ["new DocumentTable<Resume>('profiles')", "new DocumentTable<Profile>('profiles')"],
  },
  {
    label: "SQL: DocumentTable<Resume>('profiles') anywhere",
    re: /DocumentTable<(?!Profile>)[^>]*>\(\s*'profiles'/g,
    catches: ["new DocumentTable<Resume>('profiles')"],
  },
  {
    label: "SQL: DocumentTable<Profile>('resumes') anywhere",
    re: /DocumentTable<Profile>\(\s*'resumes'/g,
    catches: ["new DocumentTable<Profile>('resumes')"],
  },
  { label: 'SQL: @profileId, @profileName, @profile_id', re: /@profile(?:Id|Name|_id)\b/g, catches: ['VALUES (@profileId)', '@profileName', '@profile_id'] },
  { label: 'SQL: profile_id, profile_name', re: /\bprofile_(?:id|name)\b/g, catches: ['order_items.profile_id', 'SELECT profile_name FROM x'] },
  {
    label: 'path: a quoted /profiles or /api/profiles',
    re: /['"\x60]\/(?:api\/)?profiles\b/g,
    people: (relative, code, index) =>
      !namesResumeOnlySubpath(code, index) &&
      (PEOPLE_FILES.mount.has(relative) ||
        PEOPLE_FILES.peopleCalls.has(relative) ||
        (relative === PROFILES_API_CLIENT && insideProfilesApi(code, index))),
    catches: ["'/api/profiles'", '"/profiles/preview"', '`/profiles/${id}`'],
  },
  {
    // A profile's page is /admin/profiles/<id> (F34), spelled out in the dashboard's helper and in its test; the
    // chooser's and the editor's old addresses under it (/new, /[id]) are still a leak there.
    label: 'path: admin/profiles/ with a slash after it',
    re: /admin\\?\/profiles\\?\//g,
    people: (relative, code, index) =>
      PEOPLE_FILES.profilePage.has(relative) &&
      (PEOPLE_FILES.oldAddress.has(relative) || !/^admin\\?\/profiles\\?\/(?:new|\[id\])(?![\w-])/.test(code.slice(index, index + 40))),
    catches: ['/admin/profiles/new', 'admin\\/profiles\\/'],
  },
  { label: 'module: routes/profiles', re: /routes\/profiles/g, people: PEOPLE_FILES.mount, catches: ["require('../routes/profiles')"] },
  {
    label: 'module: profileRepository',
    re: /\bprofileRepository\b/g,
    // F2: buildModes.test.js makes a profile's default resume with the people's own `updateProfileFor`.
    people: (relative) => PEOPLE_FILES.routerAndRepository.has(relative) || relative === 'backend/test/buildModes.test.js',
    catches: ["require('./profileRepository')"],
  },
  {
    label: 'module: types/profile',
    re: /\btypes\/profile\b/g,
    people: PEOPLE_FILES.peopleType,
    catches: ["import { Profile } from '../types/profile';", "require('../dist/types/profile')"],
  },
  {
    label: 'DOM id: default-profile',
    re: /\bdefault-profile\b/g,
    people: PEOPLE_FILES.defaultProfileId,
    catches: ['id="default-profile"', "'#default-profile'"],
  },
  { label: 'module: profileService', re: /\bprofileService\b/g, catches: ["from '../services/profileService'"] },
  { label: 'module: sampleProfile', re: /\bsampleProfile\b/g, catches: ["require('../dist/services/sampleProfile')"] },
  { label: 'module: profileImport', re: /\bprofileImport\b/g, catches: ["from './profileImport'"] },
  { label: 'module: profileSections', re: /\bprofileSections\b/g, catches: ["from '@/lib/profileSections'"] },
  { label: 'module: profileDraft', re: /\bprofileDraft\b/g, catches: ["from '@/lib/profileDraft'"] },
  { label: 'module: profileGallery', re: /\bprofileGallery\b/g, catches: ["from '@/lib/profileGallery'"] },
  { label: 'module: profileModel', re: /\bprofileModel\b/g, catches: ["from '@/lib/profileModel'"] },
  { label: 'folder: components/profile', re: /components\/profile\b/g, catches: ["from '@/components/profile/ProfileEditor'", "path.join(SRC, 'components/profile')"] },
  { label: 'stylesheet: profileTemplateChrome', re: /profileTemplateChrome/g, catches: ["import css from './profileTemplateChrome.module.css'"] },
  { label: 'stylesheet: profileEditor.module', re: /profileEditor\.module/g, catches: ["import css from './profileEditor.module.css'"] },
  { label: 'stylesheet: profilePages.module', re: /profilePages\.module/g, catches: ["import css from './profilePages.module.css'"] },
  { label: 'variable: E2E_PROFILE_ID', re: /E2E_PROFILE_ID/g, catches: ['process.env.E2E_PROFILE_ID'] },
  {
    // The wire codes of a refusal stay words of their own (profile-limit; and, since F1, the people's four:
    // profile-not-found, profile-owner-mismatch, profile-name-required, profile-name-too-long; and, since F2,
    // the preview's two: profile-or-resume and profile-required, F2 contract 2.10). A fixture id 'profile-N'
    // of a person stands in the test files PEOPLE_FILES.profileFixtureIds lists.
    label: 'DOM id or class: profile- (not a refusal code: profile-limit, profile-not-found, profile-owner-mismatch, profile-name-..., profile-or-resume, profile-required)',
    re: /['"\x60#]profile-(?!limit\b|not-found\b|owner-mismatch\b|name-required\b|name-too-long\b|or-resume\b|required\b)/g,
    people: (relative) => PEOPLE_FILES.profileFixtureIds.has(relative) || PEOPLE_FILES.profileDomIds.has(relative),
    catches: ["'profile-name'", '#profile-template', '`profile-${choice}`'],
  },
  { label: "icon: 'profile'", re: /icon:\s*'profile'/g, catches: ["{ href: '/x', icon: 'profile' }"] },
];

/**
 * `{{profile_name}}`, its aliases and the render key `profile_name` are KEEP (A12): stored folder paths
 * and file-name templates use them, and they print the person's name as it is on the resume. The files
 * that spell the key out of a mustache: the output tokens' own, and the tests of them.
 */
const OUTPUT_TOKEN_FILES = new Set([
  'backend/src/utils/outputStorage.ts',
  'backend/src/utils/generatedPath.ts',
  'frontend/src/lib/outputPath.ts',
  'backend/test/outputPath.test.js',
  'backend/test/utils.test.js',
]);

function r4Hits(relative, code) {
  if (SAYS_ANYTHING.has(relative) || isBidAssistant(relative)) return [];
  const hits = [];
  for (const { label, re, people } of R4_PATTERNS) {
    for (const match of code.matchAll(re)) {
      const text = match[0];
      // A people spelling, in a file that is about people (PEOPLE_FILES).
      if (people && (typeof people === 'function' ? people(relative, code, match.index) : people.has(relative))) continue;
      if (text === 'profile_name' && (code.slice(Math.max(0, match.index - 2), match.index) === '{{' || OUTPUT_TOKEN_FILES.has(relative))) continue;
      // `DELETE FROM answers WHERE profile_id = ?`: the Bid Assistant's storage, which holds resume ids. And, since F1,
      // `resumes.profile_id`: the column that files a resume under its profile (the tree's files, PEOPLE_FILES.treeColumn).
      if (text === 'profile_id' && PEOPLE_FILES.treeColumn.has(relative)) continue;
      hits.push(`${relative}:${lineAt(code, match.index)}: ${label}: ${text}`);
    }
  }
  return hits;
}

/**
 * Names of the resume record that were renamed in Stage R. Word-bounded; a fragment with `\w` is a
 * family. NOT listed, because they stay: GATE (`profileLimit`, `profilesUsed`, `orphanedProfiles`,
 * `countProfilesForOwner`...), RUN (`profileIds`, `ProfileTargets`, `selectedProfileId`...), KEEP (`profileJson`, `profile_name`) and the Bid
 * Assistant's own.
 */
const RETIRED_NAMES = [
  'buildNewProfile', 'buildUpdatedProfile', 'buildPreviewProfile', 'normalizeProfileSettings', 'profileForTemplate',
  'getProfileResumeSections', 'getProfileTailorMode', 'getProfileSectionLayout', 'getProfileTechnicalSkillsLayout',
  'getProfileIncludeSoftSkills', 'getProfileIncludeStrengths', 'MAX_PROFILE_(?!NAME_LENGTH\\b)\\w+', 'MAX_PROFILES_PER_IMPORT',
  'ProfileImportError', 'buildImportedProfiles', 'readProfileImportDocument', 'ImportedProfile', 'assertLooksLikeProfile',
  'PROFILE_FIELDS', 'SAMPLE_PROFILE', 'buildPromptProfile', 'extractProfileFromResume', 'buildExtractProfilePromptValues',
  'resolveProfileResumePromptId', 'profileAsShown', 'profileAsTheResumeSays', 'profileSkillGroups', 'profileFingerprint',
  'profileEvidence', 'droppedProfileFigures', 'ProfileForBullets', 'readProfileForBullets', 'PROFILE_SCOPED_\\w+',
  'isProfileScoped\\w*', 'resolveTemplateForProfile', 'ProfileGoneError', 'ProfilePreview', 'ProfilePreviewResult',
  'ProfileImportResult', 'generateProfilePreviewHTML', 'ProfileSkillCategoryGroup', 'profileSlug', 'profilePreferences',
  'checkProfileModelChoice', 'resolveProfileChoices', 'loadAllProfiles', 'tailorResumesForProfiles', '\\w*ByProfileId',
  'normalizeProfileIds', 'ProfileSettings', 'ProfileDraft', 'DEFAULT_PROFILE_SETTINGS', 'draftFromProfile',
  'draftForNewProfile', 'draftToPreviewProfile', 'NEW_PROFILE_PATH', 'startProfileHref', 'duplicateProfileBody',
  'profileFileName', 'profileFileText', 'readProfileImportFile', 'NewProfileTile', 'ProfileThumb',
  'profileEditorHref', 'ProfileEditor', 'useProfileImport', 'IconProfile', 'NewProfilePage', 'EditProfilePage',
  'unbuiltProfileIds', 'failedProfileIds', 'accountProfiles', 'profileGrid', 'isProfileScopedFeature',
];
/**
 * Names Stage G gave to people: a resume-sense use of any of them is a leak. The first group is the
 * people's own (the repository, the router, the client, the settings); each may stand only in the files
 * PEOPLE_NAME_FILES lists for it. The rest were resume-sense names Stage R retired and nothing has
 * given back, so they are retired everywhere until a part that needs one lists its file here.
 */
const PEOPLE_NAME_FILES = new Map([
  ...['CreateProfileDTO', 'listProfilesFor', 'getProfileFor', 'saveProfile', 'deleteProfile', 'normalizeProfilePayload'].map(
    (name) => [name, PEOPLE_FILES.people]
  ),
  ['profileRoutes', PEOPLE_FILES.mount],
  ['profilesApi', PEOPLE_FILES.profilesApiUsers],
  ['defaultProfileId', PEOPLE_FILES.defaultProfile],
  // F34: the pages that draw and hold the people. `ProfileCard` was the v4.1 resume card (Stage R retired it) and is
  // a person's card now; `profilesData`, `setProfiles` and `selectedProfile` were the resume pages' state and are the
  // profile list and the chosen person in the builder, the settings, the order dialog and the desk.
  ['ProfileCard', PEOPLE_FILES.profileCards],
  ['profilesData', PEOPLE_FILES.profileAnswer],
  ['setProfiles', PEOPLE_FILES.profileState],
  ['selectedProfile', PEOPLE_FILES.profileChoice],
]);
const RETIRED_NAMES_NOT_GIVEN_BACK = ['listAllProfilesUnscoped', 'getProfile', 'hasProfile', 'saveProfiles', 'listProfiles'];
const namesPattern = (names) => new RegExp(String.raw`\b(?:${names.join('|')})\b`, 'g');
const RETIRED_RE = namesPattern([...RETIRED_NAMES, ...RETIRED_NAMES_NOT_GIVEN_BACK]);
/** Every name that is a person's now, wherever it may stand. */
const PEOPLE_NAMES_RE = namesPattern([...PEOPLE_NAME_FILES.keys()]);

/** The v4.1 spelling of a resume's settings: read by the import (D9) and moved by the step, nowhere else. */
const PROFILE_SETTINGS_RE = /\bprofileSettings\b/g;
const PROFILE_SETTINGS_ALLOWED = new Set([
  'backend/src/database/glossaryRename.ts',
  'backend/src/services/resumeImport.ts',
  'backend/test/resumeImport.test.js',
  SELF,
]);

function nameHits(relative, code) {
  if (SAYS_ANYTHING.has(relative) || isBidAssistant(relative)) return [];
  const hits = [...code.matchAll(RETIRED_RE)].map((match) => `${relative}:${lineAt(code, match.index)}: ${match[0]}`);
  // A name that is a person's now stands in the files that are about people, and nowhere else.
  for (const match of code.matchAll(PEOPLE_NAMES_RE)) {
    if (!PEOPLE_NAME_FILES.get(match[0]).has(relative)) hits.push(`${relative}:${lineAt(code, match.index)}: ${match[0]}`);
  }
  if (!PROFILE_SETTINGS_ALLOWED.has(relative)) {
    hits.push(...[...code.matchAll(PROFILE_SETTINGS_RE)].map((match) => `${relative}:${lineAt(code, match.index)}: ${match[0]}`));
  }
  return hits;
}

/** The account sense: the tab is Account, and nothing calls it Profile. Comments count; they say where to click. */
const ACCOUNT_SENSE_RE = /Settings\s*(?:>|->|→|,)\s*Profile\b|ProfileSettingsPage|label:\s*'Profile'|title="Profile"/g;
const ACCOUNT_SENSE_MULTILINE_RE = /Settings\s*(?:->|>)\s*\n[\s*/]*Profile\b/g;

function accountSenseHits(relative, text) {
  if (relative === SELF || isBidAssistant(relative)) return [];
  return [...text.matchAll(ACCOUNT_SENSE_RE), ...text.matchAll(ACCOUNT_SENSE_MULTILINE_RE)].map(
    (match) => `${relative}:${lineAt(text, match.index)}: ${match[0].replace(/\s+/g, ' ')}`
  );
}

// -- Part F2: the names the run's rewrite retired ------------------------------------------------ //

/**
 * F2 (one profile per run, a price per build mode, the mode the run's) deleted these from the BACKEND, and
 * F34 (the frontend's rewrite) from the FRONTEND with them. A name here is a leak anywhere in the tree - the
 * backend, `frontend/`, the e2e scripts and the frontend*.test.js files that compare the frontend's copies
 * (comments aside: a comment may say what a name was) - except in the files listed beside it, each with the
 * reason it may. There is no list of files left for a later part to rewrite: the whole tree is scanned.
 */
const F2_RETIRED_NAMES = [
  // The model's price is gone; the QUOTE's answer still names the one price every resume of a run costs.
  {
    label: 'pricePerResumeMilli',
    re: /\bpricePerResumeMilli\b/g,
    allowed: new Map([
      ['backend/src/routes/generation.ts', 'the quote answers the one price every resume of the run costs (contract 2.10)'],
      ['frontend/src/lib/generationQueue.ts', "the quote's answer, read by the client: the one price every resume of the run costs"],
      ['frontend/src/lib/format.ts', "describeRunCost words the quote's one price: `7 resumes × $0.023 = $0.161`"],
      ['backend/test/frontendFindJobs.test.js', "asserts the quote answer for each build mode's price"],
      ['backend/test/frontendMoney.test.js', "runs describeRunCost over the quote's shape"],
      ['backend/test/frontendSettings.test.js', 'asserts a model record is served with no price'],
      ['backend/test/frontendProviders.test.js', 'a stored model record with a price an older build wrote is read past by the client'],
      ['backend/test/generationPricing.test.js', 'asserts the quote answer'],
      ['backend/test/modePricing.test.js', 'stored model prices are read past, and the quote answer'],
      ['backend/test/buildModes.test.js', 'asserts a stored model price is read past, and the quote answer'],
      ['backend/test/modelAdministration.test.js', 'asserts a stored model price is read past'],
      ['backend/test/settingDefaults.test.js', 'a stored row with a model price is read past'],
      ['backend/test/userModelAccess.test.js', 'a stored row with a model price is read past'],
    ]),
    catches: ['model.pricePerResumeMilli', '{ pricePerResumeMilli: 10 }'],
  },
  {
    label: 'freeEnabledModelIds',
    re: /\bfreeEnabledModelIds\b/g,
    allowed: new Map(
      [
        'backend/test/aiModelConfig.test.js',
        'backend/test/modelAdministration.test.js',
        'backend/test/modePricing.test.js',
        'backend/test/settingDefaults.test.js',
        'backend/test/userModelAccess.test.js',
        // F34: the page's copy of the payload reads none of it either.
        'backend/test/frontendSettings.test.js',
      ].map((file) => [file, 'asserts the list is no longer served'])
    ),
    catches: ['payload.freeEnabledModelIds'],
  },
  {
    label: 'resolvePricedAiChoice',
    re: /\bresolvePricedAiChoice\b/g,
    allowed: new Map([['backend/test/userModelAccess.test.js', 'asserts the function is gone']]),
    catches: ['resolvePricedAiChoice(x)'],
  },
  {
    label: 'resolveSuppliedContentChoice',
    re: /\bresolveSuppliedContentChoice\b/g,
    allowed: new Map([['backend/test/userModelAccess.test.js', 'asserts the function is gone']]),
    catches: ['resolveSuppliedContentChoice(x)'],
  },
  {
    label: 'config/pricePerResume',
    re: /config\/pricePerResume\b/g,
    allowed: new Map(),
    catches: ["require('../dist/config/pricePerResume')", "from './config/pricePerResume'"],
  },
  {
    label: 'assertProfileScopeAllowed',
    re: /\bassertProfileScopeAllowed\b/g,
    allowed: new Map([['backend/test/subscriptionGates.test.js', 'asserts the gate is gone']]),
    catches: ['assertProfileScopeAllowed(x)'],
  },
  {
    label: 'MULTI_PROFILE_SUBSCRIPTION',
    re: /\bMULTI_PROFILE_SUBSCRIPTION\b/g,
    allowed: new Map([
      ['backend/test/subscriptionGates.test.js', 'asserts the constant is gone'],
      ['backend/test/frontendHelpers.test.js', "asserts the frontend's copy of it is gone from lib/subscriptions.ts (F34)"],
    ]),
    catches: ['MULTI_PROFILE_SUBSCRIPTION'],
  },
  {
    label: 'getResumeTailorMode',
    re: /\bgetResumeTailorMode\b/g,
    allowed: new Map([['backend/test/tailorModes.test.js', 'asserts the reader is gone']]),
    catches: ['getResumeTailorMode(resume)'],
  },
  {
    label: 'envDefaultTailorMode',
    re: /\benvDefaultTailorMode\b/g,
    allowed: new Map([['backend/test/settingDefaults.test.js', 'asserts the reader is gone']]),
    catches: ['envDefaultTailorMode(env)'],
  },
  {
    label: 'DEFAULT_RESUME_SELECTION',
    re: /\bDEFAULT_RESUME_SELECTIONS?\b/g,
    allowed: new Map(
      ['backend/test/envExample.test.js', 'backend/test/settingDefaults.test.js'].map((file) => [file, 'asserts the variable is no longer read or listed'])
    ),
    catches: ['DEFAULT_RESUME_SELECTION', 'DEFAULT_RESUME_SELECTIONS'],
  },
  { label: 'NO_MATCHING_PROFILES', re: /\bNO_MATCHING_PROFILES\b/g, allowed: new Map(), catches: ['NO_MATCHING_PROFILES'] },
  {
    // /resume/preview-all, as a ROUTE: a quoted path. (The tests that prove it is gone, 404, send it.)
    label: 'the route /resume/preview-all',
    re: /['"\x60]\/(?:api\/)?(?:resume\/)?preview-all\b/g,
    allowed: new Map([
      ['backend/test/subscriptionGates.test.js', 'asserts the route is a 404'],
      ['backend/test/generationPricing.test.js', 'asserts the route is a 404'],
      ['backend/test/buildModes.test.js', 'asserts the route is a 404'],
    ]),
    catches: ["h.post('/resume/preview-all', body)", "'/api/resume/preview-all'", "router.post('/preview-all', handler)"],
  },
];

/** A file that names a retired thing only to assert it is gone. */
const assertsGone = (reason, ...files) => new Map(files.map((file) => [file, reason]));

/**
 * F34 (the frontend of v4.2: one profile per run, no lock on a run, any template for any resume, the mode the
 * run's, a price per mode) deleted these from the frontend. Scanned like the F2 names, over the same files, and
 * the only files that may still say one are the tests that assert it is gone (and say so by the reason).
 */
const F34_RETIRED_NAMES = [
  {
    label: 'ProfileTargets',
    re: /\bProfileTargets\b/g,
    allowed: assertsGone('asserts the several-profile targets are gone from the dialog', 'backend/test/frontendFindJobs.test.js'),
    catches: ['<ProfileTargets profiles={p} />', "from '@/components/builder/ProfileTargets'"],
  },
  {
    label: 'canBuildForManyProfiles',
    re: /\bcanBuildForManyProfiles\b/g,
    allowed: assertsGone('asserts the lock on a run is gone', 'backend/test/frontendFindJobs.test.js', 'backend/test/frontendHelpers.test.js'),
    catches: ['canBuildForManyProfiles(account)'],
  },
  {
    label: 'startingResumeSelection',
    re: /\bstartingResumeSelection\b/g,
    allowed: assertsGone("asserts the builder's build target is gone", 'backend/test/frontendHelpers.test.js'),
    catches: ['startingResumeSelection(settings, account)'],
  },
  {
    label: 'describeTooLowRefusal',
    re: /\bdescribeTooLowRefusal\b/g,
    allowed: assertsGone('asserts the lock on a run is gone', 'backend/test/frontendFindJobs.test.js', 'backend/test/frontendHelpers.test.js'),
    catches: ['describeTooLowRefusal()', "import { describeTooLowRefusal } from '@/lib/subscriptions'"],
  },
  {
    label: 'isSubscriptionTooLow',
    re: /\bisSubscriptionTooLow\b/g,
    allowed: assertsGone('asserts the lock on a run is gone', 'backend/test/frontendFindJobs.test.js', 'backend/test/frontendSubscription.test.js'),
    catches: ['isSubscriptionTooLow(caught)'],
  },
  {
    label: 'templatesUsedByOthers',
    re: /\btemplatesUsedByOthers\b/g,
    allowed: assertsGone(
      'asserts any resume may use any template (D16)',
      'backend/test/frontendEditorHelpers.test.js',
      'backend/test/frontendProfiles.test.js'
    ),
    catches: ['templatesUsedByOthers(resumes, id)'],
  },
  {
    label: 'templateOptions / TemplateOption',
    re: /\b(?:templateOptions|TemplateOption)\b/g,
    allowed: assertsGone('asserts the picker offers every template (D16)', 'backend/test/frontendEditorHelpers.test.js'),
    catches: ['templateOptions(templates, used)', 'const o: TemplateOption = x;'],
  },
  {
    label: 'TAILOR_MODE_CHOICES / normalizeTailorMode',
    re: /\b(?:TAILOR_MODE_CHOICES|normalizeTailorMode)\b/g,
    allowed: assertsGone("asserts the mode is the run's, not the resume's (D19)", 'backend/test/frontendTailoring.test.js'),
    catches: ['TAILOR_MODE_CHOICES.map(fn)', 'normalizeTailorMode(x)'],
  },
  {
    label: 'formatPricePerResume',
    re: /\bformatPricePerResume\b/g,
    allowed: assertsGone("asserts a model has no price (D21)", 'backend/test/frontendSettings.test.js'),
    catches: ['formatPricePerResume(model.pricePerResumeMilli)'],
  },
  {
    label: 'previewAll',
    re: /\bpreviewAll\b/g,
    allowed: new Map(),
    catches: ['resumeApi.previewAll(body)'],
  },
  // (groupsApi, the Groups page's client, is G-2's: GROUP_RETIRED_STRINGS, which reads comments too.)
  {
    label: 'LockedPanel',
    re: /\bLockedPanel\b/g,
    allowed: new Map(),
    catches: ['<LockedPanel feature="groups" />'],
  },
  {
    label: 'RequiresSubscription',
    re: /\bRequiresSubscription\b/g,
    allowed: new Map(),
    catches: ['<RequiresSubscription feature="groups">'],
  },
  {
    label: 'builderPreviews / readyPreviewKey / keepUnbuiltPreviews',
    re: /\b(?:builderPreviews|readyPreviewKey|keepUnbuiltPreviews)\b/g,
    allowed: assertsGone("asserts the Multiple flow's previews are gone", 'backend/test/frontendHelpers.test.js'),
    catches: ["from '@/lib/builderPreviews'", 'readyPreviewKey(x)', 'keepUnbuiltPreviews(a, b)'],
  },
  {
    label: "the builder's target helpers (startingTarget, targetInEffect, targetBlocker, targetProfiles, isMultiProfileTarget, TargetKind)",
    re: /\b(?:startingTarget|targetInEffect|targetBlocker|targetProfiles|isMultiProfileTarget|TargetKind)\b/g,
    allowed: assertsGone("asserts the builder's several-profile targets are gone from lib/runChoices.ts", 'backend/test/frontendHelpers.test.js'),
    catches: ['startingTarget(settings)', 'targetInEffect(a, b)', 'targetBlocker(x)', 'targetProfiles(t, p)', 'isMultiProfileTarget(t)', 'type T = TargetKind;'],
  },
];

/** Every retired name the tree is scanned for: F2's, then F34's. */
const RETIRED_BY_PARTS = [...F2_RETIRED_NAMES, ...F34_RETIRED_NAMES];

function f2RetiredHits(files) {
  const hits = [];
  for (const { relative, code } of files) {
    if (relative === SELF || SAYS_ANYTHING.has(relative) || isBidAssistant(relative)) continue;
    for (const { label, re, allowed } of RETIRED_BY_PARTS) {
      if (allowed.has(relative)) continue;
      for (const match of code.matchAll(re)) hits.push(`${relative}:${lineAt(code, match.index)}: ${label}`);
    }
  }
  return hits;
}

test('F2 and F34: the names the run, price and mode rewrite and the frontend rewrite retired are gone from the whole tree', () => {
  // The whole tree: the backend, the frontend, the e2e scripts and the tests that compare the frontend's copies.
  const files = sourceFiles();
  for (const prefix of ['backend/src/', 'frontend/src/', 'backend/test/e2e/']) {
    assert.ok(files.some((file) => file.relative.startsWith(prefix)), `${prefix} is scanned`);
  }
  assert.ok(files.some((file) => /^backend\/test\/frontend\w*\.test\.js$/.test(file.relative)), 'the frontend tests are scanned');
  assert.deepEqual(f2RetiredHits(files), []);

  // The scan sees what it is for: every pattern catches each of its shapes in a file that may not say it - the
  // frontend's, the e2e scripts' and the frontend tests' included, which no part is left to rewrite ...
  for (const { label, re, catches } of RETIRED_BY_PARTS) {
    for (const sample of catches) {
      for (const relative of ['backend/src/services/x.ts', 'frontend/src/lib/x.ts', 'backend/test/e2e/x.js', 'backend/test/frontendX.test.js']) {
        assert.equal(f2RetiredHits([{ relative, code: sample }]).length > 0, true, `${label}: not caught in ${relative}: ${sample}`);
      }
      re.lastIndex = 0;
    }
  }
  // ... a file that is allowed one may say it and no other ...
  assert.deepEqual(f2RetiredHits([{ relative: 'backend/src/routes/generation.ts', code: 'pricePerResumeMilli' }]), []);
  assert.equal(f2RetiredHits([{ relative: 'backend/src/routes/generation.ts', code: 'freeEnabledModelIds' }]).length, 1);
  assert.deepEqual(f2RetiredHits([{ relative: 'frontend/src/lib/generationQueue.ts', code: 'quote.pricePerResumeMilli' }]), [], "the client reads the quote's one price");
  assert.equal(f2RetiredHits([{ relative: 'frontend/src/lib/api.ts', code: 'pricePerResumeMilli' }]).length, 1, 'but a model record carries none');
  assert.equal(f2RetiredHits([{ relative: 'frontend/src/lib/api.ts', code: 'pricePerResumeMilli; freeEnabledModelIds' }]).length, 2, 'F4 no longer shelters the frontend');
  assert.deepEqual(f2RetiredHits([{ relative: 'backend/test/frontendHelpers.test.js', code: "'canBuildForManyProfiles' in frontend" }]), [], 'a test may assert a name is gone, where it is listed');
  assert.equal(f2RetiredHits([{ relative: 'frontend/src/lib/subscriptions.ts', code: 'export function canBuildForManyProfiles() {}' }]).length, 1);
  // ... and the spellings that stay are not mistaken for them: the quote's field is `costMilli`, a person's
  // profile limit keeps its name, the other previews are not preview-all, and what F34 kept is not what it
  // retired (the one lock left, the one profile picked, the mode cards, the previews of ONE profile).
  for (const relative of ['backend/src/services/x.ts', 'frontend/src/lib/x.ts', 'backend/test/e2e/x.js']) {
    assert.deepEqual(
      f2RetiredHits([
        {
          relative,
          code:
            "costMilli; profileLimit; post('/resume/preview'); freeEnabled; 'resume-preview-all-x'; describeProfileLimitRefusal(r); " +
            'hasSubscription(account); <ProfileSelector id="manual-profile" />; <BuildModeChoice name="manualBuildMode" />; ' +
            'startingProfileId(s, p); startingBuildMode(s); profileBlocker(id, p); buildModeNote(m, p); resumeApi.preview(body); ' +
            'templatePreviewPath(id); isProfileLimit(e); useLockedFeature(); TargetsOfTheRun; previewChoice; targetProfileId; ' +
            'Subscription; RequiresSubscriptionLevel2',
        },
      ]),
      [],
      relative
    );
  }
  // Every allowance is used: a file listed here that no longer says the name comes off the list.
  for (const { label, re, allowed } of RETIRED_BY_PARTS) {
    for (const relative of allowed.keys()) {
      const file = files.find((candidate) => candidate.relative === relative);
      assert.ok(file, `${relative} exists`);
      assert.ok([...file.code.matchAll(re)].length > 0, `${relative} is allowed ${label} and no longer says it`);
    }
  }
});

test('R-4: no string the type-checker cannot see (SQL, a path, a module, a DOM id) still carries the old word', () => {
  const files = sourceFiles();
  assert.ok(files.length > 500, `the scan reads the source (${files.length} files)`);
  const hits = files.flatMap(({ relative, code }) => r4Hits(relative, code));
  assert.deepEqual(hits, []);

  // Every fixture allowance is used: a file listed in profileFixtureIds that no longer says an id 'profile-N'
  // comes off the list, or it would hide a real 'profile-x' DOM id or class added to it later.
  for (const relative of PEOPLE_FILES.profileFixtureIds) {
    const file = files.find((candidate) => candidate.relative === relative);
    assert.ok(file, `${relative} exists`);
    assert.ok(/['"`]profile-\d/.test(file.code), `${relative} is allowed fixture ids 'profile-N' and no longer says one`);
  }
  // ... and so is every DOM-id allowance (F34): a file that no longer draws a `profile-...` id comes off the list.
  for (const relative of PEOPLE_FILES.profileDomIds) {
    const file = files.find((candidate) => candidate.relative === relative);
    assert.ok(file, `${relative} exists`);
    assert.ok(/['"`#]profile-(?!limit\b)/.test(file.code), `${relative} is allowed a profile- DOM id and no longer says one`);
  }
  // ... and every browser script that is allowed to call the people's routes.
  for (const relative of PEOPLE_FILES.peopleCalls) {
    const file = files.find((candidate) => candidate.relative === relative);
    assert.ok(file, `${relative} exists`);
    assert.ok(
      [...file.code.matchAll(/['"\x60]\/(?:api\/)?profiles\b/g)].some((match) => !namesResumeOnlySubpath(file.code, match.index)),
      `${relative} is allowed the people's routes and no longer calls them`
    );
  }
  // ... and every address allowance for a profile's page.
  for (const relative of PEOPLE_FILES.profilePage) {
    const file = files.find((candidate) => candidate.relative === relative);
    assert.ok(file, `${relative} exists`);
    assert.ok(/admin\\?\/profiles\\?\//.test(file.code), `${relative} is allowed /admin/profiles/<id> and no longer says one`);
  }
});

test('no retired name of the resume record is left in the code', () => {
  const files = sourceFiles();
  const hits = files.flatMap(({ relative, code }) => nameHits(relative, code));
  assert.deepEqual(hits, []);

  // Every allowance F34 gave a name that is a person's now is used: a file that no longer says it comes off the list,
  // or it would hide a resume-sense use of the name added to it later.
  for (const name of ['ProfileCard', 'profilesData', 'setProfiles', 'selectedProfile']) {
    for (const relative of PEOPLE_NAME_FILES.get(name)) {
      const file = files.find((candidate) => candidate.relative === relative);
      assert.ok(file, `${relative} exists`);
      assert.ok(new RegExp(String.raw`\b${name}\b`).test(file.code), `${relative} is allowed ${name} and no longer says it`);
    }
  }
});

test('the v4.1 spelling `profileSettings` lives in the import and the step alone, and the import still reads it', () => {
  const holders = sourceFiles()
    .filter(({ relative, code }) => !isBidAssistant(relative) && /\bprofileSettings\b/.test(code))
    .map(({ relative }) => relative)
    .sort();
  for (const holder of holders) assert.ok(PROFILE_SETTINGS_ALLOWED.has(holder), `${holder} names profileSettings`);
  assert.ok(holders.includes('backend/src/services/resumeImport.ts'), 'the one input alias (D9) is there');
  assert.ok(holders.includes('backend/src/database/glossaryRename.ts'), 'and so is the step that moves the stored key');

  // And the alias works: a v4.1 export - the wrapper `profiles`, the field `profileSettings` - imports,
  // whatever the wrapper (a list, one record, `items`, `data`), and is built under the current key.
  useTempStorage('glossary-import');
  const { buildImportedResumes, readResumeImportDocument } = require('../dist/services/resumeImport');
  const record = v41Resume('res-1', 'Jane', { profileSettings: V41_SETTINGS });
  for (const document of [{ profiles: [record] }, { items: [record] }, { data: [record] }, [record], record]) {
    assert.deepEqual(readResumeImportDocument(document), [record]);
  }
  let minted = 0;
  const [imported] = buildImportedResumes(
    { profiles: [record] },
    { idExists: () => false, newId: () => `generated-${(minted += 1)}` }
  );
  // F2 retired the per-resume Partial/Fully setting (the mode is the run's): the v4.1 record's `tailorMode`
  // is read past, never carried over as a setting.
  assert.equal('tailorMode' in imported.resume.resumeSettings, false);
  assert.equal(imported.resume.resumeSettings.technicalSkillsLayout, 'flat');
  assert.equal(imported.resume.resumeSettings.includeStrengths, true);
  assert.ok(!('profileSettings' in imported.resume), 'and the built resume never carries the old key');
  // The current wrapper, `resumes`, is read the same.
  assert.deepEqual(readResumeImportDocument({ resumes: [record] }), [record]);
});

test('A-1: the Settings tab is Account, and nothing calls the account a profile', () => {
  const nav = fs.readFileSync(path.join(REPO, 'frontend/src/components/shell/navModel.ts'), 'utf8');
  assert.match(nav, /\{\s*href:\s*'\/settings',\s*label:\s*'Account'/);
  assert.deepEqual(
    sourceFiles().flatMap(({ relative, text }) => accountSenseHits(relative, text)),
    []
  );
});

// -- Stage G: the group words ----------------------------------------------- //

/**
 * Files that still hold a group word of the retired sense on purpose. Once it was the Groups surface itself -
 * the Groups page, the Specific group target, the Premium gate's copy, the 'group' selection value - which
 * the feature parts (F3, F4) deleted or rewrote (glossary A11); F34 finished them, so what is left is the
 * BACKEND's: the stored settings keys a v4.1 row may still carry and a test asserts are read past (F2). Every
 * entry's part is therefore 'F2' and every file is the backend's, and G-1 fails the moment a file of the
 * frontend, an e2e script or a frontend test is listed here again.
 *
 * A file here is NOT skipped whole: it lists the group words it still holds (`holds`), and any other
 * one in it is a stray, as in any other file. A file here that no longer exists, or lists a word it no
 * longer holds, fails the test.
 */
const holds = (part, ...tokens) => ({ part, tokens: new Set(tokens) });
const GROUP_SURFACE_FILES = new Map([
  // (F1 took its files off this list: the tier copy and the gate's comments say no group word now.)
  // (F2 took settingDefaults.ts and resumeRepository.ts off this list: the 'group' selection value and the
  // "no matching profiles" sentence are gone from them.)
  // F2: a v4.1 settings row may still carry `defaultGroupId` (the step moves it only where `defaultProfileId` is
  // unset, and never overwrites), so the list of stored keys that are read past and dropped names it (F2 contract 0.3).
  ['backend/src/config/aiModelConfig.ts', holds('F2', 'defaultGroupId')],
  // (F34 took the frontend's files off this list - the Groups page, the rail row, the lock, the icon, the
  // Specific group target, the builder's and the order dialog's group state, lib/api.ts - and the e2e scripts
  // and frontend tests of them: the Groups surface is deleted or rewritten, so no file of the frontend, of the
  // e2e scripts or of the frontend tests may hold a group word of that sense. G-1 fails if one comes back.)
  ['backend/test/settingDefaults.test.js', holds('F2', 'group-1', 'defaultGroupId')],
  // F2: the stale key a page may still send / a row may still hold, asserted as "not served, not aliased".
  ['backend/test/userModelAccess.test.js', holds('F2', 'defaultGroupId')],
]);

/** The step and the guard name the old group table and key on purpose (A3: frozen history), and so does this file. */
const GROUP_HISTORY_FILES = new Set([
  'backend/src/database/glossaryRename.ts',
  'backend/src/database/upgradeGuard.ts',
  'backend/test/upgradeGuard.test.js',
  SELF,
]);

/** Every word that has "group" in it, in the spelling code gives it: `groupsApi`, `skillGroups`, `GROUP BY`, `tl-multiselect-group`. */
const GROUP_TOKEN_RE = /[A-Za-z0-9_$-]*[Gg]roup[A-Za-z0-9_$-]*|GROUPS?/g;

/**
 * The tokens that are some other sense of the word, glossary A13 (U): skill groups, the Grouped / Plain
 * layout, the MultiSelect's option groups, prompt feature groups, the calendar's, `GROUP BY`, a table's
 * `<colgroup>`, Tailwind's `group-hover`, the sheet writer's `writeGroup`. Bare `group` / `groups` are
 * the English word and stand wherever the code means "a group of things".
 */
const U_GROUP_TOKENS = new Set([
  'group', 'groups', 'GROUP', 'GROUPS', 'grouped', 'Grouped', 'grouping', 'regrouped',
  'FeatureGroup', 'featureGroups', 'selectedFeatureGroup',
  'ResumeSkillCategoryGroup', 'SkillCategoryGroup', 'SkillGroup', 'skillGroups', 'skillGroupsOf', 'softSkillGroupHeading',
  'sanitizeSkillGroups', 'findSoftSkillGroup', 'flattenSkillGroups', 'groupClaimedSkills', 'authoredGroups',
  'fitPlainSkillGroups', 'addGroup', 'keywordGroups', 'drawSoftSkillGroupHeading', 'sourceSkillGroups',
  '_group', 'gridGrouped', 'groupedBody', 'groupedRefs', 'legacyGrouped', 'noGroups',
  'lastGroup', 'tl-multiselect-group', 'group-$', 'group-hover', 'colgroup', 'agendaGroups', 'navGroup', 'writeGroup',
  // F34: `role="radiogroup"`, the ARIA role of the build mode cards.
  'radiogroup',
]);
/** Capitalised bare words are the retired type and page names - except in the three places that mean something else. */
const U_GROUP_TOKEN_FILES = new Map([
  ['Group', new Set(['backend/src/services/jobLake/identity.ts', 'backend/test/skillGroups.test.js'])], // a company suffix; a label
  ['Groups', new Set(['backend/src/generators/pdfGenerator.ts'])], // "Groups the SELECTED skills"
]);

function groupTokenStrays(files) {
  const strays = [];
  const seen = new Set();
  for (const { relative, text } of files) {
    if (GROUP_HISTORY_FILES.has(relative) || isBidAssistant(relative)) continue;
    // A file of the Groups surface may hold the words it lists, and no others.
    const surfaceWords = GROUP_SURFACE_FILES.get(relative)?.tokens;
    for (const match of text.matchAll(GROUP_TOKEN_RE)) {
      const token = match[0];
      seen.add(token);
      if (U_GROUP_TOKENS.has(token) || U_GROUP_TOKEN_FILES.get(token)?.has(relative) || surfaceWords?.has(token)) continue;
      strays.push(`${relative}:${lineAt(text, match.index)}: ${token}`);
    }
  }
  return { strays, seen };
}

test('G-1: every group word left in the tree is another sense of it, or sits in a file a feature part deletes', () => {
  const files = sourceFiles();
  const { strays, seen } = groupTokenStrays(files);
  assert.deepEqual(strays, []);
  // The U list cannot rot: every token on it is used somewhere, so one nothing uses any more comes off.
  assert.deepEqual([...U_GROUP_TOKENS].filter((token) => !seen.has(token)), []);
  // ... and so cannot a file's right to say one retired word: each (word, file) pair of U_GROUP_TOKEN_FILES is still
  // true, or the file keeps the right to say it for no reason and a genuine use would pass unseen.
  for (const [token, allowedFiles] of U_GROUP_TOKEN_FILES) {
    for (const file of allowedFiles) {
      const found = files.find((candidate) => candidate.relative === file);
      assert.ok(found, `${file} is allowed to say "${token}" and is not in the tree`);
      assert.ok(new Set(found.text.match(GROUP_TOKEN_RE)).has(token), `${file} is allowed to say "${token}" and no longer does: take it off U_GROUP_TOKEN_FILES`);
    }
  }
  // The Groups surface is gone (F34): no feature part's file is exempt any more. Nothing of the frontend, of the e2e
  // scripts or of the frontend tests is listed, and no entry belongs to F3 or F4 - the test fails if one comes back.
  for (const [file, { part }] of GROUP_SURFACE_FILES) {
    assert.ok(!/^(?:frontend\/|backend\/test\/e2e\/|backend\/test\/frontend\w*\.test\.js$)/.test(file), `${file} is the frontend's: its group words are gone, not listed`);
    assert.ok(!['F3', 'F4'].includes(part), `${file} is held for ${part}, whose files are rewritten or deleted`);
    assert.equal(part, 'F2', `${file}: the only group words left on purpose are the backend's stored keys (F2)`);
  }
  // And the files that are listed exist.
  const relatives = new Set(files.map((file) => file.relative));
  assert.deepEqual([...GROUP_SURFACE_FILES.keys()].filter((file) => !relatives.has(file)), []);
  // What a surface file lists cannot rot either: a group word it no longer holds comes off its list.
  for (const [file, { tokens }] of GROUP_SURFACE_FILES) {
    const held = new Set(files.find((candidate) => candidate.relative === file).text.match(GROUP_TOKEN_RE));
    assert.deepEqual([...tokens].filter((token) => !held.has(token)), [], `${file} lists group words it no longer holds`);
  }
  // The scan sees what it is for: a retired name, a new group-sense name and a capitalised bare word are strays
  // in a file that is not on the list, and the other senses, the words a surface file lists and the Bid Assistant are not.
  const probe = (relative, text) => groupTokenStrays([{ relative, text }]).strays;
  assert.equal(probe('frontend/src/lib/x.ts', 'groupsApi.getAll(); const g: GroupLike = x;').length, 2);
  assert.equal(probe('frontend/src/lib/x.ts', 'the Groups page').length, 1);
  assert.equal(probe('backend/src/services/jobLake/identity.ts', 'the suffix Group').length, 0);
  assert.equal(probe('backend/src/services/credits/index.ts', 'the suffix Group').length, 1);
  assert.deepEqual(probe('frontend/src/lib/x.ts', 'role="group" skillGroups GROUP BY group-hover grouped'), []);
  assert.deepEqual(probe('frontend/src/lib/x.ts', '<div role="radiogroup" aria-label="Build mode">'), [], 'the build mode cards are a radio group');
  // The files the feature parts rewrote or deleted (F3, F4, F34) hold no group word of their own any more: each word
  // they once listed is a stray in them now, whatever it was (a name, a state, an id, a lock, an icon, a helper).
  const FORMER_SURFACE_FILES = [
    'frontend/src/app/admin/groups/page.tsx', 'frontend/src/app/admin/settings/page.tsx', 'frontend/src/components/icons/index.tsx',
    'frontend/src/components/shell/navModel.ts', 'frontend/src/components/subscription/LockedFeature.tsx',
    'frontend/src/components/subscription/subscription.module.css', 'frontend/src/lib/sectionCatalogue.ts', 'frontend/src/lib/subscriptions.ts',
    'frontend/src/app/jobs/OrderJobsDialog.tsx', 'frontend/src/app/page.tsx', 'frontend/src/components/builder/ProfileTargets.tsx',
    'frontend/src/lib/runChoices.ts', 'frontend/src/lib/api.ts', 'backend/test/e2e/find-jobs.js',
    'backend/test/frontendFindJobs.test.js', 'backend/test/frontendHelpers.test.js',
    'backend/test/e2e/shell.js', 'backend/test/e2e/sheet-panel.js', 'backend/test/frontendRoles.test.js',
  ];
  for (const file of FORMER_SURFACE_FILES) {
    assert.equal(
      probe(file, 'selectedGroupId; groupId; groupsData; setGroups; IconGroups; GroupsPage; adminGroupsRow; sheets-group-locked; onGroupChange').length,
      9,
      `${file} holds no group word of the retired sense`
    );
    assert.equal(probe(file, 'the Groups page; a Group').length, 2, `${file}: the capitalised bare words are strays too`);
    assert.deepEqual(probe(file, 'role="group" skillGroups GROUP BY group-hover grouped'), [], `${file}: the other senses stand`);
  }
  // ... and no others: not a revived type, not a new name, not a word of the files that remain.
  assert.equal(probe('backend/test/settingDefaults.test.js', 'defaultGroupId; group-1; GroupLike').length, 1, 'only the words it lists');
  assert.deepEqual(probe('backend/test/settingDefaults.test.js', 'defaultGroupId; group-1'), []);
  assert.equal(probe('frontend/src/lib/api.ts', 'groupsApi.getAll()').length, 1, 'lib/api.ts holds no group word of its own any more');
  assert.equal(probe('frontend/src/lib/api.ts', 'export interface Group {}').length, 1, 'nor a revived Group type');
  assert.equal(probe('backend/src/middleware/auth.ts', 'the Groups gate; a new GroupGate').length, 2, 'a backend file the same (F1 took auth.ts off the list: both words are strays)');
  assert.equal(probe('backend/src/config/settingDefaults.ts', 'defaultGroupId').length, 1, 'a config file that lists none (F2 took this one off the list)');
  assert.deepEqual(probe('backend/src/config/aiModelConfig.ts', 'defaultGroupId'), [], 'the stored keys read past (F2 contract 0.3)');
  assert.equal(probe('backend/src/config/aiModelConfig.ts', 'defaultGroupId; GroupLike').length, 1, 'and no other group word');
  assert.deepEqual(probe('frontend/src/bid-assistant/App.jsx', 'field-group'), [], 'the Bid Assistant');
  // The three files Stage G made out of the group files keep no bare group word at all, in code or in prose.
  for (const file of ['backend/src/types/profile.ts', 'backend/src/database/profileRepository.ts', 'backend/src/routes/profiles.ts']) {
    const { text } = files.find((candidate) => candidate.relative === file);
    assert.deepEqual([...text.matchAll(/\b[Gg]roups?\b/g)].map((match) => `${file}:${lineAt(text, match.index)}`), []);
  }
});

/**
 * Strings of the old group vocabulary that must be gone, with the files that may still say one (A3 frozen
 * history: the step, the guard, their tests; and the Groups page, which still names its own error).
 */
const GROUP_RETIRED_STRINGS = [
  ['/api/groups', []],
  ['routes/groups', []],
  ['types/group', []],
  ['groupRepository', []],
  ['groupsApi', []],
  ['CreateGroupDTO', []],
  [
    'defaultGroupId',
    [
      'backend/src/database/glossaryRename.ts',
      // F2: the stored keys that are read past and dropped (a row the step moved may still hold the old one).
      'backend/src/config/aiModelConfig.ts',
      'backend/test/settingDefaults.test.js',
      'backend/test/userModelAccess.test.js',
    ],
  ],
  ['#default-group', []],
  ['default-group', []],
  ['Untitled Group', []],
  ['Failed to fetch groups', []],
  ['Group not found', []],
  ['Group name is required', []],
  // F34: the Groups page's address and the rail's row are gone with it (a Next 404, no redirect), and so are
  // the lock that opened for them and the people's old picker copy.
  ['/admin/groups', []],
  ['many-profiles', []],
  ['data-locked-panel', []],
  ['Select Group', []],
  ['Specific group', []],
  [
    'profile_groups',
    [
      'backend/src/database/glossaryRename.ts',
      'backend/src/database/upgradeGuard.ts',
      'backend/test/upgradeGuard.test.js',
    ],
  ],
  ['groupRoutes', []],
  ['listGroupsFor', []],
  ['getGroupFor', []],
  ['saveGroup', []],
  ['deleteGroup', []],
  ['normalizeGroupPayload', []],
];
/** The people's table is never opened under a group's type or name (any spelling of the DocumentTable). */
const GROUP_TABLE_RE = /DocumentTable<\s*Group\s*>|DocumentTable<[^>]*>\(\s*['"\x60]profile_groups['"\x60]/g;

/**
 * The retired TYPE `Group`, used as a type: declared, annotated, made an array, passed as a type argument,
 * cast to, imported. In EVERY file, the Groups surface's too, whose lists of group words (GROUP_SURFACE_FILES)
 * allow a bare `Group` for the labels they print and so could not see a type come back. Left-bounded, so
 * `SkillGroup` and `ResumeSkillCategoryGroup` (another sense, U) are not it, and not followed by a word
 * character or a hyphen, so `GroupLike` and `Group-name` are not either (G-1 judges those words).
 */
const GROUP_TYPE_SHAPES = [
  { label: 'declared', re: /\b(?:interface|type|class|enum)\s+Group(?![\w-])/g, sample: 'export interface Group {' },
  { label: 'annotated', re: /[\w)\]?]\s*:\s*Group(?![\w-])/g, sample: 'const group: Group = x;' },
  { label: 'an array of it', re: /\bGroup\s*\[\]/g, sample: 'const all = [] as Group[];' },
  { label: 'a type argument', re: /<\s*Group(?![\w-])/g, sample: 'useState<Group | null>(null)' },
  { label: 'cast to', re: /\bas\s+Group(?![\w-])/g, sample: 'const g = body as Group;' },
  { label: 'imported', re: /\bimport\s+(?:type\s+)?\{[^}]*\bGroup(?![\w-])[^}]*\}/g, sample: "import type { Group, Other } from '@/lib/api';" },
];

function retiredGroupHits(files) {
  const hits = [];
  for (const { relative, text } of files) {
    if (relative === SELF || isBidAssistant(relative)) continue;
    for (const [retired, allowedIn] of GROUP_RETIRED_STRINGS) {
      if (allowedIn.includes(relative)) continue;
      for (let at = text.indexOf(retired); at !== -1; at = text.indexOf(retired, at + retired.length)) {
        hits.push(`${relative}:${lineAt(text, at)}: ${retired}`);
      }
    }
    for (const match of text.matchAll(GROUP_TABLE_RE)) hits.push(`${relative}:${lineAt(text, match.index)}: ${match[0]}`);
    for (const { label, re } of GROUP_TYPE_SHAPES) {
      for (const match of text.matchAll(re)) hits.push(`${relative}:${lineAt(text, match.index)}: the Group type, ${label}: ${match[0].trim()}`);
    }
  }
  return hits;
}

test('G-2: the retired group strings - the API path, the modules, the client, the DTO, the setting, the id - are gone', () => {
  const files = sourceFiles();
  assert.deepEqual(retiredGroupHits(files), []);
  // The allowances cannot rot: a file that may still say a retired string says it, or it comes off the list.
  const unused = [];
  for (const [retired, allowedIn] of GROUP_RETIRED_STRINGS) {
    for (const file of allowedIn) {
      const found = files.find((candidate) => candidate.relative === file);
      if (!found || !found.text.includes(retired)) unused.push(`${file}: "${retired}"`);
    }
  }
  assert.deepEqual(unused, [], 'allowed to say a retired string and no longer does: take it off GROUP_RETIRED_STRINGS');
  // The scan sees what it is for: one hit per shape, in a file that may not say it.
  const probe = (text, relative = 'frontend/src/lib/x.ts') => retiredGroupHits([{ relative, text }]);
  for (const sample of [
    "apiFetch('/api/groups')", "from '../routes/groups'", "from '../types/group'", "from './groupRepository'", 'groupsApi.getAll()',
    'CreateGroupDTO', 'settings.defaultGroupId', '#default-group', "'Untitled Group'", 'listGroupsFor(viewer)',
    "new DocumentTable<Group>('x')", "new DocumentTable<Profile>('profile_groups')", 'FROM profile_groups',
    // F34
    "{ href: '/admin/groups', label: 'Groups' }", "feature: 'many-profiles'", '<div data-locked-panel="groups">', 'Select Group',
    'Specific group', 'Group name is required',
  ]) {
    assert.ok(probe(sample).length > 0, `not caught: ${sample}`);
  }
  assert.deepEqual(probe('defaultGroupId', 'backend/src/database/glossaryRename.ts'), [], 'the step may name the old key');
  assert.deepEqual(probe("new DocumentTable<Profile>('profiles')"), [], 'the people table, under its own name, is fine');
  assert.deepEqual(probe('const skillGroups = [];'), []);
  // The retired type is caught as a type in each shape, in a file that lists a bare `Group` too (the surface's) ...
  for (const { label, sample } of GROUP_TYPE_SHAPES) {
    assert.ok(probe(sample).length > 0, `the Group type, ${label}, is not caught: ${sample}`);
    assert.ok(probe(sample, 'frontend/src/app/page.tsx').length > 0, `... in a surface file: ${sample}`);
  }
  // ... and none of the spellings that stay is mistaken for it.
  for (const sample of [
    'const groups: SkillGroup[] = [];', 'let c: ResumeSkillCategoryGroup | null;', 'type GroupLike = { id: string };', 'const x: Grouped = y;',
    '<Group-name />', 'Edit Group: ${name}',
  ]) {
    assert.deepEqual(probe(sample, 'frontend/src/app/page.tsx'), [], `wrongly caught: ${sample}`);
  }
});

/**
 * G-3: no line that said "profile" before Stage G was edited by it. Needs the files Stage G changed as
 * they were before it ran (the orchestrator's snapshot, `snap-pre-G/files`), so it compares only when
 * V42_PRE_G_FILES names that folder - Gate S6 of Stage G must be run with it set - and is otherwise
 * only the self-test of the comparison. Both the title and the run's output say which it was: a pass that
 * compared nothing must not read as one that did.
 * Stage G's three moved files (G_MOVES) are not compared: a group is a profile now, so nearly every line
 * of them was rewritten on purpose.
 */
function bareProfileLinesLost(before, after) {
  const now = new Set(after.split(/\r?\n/).map((line) => line.trim()));
  return before
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /\bprofiles?\b/i.test(line) && !now.has(line));
}
const G_MOVES = {
  'backend/src/database/groupRepository.ts': 'backend/src/database/profileRepository.ts',
  'backend/src/routes/groups.ts': 'backend/src/routes/profiles.ts',
  'backend/src/types/group.ts': 'backend/src/types/profile.ts',
};

test('G-3 (compares only when V42_PRE_G_FILES names the pre-Stage-G files, else it tests the comparison alone): every line that held the word profile before Stage G is still there, but those of the group files it moved', (t) => {
  assert.deepEqual(bareProfileLinesLost('a\nthe profile states it\nb', 'a\nthe profile states it\nb'), []);
  assert.deepEqual(bareProfileLinesLost('a\n  the Profiles list  \nb', 'a\nthe Profiles list\nb'), [], 'indentation is not an edit');
  assert.deepEqual(bareProfileLinesLost('a\nthe profile states it\nb', 'a\nthe resume states it\nb'), ['the profile states it']);
  assert.deepEqual(bareProfileLinesLost('x\r\nthe profile\r\n', 'the profile\n'), [], 'nor is the line ending');
  assert.deepEqual(bareProfileLinesLost('a group line\nb', 'x'), [], 'a line without the word is not counted');

  const folder = process.env.V42_PRE_G_FILES;
  if (!folder || !fs.existsSync(folder)) {
    t.diagnostic('G-3 compared no files: V42_PRE_G_FILES does not name the folder of the files as they were before Stage G.');
    return;
  }
  const lost = [];
  let compared = 0;
  for (const relative of walkFolder(folder)) {
    const now = G_MOVES[relative] ?? relative;
    if (Object.values(G_MOVES).includes(now)) continue;
    const before = fs.readFileSync(path.join(folder, relative), 'utf8');
    const after = fs.readFileSync(path.join(REPO, now), 'utf8');
    compared += 1;
    lost.push(...bareProfileLinesLost(before, after).map((line) => `${now}: ${line}`));
  }
  assert.ok(compared > 0, `${folder} holds the files Stage G changed, not counting the three it moved`);
  t.diagnostic(`G-3 compared ${compared} files against ${folder}.`);
  assert.deepEqual(lost, []);
});

/** Every file under a folder, as a path relative to it with forward slashes. */
function walkFolder(folder) {
  const found = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else found.push(toPosix(path.relative(folder, full)));
    }
  };
  visit(folder);
  return found;
}

// -- the API contract ------------------------------------------------------ //

test('the clients ask /resumes for the record and /resume/ for the tailoring, and the server mounts both', () => {
  const api = withoutComments(fs.readFileSync(path.join(REPO, 'frontend/src/lib/api.ts'), 'utf8'));
  const pathsOf = (client) => {
    const start = api.indexOf(`export const ${client} = {`);
    assert.ok(start >= 0, `${client} is a client of lib/api.ts`);
    const block = api.slice(start, api.indexOf('\n};', start));
    return [...new Set([...block.matchAll(/(['"\x60])(\/[^'"\x60]*)\1/g)].map((match) => match[2]))];
  };
  const records = pathsOf('resumesApi');
  const tailoring = pathsOf('resumeApi');
  assert.ok(records.length >= 6 && tailoring.length >= 6, `the clients' paths are found (${records.length}, ${tailoring.length})`);
  for (const route of records) assert.match(route, /^\/resumes(?:[/?]|$)/, `resumesApi asks ${route}`);
  for (const route of tailoring) assert.match(route, /^\/resume\//, `resumeApi asks ${route}`);
  for (const route of ['/resumes/upload', '/resumes/import', '/resumes/preview', '/resumes/entries/bullets']) {
    assert.ok(records.includes(route), `resumesApi reaches ${route}`);
  }

  const index = withoutComments(readBackend('src/index.ts'));
  assert.match(index, /from '\.\/routes\/resumes'/);
  assert.match(index, /app\.use\(\s*'\/api\/resumes'/);
  assert.match(index, /app\.use\(\s*'\/api\/resume'/);
  // "Profile not found" is the Bid Assistant's own sentence; the main routes say it of a resume.
  for (const file of ['src/routes/resumes.ts', 'src/routes/resume.ts']) {
    assert.doesNotMatch(readBackend(file), /Profile not found/, file);
  }
  assert.match(readBackend('src/routes/resumes.ts'), /Resume not found/);
});

// -- 8. the patterns ------------------------------------------------------- //

/** Spellings that STAY - GATE, RUN, KEEP, U and the Bid Assistant's - which no pattern may catch. */
const SPELLINGS_THAT_STAY = [
  'role="group"',
  'const skillGroups = sanitizeSkillGroups(raw);',
  'SELECT a FROM b GROUP BY c',
  'profileJson: promptJson(buildPromptResume(resume, mode)),',
  '[[profileJson]] [[jobAnalysisJson]]',
  'FIGURES THE PROFILE STATES AND THE DRAFT DROPPED',
  'THE PROFILE IS THE ONLY SOURCE OF FACT',
  'path.join(dir, `{{profile_name}}`)',
  'const home = process.env.USERPROFILE;',
  'const browserProfileDir = path.join(root, "chrome");',
  "'-NoProfile'",
  'const SEATBELT_PROFILE = 1;',
  "'Untitled Profile'",
  "const id = 'extract-profile-from-resume';",
  "{ code: 'profile-limit' }",
  'countProfilesForOwner(account.id)',
  'assertCanAddProfile(account)',
  'class ProfileLimitError extends PublicError {}',
  '{ profileLimit, profilesUsed, orphanedProfiles }',
  'const { profileId, buildMode } = req.body;',
  '<ProfileSelector profiles={enabledProfiles} selectedId={id} onChange={set} id="manual-profile" />',
  'import ProfileSelector from "@/components/ProfileSelector";',
  'const selectedProfileId = startingProfileId(settings, profiles);',
  "{ href: '/admin/profiles', label: 'Profiles' }",
  "await fetch('/bid-assistant/profiles')",
  "router.push('/admin/profiles')",
  // F34: the desk's helpers (they are about people), and the editor's address
  'const href = profilePageHref(profile.id);',
  "router.replace(`/admin/resumes/${resume.id}`)",
  "import { PeopleList } from '@/components/profiles/PeopleList';",
  'profile_groups',
];

test('the drift patterns catch every shape they are for, and none of the spellings that stay', () => {
  // Each R-4 pattern fires on its own samples: one that stopped working would pass the tree for nothing.
  for (const { label, re, catches } of R4_PATTERNS) {
    assert.ok(catches.length > 0, `${label} has samples`);
    for (const sample of catches) {
      assert.ok([...sample.matchAll(re)].length > 0, `${label} misses ${sample}`);
    }
  }
  // The retired names: one per family, and the ones nothing has been given back (checked on the raw pattern).
  for (const sample of [
    'buildNewProfile(input)', 'resumeApi.preview({ tailoredContentByProfileId })', 'MAX_PROFILE_CUSTOM_SECTIONS',
    'PROFILE_SCOPED_PROMPT_FEATURES', 'isProfileScopedPromptFeature(x)', 'profileFingerprint(p)', '<ProfileEditor />',
    'readProfileImportFile', 'unbuiltProfileIds', 'ProfileSettings', '.profileGrid',
  ]) {
    assert.ok([...sample.matchAll(RETIRED_RE)].length > 0, `no retired name found in ${sample}`);
  }
  for (const sample of ['listProfilesFor(viewer)', 'profilesApi.getAll()', 'defaultProfileId', 'saveProfile(x)', 'profileRoutes']) {
    assert.ok([...sample.matchAll(PEOPLE_NAMES_RE)].length > 0, `no name Stage G gave to people found in ${sample}`);
  }
  // ... and the ones F34 gave them: a person's card, the list of people and the chosen person.
  for (const sample of ['<ProfileCard profile={p} />', 'const [profilesData, setProfiles]', 'const selectedProfile = find(id);']) {
    assert.ok([...sample.matchAll(PEOPLE_NAMES_RE)].length > 0, `no name F34 gave to people found in ${sample}`);
    assert.equal([...sample.matchAll(RETIRED_RE)].length, 0, `${sample}: a name given back is not retired any more`);
  }
  for (const sample of ['getProfile(id)', 'listProfiles()', 'hasProfile(id)', 'saveProfiles(all)']) {
    assert.ok([...sample.matchAll(RETIRED_RE)].length > 0, `no name that was not given back found in ${sample}`);
  }
  assert.ok([...'const s = x.profileSettings;'.matchAll(PROFILE_SETTINGS_RE)].length > 0);
  // The account sense.
  for (const sample of [
    'Settings > Profile', 'Settings -> Profile -> Resume files', 'Settings, Profile, Resume files', 'export default function ProfileSettingsPage() {',
    "{ href: '/settings', label: 'Profile' }", '<Section title="Profile">',
  ]) {
    assert.ok(accountSenseHits('frontend/src/x.tsx', sample).length > 0, `not caught: ${sample}`);
  }
  assert.equal(accountSenseHits('frontend/src/x.tsx', ' * Settings ->\n * Profile\n').length, 1, 'the sentence that wraps');
  for (const sample of ['Settings > Account > Resume files', "{ label: 'Profiles' }", 'Settings > Profiles', '<Section title="Account">']) {
    assert.deepEqual(accountSenseHits('frontend/src/x.tsx', sample), [], `wrongly caught: ${sample}`);
  }

  // And none of them catches what stays. `{{profile_name}}` is allowed by r4Hits outside the database folder.
  for (const sample of SPELLINGS_THAT_STAY) {
    assert.deepEqual(r4Hits('frontend/src/lib/x.ts', sample), [], `R-4 wrongly catches: ${sample}`);
    assert.deepEqual(nameHits('frontend/src/lib/x.ts', sample), [], `a retired name wrongly caught in: ${sample}`);
    assert.deepEqual(accountSenseHits('frontend/src/lib/x.ts', sample), [], `the account sense wrongly caught in: ${sample}`);
  }
  // The allowances are the ones A12 names, and no wider.
  assert.deepEqual(r4Hits('backend/src/database/resumeRepository.ts', 'DELETE FROM answers WHERE profile_id = ?'), []);
  assert.equal(r4Hits('backend/src/database/orderRepository.ts', 'SELECT profile_id FROM order_items').length, 1);
  assert.equal(r4Hits('backend/src/database/orderRepository.ts', 'SELECT profile_name FROM order_items').length, 1);
  assert.deepEqual(r4Hits('backend/src/utils/outputStorage.ts', "{ profile_name: 'x' }"), []);
  assert.equal(r4Hits('backend/test/orderRepository.test.js', 'SELECT profile_name FROM order_items').length, 1, 'a column, not a token');
  assert.deepEqual(r4Hits('backend/test/orderRepository.test.js', "suffix: '/{{profile_name}}/{{role}}'"), []);
  assert.deepEqual(r4Hits('backend/test/bidAssistantScoping.test.js', "call('/profiles'); profile_id; 'a-profile-id'"), []);
  // A people spelling stands in a file that is about people and is a leak anywhere else.
  assert.deepEqual(r4Hits('backend/src/database/profileRepository.ts', "new DocumentTable<Profile>('profiles', index)"), []);
  assert.equal(r4Hits('backend/src/database/resumeRepository.ts', "new DocumentTable<Resume>('profiles')").length, 2, 'by file and by type');
  assert.equal(r4Hits('backend/src/database/profileRepository.ts', "new DocumentTable<Resume>('profiles')").length, 1, 'by type');
  assert.equal(r4Hits('backend/src/database/profileRepository.ts', "new DocumentTable<Profile>('resumes')").length, 1);
  assert.deepEqual(r4Hits('backend/src/database/sqlite.ts', 'CREATE TABLE IF NOT EXISTS profiles ('), []);
  assert.equal(r4Hits('backend/src/database/sqlite.ts', 'SELECT * FROM profiles').length, 1, 'the schema creates the table of people and queries nothing');
  assert.equal(r4Hits('backend/src/database/orderRepository.ts', 'SELECT * FROM profiles').length, 1);
  assert.deepEqual(r4Hits('backend/src/index.ts', "app.use('/api/profiles', profileRoutes);"), []);
  // ... and even there only the people's own paths: the resume router's sub-paths are a leftover in the files that mount it too.
  assert.deepEqual(r4Hits('backend/test/sectionPermissions.test.js', "['PUT', '/api/profiles/anything'], ['GET', '/api/profiles']"), []);
  for (const resumeOnly of ['preview', 'import', 'upload', 'entries/bullets']) {
    assert.equal(r4Hits('backend/test/routeAccess.test.js', `call('POST', '/api/profiles/${resumeOnly}')`).length, 1, resumeOnly);
    assert.equal(r4Hits('backend/src/index.ts', `app.use("/api/profiles/${resumeOnly}", x);`).length, 1, resumeOnly);
  }
  assert.deepEqual(r4Hits('backend/test/routeAccess.test.js', "call('GET', '/api/profiles/previewed-by-nobody')"), [], 'a segment that only starts like one');
  assert.equal(r4Hits('backend/src/routes/resumes.ts', "router.get('/profiles', list);").length, 1);
  assert.equal(r4Hits('backend/src/routes/resumes.ts', "import { x } from '../database/profileRepository';").length, 1);
  assert.deepEqual(r4Hits('backend/src/routes/profiles.ts', "import { x } from '../database/profileRepository';"), []);
  assert.equal(r4Hits('backend/src/routes/resumes.ts', "import { Profile } from '../types/profile';").length, 1);
  assert.equal(r4Hits('frontend/src/app/admin/templates/page.tsx', '<input id="default-profile" />').length, 1);
  assert.deepEqual(r4Hits('frontend/src/app/admin/settings/page.tsx', '<input id="default-profile" />'), []);
  // F34: a profile's page, its dialogs' ids and the fixtures that give a person an id stand in the files that are about
  // people - and the old chooser and editor addresses, and any other file's `profile-` id, are still leaks.
  assert.deepEqual(r4Hits('frontend/src/lib/profileDashboard.ts', "return '/admin/profiles/' + encodeURIComponent(id);"), []);
  assert.deepEqual(r4Hits('backend/test/frontendProfiles.test.js', "assert.equal(profilePageHref('abc'), '/admin/profiles/abc');"), []);
  assert.equal(r4Hits('frontend/src/lib/profileDashboard.ts', "'/admin/profiles/new'").length, 1, 'the old chooser address');
  assert.equal(r4Hits('frontend/src/lib/profileDashboard.ts', "'/admin/profiles/[id]'").length, 1, 'and the old editor address');
  assert.equal(r4Hits('frontend/src/components/resume/ResumeEditor.tsx', "router.push('/admin/profiles/' + id)").length, 1, 'only the helper and its tests spell it out');
  assert.deepEqual(r4Hits('frontend/src/components/profiles/ProfileDialogs.tsx', '<form id="profile-name-form" /><input name="profile-target" />'), []);
  assert.equal(r4Hits('frontend/src/components/resume/ResumeEditor.tsx', '<form id="profile-name-form" />').length, 1);
  assert.deepEqual(r4Hits('backend/test/frontendProfiles.test.js', "const resume = { profileId: 'profile-1' };"), []);
  assert.equal(r4Hits('backend/test/frontendHelpers.test.js', "const resume = { profileId: 'profile-1' };").length, 1);
  assert.deepEqual(r4Hits('backend/test/frontendProfiles.test.js', "app.use('/api/profiles', require('../dist/routes/profiles').default);"), []);
  assert.equal(r4Hits('backend/test/frontendSettings.test.js', "app.use('/api/profiles', x);").length, 1, 'the settings tests do not mount the people router');
  // A browser script that calls the people's routes may say '/profiles'; the resume router's sub-paths are a leak there too.
  assert.deepEqual(r4Hits('backend/test/e2e/profiles.js', "await api(token, 'POST', '/profiles', { name: 'x' });"), []);
  assert.equal(r4Hits('backend/test/e2e/profiles.js', "await api(token, 'POST', '/profiles/import', body);").length, 1);
  assert.equal(r4Hits('backend/test/e2e/walkthrough.js', "await api(token, 'POST', '/profiles', { name: 'x' });").length, 1, 'a script not listed');
  // lib/api.ts may ask '/profiles' inside the profilesApi client and nowhere else in the file.
  const apiSample = "export const resumesApi = {\n  a: () => f('/profiles'),\n};\nexport const profilesApi = {\n  getAll: () => f('/profiles'),\n};\n";
  assert.equal(r4Hits(PROFILES_API_CLIENT, apiSample).length, 1);
  assert.match(r4Hits(PROFILES_API_CLIENT, apiSample)[0], /:2: /);
  // ... inside the people's client only its own paths: the resume router's sub-paths are a leftover there too.
  const peopleClientSample = "export const profilesApi = {\n  getAll: () => f('/profiles'),\n  one: (id) => f(`/profiles/${id}`),\n  stale: () => f('/profiles/preview'),\n};\n";
  assert.equal(r4Hits(PROFILES_API_CLIENT, peopleClientSample).length, 1);
  assert.match(r4Hits(PROFILES_API_CLIENT, peopleClientSample)[0], /:4: /);
  assert.deepEqual(nameHits('frontend/src/app/page.tsx', 'profilesApi.getAll()'), []);
  assert.equal(nameHits('frontend/src/lib/runChoices.ts', 'profilesApi.getAll()').length, 1);
  assert.deepEqual(nameHits('backend/src/routes/profiles.ts', 'saveProfile(normalizeProfilePayload(body));'), []);
  assert.deepEqual(nameHits('backend/src/types/profile.ts', 'export interface CreateProfileDTO {'), []);
  assert.equal(nameHits('backend/src/routes/resumes.ts', 'saveProfile(x)').length, 1);
  // F34: the people's page names stand in the pages that draw people, and are a leak in the resume pages.
  assert.deepEqual(nameHits('frontend/src/components/profiles/ProfileCards.tsx', 'export function ProfileCard() {}'), []);
  assert.deepEqual(nameHits('frontend/src/app/page.tsx', 'const [profilesData, setProfiles] = useState([]); selectedProfile'), []);
  assert.equal(nameHits('frontend/src/components/resume/ResumeCards.tsx', '<ProfileCard resume={r} />').length, 1);
  assert.equal(nameHits('frontend/src/components/resume/ResumeEditor.tsx', 'setProfiles(list); selectedProfile').length, 2);
  assert.equal(nameHits('frontend/src/app/admin/profiles/page.tsx', 'selectedProfile').length, 1, 'the dashboard has no chosen person: the builder does');
  assert.equal(nameHits('backend/src/services/resumeService.ts', 'settings.defaultProfileId').length, 1);
  assert.deepEqual(nameHits('backend/src/config/aiModelConfig.ts', 'settings.defaultProfileId'), []);
  assert.deepEqual(nameHits('backend/src/services/resumeImport.ts', "const V41 = 'profileSettings';"), []);
  assert.equal(nameHits('backend/src/services/resumeDocument.ts', 'x.profileSettings').length, 1);
  assert.equal(r4Hits('backend/src/routes/resumes.ts', "SELECT * FROM answers WHERE profile_id = 1").length, 1);
  // The comment stripper keeps line numbers.
  assert.equal(withoutComments('/* a\n b */\nconst x = 1; // note').split('\n').length, 3);
  assert.equal(withoutComments("const u = 'http://example.com'; // gone").includes('gone'), false);
  assert.equal(withoutComments("const u = 'http://example.com';").includes('http://example.com'), true);
  // A `/*` that is not the start of a comment never hides the code after it: in a `//` comment, in a
  // glob, in a string, in a regular expression. (A pair of regular expressions once read each as the
  // start of a block comment and blanked 230 lines of frontendRoles.test.js up to the next `*` + `/`.)
  const star = '*';
  const survives = (opening, probe) => withoutComments(`${opening}\nconst ${probe} = 1;\n/${star} real ${star}/ const after = 2;`).includes(probe);
  assert.equal(survives('// /admin/* is not a comment start', 'profilesApi'), true, 'a // comment holding a /*');
  assert.equal(survives('// a/* b', 'profile_id'), true, 'a // comment holding a /* after a word');
  assert.equal(survives("const glob = 'test/*.test.js';", 'stale'), true, 'a string holding a /*');
  assert.equal(survives('const re = /a\\/*b/;', 'stale'), true, 'a regular expression holding a /*');
  assert.equal(withoutComments(`// /admin/* is not\nconst kept = 1;\n/${star} real ${star}/ const after = 2;`).includes('real'), false);
  assert.equal(withoutComments(`const a = 1; // /* x\n const b = 2; /${star} gone ${star}/ const c = 3;`).includes('gone'), false);
  assert.equal(withoutComments('a { color: red; } /* gone */ b { color: blue; }', { lineComments: false }).includes('gone'), false);
});

// -- 9. the docs (Stage D) --------------------------------------------------- //

/**
 * Stage D: the six docs name none of the retired things.
 *
 * Sections 7 and 8 hold the SOURCE to the new vocabulary. The docs were written in the old one, and a stale
 * name in them sends the reader to a file, a route or a tab that is not there, so they are held to it as well.
 * Each doc is read the way backend/test/money.test.js reads it for its amounts: the CURRENT lines only. The
 * release notes ("What changed in this release") record a release in the words of its day and are rewritten
 * for each one.
 *
 * What is retired is what no longer exists, judged by MEANING and not by spelling. `types/profile.ts`,
 * `profileRepository`, `routes/profiles`, `/api/profiles` (and its `/:id`), `profilesApi`, `defaultProfileId`
 * and `components/profiles/` are the PEOPLE's since Stage G - a profile is a person now - and are not on the
 * list. On it are the group files and names Stage G removed, the resume record's file names and routes Stage R
 * moved (every path in PATHS_GONE has a pattern here; the second test holds the two lists together), the
 * account tab's old name ("Settings -> Profile", now Account), the editor's old heading ("Editing a profile",
 * now "Editing a resume") and the e2e variable E2E_PROFILE_ID.
 *
 * A line that says what a retired name WAS may name it: the Upgrading list of renamed tables, columns and
 * stored keys does, and so does a sentence saying where a file went. EXPLAINS_A_RETIRED_NAME is the whole
 * allowance, and it is narrow on purpose - whole words, on the line of the hit (for a phrase that wraps, on
 * either of its lines) and on no other line, not the paragraph and not the section.
 */
const DOC_FILES = [
  'CLAUDE.md',
  'README.md',
  'backend/src/README.md',
  'backend/test/README.md',
  'backend/test/e2e/README.md',
  '.env.example',
];

/**
 * A doc's current lines. This is backend/test/money.test.js's `currentDocLines` (that file exports nothing), rule
 * for rule: a `## ` heading outside a code fence that says "What changed in this release" starts the release
 * notes, and the next `## ` heading ends them. It splits on either line ending, which a Windows checkout may have.
 */
function currentDocLines(text) {
  const lines = [];
  let fenced = false;
  let history = false;
  text.split(/\r?\n/).forEach((line, index) => {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (!fenced && /^## /.test(line)) history = /What changed in this release/.test(line);
    if (!history) lines.push({ number: index + 1, line });
  });
  return lines;
}

/** Every line of the doc, the release notes blanked and not dropped: a hit keeps its real line number, and a phrase cannot run from the notes into the text. */
function blankedDocLines(text) {
  const lines = text.split(/\r?\n/).map(() => '');
  for (const { number, line } of currentDocLines(text)) lines[number - 1] = line;
  return lines;
}

/**
 * Between two words of a phrase: spaces, or ONE line break with its indentation and the `#`, `>` or `*` that a
 * wrapped line of a code block (the layout in CLAUDE.md, the comments of .env.example), a quote or a bold phrase
 * can start with. The docs are hard-wrapped, so "Settings ->" and "Profile" can end up on two lines, and a scan
 * of one line at a time would never see the phrase.
 */
const DOC_GAP = String.raw`(?:[ \t]+|[ \t]*\n[ \t]*(?:[#>*][ \t]*)*)`;
/** "Settings -> Profile" with any arrow, any bold or code marks, and any wrap: the account's tab is Account, and the Profile that stays is a person. */
const SETTINGS_PROFILE_RE = new RegExp(String.raw`Settings[*_\x60]*${DOC_GAP}?(?:->|>|→)${DOC_GAP}?[*_\x60]*Profile\b`, 'g');
/** The heading and its link text, and the anchor a link to the heading uses. */
const EDITING_A_PROFILE_RE = new RegExp(String.raw`Editing${DOC_GAP}a${DOC_GAP}profile\b|#editing-a-profile\b`, 'g');

/**
 * The one allowance: a line may name a retired thing when it says what the name WAS. Whole words, in any case:
 * "was", "renamed", "retired" (which the marker "(retired name)" carries) or "v4.1", the build that spelled it
 * that way. "wasp", "unrenamed" and "v4.10" do not count, and a line excuses only its own hits.
 */
const EXPLAINS_A_RETIRED_NAME = /\(retired name\)|\b(?:was|renamed|retired)\b|\bv4\.1\b/i;

/**
 * What a current line of a doc may not name. `catches` are samples each pattern must match (see the self-test).
 * The patterns down to E2E_PROFILE_ID are the Stage D list. The last four are retired too and not on it: two test
 * files and the editor's two pages (all in PATHS_GONE), and the routes the resume router took from `/api/profiles`.
 */
const DOC_RETIRED = [
  { label: 'file: routes/groups', re: /\broutes\/groups\b/g, catches: ['backend/src/routes/groups.ts', "require('./routes/groups')"] },
  { label: 'file: types/group', re: /\btypes\/group\b/g, catches: ['backend/src/types/group.ts', "from '../types/group'"] },
  { label: 'file: groupRepository', re: /\bgroupRepository\b/g, catches: ['database/groupRepository.ts', 'groupRepository.listGroupsFor(viewer)'] },
  {
    label: 'file: services/profileService',
    re: /\bprofileService\b/g,
    catches: ['backend/src/services/profileService.ts', "Read them with `profileService`'s getters"],
  },
  { label: 'file: profileImport', re: /\bprofileImport\b/g, catches: ['services/profileImport.ts', 'test/profileImport.test.js'] },
  { label: 'file: sampleProfile', re: /\bsampleProfile\b/g, catches: ['services/sampleProfile.ts', 'sampleProfile.ts names either sample'] },
  {
    label: 'file: profileSections (config/ and lib/)',
    re: /\bprofileSections\b/g,
    catches: ['backend/src/config/profileSections.ts', 'frontend/src/lib/profileSections.ts', 'test/profileSections.test.js'],
  },
  { label: 'file: profileDraft', re: /\bprofileDraft\b/g, catches: ['frontend/src/lib/profileDraft.ts', "and profileDraft.ts, the editor's form"] },
  { label: 'file: profileGallery', re: /\bprofileGallery\b/g, catches: ['frontend/src/lib/profileGallery.ts'] },
  { label: 'file: profileModel', re: /\bprofileModel\b/g, catches: ['frontend/src/lib/profileModel.ts'] },
  {
    label: 'folder: components/profile',
    re: /\bcomponents\/profile\b/g,
    catches: ['frontend/src/components/profile/ProfileEditor.tsx', '  components/profile/ # The Profiles pages'],
  },
  { label: 'component: ProfileEditor', re: /\bProfileEditor\b/g, catches: ['THE EDITOR: ProfileEditor owns the draft', '<ProfileEditor />'] },
  // (`ProfileCards` is no pattern since F34: components/profiles/ProfileCards.tsx draws a person's card. The v4.1
  // resume cards lived in components/profile/, which the folder pattern above still catches.)
  { label: 'hook: useProfileImport', re: /\buseProfileImport\b/g, catches: ['useProfileImport.ts and its transient `chooseFile` input'] },
  { label: 'stylesheet: profileEditor.module', re: /\bprofileEditor\.module\b/g, catches: ["profileEditor.module.css's: tokens on `.editor`"] },
  { label: 'stylesheet: profilePages.module', re: /\bprofilePages\.module\b/g, catches: ['Their styles are profilePages.module.css; the'] },
  { label: 'stylesheet: profileTemplateChrome', re: /\bprofileTemplateChrome\b/g, catches: ['components/admin/profileTemplateChrome.module.css'] },
  { label: 'route: /api/groups', re: /\/api\/groups\b/g, catches: ['GET /api/groups', "fetch('/api/groups/' + id)"] },
  { label: 'client: groupsApi', re: /\bgroupsApi\b/g, catches: ['groupsApi.getAll()'] },
  { label: 'setting: defaultGroupId', re: /\bdefaultGroupId\b/g, catches: ['settings.defaultGroupId', '`defaultGroupId`'] },
  { label: 'DOM id: default-group (#default-group)', re: /\bdefault-group\b/g, catches: ['#default-group', 'id="default-group"'] },
  {
    label: 'phrase: Settings -> Profile (the tab is Account)',
    re: SETTINGS_PROFILE_RE,
    catches: [
      'Settings -> Profile',
      'Settings > Profile',
      'Settings → Profile',
      '**Settings** → **Profile**',
      'under **Settings →\nProfile → Resume files**',
      '#   Settings ->\n#   Profile -> Resume files',
    ],
  },
  {
    label: 'phrase: Editing a profile (the heading is Editing a resume)',
    re: EDITING_A_PROFILE_RE,
    catches: ['### Editing a profile', 'See [Editing a profile](#editing-a-profile).', 'Editing a\nprofile shows the resume', '# Editing\n# a profile'],
  },
  { label: 'variable: E2E_PROFILE_ID', re: /\bE2E_PROFILE_ID\b/g, catches: ['E2E_PROFILE_ID=res-1', 'process.env.E2E_PROFILE_ID'] },
  // Retired as well, though not on the Stage D list: what moved with the resume record, and its routes.
  {
    label: 'file: profilePreview (the test, and the component)',
    re: /\b[Pp]rofilePreview\b/g,
    catches: ['test/profilePreview.test.js', 'ProfilePreview frames the way the server draws it'],
  },
  { label: 'file: profileExperienceSkills', re: /\bprofileExperienceSkills\b/g, catches: ['profileExperienceSkills.test.js alongside'] },
  {
    // The desk keeps /admin/profiles (page.tsx) and, since F34, a profile's page at /admin/profiles/<id>
    // (app/admin/profiles/[profileId]/page.tsx); the chooser and the editor are /admin/resumes/new and /admin/resumes/<id>.
    label: 'path: /admin/profiles/new, /admin/profiles/[id] (now /admin/resumes/...)',
    re: /\badmin\/profiles\/(?:new|\[id\])(?![\w-])/g,
    catches: ['/admin/profiles/new', 'app/admin/profiles/[id]/page.tsx', '`/admin/profiles/new?template=x`'],
  },
  // F34 (the frontend): the Groups page is a Next 404 with no redirect, the several-profile targets are gone, and so
  // are the model's price helper and the Multiple flow's previews (every path in PATHS_GONE has a pattern here).
  { label: 'path: admin/groups (the Groups page)', re: /\badmin\/groups\b/g, catches: ['frontend/src/app/admin/groups/page.tsx', 'the Groups page at /admin/groups'] },
  {
    label: 'component: ProfileTargets (the several-profile targets)',
    re: /\bProfileTargets\b/g,
    catches: ['components/builder/ProfileTargets.tsx', '<ProfileTargets profiles={p} />'],
  },
  { label: 'file: modelPrice (the Models price helper)', re: /\bmodelPrice\b/g, catches: ['app/admin/models/modelPrice.ts', "from './modelPrice'"] },
  {
    label: "file: builderPreviews (the Multiple flow's previews)",
    re: /\bbuilderPreviews\b/g,
    catches: ['frontend/src/lib/builderPreviews.ts', "from '@/lib/builderPreviews'"],
  },
  {
    // The people's router has `/` and `/:id`; these four belong to the resume router alone (the rule of RESUME_ONLY_SUBPATH_RE).
    label: 'route: /api/profiles/preview|import|upload|entries (now /api/resumes/...)',
    re: /(?:\/api)?\/profiles\/(?:preview|import|upload|entries)(?![\w-])/g,
    catches: ['POST /api/profiles/preview', 'POST /profiles/entries/bullets', 'POST /api/profiles/import', "post('/profiles/upload')"],
  },
];

/**
 * Every retired thing the current lines of a doc name, as `doc:line: label: text` in line order. The doc is searched
 * as one piece (the release notes blanked, see blankedDocLines), so a phrase wrapped over two lines is one hit, and
 * the allowance is judged on the line, or the two lines, the hit spans.
 */
function docHits(doc, text) {
  const lines = blankedDocLines(text);
  const body = lines.join('\n');
  const hits = [];
  for (const { label, re } of DOC_RETIRED) {
    for (const match of body.matchAll(re)) {
      const first = lineAt(body, match.index);
      const last = lineAt(body, match.index + match[0].length);
      if (lines.slice(first - 1, last).some((line) => EXPLAINS_A_RETIRED_NAME.test(line))) continue;
      hits.push({ line: first, text: `${doc}:${first}: ${label}: ${match[0].replace(/\s+/g, ' ')}` });
    }
  }
  return hits.sort((a, b) => a.line - b.line).map((hit) => hit.text);
}

/** Spellings that STAY - the people's, the resume's names since Stage R, and other senses of the words - which no pattern here may catch. */
const DOC_SPELLINGS_THAT_STAY = [
  // The people's (Stage G): a profile is a person, so these are current.
  'backend/src/types/profile.ts declares the person; database/profileRepository.ts and routes/profiles.ts keep them',
  'GET /api/profiles lists the people, GET /api/profiles/:id reads one, and profilesApi.getAll() calls them',
  'the default profile is defaultProfileId, and its box is `#default-profile`',
  'frontend/src/app/admin/profiles/page.tsx is the desk, at /admin/profiles',
  "import { PeopleList } from '@/components/profiles/PeopleList';",
  // GATE, RUN and KEEP spellings
  'profileLimit, ProfileSelector.tsx, BuildModeChoice.tsx, profileIds, [[profileJson]], {{profile_name}}, extract-profile-from-resume',
  // F34: a profile's page and the desk's files, and the lock that is left
  'frontend/src/app/admin/profiles/[profileId]/page.tsx is a profile\'s page, at /admin/profiles/<id> and /admin/profiles/abc',
  'components/profiles/ProfileCards.tsx, KeywordsCard.tsx, useResumeActions.tsx and lib/profileDashboard.ts',
  'the locked New profile tile is data-locked-feature="more-profiles"',
  // The resume's names since Stage R
  'backend/src/routes/resumes.ts, types/resume.ts, database/resumeRepository.ts, resumesApi, /api/resumes',
  'POST /api/resumes/preview, /api/resumes/import, /api/resumes/upload and /resumes/entries/bullets',
  'a segment that only starts like one: /api/profiles/previewed-by-nobody',
  'services/resumeDocument.ts, services/resumeImport.ts, services/sampleResume.ts',
  'config/sectionCatalogue.ts, lib/sectionCatalogue.ts and test/sectionCatalogue.test.js',
  'lib/resumeDraft.ts, lib/resumeGallery.ts, lib/resumeModelChoice.ts',
  'components/resume/ResumeEditor.tsx, ResumeCards.tsx, ResumeDraftPreview.tsx, useResumeImport.ts',
  'resumeEditor.module.css, resumePages.module.css, resumeTemplateChrome.module.css',
  'test/resumeDraftPreview.test.js, test/resumeExperienceSkills.test.js, test/resumeImport.test.js',
  '/admin/resumes/new, /admin/resumes/[id] and app/admin/resumes/new/page.tsx',
  'E2E_RESUME_ID=res-1',
  // The account tab, the editor's heading, and other senses of the words
  'Open Settings -> Account -> Resume files, or Settings → Account, or **Settings > Account**',
  'the Profiles desk, and Settings -> Profiles, which is not the account tab',
  'Editing a resume, [Editing a resume](#editing-a-resume), and the profile editor in lower case',
  'skillGroups, GROUP BY, role="group", the Grouped layout and a group of skills',
];

test('the docs name none of the retired things', () => {
  const hits = [];
  let read = 0;
  for (const doc of DOC_FILES) {
    const file = path.join(REPO, doc);
    assert.ok(fs.existsSync(file), `${doc} is there`);
    const text = fs.readFileSync(file, 'utf8');
    const current = currentDocLines(text).length;
    assert.ok(current >= 20, `the scan reads ${doc} (${current} current lines)`);
    // The release notes are told apart by their heading, and a code fence left open would swallow every heading after it.
    if (doc.endsWith('.md')) {
      const fences = text.split(/\r?\n/).filter((line) => /^\s*```/.test(line)).length;
      assert.equal(fences % 2, 0, `${doc} closes every code fence (${fences} fence lines)`);
    }
    read += current;
    hits.push(...docHits(doc, text));
  }
  assert.ok(read > 5000, `the scan reads the docs (${read} current lines)`);
  assert.deepEqual(
    hits,
    [],
    'a current line names a retired thing: say what it is called now. A line that says what the name WAS may keep it, ' +
      'if that same line says so ("was", "renamed", "retired" or "v4.1" - on a hard-wrapped paragraph, put "(retired name)" ' +
      'after the name).\n' +
      hits.join('\n')
  );
});

test('the docs scan sees what it is for: each retired thing, none of the release notes, none of the lines that say what a name was', () => {
  // Each pattern fires on its own samples: one that stopped working would pass the docs for nothing.
  const labels = DOC_RETIRED.map(({ label }) => label);
  assert.equal(new Set(labels).size, labels.length, 'one label to a pattern');
  for (const { label, re, catches } of DOC_RETIRED) {
    assert.ok(catches.length > 0, `${label} has samples`);
    for (const sample of catches) assert.ok([...sample.matchAll(re)].length > 0, `${label} misses: ${sample}`);
  }
  // The list covers every file this file asserts is gone: a path added to PATHS_GONE needs its pattern here.
  for (const gone of PATHS_GONE) {
    assert.ok(DOC_RETIRED.some(({ re }) => [...gone.matchAll(re)].length > 0), `no docs pattern names ${gone}`);
  }
  // And none of them catches a spelling that stays.
  const scan = (text) => docHits('README.md', text);
  for (const sample of DOC_SPELLINGS_THAT_STAY) assert.deepEqual(scan(sample), [], `wrongly caught: ${sample}`);

  // A current line is caught, in its doc and at its real line number.
  const linesOf = (hits) => hits.map((hit) => Number(hit.split(':')[1]));
  const stale = scan(['# Tailor', '', 'The `ProfileEditor` draws the form.', '', 'It lives in `lib/profileDraft.ts`.'].join('\n'));
  assert.deepEqual(linesOf(stale), [3, 5]);
  assert.match(stale[0], /^README\.md:3: component: ProfileEditor: ProfileEditor$/);

  // The release notes are not read: from their heading to the next `## ` one, a fenced `## ` line ending nothing.
  const notes = [
    '# Tailor',
    'The `ResumeEditor` draws the form.',
    '## \u{1F195} What changed in this release',
    'The `ProfileEditor` went, and Settings -> Profile is Account.',
    '```',
    '## not a heading: it is inside a code fence',
    '```',
    'Still the notes: `groupsApi` is gone.',
    '',
    '## Architecture',
    'See `lib/profileDraft.ts`.',
  ].join('\n');
  assert.deepEqual(linesOf(scan(notes)), [11], 'only what comes after the notes');
  const fencedHeading = ['```md', '## What changed in this release', '```', 'Stale: `ProfileEditor`.'].join('\n');
  assert.deepEqual(linesOf(scan(fencedHeading)), [4], 'a heading in a code fence starts nothing');
  const crlf = 'ok\r\n`ProfileEditor`\r\n## What changed in this release\r\n`ProfileEditor`\r\n## Next\r\n`ProfileEditor`\r\n';
  assert.deepEqual(linesOf(scan(crlf)), [2, 6], 'CRLF');

  // A line that says what a name was may name it: "renamed from", "was", "v4.1", the marker, the Upgrading list.
  for (const sample of [
    '`ResumeEditor` (renamed from `ProfileEditor`).',
    '`routes/groups.ts` was folded into `routes/profiles.ts`.',
    '`defaultGroupId` is what v4.1 stored; it is `defaultProfileId` now.',
    '`groupsApi` (retired name)',
    'Renamed on the first start: `defaultGroupId` becomes `defaultProfileId`.',
    'The tab was **Settings -> Profile**.',
    'Open **Settings ->\nProfile**, which was renamed Account.',
    'Was **Settings ->\nProfile**, now Account.',
  ]) {
    assert.deepEqual(scan(sample), [], `wrongly caught: ${sample}`);
  }
  // ... and only that: whole words, and only on the line of the hit.
  for (const sample of [
    'The `ProfileEditor` draws the form.',
    'The `ProfileEditor` wasp, unrenamed, unretired, v4.10 and v4.12.',
  ]) {
    assert.equal(scan(sample).length, 1, `wrongly excused: ${sample}`);
  }
  const neighbours = 'Renamed last week.\n`ProfileEditor` draws the form.\nWas `groupsApi`.';
  assert.deepEqual(linesOf(scan(neighbours)), [2], 'a neighbour line excuses nothing');

  // A phrase that wraps is one hit, on its first line; it does not run over a blank line or from the text into the notes.
  assert.deepEqual(linesOf(scan('Under **Settings →\nProfile → Resume files** (a folder path).')), [1]);
  assert.deepEqual(linesOf(scan('#   Settings ->\n#   Profile -> Resume files')), [1]);
  assert.deepEqual(linesOf(scan('Editing a\nprofile shows the resume.')), [1]);
  assert.deepEqual(scan('Settings ->\n\nProfile'), []);
  assert.deepEqual(scan('Open Settings ->\n## What changed in this release\nProfile page'), []);
});
