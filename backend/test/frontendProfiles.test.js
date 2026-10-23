const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

// Before anything loads routes/resumes: the upload reads a real PDF and asks a
// model, and neither is this file's business. What is under test is the
// client's request (`?profileId=`) and WHERE the resume lands.
require.cache[require.resolve('pdf-parse')] = {
  id: require.resolve('pdf-parse'),
  filename: require.resolve('pdf-parse'),
  loaded: true,
  exports: async () => ({ text: 'A resume with plenty of text in it, enough to count as a real document.' }),
};

const ts = require('typescript');

const { useAdminEmails, useTempStorage } = require('./helpers');

/**
 * The profiles pages' half of v4.2 (frontend part F34), written from the
 * specification - the contract's sections 2.1 to 2.8 and design F3.10 - and
 * not from the code it holds to:
 *
 *  - lib/profileDashboard.ts, every helper (storage that throws included), the
 *    desk route, and `resumeLabel` against the server's `resumeLabelOf`;
 *  - lib/resumeGallery.ts's new hrefs, Duplicate (which keeps the template)
 *    and the file Download writes;
 *  - lib/orders.ts `describeChoice`, the one wording of why a resume was chosen;
 *  - lib/buildModes.ts against the server's config/buildModes;
 *  - the clients `profilesApi` and `resumesApi` run against the REAL routes
 *    (the frontendSubscription pattern: the frontend's modules transpiled with
 *    the backend's TypeScript, their requests sent to the routers on a port of
 *    their own);
 *  - the pages that must exist, the one that must not, and text pins on the
 *    sources (tablist, aria-pressed, Suspense, the editor's way back, no
 *    template rule).
 *
 * Loaded the way frontendSubscription.test.js and frontendEditorHelpers.test.js
 * load their modules. Nothing sleeps and nothing leaves the process.
 */

useTempStorage('frontend-profiles');
useAdminEmails('admin@example.com');

const SRC = path.join(__dirname, '..', '..', 'frontend', 'src');

/* ------------------------------------------------------------------ loading frontend modules */

const transpiled = new Map();

function transpile(file) {
  if (!transpiled.has(file)) {
    const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
      fileName: file,
    });
    transpiled.set(file, outputText);
  }
  return transpiled.get(file);
}

/** A module that imports other frontend modules (`@/...` or relative), resolved and shared through `seen`. */
function loadFrontend(relative, seen = new Map()) {
  const file = path.join(SRC, relative);
  if (seen.has(file)) return seen.get(file).exports;
  const module = { exports: {} };
  seen.set(file, module);
  const resolve = (specifier) => {
    let base;
    if (specifier.startsWith('@/')) base = specifier.slice(2);
    else if (specifier.startsWith('./') || specifier.startsWith('../')) {
      base = path.relative(SRC, path.join(path.dirname(file), specifier));
    } else {
      throw new Error(`${relative} imports ${specifier} at runtime; it is meant to import only frontend modules`);
    }
    const candidate = ['.ts', '.tsx'].map((ext) => `${base}${ext}`).find((name) => fs.existsSync(path.join(SRC, name)));
    if (!candidate) throw new Error(`${relative}: cannot resolve ${specifier}`);
    return loadFrontend(candidate, seen);
  };
  new Function('module', 'exports', 'require', transpile(file))(module, module.exports, resolve);
  return module.exports;
}

/** A module that must import nothing at runtime (types only), as the contract says of the pure libraries. */
function loadPure(relative) {
  const file = path.join(SRC, relative);
  const module = { exports: {} };
  const refuse = (specifier) => {
    throw new Error(`${relative} imports ${specifier}; it is meant to import nothing at runtime`);
  };
  new Function('module', 'exports', 'require', transpile(file))(module, module.exports, refuse);
  return module.exports;
}

const read = (...segments) => fs.readFileSync(path.join(SRC, ...segments), 'utf8');

function walk(dir, extensions = ['.ts', '.tsx', '.js', '.jsx', '.css']) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full, extensions));
    else if (extensions.includes(path.extname(entry.name))) found.push(full);
  }
  return found;
}

const sourcesUnder = (...segments) => {
  const target = path.join(SRC, ...segments);
  if (!fs.existsSync(target)) return '';
  return fs.statSync(target).isDirectory()
    ? walk(target, ['.ts', '.tsx']).map((file) => fs.readFileSync(file, 'utf8')).join('\n')
    : fs.readFileSync(target, 'utf8');
};

function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/* ------------------------------------------------------------------ small fixtures */

const profile = (id, lastEditedAt, extra = {}) => ({
  id,
  name: `Profile ${id}`,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: lastEditedAt,
  lastEditedAt,
  resumeCount: 0,
  enabledResumeCount: 0,
  defaultResumeId: null,
  chosenDefaultResumeId: null,
  ...extra,
});

const resume = (id, extra = {}) => ({ id, name: `Name ${id}`, title: '', profileId: 'p1', ...extra });

/** A storage that holds what it is given. */
function memoryStorage(initial = {}) {
  const held = new Map(Object.entries(initial));
  return {
    held,
    getItem: (key) => (held.has(key) ? held.get(key) : null),
    setItem: (key, value) => {
      held.set(key, String(value));
    },
  };
}

/** A storage that refuses every call, as a private window or blocked site data does. */
const throwingStorage = {
  getItem() {
    throw new Error('storage is blocked');
  },
  setItem() {
    throw new Error('storage is blocked');
  },
};

/* ================================================================== lib/profileDashboard.ts */

const dashboard = () => loadPure('lib/profileDashboard.ts');

test('the dashboard imports nothing at runtime, so the tests (and the pages) can load it alone', () => {
  assert.doesNotThrow(() => dashboard());
});

test('the dashboard has two tabs: only "resumes" opens All resumes, anything else is Profiles, and each tab has its address', () => {
  const { readDashboardTab, dashboardHref } = dashboard();
  assert.equal(readDashboardTab('resumes'), 'resumes');
  for (const other of ['profiles', '', null, undefined, 'RESUMES', 'groups', 'resumes ', 'resume']) {
    assert.equal(readDashboardTab(other), 'profiles', String(other));
  }
  assert.equal(dashboardHref('profiles'), '/admin/profiles');
  assert.equal(dashboardHref('resumes'), '/admin/profiles?tab=resumes');
  // The address reads back as the tab it was made for.
  for (const tab of ['profiles', 'resumes']) {
    assert.equal(readDashboardTab(new URL(dashboardHref(tab), 'http://localhost').searchParams.get('tab')), tab);
  }
});

test('the view (Grid or List) is kept in localStorage under its own key, and a storage that is missing or throws means Grid', () => {
  const { VIEW_MODE_KEY, readViewMode, writeViewMode } = dashboard();
  assert.equal(VIEW_MODE_KEY, 'freeTailor.profiles.view');

  assert.equal(readViewMode(null), 'grid');
  assert.equal(readViewMode(memoryStorage()), 'grid', 'nothing stored');
  assert.equal(readViewMode(memoryStorage({ [VIEW_MODE_KEY]: 'list' })), 'list');
  assert.equal(readViewMode(memoryStorage({ [VIEW_MODE_KEY]: 'grid' })), 'grid');
  for (const junk of ['', 'LIST', 'cards', ' list', 'list ', '1']) {
    assert.equal(readViewMode(memoryStorage({ [VIEW_MODE_KEY]: junk })), 'grid', JSON.stringify(junk));
  }
  assert.equal(readViewMode(throwingStorage), 'grid', 'a storage that throws');
  assert.equal(readViewMode({ getItem: () => undefined }), 'grid', 'a storage that answers nothing');

  // It asks for exactly its own key.
  const asked = [];
  readViewMode({ getItem: (key) => (asked.push(key), 'list') });
  assert.deepEqual(asked, [VIEW_MODE_KEY]);

  const storage = memoryStorage();
  writeViewMode(storage, 'list');
  assert.equal(storage.held.get(VIEW_MODE_KEY), 'list');
  assert.equal(readViewMode(storage), 'list', 'what was written is read back');
  writeViewMode(storage, 'grid');
  assert.equal(readViewMode(storage), 'grid');

  assert.doesNotThrow(() => writeViewMode(throwingStorage, 'list'), 'a refusing storage is not an error');
  assert.doesNotThrow(() => writeViewMode(null, 'list'), 'no storage is not an error');
});

