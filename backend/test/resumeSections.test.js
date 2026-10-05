const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { useTempStorage } = require('./helpers');

/**
 * The profile's section choices, from the stored field to every output.
 *
 *   - `profileSettings.includeSoftSkills` / `includeStrengths`: off unless a
 *     profile says true, and kept by a save that does not mention them;
 *   - `softSkills` on the profile itself: trimmed, de-duplicated, bounded, kept
 *     when omitted - the editor's chip list, which used to be dropped on save;
 *   - the render gate: what the PDF, the preview and the DOCX are handed has
 *     the two sections exactly when the switches are on, from the tailored
 *     content or the profile's own lists;
 *   - links the renderer puts in an href are http(s) only.
 */

function seeded(name) {
  const storage = useTempStorage(`resume-sections-${name}`);
  const shipped = path.join(__dirname, '..', 'static');
  fs.cpSync(path.join(shipped, 'skills'), path.join(storage.staticDir, 'skills'), { recursive: true });
  return storage;
}

function profile(settings = {}, extra = {}) {
  return {
    id: 'p1',
    name: 'Sam Chen',
    title: 'Engineer',
    contact: { email: 'sam@example.com', phone: '1', location: 'X', linkedin: 'linkedin.com/in/sam' },
    summary: 'Summary.',
    experience: [],
    strengths: [
      { title: 'Foresight', description: 'Sees the failure before it ships.' },
      { title: '  ', description: '' },
    ],
    softSkills: ['Persistence', 'Clear writing'],
    education: [],
    skills: ['C#', 'Python', 'Docker'],
    profileSettings: settings,
    createdAt: '',
    updatedAt: '',
    ...extra,
  };
}

function tailored(extra = {}) {
  return {
    title: 'Engineer',
    summary: 'Tailored summary.',
    experience: [],
    skills: ['Python'],
    hardSkills: ['Python'],
    softSkills: ['Negotiation'],
    unconfirmedSoftSkills: [],
    unconfirmedHardSkills: [],
    strengths: [{ title: 'Tailored strength', description: 'For this job.' }],
    ...extra,
  };
}

/* ------------------------------------------------------------ the profile */

test('the section switches are off unless a profile says true, and a save that omits them keeps them', () => {
  const { buildNewProfile, buildUpdatedProfile, getProfileResumeSections } = require('../dist/services/profileService');

  const fresh = buildNewProfile({ name: 'A' }, 'a');
  assert.equal(fresh.profileSettings.includeSoftSkills, false);
  assert.equal(fresh.profileSettings.includeStrengths, false);
  assert.deepEqual(getProfileResumeSections(fresh), { layout: 'categorized', softSkills: false, strengths: false });
  assert.deepEqual(getProfileResumeSections({}), { layout: 'categorized', softSkills: false, strengths: false });

  const on = buildUpdatedProfile(fresh, {
    profileSettings: { includeSoftSkills: true, includeStrengths: true, technicalSkillsLayout: 'flat' },
  });
  assert.deepEqual(getProfileResumeSections(on), { layout: 'flat', softSkills: true, strengths: true });

  // A client that predates the switches saves without them: nothing turns off.
  const kept = buildUpdatedProfile(on, { name: 'Renamed', profileSettings: { hardSkillOrdering: 'library' } });
  assert.equal(kept.profileSettings.includeSoftSkills, true);
  assert.equal(kept.profileSettings.includeStrengths, true);

  // Only a boolean decides.
  const junk = buildUpdatedProfile(on, { profileSettings: { includeSoftSkills: 'no', includeStrengths: null } });
  assert.equal(junk.profileSettings.includeSoftSkills, true);
  const off = buildUpdatedProfile(on, { profileSettings: { includeSoftSkills: false } });
  assert.equal(off.profileSettings.includeSoftSkills, false);
  assert.equal(off.profileSettings.includeStrengths, true);
});

