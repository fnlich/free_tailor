const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildImportedTemplates,
  inferTemplateSections,
  normalizeManualConfig,
  readTemplateImportDocument,
  TemplateImportError,
  MAX_TEMPLATES_PER_IMPORT,
} = require('../dist/services/templateImport');

const TEMPLATES_DIR = path.join(__dirname, '..', 'static', 'templates');

const HTML =
  '<div>{{#if summary}}{{summary}}{{/if}}{{#each experience}}{{title}}{{/each}}' +
  '{{#each skillCategories}}{{category}}{{/each}}{{#each education}}{{degree}}{{/each}}</div>'.padEnd(
    150,
    ' '
  );

function importIt(document, overrides = {}) {
  let next = 0;
  return buildImportedTemplates(document, {
    idExists: () => false,
    newId: () => `gen-${++next}`,
    ...overrides,
  });
}

test('a file may hold one template, a list, or a wrapper', () => {
  // The list is what an export of a whole set produces, and what this refused
  // outright - so the button that saves your templates made a file the button
  // that loads them would not take.
  assert.equal(readTemplateImportDocument({ name: 'A' }).length, 1);
  assert.equal(readTemplateImportDocument([{ name: 'A' }, { name: 'B' }]).length, 2);
  assert.equal(readTemplateImportDocument({ templates: [{ name: 'A' }] }).length, 1);
  assert.equal(readTemplateImportDocument({ items: [{ name: 'A' }] }).length, 1);
  assert.throws(() => readTemplateImportDocument('a string'), TemplateImportError);
});

test('every built-in template survives an export and re-import unchanged', () => {
  // The round trip that has to work, run against the real files rather than a
  // fixture that could drift away from them.
  const all = fs
    .readdirSync(TEMPLATES_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, file), 'utf8')));
  assert.ok(all.length >= 10);

  const imported = importIt(all);
  assert.equal(imported.length, all.length, 'all of them, in one file');
  for (const [index, entry] of imported.entries()) {
    assert.equal(entry.template.htmlContent, all[index].htmlContent);
    assert.equal(entry.template.cssContent, all[index].cssContent ?? '');
    assert.deepEqual(entry.template.sections, all[index].sections);
    assert.ok(entry.keptId, 'an import into an empty install keeps its ids');
  }
});

test('an import never overwrites a template already here', () => {
  const imported = importIt([{ name: 'A', id: 'navy-rule', htmlContent: HTML }], {
    idExists: (id) => id === 'navy-rule',
  });
  assert.equal(imported[0].keptId, false);
  assert.equal(imported[0].template.id, 'gen-1');
});

test('a missing sections list is worked out rather than refused', () => {
  // Nothing at render time reads it - the markup decides what is drawn - so
  // demanding it turned a hand-written template into an error over metadata.
  const imported = importIt({ name: 'A', htmlContent: HTML });
  assert.deepEqual(imported[0].template.sections, ['summary', 'experience', 'skills', 'education']);

  assert.deepEqual(
    inferTemplateSections('<div>{{#each experience}}{{title}}{{/each}}</div>'),
    ['experience']
  );
  assert.ok(
    inferTemplateSections('<div>nothing familiar</div>').length > 0,
    'a template naming no known section still renders whatever it has'
  );
});

test('a sections list the file names is kept as written', () => {
  const imported = importIt({ name: 'A', htmlContent: HTML, sections: ['x', 'y'] });
  assert.deepEqual(imported[0].template.sections, ['x', 'y']);
});

test('a file that is not a template says which field is missing', () => {
  assert.throws(() => importIt({ htmlContent: HTML }), /has no "name"/);
  assert.throws(() => importIt({ name: 'A' }), /has no "htmlContent"/);
  assert.throws(() => importIt({ name: 'A', htmlContent: '<p>hi</p>' }), /too short/);
  // A package.json has a name and nothing else, and used to be the file people
  // picked by accident from the wrong row of a downloads folder.
  assert.throws(() => importIt({ name: 'my-app', version: '1.0.0' }), /has no "htmlContent"/);
});

test('one bad template in the middle imports nothing', () => {
  // Otherwise the admin list is left half updated and the person has to work
  // out which half.
  assert.throws(
    () => importIt([{ name: 'A', htmlContent: HTML }, { name: 'B' }, { name: 'C', htmlContent: HTML }]),
    /Template 2 of 3 \("B"\)/
  );
});

test('manualConfig is checked, not cast', () => {
  // The visual editor trusts these types: a font size that arrived as the
  // string "9pt" reaches an arithmetic comparison and renders a blank page - a
  // problem for whoever opened the template next, with nothing linking it back
  // to the import. What it must NOT do is refuse "9pt", which plainly means 9.
  const config = normalizeManualConfig({
    name: 'Manual',
    columns: 2,
    bodyFontSizePt: '9pt',
    titleFontSizePt: 24,
    accentColor: '#1e40af',
    sectionOrder: ['summary', 42, 'experience'],
    nameStyle: { color: 'red' },
    sectionStyles: { skills: { title: { color: 'blue' }, broken: 'not an object' } },
  });
  assert.equal(config.bodyFontSizePt, 9, 'a readable number is read, not refused');
  assert.equal(typeof config.bodyFontSizePt, 'number', 'and stored as a number, never the string');
  assert.equal(config.titleFontSizePt, 24);
  // Genuine garbage is dropped, so the editor's own default wins instead.
  assert.equal(normalizeManualConfig({ name: 'M', bodyFontSizePt: 'large' }).bodyFontSizePt, undefined);
  assert.equal(normalizeManualConfig({ name: 'M', bodyFontSizePt: true }).bodyFontSizePt, undefined);
  assert.equal(normalizeManualConfig({ name: 'M', bodyFontSizePt: -4 }).bodyFontSizePt, undefined);
  assert.equal(config.columns, 2);
  assert.deepEqual(config.sectionOrder, ['summary', 'experience']);
  assert.deepEqual(config.sectionStyles, { skills: { title: { color: 'blue' } } });

  assert.equal(normalizeManualConfig({ columns: 1 }), undefined, 'a config with no name is not one');
  assert.equal(normalizeManualConfig('nope'), undefined);
});

test('a config from a newer build keeps the parts this one understands', () => {
  // Dropping unknown keys rather than refusing them: a template written by a
  // later release is still a usable template here, and the editor rewrites the
  // whole object when it next saves.
  const config = normalizeManualConfig({ name: 'Manual', columns: 1, somethingNew: { a: 1 } });
  assert.equal(config.name, 'Manual');
  assert.equal('somethingNew' in config, false);
});

test('an id chosen by the caller cannot be applied to a whole list', () => {
  // Every entry would overwrite the last and the import would silently produce
  // one template, under a name from the middle of the file.
  assert.throws(
    () =>
      importIt([{ name: 'A', htmlContent: HTML }, { name: 'B', htmlContent: HTML }], {
        overrideId: 'mine',
      }),
    /cannot be imported under one chosen id/
  );
});

test('a misdirected file is refused before it becomes fifty templates', () => {
  const many = Array.from({ length: MAX_TEMPLATES_PER_IMPORT + 1 }, (_, index) => ({
    name: `T${index}`,
    htmlContent: HTML,
  }));
  assert.throws(() => importIt(many), /is the most one import may carry/);
  assert.throws(() => importIt([]), /has no templates in it/);
});

test('an id is reduced to what is safe in a URL and a storage key', () => {
  const imported = importIt({ name: 'A', id: 'my template/../x', htmlContent: HTML });
  assert.match(imported[0].template.id, /^[a-zA-Z0-9\-_]+$/);
});