test('the desk route: a profile list, one profile and an editor are on the resume desk; nothing else is', () => {
  const { isProfilesDeskRoute } = dashboard();
  for (const yes of [
    '/admin/profiles',
    '/admin/profiles/',
    '/admin/profiles/x123',
    '/admin/profiles/x123/',
    '/admin/resumes/new',
    '/admin/resumes/x123',
    '/admin/resumes/x123/',
  ]) {
    assert.equal(isProfilesDeskRoute(yes), true, yes);
  }
  for (const no of [
    '/admin/resumes',
    '/admin/resumes/',
    '/admin/profiles/a/b',
    '/admin/resumes/a/b',
    '/admin/profilesx',
    '/admin/settings',
    '/admin',
    '/admin/',
    '/profiles',
    '/',
    '',
  ]) {
    assert.equal(isProfilesDeskRoute(no), false, no);
  }
});

test('a profile page and a new-resume address carry the ids encoded, and read back the profile asked for', () => {
  const { profilePageHref, newResumeHref, readProfileParam } = dashboard();
  assert.equal(profilePageHref('abc-123'), '/admin/profiles/abc-123');
  assert.equal(profilePageHref('a b/c'), '/admin/profiles/a%20b%2Fc');

  assert.equal(newResumeHref(), '/admin/resumes/new');
  assert.equal(newResumeHref(null), '/admin/resumes/new');
  assert.equal(newResumeHref(''), '/admin/resumes/new');
  assert.equal(newResumeHref('p1'), '/admin/resumes/new?profile=p1');
  assert.equal(newResumeHref('a/b&c=d'), '/admin/resumes/new?profile=a%2Fb%26c%3Dd');
  assert.equal(new URL(newResumeHref('a/b&c=d'), 'http://localhost').searchParams.get('profile'), 'a/b&c=d');

  assert.equal(readProfileParam('p1'), 'p1');
  assert.equal(readProfileParam('  p1  '), 'p1');
  for (const none of ['', '   ', null, undefined]) assert.equal(readProfileParam(none), null, String(none));
  assert.equal(readProfileParam(new URL(newResumeHref('abc'), 'http://localhost').searchParams.get('profile')), 'abc');
});

test('a resume is called by its headline, else its name, else "Untitled resume" - exactly as the server labels it', () => {
  const { resumeLabel } = dashboard();
  const { resumeLabelOf } = require('../dist/services/profileRules');
  const table = [
    { title: 'Backend Engineer', name: 'Jane Doe' },
    { title: 'Professional', name: 'Jane Doe' },
    { title: ' Professional ', name: 'Jane Doe' },
    { title: 'professional', name: 'Jane Doe' },
    { title: '', name: 'Jane Doe' },
    { title: '   ', name: '  Jane   Doe  ' },
    { title: undefined, name: 'Jane Doe' },
    { name: 'Jane Doe' },
    { title: 'Staff   Platform  Engineer', name: 'x' },
    { title: '  Data Engineer  ', name: '' },
    { title: 'Professional', name: '' },
    { title: 'Professional', name: '   ' },
    { title: '', name: '' },
    { title: undefined, name: undefined },
    {},
    { title: 'Café Manager', name: 'a' },
    { title: '', name: 'Zöe' },
    { title: '工程师', name: 'Li Lei' },
  ];
  for (const input of table) {
    assert.equal(resumeLabel(input), resumeLabelOf(input), JSON.stringify(input));
  }
  // And the plain cases, spelled out.
  assert.equal(resumeLabel({ title: 'Backend Engineer', name: 'Jane Doe' }), 'Backend Engineer');
  assert.equal(resumeLabel({ title: 'Professional', name: 'Jane Doe' }), 'Jane Doe');
  assert.equal(resumeLabel({ title: '', name: '' }), 'Untitled resume');
});

test('profiles are listed newest edit first, ties by id, and sorting changes nothing it was given', () => {
  const { sortProfiles } = dashboard();
  const given = [
    profile('b', '2026-03-01T00:00:00.000Z'),
    profile('c', '2026-05-01T00:00:00.000Z'),
    profile('a', '2026-03-01T00:00:00.000Z'),
    profile('d', '2026-01-01T00:00:00.000Z'),
  ];
  const snapshot = given.map((p) => p.id).join();
  assert.deepEqual(sortProfiles(given).map((p) => p.id), ['c', 'a', 'b', 'd']);
  assert.equal(given.map((p) => p.id).join(), snapshot, 'the list given is left as it was');
  assert.deepEqual(sortProfiles([]), []);
  assert.deepEqual(sortProfiles(given.slice().reverse()).map((p) => p.id), ['c', 'a', 'b', 'd'], 'never depends on the order given');
});

test('a search matches a typed word anywhere, in any case, ignoring the spaces around it; nothing typed matches everything', () => {
  const { matchesQuery } = dashboard();
  assert.equal(matchesQuery('', ['anything']), true);
  assert.equal(matchesQuery('   ', []), true);
  assert.equal(matchesQuery('jane', ['Jane Doe']), true);
  assert.equal(matchesQuery('  JANE  ', ['jane doe']), true);
  assert.equal(matchesQuery('e do', ['Jane Doe']), true, 'a substring, across words');
  assert.equal(matchesQuery('bob', ['Jane Doe']), false);
  assert.equal(matchesQuery('bob', []), false);
  assert.equal(matchesQuery('bob', [undefined, 'Backend', undefined, 'Bobby']), true, 'a missing field is skipped');
  assert.equal(matchesQuery('bob', [undefined]), false);
});

test('Profiles search matches a profile by its name or by any of its resumes, and All resumes search by label, name or profile name', () => {
  const { filterProfiles, filterResumes } = dashboard();
  const profiles = [
    profile('p1', '2026-02-01T00:00:00.000Z', { name: 'Jane Doe' }),
    profile('p2', '2026-01-01T00:00:00.000Z', { name: 'Zed Zee' }),
    profile('p3', '2026-03-01T00:00:00.000Z', { name: 'Empty Person' }),
  ];
  const resumes = [
    resume('r1', { profileId: 'p1', name: 'Jane Doe', title: 'Backend Engineer' }),
    resume('r2', { profileId: 'p2', name: 'Z. Zee', title: 'Data Engineer' }),
    resume('r3', { profileId: 'p2', name: 'Zed Zee', title: 'Professional' }),
  ];
  // Membership, not order: the order a list is shown in is sortProfiles' business.
  const ids = (list) => list.map((item) => item.id).sort();

  // Profiles: by name, by a resume's label (its headline), by a resume's name.
  assert.deepEqual(ids(filterProfiles(profiles, resumes, '')), ['p1', 'p2', 'p3'], 'nothing typed: everyone');
  assert.deepEqual(ids(filterProfiles(profiles, resumes, '  ')), ['p1', 'p2', 'p3']);
  assert.deepEqual(ids(filterProfiles(profiles, resumes, 'jane')), ['p1']);
  assert.deepEqual(ids(filterProfiles(profiles, resumes, 'data eng')), ['p2'], "by a resume's label");
  assert.deepEqual(ids(filterProfiles(profiles, resumes, 'z. zee')), ['p2'], "by a resume's name");
  assert.deepEqual(ids(filterProfiles(profiles, resumes, 'engineer')), ['p1', 'p2'], 'any of its resumes');
  assert.deepEqual(ids(filterProfiles(profiles, resumes, 'empty')), ['p3'], 'a profile with no resume is still found by its name');
  assert.deepEqual(ids(filterProfiles(profiles, resumes, 'nobody')), []);
  assert.deepEqual(ids(filterProfiles(profiles, [], 'engineer')), [], 'resumes not given: only names count');

  // Resumes: by label, by name, by their profile's name.
  assert.deepEqual(ids(filterResumes(resumes, profiles, '')), ['r1', 'r2', 'r3']);
  assert.deepEqual(ids(filterResumes(resumes, profiles, 'backend')), ['r1'], 'by label');
  assert.deepEqual(ids(filterResumes(resumes, profiles, 'z. zee')), ['r2'], 'by name');
  assert.deepEqual(ids(filterResumes(resumes, profiles, 'zed')), ['r2', 'r3'], "by the profile's name (and r3's own label, its name)");
  assert.deepEqual(ids(filterResumes(resumes, profiles, 'jane doe')), ['r1']);
  assert.deepEqual(ids(filterResumes(resumes, profiles, 'nobody')), []);
  assert.deepEqual(
    ids(filterResumes([resume('lost', { profileId: 'gone', name: 'Lost Soul' })], profiles, 'lost')),
    ['lost'],
    'a resume whose profile is not in the list is still found by its own words'
  );
});

