const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { prepareResumeRenderData, generatePreviewHTML } = require('../dist/generators/pdfGenerator');

const TEMPLATES_DIR = path.join(__dirname, '..', 'static', 'templates');

function templateNamed(id) {
  return JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, `${id}.json`), 'utf8'));
}

/** The built-in templates' ids: the files without a `source` - a saved template beside them is an administrator's. */
function builtInIds() {
  return fs
    .readdirSync(TEMPLATES_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.replace(/\.json$/, ''))
    .filter((id) => !templateNamed(id).source);
}

function profile(extra = {}) {
  return {
    id: 'p1',
    name: 'A Person',
    title: 'Engineer',
    contact: { email: 'a@b.c', phone: '1', location: 'X' },
    summary: 'A summary.',
    experience: [],
    strengths: [],
    education: [],
    certifications: [],
    skills: ['C#', 'Python', 'C', 'Angular', 'Vault', 'Azure', 'Keras'],
    createdAt: '',
    updatedAt: '',
    ...extra,
  };
}

test('the flat layout renders skill names, not headings', () => {
  const data = prepareResumeRenderData(profile({ profileSettings: { technicalSkillsLayout: 'flat' } }));
  assert.equal(data.skillCategories.length, 1, 'one group, so every template keeps its single loop');
  assert.equal(data.skillCategories[0].category, '', 'and that group has no heading');

  // One entry per skill, not one entry holding the whole list behind a colon.
  // A template that renders a chip per entry has to produce a chip per SKILL.
  assert.deepEqual(data.hardSkills, data.skillCategories[0].skills);
  for (const line of data.hardSkills) {
    assert.doesNotMatch(line, /:/, `"${line}" still carries a heading`);
  }
});

test('the flat layout does not pad the list with skills the profile never claimed', () => {
  // The padding rules exist to make a CATEGORIZED block look right - five per
  // heading, at least five headings. A list with no headings has no such shape
  // to fill, and filling it anyway invents claims on somebody's resume.
  const claimed = profile().skills.map((skill) => skill.toLowerCase());
  const data = prepareResumeRenderData(profile({ profileSettings: { technicalSkillsLayout: 'flat' } }));
  for (const skill of data.skillCategories[0].skills) {
    assert.ok(
      claimed.includes(skill.toLowerCase()),
      `"${skill}" is on the resume but not in the profile`
    );
  }
});

test('the categorized layout puts each skill under its library heading, and adds none', () => {
  // It used to fill an inferred block out to five headings of five from the
  // library. Nothing pads a block now, on any path.
  const data = prepareResumeRenderData(profile());
  assert.ok(data.skillCategories.length > 1);
  assert.equal(data.skillCategories[0].category, 'Languages');
  assert.match(data.hardSkills[0], /^Languages: /);
  const claimed = profile().skills.map((skill) => skill.toLowerCase()).sort();
  const shown = data.skillCategories.flatMap((group) => group.skills).map((skill) => skill.toLowerCase()).sort();
  assert.deepEqual(shown, claimed);
});

test("a profile's own grouping beats the library's guess", () => {
  // The library has no idea that a particular person's Vault is infrastructure
  // rather than a library. Somebody who says so has to be believed.
  const inferred = prepareResumeRenderData(profile());
  const guessed = inferred.skillCategories.find((group) => group.skills.includes('Vault'));
  assert.equal(guessed.category, 'Frameworks and Libraries', 'what the library guesses today');

  const authored = prepareResumeRenderData(
    profile({
      skillCategories: [
        { category: 'Languages', skills: ['C#', 'Python', 'C'] },
        { category: 'Cloud and Infrastructure', skills: ['Vault', 'Azure'] },
      ],
    })
  );
  const placed = authored.skillCategories.find((group) => group.skills.includes('Vault'));
  assert.equal(placed.category, 'Cloud and Infrastructure');
});

