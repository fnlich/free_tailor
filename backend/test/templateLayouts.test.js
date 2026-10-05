const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { useAdminEmails, useTempStorage } = require('./helpers');

/**
 * Templates and the two Technical Skills layouts.
 *
 *   - every built-in declares the layouts it renders (`skillsLayouts`), and
 *     renders each one properly: one item per skill when flat (the plain
 *     list), category headings when grouped;
 *   - Soft Skills and Strengths appear only when a profile switches them on,
 *     only in templates that have the markup for them, and never as an empty
 *     heading;
 *   - stored, imported and manual templates get their layouts from the markup
 *     when they carry none, and an administrator can reclassify any template;
 *   - the one template resolver never fails a resume over a layout.
 */

const SHIPPED = path.join(__dirname, '..', 'static');
const TEMPLATES_DIR = path.join(SHIPPED, 'templates');

/** Fresh storage with the shipped templates and skill library in it. */
function seeded(name) {
  const storage = useTempStorage(`template-layouts-${name}`);
  fs.cpSync(TEMPLATES_DIR, path.join(storage.staticDir, 'templates'), { recursive: true });
  fs.cpSync(path.join(SHIPPED, 'skills'), path.join(storage.staticDir, 'skills'), { recursive: true });
  return storage;
}

function shippedTemplates() {
  return fs
    .readdirSync(TEMPLATES_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, file), 'utf8')));
}

/** Eight skills the library knows, three of them languages. */
const SKILLS = ['C#', 'Python', 'TypeScript', 'React', 'Docker', 'PostgreSQL', 'AWS', 'Kubernetes'];

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

/* ----------------------------------------------------------- the built-ins */

test('every built-in declares the layouts it renders, and default renders both', () => {
  const templates = shippedTemplates();
  assert.equal(templates.length, 19);
  for (const template of templates) {
    assert.ok(Array.isArray(template.skillsLayouts) && template.skillsLayouts.length > 0, `${template.id}`);
    for (const layout of template.skillsLayouts) {
      assert.ok(['categorized', 'flat'].includes(layout), `${template.id}: ${layout}`);
    }
    const expected = ['burgundy-rule', 'navy-rule'].includes(template.id)
      ? ['categorized']
      : ['categorized', 'flat'];
    assert.deepEqual(template.skillsLayouts, expected, template.id);
  }
  // The fallback every resolution ends at must take every profile.
  assert.deepEqual(templates.find((template) => template.id === 'default').skillsLayouts, ['categorized', 'flat']);
});