test("a profile's soft skills are stored, cleaned, bounded, and kept when a save omits them", () => {
  const {
    buildNewProfile,
    buildUpdatedProfile,
    MAX_PROFILE_SOFT_SKILLS,
    MAX_SOFT_SKILL_LENGTH,
  } = require('../dist/services/profileService');

  const stored = buildNewProfile(
    { name: 'A', softSkills: ['  Leadership ', 'leadership', 'Clear   writing', '', 7, null, 'Grit'] },
    'a'
  );
  assert.deepEqual(stored.softSkills, ['Leadership', 'Clear writing', 'Grit'], 'the first spelling wins a repeat');

  assert.deepEqual(buildUpdatedProfile(stored, { name: 'B' }).softSkills, stored.softSkills, 'omitted keeps');
  assert.deepEqual(buildUpdatedProfile(stored, { softSkills: [] }).softSkills, [], 'an empty list clears');
  assert.deepEqual(buildUpdatedProfile(stored, { softSkills: 'Grit' }).softSkills, [], 'not a list is no list');

  const many = buildNewProfile({ softSkills: Array.from({ length: 80 }, (_, i) => `Skill ${i}`) }, 'm');
  assert.equal(many.softSkills.length, MAX_PROFILE_SOFT_SKILLS);
  const long = buildNewProfile({ softSkills: ['x'.repeat(500)] }, 'l');
  assert.equal(long.softSkills[0].length, MAX_SOFT_SKILL_LENGTH);

  // Written before the field existed: reads as none, and a save adds it.
  const { softSkills, ...legacy } = stored;
  void softSkills;
  assert.deepEqual(buildUpdatedProfile(legacy, { name: 'C' }).softSkills, []);
});

test('the preview builder never throws, and takes only the settings that change the render', () => {
  const { buildNewProfile, buildPreviewProfile } = require('../dist/services/profileService');
  const stored = {
    ...buildNewProfile(
      {
        name: 'Stored',
        summary: 'Stored summary.',
        profileSettings: { resumeFileNameTemplate: '{{profile name}}_cv', ai: { modelId: 'claude-cli-opus' } },
      },
      'p-1'
    ),
    ownerId: 'owner-1',
  };

  const built = buildPreviewProfile(
    {
      name: 'Draft',
      softSkills: ['Grit'],
      profileSettings: {
        resumeFileNameTemplate: '{{bogus}}',
        companyFolderNameTemplate: '{{profile na',
        ai: { modelId: 'not-checked-here' },
        includeSoftSkills: true,
        technicalSkillsLayout: 'flat',
      },
    },
    stored
  );
  assert.equal(built.id, 'p-1');
  assert.equal(built.ownerId, 'owner-1');
  assert.equal(built.name, 'Draft');
  assert.equal(built.summary, 'Stored summary.', 'omitted keeps the stored value');
  assert.deepEqual(built.softSkills, ['Grit']);
  assert.equal(built.profileSettings.includeSoftSkills, true);
  assert.equal(built.profileSettings.technicalSkillsLayout, 'flat');
  assert.equal(built.profileSettings.resumeFileNameTemplate, '{{profile name}}_cv', 'file naming stays as stored');
  assert.deepEqual(built.profileSettings.ai, { modelId: 'claude-cli-opus' }, 'the model choice stays as stored');

  for (const nonsense of [undefined, null, 'x', 42, [], { experience: 'x', strengths: [1, null], contact: [] }]) {
    assert.doesNotThrow(() => buildPreviewProfile(nonsense, stored));
    assert.doesNotThrow(() => buildPreviewProfile(nonsense));
  }
  assert.equal(buildPreviewProfile({ name: 'New' }).id, 'preview');
});

test('a file holding only soft skills is a profile, and the switches survive an import', () => {
  const { buildImportedProfiles } = require('../dist/services/profileImport');
  const [entry] = buildImportedProfiles(
    {
      name: 'Soft only',
      softSkills: ['Persistence'],
    },
    { idExists: () => false, newId: () => 'new-1' }
  );
  assert.deepEqual(entry.profile.softSkills, ['Persistence']);

  const [withSwitches] = buildImportedProfiles(
    { name: 'Switched', title: 'T', profileSettings: { includeSoftSkills: true, includeStrengths: true } },
    { idExists: () => false, newId: () => 'new-2' }
  );
  assert.equal(withSwitches.profile.profileSettings.includeSoftSkills, true);
  assert.equal(withSwitches.profile.profileSettings.includeStrengths, true);
});

/* ------------------------------------------------------- the render gate */

test('switched off, neither section reaches a render - whatever the content carries', () => {
  seeded('gate-off');
  const { prepareResumeRenderData } = require('../dist/generators/pdfGenerator');
  for (const data of [prepareResumeRenderData(profile()), prepareResumeRenderData(profile(), tailored())]) {
    assert.deepEqual(data.softSkills, []);
    assert.deepEqual(data.strengths, []);
  }
});

