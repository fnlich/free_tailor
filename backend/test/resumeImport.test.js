const assert = require('node:assert/strict');
const test = require('node:test');

const { useTempStorage } = require('./helpers');

/**
 * Importing resumes from an uploaded JSON file.
 *
 * The thing under test is the GATE. resumeDocument normalizes whatever it is
 * handed and never throws, which is right for the admin form and wrong for a
 * file someone picked out of a downloads folder: without a gate, a package.json
 * becomes a resume. So most of what follows is about what gets refused, and
 * about ids - an import must never overwrite a resume that is already here.
 */

const {
  buildImportedResumes,
  readResumeImportDocument,
  ResumeImportError,
  MAX_RESUMES_PER_IMPORT,
} = require('../dist/services/resumeImport');

/** A resume as `GET /api/resumes/:id` hands it out. */
function exportedResume(overrides = {}) {
  return {
    id: 'resume-alice',
    name: 'Alice Nguyen',
    title: 'Staff Engineer',
    contact: { phone: '555-0100', email: 'alice@example.com', location: 'Remote' },
    summary: 'Builds things.',
    experience: [
      {
        title: 'Staff Engineer',
        company: 'Acme',
        startDate: '01/2022',
        endDate: 'Present',
        location: 'Remote',
        description: 'Led the platform team.',
        achievements: ['Cut deploy time in half.'],
        skills: ['TypeScript'],
      },
    ],
    strengths: [],
    skills: ['TypeScript', 'SQL'],
    education: [],
    certifications: [],
    createdAt: '2025-03-04T10:00:00.000Z',
    updatedAt: '2025-03-04T10:00:00.000Z',
    ...overrides,
  };
}

/** Ids nothing has claimed, and a counter so each minted one is distinct. */
function emptyStore() {
  let next = 0;
  return { idExists: () => false, newId: () => `generated-${++next}` };
}

test('the three shapes a resume file actually comes in are all accepted', () => {
  const one = exportedResume();
  const two = exportedResume({ id: 'resume-bo', name: 'Bo Chen' });

  // A single resume, as exported from the API.
  assert.deepEqual(readResumeImportDocument(one), [one]);
  // A bare list of them.
  assert.deepEqual(readResumeImportDocument([one, two]), [one, two]);
  // And the wrapper an export of several would have.
  assert.deepEqual(readResumeImportDocument({ resumes: [one, two] }), [one, two]);
});

/**
 * A resume file exported by v4.1, when the record was still called a profile
 * (owner decision D9). Its wrapper is `{ "profiles": [ ... ] }` and a record
 * keeps its settings under `profileSettings`, where this build writes
 * `{ "resumes": [ ... ] }` and `resumeSettings`. The import is the one place
 * that still reads the old spelling, so a backup taken before the rename
 * restores; this test and glossaryRename.test.js are the only others that may
 * name it.
 */
const V41_SETTINGS = {
  technicalSkillsLayout: 'flat',
  includeSoftSkills: true,
  includeStrengths: true,
  tailorMode: 'full',
  resumePromptId: 'tailor-resume-mine',
};

/** A resume record as v4.1 exported it: `profileSettings`, and no `resumeSettings`. */
function v41Resume(overrides = {}) {
  return { ...exportedResume(), profileSettings: V41_SETTINGS, ...overrides };
}

test('a v4.1 export is still read: a record, a list, and the wrappers profiles, items and data', () => {
  const one = v41Resume();
  const two = v41Resume({ id: 'resume-bo', name: 'Bo Chen' });
  const ids = (entries) => entries.map((entry) => entry.id);

  assert.deepEqual(ids(readResumeImportDocument(one)), ['resume-alice']);
  assert.deepEqual(ids(readResumeImportDocument([one, two])), ['resume-alice', 'resume-bo']);
  for (const wrapper of ['profiles', 'items', 'data']) {
    assert.deepEqual(
      ids(readResumeImportDocument({ [wrapper]: [one, two] })),
      ['resume-alice', 'resume-bo'],
      `{ "${wrapper}": [ ... ] }`
    );
  }

  // This build's own wrapper is read first when a file carries both.
  assert.deepEqual(ids(readResumeImportDocument({ resumes: [two], profiles: [one] })), ['resume-bo']);

  // The sentence for a file that is neither names the wrapper this build writes.
  assert.throws(
    () => readResumeImportDocument('nope'),
    (error) =>
      error instanceof ResumeImportError &&
      error.message.includes('{ "resumes": [ ... ] }') &&
      !error.message.includes('"profiles"')
  );
});

