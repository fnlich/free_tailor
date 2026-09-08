const assert = require('node:assert/strict');
const test = require('node:test');

const {
  generatePreviewHTML,
  generateTemplatePreviewHTML,
  prepareResumeRenderData,
  RESUME_PAGE_GEOMETRY,
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

test('prepareResumeRenderData removes soft skills for rendered resumes', () => {
  const tailoredContent = {
    title: 'Senior Software Engineer',
    summary: 'Summary',
    experience: [],
    skills: ['TypeScript'],
    hardSkills: ['TypeScript'],
    softSkills: ['Communication'],
    unconfirmedSoftSkills: [],
    unconfirmedHardSkills: [],
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

  assert.deepEqual(firstRenderData.softSkills, []);
  assert.deepEqual(otherRenderData.softSkills, []);
});

test('prepareResumeRenderData enforces prompt-compliant skill category counts', () => {
  const renderData = prepareResumeRenderData(
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
    {
      title: 'Software Engineer',
      summary: 'Summary',
      experience: [],
      skills: ['TypeScript', 'React', 'AWS', 'PostgreSQL', 'Git', 'CI/CD'],
      hardSkills: ['TypeScript', 'React', 'AWS', 'PostgreSQL', 'Git', 'CI/CD'],
      softSkills: [],
      unconfirmedSoftSkills: [],
      unconfirmedHardSkills: [],
      strengths: [],
    }
  );

  const groups = Object.fromEntries(
    renderData.skillCategories.map((group) => [group.category, group.skills])
  );

  assert.deepEqual(Object.keys(groups), [
    'Languages',
    'Frameworks and Libraries',
    'Cloud and Infrastructure',
    'Databases and Storage',
    'Version Control & Collaboration',
  ]);
  assert.equal(groups.Languages.length, 3);
  assert.equal(groups['Frameworks and Libraries'].length, 5);
  assert.equal(groups['Cloud and Infrastructure'].length, 5);
  assert.equal(groups['Databases and Storage'].length, 5);
  assert.equal(groups['Version Control & Collaboration'].length, 5);
  assert.ok(groups.Languages.includes('TypeScript'));
  assert.ok(groups.Languages.includes('Python'));
  assert.ok(groups.Languages.includes('Java'));
  assert.equal(groups.Languages.some((skill) => ['Bash', 'C#', 'HTML', 'CSS'].includes(skill)), false);
  assert.ok(groups['Frameworks and Libraries'].includes('React'));
  assert.ok(groups['Cloud and Infrastructure'].includes('AWS'));
  assert.ok(groups['Databases and Storage'].includes('PostgreSQL'));
  assert.ok(groups['Version Control & Collaboration'].includes('Git'));
});

test('prepareResumeRenderData rejects non-library hard skill strings', () => {
  const renderData = prepareResumeRenderData(
    {
      id: 'profile-non-library',
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
      skills: ['AI coding tools', 'Accuracy', 'SaaS', 'Code Review'],
      education: [],
      createdAt: '',
      updatedAt: '',
    },
    {
      title: 'Software Engineer',
      summary: 'Summary',
      experience: [],
      skills: [
        'Bash',
        'C#',
        'C++',
        'JavaScript',
        'TypeScript',
        'Next.js',
        'React',
        'AI coding tools',
        'AI coding workflows',
        'AI-assisted code review tools',
        'access-control workflow development',
        'End-to-End Testing',
        'Integration Testing',
        'Regression Testing',
        'Testing',
        'Unit Testing',
      ],
      hardSkills: [
        'Bash',
        'C#',
        'C++',
        'JavaScript',
        'TypeScript',
        'Next.js',
        'React',
        'AI coding tools',
        'AI coding workflows',
        'AI-assisted code review tools',
        'access-control workflow development',
        'End-to-End Testing',
        'Integration Testing',
        'Regression Testing',
        'Testing',
        'Unit Testing',
      ],
      softSkills: [],
      unconfirmedSoftSkills: [],
      unconfirmedHardSkills: [],
      strengths: [],
    }
  );

  const groups = renderData.skillCategories;
  const flattened = groups.flatMap((group) => group.skills.map((skill) => skill.toLowerCase()));

  assert.equal(groups.length >= 5, true);
  assert.equal(
    groups.every((group) =>
      group.category === 'Languages'
        ? group.skills.length >= 3 && group.skills.length <= 5
        : group.skills.length >= 5 && group.skills.length <= 10
    ),
    true
  );
  for (const rejectedSkill of [
    'ai coding tools',
    'ai coding workflows',
    'ai-assisted code review tools',
    'access-control workflow development',
    'accuracy',
    'saas',
    'code review',
  ]) {
    assert.equal(flattened.includes(rejectedSkill), false);
  }
});

test('prepareResumeRenderData applies strict skill category rules', () => {
  const renderData = prepareResumeRenderData(
    {
      id: 'profile-2',
      name: 'Alex Rivera',
      title: 'Senior Software Engineer',
      contact: {
        phone: '555-555-5555',
        email: 'alex@example.com',
        linkedin: 'linkedin.com/in/alex-rivera',
        location: 'Kirkland, WA',
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
      title: 'Senior Software Engineer',
      summary: 'Summary',
      experience: [],
      skills: ['Go', 'Python'],
      hardSkills: ['Go', 'Python'],
      softSkills: [],
      unconfirmedSoftSkills: [],
      unconfirmedHardSkills: [],
      strengths: [],
    }
  );

  const groups = Object.fromEntries(
    renderData.skillCategories.map((group) => [group.category, group.skills])
  );

  assert.deepEqual(Object.keys(groups), [
    'Languages',
    'Frameworks and Libraries',
    'Software Architecture & Design',
    'Security',
    'Cloud and Infrastructure',
  ]);
  assert.equal(groups.Languages.length >= 3 && groups.Languages.length <= 5, true);
  for (const [category, skills] of Object.entries(groups)) {
    if (category === 'Languages') continue;
    assert.ok(skills.length >= 5);
    assert.ok(skills.length <= 10);
  }
  assert.deepEqual(new Set(groups.Languages), new Set(['Go', 'Python', 'Java']));
  assert.ok(groups['Frameworks and Libraries'].includes('Gin'));
  assert.ok(groups['Frameworks and Libraries'].includes('Echo'));
  assert.ok(groups['Frameworks and Libraries'].includes('Django'));
  assert.ok(groups['Frameworks and Libraries'].includes('FastAPI'));
});

test('prepareResumeRenderData caps language skills at the prompt maximum', () => {
  const renderData = prepareResumeRenderData(
    {
      id: 'profile-2',
      name: 'Alex Rivera',
      title: 'Senior Software Engineer',
      contact: {
        phone: '555-555-5555',
        email: 'alex@example.com',
        linkedin: 'linkedin.com/in/alex-rivera',
        location: 'Kirkland, WA',
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
      title: 'Senior Software Engineer',
      summary: 'Summary',
      experience: [],
      skills: ['Go', 'Python', 'JavaScript', 'PHP', 'Java', 'TypeScript'],
      hardSkills: ['Go', 'Python', 'JavaScript', 'PHP', 'Java', 'TypeScript'],
      softSkills: [],
      unconfirmedSoftSkills: [],
      unconfirmedHardSkills: [],
      strengths: [],
    }
  );

  const languages = renderData.skillCategories.find((group) => group.category === 'Languages').skills;
  assert.equal(languages.length, 5);
  assert.deepEqual(new Set(languages), new Set(['Go', 'Python', 'JavaScript', 'PHP', 'Java']));
});

// -- Template preview == printed page ---------------------------------------- //
// The preview exists to show what the PDF will look like, and it only does that
// if it renders the same document at the same width. It used to do neither: the
// template document was nested inside a second wrapper document, and laid out at
// whatever width the iframe happened to be. Column counts, line wraps and page
// breaks all move with width, so the two were only loosely related.

test('the page geometry is one definition, not two', () => {
  assert.equal(RESUME_PAGE_GEOMETRY.format, 'A4');
  assert.deepEqual(RESUME_PAGE_GEOMETRY.margin, {
    top: '0.4in',
    right: '0.5in',
    bottom: '0.3in',
    left: '0.5in',
  });
  // A4 is 8.27in wide; minus 0.5in of margin either side, at 96 DPI.
  assert.equal(RESUME_PAGE_GEOMETRY.contentWidthPx, 698);
});

test('a template preview carries the printed page box, not an arbitrary width', async () => {
  const template = await getTemplateById('developer-mono');
  assert.ok(template, 'developer-mono should be a built-in template');

  const preview = generateTemplatePreviewHTML(template);
  const { margin, contentWidthPx, contentHeightPx } = RESUME_PAGE_GEOMETRY;

  // The width every width-dependent CSS decision resolves against.
  assert.match(preview, new RegExp(`width:\\s*${contentWidthPx}px`));
  assert.match(preview, new RegExp(`min-height:\\s*${contentHeightPx}px`));
  // All four PDF margins, in PDF order, drawn as the page's white border.
  assert.match(
    preview,
    new RegExp(`border-width:\\s*${margin.top}\\s+${margin.right}\\s+${margin.bottom}\\s+${margin.left}`)
  );
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
  const templates = await getAllTemplates();
  const ids = templates.map((entry) => entry.id).sort();

  assert.deepEqual(ids, [
    'classic-serif',
    'contrast-cards',
    'default',
    'developer-mono',
    'editorial-italic',
    'structured-slate',
  ]);
});

test('a template of each layout shape renders the sample resume end to end', async () => {
  // One flow-layout template and one CSS-grid one. Rendering all six costs
  // about two minutes of skill-categorisation per template for no extra
  // coverage - the shapes are what differ, not the count.
  const templates = await Promise.all(
    ['developer-mono', 'contrast-cards'].map((id) => getTemplateById(id))
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
  const templates = await getAllTemplates();
  for (const template of templates) {
    assert.doesNotMatch(
      template.name,
      /rista_|jacky_/i,
      `${template.id} kept an authoring name: ${template.name}`
    );
    assert.ok(template.description && template.description.length > 20, `${template.id} needs a description`);
  }
});