test("switched on, an untailored render shows the profile's own lists", () => {
  seeded('gate-own');
  const { prepareResumeRenderData } = require('../dist/generators/pdfGenerator');
  const data = prepareResumeRenderData(profile({ includeSoftSkills: true, includeStrengths: true }));
  assert.deepEqual(data.softSkills, ['Persistence', 'Clear writing']);
  assert.deepEqual(
    data.strengths,
    [{ title: 'Foresight', description: 'Sees the failure before it ships.' }],
    'an empty strength is not a strength'
  );
});

test("switched on, a tailored render shows the tailored lists, and the profile's when those are empty", () => {
  seeded('gate-tailored');
  const { prepareResumeRenderData } = require('../dist/generators/pdfGenerator');
  const on = profile({ includeSoftSkills: true, includeStrengths: true });

  const fromTailoring = prepareResumeRenderData(on, tailored());
  assert.deepEqual(fromTailoring.softSkills, ['Negotiation']);
  assert.deepEqual(fromTailoring.strengths, [{ title: 'Tailored strength', description: 'For this job.' }]);

  // Content written while a switch was off - a held preview sent back with a
  // batch, a queued task - has nothing for the section.
  const stale = prepareResumeRenderData(on, tailored({ softSkills: [], strengths: [] }));
  assert.deepEqual(stale.softSkills, ['Persistence', 'Clear writing']);
  assert.deepEqual(stale.strengths, [{ title: 'Foresight', description: 'Sees the failure before it ships.' }]);
});

test('the live preview groups only the skills entered; generation still pads an inferred grouping', () => {
  seeded('padding');
  const { prepareResumeRenderData } = require('../dist/generators/pdfGenerator');
  const claimed = ['c#', 'python', 'docker'];

  const preview = prepareResumeRenderData(profile(), undefined, undefined, undefined, { padSkillCategories: false });
  const shown = preview.skillCategories.flatMap((group) => group.skills).map((skill) => skill.toLowerCase());
  assert.deepEqual(shown.sort(), [...claimed].sort());
  assert.ok(preview.skillCategories.every((group) => group.category), 'still under headings');

  const generated = prepareResumeRenderData(profile());
  assert.ok(generated.skillCategories.flatMap((group) => group.skills).length > claimed.length, 'padded as before');
});

test('a link reaches an href only as http(s)', () => {
  seeded('links');
  const { prepareResumeRenderData } = require('../dist/generators/pdfGenerator');
  const linkedin = (value) =>
    prepareResumeRenderData(profile({}, { contact: { email: 'a', phone: '1', location: 'X', linkedin: value } }))
      .contact.linkedinHref;

  assert.equal(linkedin('linkedin.com/in/sam'), 'https://linkedin.com/in/sam');
  assert.equal(linkedin('http://linkedin.com/in/sam'), 'http://linkedin.com/in/sam');
  assert.equal(linkedin('HTTPS://www.linkedin.com/in/sam'), 'HTTPS://www.linkedin.com/in/sam');
  assert.equal(linkedin('www.linkedin.com:443/in/sam'), 'https://www.linkedin.com:443/in/sam', 'a host and port');
  for (const hostile of [
    'javascript:alert(1)',
    'JavaScript://%0aalert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
  ]) {
    assert.equal(linkedin(hostile), '', hostile);
  }

  const contact = prepareResumeRenderData(
    profile({}, {
      contact: { email: 'a', phone: '1', location: 'X', github: 'javascript:alert(1)', portfolio: 'example.dev/me' },
    })
  ).contact;
  assert.equal(contact.github, '', 'a hostile GitHub link is dropped');
  assert.equal(contact.portfolio, 'example.dev/me', 'a safe one is kept as written');

  // A browser deletes tab, LF and CR from an href before reading its scheme,
  // so a control character split inside `javascript:` must not get through
  // on the fields kept as typed, nor on LinkedIn.
  for (const split of [
    'java\tscript:443/alert(1)',
    'java\nscript:443/alert(1)',
    'java\rscript:443/alert(1)',
    'javascript\t:443/alert(1)',
    'java\u0000script:443/alert(1)',
  ]) {
    const links = prepareResumeRenderData(
      profile({}, { contact: { email: 'a', phone: '1', location: 'X', github: split, portfolio: split, linkedin: split } })
    ).contact;
    assert.equal(links.github, '', JSON.stringify(split));
    assert.equal(links.portfolio, '', JSON.stringify(split));
    assert.equal(links.linkedinHref, '', JSON.stringify(split));
  }
});

