const assert = require('node:assert/strict');
const test = require('node:test');

const {
  generatePreviewHTML,
  generateTemplatePreviewHTML,
  prepareResumeRenderData,
  RESUME_PAGE_GEOMETRY,
  resolveTemplatePageBox,
} = require('../dist/generators/pdfGenerator');
const { getAllTemplates, getTemplateById } = require('../dist/extractors/templateExtractor');

test('prepareResumeRenderData normalizes LinkedIn href and display text', () => {
  const renderData = prepareResumeRenderData({
    id: 'profile-1',
    name: 'Jane Doe',
    title: 'Software Engineer',
    contact: {
      phone: '555-555-5555',
      email: 'jane@example.com',
      linkedin: 'linkedin.com/in/jane-doe',
      location: 'San Francisco, CA',
    },
    summary: 'Summary',
    experience: [],
    strengths: [],
    skills: [],
    education: [],
    createdAt: '',
    updatedAt: '',
  });

  assert.equal(renderData.contact.linkedin, 'https://linkedin.com/in/jane-doe');
  assert.equal(renderData.contact.linkedinHref, 'https://linkedin.com/in/jane-doe');
  assert.equal(renderData.contact.linkedinDisplay, 'linkedin.com/in/jane-doe');
});

test('generatePreviewHTML shows linkedin.com text while keeping the full LinkedIn href', async () => {
  const html = await generatePreviewHTML(
    {
      id: 'profile-2',
      name: 'Jane Doe',
      title: 'Software Engineer',
      contact: {
        phone: '555-555-5555',
        email: 'jane@example.com',
        linkedin: 'https://www.linkedin.com/in/jane-doe',
        location: 'San Francisco, CA',
      },
      summary: 'Summary',
      experience: [],
      strengths: [],
      skills: [],
      education: [],
      createdAt: '',
      updatedAt: '',
    },
    {
      id: 'template-1',
      name: 'Template',
      htmlContent: '<a href="{{contact.linkedin}}">{{contact.linkedin}}</a>',
      cssContent: '',
      createdAt: '',
      updatedAt: '',
    }
  );

  assert.match(html, /href="https:\/\/www\.linkedin\.com\/in\/jane-doe"/);
  assert.match(html, />linkedin\.com\/in\/jane-doe<\/a>/);
  assert.doesNotMatch(html, />https:\/\/www\.linkedin\.com\/in\/jane-doe<\/a>/);
});