test("a tailored resume's own skill groups beat the profile's grouping", () => {
  // The model writes the block for the posting; the author's headings decide
  // an untailored render only.
  const authored = profile({ skillCategories: [{ category: 'Languages', skills: ['C#', 'Python', 'C'] }] });
  const data = prepareResumeRenderData(authored, {
    title: 'Engineer',
    summary: 'S',
    experience: [],
    skills: [],
    hardSkills: [],
    softSkills: [],
    strengths: [],
    skillGroups: [
      { category: 'Back End', skills: ['Python', 'Go'] },
      { category: 'Security', skills: ['Vault'] },
    ],
  });
  assert.deepEqual(data.skillCategories, [
    { category: 'Back End', skills: ['Python', 'Go'] },
    { category: 'Security', skills: ['Vault'] },
  ]);
});

test('a skill the author never placed still reaches the resume', () => {
  // Under the library's heading for it, appended after the author's own order -
  // dropping it would mean grouping your skills quietly deleted the ones you
  // had not got round to.
  const data = prepareResumeRenderData(
    profile({ skillCategories: [{ category: 'Languages', skills: ['C#'] }] })
  );
  const all = data.skillCategories.flatMap((group) => group.skills);
  assert.ok(all.includes('Keras'), 'an unplaced skill must not vanish');
  assert.equal(data.skillCategories[0].category, 'Languages', "the author's order leads");
});

test("the author's headings are not padded to a count they never chose", () => {
  // The five-per-heading rule is about making an INFERRED block look full.
  // Applying it to somebody's own headings files skills under headings they
  // did not pick for them.
  const data = prepareResumeRenderData(
    profile({ skillCategories: [{ category: 'Languages', skills: ['C#', 'Python', 'C'] }] })
  );
  const languages = data.skillCategories.find((group) => group.category === 'Languages');
  assert.deepEqual(languages.skills, ['C#', 'Python', 'C']);
});

test('flat wins over a grouping, and the grouping survives it', () => {
  // A rendering choice, not a storage one: switching to flat and back must not
  // lose the headings somebody typed in.
  const stored = profile({
    profileSettings: { technicalSkillsLayout: 'flat' },
    skillCategories: [{ category: 'Languages', skills: ['C#'] }],
  });
  const data = prepareResumeRenderData(stored);
  assert.equal(data.skillCategories.length, 1);
  assert.equal(data.skillCategories[0].category, '');
  assert.deepEqual(
    stored.skillCategories,
    [{ category: 'Languages', skills: ['C#'] }],
    'the profile itself is not rewritten by rendering it'
  );
});

test('every built-in template renders the flat layout without an empty heading', async () => {
  // The flat layout is delivered as one group with an empty heading so that
  // every template keeps the single loop it already has. The cost of that
  // choice is an unguarded heading element rendering as a blank box - which on
  // a resume is a visible empty line and, in several of these, a stray rule.
  const ids = builtInIds();
  assert.equal(ids.length, 19, 'this must cover the whole set, not a sample');

  for (const id of ids) {
    const html = await generatePreviewHTML(
      profile({ profileSettings: { technicalSkillsLayout: 'flat' } }),
      templateNamed(id)
    );
    const body = html.slice(html.indexOf('</style>'));
    assert.doesNotMatch(
      body,
      /<div class="skill-category-title"[^>]*>\s*<\/div>/,
      `${id} renders an empty category heading`
    );
    // The list-style templates put the heading in a <strong> followed by a
    // <br>. Guard only the <strong> and the break is left behind, opening the
    // list with a blank line - which is what this looked like when the two
    // rewrite rules ran in the wrong order.
    assert.doesNotMatch(body, /<li>\s*<br\s*\/?>/, `${id} opens its skill list with a blank line`);
    assert.doesNotMatch(body, /<strong>\s*<\/strong>/, `${id} renders an empty bold heading`);
    assert.ok(body.includes('C#'), `${id} did not render the skills at all`);
  }
});

test('every built-in template still renders headings when categorized', async () => {
  for (const id of builtInIds()) {
    const html = await generatePreviewHTML(profile(), templateNamed(id));
    const body = html.slice(html.indexOf('</style>'));
    assert.ok(body.includes('Languages'), `${id} lost its category headings`);
  }
});

/* ------------------------------------------------ a joined skills line */