/* -------------------------------------------------------------- the DOCX */

test('the DOCX has Strengths and Soft Skills exactly when the PDF does', () => {
  seeded('docx');
  const { prepareResumeRenderData } = require('../dist/generators/pdfGenerator');
  const { buildResumeDocxHTML } = require('../dist/generators/docxGenerator');

  const off = buildResumeDocxHTML(prepareResumeRenderData(profile(), tailored()));
  assert.equal(off.includes('Key Strengths'), false);
  assert.equal(off.includes('Soft Skills'), false);
  assert.equal(off.includes('Negotiation') || off.includes('Persistence'), false);

  const on = buildResumeDocxHTML(
    prepareResumeRenderData(profile({ includeSoftSkills: true, includeStrengths: true }), tailored())
  );
  assert.match(on, /<u>Key Strengths<\/u>[\s\S]*<strong>Tailored strength<\/strong>: For this job\./);
  assert.match(on, /<u>Soft Skills<\/u><\/p>\s*<p[^>]*>Negotiation<\/p>/);
  assert.ok(on.indexOf('Key Strengths') < on.indexOf('Technical Skills'), 'Strengths after the summary');
  assert.ok(on.indexOf('Technical Skills') < on.indexOf('Soft Skills'), 'Soft Skills after Technical Skills');

  // Switched on with nothing to show: no heading over nothing.
  const empty = buildResumeDocxHTML(
    prepareResumeRenderData(
      profile({ includeSoftSkills: true, includeStrengths: true }, { softSkills: [], strengths: [] })
    )
  );
  assert.equal(empty.includes('Key Strengths') || empty.includes('Soft Skills'), false);
});

test('the DOCX lists technical skills by layout, and never folds soft skills into them', () => {
  seeded('docx-layout');
  const { prepareResumeRenderData } = require('../dist/generators/pdfGenerator');
  const { buildResumeDocxHTML } = require('../dist/generators/docxGenerator');
  // From the Technical Skills heading to the next heading, whichever it is.
  const technical = (html) => {
    const start = html.indexOf('<u>Technical Skills</u>');
    return html.slice(start, html.indexOf('<u>', start + 1));
  };

  const flat = technical(buildResumeDocxHTML(prepareResumeRenderData(profile({ technicalSkillsLayout: 'flat' }))));
  assert.equal((flat.match(/<p style="font-size: 9pt/g) ?? []).length, 1, 'flat is one paragraph');
  assert.equal(flat.includes('<strong>'), false, 'with no heading');

  const grouped = technical(buildResumeDocxHTML(prepareResumeRenderData(profile())));
  assert.ok((grouped.match(/<strong>[^<]+<\/strong><br>/g) ?? []).length > 1, 'grouped is a paragraph per heading');

  // The no-categories fallback once appended soft skills to this list.
  const fallback = buildResumeDocxHTML({
    ...prepareResumeRenderData(profile({ includeSoftSkills: true })),
    skillCategories: [],
    hardSkills: ['Python'],
  });
  assert.equal(technical(fallback).includes('Persistence'), false);
});

/* ------------------------------------------- the template decides, everywhere */

function shippedTemplate(id) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'static', 'templates', `${id}.json`), 'utf8'));
}

/** The rendered document after its stylesheets, so CSS naming a class is not read as content. */
function bodyOf(html) {
  return html.slice(html.lastIndexOf('</style>'));
}

test('one generation prints the same optional sections in the PDF and the DOCX, decided by its template', async () => {
  seeded('docx-template');
  const { generatePreviewHTML, prepareResumeRenderData } = require('../dist/generators/pdfGenerator');
  const { buildResumeDocxHTML } = require('../dist/generators/docxGenerator');
  const { profileForTemplate } = require('../dist/services/profileService');
  const on = profile({ includeSoftSkills: true, includeStrengths: true });

  for (const [id, strengths, softSkills] of [
    ['charcoal-sidebar', false, false],
    ['burgundy-rule', false, false],
    ['navy-rule', false, false],
    ['ink-ledger', true, false],
    ['default', true, true],
  ]) {
    const template = shippedTemplate(id);
    // generateResumeDOCX reads the profile through its template exactly so.
    const docx = buildResumeDocxHTML(prepareResumeRenderData(profileForTemplate(on, template), tailored()));
    const pdf = bodyOf(await generatePreviewHTML(on, template, tailored()));
    assert.equal(pdf.includes('Tailored strength'), strengths, `${id}: Strengths in the PDF`);
    assert.equal(docx.includes('Key Strengths'), strengths, `${id}: Strengths in the DOCX`);
    assert.equal(docx.includes('Tailored strength'), strengths, `${id}: Strengths in the DOCX`);
    assert.equal(pdf.includes('Negotiation'), softSkills, `${id}: Soft Skills in the PDF`);
    assert.equal(docx.includes('<u>Soft Skills</u>'), softSkills, `${id}: Soft Skills in the DOCX`);
  }
});

