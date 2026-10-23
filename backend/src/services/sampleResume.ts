import { getResumeSections } from './resumeDocument';
import { flattenSkillGroups } from './skillGroups';
import type { Education, Experience, Resume, Strength } from '../types/resume';
import type { SkillGroup, TailoredContent } from '../types/template';

/**
 * The resume every template preview is rendered with.
 *
 * Deliberately a FULL one - four roles with real achievement bullets, a skill
 * list broad enough to fill every category the skills pipeline builds, two
 * degrees - because a preview's whole job is to show how a template handles a
 * real resume. The previous sample had two roles and five skills, which made
 * every template look roomy and told you nothing about how the one you picked
 * would cope with a second page, a long company line, or a four-column skills
 * block.
 *
 * The names and companies are invented. Nothing here is anyone's real resume.
 *
 * Two readers, and only two: the template gallery (`generateTemplatePreviewHTML`)
 * draws it tailored - its name, contact, education, strengths and soft skills
 * with `SAMPLE_TAILORED_CONTENT` below in place of the summary, roles and
 * skills - and the resume editor's live preview borrows the parts a draft has
 * left empty (`withSampleDefaults`, below). Never a save, a generation, a PDF,
 * a DOCX or a prompt - test/sampleDefaults.test.js holds that line.
 */
export const SAMPLE_RESUME: Resume = {
  id: 'preview',
  name: 'Jordan Avery Chen',
  title: 'Senior Software Engineer',
  totalYearsExperience: 9,
  contact: {
    phone: '+1 (555) 123-4567',
    email: 'jordan.chen@example.com',
    linkedin: 'linkedin.com/in/jordanchen',
    location: 'San Francisco, CA',
  },
  summary:
    'Senior engineer with nine years building and operating payment and data platforms at scale. ' +
    'Leads backend architecture for services handling 40M requests a day, and has taken three ' +
    'greenfield systems from design through to production ownership. Works closely with product ' +
    'and SRE, and has mentored eight engineers through promotion.',
  experience: [
    {
      title: 'Senior Software Engineer',
      company: 'Northwind Payments',
      startDate: '03/2022',
      endDate: 'Present',
      location: 'San Francisco, CA',
      description:
        'Own the ledger and settlement services behind a payments platform processing $2.4B annually. ' +
        'Lead a team of five across backend and infrastructure.',
      achievements: [
        'Rebuilt the settlement pipeline on an event-sourced ledger, cutting end-of-day reconciliation from 6 hours to 18 minutes',
        'Cut p99 authorisation latency from 840ms to 120ms by replacing synchronous fraud lookups with a cached risk service',
        'Introduced contract testing across 14 services, taking integration failures in staging from roughly 30 a week to under 3',
        'Mentored three engineers to senior; two now lead their own teams',
      ],
      skills: [],
    },
    {
      title: 'Software Engineer II',
      company: 'Cobalt Analytics',
      startDate: '07/2019',
      endDate: '02/2022',
      location: 'Seattle, WA',
      description:
        'Built the ingestion and query layer for a customer-facing analytics product used by 1,200 organisations.',
      achievements: [
        'Designed a columnar ingestion path handling 8TB a day, reducing storage cost per event by 62%',
        'Shipped an incremental materialised-view engine that brought dashboard loads under 2 seconds at the 95th percentile',
        'Led the migration from a single Postgres instance to a sharded cluster with no customer-visible downtime',
      ],
      skills: [],
    },
    {
      title: 'Software Engineer',
      company: 'Harbourline Systems',
      startDate: '08/2017',
      endDate: '06/2019',
      location: 'Remote',
      description:
        'Full-stack work on a logistics scheduling product, from the React planning board to the routing service behind it.',
      achievements: [
        'Replaced a nightly batch scheduler with an incremental solver, improving on-time dispatch from 81% to 96%',
        'Built the CI pipeline the whole engineering group still uses, taking a release from a half-day to 20 minutes',
      ],
      skills: [],
    },
    {
      title: 'Junior Software Engineer',
      company: 'Fairhaven Digital',
      startDate: '06/2016',
      endDate: '07/2017',
      location: 'Boston, MA',
      description: 'Maintained client web applications and internal tooling for a digital agency.',
      achievements: [
        'Automated the deployment process for 20 client sites, removing a recurring source of release errors',
      ],
      skills: [],
    },
  ],
  strengths: [
    { title: 'Systems Design', description: 'Designs for failure modes and operational cost, not just the happy path.' },
    { title: 'Mentorship', description: 'Eight engineers coached through promotion in four years.' },
    { title: 'Incident Ownership', description: 'Drives root-cause analysis through to the fix that prevents recurrence.' },
    { title: 'Communication', description: 'Writes the design document people actually read before the meeting.' },
  ],
  // Shown only when a gallery preview asks for the section (see
  // generateTemplatePreviewHTML) or a draft has the switch on; off, as for
  // every resume by default.
  softSkills: [
    'Mentoring',
    'Cross-team communication',
    'Stakeholder management',
    'Ownership',
    'Clear technical writing',
    'Calm under pressure',
  ],
  skills: [
    'TypeScript', 'JavaScript', 'Python', 'Go', 'SQL', 'Java',
    'React', 'Next.js', 'Node.js', 'Express', 'Django', 'GraphQL',
    'PostgreSQL', 'MySQL', 'Redis', 'MongoDB', 'DynamoDB', 'Kafka',
    'AWS', 'GCP', 'Docker', 'Kubernetes', 'Terraform', 'GitHub Actions',
    'Jenkins', 'Prometheus', 'Grafana', 'Datadog', 'Jest', 'Playwright',
  ],
  education: [
    {
      degree: 'M.S. Computer Science',
      institution: 'University of Washington',
      startDate: '2014',
      endDate: '2016',
      location: 'Seattle, WA',
    },
    {
      degree: 'B.S. Computer Engineering',
      institution: 'Boston University',
      startDate: '2010',
      endDate: '2014',
      location: 'Boston, MA',
    },
  ],
  createdAt: '',
  updatedAt: '',
};