test('the builder preview carries the same Content-Security-Policy as the profile editor preview', async () => {
  // It holds whatever the model wrote, framed in the page; the policy keeps a
  // stray script or remote fetch out even if the frame's own sandbox did not.
  const profile = {
    id: 'profile-csp',
    name: 'Jane Doe',
    title: 'Engineer',
    contact: { phone: '', email: '', linkedin: '', location: '' },
    summary: 'Summary',
    experience: [],
    strengths: [],
    skills: [],
    education: [],
    createdAt: '',
    updatedAt: '',
  };
  const template = (htmlContent) => ({ id: 't-csp', name: 'T', htmlContent, cssContent: '', createdAt: '', updatedAt: '' });

  const withDoctype = await generatePreviewHTML(profile, template('<!DOCTYPE html><html><body>{{name}}</body></html>'));
  assert.match(withDoctype, /^<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="default-src 'none';/);

  const bare = await generatePreviewHTML(profile, template('<div>{{name}}</div>'));
  assert.ok(bare.indexOf('Content-Security-Policy') < bare.indexOf('Jane Doe'));
});

test('prepareResumeRenderData leaves soft skills out unless the profile switches them on', () => {
  const tailoredContent = {
    title: 'Senior Software Engineer',
    summary: 'Summary',
    experience: [],
    skills: ['TypeScript'],
    hardSkills: ['TypeScript'],
    softSkills: ['Communication'],
    strengths: [],
  };

  const firstRenderData = prepareResumeRenderData(
    {
      id: 'profile-1',
      name: 'Sam Chen',
      title: 'Senior Software Engineer',
      contact: {
        phone: '555-555-5555',
        email: 'sam@example.com',
        linkedin: 'linkedin.com/in/sam-chen',
        location: 'San Jose, CA',
      },
      summary: 'Summary',
      experience: [],
      strengths: [],
      skills: [],
      education: [],
      createdAt: '',
      updatedAt: '',
    },
    tailoredContent
  );

  const otherRenderData = prepareResumeRenderData(
    {
      id: 'profile-4',
      name: 'Jane Doe',
      title: 'Software Engineer',
      contact: {
        phone: '555-555-5555',
        email: 'jane@example.com',
        linkedin: 'linkedin.com/in/jane-doe',
        location: 'San Francisco, CA',
      },
      summary: 'Summary',
      experience: [],
      strengths: [],
      skills: [],
      education: [],
      createdAt: '',
      updatedAt: '',
    },
    tailoredContent
  );

  // Off - absent from profileSettings, as on every profile written before the
  // switch - is what every resume has always rendered: no soft skills, even
  // when the tailored content carries some.
  assert.deepEqual(firstRenderData.softSkills, []);
  assert.deepEqual(otherRenderData.softSkills, []);

  const switchedOn = prepareResumeRenderData(
    {
      id: 'profile-5',
      name: 'Sam Chen',
      title: 'Senior Software Engineer',
      contact: { phone: '1', email: 'sam@example.com', location: 'San Jose, CA' },
      summary: 'Summary',
      experience: [],
      strengths: [],
      skills: [],
      education: [],
      profileSettings: { includeSoftSkills: true },
      createdAt: '',
      updatedAt: '',
    },
    tailoredContent
  );
  assert.deepEqual(switchedOn.softSkills, ['Communication']);
});

/**
 * A tailored list is printed as it came, never filled out from the skill
 * library. These four inputs once came back as five library headings of five,
 * Python and Java added beside a TypeScript nobody asked to pair them with,
 * Gin, Echo, Django and FastAPI added for a Go and Python profile, CI/CD
 * dropped by a gate and a sixth language cut. Content with `skillGroups` - what
 * the tailoring prompt returns now - is test/tailoredRender.test.js; these are
 * content without it, as an older build held it.
 */
test('older tailored content is printed unpadded: nothing added, nothing gated, nothing capped', () => {
  const profile = {
    id: 'profile-legacy',
    name: 'Alex Rivera',
    title: 'Senior Software Engineer',
    contact: { phone: '555-555-5555', email: 'alex@example.com', location: 'Kirkland, WA' },
    summary: 'Summary',
    experience: [],
    strengths: [],
    skills: [],
    education: [],
    createdAt: '',
    updatedAt: '',
  };
  const tailored = (hardSkills) => ({
    title: 'Senior Software Engineer',
    summary: 'Summary',
    experience: [],
    skills: hardSkills,
    hardSkills,
    softSkills: [],
    strengths: [],
  });
  const printed = (data) => data.skillCategories.flatMap((group) => group.skills);

  for (const hardSkills of [
    ['TypeScript', 'React', 'AWS', 'PostgreSQL', 'Git', 'CI/CD'],
    ['Go', 'Python'],
    ['Go', 'Python', 'JavaScript', 'PHP', 'Java', 'TypeScript'],
  ]) {
    const grouped = prepareResumeRenderData(profile, tailored(hardSkills));
    assert.deepEqual(new Set(printed(grouped)), new Set(hardSkills), `grouped: ${hardSkills.join(', ')}`);
    assert.ok(grouped.skillCategories.every((group) => group.category), 'under the library headings');

    const flat = prepareResumeRenderData(
      { ...profile, profileSettings: { technicalSkillsLayout: 'flat' } },
      tailored(hardSkills)
    );
    assert.deepEqual(flat.hardSkills, hardSkills, `flat: ${hardSkills.join(', ')}, in order`);
  }

  const languages = prepareResumeRenderData(
    profile,
    tailored(['Go', 'Python', 'JavaScript', 'PHP', 'Java', 'TypeScript'])
  ).skillCategories.find((group) => group.category === 'Languages');
  assert.deepEqual(languages.skills, ['Go', 'Python', 'JavaScript', 'PHP', 'Java', 'TypeScript'], 'no cap at five');
});

// -- Template preview == printed page ---------------------------------------- //
// The preview exists to show what the PDF will look like, and it only does that
// if it renders the same document at the same width. It used to do neither: the
// template document was nested inside a second wrapper document, and laid out at
// whatever width the iframe happened to be. Column counts, line wraps and page
// breaks all move with width, so the two were only loosely related.

test('the fallback page geometry is A4 with the margins page.pdf is called with', () => {
  assert.equal(RESUME_PAGE_GEOMETRY.format, 'A4');
  assert.deepEqual(RESUME_PAGE_GEOMETRY.margin, {
    top: '0.4in',
    right: '0.5in',
    bottom: '0.3in',
    left: '0.5in',
  });
  // A4 at 96 DPI, minus 0.5in of margin either side.
  assert.equal(RESUME_PAGE_GEOMETRY.pageWidthPx, 794);
  assert.equal(RESUME_PAGE_GEOMETRY.contentWidthPx, 698);
});

// Chrome honours a template's own `@page` rule and ignores the margin handed to
// `page.pdf()`. Print the same markup with and without an `@page { margin:
// 0.35in }` rule and the ink starts 34px in rather than 48px in. Every built-in
// template declares one, so a preview built from the fallback geometry above was
// 30-96px narrower than the page it was previewing, and wrapped its lines and
// filled its pages differently. The page box has to be read per template.
test('the page box is read from the template, not assumed', async () => {
  const cases = [
    // id, margin shorthand it declares, content width that leaves on A4
    ['developer-mono', '0.35in', 794 - 2 * 33.6],
    ['timeline-bars', '0.2in', 794 - 2 * 19.2],
    ['azure-stack', '0.3in', 794 - 2 * 28.8],
  ];
  for (const [id, margin, contentWidthPx] of cases) {
    const template = await getTemplateById(id);
    assert.ok(template, `${id} should be a built-in template`);
    const box = resolveTemplatePageBox(template);
    assert.equal(box.margin.top, margin, `${id} margin`);
    assert.equal(Math.round(box.contentWidthPx), Math.round(contentWidthPx), `${id} content width`);
    assert.equal(box.mediaScale, 1, `${id} is already A4`);
  }

  // charcoal-sidebar asks for letter with no margins. It is laid out at letter
  // and scaled down to fit the A4 media box, which is what printing does to it.
  const letter = await getTemplateById('charcoal-sidebar');
  const letterBox = resolveTemplatePageBox(letter);
  assert.equal(letterBox.pageWidthPx, 816);
  assert.equal(letterBox.pageHeightPx, 1056);
  assert.equal(letterBox.contentWidthPx, 816, 'no margins means the content is the whole page');
  assert.ok(letterBox.mediaScale < 1 && letterBox.mediaScale > 0.9, 'letter is scaled to fit A4');
  assert.ok(letterBox.usesViewportUnits, 'charcoal-sidebar sizes itself in vh');

  // Laid out at 816px in a frame the width of the A4 sheet (794px): a
  // transform does not shrink overflow, so without this a classic-scrollbar
  // browser paints a horizontal bar under the page.
  const chrome = (html) => html.slice(html.indexOf('resume-preview-page'));
  assert.match(chrome(generateTemplatePreviewHTML(letter)), /overflow-x:\s*hidden/);
  assert.doesNotMatch(
    chrome(generateTemplatePreviewHTML(await getTemplateById('developer-mono'))),
    /overflow-x:\s*hidden/,
    'an A4 page is left alone'
  );
});

test('a template preview carries the printed page box, not an arbitrary width', async () => {
  const template = await getTemplateById('developer-mono');
  assert.ok(template, 'developer-mono should be a built-in template');

  const preview = generateTemplatePreviewHTML(template);
  const { margin, contentWidthPx, contentHeightPx } = resolveTemplatePageBox(template);

  // The width every width-dependent CSS decision resolves against.
  assert.match(preview, new RegExp(`width:\\s*${contentWidthPx.toFixed(2)}px`));
  assert.match(preview, new RegExp(`min-height:\\s*${contentHeightPx.toFixed(2)}px`));
  // All four page margins, in PDF order. They are set on `html`, never on the
  // body: a border or padding on the body stops the first child's top margin
  // collapsing through it, and timeline-bars pulls its header up with a
  // negative margin. Measured, doing it on the body put every element below
  // that header 10px out against the PDF.
  assert.match(
    preview,
    new RegExp(`padding:\\s*${margin.top}\\s+${margin.right}\\s+${margin.bottom}\\s+${margin.left}`)
  );
  // Print cuts anything that bleeds past the margins off at the margin edge.
  assert.match(
    preview,
    new RegExp(`clip-path:\\s*inset\\(${margin.top}\\s+${margin.right}\\s+${margin.bottom}\\s+${margin.left}\\)`)
  );
  const bodyRule = /body\s*\{[^}]*\}/.exec(preview.slice(preview.indexOf('resume-preview-page')));
  assert.ok(bodyRule, 'the chrome should style the body');
  for (const forbidden of ['border', 'padding', 'margin-top', 'margin-bottom']) {
    assert.equal(
      bodyRule[0].includes(forbidden),
      false,
      `the preview must not set ${forbidden} on the body - it changes margin collapsing`
    );
  }
  // page.pdf runs with printBackground: true, so the preview must not let the
  // browser drop backgrounds the way a screen render would.
  assert.match(preview, /print-color-adjust:\s*exact/);
});

