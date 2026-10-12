const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { useTempStorage } = require('./helpers');

/**
 * A TAILORED resume as every output prints it, against what the tailoring
 * prompt promises about the page:
 *
 *   - the skills block "is printed exactly as you return it": Grouped prints
 *     the model's `skillGroups` as they stand, Plain the same skills as one
 *     list, same order, repeats removed - nothing padded, filtered or
 *     reordered from the skill library;
 *   - the last group, the posting's soft skills, goes to the Soft Skills
 *     section while that switch is on (as the template leaves it) and stays in
 *     the block while it is off;
 *   - Strengths are the profile's own; the model writes none;
 *   - a role's description "is discarded before the resume is printed", and
 *     no template leaves an empty box where it would have been;
 *   - "anything past the eighth bullet is DISCARDED";
 *   - the title is printed as composed, separators and all;
 *
 * in every built-in, both layouts it offers, both switch states, and in the
 * DOCX; and the gallery's sample is drawn the same way.
 */

const SHIPPED = path.join(__dirname, '..', 'static');
const TEMPLATES_DIR = path.join(SHIPPED, 'templates');

function seeded(name) {
  const storage = useTempStorage(`tailored-render-${name}`);
  fs.cpSync(path.join(SHIPPED, 'skills'), path.join(storage.staticDir, 'skills'), { recursive: true });
  return storage;
}

function shippedTemplates() {
  return fs
    .readdirSync(TEMPLATES_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, file), 'utf8')));
}