test("the holdings line welcomes the account and counts its profiles and resumes, singular at one", () => {
  const { describeHoldings } = dashboard();
  assert.equal(describeHoldings('Jane', 2, 5), 'Welcome back, Jane! You have 2 profiles and 5 resumes.');
  assert.equal(describeHoldings('Jane', 1, 1), 'Welcome back, Jane! You have 1 profile and 1 resume.');
  assert.equal(describeHoldings('Jane', 1, 3), 'Welcome back, Jane! You have 1 profile and 3 resumes.');
  assert.equal(describeHoldings('Jane', 4, 1), 'Welcome back, Jane! You have 4 profiles and 1 resume.');
  assert.equal(describeHoldings('Jane', 0, 0), 'Welcome back, Jane! You have 0 profiles and 0 resumes.');
  assert.equal(describeHoldings('', 2, 5), 'Welcome back! You have 2 profiles and 5 resumes.');
  assert.equal(describeHoldings('', 1, 1), 'Welcome back! You have 1 profile and 1 resume.');
});

test("the search's status line says how many matched, in the owner's words", () => {
  const { describeMatches } = dashboard();
  assert.equal(describeMatches(1, 2, 'profile'), '1 of 2 profiles match.');
  assert.equal(describeMatches(0, 2, 'resume'), '0 of 2 resumes match.');
  assert.equal(describeMatches(2, 5, 'resume'), '2 of 5 resumes match.');
  assert.equal(describeMatches(0, 7, 'profile'), '0 of 7 profiles match.');
  assert.equal(describeMatches(3, 3, 'profile'), '3 of 3 profiles match.');
});

test("deleting a profile warns about its resumes in the owner's words, and a profile with none is a plain delete", () => {
  const { deleteProfileWording } = dashboard();
  assert.deepEqual(deleteProfileWording('Jane Doe', 2), {
    title: 'Delete Jane Doe?',
    body: "You can't undo this. Every resume in this profile will be deleted with it and can't be recovered.",
    confirm: 'Delete profile and its resumes',
  });
  assert.deepEqual(deleteProfileWording('Jane Doe', 1), deleteProfileWording('Jane Doe', 2), 'one resume is still a resume');
  assert.deepEqual(deleteProfileWording('Jane Doe', 0), {
    title: 'Delete Jane Doe?',
    body: "This can't be undone.",
    confirm: 'Delete profile',
  });
  for (const blank of ['', '   ']) {
    assert.equal(deleteProfileWording(blank, 0).title, 'Delete Untitled Profile?', JSON.stringify(blank));
    assert.equal(deleteProfileWording(blank, 3).title, 'Delete Untitled Profile?', JSON.stringify(blank));
  }
});

test('the keywords preview shows the first eight terms and counts the rest', () => {
  const { keywordPreview } = dashboard();
  const terms = (n) => Array.from({ length: n }, (_, i) => `T${i + 1}`);
  const keywords = (list) => ({ version: 3, vocabulary: 'v', basedOn: 'b', headline: [], roleTitles: [], terms: list });

  assert.deepEqual(keywordPreview(undefined), { shown: [], more: 0 });
  assert.deepEqual(keywordPreview(keywords([])), { shown: [], more: 0 });
  assert.deepEqual(keywordPreview(keywords(terms(3))), { shown: ['T1', 'T2', 'T3'], more: 0 });
  assert.deepEqual(keywordPreview(keywords(terms(8))), { shown: terms(8), more: 0 }, 'exactly eight: nothing more');
  assert.deepEqual(keywordPreview(keywords(terms(9))), { shown: terms(8), more: 1 });
  assert.deepEqual(keywordPreview(keywords(terms(80))), { shown: terms(8), more: 72 });
  assert.deepEqual(keywordPreview(keywords(terms(10)), 3), { shown: ['T1', 'T2', 'T3'], more: 7 }, 'the limit is the caller\'s to give');
  assert.deepEqual(keywordPreview(keywords(terms(3)), 3), { shown: terms(3), more: 0 });
});

/* ================================================================== lib/resumeGallery.ts */

const gallery = () => loadFrontend('lib/resumeGallery.ts');

/** A resume as the server stores and serves it, with every key Duplicate and Download must decide about. */
function storedResume(extra = {}) {
  const { buildNewResume } = require('../dist/services/resumeDocument');
  const built = buildNewResume(
    {
      name: 'Sam Chen',
      title: 'Backend Engineer',
      summary: 'Builds backend services in Go.',
      skills: ['Go', 'Kubernetes'],
      softSkills: ['Mentoring'],
      experience: [
        {
          company: 'Acme',
          title: 'Engineer',
          startDate: '2020-01',
          endDate: 'Present',
          achievements: ['Built a queue.', 'Cut deploy time by half.'],
        },
      ],
      education: [],
      strengths: [],
      projects: [{ name: 'Tailor', description: 'A resume tool.' }],
      languages: [{ name: 'English' }],
    },
    'resume-1'
  );
  return {
    ...built,
    resumeSettings: { ...built.resumeSettings, includeStrengths: true, resumeFileNameTemplate: '{{profile_name}}_cv', ai: { modelId: 'gone' } },
    id: 'resume-1',
    ownerId: 'owner-1',
    profileId: 'profile-1',
    preferredTemplate: 'navy-rule',
    disabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
    matchKeywords: { version: 3, vocabulary: 'v', basedOn: 'b', headline: ['engineer'], roleTitles: ['engineer'], terms: ['Go', 'Kubernetes'] },
    ...extra,
  };
}

test('the chooser links carry the template, then the layout, then the profile, in that order', () => {
  const { startResumeHref, startWithoutTemplateHref, NEW_RESUME_PATH } = gallery();
  assert.equal(NEW_RESUME_PATH, '/admin/resumes/new');

  assert.equal(startResumeHref('classic-serif'), '/admin/resumes/new?template=classic-serif');
  assert.equal(startResumeHref('navy-rule', 'flat'), '/admin/resumes/new?template=navy-rule&layout=flat');
  assert.equal(startResumeHref('classic-serif', undefined, null), '/admin/resumes/new?template=classic-serif');
  assert.equal(startResumeHref('classic-serif', 'flat', null), '/admin/resumes/new?template=classic-serif&layout=flat');
  assert.equal(startResumeHref('classic-serif', undefined, 'p1'), '/admin/resumes/new?template=classic-serif&profile=p1');
  assert.equal(startResumeHref('navy-rule', 'flat', 'p1'), '/admin/resumes/new?template=navy-rule&layout=flat&profile=p1');
  assert.equal(
    startResumeHref('navy-rule', 'flat', 'a/b&c=d'),
    '/admin/resumes/new?template=navy-rule&layout=flat&profile=a%2Fb%26c%3Dd',
    'the profile is encoded'
  );

  // Whatever is put in reads back out.
  const url = new URL(startResumeHref('navy-rule', 'categorized', 'a/b&c=d'), 'http://localhost');
  assert.equal(url.pathname, NEW_RESUME_PATH);
  assert.equal(url.searchParams.get('template'), 'navy-rule');
  assert.equal(url.searchParams.get('profile'), 'a/b&c=d');
  assert.notEqual(url.searchParams.get('layout'), 'flat');

  assert.equal(startWithoutTemplateHref(), '/admin/resumes/new?template=');
  assert.equal(startWithoutTemplateHref(null), '/admin/resumes/new?template=');
  assert.equal(startWithoutTemplateHref('p1'), '/admin/resumes/new?template=&profile=p1');
  assert.equal(startWithoutTemplateHref('a/b&c=d'), '/admin/resumes/new?template=&profile=a%2Fb%26c%3Dd');
});