/** As Handlebars prints text: the library's "AI/ML & Data Science" comes out with `&amp;`. */
function escaped(text) {
  return text.replace(/&/g, '&amp;');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const GROUPED = profile();
const PLAIN = profile({ profileSettings: { technicalSkillsLayout: 'flat' } });

/** A template as an uploaded file holds one. */
function uploaded(id, body, head = '') {
  return {
    id,
    name: id,
    description: '',
    htmlContent: `<!DOCTYPE html><html><head><meta charset="UTF-8">${head}</head><body><h1>{{name}}</h1>${body}</body></html>`,
    cssContent: '',
    sections: [],
    createdAt: '',
    updatedAt: '',
  };
}

/** The document after its last stylesheet, if it has one: the rendered body. */
function bodyOf(html) {
  const at = html.lastIndexOf('</style>');
  return at === -1 ? html : html.slice(at);
}

/** True when two headings of the block share one run of text - the run-on line. */
function runsOn(body, groups) {
  return groups.some((group, index) =>
    index > 0
      ? new RegExp(`${escapeRegExp(escaped(groups[index - 1].category))}:[^<]*${escapeRegExp(escaped(group.category))}:`).test(body)
      : false
  );
}

test('a joined skills line prints Grouped one line per heading, its label and separator its own', async () => {
  // The owner's uploaded ATS templates: one paragraph joining every line, with
  // a static bold label - and a soft line beside it that must stay as it is.
  const ats = uploaded(
    'ats-shape',
    '<section><h2>Skills</h2><p class="skills-line"><strong>Technical Skills:</strong> {{join hardSkills ", "}}</p>' +
      '{{#if softSkills.length}}<p class="skills-line"><strong>Soft Skills:</strong> {{join softSkills ", "}}</p>{{/if}}</section>'
  );
  const groups = prepareResumeRenderData(GROUPED).skillCategories;
  assert.ok(groups.length >= 3, 'a block of several headings');

  const grouped = bodyOf(await generatePreviewHTML(GROUPED, ats));
  for (const group of groups) {
    assert.ok(
      grouped.includes(
        `<p class="skills-line"><strong>${escaped(group.category)}:</strong> ${escaped(group.skills.join(', '))}</p>`
      ),
      `${group.category}: a line of its own, in the template's element and class`
    );
  }
  assert.equal(grouped.includes('Technical Skills:'), false, 'the static label gives way to the headings');
  assert.equal(runsOn(grouped, groups), false, 'no run-on paragraph');
  assert.doesNotMatch(grouped, /Languages:[^<]*,\s*Frameworks/);

  // Plain: the template's own line, label and all.
  const plain = bodyOf(await generatePreviewHTML(PLAIN, ats));
  const skills = prepareResumeRenderData(PLAIN).hardSkills;
  assert.ok(plain.includes(`<p class="skills-line"><strong>Technical Skills:</strong> ${escaped(skills.join(', '))}</p>`));

  // No label, a list item, a separator of its own: each kept.
  const bare = bodyOf(await generatePreviewHTML(GROUPED, uploaded('bare', '<p class="line">{{join hardSkills ", "}}</p>')));
  assert.ok(bare.includes(`<p class="line"><strong>Languages:</strong> ${groups[0].skills.join(', ')}</p>`));
  const dotted = bodyOf(
    await generatePreviewHTML(GROUPED, uploaded('dotted', "<ul><li class='skills'>{{join hardSkills ' · '}}</li></ul>"))
  );
  assert.ok(dotted.includes(`<li class='skills'><strong>Languages:</strong> ${groups[0].skills.join(' · ')}</li>`));
  assert.equal(runsOn(dotted, groups), false);
});

test('a headless group among headed ones prints no empty label on a joined line', async () => {
  const ats = uploaded('ats-headless', '<p class="skills-line"><b>Skills:</b> {{join hardSkills ", "}}</p>');
  const body = bodyOf(
    await generatePreviewHTML(GROUPED, ats, {
      title: 'Engineer',
      summary: 'S',
      experience: [],
      skills: [],
      hardSkills: [],
      softSkills: [],
      strengths: [],
      skillGroups: [
        { category: 'Back End', skills: ['Python', 'Go'] },
        { category: '', skills: ['Vault'] },
      ],
    })
  );
  assert.ok(body.includes('<p class="skills-line"><strong>Back End:</strong> Python, Go</p>'));
  assert.ok(body.includes('<p class="skills-line">Vault</p>'), 'its skills alone, with no heading');
  assert.doesNotMatch(body, /<strong>\s*:?\s*<\/strong>/);
  assert.equal(body.includes('Skills:'), false);
});

test('a joined line in a span or a td stays one element, its groups on lines of their own inside it', async () => {
  // Repeating a span ran its groups together inside the line ("...Python,
  // CFrameworks and Libraries: ..."), and repeating a td added a column to
  // its table for every group.
  const groups = prepareResumeRenderData(GROUPED).skillCategories;
  const lines = groups
    .map((group) => `<strong>${escaped(group.category)}:</strong> ${escaped(group.skills.join(', '))}`)
    .join('<br>');

  const outside = uploaded(
    'span-outside',
    '<p class="skills"><strong>Skills:</strong> <span class="list">{{join hardSkills ", "}}</span></p>'
  );
  const spanned = bodyOf(await generatePreviewHTML(GROUPED, outside));
  assert.ok(
    spanned.includes(`<p class="skills"><strong>Skills:</strong> <span class="list">${lines}</span></p>`),
    'the label outside the span stays; the groups are lines inside the one span'
  );
  assert.equal(spanned.match(/<span class="list">/g).length, 1, 'one span');
  assert.equal(runsOn(spanned, groups), false);

  const inside = uploaded(
    'span-inside',
    '<p class="skills"><span class="list"><b>Skills:</b> {{join hardSkills ", "}}</span></p>'
  );
  const labelled = bodyOf(await generatePreviewHTML(GROUPED, inside));
  assert.ok(labelled.includes(`<p class="skills"><span class="list">${lines}</span></p>`), 'the label inside gives way');

  const table = uploaded(
    'td-line',
    '<table class="facts"><tr><th>Skills</th><td>{{join hardSkills ", "}}</td></tr>' +
      '<tr><th>Languages spoken</th><td>English, Spanish</td></tr></table>'
  );
  const tabled = bodyOf(await generatePreviewHTML(GROUPED, table));
  assert.ok(tabled.includes(`<tr><th>Skills</th><td>${lines}</td></tr>`), 'one cell, a line per group');
  assert.equal(tabled.match(/<td\b/g).length, 2, 'no column added to the table');

  // Plain: each the template's own line, as written.
  const skills = escaped(prepareResumeRenderData(PLAIN).hardSkills.join(', '));
  assert.ok(bodyOf(await generatePreviewHTML(PLAIN, outside)).includes(`<span class="list">${skills}</span>`));
  assert.ok(bodyOf(await generatePreviewHTML(PLAIN, table)).includes(`<tr><th>Skills</th><td>${skills}</td></tr>`));
});

test('a join that is not a line of its own is left as written', async () => {
  // In an attribute, and beside other text: neither is the skills line.
  const template = uploaded(
    'join-elsewhere',
    '<p class="intro">Skilled in {{join hardSkills ", "}}.</p>',
    "<meta name=\"keywords\" content=\"{{join hardSkills ', '}}\">"
  );
  const html = await generatePreviewHTML(GROUPED, template);
  const lines = prepareResumeRenderData(GROUPED).hardSkills;
  const meta = /<meta name="keywords" content="([^"]*)">/.exec(html);
  assert.ok(meta, 'the meta is still there');
  assert.equal(meta[1], escaped(lines.join(', ')), 'its content the joined lines, as the template wrote it');
  assert.equal(meta[1].includes('<strong'), false);
  assert.ok(html.includes(`<p class="intro">Skilled in ${escaped(lines.join(', '))}.</p>`));
});