test('the DOCX prints no Technical Skills heading over an empty list', () => {
  seeded('docx-empty-skills');
  const { prepareResumeRenderData } = require('../dist/generators/pdfGenerator');
  const { buildResumeDocxHTML } = require('../dist/generators/docxGenerator');
  const html = buildResumeDocxHTML(prepareResumeRenderData(profile({ technicalSkillsLayout: 'flat' }, { skills: [] })));
  assert.equal(html.includes('Technical Skills'), false);
  assert.ok(html.includes('Professional Experience'), 'the rest of the document is still there');
});

test('a strength with no title draws no lone star, in either template that had one', async () => {
  seeded('strength-icon');
  const { generatePreviewHTML } = require('../dist/generators/pdfGenerator');
  const untitled = profile(
    { includeStrengths: true },
    {
      strengths: [
        { title: '', description: 'Only a description here.' },
        { title: 'Titled', description: '' },
      ],
    }
  );
  for (const id of ['default', 'azure-stack']) {
    const body = bodyOf(await generatePreviewHTML(untitled, shippedTemplate(id)));
    assert.ok(body.includes('Only a description here.'), `${id}: the description is kept`);
    assert.equal((body.match(/class="strength-icon"/g) ?? []).length, 1, `${id}: one star, beside the one title`);
    assert.equal((body.match(/class="strength-description"/g) ?? []).length, 1, `${id}: no empty description`);
    assert.doesNotMatch(body, /<span class="strength-title">\s*<\/span>/, id);
  }
});

test('only the Technical Skills lines become heading blocks, never a strength or soft skill that looks like one', async () => {
  seeded('category-lines');
  const { generatePreviewHTML } = require('../dist/generators/pdfGenerator');
  const lookalikes = profile(
    { includeStrengths: true, includeSoftSkills: true },
    {
      strengths: [{ title: 'Multilingual', description: 'Languages: English and Spanish, both fluent.' }],
      softSkills: ['Languages: English, Spanish', 'Tools: Jira and Confluence', 'Communication'],
    }
  );
  for (const layout of ['categorized', 'flat']) {
    for (const id of ['default', 'azure-stack']) {
      const subject = { ...lookalikes, profileSettings: { ...lookalikes.profileSettings, technicalSkillsLayout: layout } };
      const body = bodyOf(await generatePreviewHTML(subject, shippedTemplate(id)));
      const where = `${id} / ${layout}`;
      assert.match(
        body,
        /<div class="strength-description">Languages: English and Spanish, both fluent\.<\/div>/,
        `${where}: the strength keeps its own markup`
      );
      assert.match(body, /<div class="skill-box">Languages: English, Spanish<\/div>/, `${where}: the soft skill too`);
      assert.match(body, /<div class="skill-box">Tools: Jira and Confluence<\/div>/, where);
      assert.doesNotMatch(body, /skill-category-title">(Languages|Tools)<\/div><div class="skill-category-skills">(English|Jira)/, where);
    }
  }

  // A template that prints the categorized lines through a loop the compile
  // step leaves alone still gets its heading blocks.
  const { generatePreviewHTML: render } = require('../dist/generators/pdfGenerator');
  const lines = {
    id: 'lines',
    name: 'Lines',
    htmlContent: '<div class="skills">{{#each hardSkills}}<span class="line">{{this}}</span>{{/each}}</div>',
    cssContent: '',
    sections: [],
    createdAt: '',
    updatedAt: '',
  };
  const html = await render(profile(), lines);
  assert.match(
    html,
    /<div class="skill-category"><div class="skill-category-title">[^<]+<\/div><div class="skill-category-skills">[^<]*Python/
  );
});