test('Duplicate copies a resume for a new one, KEEPS its template, and leaves out the id, the times, the switch, the profile and the keywords', () => {
  const { duplicateResumeBody } = gallery();
  const { normalizeResumePayload } = require('../dist/services/resumeDocument');
  const stored = storedResume();
  const before = JSON.parse(JSON.stringify(stored));

  const body = duplicateResumeBody(stored, {});
  assert.equal(body.preferredTemplate, 'navy-rule', 'the template is kept');
  for (const key of ['id', 'createdAt', 'updatedAt', 'disabled', 'profileId', 'matchKeywords']) {
    assert.equal(key in body, false, `${key} is dropped`);
  }
  // `before` went through JSON, which drops the built resume's undefined keys; so does the comparison.
  assert.deepEqual(JSON.parse(JSON.stringify(stored)), before, 'the resume itself is not changed');

  // Everything the person wrote comes with it.
  assert.equal(body.name, 'Sam Chen');
  assert.equal(body.title, 'Backend Engineer');
  assert.equal(body.summary, stored.summary);
  assert.deepEqual(body.skills, stored.skills);
  assert.deepEqual(body.resumeSettings.ai, {}, 'the model choice as the caller may save it');
  assert.equal(body.resumeSettings.resumeFileNameTemplate, '{{profile_name}}_cv');
  assert.deepEqual(stored.resumeSettings.ai, { modelId: 'gone' });
  assert.deepEqual(duplicateResumeBody(stored, { modelId: 'kept' }).resumeSettings.ai, { modelId: 'kept' });

  // And the server reads it as a new, enabled resume on the same template.
  const copy = normalizeResumePayload(body);
  assert.equal(copy.preferredTemplate, 'navy-rule');
  assert.equal(copy.disabled, false);
  assert.equal(copy.name, stored.name);
  for (const key of ['title', 'summary', 'skills', 'softSkills', 'projects', 'languages']) {
    assert.deepEqual(copy[key], stored[key], key);
  }
  assert.deepEqual(copy.experience[0].achievements, stored.experience[0].achievements);
  assert.equal(copy.resumeSettings.resumeFileNameTemplate, '{{profile_name}}_cv');
});

test('Download writes the resume as a file Import JSON takes back, without the keywords or the profile it was filed under', () => {
  const { resumeExportText, resumeExportFileName } = gallery();
  const { buildImportedResumes } = require('../dist/services/resumeImport');
  const stored = storedResume();

  const text = resumeExportText(stored);
  assert.ok(text.endsWith('\n'), 'a text file ends its last line');
  assert.match(text, /\n {2}"name": "Sam Chen"/, 'pretty-printed, two spaces');
  const parsed = JSON.parse(text);
  assert.equal('matchKeywords' in parsed, false);
  assert.equal('profileId' in parsed, false);
  assert.doesNotMatch(text, /matchKeywords|profileId/);
  assert.equal(parsed.name, 'Sam Chen');
  assert.equal(parsed.preferredTemplate, 'navy-rule');
  assert.deepEqual(parsed.experience, JSON.parse(JSON.stringify(stored.experience)));
  assert.equal('matchKeywords' in stored && 'profileId' in stored, true, 'the resume itself is not changed');

  const [imported] = buildImportedResumes(parsed, { idExists: () => false, newId: () => 'fresh' });
  assert.equal(imported.resume.id, 'resume-1', 'the id is kept while it is free');
  assert.equal(imported.resume.name, 'Sam Chen');
  assert.deepEqual(imported.resume.projects, stored.projects);
  const [again] = buildImportedResumes(parsed, { idExists: () => true, newId: () => 'fresh' });
  assert.equal(again.resume.id, 'fresh', 'and never overwrites one');

  assert.equal(resumeExportFileName({ name: 'Sam Chen' }), 'sam-chen.json');
});

/* ================================================================== lib/orders.ts describeChoice */

test("describeChoice says why a resume was chosen, in one wording for the order page, the receipt and the preview", () => {
  const { describeChoice } = loadFrontend('lib/orders.ts');
  const match = (extra) => ({ v: 1, mode: 'partial', reason: 'matched', candidates: 3, ...extra });

  assert.equal(describeChoice(null), null);
  assert.equal(describeChoice(undefined), null);

  // matched: the terms it carries, best first.
  assert.equal(
    describeChoice(match({ matched: ['Go', 'Kubernetes', 'AWS'], matchedCount: 3, postingTermCount: 6 })),
    'Partial Tailor: matched Go, Kubernetes, AWS'
  );
  assert.equal(
    describeChoice(match({ mode: 'suitable', matched: ['Go'], matchedCount: 1 })),
    'Suitable resume: matched Go',
    'Choose Suitable Resume is named "Suitable resume" here'
  );
  assert.equal(describeChoice(match({ mode: 'full', matched: ['Go'], matchedCount: 1 })), 'Fully Tailor: matched Go');

  // Eight terms are shown and the rest are counted.
  const ten = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10'];
  assert.equal(
    describeChoice(match({ matched: ten, matchedCount: 10 })),
    'Partial Tailor: matched T1, T2, T3, T4, T5, T6, T7, T8 and 2 more'
  );
  assert.equal(
    describeChoice(match({ matched: ten.slice(0, 8), matchedCount: 11 })),
    'Partial Tailor: matched T1, T2, T3, T4, T5, T6, T7, T8 and 3 more',
    'the count the server made, not the list it kept'
  );
  assert.equal(
    describeChoice(match({ matched: ten.slice(0, 8), matchedCount: 8 })),
    'Partial Tailor: matched T1, T2, T3, T4, T5, T6, T7, T8',
    'eight matched: nothing more'
  );
  assert.equal(
    describeChoice(match({ matched: ten.slice(0, 7), matchedCount: 7 })),
    'Partial Tailor: matched T1, T2, T3, T4, T5, T6, T7'
  );

  // Nothing but the title matched.
  assert.equal(
    describeChoice(match({ matched: [], matchedCount: 0, titleMatched: true })),
    "Partial Tailor: its title matches the posting's"
  );
  assert.equal(
    describeChoice(match({ mode: 'suitable', matched: [], matchedCount: 0, titleMatched: true })),
    "Suitable resume: its title matches the posting's"
  );
  assert.equal(
    describeChoice(match({ matched: ['Go'], matchedCount: 1, titleMatched: true })),
    'Partial Tailor: matched Go',
    'terms first when there are any'
  );

  // The rest.
  assert.equal(
    describeChoice({ v: 1, mode: 'partial', reason: 'tie', candidates: 2, basis: 'none' }),
    "Partial Tailor: no other resume matched better, so the profile's default"
  );
  assert.equal(
    describeChoice({ v: 1, mode: 'suitable', reason: 'tie', candidates: 4 }),
    "Suitable resume: no other resume matched better, so the profile's default"
  );
  assert.equal(
    describeChoice({ v: 1, mode: 'partial', reason: 'only', candidates: 1 }),
    "Partial Tailor: the profile's only enabled resume"
  );
  assert.equal(
    describeChoice({ v: 1, mode: 'suitable', reason: 'only', candidates: 1 }),
    "Suitable resume: the profile's only enabled resume"
  );
  assert.equal(
    describeChoice({ v: 1, mode: 'full', reason: 'default', candidates: 3 }),
    "Fully Tailor: the profile's default resume"
  );
});

/* ================================================================== lib/buildModes.ts */

