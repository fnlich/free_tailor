const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { generatePreviewHTML, prepareResumeRenderData } = require('../dist/generators/pdfGenerator');

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

test('new_leo template renders each experience entry', async () => {
  const template = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'data', 'templates', 'new_leo.json'), 'utf8')
  );

  const html = await generatePreviewHTML(
    {
      id: 'profile-3',
      name: 'Jane Doe',
      title: 'Software Engineer',
      contact: {
        phone: '555-555-5555',
        email: 'jane@example.com',
        linkedin: 'linkedin.com/in/jane-doe',
        location: 'San Francisco, CA',
      },
      summary: 'Summary',
      experience: [
        {
          title: 'Senior Engineer',
          company: 'Acme Corp',
          startDate: '01/2022',
          endDate: 'Present',
          location: 'Remote',
          description: 'Led platform work.',
          achievements: ['Built reporting workflows'],
        },
        {
          title: 'Engineer',
          company: 'Beta Labs',
          startDate: '02/2020',
          endDate: '12/2021',
          location: 'Los Angeles, CA',
          description: 'Built backend systems.',
          achievements: ['Reduced latency'],
        },
      ],
      strengths: [],
      skills: ['TypeScript'],
      education: [],
      createdAt: '',
      updatedAt: '',
    },
    template
  );

  assert.match(html, /Acme Corp/);
  assert.match(html, /Beta Labs/);
  assert.match(html, /Senior Engineer/);
  assert.match(html, /Engineer/);
  assert.match(html, /01\/2022 - Present/);
  assert.match(html, /02\/2020 - 12\/2021/);
  assert.doesNotMatch(html, /Projects/);
});

