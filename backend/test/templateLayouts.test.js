const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { useAdminEmails, useTempStorage } = require('./helpers');

/**
 * Templates and the two Technical Skills layouts.
 *
 *   - every template prints both layouts and none carries a list of them:
 *     every built-in renders each one properly - one item per skill Plain
 *     (the plain list), category headings Grouped - and a design built on a
 *     grid of category cells lays its one Plain group across the whole row;
 *   - Soft Skills and Strengths appear only when a profile switches them on,
 *     only in templates that have the markup for them, and never as an empty
 *     heading;
 *   - a `skillsLayouts` an older build stored - in a saved file, an imported
 *     one, an override row - is not read, and the admin edit takes a name, a
 *     description or disabled and nothing else;
 *   - the one template resolver takes the requested template, else the
 *     profile's own, else `default`, else any enabled one - whatever the
 *     profile's layout.
 *
 * The fixtures read the BUILT-INS only: a saved template (a file with a
 * `source`) beside them is an administrator's, and not the shipped set.
 */

const SHIPPED = path.join(__dirname, '..', 'static');
const TEMPLATES_DIR = path.join(SHIPPED, 'templates');

/** The two built-ins drawn as a grid of category cells, which the Plain net marks. */
const GRID_DESIGNS = ['burgundy-rule', 'navy-rule'];

/** The built-in template files: those without a `source`. */
function builtInFiles() {
  return fs
    .readdirSync(TEMPLATES_DIR)
    .filter((file) => file.endsWith('.json'))
    .filter((file) => !JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, file), 'utf8')).source);
}

/** Fresh storage with the built-in templates and the skill library in it. */
function seeded(name) {
  const storage = useTempStorage(`template-layouts-${name}`);
  const templates = path.join(storage.staticDir, 'templates');
  fs.mkdirSync(templates, { recursive: true });
  for (const file of builtInFiles()) fs.copyFileSync(path.join(TEMPLATES_DIR, file), path.join(templates, file));
  fs.cpSync(path.join(SHIPPED, 'skills'), path.join(storage.staticDir, 'skills'), { recursive: true });
  return storage;
}

function shippedTemplates() {
  return builtInFiles().map((file) => JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, file), 'utf8')));
}

/**
 * Eleven skills the library knows, three of them languages, and at least two
 * under every heading it gives them: with no padding, a heading over one
 * skill draws it as `<br>React</li>`, which reads as an item of its own.
 */
const SKILLS = ['C#', 'Python', 'TypeScript', 'React', 'Node.js', 'Docker', 'PostgreSQL', 'Redis', 'AWS', 'GCP', 'Kubernetes'];

function profile(settings = {}, extra = {}) {
  return {
    id: 'p1',
    name: 'A Person',
    title: 'Engineer',
    contact: { email: 'a@b.c', phone: '1', location: 'X' },
    summary: 'A summary.',
    experience: [],
    strengths: [{ title: 'Foresight', description: 'Sees the failure before it ships.' }],
    softSkills: ['Persistence', 'Clear writing'],
    education: [],
    certifications: [],
    skills: SKILLS,
    profileSettings: settings,
    createdAt: '',
    updatedAt: '',
    ...extra,
  };
}