test("a v4.1 record's profileSettings arrive as resumeSettings, equal to what they held", () => {
  const [{ resume }] = buildImportedResumes({ profiles: [v41Resume()] }, emptyStore());

  assert.equal(resume.id, 'resume-alice');
  assert.equal(resume.name, 'Alice Nguyen');
  assert.deepEqual(resume.experience.map((role) => role.company), ['Acme']);

  // They are the file's settings, not the defaults a record with neither key gets.
  assert.equal(resume.resumeSettings.technicalSkillsLayout, 'flat');
  assert.equal(resume.resumeSettings.includeSoftSkills, true);
  assert.equal(resume.resumeSettings.includeStrengths, true);
  // F2 retired the per-resume Partial/Fully setting (the mode is the run's): a v4.1 file's
  // `tailorMode` is read past, never carried over.
  assert.equal('tailorMode' in resume.resumeSettings, false);
  assert.equal(resume.resumeSettings.resumePromptId, 'tailor-resume-mine');

  // The same settings sent under this build's own key import to exactly the
  // same thing: the alias lost nothing and added nothing.
  const [{ resume: current }] = buildImportedResumes(
    { resumes: [exportedResume({ resumeSettings: V41_SETTINGS })] },
    emptyStore()
  );
  assert.deepEqual(resume.resumeSettings, current.resumeSettings);

  // And the old key does not come out the other side, at any depth.
  assert.equal('profileSettings' in resume, false);
  assert.equal(JSON.stringify(resume).includes('profileSettings'), false);
});

test('every v4.1 shape imports whole, each record keeping its own settings', () => {
  const one = v41Resume();
  const two = v41Resume({
    id: 'resume-bo',
    name: 'Bo Chen',
    profileSettings: { technicalSkillsLayout: 'categorized', includeSoftSkills: false, includeStrengths: true },
  });
  const documents = {
    'a bare list': [one, two],
    '{ "profiles": [ ... ] }': { profiles: [one, two] },
    '{ "items": [ ... ] }': { items: [one, two] },
    '{ "data": [ ... ] }': { data: [one, two] },
  };

  for (const [shape, document] of Object.entries(documents)) {
    const imported = buildImportedResumes(document, emptyStore());
    assert.deepEqual(imported.map((entry) => entry.resume.name), ['Alice Nguyen', 'Bo Chen'], shape);
    assert.deepEqual(
      imported.map((entry) => entry.resume.resumeSettings.technicalSkillsLayout),
      ['flat', 'categorized'],
      shape
    );
    assert.deepEqual(
      imported.map((entry) => entry.resume.resumeSettings.includeSoftSkills),
      [true, false],
      shape
    );
    assert.equal(
      imported.some((entry) => 'profileSettings' in entry.resume),
      false,
      shape
    );
  }

  // A single record, with neither wrapper.
  const [{ resume }] = buildImportedResumes(two, emptyStore());
  assert.equal(resume.resumeSettings.technicalSkillsLayout, 'categorized');
  assert.equal(resume.resumeSettings.includeStrengths, true);
});

test('either settings key is enough to read as a resume, and a name alone is still not', () => {
  const opts = { idExists: () => false, newId: () => 'gen' };
  const only = (document) => buildImportedResumes(document, opts)[0].resume;

  assert.equal(only({ name: 'A', profileSettings: { includeStrengths: true } }).resumeSettings.includeStrengths, true);
  assert.equal(only({ name: 'A', resumeSettings: { includeStrengths: true } }).resumeSettings.includeStrengths, true);
  assert.throws(() => buildImportedResumes({ name: 'my-app', version: '1.0.0' }, opts), /none of the fields a resume is made of/);

  // A file somehow naming both is read by this build's own key.
  const both = only({
    name: 'A',
    resumeSettings: { technicalSkillsLayout: 'flat' },
    profileSettings: { technicalSkillsLayout: 'categorized' },
  });
  assert.equal(both.resumeSettings.technicalSkillsLayout, 'flat');
  assert.equal('profileSettings' in both, false);
});