test('the build modes the pages know are the server\'s: the modes, their labels, the price settings and the request fields', () => {
  const frontend = loadPure('lib/buildModes.ts');
  const server = require('../dist/config/buildModes');
  const { MODE_PRICE_REQUEST_FIELDS, APP_SETTING_ENV_VARIABLES } = loadFrontend('lib/settingSources.ts');

  assert.deepEqual([...frontend.BUILD_MODES], [...server.BUILD_MODES]);
  assert.deepEqual([...frontend.BUILD_MODES], ['suitable', 'partial', 'full']);
  assert.deepEqual({ ...frontend.BUILD_MODE_LABELS }, { ...server.BUILD_MODE_LABELS });
  assert.deepEqual(
    { ...frontend.BUILD_MODE_LABELS },
    { suitable: 'Choose Suitable Resume', partial: 'Partial Tailor', full: 'Fully Tailor' }
  );

  for (const mode of server.BUILD_MODES) {
    const fields = server.BUILD_MODE_PRICE_FIELDS[mode];
    assert.equal(frontend.BUILD_MODE_PRICE_SETTINGS[mode], fields.setting, `${mode}: the setting a price is served under`);
    assert.equal(MODE_PRICE_REQUEST_FIELDS[fields.setting], fields.request, `${mode}: the request field a price is sent under`);
    assert.deepEqual([...APP_SETTING_ENV_VARIABLES[fields.setting]], [fields.env], `${mode}: the .env variable behind it`);
  }
  assert.deepEqual(Object.keys(MODE_PRICE_REQUEST_FIELDS).sort(), Object.values(frontend.BUILD_MODE_PRICE_SETTINGS).sort());
  assert.deepEqual([...APP_SETTING_ENV_VARIABLES.defaultBuildMode], ['DEFAULT_TAILOR_MODE'], 'the starting mode follows .env');
  assert.equal('defaultResumeSelection' in APP_SETTING_ENV_VARIABLES, false, 'the builder has no default target any more');

  for (const mode of server.BUILD_MODES) assert.equal(frontend.isBuildMode(mode), true, mode);
  for (const other of ['', 'Partial', 'both', 'tailor', null, undefined, 1, {}, ['full']]) {
    assert.equal(frontend.isBuildMode(other), false, String(other));
    assert.equal(server.isBuildMode(other), false, String(other));
  }
});

test("the three mode cards read in the owner's order and words, and never mention a subscription", () => {
  const { BUILD_MODE_CHOICES, BUILD_MODE_LABELS } = loadPure('lib/buildModes.ts');
  assert.deepEqual(
    BUILD_MODE_CHOICES.map((choice) => choice.value),
    ['suitable', 'partial', 'full']
  );
  for (const choice of BUILD_MODE_CHOICES) {
    assert.equal(choice.label, BUILD_MODE_LABELS[choice.value], `${choice.value}: the card carries the mode's name`);
    assert.doesNotMatch(choice.description, /premium|\bplan\b|subscription/i, `${choice.value}: every mode is open to every account`);
  }
  const description = Object.fromEntries(BUILD_MODE_CHOICES.map((choice) => [choice.value, choice.description]));
  assert.equal(
    description.suitable,
    'For each job, the resume whose keywords match the posting best, built as written. Only its cover letter is written by AI.'
  );
  assert.equal(
    description.partial,
    "The best-matching resume, with job-friendly changes for the posting's keywords. Your own summary and each role's description and achievements are rewritten; a role you left empty is written from the posting."
  );
  assert.equal(
    description.full,
    "The profile's default resume, with the summary, experience and skills written for the posting from each role's company, title and dates, with plausible figures. Read it before you send it."
  );
});

/* ================================================================== the clients, against the real routes */

let worldPromise = null;
const world = () => (worldPromise ??= startWorld());

test.after(async () => {
  if (worldPromise) (await worldPromise).close();
});

async function startWorld() {
  const users = require('../dist/database/userRepository');
  const { attachUser } = require('../dist/middleware/auth');
  const { publicErrorHandler } = require('../dist/middleware/publicError');
  require('../dist/bidAssistant/database');

  // The model behind an upload: counted, so a test can say it did not run.
  const resumeService = require('../dist/services/resumeService');
  const extractCalls = [];
  resumeService.extractResumeFromText = async (text) => {
    extractCalls.push(text);
    return {
      name: 'Uploaded Person',
      title: 'Engineer',
      summary: 'Read from a PDF.',
      skills: ['Go'],
      contact: { email: 'uploaded@example.com', phone: '1', location: 'Remote' },
      experience: [],
      strengths: [],
      education: [],
    };
  };

  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/profiles', require('../dist/routes/profiles').default);
  app.use('/api/resumes', require('../dist/routes/resumes').default);
  app.use(publicErrorHandler);
  const server = app.listen(0);

  let counter = 0;
  /** A new ordinary account, signed in. `premium-max` has no limit on profiles; `default` keeps one. */
  const account = (label, subscription = 'premium-max') => {
    counter += 1;
    const user = users.createUser({ email: `${label}-${counter}@example.com` });
    if (subscription !== 'default') users.updateUser(user.id, { subscription });
    return { id: user.id, token: users.createSession(user.id) };
  };

  return {
    account,
    extractCalls,
    base: `http://127.0.0.1:${server.address().port}/api`,
    close: () => server.close(),
  };
}

/**
 * The frontend's client, with its requests sent to the world's routes as `who`.
 * `calls` records every request it made: method, path and query.
 */
async function asClient(w, who, fn) {
  const seen = new Map();
  const api = loadFrontend('lib/api.ts', seen);
  const realFetch = globalThis.fetch;
  const saved = {
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
    localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
  };
  const stored = new Map();
  Object.defineProperty(globalThis, 'window', { value: { location: { hostname: 'localhost' } }, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, String(value)),
      removeItem: (key) => stored.delete(key),
    },
    configurable: true,
    writable: true,
  });
  const calls = [];
  globalThis.fetch = (url, init) => {
    const parsed = new URL(String(url));
    calls.push({
      method: (init && init.method) || 'GET',
      path: parsed.pathname,
      search: parsed.search,
      params: parsed.searchParams,
    });
    return realFetch(String(url).replace(/^https?:\/\/[^/]+\/api/, w.base), init);
  };
  api.setToken(who.token);
  try {
    return await fn({ api, calls, profilesApi: api.profilesApi, resumesApi: api.resumesApi });
  } finally {
    globalThis.fetch = realFetch;
    for (const name of ['window', 'localStorage']) {
      if (saved[name]) Object.defineProperty(globalThis, name, saved[name]);
      else delete globalThis[name];
    }
  }
}

async function refusalOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return assert.fail('the server accepted it');
}

/** A resume as the editor would send it. */
const person = (name, extra = {}) => ({
  name,
  title: 'Software Engineer',
  summary: `${name} builds backend services.`,
  skills: ['Go'],
  ...extra,
});

/** `moved` may be answered as a count or as the moved ids; both read as a count here. */
const countOf = (value) => (Array.isArray(value) ? value.length : value);
const idsOf = (list) => list.map((item) => item.id);