/** The rendered document after its stylesheets, so CSS naming a class is not read as content. */
function bodyOf(html) {
  return html.slice(html.lastIndexOf('</style>'));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** How many elements hold exactly this text and nothing else. */
function wholeItems(html, text) {
  return (html.match(new RegExp(`>\\s*${escapeRegExp(text)}\\s*<`, 'g')) ?? []).length;
}

/** How many times the Plain net's stylesheet is in a document. */
function plainNets(html) {
  return html.split('id="plain-skills-style"').length - 1;
}

/** The grid designs' category holder, marked by the Plain net. */
const MARKED_HOLDER = /<div class="[^"]*\bskill-categories\b[^"]*"[^>]*\sdata-plain-skills\b[^>]*>/;

/* ----------------------------------------------------------- the built-ins */

test('no built-in carries a list of layouts: every template prints both', () => {
  const templates = shippedTemplates();
  assert.equal(templates.length, 19);
  for (const template of templates) {
    assert.equal('skillsLayouts' in template, false, template.id);
  }
  // The two grid designs carry a rule of their own for the one Plain group:
  // across the row, with no minimum height. The headless group is the cell
  // with no title element left in it (the heading guard takes it out).
  for (const id of GRID_DESIGNS) {
    const { cssContent } = templates.find((template) => template.id === id);
    assert.match(
      cssContent,
      /\.section\.section-skills \.skill-category:not\(:has\(\.skill-category-title\)\) \{ grid-column: 1 \/ -1; min-height: 0; \}/,
      id
    );
  }

  const templateImport = require('../dist/services/templateImport');
  for (const gone of ['TECHNICAL_SKILLS_LAYOUTS', 'normalizeSkillsLayouts', 'inferTemplateSkillsLayouts']) {
    assert.equal(gone in templateImport, false, `${gone} is gone`);
  }
  assert.equal('templateSupportsLayout' in require('../dist/services/templateChoice'), false);
});

test("every built-in is filed under one of the new-profile chooser's categories, and every category has some", async () => {
  const { TEMPLATE_CATEGORIES, isTemplateCategory } = require('../dist/config/templateCategories');
  assert.deepEqual(TEMPLATE_CATEGORIES, ['simple', 'modern', 'creative']);
  const builtIns = shippedTemplates();
  for (const template of builtIns) {
    assert.ok(isTemplateCategory(template.category), `${template.id}: ${template.category}`);
  }
  for (const category of TEMPLATE_CATEGORIES) {
    assert.ok(builtIns.some((template) => template.category === category), `nothing is ${category}`);
  }

  // Read as the file says, through the same reader as every route.
  seeded('categories');
  const { getAllTemplates, getTemplateById } = require('../dist/extractors/templateExtractor');
  assert.equal((await getTemplateById('default')).category, 'modern');
  for (const template of await getAllTemplates()) {
    assert.equal(template.category, builtIns.find((shipped) => shipped.id === template.id)?.category, template.id);
  }
});

test('a saved template keeps a category it states and drops one that is not a category', async () => {
  const { staticDir } = seeded('saved-category');
  const { saveStoredTemplate } = require('../dist/database/templateRepository');
  const { getTemplateById } = require('../dist/extractors/templateExtractor');
  const { buildImportedTemplates } = require('../dist/services/templateImport');

  const html = '<div>{{name}}{{#each experience}}{{title}}{{/each}}</div>'.padEnd(150, ' ');
  const [stated, junk, none] = buildImportedTemplates(
    [
      { name: 'Stated', htmlContent: html, category: 'creative' },
      { name: 'Junk', htmlContent: html, category: 'Fancy' },
      { name: 'None', htmlContent: html },
    ],
    { idExists: () => false, newId: () => `id-${Math.random().toString(16).slice(2)}` }
  );
  assert.equal(stated.template.category, 'creative');
  assert.equal('category' in junk.template, false);
  assert.equal('category' in none.template, false);

  saveStoredTemplate({ ...stated.template, id: 'stated-category' });
  assert.equal((await getTemplateById('stated-category')).category, 'creative');
  const row = JSON.parse(fs.readFileSync(path.join(staticDir, 'templates', 'stated-category.json'), 'utf8'));
  assert.equal(row.category, 'creative', 'written with the file, unlike the derived fields');

  saveStoredTemplate({ ...none.template, id: 'junk-category', category: 'Fancy' });
  const junkRow = JSON.parse(fs.readFileSync(path.join(staticDir, 'templates', 'junk-category.json'), 'utf8'));
  assert.equal('category' in junkRow, false, 'a word that is not a category is not written');
  assert.equal('category' in (await getTemplateById('junk-category')), false);

  // ...and one typed into the file by hand is not read.
  fs.writeFileSync(
    path.join(staticDir, 'templates', 'junk-category.json'),
    JSON.stringify({ ...junkRow, category: 'Fancy' }, null, 2)
  );
  assert.equal('category' in (await getTemplateById('junk-category')), false);
});

test('every built-in renders both layouts: one item per skill Plain, headings Grouped, a category grid across its row', async () => {
  seeded('render-all');
  const { generatePreviewHTML } = require('../dist/generators/pdfGenerator');

  for (const template of shippedTemplates()) {
    const perItem = /\{\{#each\s+(?:hardSkills|skills)\s*\}\}/.test(template.htmlContent);
    const grid = GRID_DESIGNS.includes(template.id);
    for (const layout of ['categorized', 'flat']) {
      const html = await generatePreviewHTML(profile({ technicalSkillsLayout: layout }), template);
      const body = bodyOf(html);
      const label = `${template.id} (${layout})`;

      if (layout === 'flat') {
        assert.doesNotMatch(body, />\s*Languages\s*</, `${label} drew a category heading`);
        if (perItem) {
          // The plain list: each skill its own item - not one item holding
          // all eight, squeezed into a single column of a multi-column list.
          for (const skill of SKILLS) {
            assert.equal(wholeItems(body, skill), 1, `${label}: "${skill}" should be exactly one item`);
          }
        } else {
          // A design built on category groups draws flat as one headless
          // group: every skill once, in one joined list, and no heading
          // element left over it.
          for (const skill of SKILLS) {
            assert.equal(body.split(skill).length - 1, 1, `${label}: "${skill}" should appear once`);
          }
          assert.doesNotMatch(body, /<div class="skill-category-title"/, `${label} kept an empty heading element`);
        }
        // The grid designs' holder is marked, so the one group spans the row
        // with no minimum height; the net's stylesheet comes with it, once.
        assert.equal(MARKED_HOLDER.test(body), grid, `${label}: the category holder marked`);
        assert.equal(plainNets(html), grid ? 1 : 0, `${label}: the Plain net's stylesheet`);
      } else {
        assert.match(body, />\s*Languages\s*</, `${label} lost its category headings`);
        for (const skill of SKILLS) {
          assert.equal(wholeItems(body, skill), 0, `${label}: "${skill}" is an item of its own, not under a heading`);
        }
        assert.equal(plainNets(html), 0, `${label}: the Plain net is Plain's alone`);
        assert.equal(body.includes('data-plain-skills'), false, `${label}: nothing marked`);
      }
      assert.equal(body.includes('{{'), false, `${label} left Handlebars unrendered`);
    }
  }
});

test('Soft Skills and Strengths appear only when switched on, and only where the template has them', async () => {
  seeded('sections');
  const { getAllTemplates } = require('../dist/extractors/templateExtractor');
  const { generatePreviewHTML } = require('../dist/generators/pdfGenerator');

  const templates = await getAllTemplates();
  assert.equal(templates.length, 19);
  for (const template of templates) {
    const on = bodyOf(await generatePreviewHTML(profile({ includeSoftSkills: true, includeStrengths: true }), template));
    const off = bodyOf(await generatePreviewHTML(profile({}), template));
    const onButEmpty = bodyOf(
      await generatePreviewHTML(
        profile({ includeSoftSkills: true, includeStrengths: true }, { softSkills: [], strengths: [] }),
        template
      )
    );

    // Switched on, a template renders the section exactly when it says it can -
    // which is what the editor's "this template has no ... section" note reads.
    assert.equal(on.includes('Persistence'), template.supportsSoftSkills, `${template.id} soft skills`);
    assert.equal(on.includes('Foresight'), template.supportsStrengths, `${template.id} strengths`);

    // Off - the default, and what every resume rendered before the switches -
    // nothing of either, not even a heading.
    for (const body of [off, onButEmpty]) {
      assert.equal(body.includes('Persistence') || body.includes('Foresight'), false, template.id);
      assert.doesNotMatch(body, />\s*Soft Skills\s*</, `${template.id} drew an empty Soft Skills heading`);
      assert.doesNotMatch(body, />\s*(?:Key )?Strengths\s*</, `${template.id} drew an empty Strengths heading`);
    }
  }
});

test('the capability flags match the markup of every built-in', async () => {
  seeded('capabilities');
  const { getAllTemplates } = require('../dist/extractors/templateExtractor');
  const byId = Object.fromEntries((await getAllTemplates()).map((template) => [template.id, template]));

  const neither = ['burgundy-rule', 'navy-rule', 'charcoal-sidebar'];
  for (const [id, template] of Object.entries(byId)) {
    const expected = neither.includes(id)
      ? { supportsSoftSkills: false, supportsStrengths: false }
      : id === 'ink-ledger'
        ? { supportsSoftSkills: false, supportsStrengths: true }
        : { supportsSoftSkills: true, supportsStrengths: true };
    assert.deepEqual(
      { supportsSoftSkills: template.supportsSoftSkills, supportsStrengths: template.supportsStrengths },
      expected,
      id
    );
  }
});

/* ------------------------------------------------- section strip and guard */

test('switching a section off removes that element and nothing around it', async () => {
  seeded('strip');
  const { generatePreviewHTML } = require('../dist/generators/pdfGenerator');
  const render = (htmlContent, settings) =>
    generatePreviewHTML(profile(settings), { id: 'custom', name: 'Custom', htmlContent, cssContent: '' });

  // The old strip took the nearest <div before the class name - here the whole
  // main column, Experience included.
  const nested =
    '<div class="main"><div class="experience">Experience: {{summary}}</div>' +
    '<section class="section-strengths"><h2>Strengths</h2>{{#each strengths}}<p>{{title}}</p>{{/each}}</section>' +
    '<div class="tail">Tail</div></div>';
  const off = await render(nested, {});
  assert.ok(off.includes('Experience: A summary.'), 'the main column survives');
  assert.ok(off.includes('Tail'));
  assert.equal(off.includes('Strengths'), false);
  const on = await render(nested, { includeStrengths: true });
  assert.ok(on.includes('<p>Foresight</p>'));

  // A class named in a stylesheet after the first element is not an element.
  const styled =
    '<div class="wrap"><style>.section-soft-skills { color: red }</style><p>Keep</p>' +
    '<div class="section-soft-skills">Soft {{#each softSkills}}{{this}}{{/each}}</div></div>';
  const styledOff = await render(styled, {});
  assert.ok(styledOff.includes('.section-soft-skills { color: red }'));
  assert.ok(styledOff.includes('<p>Keep</p>'));
  assert.equal(styledOff.includes('Soft '), false);

  // An opening guard with no closing one right after the element is left
  // whole: taking half of it would leave an orphan {{/if}} that no longer compiles.
  const halfGuarded =
    '<div>{{#if softSkills.length}}<div class="section-soft-skills">Soft</div><p>After</p>{{/if}}</div>';
  await assert.doesNotReject(() => render(halfGuarded, {}));

  // A class that only starts with the name is a different class.
  const lookalike = '<div class="section-strengths-grid">Grid stays</div>';
  assert.ok((await render(lookalike, {})).includes('Grid stays'));
});

test('a switched-on section with nothing in it leaves no heading, in any template written either way', async () => {
  seeded('guard');
  const { generatePreviewHTML } = require('../dist/generators/pdfGenerator');
  const unguarded =
    '<div><div class="section section-strengths"><div class="title">Strengths</div>' +
    '{{#each strengths}}<p>{{title}}</p>{{/each}}</div></div>';
  const template = { id: 'u', name: 'U', htmlContent: unguarded, cssContent: '' };

  const empty = await generatePreviewHTML(profile({ includeStrengths: true }, { strengths: [] }), template);
  assert.equal(empty.includes('Strengths'), false);
  const full = await generatePreviewHTML(profile({ includeStrengths: true }), template);
  assert.ok(full.includes('<p>Foresight</p>'));
});

/* ------------------------------------------- inference, storage and import */

test("a template's sections are read off its markup", () => {
  const { inferTemplateCapabilities } = require('../dist/services/templateImport');
  assert.deepEqual(inferTemplateCapabilities('{{#if softSkills.length}}{{#each softSkills}}{{/each}}{{/if}}'), {
    supportsSoftSkills: true,
    supportsStrengths: false,
  });
  assert.deepEqual(inferTemplateCapabilities('<style>.section-strengths{}</style>'), {
    supportsSoftSkills: false,
    supportsStrengths: false,
  });
});

test('a stored template reads with no layout list, even one its file states, and its capabilities are never stored', async () => {
  const { staticDir } = seeded('stored');
  const { saveStoredTemplate } = require('../dist/database/templateRepository');
  const { getAllTemplates, getTemplateById, updateTemplate } = require('../dist/extractors/templateExtractor');

  const html = '<div>{{#each skillCategories}}{{category}}{{/each}}{{#each strengths}}{{title}}{{/each}}</div>';
  saveStoredTemplate({ id: 'legacy', name: 'Legacy', description: '', htmlContent: html, cssContent: '', sections: [], createdAt: 'x', updatedAt: 'x' });
  const legacy = await getTemplateById('legacy');
  assert.equal('skillsLayouts' in legacy, false);
  assert.equal(legacy.supportsStrengths, true);
  assert.equal(legacy.supportsSoftSkills, false);

  // A file now, beside the built-ins (test/templateFiles.test.js has the rest).
  const row = JSON.parse(fs.readFileSync(path.join(staticDir, 'templates', 'legacy.json'), 'utf8'));
  assert.equal('supportsStrengths' in row, false, 'derived from the markup, so never written');
  assert.equal('supportsSoftSkills' in row, false);
  assert.equal(row.source, 'uploaded', 'a save without a source is recorded as brought in');

  // A file an older build wrote, Grouped only: the list is not read...
  const older = path.join(staticDir, 'templates', 'older.json');
  fs.writeFileSync(
    older,
    JSON.stringify(
      { id: 'older', name: 'Older', description: '', source: 'uploaded', htmlContent: html, cssContent: '', sections: [], skillsLayouts: ['categorized'], createdAt: 'x', updatedAt: 'x' },
      null,
      2
    )
  );
  assert.equal('skillsLayouts' in (await getTemplateById('older')), false);
  assert.equal('skillsLayouts' in (await getAllTemplates()).find((template) => template.id === 'older'), false);
  // ...and the next write of the file leaves it out.
  await updateTemplate('older', { name: 'Older, renamed' });
  const rewritten = JSON.parse(fs.readFileSync(older, 'utf8'));
  assert.equal(rewritten.name, 'Older, renamed');
  assert.equal('skillsLayouts' in rewritten, false);
});

test('an import reads no layout list, whatever the file states', () => {
  const { buildImportedTemplates } = require('../dist/services/templateImport');
  const html = '{{#each skillCategories}}{{category}}{{/each}}'.padEnd(150, ' ');
  const [stated, none] = buildImportedTemplates(
    [
      { name: 'Stated', htmlContent: html, skillsLayouts: ['flat'] },
      { name: 'None', htmlContent: html },
    ],
    { idExists: () => false, newId: () => `id-${Math.random()}` }
  );
  assert.equal('skillsLayouts' in stated.template, false);
  assert.equal('skillsLayouts' in none.template, false);
});

test('a manual template prints both layouts and builds Strengths and Soft Skills when asked', async () => {
  seeded('manual');
  const { createManualTemplate, getTemplateById } = require('../dist/extractors/templateExtractor');
  const { generatePreviewHTML } = require('../dist/generators/pdfGenerator');

  const created = await createManualTemplate({
    name: 'Mine',
    columns: 2,
    accentColor: '#123456',
    bodyColor: '#000',
    bodyFontSizePt: 9,
    titleFontSizePt: 20,
    leftSectionOrder: ['summary', 'experience', 'strengths'],
    rightSectionOrder: ['hardSkills', 'softSkills', 'education'],
    sectionStyles: { strengths: { strengthTitle: { color: '#ff0000' } } },
  });
  const template = await getTemplateById(created.id);
  assert.equal('skillsLayouts' in template, false);
  assert.equal(template.supportsStrengths, true, 'the editor offered Strengths, and now it is built');
  assert.equal(template.supportsSoftSkills, true);
  assert.match(template.htmlContent, /\[data-section="strengths"\] \.strength-title \{ color: #ff0000 \}/);

  const on = await generatePreviewHTML(profile({ includeSoftSkills: true, includeStrengths: true }), template);
  assert.ok(on.includes('Foresight') && on.includes('Persistence'));
  const off = await generatePreviewHTML(profile({}), template);
  assert.equal(off.includes('Foresight') || off.includes('Persistence'), false);

  const grouped = bodyOf(await generatePreviewHTML(profile({ technicalSkillsLayout: 'categorized' }), template));
  assert.match(grouped, />\s*Languages\s*</, 'a category cell per group');
  const flat = bodyOf(await generatePreviewHTML(profile({ technicalSkillsLayout: 'flat' }), template));
  for (const skill of SKILLS) assert.equal(wholeItems(flat, skill), 1, `${skill} as its own box`);
});

test('every template mutation answers with the capabilities a following read reports', async () => {
  seeded('mutation-capabilities');
  const {
    createManualTemplate,
    updateManualTemplate,
    uploadJsonTemplates,
    getTemplateById,
  } = require('../dist/extractors/templateExtractor');
  const capabilities = (template) => ({
    supportsSoftSkills: template.supportsSoftSkills,
    supportsStrengths: template.supportsStrengths,
  });
  const config = {
    name: 'Mine',
    columns: 1,
    accentColor: '#123456',
    bodyColor: '#000',
    bodyFontSizePt: 9,
    titleFontSizePt: 20,
  };

  const created = await createManualTemplate({ ...config, sectionOrder: ['summary', 'strengths', 'softSkills'] });
  assert.deepEqual(capabilities(created), { supportsSoftSkills: true, supportsStrengths: true });
  assert.deepEqual(capabilities(created), capabilities(await getTemplateById(created.id)));

  const dropped = await updateManualTemplate(created.id, { ...config, sectionOrder: ['summary', 'experience'] });
  assert.deepEqual(capabilities(dropped), { supportsSoftSkills: false, supportsStrengths: false }, 'not the old markup');
  assert.deepEqual(capabilities(dropped), capabilities(await getTemplateById(created.id)));

  const restored = await updateManualTemplate(created.id, { ...config, sectionOrder: ['strengths', 'softSkills'] });
  assert.deepEqual(capabilities(restored), { supportsSoftSkills: true, supportsStrengths: true });

  const source = JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, 'classic-serif.json'), 'utf8'));
  const [uploaded] = await uploadJsonTemplates(Buffer.from(JSON.stringify({ ...source, id: 'classic-copy' })));
  assert.equal(typeof uploaded.template.supportsStrengths, 'boolean');
  assert.deepEqual(capabilities(uploaded.template), capabilities(await getTemplateById(uploaded.template.id)));
});

/* ---------------------------------------------------------- admin routes */

async function serveTemplates(name) {
  seeded(name);
  useAdminEmails('admin@example.com');
  const users = require('../dist/database/userRepository');
  const admin = users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  const tokens = { admin: users.createSession(admin.id), alice: users.createSession(alice.id) };
  const { attachUser } = require('../dist/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/templates', require('../dist/routes/templates').default);
  const server = app.listen(0);
  const port = server.address().port;
  const call = async (who, method, route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/templates${route}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[who]}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // HTML, for the preview
    }
    return { status: response.status, body: parsed, headers: response.headers };
  };
  return { call, close: () => server.close() };
}