test('the preview is the PDF document plus chrome, never a different document', async () => {
  const template = await getTemplateById('classic-serif');
  const preview = generateTemplatePreviewHTML(template);

  // Strip the one appended block and what is left must be a standalone
  // document - the same string the PDF renderer is handed.
  const chrome = /<style id="resume-preview-page">[\s\S]*?<\/style>$/;
  assert.match(preview, chrome, 'the chrome must be appended last so it wins ties');

  const document = preview.replace(chrome, '');
  assert.match(document, /^<!DOCTYPE html>/i);
  assert.equal(document.includes('resume-preview-page'), false);
  // And it must be a rendered resume, not an unfilled template.
  assert.equal(document.includes('{{'), false, 'no unrendered Handlebars should survive');
  assert.ok(document.includes('Jordan Avery Chen'));
});

test('every built-in template is present and described', async () => {
  // The built-ins: a saved template beside them is an administrator's.
  const templates = (await getAllTemplates()).filter((entry) => entry.isBuiltIn);
  const ids = templates.map((entry) => entry.id).sort();

  assert.deepEqual(ids, [
    'amber-gradient',
    'azure-stack',
    'burgundy-rule',
    'charcoal-sidebar',
    'classic-serif',
    'contrast-cards',
    'default',
    'developer-mono',
    'dossier-panel',
    'editorial-italic',
    'forest-chips',
    'framed-serif',
    'indigo-band',
    'ink-ledger',
    'navy-gold',
    'navy-rule',
    'slate-italic',
    'structured-slate',
    'timeline-bars',
  ]);
});

