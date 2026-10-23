const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { useTempStorage } = require('./helpers');

/**
 * Every section of a resume prints where its stored order puts it,
 * on every template, and the nine kinds beyond the classic six print at all.
 *
 *   - with a stored order, the sections of every built-in come out in that
 *     order WITHIN EACH COLUMN (a template decides the column; the order
 *     applies inside it), every entry of every kind prints once, no `{{`
 *     survives and no template needs the compile fallback;
 *   - with no stored order nothing moves: the classic sections print in the
 *     template's own order - the one `nativeSectionOrder` reports, which is
 *     what the editor shows such a resume in - and the other kinds print at
 *     the macro's position in canonical order, custom sections last;
 *   - an unlisted section follows the listed ones in the template's order; a
 *     listed kind with no entries prints no heading; a custom section prints
 *     under its own title and moves on its own;
 *   - an uploaded-style template with no markers is reordered through the
 *     heading heuristic; one whose section cannot be found prints it where it
 *     is and says so once; one whose section wraps a Handlebars block that
 *     closes outside it keeps its own order and says so once; a template that
 *     prints a kind itself beside the macro prints it once;
 *   - two orders compile to two different documents;
 *   - the DOCX follows the stored order, prints the canonical order without
 *     one, no heading over nothing, and a custom section under its title;
 *   - `printsSections` and `nativeSectionOrder` are read off every built-in
 *     and never written to a saved file.
 */

const SHIPPED = path.join(__dirname, '..', 'static');

/** Fresh storage with the built-in templates - not a saved one beside them (a file with a `source`) - and the skill library. */
function seeded(name) {
  const storage = useTempStorage(`section-order-${name}`);
  const from = path.join(SHIPPED, 'templates');
  const to = path.join(storage.staticDir, 'templates');
  fs.mkdirSync(to, { recursive: true });
  for (const file of fs.readdirSync(from).filter((entry) => entry.endsWith('.json'))) {
    const text = fs.readFileSync(path.join(from, file), 'utf8');
    if (!JSON.parse(text).source) fs.writeFileSync(path.join(to, file), text);
  }
  fs.cpSync(path.join(SHIPPED, 'skills'), path.join(storage.staticDir, 'skills'), { recursive: true });
  return storage;
}

/** A resume with something in every kind of section, both switches on. */
function fullResume(extra = {}) {
  return {
    id: 'p1',
    name: 'A Person',
    title: 'Engineer',
    contact: { email: 'a@b.c', phone: '1', location: 'X' },
    summary: 'A summary of the work.',
    experience: [
      {
        title: 'Developer',
        company: 'Acme Widgets',
        startDate: '2020',
        endDate: '2023',
        location: 'Remote',
        description: 'Built the widget pipeline.',
        achievements: ['Shipped it'],
        skills: [],
      },
    ],
    strengths: [{ title: 'Foresight', description: 'Sees the failure before it ships.' }],
    softSkills: ['Persistence'],
    skills: ['Python', 'Docker'],
    education: [{ degree: 'BSc Computing', institution: 'Hill University', startDate: '2014', endDate: '2018', location: 'Hill' }],
    certifications: [{ name: 'AWS Solutions Architect', issuer: 'Amazon', date: '2022', expiryDate: '2025', credentialId: 'ABC-123' }],
    projects: [
      {
        name: 'Lakehouse Build',
        role: 'Lead',
        startDate: '01/2023',
        endDate: '06/2023',
        link: 'github.com/person/lakehouse',
        description: 'A lakehouse for the team.',
        achievements: ['Cut query time by 40%'],
      },
    ],
    volunteering: [
      {
        role: 'Mentor Volunteer',
        organization: 'Code Club',
        startDate: '2021',
        endDate: 'Present',
        location: 'Austin',
        description: '',
        achievements: ['Taught thirty kids'],
      },
    ],
    awards: [{ title: 'Best Paper Award', issuer: 'ACM', date: '2022', description: 'For the lakehouse paper.' }],
    publications: [{ title: 'On Lakehouses', publisher: 'VLDB', date: '2022', link: 'javascript:alert(1)', description: '' }],
    courses: [{ name: 'Machine Learning Course', institution: 'Coursera', date: '2020' }],
    languages: [{ language: 'French', proficiency: 'Fluent' }],
    interests: ['Chess', 'Hiking'],
    references: [{ name: 'Ann Lee', title: 'CTO', company: 'Acme', email: 'ann@acme.com', phone: '555' }],
    customSections: [
      { key: 'cs-alpha', title: 'Patents', entries: [{ heading: 'US123 Patent', subheading: 'USPTO', startDate: '2021', endDate: '', location: '', description: '', achievements: [] }] },
      { key: 'cs-beta', title: 'Talks', entries: [{ heading: 'KubeCon Talk', subheading: '', startDate: '', endDate: '', location: 'Paris', description: 'On lakes.', achievements: ['Full room'] }] },
    ],
    resumeSettings: { includeSoftSkills: true, includeStrengths: true },
    createdAt: '',
    updatedAt: '',
    ...extra,
  };
}