test('profilesApi makes, reads, renames, re-defaults and lists profiles through the real routes', async () => {
  const w = await world();
  await asClient(w, w.account('lifecycle'), async ({ profilesApi, resumesApi, calls }) => {
    assert.deepEqual(await profilesApi.getAll(), [], 'a new account has no profile');
    assert.equal(calls.at(-1).method, 'GET');
    assert.equal(calls.at(-1).path, '/api/profiles');

    const jane = await profilesApi.create({ name: '  Jane   Doe ' });
    assert.equal(calls.at(-1).method, 'POST');
    assert.equal(jane.name, 'Jane Doe', 'a name is tidied');
    assert.equal(typeof jane.id, 'string');
    assert.equal(jane.resumeCount, 0);
    assert.equal(jane.enabledResumeCount, 0);
    assert.equal(jane.defaultResumeId, null);
    assert.equal(jane.chosenDefaultResumeId, null);
    for (const key of ['createdAt', 'updatedAt', 'lastEditedAt']) assert.equal(typeof jane[key], 'string', key);
    assert.equal('resumeIds' in jane, false, 'a profile lists no resumes: it counts them');

    const untitled = await profilesApi.create({});
    assert.equal(untitled.name, 'Untitled Profile');

    const first = await resumesApi.create(person('Someone Else'), { profileId: jane.id });
    assert.equal(calls.at(-1).method, 'POST');
    assert.equal(calls.at(-1).path, '/api/resumes');
    assert.equal(calls.at(-1).params.get('profileId'), jane.id, 'the profile asked for is sent');
    assert.equal(first.profileId, jane.id, 'and not the one the name would have chosen');
    const second = await resumesApi.create(person('Another Person'), { profileId: jane.id });
    assert.equal(second.profileId, jane.id);

    let current = await profilesApi.get(jane.id);
    assert.equal(calls.at(-1).path, `/api/profiles/${jane.id}`);
    assert.equal(current.resumeCount, 2);
    assert.equal(current.enabledResumeCount, 2);
    assert.equal(current.defaultResumeId, first.id, 'the first resume in is the default');
    assert.equal(current.chosenDefaultResumeId, first.id);
    assert.deepEqual(
      (await profilesApi.getAll()).find((entry) => entry.id === jane.id),
      current,
      'the list and the profile agree'
    );

    current = await profilesApi.update(jane.id, { defaultResumeId: second.id });
    assert.equal(calls.at(-1).method, 'PUT');
    assert.equal(current.defaultResumeId, second.id);
    assert.equal(current.chosenDefaultResumeId, second.id);
    current = await profilesApi.update(jane.id, { name: 'Jane D.' });
    assert.equal(current.name, 'Jane D.');
    assert.equal(current.chosenDefaultResumeId, second.id, 'renaming leaves the default alone');

    // A disabled resume cannot be the default, and disabling the default writes nothing.
    await resumesApi.update(first.id, { disabled: true });
    assert.equal((await profilesApi.get(jane.id)).enabledResumeCount, 1);
    const refused = await refusalOf(profilesApi.update(jane.id, { defaultResumeId: first.id }));
    assert.equal(refused.status, 409);
    assert.equal(refused.code, 'default-disabled');

    assert.deepEqual(idsOf(await profilesApi.getAll()).sort(), [jane.id, untitled.id].sort());
  });
});

test('resumesApi serves every resume with its profile and keywords, and lists the disabled ones only when asked', async () => {
  const w = await world();
  await asClient(w, w.account('serving'), async ({ profilesApi, resumesApi, calls }) => {
    const home = await profilesApi.create({ name: 'Home' });
    const kept = await resumesApi.create(person('Kept One'), { profileId: home.id });
    const hidden = await resumesApi.create(person('Hidden One'), { profileId: home.id });
    await resumesApi.update(hidden.id, { disabled: true });

    const enabled = await resumesApi.getAll();
    assert.equal(calls.at(-1).params.has('includeDisabled'), false);
    assert.deepEqual(idsOf(enabled), [kept.id]);

    const everyone = await resumesApi.getAll({ includeDisabled: true });
    assert.equal(calls.at(-1).params.get('includeDisabled'), 'true');
    assert.deepEqual(idsOf(everyone).sort(), [hidden.id, kept.id].sort());

    for (const served of [...everyone, await resumesApi.getById(kept.id)]) {
      assert.equal(served.profileId, home.id, 'every resume carries its profile');
      assert.ok(served.matchKeywords && Array.isArray(served.matchKeywords.terms), 'and its derived keywords');
      assert.equal(typeof served.matchKeywords.version, 'number');
    }
    assert.ok((await resumesApi.getById(kept.id)).matchKeywords.terms.includes('Go'), 'what the resume lists is among its keywords');
    assert.equal(calls.at(-1).path, `/api/resumes/${kept.id}`);
  });
});

test('profilesApi.move takes resumes into a profile and answers how many moved and the profiles it touched', async () => {
  const w = await world();
  await asClient(w, w.account('mover'), async ({ profilesApi, resumesApi, calls }) => {
    const from = await profilesApi.create({ name: 'From' });
    const to = await profilesApi.create({ name: 'To' });
    const a = await resumesApi.create(person('Mover A'), { profileId: from.id });
    const b = await resumesApi.create(person('Mover B'), { profileId: from.id });

    const answer = await profilesApi.move(to.id, [a.id]);
    assert.equal(calls.at(-1).method, 'POST');
    assert.equal(calls.at(-1).path, `/api/profiles/${to.id}/move`);
    assert.equal(countOf(answer.moved), 1);
    assert.ok(Array.isArray(answer.profiles));
    const byId = Object.fromEntries(answer.profiles.map((entry) => [entry.id, entry]));
    assert.equal(byId[to.id].resumeCount, 1, 'the target, counted after the move');
    assert.equal(byId[from.id].resumeCount, 1, 'and the profile it came from');
    assert.equal(byId[to.id].defaultResumeId, a.id, 'the target had none, so it takes the one that arrived');
    assert.equal(byId[from.id].defaultResumeId, b.id, 'the profile it left re-points its default');
    assert.equal((await resumesApi.getById(a.id)).profileId, to.id, "a resume's address survives a Move");

    // All or nothing, and an empty list is refused.
    const nothing = await refusalOf(profilesApi.move(to.id, []));
    assert.equal(nothing.status, 400);
    assert.equal(nothing.code, 'nothing-to-move');
    const missing = await refusalOf(profilesApi.move(to.id, [b.id, 'no-such-resume']));
    assert.equal(missing.status, 404);
    assert.equal(missing.code, 'resume-not-found');
    assert.equal((await resumesApi.getById(b.id)).profileId, from.id, 'none moved');

    // A profile can be made with resumes already in it.
    const made = await profilesApi.create({ name: 'Made With', resumeIds: [b.id] });
    assert.equal(made.resumeCount, 1);
    assert.equal((await resumesApi.getById(b.id)).profileId, made.id);
  });
});

test('profilesApi.delete deletes the profile and every resume in it, and answers { deleted, deletedResumes }', async () => {
  const w = await world();
  await asClient(w, w.account('deleter'), async ({ profilesApi, resumesApi, calls }) => {
    const doomed = await profilesApi.create({ name: 'Doomed' });
    const spared = await profilesApi.create({ name: 'Spared' });
    const one = await resumesApi.create(person('Doomed One'), { profileId: doomed.id });
    const two = await resumesApi.create(person('Doomed Two'), { profileId: doomed.id });
    const safe = await resumesApi.create(person('Safe One'), { profileId: spared.id });

    const answer = await profilesApi.delete(doomed.id);
    assert.equal(calls.at(-1).method, 'DELETE');
    assert.equal(calls.at(-1).path, `/api/profiles/${doomed.id}`);
    assert.deepEqual(answer, { deleted: true, deletedResumes: 2 });

    for (const gone of [one.id, two.id]) {
      const error = await refusalOf(resumesApi.getById(gone));
      assert.equal(error.status, 404, 'the resumes went with the profile');
    }
    assert.deepEqual(idsOf(await resumesApi.getAll({ includeDisabled: true })), [safe.id]);
    assert.deepEqual(idsOf(await profilesApi.getAll()), [spared.id]);

    const again = await refusalOf(profilesApi.delete(doomed.id));
    assert.equal(again.status, 404);
    assert.equal(again.code, 'profile-not-found');

    // A profile with nothing in it deletes too, and says so.
    const empty = await profilesApi.create({ name: 'Empty' });
    assert.deepEqual(await profilesApi.delete(empty.id), { deleted: true, deletedResumes: 0 });
  });
});