/**
 * The sample person's skills block as a model writes it for the tailoring
 * prompt: its own headings, about thirty skills, and the posting's soft skills
 * as the LAST group under the heading drawn for the resume, marked `soft` as
 * the parse marks it.
 */
const SAMPLE_SKILL_GROUPS: SkillGroup[] = [
  { category: 'Languages', skills: ['TypeScript', 'Python', 'Go', 'SQL', 'Java', 'JavaScript'] },
  { category: 'Frameworks', skills: ['Node.js', 'React', 'Next.js', 'Express', 'Django', 'GraphQL'] },
  { category: 'Data & Storage', skills: ['PostgreSQL', 'Redis', 'Kafka', 'DynamoDB', 'MongoDB', 'MySQL'] },
  { category: 'Cloud & Infrastructure', skills: ['AWS', 'GCP', 'Docker', 'Kubernetes', 'Terraform'] },
  { category: 'CI/CD & Monitoring', skills: ['GitHub Actions', 'Jenkins', 'Prometheus', 'Grafana', 'Datadog'] },
  { category: 'Testing', skills: ['Jest', 'Playwright', 'pytest', 'Pact'] },
  {
    category: 'Professional Skills',
    skills: ['Mentoring', 'Ownership', 'Communication skills', 'Collaboration', 'Problem solving'],
    soft: true,
  },
];

const SAMPLE_TECHNICAL_SKILLS = flattenSkillGroups(SAMPLE_SKILL_GROUPS.filter((group) => !group.soft));

/**
 * What the sample person's resume looks like once tailored, for the template
 * gallery: the shape a generated resume has, so a template is judged on what
 * it will actually print - a composed title, a summary and bullets in the
 * tailoring prompt's voice, no role descriptions (the prompt has the model
 * leave them empty, and the render prints none), at most eight bullets a
 * role, and the model's own skill groups ending in the soft-skill group, which
 * Soft Skills on moves into its section and off leaves in the block.
 *
 * Roles, employers, dates and places are SAMPLE_RESUME's own. Drawn by the
 * gallery and nothing else (test/sampleDefaults.test.js).
 */
