const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

/**
 * Every seat is locked, before any dist module loads: nothing here may ask a
 * model, and a 200 from the preview is also proof that none was asked.
 */
process.env.AI_LOCKED_PROVIDERS = 'claude-cli,codex-cli,gemini-cli';

const { useAdminEmails, useTempStorage } = require('./helpers');

/**
 * The editor's preview fills an empty draft from the sample person - and
 * nothing else ever does.
 *
 *   - single fields per field, lists per section, Strengths and Soft Skills
 *     only while their switch is on for the template being drawn;
 *   - the response names what was filled, in `SAMPLE_FIELDS` order;
 *   - a sampled value never reaches a save, a render that is kept (PDF, DOCX,
 *     the builder's preview), or a prompt.
 */

const SHIPPED = path.join(__dirname, '..', 'static');
const SRC = path.join(__dirname, '..', 'src');

const SAMPLE_TEXT = [
  'Jordan Avery Chen',
  'Senior Software Engineer',
  'jordan.chen@example.com',
  '+1 (555) 123-4567',
  'San Francisco, CA',
  'linkedin.com/in/jordanchen',
  'Northwind Payments',
  'University of Washington',
  'Systems Design',
  'Calm under pressure',
];

function seedStatic(staticDir) {
  fs.cpSync(path.join(SHIPPED, 'templates'), path.join(staticDir, 'templates'), { recursive: true });
  fs.cpSync(path.join(SHIPPED, 'skills'), path.join(staticDir, 'skills'), { recursive: true });
}

/** What the editor sends for a profile nobody has typed into: every field, all blank. */
function blankDraft(extra = {}) {
  return {
    name: '',
    title: '',
    contact: { email: '', phone: '', location: '', linkedin: '' },
    summary: '',
    experience: [],
    strengths: [],
    softSkills: [],
    skills: [],
    education: [],
    ...extra,
  };
}

function bodyOf(html) {
  return html.slice(html.lastIndexOf('</style>', html.indexOf('<style id="resume-preview-page">')));
}

const storage = useTempStorage('sample-defaults');
seedStatic(storage.staticDir);
useAdminEmails('admin@example.com');

const users = require('../dist/database/userRepository');
const { saveProfile, getProfile } = require('../dist/database/profileRepository');
const { buildNewProfile, buildPreviewProfile } = require('../dist/services/profileService');
const { withSampleDefaults, SAMPLE_FIELDS, SAMPLE_PROFILE } = require('../dist/services/sampleProfile');

const admin = users.createUser({ email: 'admin@example.com' });
const alice = users.createUser({ email: 'alice@example.com' });
const tokens = { admin: users.createSession(admin.id), alice: users.createSession(alice.id) };