test("the owner's saved templates that join hardSkills print Grouped one line per heading", async (t) => {
  // Saved templates are untracked files beside the built-ins; a checkout may have none.
  const saved = fs
    .readdirSync(TEMPLATES_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, file), 'utf8')))
    .filter((template) => template.source && /\{\{\s*join\s+hardSkills\b/.test(template.htmlContent));
  if (saved.length === 0) {
    t.skip('no saved template joins hardSkills on this checkout');
    return;
  }
  const groups = prepareResumeRenderData(GROUPED).skillCategories;
  for (const template of saved) {
    const body = bodyOf(await generatePreviewHTML(GROUPED, template));
    for (const group of groups) {
      assert.ok(body.includes(`<strong>${escaped(group.category)}:</strong>`), `${template.id}: ${group.category}`);
    }
    assert.equal(runsOn(body, groups), false, `${template.id}: a run-on line`);
  }
});

/* --------------------------------------------------- the Plain safety net */

const GRID_CSS =
  '<style>.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.cell{min-height:40px}</style>';
const GRID_LOOP =
  '{{#each skillCategories}}<div class="cell"><div class="cell-title">{{category}}</div>' +
  '<div class="cell-skills">{{join skills ", "}}</div></div>{{/each}}';

test('Plain marks the element holding a category loop, with one stylesheet in the head', async () => {
  const grid = uploaded('grid', `<h2>Skills</h2><div class="grid">${GRID_LOOP}</div>`, GRID_CSS);

  const plain = await generatePreviewHTML(PLAIN, grid);
  assert.match(plain, /<div class="grid" data-plain-skills>/);
  const styles = plain.match(/<style id="plain-skills-style">([^<]*)<\/style>/g) ?? [];
  assert.equal(styles.length, 1, 'one stylesheet');
  assert.ok(plain.indexOf('id="plain-skills-style"') < plain.indexOf('</head>'), 'in the head');
  for (const rule of ['grid-column:1/-1!important', 'column-span:all!important', 'min-height:0!important']) {
    assert.ok(styles[0].includes(rule), rule);
  }
  assert.ok(styles[0].startsWith('<style id="plain-skills-style">[data-plain-skills]>*{'), 'the holder\'s children');
  assert.doesNotMatch(bodyOf(plain), /class="cell-title"/, 'no heading box over the one group');

  const grouped = await generatePreviewHTML(GROUPED, grid);
  assert.equal(grouped.includes('data-plain-skills'), false, 'Grouped is the design as written');
  assert.equal(grouped.includes('plain-skills-style'), false);

  // A guard on the list, as uploaded designs write one, still finds the holder.
  const guarded = uploaded(
    'guarded',
    `<div class="grid">{{#if skillCategories.length}}${GRID_LOOP}{{/if}}</div>`,
    GRID_CSS
  );
  assert.match(await generatePreviewHTML(PLAIN, guarded), /<div class="grid" data-plain-skills>/);

  // A design with one item per skill needs nothing: it was written for a plain list.
  const perItem = await generatePreviewHTML(PLAIN, templateNamed('classic-serif'));
  assert.equal(perItem.includes('data-plain-skills'), false);
  assert.equal(perItem.includes('plain-skills-style'), false);
});