test("the clients' refusals reach a page as the server made them: unknown profiles, other people's, bad names", async () => {
  const w = await world();
  const owner = w.account('owner');
  const stranger = w.account('stranger');
  let ownerProfile;
  await asClient(w, owner, async ({ profilesApi }) => {
    ownerProfile = await profilesApi.create({ name: 'Private' });
  });

  await asClient(w, stranger, async ({ api, profilesApi, resumesApi }) => {
    // Thunks, so that no request is in flight (and refused unobserved) before it is awaited.
    for (const attempt of [
      () => profilesApi.get('no-such-profile'),
      () => profilesApi.get(ownerProfile.id),
      () => profilesApi.update(ownerProfile.id, { name: 'Mine now' }),
      () => profilesApi.delete(ownerProfile.id),
    ]) {
      const error = await refusalOf(attempt());
      assert.ok(error instanceof api.ApiResponseError);
      assert.equal(error.status, 404);
      assert.equal(error.code, 'profile-not-found');
    }
    // A resume cannot be filed under somebody else's profile.
    const foreign = await refusalOf(resumesApi.create(person('Sneaky'), { profileId: ownerProfile.id }));
    assert.equal(foreign.status, 404);
    assert.equal(foreign.code, 'profile-not-found');
    assert.deepEqual(await resumesApi.getAll({ includeDisabled: true }), [], 'nothing was written');

    const long = await refusalOf(profilesApi.create({ name: 'x'.repeat(101) }));
    assert.equal(long.status, 400);
    assert.equal(long.code, 'profile-name-too-long');
    const blank = await profilesApi.create({ name: 'Fine' });
    const unnamed = await refusalOf(profilesApi.update(blank.id, { name: '   ' }));
    assert.equal(unnamed.status, 400);
    assert.equal(unnamed.code, 'profile-name-required');
    const nothing = await refusalOf(profilesApi.update(blank.id, {}));
    assert.equal(nothing.status, 400);
    assert.equal(nothing.code, 'nothing-to-change');
  });
  await asClient(w, owner, async ({ profilesApi }) => {
    assert.equal((await profilesApi.get(ownerProfile.id)).name, 'Private', 'untouched');
  });
});

test('a Default account keeps one profile: the limit is on people, and the client says so through isProfileLimit', async () => {
  const w = await world();
  await asClient(w, w.account('limited', 'default'), async ({ api, profilesApi, resumesApi }) => {
    const only = await profilesApi.create({ name: 'Only One' });

    const second = await refusalOf(profilesApi.create({ name: 'A Second' }));
    assert.equal(api.isProfileLimit(second), true);
    assert.equal(second.status, 402);
    assert.equal(second.code, 'profile-limit');

    // Resumes are never counted: more of the same person, and of anybody added to a profile it already has.
    const a = await resumesApi.create(person('Only One'), { profileId: only.id });
    const b = await resumesApi.create(person('Somebody Else'), { profileId: only.id });
    const c = await resumesApi.create(person('Only One', { title: 'Staff Engineer' }));
    assert.equal(a.profileId, only.id);
    assert.equal(b.profileId, only.id);
    assert.equal(c.profileId, only.id, 'filed by the person it names');

    // A resume for a person with no profile is a new profile, and that is refused.
    const stranger = await refusalOf(resumesApi.create(person('Brand New Person')));
    assert.equal(api.isProfileLimit(stranger), true);

    // An import that would make two profiles writes nothing at all.
    const two = { resumes: [person('Ann One'), person('Bob Two')] };
    const refused = await refusalOf(resumesApi.importJson(two));
    assert.equal(api.isProfileLimit(refused), true);
    assert.equal((await resumesApi.getAll({ includeDisabled: true })).length, 3);

    // The same file into the profile it has is fine.
    const into = await resumesApi.importJson(two, { profileId: only.id });
    assert.equal(into.imported, 2);
    assert.equal((await resumesApi.getAll({ includeDisabled: true })).length, 5);
    assert.equal((await profilesApi.getAll()).length, 1);
  });
});

test('resumesApi.importJson sends ?profileId= when given, and answers the profiles it filed under or made', async () => {
  const w = await world();
  await asClient(w, w.account('importer'), async ({ profilesApi, resumesApi, calls }) => {
    const target = await profilesApi.create({ name: 'Target' });
    const file = { resumes: [person('Ann One'), person('Bob Two')] };

    const into = await resumesApi.importJson(file, { profileId: target.id });
    assert.equal(calls.at(-1).method, 'POST');
    assert.equal(calls.at(-1).path, '/api/resumes/import');
    assert.equal(calls.at(-1).params.get('profileId'), target.id);
    assert.equal(into.imported, 2);
    assert.deepEqual(into.profileIds, [target.id]);
    assert.deepEqual(into.createdProfiles, []);
    for (const entry of into.resumes) assert.equal(entry.profileId, target.id);

    const bare = await resumesApi.importJson({ resumes: [person('Cy Three'), person('Di Four'), person('Cy Three', { title: 'Lead' })] });
    assert.equal(calls.at(-1).search, '', 'without a profile there is no query');
    assert.equal(bare.imported, 3);
    assert.equal(bare.profileIds.length, 2, 'two people, two profiles');
    assert.deepEqual(bare.createdProfiles.map((made) => made.name).sort(), ['Cy Three', 'Di Four']);
    assert.deepEqual(idsOf(bare.createdProfiles).sort(), [...bare.profileIds].sort());
    for (const made of bare.createdProfiles) assert.equal(typeof made.id, 'string');
    assert.equal((await profilesApi.getAll()).length, 3);

    const notMine = await refusalOf(resumesApi.importJson(file, { profileId: 'no-such-profile' }));
    assert.equal(notMine.status, 404);
    assert.equal(notMine.code, 'profile-not-found');
  });
});

test('resumesApi.uploadPdf sends ?profileId= when given, and a profile that is not the account\'s is refused before the model is asked', async () => {
  const w = await world();
  const pdf = () => new File([Buffer.from('%PDF-1.4 a resume')], 'resume.pdf', { type: 'application/pdf' });
  const stranger = w.account('pdf-stranger');
  let theirs;
  await asClient(w, stranger, async ({ profilesApi }) => {
    theirs = await profilesApi.create({ name: 'Theirs' });
  });

  await asClient(w, w.account('pdf-owner'), async ({ profilesApi, resumesApi, calls }) => {
    const target = await profilesApi.create({ name: 'Upload Target' });
    const before = w.extractCalls.length;

    const filed = await resumesApi.uploadPdf(pdf(), { profileId: target.id });
    assert.equal(calls.at(-1).method, 'POST');
    assert.equal(calls.at(-1).path, '/api/resumes/upload');
    assert.equal(calls.at(-1).params.get('profileId'), target.id);
    assert.equal(w.extractCalls.length, before + 1);
    assert.equal(filed.profileId, target.id, 'filed where it was sent, not by the name it was read with');
    assert.equal(filed.name, 'Uploaded Person');

    const foreign = await refusalOf(resumesApi.uploadPdf(pdf(), { profileId: theirs.id }));
    assert.equal(foreign.status, 404);
    assert.equal(foreign.code, 'profile-not-found');
    assert.equal(w.extractCalls.length, before + 1, 'no model was asked for a profile that is not theirs');

    const bare = await resumesApi.uploadPdf(pdf());
    assert.equal(calls.at(-1).search, '', 'without a profile there is no query');
    assert.notEqual(bare.profileId, target.id, 'filed by the person it names');
    assert.equal((await profilesApi.get(bare.profileId)).name, 'Uploaded Person');
  });
});

test('a duplicate made from a resume goes to its profile on the same template, enabled and as a new resume', async () => {
  const w = await world();
  const { duplicateResumeBody } = gallery();
  await asClient(w, w.account('duplicator'), async ({ profilesApi, resumesApi }) => {
    const home = await profilesApi.create({ name: 'Home' });
    const original = await resumesApi.create(person('Original Person', { preferredTemplate: 'navy-rule' }), { profileId: home.id });
    assert.equal(original.preferredTemplate, 'navy-rule');
    const served = await resumesApi.getById(original.id);

    const copy = await resumesApi.create(duplicateResumeBody(served, {}), { profileId: served.profileId });
    assert.notEqual(copy.id, original.id);
    assert.equal(copy.profileId, home.id);
    assert.equal(copy.preferredTemplate, 'navy-rule', 'Duplicate keeps the template');
    assert.equal(copy.disabled, false);
    assert.equal(copy.name, original.name);
    assert.equal((await profilesApi.get(home.id)).resumeCount, 2);
    assert.equal((await profilesApi.get(home.id)).defaultResumeId, original.id, 'the copy does not take the default');
  });
});