test('a file that is not a resume is refused, and says which entry', () => {
  const store = emptyStore();
  const reject = (document, pattern) =>
    assert.throws(() => buildImportedResumes(document, store), pattern);

  reject('just a string', /not a resume/i);
  reject(42, /not a resume/i);
  reject(null, /not a resume/i);
  reject([], /no resumes in it/i);
  reject({ resumes: [] }, /no resumes in it/i);
  reject([exportedResume(), 'nope'], /Resume 2 of 2 is not a JSON object/);

  // The case the gate exists for: a JSON file with a name and nothing else.
  // Without it this saves cleanly as an empty resume called "my-app".
  reject(
    { name: 'my-app', version: '1.0.0', dependencies: {} },
    /none of the fields a resume is made of/i
  );

  // And a resume-shaped object with no name, which would otherwise import as
  // "Untitled Profile" - valid, saved, and useless.
  reject({ title: 'Staff Engineer', summary: 'Builds things.' }, /has no "name"/);
});

test('nothing is imported when one entry in the middle is bad', () => {
  const store = emptyStore();
  assert.throws(
    () =>
      buildImportedResumes(
        [exportedResume(), { name: 'no fields' }, exportedResume({ id: 'resume-bo', name: 'Bo' })],
        store
      ),
    /Resume 2 of 3/
  );
});

test('a free id is kept and a taken one is replaced, never overwritten', () => {
  let next = 0;
  const taken = new Set(['resume-alice']);
  const store = { idExists: (id) => taken.has(id), newId: () => `generated-${++next}` };

  // Restoring into an install that already has this resume makes a copy. The
  // promise is that an import cannot destroy a resume you already had.
  const [copy] = buildImportedResumes(exportedResume(), store);
  assert.equal(copy.keptId, false);
  assert.equal(copy.resume.id, 'generated-1');
  assert.equal(copy.resume.name, 'Alice Nguyen');

  // Restoring into an install that does not have it keeps the id, so the
  // profiles that list this resume still resolve.
  const [restored] = buildImportedResumes(exportedResume({ id: 'resume-bo' }), store);
  assert.equal(restored.keptId, true);
  assert.equal(restored.resume.id, 'resume-bo');
});

test('a file naming the same id twice does not collapse into one resume', () => {
  const store = emptyStore();
  const imported = buildImportedResumes(
    [exportedResume({ name: 'First' }), exportedResume({ name: 'Second' })],
    store
  );

  assert.equal(imported.length, 2);
  assert.notEqual(imported[0].resume.id, imported[1].resume.id, 'the second entry gets an id of its own');
  assert.deepEqual(imported.map((entry) => entry.resume.name), ['First', 'Second']);
});

test('the resume content survives the round trip', () => {
  const source = exportedResume();
  const [{ resume }] = buildImportedResumes(source, emptyStore());

  assert.equal(resume.title, 'Staff Engineer');
  assert.equal(resume.contact.email, 'alice@example.com');
  assert.equal(resume.summary, 'Builds things.');
  assert.deepEqual(resume.skills, ['TypeScript', 'SQL']);
  assert.equal(resume.experience.length, 1);
  assert.deepEqual(resume.experience[0].achievements, ['Cut deploy time in half.']);

  // The resume's own history is a fact about the resume and survives;
  // updatedAt does not, because this row was written just now.
  assert.equal(resume.createdAt, '2025-03-04T10:00:00.000Z');
  assert.notEqual(resume.updatedAt, '2025-03-04T10:00:00.000Z');

  // Settings a file omits come back as the defaults rather than as undefined,
  // so an imported resume is usable without being opened and saved first.
  assert.equal(resume.resumeSettings.resumePromptId, 'tailor-resume');
  assert.equal(resume.resumeSettings.technicalSkillsLayout, 'categorized');
  // The skill ordering is gone: the tailored block prints in the model's order.
  assert.equal('hardSkillOrdering' in resume.resumeSettings, false);
});