test('the admin edit changes a name, a description or disabled - and nothing else', async () => {
  const server = await serveTemplates('patch');
  try {
    const before = (await server.call('alice', 'GET', '/navy-gold')).body;

    // A layout list is not something a template has any more: alone, it is
    // nothing to change - refused, rather than a 200 that rewrites a file.
    for (const body of [{ skillsLayouts: ['flat'] }, {}, { name: 42, disabled: 'yes' }]) {
      const refused = await server.call('admin', 'PATCH', '/navy-gold', body);
      assert.equal(refused.status, 400, JSON.stringify(body));
      assert.equal(refused.body.error, 'There is nothing to change: send a name, a description or disabled.');
    }
    assert.equal((await server.call('alice', 'GET', '/navy-gold')).body.updatedAt, before.updatedAt, 'nothing moved');

    // A built-in's edit goes in its override row and is applied on every read.
    const renamed = await server.call('admin', 'PATCH', '/navy-gold', { name: 'Navy and Gold', skillsLayouts: ['flat'] });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.name, 'Navy and Gold');
    assert.equal('skillsLayouts' in renamed.body, false);
    const listed = await server.call('alice', 'GET', '/');
    const navyGold = listed.body.find((template) => template.id === 'navy-gold');
    assert.equal(navyGold.name, 'Navy and Gold');
    assert.equal(navyGold.supportsStrengths, true);

    // An override row an older build wrote, narrowing a built-in to Plain: not
    // read by the list, nor by the resolver, which draws a Grouped profile on it.
    const { saveTemplateOverride } = require('../dist/database/templateRepository');
    const { resolveTemplateForProfile } = require('../dist/services/templateChoice');
    const at = new Date().toISOString();
    saveTemplateOverride({ id: 'burgundy-rule', skillsLayouts: ['flat'], createdAt: at, updatedAt: at });
    const burgundy = (await server.call('alice', 'GET', '/')).body.find((template) => template.id === 'burgundy-rule');
    assert.equal('skillsLayouts' in burgundy, false);
    assert.equal(burgundy.name, 'Burgundy Rule', 'a row with no name keeps the file\'s');
    const grouped = await resolveTemplateForProfile({ preferredTemplate: 'burgundy-rule', profileSettings: {} });
    assert.equal(grouped.id, 'burgundy-rule');

    const forbidden = await server.call('alice', 'PATCH', '/navy-gold', { name: 'Mine' });
    assert.equal(forbidden.status, 403);
  } finally {
    server.close();
  }
});