/* ================================================================== the pages, and the text pins */

test('the pages of the profiles desk exist', () => {
  for (const page of [
    ['app', 'admin', 'profiles', 'page.tsx'],
    ['app', 'admin', 'profiles', '[profileId]', 'page.tsx'],
    ['app', 'admin', 'resumes', 'new', 'page.tsx'],
    ['app', 'admin', 'resumes', '[id]', 'page.tsx'],
  ]) {
    assert.ok(fs.existsSync(path.join(SRC, ...page)), page.join('/'));
  }
  assert.equal(fs.existsSync(path.join(SRC, 'app', 'admin', 'resumes', 'page.tsx')), false, '/admin/resumes has no index of its own');
});

test('the dashboard has Profiles and All resumes as tabs, a Grid / List switch with pressed states, and a search that can be searched', () => {
  // The dashboard's page, its components, and the resume cards (owned with them, in components/resume).
  const source =
    sourcesUnder('app/admin/profiles/page.tsx') +
    '\n' +
    sourcesUnder('components/profiles') +
    '\n' +
    sourcesUnder('components/resume/ResumeCards.tsx');
  assert.match(source, /role="tablist"/, 'the two tabs are a tablist');
  assert.match(source, /role="tab"/, 'and each is a tab');
  assert.match(source, /aria-selected/);
  assert.match(source, /aria-pressed/, 'the view switch says which view is pressed');
  assert.match(source, /role="group"/);
  assert.match(source, /aria-label="View"/);
  assert.match(source, /type="search"/, 'a search box per tab');
  assert.match(source, /role="status"/, "and its status line");
  assert.match(source, /data-new-tile/, 'a New tile');
  for (const hook of ['data-profile-card', 'data-profile-row', 'data-resume-card', 'data-resume-row', 'data-default-resume']) {
    assert.ok(source.includes(hook), `${hook} is a stable hook for the browser scripts`);
  }
  assert.match(source, /more-profiles/, 'the New profile tile is the one lock');
  assert.match(source, /scroll:\s*false/, 'a tab changes the address without scrolling the page');
  assert.match(source, /VIEW_MODE_KEY|freeTailor\.profiles\.view/);
  assert.match(source, /deleteProfileWording/, 'the warning is the one wording');

  const menus = sourcesUnder('components/resume/ActionMenu.tsx');
  assert.match(menus, /role="menu"/);
  assert.match(menus, /role="menuitem"/);
});

test('everything that reads the address is inside a Suspense boundary, on the dashboard and on the new-resume page', () => {
  for (const [label, source] of [
    ['the dashboard', sourcesUnder('app/admin/profiles/page.tsx') + '\n' + sourcesUnder('components/profiles')],
    ['a profile\'s page', sourcesUnder('app/admin/profiles/[profileId]/page.tsx')],
    ['the new-resume page', sourcesUnder('app/admin/resumes/new/page.tsx')],
  ]) {
    if (!/useSearchParams/.test(source)) continue;
    assert.match(source, /<Suspense[\s>]/, `${label} reads useSearchParams, so it renders inside <Suspense>`);
  }
  // The two that are known to read it.
  assert.match(sourcesUnder('app/admin/profiles/page.tsx') + sourcesUnder('components/profiles'), /useSearchParams/, '?tab= is read');
  assert.match(sourcesUnder('app/admin/resumes/new/page.tsx'), /useSearchParams/, '?template= and ?profile= are read');
  assert.match(sourcesUnder('app/admin/resumes/new/page.tsx'), /<Suspense[\s>]/);
});

test("the editor never sends the person to the bare list: it goes back to the resume's profile", () => {
  const editor = withoutComments(sourcesUnder('components/resume/ResumeEditor.tsx'));
  assert.ok(editor.length > 0, 'the editor is read');
  assert.doesNotMatch(editor, /router\.(?:push|replace)\(\s*['"`]\/admin\/profiles['"`]\s*[,)]/, "no router.push('/admin/profiles') in the editor");
  assert.doesNotMatch(editor, /templatesUsedByOthers/);

  // It finds its way through a profile, which it loads from the server.
  const loader = editor + '\n' + withoutComments(sourcesUnder('app/admin/resumes/[id]/page.tsx')) + '\n' + withoutComments(sourcesUnder('app/admin/resumes/new/page.tsx'));
  assert.match(loader, /profilesApi\.get\(/, 'the editor loads the profile the resume is filed under');
  assert.match(loader, /profilePageHref|\/admin\/profiles\//, "and goes back to that profile's page");
});

test("a profile's page hands an old resume bookmark to the editor, and says so when it is neither", () => {
  const page = sourcesUnder('app/admin/profiles/[profileId]/page.tsx');
  assert.match(page, /resumesApi\.getById\(/, 'an id that is no profile is asked of the resumes');
  assert.match(page, /router\.replace\(/, 'and replaced, not pushed, so Back does not loop');
  assert.match(page, /\/admin\/resumes\//, 'to the editor');
  assert.match(page, /That profile was not found\. It may have been deleted\./);
  assert.match(page, /deleteProfileWording|DeleteProfileDialog/, 'Delete profile warns about the resumes');
  assert.match(page, /profilesApi\./);
});

test('no resume is limited to a template another resume has not used: the template rule is gone from the sources', () => {
  const everywhere = walk(SRC, ['.ts', '.tsx', '.js', '.jsx']);
  for (const file of everywhere) {
    const text = fs.readFileSync(file, 'utf8');
    const relative = path.relative(SRC, file).split(path.sep).join('/');
    for (const retired of [/templatesUsedByOthers/, /\bTemplateOption\b/, /\bevery(?:One)?Used\b/, /\bEveryOneUsed\b/, /\btemplateOptions\b/, /\busedBy\b/]) {
      assert.doesNotMatch(text, retired, `${relative} still names ${retired.source}`);
    }
  }

  // The words a person read: "(used by X)", "Used by X", and the sentence about every template being used.
  const resumeDesk = [
    ...walk(path.join(SRC, 'components', 'resume')),
    ...walk(path.join(SRC, 'app', 'admin', 'resumes')),
    ...walk(path.join(SRC, 'app', 'admin', 'profiles')),
    ...(fs.existsSync(path.join(SRC, 'components', 'profiles')) ? walk(path.join(SRC, 'components', 'profiles')) : []),
    ...['resumeDraft.ts', 'resumeGallery.ts', 'resumeModelChoice.ts', 'profileDashboard.ts']
      .map((name) => path.join(SRC, 'lib', name))
      .filter((file) => fs.existsSync(file)),
  ];
  assert.ok(resumeDesk.length > 5, 'the resume desk is found');
  for (const file of resumeDesk) {
    const relative = path.relative(SRC, file).split(path.sep).join('/');
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /\bused by\b/i, `${relative} says "used by"`);
  }
});

test('the files that show or build a price do not floor, truncate or float-parse it', () => {
  for (const relative of ['lib/buildModes.ts', 'components/builder/BuildModeChoice.tsx']) {
    const file = path.join(SRC, relative);
    assert.ok(fs.existsSync(file), `${relative} is one of the files that show or build a price, and is gone`);
    const code = withoutComments(fs.readFileSync(file, 'utf8'));
    for (const banned of [/Math\.floor\s*\(/, /Math\.trunc\s*\(/, /parseFloat\s*\(/, /parseInt\s*\(/, /Number\.isInteger\s*\(/, /\.toFixed\s*\(/]) {
      assert.doesNotMatch(code, banned, `${relative} uses ${banned.source}`);
    }
  }
});

test('the admin layout asks the dashboard\'s own route test for the resume desk, and does not keep a copy of the pattern', () => {
  const layout = withoutComments(read('app', 'admin', 'layout.tsx'));
  assert.match(layout, /isProfilesDeskRoute/);
  assert.doesNotMatch(layout, /profiles\|resumes|\(\?:profiles/, 'no second regular expression of the desk');
});