test('a template of each layout shape renders the sample resume end to end', async () => {
  // One template per layout shape: flow, CSS grid, a sidebar, a date-column
  // ledger and a single-column stack. Rendering every one of them adds cost
  // without coverage - the shapes are what differ, not the count.
  const templates = await Promise.all(
    [
      'developer-mono',
      'contrast-cards',
      'charcoal-sidebar',
      'burgundy-rule',
      'ink-ledger',
      'dossier-panel',
      'framed-serif',
      'azure-stack',
    ].map((id) => getTemplateById(id))
  );

  for (const template of templates) {
    assert.ok(template, 'built-in template should load');
    const preview = generateTemplatePreviewHTML(template);
    // The sample profile is deliberately a full resume, so a template that
    // silently drops a section shows up here rather than in someone's PDF.
    assert.ok(preview.includes('Jordan Avery Chen'), `${template.id}: name missing`);
    assert.ok(preview.includes('Northwind Payments'), `${template.id}: experience missing`);
    assert.ok(preview.includes('University of Washington'), `${template.id}: education missing`);
    assert.ok(preview.includes('Languages'), `${template.id}: skill categories missing`);
    assert.equal(preview.includes('{{'), false, `${template.id}: unrendered Handlebars`);
  }
});

test('no built-in template is still named after the person who wrote it', async () => {
  const templates = (await getAllTemplates()).filter((entry) => entry.isBuiltIn);
  for (const template of templates) {
    assert.doesNotMatch(
      template.name,
      /rista_|jacky_|new_leo|new_abe|new_kevin|^Test \d/i,
      `${template.id} kept an authoring name: ${template.name}`
    );
    assert.ok(template.description && template.description.length > 20, `${template.id} needs a description`);
  }
});
