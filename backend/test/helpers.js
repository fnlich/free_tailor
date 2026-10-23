const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

// No test uses a real Google credential: the search for one is off, and
// neither path variable names a file - what scripts/runTests.js sets for the
// whole run, here again for a file run with `node --test` on its own. A test
// of the search itself turns it back on for its own scope (`withCredentialSearch`).
process.env.TAILOR_GOOGLE_CREDENTIAL_SEARCH = 'off';
process.env.GOOGLE_CREDENTIALS_PATH = '';
process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH = '';

/**
 * Runs `action` with the default credential search on - only for a test that
 * puts its own fake credential in the directory it runs from (and fakes
 * `fetch`), since the search also finds a real one beside the compiled code.
 */
async function withCredentialSearch(action) {
  const saved = process.env.TAILOR_GOOGLE_CREDENTIAL_SEARCH;
  process.env.TAILOR_GOOGLE_CREDENTIAL_SEARCH = 'on';
  try {
    return await action();
  } finally {
    if (saved === undefined) delete process.env.TAILOR_GOOGLE_CREDENTIAL_SEARCH;
    else process.env.TAILOR_GOOGLE_CREDENTIAL_SEARCH = saved;
  }
}

function makeTempDataDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tailor-${name}-`));
}

/**
 * Points the SQLite database and the static asset directory at fresh temp
 * folders so each test runs against isolated storage.
 */
function useTempStorage(name) {
  const rootDir = makeTempDataDir(name);
  const dbDir = path.join(rootDir, 'db');
  const staticDir = path.join(rootDir, 'static');
  fs.mkdirSync(dbDir, { recursive: true });
  fs.mkdirSync(staticDir, { recursive: true });
  process.env.DB_DIR = dbDir;
  process.env.TAILOR_STATIC_DIR = staticDir;
  // Fresh storage means a fresh installation, and an installation does not
  // inherit the previous test's administrator.
  delete process.env.ADMIN_EMAILS;
  delete process.env.SMTP_USER;
  return { rootDir, dbDir, staticDir };
}

/**
 * Names the administrator, the way an installation does in .env.
 *
 * Needed explicitly now that arrival order decides nothing: without it a test
 * creates a pile of ordinary accounts and no administrator, which is exactly
 * what a real install with neither ADMIN_EMAILS nor SMTP_USER gets.
 *
 * Cleared by `useTempStorage`, so one test naming an admin cannot leak into the
 * next one in the same file.
 */
function useAdminEmails(...emails) {
  process.env.ADMIN_EMAILS = emails.flat().join(',');
}

function writeStaticJson(staticDir, relativePath, value) {
  const filePath = path.join(staticDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
  return filePath;
}

function openTestDb(dbDir) {
  return new Database(path.join(dbDir, 'free_tailor.db'));
}

function readDocument(dbDir, table, id) {
  const db = openTestDb(dbDir);
  try {
    const row = db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id);
    return row ? JSON.parse(row.data) : null;
  } finally {
    db.close();
  }
}

function readSettingRaw(dbDir, key) {
  const db = openTestDb(dbDir);
  try {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
    return row ? row.value : null;
  } finally {
    db.close();
  }
}

function writeSettingRaw(dbDir, key, value) {
  const db = openTestDb(dbDir);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT
      );
    `);
    db.prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(key, value, new Date().toISOString());
  } finally {
    db.close();
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/** Lines of a recorded `claude` CLI event stream, from test/fixtures/cli. */
function readCliFixture(name) {
  const filePath = path.join(__dirname, 'fixtures', 'cli', `${name}.ndjson`);
  return fs.readFileSync(filePath, 'utf8').split('\n').filter((line) => line.length > 0);
}

/**
 * A CliRunner that replays a recorded stream instead of spawning anything.
 *
 * This is the seam the whole provider suite runs on: no `claude` binary, no
 * network, no subprocess. `script` is either one step or a function of
 * (spec, callIndex) so a test can vary behaviour per call.
 *
 * A step may set:
 *   lines      - NDJSON lines to feed, in order
 *   chunks     - raw byte chunks to feed instead, so line splitting is
 *                exercised across real chunk boundaries
 *   exitCode, stderr, timedOut, stalled, aborted, spawnError
 */
function makeFakeCliRunner(script) {
  const calls = [];

  return {
    calls,
    async run(spec) {
      calls.push({
        binary: spec.binary,
        argv: [...spec.argv],
        env: spec.env,
        cwd: spec.cwd,
        stdin: spec.stdin,
        deadlineMs: spec.deadlineMs,
      });

      // Awaited so a script may be async and hold the slot for a measurable
      // moment, which is how the concurrency bound is observed at all.
      const step = await (typeof script === 'function' ? script(spec, calls.length - 1) : script);
      if (step.spawnError) {
        return {
          exitCode: null, signal: null, stderrTail: '', timedOut: false,
          stalled: false, aborted: false, spawnError: step.spawnError, bytesRead: 0,
        };
      }

      if (Array.isArray(step.chunks)) {
        // Feed raw bytes and split here exactly as the real runner does, so a
        // fixture split mid-line or mid-UTF-8 character is exercised for real.
        let buffered = Buffer.alloc(0);
        for (const chunk of step.chunks) {
          buffered = Buffer.concat([buffered, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')]);
          for (;;) {
            const newline = buffered.indexOf(0x0a);
            if (newline < 0) break;
            spec.onLine(buffered.subarray(0, newline).toString('utf8'));
            buffered = buffered.subarray(newline + 1);
          }
        }
        if (buffered.length > 0) {
          spec.onLine(buffered.toString('utf8'));
        }
      } else {
        for (const line of step.lines ?? []) {
          spec.onLine(line);
        }
      }

      return {
        exitCode: step.exitCode ?? 0,
        signal: null,
        stderrTail: step.stderr ?? '',
        timedOut: Boolean(step.timedOut),
        stalled: Boolean(step.stalled),
        aborted: Boolean(step.aborted),
        spawnError: null,
        bytesRead: 0,
      };
    },
  };
}

function loadFresh(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  return require(resolved);
}

/**
 * Runs `action` with console.error captured, and returns what it logged - one
 * string per call, objects through util.inspect, so an error's stack and own
 * properties are searchable - beside its result.
 *
 * For the failures `middleware/publicError` answers generically: the body or
 * the stored text carries a ref, and the cause is meant to be in the log under
 * that ref and nowhere a non-administrator can read it.
 */
async function captureErrorLog(action) {
  const util = require('util');
  const lines = [];
  const real = console.error;
  console.error = (...args) =>
    lines.push(args.map((arg) => (typeof arg === 'string' ? arg : util.inspect(arg, { depth: 4 }))).join(' '));
  try {
    const result = await action();
    return { result, lines };
  } finally {
    console.error = real;
  }
}

/**
 * The ref a public failure text ends with ("... (Ref: ERR-7F3A9C)"), checked
 * to be one, and the log lines filed under it.
 */
function refAndLog(text, lines) {
  const match = /\(Ref: (ERR-[0-9A-F]{6})\)$/.exec(String(text));
  if (!match) throw new Error(`No ref at the end of: ${text}`);
  const ref = match[1];
  return { ref, logged: lines.filter((line) => line.includes(`[error ${ref}]`)).join('\n') };
}

/**
 * Stores a job analysis the way the gate would have, for tests that build on
 * one without asking a model: a request names it by the id this returns
 * (`analysisId`), since an analysis OBJECT a client sends is never read.
 *
 * Through the repository of the dist the test already required, so it lands
 * in the database `useTempStorage` pointed DB_DIR at. A posting text unique to
 * the call unless one is given, because the text is a posting's identity.
 */
function storeJobAnalysis(analysis = {}, posting = {}) {
  const repository = require('../dist/database/jobAnalysisRepository');
  const identity = require('../dist/services/jobAnalysis/identity');
  const jobDescription =
    posting.jobDescription ?? `A stored posting for a test, unique to it: ${Math.random().toString(36).slice(2)}.`;
  const { row } = repository.insertJobAnalysisIfAbsent({
    contentHash: identity.contentHash(jobDescription),
    linkKey: identity.linkKey(posting.jobLink),
    jobLink: posting.jobLink ?? '',
    analysis: {
      jobMeta: { title: '', seniority: '', industry: '', department: '' },
      skills: { technical: [], required: [], preferred: [], tools: [], soft: [], technologies: [] },
      technologies: [],
      protocols: [],
      methodologies: [],
      architecturePatterns: [],
      responsibilities: [],
      domainKnowledge: [],
      softSkills: [],
      keywords: { actionVerbs: [], buzzwords: [], mustInclude: [] },
      jobField: 'unclassified',
      salary: null,
      filter: {
        jobType: 'not_specified',
        onsiteInterview: 'not_specified',
        companyCategory: 'other',
        clearanceRequired: 'not_specified',
        region: 'not_specified',
        usState: '',
      },
      ...analysis,
      sourceJobDescription: jobDescription,
    },
    modelId: '',
    promptHash: '',
    source: 'ai',
    createdBy: posting.createdBy ?? null,
    ...(posting.companyName ? { companyName: posting.companyName } : {}),
  });
  return row.id;
}

/**
 * Seeds one PROFILE (a person) holding resumes, for tests that need a tree to
 * stand on and are not about how it grows.
 *
 * `inputs` are resume payloads (CreateResumeDTO; an `id` in one is kept). They
 * are filed under the new profile in order - the first becomes its default, and
 * the resumes' times rise by a millisecond each, so "oldest" is the first one
 * whichever clock a rule reads. Returns `{ profileId, resumeIds }`.
 *
 * It goes round the HTTP routes and the profile limit on purpose: a seed is
 * not a request, so a Default account can be given three people to prove what
 * it may then do (the raw writers never count the limit, as filing does not).
 * The profile row is written straight into the `profiles` table on the
 * connection the test's own dist modules use, in the stored shape `{ id,
 * ownerId, name, defaultResumeId?, createdAt, updatedAt }`; each resume then
 * goes through the repository's raw `saveResume` carrying its `profileId`,
 * which that writer places on as long as the profile is the same owner's.
 */
function seedProfileWithResumes(owner, name, inputs = []) {
  const { randomUUID } = require('crypto');
  const { getDb } = require('../dist/database/sqlite');
  const resumes = require('../dist/database/resumeRepository');
  const { buildNewResume } = require('../dist/services/resumeDocument');

  const base = Date.now();
  const stamp = (offset) => new Date(base + offset).toISOString();
  const profileId = randomUUID();
  const resumeIds = inputs.map((input) => (typeof input.id === 'string' && input.id ? input.id : randomUUID()));

  const document = {
    id: profileId,
    ownerId: owner.id,
    name,
    ...(resumeIds.length > 0 ? { defaultResumeId: resumeIds[0] } : {}),
    createdAt: stamp(0),
    updatedAt: stamp(0),
  };
  getDb()
    .prepare('INSERT INTO profiles (id, name, data, created_at, updated_at, owner_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(profileId, name, JSON.stringify(document), document.createdAt, document.updatedAt, owner.id);

  inputs.forEach((input, index) => {
    resumes.saveResume({
      ...buildNewResume(input, resumeIds[index]),
      createdAt: stamp(index + 1),
      updatedAt: stamp(index + 1),
      ownerId: owner.id,
      profileId,
    });
  });

  return { profileId, resumeIds };
}

module.exports = {
  captureErrorLog,
  openTestDb,
  seedProfileWithResumes,
  storeJobAnalysis,
  loadFresh,
  refAndLog,
  useAdminEmails,
  makeFakeCliRunner,
  readCliFixture,
  readDocument,
  readJson,
  readSettingRaw,
  useTempStorage,
  withCredentialSearch,
  writeSettingRaw,
  writeStaticJson,
};