test('new_leo template removes strengths and soft skills sections', async () => {
  const template = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'data', 'templates', 'new_leo.json'), 'utf8')
  );

  const html = await generatePreviewHTML(
    {
      id: 'c93ba1c1-390e-4d38-87d7-93cb74502cb1',
      name: 'Leo Wu',
      title: 'Senior Software Engineer',
      contact: {
        phone: '555-555-5555',
        email: 'leo@example.com',
        linkedin: 'linkedin.com/in/leo-wu',
        location: 'San Jose, CA',
      },
      summary: 'Summary',
      experience: [],
      strengths: [],
      skills: ['TypeScript'],
      education: [],
      createdAt: '',
      updatedAt: '',
    },
    template,
    {
      title: 'Senior Software Engineer',
      summary: 'Summary',
      experience: [],
      skills: ['TypeScript'],
      hardSkills: ['TypeScript'],
      softSkills: ['Stakeholder Alignment', 'Cross-functional Communication'],
      unconfirmedSoftSkills: [],
      unconfirmedHardSkills: [],
      strengths: [
        {
          title: 'Telemetry Reliability',
          description: 'Improved high-volume sensor event processing for connected operations teams.',
        },
      ],
    }
  );

  assert.doesNotMatch(html, /Strengths/);
  assert.match(html, /section-strengths \.strengths-list \{ display: block; \}/);
  assert.doesNotMatch(html, /Telemetry Reliability/);
  assert.doesNotMatch(html, /Improved high-volume sensor event processing/);
  assert.doesNotMatch(html, /Projects/);
  assert.doesNotMatch(html, /Soft Skills/);
  assert.doesNotMatch(html, /Stakeholder Alignment/);
  assert.doesNotMatch(html, /Cross-functional Communication/);
  assert.doesNotMatch(html, /section-soft-skills/);
  assert.doesNotMatch(html, /section-projects/);
  assert.doesNotMatch(html, /project-item/);
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

  const leoRenderData = prepareResumeRenderData(
    {
      id: 'c93ba1c1-390e-4d38-87d7-93cb74502cb1',
      name: 'Leo Wu',
      title: 'Senior Software Engineer',
      contact: {
        phone: '555-555-5555',
        email: 'leo@example.com',
        linkedin: 'linkedin.com/in/leo-wu',
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

  assert.deepEqual(leoRenderData.softSkills, []);
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
    renderData.kimuraSkillCategories.map((group) => [group.category, group.skills])
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

  const groups = renderData.kimuraSkillCategories;
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

test('prepareResumeRenderData applies strict David Kimura skill categories', () => {
  const renderData = prepareResumeRenderData(
    {
      id: '2e7542a5-f9fd-473c-873a-28e7ab48e77b',
      name: 'David Kimura',
      title: 'Senior Software Engineer',
      contact: {
        phone: '555-555-5555',
        email: 'david@example.com',
        linkedin: 'linkedin.com/in/david-kimura',
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
    renderData.kimuraSkillCategories.map((group) => [group.category, group.skills])
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
      id: '2e7542a5-f9fd-473c-873a-28e7ab48e77b',
      name: 'David Kimura',
      title: 'Senior Software Engineer',
      contact: {
        phone: '555-555-5555',
        email: 'david@example.com',
        linkedin: 'linkedin.com/in/david-kimura',
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

  const languages = renderData.kimuraSkillCategories.find((group) => group.category === 'Languages').skills;
  assert.equal(languages.length, 5);
  assert.deepEqual(new Set(languages), new Set(['Go', 'Python', 'JavaScript', 'PHP', 'Java']));
});

test('kimura template renders categorized skills without soft skills or strengths', async () => {
  const template = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'data', 'templates', 'kimura.json'), 'utf8')
  );

  const html = await generatePreviewHTML(
    {
      id: 'profile-5',
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
      strengths: [{ title: 'Problem Solving', description: 'Solves hard problems.' }],
      skills: [],
      education: [
        {
          degree: 'B.S. Computer Science',
          institution: 'State University',
          startDate: '2015',
          endDate: '2019',
          location: 'Boston, MA',
        },
      ],
      createdAt: '',
      updatedAt: '',
    },
    template,
    {
      title: 'Software Engineer',
      summary: 'Summary',
      experience: [],
      skills: ['TypeScript', 'React', 'AWS', 'PostgreSQL', 'Git'],
      hardSkills: ['TypeScript', 'React', 'AWS', 'PostgreSQL', 'Git'],
      softSkills: ['Communication'],
      unconfirmedSoftSkills: [],
      unconfirmedHardSkills: [],
      strengths: [{ title: 'Problem Solving', description: 'Solves hard problems.' }],
    }
  );

  assert.match(html, /Technical Skills/);
  assert.match(html, /grid-template-columns: repeat\(3, 1fr\)/);
  assert.match(html, /gap: 1px 16px/);
  assert.match(html, /min-height: 54px/);
  assert.match(html, /Languages/);
  assert.match(html, /Frameworks and Libraries/);
  assert.match(html, /Cloud and Infrastructure/);
  assert.match(html, /Databases and Storage/);
  assert.match(html, /Version Control &amp; Collaboration/);
  assert.match(html, /TypeScript/);
  assert.match(html, /React/);
  assert.match(html, /AWS/);
  assert.match(html, /PostgreSQL/);
  assert.match(html, /Git/);
  assert.match(html, /TypeScript, Python, Java/);
  assert.match(html, /education-header/);
  assert.match(html, /justify-content: space-between/);
  assert.match(html, /class="edu-date"[^>]*>2015 - 2019 \| Boston, MA<\/div>/);
  assert.doesNotMatch(html, /<li\b/);
  assert.doesNotMatch(html, /skills-list/);
  assert.doesNotMatch(html, /Soft Skills/);
  assert.doesNotMatch(html, /Key Strengths/);
  assert.doesNotMatch(html, /Communication/);
  assert.doesNotMatch(html, /Problem Solving/);
  assert.doesNotMatch(html, /section-soft-skills/);
  assert.doesNotMatch(html, /section-strengths/);
});