test('the Plain net keeps a leading doctype first, and marks nothing it cannot reach', async () => {
  const { fitPlainSkillGroups } = require('../dist/generators/plainSkillsMarkup');

  // No head: the stylesheet goes right after the doctype, which stays first
  // (before it, the page would lay out in quirks mode, unlike the PDF).
  const headless = {
    ...uploaded('headless', ''),
    htmlContent: `<!DOCTYPE html><div class="grid">${GRID_LOOP}</div>`,
  };
  const html = await generatePreviewHTML(PLAIN, headless);
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(fitPlainSkillGroups(headless.htmlContent), /^<!DOCTYPE html><style id="plain-skills-style">/);
  assert.match(fitPlainSkillGroups(`<div>${GRID_LOOP}</div>`), /^<style id="plain-skills-style">/, 'no doctype: first');

  // Idempotent, and one stylesheet however many holders.
  const twice = `<div class="a">${GRID_LOOP}</div><div class="b">${GRID_LOOP}</div>`;
  const once = fitPlainSkillGroups(twice);
  assert.equal(once.match(/<div class="[ab]" data-plain-skills>/g).length, 2);
  assert.equal(fitPlainSkillGroups(once), once);
  assert.equal(once.match(/plain-skills-style/g).length, 1);

  // A loop after a closing tag (charcoal-sidebar's), after a void element, or
  // with markup between it and its holder: nothing marked, nothing added. So
  // too a holder with anything after the loop - inside a guard or past it, an
  // `{{else}}` of the guard, a second loop - and the document's own body.
  for (const markup of [
    `<div class="side"><div class="label">Skills</div>${GRID_LOOP}</div>`,
    `<div><br>${GRID_LOOP}</div>`,
    `<div class="grid"><h3>Skills</h3>${GRID_LOOP}</div>`,
    `<aside class="side">${GRID_LOOP}<div class="rule"></div></aside>`,
    `<aside class="side">${GRID_LOOP}<img class="photo" src="me.png" style="width:90px;height:90px"></aside>`,
    `<div class="grid">{{#if skillCategories.length}}${GRID_LOOP}<p>More on request</p>{{/if}}</div>`,
    `<div class="grid">{{#if skillCategories.length}}${GRID_LOOP}{{else}}<p>None yet</p>{{/if}}</div>`,
    `<div class="grid">${GRID_LOOP}${GRID_LOOP}</div>`,
    `<body>${GRID_LOOP}</body>`,
  ]) {
    assert.equal(fitPlainSkillGroups(markup), markup);
  }

  // The loop and its guards are all it holds, with loops of its own inside
  // the cells and whitespace around: marked.
  for (const markup of [
    `<div class="grid">\n  {{#if skillCategories.length}}\n  ${GRID_LOOP}\n  {{/if}}\n</div>`,
    '<div class="grid">{{#each skillCategories}}<div class="cell">{{#each skills}}<span>{{this}}</span>{{/each}}</div>{{/each}}</div>',
  ]) {
    assert.match(fitPlainSkillGroups(markup), /<div class="grid" data-plain-skills>/);
  }
});