export const SAMPLE_TAILORED_CONTENT: TailoredContent = {
  title: 'Senior Software Engineer | Backend Engineer',
  summary:
    '9 years of backend engineering across payment and data platforms, most of it on the services that ' +
    'move money and the pipelines that report on it. Day to day the work is TypeScript and Python services ' +
    'on AWS, with Kafka for event streaming and PostgreSQL underneath, and ownership running from the design ' +
    'review to the pager. Settlement, reconciliation and fraud checks are the domains known best, along with ' +
    'the analytics ingestion beside them. Mentoring is a steady part of the job, and so is the written ' +
    'communication that keeps product and SRE agreeing on what ships and when.',
  experience: [
    {
      title: 'Senior Software Engineer',
      company: 'Northwind Payments',
      startDate: '03/2022',
      endDate: 'Present',
      location: 'San Francisco, CA',
      description: '',
      achievements: [
        'Rebuilt the settlement pipeline in TypeScript on an event-sourced ledger in PostgreSQL, cutting end-of-day reconciliation from 6 hours to 18 minutes on a platform processing $2.4B a year',
        'Cut p99 authorisation latency from 840ms to 120ms by replacing synchronous fraud lookups with a cached risk service on Redis, and took ownership of the rollout across 4 regions',
        'Moved 14 services onto contract testing in GitHub Actions, taking integration failures in staging from roughly 30 a week to under 3',
        'Wrote the Kafka consumer library the ledger and payout services share, with dead-letter handling and replay, so a poisoned message no longer blocked a partition',
        'Mentored three engineers to senior through design reviews and paired on-call rotations; two now run teams of their own',
      ],
    },
    {
      title: 'Software Engineer II',
      company: 'Cobalt Analytics',
      startDate: '07/2019',
      endDate: '02/2022',
      location: 'Seattle, WA',
      description: '',
      achievements: [
        'Built a columnar ingestion path in Go handling 8TB a day, reducing storage cost per event by 62% for 1,200 customer organisations',
        'Shipped an incremental materialised-view engine in Python that brought dashboard loads under 2 seconds at the 95th percentile',
        'Moved the query layer from a single Postgres instance to a sharded cluster with no customer-visible downtime, and wrote the cutover runbook the team still uses',
        'Added Prometheus and Grafana alerts on ingestion lag, which caught 9 stalled partitions before a customer did',
      ],
    },
    {
      title: 'Software Engineer',
      company: 'Harbourline Systems',
      startDate: '08/2017',
      endDate: '06/2019',
      location: 'Remote',
      description: '',
      achievements: [
        'Replaced a nightly batch scheduler with an incremental solver, improving on-time dispatch from 81% to 96%',
        'Built the Jenkins CI pipeline the whole engineering group still uses, taking a release from half a day to 20 minutes',
        'Rewrote the React planning board against the routing service API, so dispatchers saw a changed route within 5 seconds instead of on the next refresh',
      ],
    },
    {
      title: 'Junior Software Engineer',
      company: 'Fairhaven Digital',
      startDate: '06/2016',
      endDate: '07/2017',
      location: 'Boston, MA',
      description: '',
      achievements: [
        'Automated the deployment process for 20 client sites, removing a recurring source of release errors',
        'Wrote content migration tooling in Node.js that the agency ran on 6 client launches',
        'Fixed accessibility defects across client web applications, with clear communication to account managers on what changed',
      ],
    },
  ],
  skillGroups: SAMPLE_SKILL_GROUPS,
  softSkillGroupHeading: 'Professional Skills',
  hardSkills: SAMPLE_TECHNICAL_SKILLS,
  skills: SAMPLE_TECHNICAL_SKILLS,
  softSkills: SAMPLE_SKILL_GROUPS[SAMPLE_SKILL_GROUPS.length - 1].skills,
  strengths: [],
};

/**
 * The parts of a draft the editor's preview may fill from the sample, in the
 * order the editor lists them. The response's `sampled` is a subset of these,
 * in this order, so a page can match it against its own inputs by name.
 *
 * Contact fields are named without their `contact.` prefix: they are single
 * inputs on the form, and the form is the one reading the list.
 */
export const SAMPLE_FIELDS = [
  'name',
  'title',
  'email',
  'phone',
  'location',
  'linkedin',
  'summary',
  'experience',
  'education',
  'skills',
  'strengths',
  'softSkills',
] as const;

export type SampleField = (typeof SAMPLE_FIELDS)[number];

function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === '';
}

function anyText(values: unknown[]): boolean {
  return values.some((value) =>
    Array.isArray(value) ? anyText(value) : typeof value === 'string' && value.trim() !== ''
  );
}