test('a nonsense createdAt is ignored rather than stored', () => {
  const [{ resume }] = buildImportedResumes(
    exportedResume({ createdAt: 'last Tuesday' }),
    emptyStore()
  );
  assert.ok(!Number.isNaN(Date.parse(resume.createdAt)));
});

test('an oversized file is refused before anything is built', () => {
  const many = Array.from({ length: MAX_RESUMES_PER_IMPORT + 1 }, (_, index) =>
    exportedResume({ id: `resume-${index}`, name: `Person ${index}` })
  );
  assert.throws(() => buildImportedResumes(many, emptyStore()), /is the most one import may carry/);
});

test('the error type is the one the route maps to a 400', () => {
  assert.throws(() => buildImportedResumes('nope', emptyStore()), ResumeImportError);
});

test('an import lands in the database whole, or not at all', () => {
  useTempStorage('resume-import-store');
  const repository = require('../dist/database/resumeRepository');

  const saved = repository.saveResumes(
    buildImportedResumes(
      [exportedResume(), exportedResume({ id: 'resume-bo', name: 'Bo Chen' })],
      { idExists: repository.hasResume, newId: () => `generated-${Math.random()}` }
    ).map((entry) => entry.resume)
  );

  assert.equal(saved.length, 2);
  const stored = repository.listResumes({ includeDisabled: true });
  assert.deepEqual(stored.map((resume) => resume.name).sort(), ['Alice Nguyen', 'Bo Chen']);

  // A batch that cannot be written leaves the table exactly as it was. The
  // second row is made unserializable to force the failure - a synthetic
  // cause, but the path it takes is the real one: a save throws partway
  // through the batch, and the rows before it must not survive.
  const unserializable = exportedResume({ id: 'resume-dee', name: 'Dee' });
  unserializable.self = unserializable;

  assert.throws(() =>
    repository.saveResumes([exportedResume({ id: 'resume-cy', name: 'Cy' }), unserializable])
  );
  assert.equal(repository.listResumes({ includeDisabled: true }).length, 2, 'the failed batch wrote nothing');
  assert.equal(repository.hasResume('resume-cy'), false, 'the row before the failure was rolled back');
});

test('an uploaded resume may group its skills, or not, or both', () => {
  // The point of the upload is to save hand-editing a file. Accepting only one
  // of these shapes would mean rewriting the other three by hand first.
  const opts = { idExists: () => false, newId: () => 'gen' };
  const only = (document) => buildImportedResumes(document, opts)[0].resume;

  const flat = only({ name: 'A', skills: ['C#', 'Python'] });
  assert.deepEqual(flat.skills, ['C#', 'Python']);
  assert.equal(flat.skillCategories, undefined);

  const map = only({ name: 'A', skills: { Languages: ['C#'], Cloud: ['Vault'] } });
  assert.deepEqual(map.skills, ['C#', 'Vault']);
  assert.deepEqual(map.skillCategories, [
    { category: 'Languages', skills: ['C#'] },
    { category: 'Cloud', skills: ['Vault'] },
  ]);

  const grouped = only({ name: 'A', skills: [{ category: 'Languages', skills: ['C#'] }] });
  assert.deepEqual(grouped.skillCategories, [{ category: 'Languages', skills: ['C#'] }]);

  // A file whose ONLY skills field is the grouped one still has to read as a
  // resume - the probe list decides that, and it had never heard of this field.
  const separate = only({ name: 'A', skillCategories: [{ category: 'Languages', skills: ['C#'] }] });
  assert.deepEqual(separate.skills, ['C#']);
  assert.deepEqual(separate.skillCategories, [{ category: 'Languages', skills: ['C#'] }]);
});

test('a resume file still has to be a resume', () => {
  // Adding a field to the probe list must not turn the gate off: a package.json
  // has a name and nothing else, and became an empty resume called "my-app".
  assert.throws(
    () =>
      buildImportedResumes(
        { name: 'my-app', version: '1.0.0', dependencies: {} },
        { idExists: () => false, newId: () => 'gen' }
      ),
    /none of the fields a resume is made of/
  );
});