test('the Plain net restyles nothing but the groups: a holder with more in it is left as written', async () => {
  // The net's rule is `!important` on every child of the holder, which beats
  // a child's own inline style. A sidebar holding the loop and then a divider,
  // a badge and a photo was marked, and in Plain the divider drawn by its
  // height vanished and the photo came out at its natural size.
  const sidebar = uploaded(
    'sidebar-after',
    `<aside class="side">${GRID_LOOP}<div class="rule"></div><div class="badge">Certified</div>` +
      '<img class="photo" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" style="width:90px;height:90px"></aside>',
    '<style>.side{width:300px;display:grid;grid-template-columns:1fr 1fr}.rule{height:2px}.badge{width:60px;float:right}</style>'
  );
  for (const who of [PLAIN, GROUPED]) {
    const html = await generatePreviewHTML(who, sidebar);
    assert.equal(html.includes('data-plain-skills'), false);
    assert.equal(html.includes('plain-skills-style'), false);
    assert.ok(html.includes('<div class="rule"></div><div class="badge">Certified</div>'));
  }
});

test('a span loop over the lines, separator and all, is drawn Grouped as heading blocks', async () => {
  // The shape the compile step once rewrote by name: now the lines print as
  // written and the render after it turns each into a heading block.
  const spans = uploaded(
    'span-loop',
    '<div class="skills">{{#if hardSkills.length}}{{#each hardSkills}}<span>{{this}}{{#unless @last}} • {{/unless}}</span>' +
      '{{/each}}{{else}}{{#each skills}}<span>{{this}}{{#unless @last}} • {{/unless}}</span>{{/each}}{{/if}}</div>'
  );
  const groups = prepareResumeRenderData(GROUPED).skillCategories;
  const body = bodyOf(await generatePreviewHTML(GROUPED, spans));
  for (const group of groups) {
    assert.ok(
      body.includes(
        `<div class="skill-category"><div class="skill-category-title">${escaped(group.category)}</div>` +
          `<div class="skill-category-skills">${escaped(group.skills.join(', '))}</div></div>`
      ),
      group.category
    );
  }
  assert.equal(body.includes('•'), false, 'the separator went with its line');
  assert.equal(body.includes('skill-chip'), false);
});