test('the gallery preview can show a layout and the sections, under a no-script policy', async () => {
  const server = await serveTemplates('gallery');
  try {
    const plain = await server.call('alice', 'GET', '/classic-serif/preview?layout=flat&softSkills=1&strengths=true');
    assert.equal(plain.status, 200);
    assert.equal(
      plain.headers.get('content-security-policy'),
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"
    );
    const body = bodyOf(plain.body.slice(0, plain.body.indexOf('<style id="resume-preview-page">')));
    assert.equal(wholeItems(body, 'TypeScript'), 1, 'flat: one item per skill');
    assert.equal(wholeItems(body, 'Mentoring'), 1, "the sample's soft skills, once, in their section");
    assert.ok(body.includes('Systems Design'), 'the sample strengths');

    // The usual sample is tailored with neither section: its soft-skill group
    // is the last heading of the skills block, as on a generated resume.
    const usual = await server.call('alice', 'GET', '/classic-serif/preview');
    const usualBody = bodyOf(usual.body.slice(0, usual.body.indexOf('<style id="resume-preview-page">')));
    assert.match(usualBody, /<strong>Professional Skills<\/strong><br>Mentoring, /);
    assert.equal(usualBody.includes('Systems Design'), false, 'no Strengths section');
    assert.doesNotMatch(usualBody, />\s*Soft Skills\s*</, 'no Soft Skills section');

    // A grid of category cells, Plain: the one group's holder marked, no title
    // element over it, the net's stylesheet once - and Grouped, its cells.
    const grid = await server.call('alice', 'GET', '/burgundy-rule/preview?layout=flat');
    assert.equal(grid.status, 200);
    const gridDocument = grid.body.slice(0, grid.body.indexOf('<style id="resume-preview-page">'));
    const gridBody = bodyOf(gridDocument);
    assert.match(gridBody, MARKED_HOLDER);
    assert.doesNotMatch(gridBody, /<div class="skill-category-title"/);
    assert.equal(plainNets(gridDocument), 1);
    const gridGrouped = await server.call('alice', 'GET', '/burgundy-rule/preview?layout=categorized');
    const groupedBody = bodyOf(gridGrouped.body.slice(0, gridGrouped.body.indexOf('<style id="resume-preview-page">')));
    assert.match(groupedBody, /<div class="skill-category-title"[^>]*>Professional Skills<\/div>/);
    assert.equal(gridGrouped.body.includes('data-plain-skills'), false);

    await server.call('admin', 'PATCH', '/classic-serif', { disabled: true });
    assert.equal((await server.call('alice', 'GET', '/classic-serif/preview')).status, 404);
    assert.equal((await server.call('admin', 'GET', '/classic-serif/preview')).status, 200);
  } finally {
    server.close();
  }
});