const KINDS = [
  'summary', 'strengths', 'skills', 'softSkills', 'experience', 'education',
  'certifications', 'projects', 'volunteering', 'awards', 'publications', 'courses', 'languages', 'interests', 'references',
];
const EXTRA = KINDS.slice(6);
const FULL_REVERSED = ['custom:cs-beta', 'custom:cs-alpha', ...KINDS.slice().reverse()];

/** What a reader sees: no stylesheet, no head, no tags. */
function seen(html) {
  return html
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<head\b[\s\S]*?<\/head>/i, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ');
}

const CLASS_KINDS = {
  'section-summary': 'summary', 'section-strengths': 'strengths', 'section-skills': 'skills', 'section-soft-skills': 'softSkills',
  'section-experience': 'experience', 'section-education': 'education', 'section-certifications': 'certifications',
  'section-projects': 'projects', 'section-volunteering': 'volunteering', 'section-awards': 'awards',
  'section-publications': 'publications', 'section-courses': 'courses', 'section-languages': 'languages',
  'section-interests': 'interests', 'section-references': 'references',
};
const DATA_KINDS = { hardSkills: 'skills', skillCategories: 'skills', 'soft-skills': 'softSkills' };

/** The section refs a rendered document marks, in document order (every marked element, so a repeat counts twice). */
function refsOf(html) {
  const body = html.replace(/<style\b[\s\S]*?<\/style>/gi, ' ').replace(/<head\b[\s\S]*?<\/head>/i, ' ');
  const refs = [];
  for (const tag of body.match(/<[a-zA-Z][^>]*>/g) ?? []) {
    const data = /data-section="([^"]+)"/.exec(tag);
    if (data) {
      const value = data[1];
      if (value.startsWith('custom:') || KINDS.includes(value) || DATA_KINDS[value]) refs.push(DATA_KINDS[value] ?? value);
      continue;
    }
    const classes = /class="([^"]*)"/.exec(tag);
    if (!classes) continue;
    const kind = classes[1].split(/\s+/).map((token) => CLASS_KINDS[token]).find(Boolean);
    if (kind) refs.push(kind);
  }
  return refs;
}

/** The refs of a rendered document grouped by the element each sits in - its column - in document order. */
function groupedRefs(html, locator) {
  const groups = new Map();
  for (const section of locator.locateSections(html, 'marked')) {
    const key = locator.parentKeyOf(html, section);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(section.ref);
  }
  return [...groups.values()];
}

async function warningsOf(fn) {
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    return { result: await fn(), warnings: warnings.filter((line) => line.includes('[templates]')) };
  } finally {
    console.warn = realWarn;
  }
}

const ENTRY_TEXTS = [
  'Acme Widgets', 'Foresight', 'Persistence', 'Docker', 'BSc Computing', 'AWS Solutions Architect', 'Credential ID ABC-123',
  'Lakehouse Build', 'Cut query time by 40%', 'github.com/person/lakehouse', 'Mentor Volunteer', 'Taught thirty kids',
  'Best Paper Award', 'On Lakehouses', 'Machine Learning Course', 'French - Fluent', 'Chess, Hiking', 'Ann Lee',
  'ann@acme.com | 555', 'Patents', 'US123 Patent', 'Talks', 'KubeCon Talk', 'Full room',
];
const KIND_HEADINGS = ['Certifications', 'Projects', 'Volunteering', 'Awards', 'Publications', 'Courses', 'Languages', 'Interests', 'References'];

/**
 * Every entry once - except a strength or a soft skill on a template with no
 * section for it, which `resumeForTemplate` turns off exactly as the PDF
 * always has (burgundy-rule, navy-rule, charcoal-sidebar; ink-ledger has no
 * Soft Skills).
 */