test('every built-in renders each layout it declares: one item per skill flat, headings grouped', async () => {
  seeded('render-all');
  const { generatePreviewHTML } = require('../dist/generators/pdfGenerator');

  for (const template of shippedTemplates()) {
    const perItem = /\{\{#each\s+(?:hardSkills|skills)\s*\}\}/.test(template.htmlContent);
    for (const layout of template.skillsLayouts) {
      const body = bodyOf(
        await generatePreviewHTML(profile({ technicalSkillsLayout: layout }), template)
      );
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
          // group: every skill once, in one joined list.
          for (const skill of SKILLS) {
            assert.equal(body.split(skill).length - 1, 1, `${label}: "${skill}" should appear once`);
          }
        }
      } else {
        assert.match(body, />\s*Languages\s*</, `${label} lost its category headings`);
        for (const skill of SKILLS) {
          assert.equal(wholeItems(body, skill), 0, `${label}: "${skill}" is an item of its own, not under a heading`);
        }
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

test('a template without a declared layout gets one from its markup', () => {
  const { inferTemplateSkillsLayouts, inferTemplateCapabilities, normalizeSkillsLayouts } = require(
    '../dist/services/templateImport'
  );
  assert.deepEqual(inferTemplateSkillsLayouts('<ul>{{#each hardSkills}}<li>{{this}}</li>{{/each}}</ul>'), [
    'categorized',
    'flat',
  ]);
  assert.deepEqual(inferTemplateSkillsLayouts('<p>{{#each skills}}{{this}}{{/each}}</p>'), ['categorized', 'flat']);
  assert.deepEqual(
    inferTemplateSkillsLayouts('{{#each skillCategories}}<b>{{category}}</b>{{join skills ", "}}{{/each}}'),
    ['categorized'],
    'a category design is offered for grouped only'
  );
  assert.deepEqual(
    inferTemplateSkillsLayouts(
      '{{#each skillCategories}}<div class="card"><h4>{{category}}</h4><ul>{{#each skills}}<li>{{this}}</li>{{/each}}</ul></div>{{/each}}'
    ),
    ['categorized'],
    "a category card's own inner list is not a per-skill loop, however it is spelled"
  );
  assert.deepEqual(
    inferTemplateSkillsLayouts('{{#each skillCategories}}x{{/each}}{{#each hardSkills}}y{{/each}}'),
    ['categorized', 'flat']
  );
  assert.deepEqual(
    inferTemplateSkillsLayouts(
      '{{#each skillCategories}}{{#each skills}}{{this}}{{/each}}{{/each}}<p>{{#each hardSkills}}{{this}}{{/each}}</p>'
    ),
    ['categorized', 'flat'],
    'a top-level loop after a nested category block still counts'
  );
  assert.deepEqual(inferTemplateSkillsLayouts('<p>{{summary}}</p>'), ['categorized', 'flat'], 'no skills, hide it from nobody');

  assert.deepEqual(normalizeSkillsLayouts(['flat', 'categorized', 'flat']), ['categorized', 'flat']);
  assert.deepEqual(normalizeSkillsLayouts(['flat', 'sideways']), ['flat']);
  assert.equal(normalizeSkillsLayouts([]), null);
  assert.equal(normalizeSkillsLayouts('flat'), null);

  assert.deepEqual(inferTemplateCapabilities('{{#if softSkills.length}}{{#each softSkills}}{{/each}}{{/if}}'), {
    supportsSoftSkills: true,
    supportsStrengths: false,
  });
  assert.deepEqual(inferTemplateCapabilities('<style>.section-strengths{}</style>'), {
    supportsSoftSkills: false,
    supportsStrengths: false,
  });
});

test('a stored template reads with its layouts inferred or kept, and its capabilities are never stored', async () => {
  const { staticDir } = seeded('stored');
  const { saveStoredTemplate } = require('../dist/database/templateRepository');
  const { getTemplateById } = require('../dist/extractors/templateExtractor');

  const html = '<div>{{#each skillCategories}}{{category}}{{/each}}{{#each strengths}}{{title}}{{/each}}</div>';
  saveStoredTemplate({ id: 'legacy', name: 'Legacy', description: '', htmlContent: html, cssContent: '', sections: [], createdAt: 'x', updatedAt: 'x' });
  const legacy = await getTemplateById('legacy');
  assert.deepEqual(legacy.skillsLayouts, ['categorized'], 'inferred on read, with no migration');
  assert.equal(legacy.supportsStrengths, true);
  assert.equal(legacy.supportsSoftSkills, false);

  saveStoredTemplate({ ...legacy, id: 'kept', skillsLayouts: ['categorized', 'flat'] });
  assert.deepEqual((await getTemplateById('kept')).skillsLayouts, ['categorized', 'flat'], 'a stated list wins');

  // A file now, beside the built-ins (test/templateFiles.test.js has the rest).
  const row = JSON.parse(fs.readFileSync(path.join(staticDir, 'templates', 'kept.json'), 'utf8'));
  assert.equal('supportsStrengths' in row, false, 'derived from the markup, so never written');
  assert.equal('supportsSoftSkills' in row, false);
  assert.equal(row.source, 'uploaded', 'a save without a source is recorded as brought in');
});

test('an import keeps a stated layout list and infers a missing one', () => {
  const { buildImportedTemplates } = require('../dist/services/templateImport');
  const html = '{{#each skillCategories}}{{category}}{{/each}}'.padEnd(150, ' ');
  const [stated, inferred, junk] = buildImportedTemplates(
    [
      { name: 'Stated', htmlContent: html, skillsLayouts: ['flat'] },
      { name: 'Inferred', htmlContent: html },
      { name: 'Junk', htmlContent: html, skillsLayouts: 'flat' },
    ],
    { idExists: () => false, newId: () => `id-${Math.random()}` }
  );
  assert.deepEqual(stated.template.skillsLayouts, ['flat']);
  assert.deepEqual(inferred.template.skillsLayouts, ['categorized']);
  assert.deepEqual(junk.template.skillsLayouts, ['categorized']);
});

test('a manual template offers both layouts and builds Strengths and Soft Skills when asked', async () => {
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
  assert.deepEqual(template.skillsLayouts, ['categorized', 'flat']);
  assert.equal(template.supportsStrengths, true, 'the editor offered Strengths, and now it is built');
  assert.equal(template.supportsSoftSkills, true);
  assert.match(template.htmlContent, /\[data-section="strengths"\] \.strength-title \{ color: #ff0000 \}/);

  const on = await generatePreviewHTML(profile({ includeSoftSkills: true, includeStrengths: true }), template);
  assert.ok(on.includes('Foresight') && on.includes('Persistence'));
  const off = await generatePreviewHTML(profile({}), template);
  assert.equal(off.includes('Foresight') || off.includes('Persistence'), false);

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

test('an administrator can reclassify a template, and a bad list is refused by name', async () => {
  const server = await serveTemplates('patch');
  try {
    for (const bad of [[], ['sideways'], ['flat', 'sideways'], 'flat', null]) {
      const refused = await server.call('admin', 'PATCH', '/navy-gold', { skillsLayouts: bad });
      assert.equal(refused.status, 400, JSON.stringify(bad));
      assert.match(refused.body.error, /skillsLayouts/);
    }

    // A built-in's goes in its override row and is applied on every read.
    const narrowed = await server.call('admin', 'PATCH', '/navy-gold', { skillsLayouts: ['flat', 'flat'] });
    assert.equal(narrowed.status, 200);
    assert.deepEqual(narrowed.body.skillsLayouts, ['flat']);
    const listed = await server.call('alice', 'GET', '/');
    assert.deepEqual(listed.body.find((template) => template.id === 'navy-gold').skillsLayouts, ['flat']);
    assert.equal(listed.body.find((template) => template.id === 'navy-gold').supportsStrengths, true);

    // A PATCH about something else leaves the classification alone.
    const renamed = await server.call('admin', 'PATCH', '/navy-gold', { name: 'Navy and Gold' });
    assert.deepEqual(renamed.body.skillsLayouts, ['flat']);

    const widened = await server.call('admin', 'PATCH', '/burgundy-rule', { skillsLayouts: ['categorized', 'flat'] });
    assert.deepEqual(widened.body.skillsLayouts, ['categorized', 'flat']);

    const forbidden = await server.call('alice', 'PATCH', '/navy-gold', { skillsLayouts: ['categorized'] });
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
    assert.ok(body.includes('Mentoring'), 'the sample soft skills');
    assert.ok(body.includes('Systems Design'), 'the sample strengths');

    const usual = await server.call('alice', 'GET', '/classic-serif/preview');
    assert.equal(usual.body.includes('Mentoring'), false, 'the usual sample shows neither section');

    await server.call('admin', 'PATCH', '/classic-serif', { disabled: true });
    assert.equal((await server.call('alice', 'GET', '/classic-serif/preview')).status, 404);
    assert.equal((await server.call('admin', 'GET', '/classic-serif/preview')).status, 200);
  } finally {
    server.close();
  }
});

/* ----------------------------------------------------------- the resolver */

test('the resolver prefers a template that fits the layout, and never fails a resume over one', async () => {
  seeded('resolver');
  const { resolveTemplateForProfile } = require('../dist/services/templateChoice');
  const { updateTemplate } = require('../dist/extractors/templateExtractor');
  const flat = (preferredTemplate) => ({
    id: 'p',
    preferredTemplate,
    profileSettings: { technicalSkillsLayout: 'flat' },
  });
  const grouped = (preferredTemplate) => ({ id: 'p', preferredTemplate, profileSettings: {} });

  assert.equal((await resolveTemplateForProfile(grouped('navy-rule'))).id, 'navy-rule');
  assert.equal((await resolveTemplateForProfile(flat('navy-rule'))).id, 'default', 'grouped-only skipped for flat');
  assert.equal((await resolveTemplateForProfile(flat('navy-rule'), 'ink-ledger')).id, 'ink-ledger');
  assert.equal((await resolveTemplateForProfile(flat('ink-ledger'), 'burgundy-rule')).id, 'ink-ledger');

  await updateTemplate('ink-ledger', { disabled: true });
  assert.equal((await resolveTemplateForProfile(grouped('ink-ledger'))).id, 'default', 'disabled is skipped');
  assert.equal(
    (await resolveTemplateForProfile(grouped(), 'ink-ledger', { allowDisabledRequested: true })).id,
    'ink-ledger',
    'unless an administrator asked for it by name'
  );

  // Default reclassified away from flat: a flat profile still gets a template
  // that offers flat, rather than a failure.
  await updateTemplate('default', { skillsLayouts: ['categorized'] });
  const fallback = await resolveTemplateForProfile(flat('navy-rule'));
  assert.ok(fallback, 'never null while anything is enabled');
  assert.ok(fallback.skillsLayouts.includes('flat'), `${fallback.id} offers flat`);

  // Nothing offers flat at all: drawn anyway, with the first enabled choice.
  for (const template of shippedTemplates()) {
    await updateTemplate(template.id, { skillsLayouts: ['categorized'] });
  }
  const stillDrawn = await resolveTemplateForProfile(flat('navy-rule'));
  assert.equal(stillDrawn.id, 'navy-rule');
});