/** A row somebody has typed anything into. A freshly added blank row is not one. */
function experienceTyped(entry: Experience | undefined): boolean {
  if (!entry) return false;
  return anyText([
    entry.title,
    entry.company,
    entry.startDate,
    entry.endDate,
    entry.location,
    entry.description,
    entry.achievements,
  ]);
}

function educationTyped(entry: Education | undefined): boolean {
  if (!entry) return false;
  return anyText([
    entry.degree,
    entry.institution,
    entry.startDate,
    entry.endDate,
    entry.location,
    entry.gpa,
    entry.achievements,
  ]);
}

function strengthTyped(entry: Strength | undefined): boolean {
  return Boolean(entry) && anyText([entry?.title, entry?.description]);
}

/**
 * A draft for the editor's live preview, with the sample person standing in
 * wherever the draft is still empty - and the list of what was filled, so the
 * editor can say "Sample text shown for: ...".
 *
 * PER FIELD for the single values (a typed name with an empty phone shows the
 * typed name and the sample phone) and PER SECTION for the lists: a list is
 * either the person's or the sample's, never a mixture, so one typed role
 * replaces all four sample roles rather than being shuffled in among them.
 * Strengths and Soft Skills are filled only while their switch is on - as the
 * resume reads for the template being drawn, so pass it through
 * `resumeForTemplate` first - because off, the section is not drawn and
 * claiming it was "sampled" would be a lie.
 *
 * The preview ONLY. A sampled value must never be saved, generated, printed
 * or sent to a model, which is why this is applied in exactly one place,
 * `POST /api/resumes/preview`, after the draft has been read and never on
 * the way to anything that is kept. The input is not modified; the sample's
 * lists are copied, so nothing downstream can edit the shared sample.
 */
export function withSampleDefaults(resume: Resume): { resume: Resume; sampled: SampleField[] } {
  const sample = SAMPLE_RESUME;
  const sections = getResumeSections(resume);
  const filled = new Set<SampleField>();
  const pick = <T>(field: SampleField, typed: T, empty: boolean, fallback: () => T): T => {
    if (!empty) return typed;
    filled.add(field);
    return fallback();
  };

  const contact = resume.contact ?? { phone: '', email: '', location: '' };
  const hasSkills =
    (resume.skills ?? []).some((skill) => !isBlank(skill)) ||
    (resume.skillCategories ?? []).some((group) => (group.skills ?? []).some((skill) => !isBlank(skill)));
  const hasSoftSkills = (resume.softSkills ?? []).some((skill) => !isBlank(skill));

  const shown: Resume = {
    ...resume,
    name: pick('name', resume.name, isBlank(resume.name), () => sample.name),
    title: pick('title', resume.title, isBlank(resume.title), () => sample.title),
    contact: {
      ...contact,
      email: pick('email', contact.email, isBlank(contact.email), () => sample.contact.email),
      phone: pick('phone', contact.phone, isBlank(contact.phone), () => sample.contact.phone),
      location: pick('location', contact.location, isBlank(contact.location), () => sample.contact.location),
      linkedin: pick('linkedin', contact.linkedin, isBlank(contact.linkedin), () => sample.contact.linkedin),
    },
    summary: pick('summary', resume.summary, isBlank(resume.summary), () => sample.summary),
    experience: pick('experience', resume.experience, !(resume.experience ?? []).some(experienceTyped), () =>
      structuredClone(sample.experience)
    ),
    education: pick('education', resume.education, !(resume.education ?? []).some(educationTyped), () =>
      structuredClone(sample.education)
    ),
    strengths: pick(
      'strengths',
      resume.strengths,
      sections.strengths && !(resume.strengths ?? []).some(strengthTyped),
      () => structuredClone(sample.strengths)
    ),
    softSkills: pick('softSkills', resume.softSkills, sections.softSkills && !hasSoftSkills, () => [
      ...(sample.softSkills ?? []),
    ]),
  };

  // The two skill fields go together, as they are saved together: the
  // sample's list is flat, so a stale empty grouping must not sit beside it.
  if (!hasSkills) {
    filled.add('skills');
    shown.skills = [...sample.skills];
    delete shown.skillCategories;
  }

  return { resume: shown, sampled: SAMPLE_FIELDS.filter((field) => filled.has(field)) };
}