function assertEverythingPrintsOnce(html, name, supports = { strengths: true, softSkills: true }) {
  const text = seen(html);
  for (const entry of ENTRY_TEXTS) {
    const expected = (entry === 'Foresight' && !supports.strengths) || (entry === 'Persistence' && !supports.softSkills) ? 0 : 1;
    assert.equal(text.split(entry).length - 1, expected, `${name}: "${entry}" printed ${expected === 1 ? 'once' : 'nowhere'}`);
  }
  for (const headingText of KIND_HEADINGS) assert.match(text, new RegExp(headingText), `${name}: the ${headingText} heading`);
  assert.doesNotMatch(html, /\{\{/, `${name}: no unrendered Handlebars`);
  assert.doesNotMatch(html, /javascript:/, `${name}: an unsafe link never reaches an href`);
  assert.ok(html.includes('id="xs-style"'), `${name}: the baseline stylesheet once`);
  assert.equal(html.split('id="xs-style"').length - 1, 1, `${name}: the baseline stylesheet once`);
}

/* ------------------------------------------------------- every built-in */

test('every built-in prints every section in the stored order within each column, everything once, and needs no fallback', async () => {
  seeded('built-ins');
  const { getAllTemplates } = require('../dist/extractors/templateExtractor');
  const { generatePreviewHTML } = require('../dist/generators/pdfGenerator');
  const locator = require('../dist/generators/sectionLocator');

  const templates = await getAllTemplates();
  assert.equal(templates.length, 19);
  const resume = fullResume({ sectionOrder: FULL_REVERSED });

  const { warnings } = await warningsOf(async () => {
    for (const template of templates) {
      const supports = { strengths: template.supportsStrengths, softSkills: template.supportsSoftSkills };
      const html = await generatePreviewHTML(resume, template);
      assertEverythingPrintsOnce(html, template.id, supports);
      const groups = groupedRefs(html, locator);
      assert.ok(groups.length > 0, `${template.id}: sections located in the render`);
      for (const group of groups) {
        const places = group.map((ref) => FULL_REVERSED.indexOf(ref));
        assert.ok(places.every((place) => place >= 0), `${template.id}: every located section is in the order (${group})`);
        for (let i = 1; i < places.length; i += 1) {
          assert.ok(places[i] > places[i - 1], `${template.id}: ${group[i - 1]} before ${group[i]} in a column, order says otherwise`);
        }
      }
      // Both layouts: the skills rewrite runs after the reorder and must not undo it.
      const flat = await generatePreviewHTML(
        { ...resume, resumeSettings: { ...resume.resumeSettings, technicalSkillsLayout: 'flat' } },
        template
      );
      assertEverythingPrintsOnce(flat, `${template.id} (flat)`, supports);
    }
  });
  assert.deepEqual(warnings, [], 'a built-in needed the compile fallback or lost a section');
});

test('with no stored order nothing moves: every built-in prints its classic sections in its own order, the other kinds at the macro, custom sections last', async () => {
  seeded('native');
  const { getAllTemplates } = require('../dist/extractors/templateExtractor');
  const { generatePreviewHTML } = require('../dist/generators/pdfGenerator');

  const templates = await getAllTemplates();
  const resume = fullResume();
  const { warnings } = await warningsOf(async () => {
    for (const template of templates) {
      const html = await generatePreviewHTML(resume, template);
      assertEverythingPrintsOnce(html, template.id, { strengths: template.supportsStrengths, softSkills: template.supportsSoftSkills });
      const refs = refsOf(html);
      const kinds = refs.filter((ref) => !ref.startsWith('custom:'));
      const customs = refs.filter((ref) => ref.startsWith('custom:'));
      assert.deepEqual(kinds, template.nativeSectionOrder, `${template.id}: the render follows nativeSectionOrder`);
      assert.deepEqual(customs, ['custom:cs-alpha', 'custom:cs-beta'], `${template.id}: custom sections in their own order`);
      assert.ok(
        refs.indexOf('custom:cs-alpha') > refs.indexOf('references'),
        `${template.id}: custom sections after the generated kinds`
      );
      // The template read says the same: every kind it has once, the nine
      // generated kinds once and together in canonical order, no custom ref.
      const native = template.nativeSectionOrder;
      assert.equal(new Set(native).size, native.length, `${template.id}: each kind once`);
      assert.equal(native.includes('strengths'), template.supportsStrengths, `${template.id}: strengths iff supported`);
      assert.equal(native.includes('softSkills'), template.supportsSoftSkills, `${template.id}: soft skills iff supported`);
      for (const kind of ['summary', 'experience', 'education', 'skills']) assert.ok(native.includes(kind), `${template.id}: ${kind}`);
      const extrasAt = native.indexOf('certifications');
      assert.deepEqual(native.slice(extrasAt, extrasAt + EXTRA.length), EXTRA, `${template.id}: the nine kinds contiguous, canonical`);
      assert.ok(native.every((ref) => !ref.startsWith('custom:')), `${template.id}: no custom ref`);
      assert.ok(EXTRA.every((kind) => template.printsSections.includes(kind)), `${template.id}: prints every generated kind`);
      assert.ok(template.printsSections.includes('custom'), `${template.id}: prints custom sections`);
      assert.equal(template.printsSections.includes('softSkills'), template.supportsSoftSkills, `${template.id}: printsSections agrees on soft skills`);
    }
  });
  assert.deepEqual(warnings, []);
  // The two columns of default, and the macro in the left one after Experience.
  const byId = new Map(templates.map((template) => [template.id, template]));
  assert.deepEqual(byId.get('default').nativeSectionOrder, ['summary', 'experience', ...EXTRA, 'strengths', 'skills', 'softSkills', 'education']);
  assert.deepEqual(byId.get('azure-stack').nativeSectionOrder, ['summary', 'experience', 'strengths', 'skills', 'softSkills', 'education', ...EXTRA]);
  assert.deepEqual(byId.get('charcoal-sidebar').nativeSectionOrder, ['skills', 'summary', 'experience', 'education', ...EXTRA]);
});

test('an unlisted section follows the listed ones in the template\'s own order, a listed empty kind prints no heading, and a custom section moves on its own', async () => {
  seeded('partial');
  const { getTemplateById } = require('../dist/extractors/templateExtractor');
  const { generatePreviewHTML } = require('../dist/generators/pdfGenerator');
  const locator = require('../dist/generators/sectionLocator');
  const template = await getTemplateById('default');

  // default: summary and experience (and the generated kinds) in the left
  // column; strengths, skills, soft skills, education in the right. Education
  // listed first moves to the top of ITS column; the unlisted ones follow in
  // the template's order; custom:cs-beta moves above the summary in the left.
  const html = await generatePreviewHTML(fullResume({ sectionOrder: ['education', 'custom:cs-beta', 'summary'] }), template);
  const groups = groupedRefs(html, locator);
  const left = groups.find((group) => group.includes('summary'));
  const right = groups.find((group) => group.includes('education'));
  assert.deepEqual(left.slice(0, 3), ['custom:cs-beta', 'summary', 'experience']);
  assert.deepEqual(left.slice(3), [...EXTRA, 'custom:cs-alpha']);
  assert.deepEqual(right, ['education', 'strengths', 'skills', 'softSkills']);

  // Listed with nothing in it: no heading, no block. (The skill library's
  // "Languages" category still heads the skills block, so the block's own
  // markers are what is checked, not the word.)
  const empty = await generatePreviewHTML(fullResume({ languages: [], courses: [], sectionOrder: ['languages', 'summary'] }), template);
  assert.doesNotMatch(seen(empty), /Courses|French/);
  assert.equal(refsOf(empty).includes('languages'), false);
  assert.equal(refsOf(empty).includes('courses'), false);
  assert.equal(empty.includes('data-section="languages"'), false);

  // Two orders are two documents.
  const other = await generatePreviewHTML(fullResume({ sectionOrder: ['summary', 'education'] }), template);
  assert.notEqual(html, other);
  assert.deepEqual(groupedRefs(other, locator).find((group) => group.includes('education')), ['education', 'strengths', 'skills', 'softSkills']);
  assert.deepEqual(groupedRefs(other, locator).find((group) => group.includes('summary')).slice(0, 2), ['summary', 'experience']);
});

/* ------------------------------------------------- uploaded-style markup */

const UPLOADED =
  '<div class="main"><h2>Summary</h2><p>{{summary}}</p>' +
  '<h2>Experience</h2>{{#each experience}}<p>{{company}}</p>{{/each}}' +
  '<h2>Education</h2>{{#each education}}<p>{{degree}}</p>{{/each}}' +
  '<h2>Technical Skills</h2>{{#each skills}}<span>{{this}}</span>{{/each}}' +
  '{{> extra-sections}}</div>';

function uploaded(id, htmlContent) {
  return { id, name: id, description: '', htmlContent, cssContent: '', sections: [], createdAt: '', updatedAt: '' };
}

test('an uploaded-style template with no markers is reordered through its headings, and one with the macro prints the new kinds', async () => {
  seeded('uploaded');
  const { generatePreviewHTML } = require('../dist/generators/pdfGenerator');
  const template = uploaded('uploaded-plain', UPLOADED);
  const { result: html, warnings } = await warningsOf(() =>
    generatePreviewHTML(fullResume({ sectionOrder: ['projects', 'education', 'skills', 'experience', 'summary'] }), template)
  );
  assert.deepEqual(warnings, []);
  const text = seen(html);
  const at = (needle) => {
    const index = text.indexOf(needle);
    assert.ok(index >= 0, `"${needle}" printed`);
    return index;
  };
  assert.ok(at('Lakehouse Build') < at('BSc Computing'), 'Projects first');
  assert.ok(at('BSc Computing') < at('Docker'), 'then Education');
  assert.ok(at('Docker') < at('Acme Widgets'), 'then Technical Skills');
  assert.ok(at('Acme Widgets') < at('A summary of the work'), 'then Experience, then Summary');
  // No Strengths or Soft Skills markup in this fixture, so neither prints.
  assertEverythingPrintsOnce(html, 'uploaded-plain', { strengths: false, softSkills: false });
});

test('a section the locator cannot find prints where it is and is said so once; a section wrapping a block that closes outside it keeps the template\'s order, once', async () => {
  seeded('unmovable');
  const { generatePreviewHTML } = require('../dist/generators/pdfGenerator');

  // Experience with no heading element before its loop: nothing to move it by.
  const headless = uploaded(
    'uploaded-headless',
    '<div class="main">{{#each experience}}<p>{{company}}</p>{{/each}}<h2>Education</h2>{{#each education}}<p>{{degree}}</p>{{/each}}' +
      '<h2>Summary</h2><p>{{summary}}</p></div>'
  );
  const order = ['summary', 'education', 'experience'];
  const first = await warningsOf(() => generatePreviewHTML(fullResume({ sectionOrder: order }), headless));
  const second = await warningsOf(() => generatePreviewHTML(fullResume({ sectionOrder: order, name: 'Again' }), headless));
  assert.equal(first.warnings.length, 1);
  assert.match(first.warnings[0], /Template "uploaded-headless" has a experience section the resume's order cannot move/);
  assert.deepEqual(second.warnings, [], 'said once');
  const text = seen(first.result);
  assert.ok(text.indexOf('Acme Widgets') < text.indexOf('A summary'), 'Experience stays first; the two found sections are reordered after it');
  assert.ok(text.indexOf('A summary') < text.indexOf('BSc Computing'), 'Summary before Education, as the order says');

  // A guard that opens inside the summary's element and closes outside it: a
  // move would split it, so the template keeps its own order and says so once.
  const crossed = uploaded(
    'uploaded-crossed-order',
    '<div class="main"><div class="section section-summary"><h2>Summary</h2>{{#if summary}}<p>{{summary}}</p></div>{{/if}}' +
      '<div class="section section-education"><h2>Education</h2>{{#each education}}<p>{{degree}}</p>{{/each}}</div></div>'
  );
  const kept = await warningsOf(() => generatePreviewHTML(fullResume({ sectionOrder: ['education', 'summary'] }), crossed));
  const again = await warningsOf(() => generatePreviewHTML(fullResume({ sectionOrder: ['education', 'summary'], name: 'B' }), crossed));
  assert.equal(kept.warnings.length, 1);
  assert.match(kept.warnings[0], /Template "uploaded-crossed-order" cannot be drawn in the resume's section order/);
  assert.deepEqual(again.warnings, []);
  const keptText = seen(kept.result);
  assert.ok(keptText.indexOf('A summary') < keptText.indexOf('BSc Computing'), 'the template\'s own order');
  assert.doesNotMatch(kept.result, /\{\{/);
});

test('a template that prints a kind itself beside the macro prints it once', async () => {
  seeded('own-kind');
  const { generatePreviewHTML } = require('../dist/generators/pdfGenerator');
  const template = uploaded(
    'uploaded-own-certifications',
    '<div class="main"><h2>Experience</h2>{{#each experience}}<p>{{company}}</p>{{/each}}' +
      '<h2>Certifications</h2><ul>{{#each certifications}}<li>{{name}}, {{issuer}} ({{dates}})</li>{{/each}}</ul>' +
      '{{> extra-sections sectionClass="section"}}</div>'
  );
  const html = await generatePreviewHTML(fullResume(), template);
  const text = seen(html);
  assert.equal(text.split('AWS Solutions Architect').length - 1, 1, 'the template\'s own block, not the macro\'s too');
  assert.match(text, /AWS Solutions Architect, Amazon \(2022 - 2025\)/, 'the prepared dates reach the template\'s own loop');
  assert.equal(html.includes('<!--xs:certifications-->'), false, 'no generated certifications block');
  assert.ok(html.includes('<!--xs:projects-->'), 'the other kinds are generated');
  assert.match(text, /Lakehouse Build/);
});

/* ---------------------------------------------------------------- DOCX */

test('the DOCX follows the stored order, prints the canonical order without one, no heading over nothing, a custom section under its title', () => {
  seeded('docx');
  const { prepareResumeRenderData } = require('../dist/generators/pdfGenerator');
  const { buildResumeDocxHTML } = require('../dist/generators/docxGenerator');

  const headingsOf = (html) => [...html.matchAll(/<u>([^<]+)<\/u>/g)].map((match) => match[1]);
  const canonical = buildResumeDocxHTML(prepareResumeRenderData(fullResume()));
  assert.deepEqual(headingsOf(canonical), [
    'Professional Summary', 'Key Strengths', 'Technical Skills', 'Soft Skills', 'Professional Experience', 'Education',
    'Certifications', 'Projects', 'Volunteering', 'Awards', 'Publications', 'Courses', 'Languages', 'Interests', 'References',
    'Patents', 'Talks',
  ]);
  for (const entry of ['Lakehouse Build (github.com/person/lakehouse)', 'Cut query time by 40%', 'French - Fluent', 'US123 Patent', 'Credential ID ABC-123']) {
    assert.ok(canonical.includes(entry), `the DOCX prints ${entry}`);
  }
  assert.doesNotMatch(canonical, /javascript:/);

  const ordered = buildResumeDocxHTML(prepareResumeRenderData(fullResume({ sectionOrder: ['custom:cs-beta', 'projects', 'education', 'summary'] })));
  assert.deepEqual(headingsOf(ordered).slice(0, 4), ['Talks', 'Projects', 'Education', 'Professional Summary']);
  assert.deepEqual(headingsOf(ordered).slice(4), [
    'Key Strengths', 'Technical Skills', 'Soft Skills', 'Professional Experience',
    'Certifications', 'Volunteering', 'Awards', 'Publications', 'Courses', 'Languages', 'Interests', 'References', 'Patents',
  ]);

  // Nothing in a kind: no heading. A custom section with no title: entries, no heading.
  const sparse = buildResumeDocxHTML(
    prepareResumeRenderData(
      fullResume({
        languages: [],
        awards: [],
        customSections: [{ key: 'cs-x', title: '', entries: [{ heading: 'Untitled entry', subheading: '', startDate: '', endDate: '', location: '', description: '', achievements: [] }] }],
        sectionOrder: ['languages', 'summary'],
      })
    )
  );
  assert.doesNotMatch(sparse, /<u>Languages<\/u>|<u>Awards<\/u>/);
  assert.ok(sparse.includes('Untitled entry'));
});

/* ---------------------------------------------------- the template read */

test('printsSections and nativeSectionOrder are read off a template and never written to its file', () => {
  const storage = seeded('derived');
  const { getTemplateById } = require('../dist/extractors/templateExtractor');
  const { writeTemplateFile, readSavedTemplateFile } = require('../dist/database/templateFiles');

  return getTemplateById('default').then((template) => {
    assert.ok(Array.isArray(template.printsSections) && template.printsSections.includes('projects'));
    assert.ok(Array.isArray(template.nativeSectionOrder) && template.nativeSectionOrder[0] === 'summary');
    writeTemplateFile({ ...template, id: 'copy-of-default', name: 'Copy' }, 'uploaded');
    const written = JSON.parse(fs.readFileSync(path.join(storage.staticDir, 'templates', 'copy-of-default.json'), 'utf8'));
    assert.equal('printsSections' in written, false);
    assert.equal('nativeSectionOrder' in written, false);
    assert.equal('supportsSoftSkills' in written, false);
    const read = readSavedTemplateFile('copy-of-default');
    assert.equal(read.source, 'uploaded');
  });
});