/** The rendered document after its stylesheets, so CSS naming a class is not read as content. */
function bodyOf(html) {
  return html.slice(html.lastIndexOf('</style>'));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** As Handlebars prints text. */
function escaped(text) {
  return text.replace(/&/g, '&amp;');
}

/** How many elements hold exactly this text and nothing else. */
function wholeItems(html, text) {
  return (html.match(new RegExp(`>\\s*${escapeRegExp(escaped(text))}\\s*<`, 'g')) ?? []).length;
}

function occurrences(html, text) {
  return html.split(escaped(text)).length - 1;
}

/** The skills in this order, one joined list (", " or " · "), inside one element. */
function inOneList(html, skills) {
  return new RegExp(skills.map((skill) => escapeRegExp(escaped(skill))).join('\\s*(?:,|·)\\s*')).test(html);
}

const SOFT_HEADING = 'Collaboration & Communication';

/**
 * A model's block: headings the library never had, a skill the library does
 * not know, a concept the old gate threw out, a repeat across two groups, and
 * the soft-skill group last under the drawn heading.
 */
const MODEL_GROUPS = [
  { category: 'Languages', skills: ['Go', 'Python', 'TypeScript'] },
  { category: 'CI/CD & Automation', skills: ['GitHub Actions', 'Argo CD', 'CI/CD', 'Python'] },
  { category: 'Observability Stack', skills: ['Honeycomb', 'OpenTelemetry'] },
  { category: SOFT_HEADING, skills: ['Mentoring', 'Ownership', 'Stakeholder alignment'] },
];
const TECHNICAL = MODEL_GROUPS.slice(0, -1);
const SOFT = MODEL_GROUPS[MODEL_GROUPS.length - 1];
const PLAIN = ['Go', 'Python', 'TypeScript', 'GitHub Actions', 'Argo CD', 'CI/CD', 'Honeycomb', 'OpenTelemetry'];

const BULLETS = [
  'First bullet about the ledger',
  'Second bullet about the queue',
  'Third bullet about the cache',
  'Fourth bullet about the index',
  'Fifth bullet about the deploy',
  'Sixth bullet about the pager',
  'Seventh bullet about the schema',
  'Eighth bullet about the review',
  'Ninth bullet that is discarded',
  'Tenth bullet that is discarded',
];

const TITLE = 'Software Engineer (AI/ML Engineer)';

function profile(settings = {}, extra = {}) {
  return {
    id: 'p-render',
    name: 'Ada Example',
    title: 'Software Engineer',
    contact: { email: 'ada@example.com', phone: '1', location: 'X' },
    summary: 'Her own summary.',
    experience: [
      {
        title: 'Engineer',
        company: 'Acme',
        startDate: '2020',
        endDate: 'Present',
        location: 'Remote',
        description: 'Her own description of the role.',
        achievements: ['Her own bullet.'],
        skills: [],
      },
    ],
    strengths: [{ title: 'Foresight', description: 'Sees the failure before it ships.' }],
    softSkills: ['Persistence'],
    education: [],
    skills: ['C#', 'Python', 'Docker'],
    profileSettings: settings,
    createdAt: '',
    updatedAt: '',
    ...extra,
  };
}

function modelContent(extra = {}) {
  return {
    title: TITLE,
    summary: 'The tailored summary.',
    experience: [
      {
        title: 'Engineer',
        company: 'Acme',
        startDate: '2020',
        endDate: 'Present',
        location: 'Remote',
        description: 'A description the model wrote anyway.',
        achievements: BULLETS,
      },
    ],
    skillGroups: MODEL_GROUPS,
    softSkillGroupHeading: SOFT_HEADING,
    skills: PLAIN,
    hardSkills: PLAIN,
    softSkills: SOFT.skills,
    unconfirmedSoftSkills: [],
    unconfirmedHardSkills: [],
    strengths: [{ title: 'Model strength', description: 'Written for this job.' }],
    ...extra,
  };
}

/* ------------------------------------------------------------- the data */

test('Grouped prints the model groups as they stand; Plain the same skills once, in order', () => {
  seeded('data');
  const { prepareResumeRenderData } = require('../dist/generators/pdfGenerator');

  const grouped = prepareResumeRenderData(profile(), modelContent());
  assert.deepEqual(grouped.skillCategories, MODEL_GROUPS, 'every group, the soft one last, with Soft Skills off');
  assert.equal(grouped.hardSkills[1], 'CI/CD & Automation: GitHub Actions, Argo CD, CI/CD, Python');
  assert.deepEqual(grouped.skills, grouped.hardSkills);

  const plain = prepareResumeRenderData(profile({ technicalSkillsLayout: 'flat' }), modelContent());
  assert.deepEqual(plain.skillCategories, [{ category: '', skills: [...PLAIN, ...SOFT.skills] }]);
  assert.deepEqual(plain.hardSkills, [...PLAIN, ...SOFT.skills], 'one entry per skill');
});

test('the soft-skill group goes to the Soft Skills section while the switch is on, and never twice', () => {
  seeded('routing');
  const { prepareResumeRenderData } = require('../dist/generators/pdfGenerator');

  const grouped = prepareResumeRenderData(profile({ includeSoftSkills: true }), modelContent());
  assert.deepEqual(grouped.skillCategories, TECHNICAL);
  assert.deepEqual(grouped.softSkills, SOFT.skills, "the posting's soft skills, not her own");

  const plain = prepareResumeRenderData(
    profile({ includeSoftSkills: true, technicalSkillsLayout: 'flat' }),
    modelContent()
  );
  assert.deepEqual(plain.hardSkills, PLAIN);
  assert.deepEqual(plain.softSkills, SOFT.skills);

  // Off, the section prints nothing and the group stays in the block.
  const off = prepareResumeRenderData(profile(), modelContent());
  assert.deepEqual(off.softSkills, []);

  // The mark the parse leaves finds the group after its heading was edited.
  const renamed = MODEL_GROUPS.map((group, index) =>
    index === MODEL_GROUPS.length - 1 ? { ...group, category: 'People', soft: true } : group
  );
  const marked = prepareResumeRenderData(
    profile({ includeSoftSkills: true }),
    modelContent({ skillGroups: renamed, softSkillGroupHeading: undefined })
  );
  assert.deepEqual(marked.skillCategories, TECHNICAL);
  assert.deepEqual(marked.softSkills, SOFT.skills);

  // No soft group found: nothing leaves the block, and the section falls back
  // to the content's list, else her own - never empty when she asked for it.
  const noSoft = prepareResumeRenderData(
    profile({ includeSoftSkills: true }),
    modelContent({ skillGroups: TECHNICAL, softSkills: [] })
  );
  assert.deepEqual(noSoft.skillCategories, TECHNICAL);
  assert.deepEqual(noSoft.softSkills, ['Persistence']);
});

test('nothing in the block comes from, or is held to, the skill library', () => {
  seeded('library');
  const { prepareResumeRenderData } = require('../dist/generators/pdfGenerator');
  const groups = [
    { category: 'Odd Headings', skills: ['AI coding tools', 'Accuracy', 'Microservices', 'Agile'] },
    { category: 'Languages', skills: ['Go'] },
  ];
  for (const layout of ['categorized', 'flat']) {
    const data = prepareResumeRenderData(
      profile({ technicalSkillsLayout: layout }, { skillCategories: [{ category: 'Mine', skills: ['C#', 'Python', 'Docker'] }] }),
      modelContent({ skillGroups: groups })
    );
    const printed = data.skillCategories.flatMap((group) => group.skills);
    assert.deepEqual(printed, ['AI coding tools', 'Accuracy', 'Microservices', 'Agile', 'Go'], layout);
    assert.equal(
      data.skillCategories.some((group) => group.category === 'Mine'),
      false,
      `${layout}: the model's block beats the profile's own grouping`
    );
  }
});

test('a block left with nothing to print is the profile\'s own skills, unpadded', () => {
  seeded('fallback');
  const { prepareResumeRenderData } = require('../dist/generators/pdfGenerator');
  const ownOnly = (data) => data.skillCategories.flatMap((group) => group.skills).map((skill) => skill.toLowerCase()).sort();

  // Only the soft group came back, and the switch moved it.
  const onlySoft = prepareResumeRenderData(profile({ includeSoftSkills: true }), modelContent({ skillGroups: [SOFT] }));
  assert.deepEqual(ownOnly(onlySoft), ['c#', 'docker', 'python']);
  assert.deepEqual(onlySoft.softSkills, SOFT.skills);

  // No skills of any kind: content from a prompt that never asked for them.
  const none = prepareResumeRenderData(
    profile(),
    modelContent({ skillGroups: [{ category: 'Junk', skills: ['', 7] }], hardSkills: [], skills: [] })
  );
  assert.deepEqual(ownOnly(none), ['c#', 'docker', 'python']);
});

test('content from before the model wrote the block prints its own list, unpadded (Plain unfiltered, Grouped under the library)', () => {
  seeded('legacy');
  const { prepareResumeRenderData } = require('../dist/generators/pdfGenerator');
  const legacy = {
    ...modelContent(),
    skillGroups: undefined,
    softSkillGroupHeading: undefined,
    hardSkills: ['Go', 'Python', 'CI/CD', 'PostgreSQL'],
    skills: ['Go', 'Python', 'CI/CD', 'PostgreSQL'],
  };
  const plain = prepareResumeRenderData(profile({ technicalSkillsLayout: 'flat' }), legacy);
  assert.deepEqual(plain.hardSkills, ['Go', 'Python', 'CI/CD', 'PostgreSQL'], 'as given, CI/CD included');

  const grouped = prepareResumeRenderData(profile(), legacy);
  const printed = grouped.skillCategories.flatMap((group) => group.skills);
  assert.ok(printed.length <= 4, `padded to ${printed.length}: ${printed.join(', ')}`);
  for (const skill of printed) assert.ok(legacy.hardSkills.includes(skill), `${skill} was never in the content`);
  assert.ok(grouped.skillCategories.every((group) => group.category), 'under the library headings');
});

/**
 * What README and CLAUDE.md say the library still does, held to the code: it
 * never pads a block and never touches the model's, but an untailored block,
 * and an older content's Grouped list, are filed under its headings in its
 * heading order and keep only the skills it knows - except under the
 * author's own headings - while an older content's Plain list prints whole.
 */
test("the skill library files and filters only an untailored or older Grouped block, and pads none", () => {
  seeded('library-scope');
  const { prepareResumeRenderData } = require('../dist/generators/pdfGenerator');
  const skills = ['Docker', 'Frobnicator 9000', 'TypeScript', 'Kubernetes'];
  const printed = (data) => data.skillCategories.flatMap((group) => group.skills);

  // Untailored, Grouped with nothing assigned by hand: the library's headings,
  // Languages before DevOps whatever order the skills were typed in, and the
  // skill it never heard of left off.
  const grouped = prepareResumeRenderData(profile({}, { skills }));
  assert.equal(grouped.skillCategories[0].category, 'Languages');
  assert.deepEqual(grouped.skillCategories[0].skills, ['TypeScript']);
  assert.deepEqual(printed(grouped).slice().sort(), ['Docker', 'Kubernetes', 'TypeScript']);

  // Untailored, Plain: the same library-known skills, in the person's order.
  const plain = prepareResumeRenderData(profile({ technicalSkillsLayout: 'flat' }, { skills }));
  assert.deepEqual(printed(plain), ['Docker', 'TypeScript', 'Kubernetes']);

  // Untailored, Grouped under the author's headings: every skill, as typed.
  const authored = prepareResumeRenderData(
    profile({}, { skills, skillCategories: [{ category: 'Mine', skills }] })
  );
  assert.deepEqual(authored.skillCategories, [{ category: 'Mine', skills }]);

  // Older tailored content: Plain prints its list whole; Grouped files it.
  const legacy = { ...modelContent(), skillGroups: undefined, softSkillGroupHeading: undefined, hardSkills: skills, skills };
  assert.deepEqual(prepareResumeRenderData(profile({ technicalSkillsLayout: 'flat' }), legacy).hardSkills, skills);
  const legacyGrouped = prepareResumeRenderData(profile(), legacy);
  assert.equal(legacyGrouped.skillCategories[0].category, 'Languages');
  assert.equal(printed(legacyGrouped).includes('Frobnicator 9000'), false);

  // The model's block is never filed or filtered, in either layout.
  for (const layout of ['categorized', 'flat']) {
    const model = prepareResumeRenderData(
      profile({ technicalSkillsLayout: layout }, { skills }),
      modelContent({ skillGroups: [{ category: 'Stack', skills }] })
    );
    assert.deepEqual(printed(model), skills, layout);
  }
});

test("Strengths are the profile's own, whatever the content carries", () => {
  seeded('strengths');
  const { prepareResumeRenderData } = require('../dist/generators/pdfGenerator');
  const on = prepareResumeRenderData(profile({ includeStrengths: true }), modelContent());
  assert.deepEqual(on.strengths, [{ title: 'Foresight', description: 'Sees the failure before it ships.' }]);
  assert.deepEqual(prepareResumeRenderData(profile(), modelContent()).strengths, []);
});

test('a tailored role prints no description and at most eight bullets', () => {
  seeded('roles');
  const { prepareResumeRenderData } = require('../dist/generators/pdfGenerator');
  const data = prepareResumeRenderData(profile(), modelContent());
  assert.equal(data.experience[0].description, '');
  assert.deepEqual(data.experience[0].achievements, BULLETS.slice(0, 8));
  assert.equal(data.experience[0].company, 'Acme');

  // Odd held content renders rather than failing.
  const odd = prepareResumeRenderData(
    profile(),
    modelContent({ experience: [{ title: 'T', company: 'C', achievements: ['Kept', 7, '', null] }, null, 'x'] })
  );
  assert.deepEqual(odd.experience, [{ title: 'T', company: 'C', description: '', achievements: ['Kept'] }]);
  assert.deepEqual(prepareResumeRenderData(profile(), modelContent({ experience: 'not a list' })).experience, []);

  // Untailored, the person's own description is theirs to print.
  assert.equal(prepareResumeRenderData(profile()).experience[0].description, 'Her own description of the role.');
});

test('the title is printed as composed: separators kept, other symbols dropped', () => {
  seeded('title');
  const { prepareResumeRenderData } = require('../dist/generators/pdfGenerator');
  const title = (value, tailored = true) =>
    tailored
      ? prepareResumeRenderData(profile(), modelContent({ title: value })).title
      : prepareResumeRenderData(profile({}, { title: value })).title;

  for (const kept of [
    'Senior Software Engineer | Cloud Engineer',
    'Software Engineer (AI/ML Engineer)',
    'Software Engineer, Platform Engineer',
    'Software Engineer / Data Engineer',
    'Software Engineer · Site Reliability Engineer',
    'Software Engineer & Backend Engineer',
    'C# Developer',
    'C++ and Node.js Engineer',
    'Full-Stack Engineer',
    'Ingénieur Logiciel',
  ]) {
    assert.equal(title(kept), kept, kept);
    assert.equal(title(kept, false), kept, `${kept} (untailored)`);
  }
  assert.equal(title('Engineer: "Platform" @ Acme [remote] 100%'), 'Engineer Platform Acme remote 100');
  assert.equal(title('  '), 'Software Engineer', "a blank tailored title is the profile's headline");
});

/* --------------------------------------------------------- the built-ins */

test('every built-in prints a tailored resume as promised, in each layout and both switch states', async () => {
  seeded('built-ins');
  const { generatePreviewHTML } = require('../dist/generators/pdfGenerator');
  const { inferTemplateCapabilities } = require('../dist/services/templateImport');

  const templates = shippedTemplates();
  assert.equal(templates.length, 19, 'the whole set, not a sample');
  for (const template of templates) {
    const { supportsSoftSkills, supportsStrengths } = inferTemplateCapabilities(template.htmlContent);
    const perItem = /\{\{#each\s+(?:hardSkills|skills)\s*\}\}/.test(template.htmlContent);
    for (const layout of template.skillsLayouts) {
      for (const softOn of [false, true]) {
        const label = `${template.id} (${layout}, soft ${softOn ? 'on' : 'off'})`;
        const settings = { technicalSkillsLayout: layout, includeSoftSkills: softOn, includeStrengths: true };
        const body = bodyOf(await generatePreviewHTML(profile(settings), template, modelContent()));
        const routed = softOn && supportsSoftSkills;

        if (layout === 'categorized') {
          for (const group of TECHNICAL) {
            assert.equal(wholeItems(body, group.category), 1, `${label}: heading "${group.category}" once`);
            assert.ok(inOneList(body, group.skills), `${label}: ${group.category}'s skills in order, under it`);
          }
          // The soft group is a heading of the block exactly when it is not routed.
          assert.equal(wholeItems(body, SOFT.category), routed ? 0 : 1, `${label}: soft heading in the block`);
          if (!routed) assert.ok(inOneList(body, SOFT.skills), `${label}: soft skills under their heading`);
        } else {
          for (const group of TECHNICAL) {
            assert.equal(wholeItems(body, group.category), 0, `${label}: no heading "${group.category}"`);
          }
          assert.equal(wholeItems(body, SOFT.category), 0, `${label}: no soft heading`);
          const listed = routed ? PLAIN : [...PLAIN, ...SOFT.skills];
          if (perItem) {
            for (const skill of PLAIN) assert.equal(wholeItems(body, skill), 1, `${label}: "${skill}" one item`);
          } else {
            assert.ok(inOneList(body, listed), `${label}: one list, in order`);
          }
          assert.equal(occurrences(body, 'Python'), 1, `${label}: the repeat removed`);
        }

        // Every soft skill printed exactly once: in the section, or in the block.
        for (const skill of SOFT.skills) assert.equal(occurrences(body, skill), 1, `${label}: "${skill}" once`);
        assert.equal(body.includes('Persistence'), false, `${label}: not her own soft skills`);

        assert.equal(body.includes('Foresight'), supportsStrengths, `${label}: her own strengths`);
        assert.equal(body.includes('Model strength'), false, `${label}: never a model's`);

        assert.ok(body.includes(TITLE), `${label}: the title as composed`);
        assert.equal(body.includes('A description the model wrote anyway'), false, `${label}: no description`);
        assert.doesNotMatch(body, /class="(?:experience-desc|exp-desc|description)"/, `${label}: an empty description box`);
        for (const bullet of BULLETS.slice(0, 8)) assert.ok(body.includes(bullet), `${label}: ${bullet}`);
        assert.equal(body.includes('Ninth bullet'), false, `${label}: the ninth bullet`);
        assert.equal(body.includes('{{'), false, `${label}: unrendered Handlebars`);
      }
    }
  }
});

test('an untailored role keeps its description, and an uploaded template is guarded too', async () => {
  seeded('description-guard');
  const { generatePreviewHTML } = require('../dist/generators/pdfGenerator');
  const own = bodyOf(await generatePreviewHTML(profile(), shippedTemplates().find((t) => t.id === 'default')));
  assert.match(own, /<div class="description">Her own description of the role\.<\/div>/);

  const uploaded = {
    id: 'uploaded',
    name: 'Uploaded',
    htmlContent:
      '{{#each experience}}<section><h3>{{company}}</h3><p class="role-brief">  {{description}}  </p>' +
      '{{#if description}}<em class="kept">{{description}}</em>{{/if}}<ul>{{#each achievements}}<li>{{this}}</li>{{/each}}</ul></section>{{/each}}',
    cssContent: '',
  };
  const tailored = await generatePreviewHTML(profile(), uploaded, modelContent());
  assert.equal(tailored.includes('role-brief'), false, 'an element holding only the description goes with it');
  assert.equal(tailored.includes('class="kept"'), false);
  const untailored = await generatePreviewHTML(profile(), uploaded);
  assert.match(untailored, /<p class="role-brief">Her own description of the role\.<\/p>/);
  assert.equal((untailored.match(/class="kept"/g) ?? []).length, 1, 'an element already guarded is not guarded twice');
});

test('the description guard never stops a template that compiles on its own from rendering', async (t) => {
  seeded('description-guard-cut');
  const Handlebars = require('handlebars');
  const { generatePreviewHTML } = require('../dist/generators/pdfGenerator');
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));

  const roles = (inner) =>
    `<h1>{{name}}</h1>{{#each experience}}<div class="role">${inner}` +
    '<ul>{{#each achievements}}<li>{{this}}</li>{{/each}}</ul></div>{{/each}}';
  const templates = [
    // A block opened inside the element and closed after it, beside an
    // ordinary wrapper that is still guarded.
    {
      id: 'cut-after',
      inner: '<p class="desc">{{#if description}}{{description}}</p>{{/if}}<div class="brief">{{description}}</div>',
      guarded: 'brief',
    },
    // A block opened before the element and closed inside it.
    { id: 'cut-before', inner: '{{#if description}}<em>x</em><p class="desc">{{description}}{{/if}}</p>' },
    // A block opened inside the element's own tag: any guard around the element
    // would cross it, so the markup is kept as written.
    { id: 'cut-in-tag', inner: '<p {{#with this}}class="desc">{{description}}</p>{{/with}}' },
  ];

  for (const { id, inner, guarded } of templates) {
    const template = { id, name: id, htmlContent: roles(inner), cssContent: '' };
    assert.doesNotThrow(() => Handlebars.precompile(template.htmlContent), `${id} parses on its own`);

    const untailored = await generatePreviewHTML(profile(), template);
    assert.ok(untailored.includes('Her own description of the role.'), `${id}: the profile's description prints`);
    assert.ok(untailored.includes('<li>Her own bullet.</li>'), id);

    const tailored = await generatePreviewHTML(profile(), template, modelContent());
    assert.ok(tailored.includes(`<li>${BULLETS[0]}</li>`), `${id}: the tailored resume renders`);
    assert.equal(tailored.includes('A description the model wrote anyway.'), false, id);
    if (guarded) assert.equal(tailored.includes(`class="${guarded}"`), false, `${id}: the ordinary wrapper is still guarded`);
  }
  assert.deepEqual(
    warnings.filter((line) => line.includes('[templates]')),
    [],
    'no Strengths / Soft Skills fallback is logged for a template with neither section'
  );
});

test('a model heading becomes a heading block on a template that prints the lines itself', async () => {
  seeded('line-breaks');
  const { generatePreviewHTML } = require('../dist/generators/pdfGenerator');
  const lines = {
    id: 'lines',
    name: 'Lines',
    htmlContent: '<div class="skills">{{#each hardSkills}}<span class="line">{{this}}</span>{{/each}}</div>',
    cssContent: '',
  };
  const html = await generatePreviewHTML(profile(), lines, modelContent());
  for (const group of MODEL_GROUPS) {
    assert.ok(
      html.includes(
        `<div class="skill-category"><div class="skill-category-title">${escaped(group.category)}</div>` +
          `<div class="skill-category-skills">${escaped(group.skills.join(', '))}</div></div>`
      ),
      group.category
    );
  }
});

/* --------------------------------------------------------------- the DOCX */

test('the DOCX prints the same tailored resume: title, model groups, routed soft skills, no empty description', () => {
  seeded('docx');
  const { prepareResumeRenderData } = require('../dist/generators/pdfGenerator');
  const { buildResumeDocxHTML } = require('../dist/generators/docxGenerator');
  const technical = (html) => {
    const start = html.indexOf('<u>Technical Skills</u>');
    return html.slice(start, html.indexOf('<u>', start + 1));
  };

  const off = buildResumeDocxHTML(prepareResumeRenderData(profile(), modelContent()));
  assert.ok(off.includes(`>${TITLE}</p>`), 'the title as composed');
  for (const group of MODEL_GROUPS) {
    assert.ok(
      technical(off).includes(`<strong>${escaped(group.category)}</strong><br>${escaped(group.skills.join(', '))}`),
      group.category
    );
  }
  assert.equal(off.includes('<u>Soft Skills</u>'), false);
  // Dates, then straight into the bullets: no empty paragraph between.
  assert.match(off, /2020 – Present • Remote<\/p>\s*<p[^>]*>- First bullet/);
  assert.equal(off.includes('A description the model wrote anyway'), false);
  assert.equal(off.includes('Ninth bullet'), false);

  const on = buildResumeDocxHTML(
    prepareResumeRenderData(profile({ includeSoftSkills: true, includeStrengths: true }), modelContent())
  );
  assert.equal(technical(on).includes(escaped(SOFT.category)), false, 'the soft group left the block');
  assert.match(on, new RegExp(`<u>Soft Skills</u></p>\\s*<p[^>]*>${SOFT.skills.join(', ')}</p>`));
  assert.match(on, /<strong>Foresight<\/strong>: Sees the failure before it ships\./);
  assert.equal(on.includes('Model strength'), false);

  const plain = technical(
    buildResumeDocxHTML(prepareResumeRenderData(profile({ technicalSkillsLayout: 'flat' }), modelContent()))
  );
  assert.equal(plain.includes('<strong>'), false);
  assert.ok(plain.includes(escaped([...PLAIN, ...SOFT.skills].join(', '))));

  // Untailored, a role's own description keeps its paragraph.
  assert.match(buildResumeDocxHTML(prepareResumeRenderData(profile())), /<p[^>]*>Her own description of the role\.<\/p>/);
});

/* ------------------------------------------------------------ the gallery */

test('the gallery draws the sample person tailored, the way a generated resume prints', async () => {
  seeded('gallery');
  const { generateTemplatePreviewHTML } = require('../dist/generators/pdfGenerator');
  const { SAMPLE_PROFILE, SAMPLE_TAILORED_CONTENT } = require('../dist/services/sampleProfile');
  const { findSoftSkillGroup } = require('../dist/services/skillGroups');
  const { inferTemplateCapabilities } = require('../dist/services/templateImport');

  // The sample is itself what a tailored answer looks like.
  const groups = SAMPLE_TAILORED_CONTENT.skillGroups;
  const softAt = findSoftSkillGroup(groups, SAMPLE_TAILORED_CONTENT.softSkillGroupHeading);
  assert.equal(softAt, groups.length - 1, 'the soft group is last');
  assert.equal(groups[softAt].soft, true);
  assert.ok(groups.length >= 4 && groups.length <= 7);
  for (const role of SAMPLE_TAILORED_CONTENT.experience) {
    assert.equal(role.description, '');
    assert.ok(role.achievements.length >= 1 && role.achievements.length <= 8, role.company);
    assert.ok(SAMPLE_PROFILE.experience.some((own) => own.company === role.company && own.title === role.title));
  }

  // The gallery appends its page chrome as a last stylesheet; the resume is what is before it.
  const galleryBody = (html) => bodyOf(html.replace(/<style id="resume-preview-page">[\s\S]*$/, ''));
  const soft = groups[softAt];
  for (const template of shippedTemplates()) {
    const body = galleryBody(generateTemplatePreviewHTML(template));
    assert.ok(body.includes(escaped(SAMPLE_TAILORED_CONTENT.title)), `${template.id}: the composed title`);
    assert.equal(body.includes(SAMPLE_PROFILE.experience[0].description), false, `${template.id}: no description`);
    assert.doesNotMatch(body, /class="(?:experience-desc|exp-desc|description)"/, `${template.id}: no empty box`);
    assert.equal(wholeItems(body, groups[0].category), 1, `${template.id}: the model's headings`);
    assert.equal(wholeItems(body, soft.category), 1, `${template.id}: Soft Skills off keeps the group in the block`);

    const { supportsSoftSkills, supportsStrengths } = inferTemplateCapabilities(template.htmlContent);
    const both = galleryBody(generateTemplatePreviewHTML(template, { softSkills: true, strengths: true }));
    assert.equal(wholeItems(both, soft.category), supportsSoftSkills ? 0 : 1, `${template.id}: routed only where it fits`);
    assert.ok(both.includes(soft.skills[0]), `${template.id}: the soft skills still print`);
    assert.equal(both.includes(SAMPLE_PROFILE.strengths[0].title), supportsStrengths, `${template.id}: own strengths`);
  }
});

/* ------------------------------------------------------- the cover letter */

test('a cover letter keeps its paragraphs whether the model separated them with a blank line or one newline', () => {
  const { splitCoverLetterParagraphs } = require('../dist/generators/coverLetterGenerator');
  assert.deepEqual(splitCoverLetterParagraphs('I build things.\nThey work.\nI would like to build yours.'), [
    'I build things.',
    'They work.',
    'I would like to build yours.',
  ]);
  assert.deepEqual(
    splitCoverLetterParagraphs('I build things\nthat work.\n\nThey work.\r\n\r\nI would like to build yours.\n'),
    ['I build things that work.', 'They work.', 'I would like to build yours.'],
    'with a blank line, a single newline is only a wrap'
  );
  assert.deepEqual(splitCoverLetterParagraphs('   '), []);
});