function serve() {
  const { attachUser } = require('../dist/middleware/auth');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(attachUser);
  app.use('/api/profiles', require('../dist/routes/profiles').default);
  const server = app.listen(0);
  const port = server.address().port;
  const call = async (method, url, body, who = 'alice') => {
    const response = await fetch(`http://127.0.0.1:${port}/api/profiles${url}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[who]}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { call, close: () => server.close() };
}

/* ------------------------------------------------------------- the merge */

test('an empty draft is filled field by field and section by section, and says which', () => {
  const draft = buildPreviewProfile(blankDraft());
  const { profile, sampled } = withSampleDefaults(draft);

  assert.deepEqual(sampled, [
    'name', 'title', 'email', 'phone', 'location', 'linkedin', 'summary', 'experience', 'education', 'skills',
  ]);
  assert.equal(profile.name, 'Jordan Avery Chen');
  assert.equal(profile.contact.phone, '+1 (555) 123-4567');
  assert.equal(profile.experience.length, 4);
  assert.equal(profile.education.length, 2);
  assert.equal(profile.skills.length, 30);
  // Off by default, so neither is drawn - and neither is claimed as sampled.
  assert.deepEqual(profile.strengths, []);
  assert.deepEqual(profile.softSkills, []);

  // The order the editor lists them in, whatever subset is filled.
  assert.deepEqual(sampled, SAMPLE_FIELDS.filter((field) => sampled.includes(field)));
});

test('a typed value wins per field, and one typed row replaces the whole sample list', () => {
  const draft = buildPreviewProfile(
    blankDraft({
      name: 'Ada Lovelace',
      contact: { email: 'ada@example.com', phone: '  ', location: '', linkedin: '' },
      experience: [{ title: 'Analyst', company: '', startDate: '', endDate: '', location: '', description: '', achievements: [] }],
      skills: [],
      skillCategories: [{ category: 'Languages', skills: ['Python'] }],
    })
  );
  const { profile, sampled } = withSampleDefaults(draft);

  assert.equal(profile.name, 'Ada Lovelace');
  assert.equal(profile.contact.email, 'ada@example.com');
  assert.equal(profile.contact.phone, '+1 (555) 123-4567', 'blank after trimming is empty');
  assert.deepEqual(profile.experience.map((role) => role.title), ['Analyst'], 'per section, never mixed');
  assert.ok(profile.skills.includes('Python') && !profile.skills.includes('Kubernetes'), 'a grouped skill counts');
  for (const field of ['name', 'email', 'experience', 'skills']) assert.equal(sampled.includes(field), false, field);
  for (const field of ['phone', 'location', 'linkedin', 'title', 'summary', 'education']) {
    assert.ok(sampled.includes(field), field);
  }

  // A freshly added blank row is not typing.
  const blankRow = withSampleDefaults(
    buildPreviewProfile(
      blankDraft({ experience: [{ title: ' ', company: '', startDate: '', endDate: '', location: '', description: '', achievements: [''] }] })
    )
  );
  assert.equal(blankRow.profile.experience.length, 4);
  assert.ok(blankRow.sampled.includes('experience'));
});

test('Strengths and Soft Skills are sampled only while their switch is on', () => {
  const on = buildPreviewProfile(blankDraft({ profileSettings: { includeStrengths: true, includeSoftSkills: true } }));
  const filled = withSampleDefaults(on);
  assert.ok(filled.sampled.includes('strengths') && filled.sampled.includes('softSkills'));
  assert.equal(filled.profile.strengths[0].title, 'Systems Design');
  assert.ok(filled.profile.softSkills.includes('Calm under pressure'));

  const typed = withSampleDefaults(
    buildPreviewProfile(
      blankDraft({
        profileSettings: { includeStrengths: true, includeSoftSkills: true },
        strengths: [{ title: 'Foresight', description: '' }],
        softSkills: ['Grit'],
      })
    )
  );
  assert.deepEqual(typed.profile.strengths, [{ title: 'Foresight', description: '' }]);
  assert.deepEqual(typed.profile.softSkills, ['Grit']);
  assert.equal(typed.sampled.includes('strengths') || typed.sampled.includes('softSkills'), false);
});

test('neither the draft nor the shared sample is changed by a merge', () => {
  const draft = buildPreviewProfile(blankDraft());
  const before = JSON.stringify(draft);
  const sampleBefore = JSON.stringify(SAMPLE_PROFILE);
  const { profile } = withSampleDefaults(draft);
  profile.experience[0].achievements.push('edited downstream');
  profile.skills.push('Edited');
  assert.equal(JSON.stringify(draft), before);
  assert.equal(JSON.stringify(SAMPLE_PROFILE), sampleBefore);
});

/* ------------------------------------------------------------- the route */

test('the preview of an empty draft shows the sample and answers `sampled`', async () => {
  const server = serve();
  try {
    const response = await server.call('POST', '/preview', { profile: blankDraft() });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(Object.keys(response.body).sort(), ['html', 'page', 'sampled', 'templateId']);
    assert.deepEqual(response.body.sampled, [
      'name', 'title', 'email', 'phone', 'location', 'linkedin', 'summary', 'experience', 'education', 'skills',
    ]);
    const html = bodyOf(response.body.html);
    assert.ok(html.includes('Jordan Avery Chen'));
    assert.ok(html.includes('Northwind Payments'));

    const typed = await server.call('POST', '/preview', {
      profile: blankDraft({ name: 'Ada Lovelace', summary: 'Writes the first program.' }),
    });
    const typedHtml = bodyOf(typed.body.html);
    assert.ok(typedHtml.includes('Ada Lovelace') && !typedHtml.includes('Jordan Avery Chen'));
    assert.ok(typedHtml.includes('+1 (555) 123-4567'), 'the empty phone still shows the sample');
    assert.equal(typed.body.sampled.includes('name'), false);
    assert.equal(typed.body.sampled.includes('summary'), false);
  } finally {
    server.close();
  }
});

test('a switch the template has no section for is neither filled nor reported', async () => {
  const server = serve();
  try {
    const settings = { includeStrengths: true, includeSoftSkills: true };
    // Burgundy Rule has no Strengths or Soft Skills section.
    const without = await server.call('POST', '/preview', {
      profile: blankDraft({ profileSettings: settings }),
      templateId: 'burgundy-rule',
    });
    assert.equal(without.body.templateId, 'burgundy-rule');
    assert.equal(without.body.sampled.includes('strengths'), false);
    assert.equal(without.body.sampled.includes('softSkills'), false);

    const withSections = await server.call('POST', '/preview', {
      profile: blankDraft({ profileSettings: settings }),
      templateId: 'classic-serif',
    });
    assert.ok(withSections.body.sampled.includes('strengths') && withSections.body.sampled.includes('softSkills'));
    assert.ok(bodyOf(withSections.body.html).includes('Systems Design'));
  } finally {
    server.close();
  }
});

/* ------------------------------------------------- and nowhere else, ever */

test('a profile saved from an empty draft holds no sample value', async () => {
  const server = serve();
  try {
    const created = await server.call('POST', '/', blankDraft(), 'alice');
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const stored = getProfile(created.body.id);
    const text = JSON.stringify(stored);
    for (const sample of SAMPLE_TEXT) assert.equal(text.includes(sample), false, `${sample} was saved`);
    assert.equal(stored.name, '');
    assert.deepEqual(stored.experience, []);

    // A preview in between, then an edit: still nothing from the sample.
    await server.call('POST', '/preview', { profileId: stored.id, profile: blankDraft() });
    const updated = await server.call('PUT', `/${stored.id}`, blankDraft({ title: 'Analyst' }), 'alice');
    assert.equal(updated.status, 200);
    const again = JSON.stringify(getProfile(stored.id));
    for (const sample of SAMPLE_TEXT) assert.equal(again.includes(sample), false, `${sample} was saved`);
  } finally {
    server.close();
  }
});

test('an empty profile renders, prints and prompts as empty: the sample is the preview\'s alone', async () => {
  const empty = { ...buildNewProfile(blankDraft(), 'p-empty'), ownerId: alice.id };
  saveProfile(empty);
  const { getTemplateById } = require('../dist/extractors/templateExtractor');
  const { generatePreviewHTML, prepareResumeRenderData } = require('../dist/generators/pdfGenerator');
  const { buildResumeDocxHTML } = require('../dist/generators/docxGenerator');
  const { buildTailorResumePromptValues, buildCoverLetterPromptValues, parseJobAnalysisContent } =
    require('../dist/services/resumeService');
  const template = await getTemplateById('default');

  // The builder's preview and the PDF share one render; the DOCX its own HTML.
  const renders = [
    await generatePreviewHTML(empty, template),
    buildResumeDocxHTML(prepareResumeRenderData(empty)),
  ];
  const analysis = parseJobAnalysisContent(
    JSON.stringify({ jobMeta: { title: 'Engineer' }, skills: { technical: ['Python'] } }),
    'A posting for an engineer who writes Python every day of the week.'
  );
  const prompts = [
    JSON.stringify(buildTailorResumePromptValues(empty, analysis)),
    JSON.stringify(buildCoverLetterPromptValues(empty, 'Acme', 'Engineer')),
  ];
  for (const text of [...renders, ...prompts]) {
    for (const sample of SAMPLE_TEXT) assert.equal(text.includes(sample), false, `${sample} leaked`);
  }
});

test('withSampleDefaults is called from the preview route and nowhere else', () => {
  // The behavioural tests above cover the paths that exist; this covers the
  // next one somebody writes. The sample is drawn in two places by design -
  // the gallery and the editor's preview - and any third is a leak.
  const callers = { withSampleDefaults: [], SAMPLE_PROFILE: [] };
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) {
        const text = fs.readFileSync(full, 'utf8');
        for (const name of Object.keys(callers)) {
          if (new RegExp(`\\b${name}\\b`).test(text)) callers[name].push(path.relative(SRC, full).split(path.sep).join('/'));
        }
      }
    }
  };
  walk(SRC);
  assert.deepEqual(callers.withSampleDefaults.sort(), ['routes/profiles.ts', 'services/sampleProfile.ts']);
  assert.deepEqual(callers.SAMPLE_PROFILE.sort(), ['generators/pdfGenerator.ts', 'services/sampleProfile.ts']);
});