/* ----------------------------------------------------------- the resolver */

test("the resolver takes the requested template, else the profile's own, else default, else any enabled one - whatever the layout", async () => {
  seeded('resolver');
  const { resolveTemplateForProfile } = require('../dist/services/templateChoice');
  const { getAllTemplates, updateTemplate } = require('../dist/extractors/templateExtractor');
  const flat = (preferredTemplate) => ({
    id: 'p',
    preferredTemplate,
    profileSettings: { technicalSkillsLayout: 'flat' },
  });
  const grouped = (preferredTemplate) => ({ id: 'p', preferredTemplate, profileSettings: {} });

  // The two grid designs were Grouped only; a Plain profile is drawn with them now.
  assert.equal((await resolveTemplateForProfile(flat('navy-rule'))).id, 'navy-rule');
  assert.equal((await resolveTemplateForProfile(grouped('navy-rule'))).id, 'navy-rule');
  assert.equal((await resolveTemplateForProfile(flat('navy-rule'), 'burgundy-rule')).id, 'burgundy-rule', 'requested beats preferred');
  assert.equal((await resolveTemplateForProfile(flat('gone'))).id, 'default', 'a template that is gone falls to default');
  assert.equal((await resolveTemplateForProfile(flat(undefined))).id, 'default');

  await updateTemplate('ink-ledger', { disabled: true });
  assert.equal((await resolveTemplateForProfile(grouped('ink-ledger'))).id, 'default', 'disabled is skipped');
  assert.equal((await resolveTemplateForProfile(grouped('navy-rule'), 'ink-ledger')).id, 'navy-rule', 'a disabled request too');
  assert.equal(
    (await resolveTemplateForProfile(grouped(), 'ink-ledger', { allowDisabledRequested: true })).id,
    'ink-ledger',
    'unless an administrator asked for it by name'
  );
  assert.equal(
    (await resolveTemplateForProfile(grouped('ink-ledger'), undefined, { allowDisabledRequested: true })).id,
    'default',
    'only a requested one: a disabled preference is skipped for an administrator too'
  );

  // `default` disabled and the profile's own gone: the first enabled template
  // there is, newest first as the list is served - never null while one is.
  await updateTemplate('default', { disabled: true });
  const fallback = await resolveTemplateForProfile(flat('gone'));
  assert.ok(fallback, 'never null while anything is enabled');
  assert.equal(fallback.disabled, false);
  assert.equal(fallback.id, (await getAllTemplates()).find((template) => !template.disabled).id);

  // Nothing enabled at all: null, which every caller turns into the 503.
  for (const template of shippedTemplates()) {
    await updateTemplate(template.id, { disabled: true });
  }
  assert.equal(await resolveTemplateForProfile(flat('navy-rule')), null);
  assert.equal(await resolveTemplateForProfile(grouped(), 'navy-rule'), null);
  assert.equal(
    (await resolveTemplateForProfile(grouped(), 'navy-rule', { allowDisabledRequested: true })).id,
    'navy-rule',
    'an administrator previewing one by name still sees it'
  );
});
