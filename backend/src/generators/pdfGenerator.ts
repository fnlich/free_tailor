import puppeteer from 'puppeteer';
import type { Browser } from 'puppeteer';
import Handlebars from 'handlebars';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { Profile } from '../types/profile';
import { TailoredContent, Template } from '../types/template';
import type { GeneratedPathInfo } from '../utils/generatedPath';
import { getGeneratedFilePath, getResumeOutputFilename } from '../utils/generatedPath';
import {
  HARD_SKILL_CATEGORIES,
  HardSkillCategory,
  readHardSkillPriorityMap,
  readHardSkillRecords,
  readSkills,
} from '../database/skillsDatabase';
const MAX_ROLE_BRIEF_LENGTH = 1200;
const A4_PRINTABLE_WIDTH_PX = 698; // A4 width (8.27in) minus 0.5in margins on both sides at 96 DPI
const A4_PRINTABLE_HEIGHT_PX = 1026; // A4 height (11.69in) minus 0.5in margins top/bottom at 96 DPI

/**
 * The page box every resume is printed into.
 *
 * ONE definition, used by `page.pdf()` and by the on-screen preview alike. They
 * used to be unrelated: the PDF printed A4 with these margins at a 698px
 * viewport, while the preview rendered at whatever width the iframe happened to
 * be, inside a second wrapper document. Column counts, line wraps and page
 * breaks all differ with width, so "preview" and "what you get" were only ever
 * loosely related. Anything that changes here changes both.
 */
export const RESUME_PAGE_GEOMETRY = {
  format: 'A4',
  margin: { top: '0.4in', right: '0.5in', bottom: '0.3in', left: '0.5in' },
  contentWidthPx: A4_PRINTABLE_WIDTH_PX,
  contentHeightPx: A4_PRINTABLE_HEIGHT_PX,
} as const;
const LANGUAGE_SKILLS = new Set([
  'python',
  'javascript',
  'typescript',
  'java',
  'go',
  'golang',
  'rust',
  'ruby',
  'php',
  'c++',
  'c#',
  'kotlin',
  'swift',
  'scala',
  'sql',
  'html',
  'css',
  'elixir',
  'bash',
]);
const FRAMEWORK_SKILLS = new Set([
  'react',
  'react.js',
  'reactjs',
  'next',
  'next.js',
  'nextjs',
  'node',
  'node.js',
  'nodejs',
  'vue',
  'vue.js',
  'vuejs',
  'express',
  'express.js',
  'expressjs',
  'angular',
  'angular.js',
  'angularjs',
  'nest',
  'nestjs',
  'nest.js',
  'nuxt',
  'nuxt.js',
  'nuxtjs',
  'django',
  'flask',
  'fastapi',
  'fastify',
  'laravel',
  'rails',
  'spring',
  'spring boot',
  'springboot',
  'tensorflow',
  'pytorch',
  'torch',
  'keras',
  'scikit-learn',
  'sklearn',
  'pandas',
  'numpy',
  'redux',
  'react router',
  'tailwind',
  'tailwindcss',
  'mui',
  'material ui',
  'sass',
  'scss',
  'svelte',
  'svelte.js',
  'sveltejs',
  'ember',
  'ember.js',
  'emberjs',
  'jquery',
  'jquery.js',
  'jqueryjs',
  'bootstrap',
  'graphql',
  'swr',
  'flutter',
  'react native',
  'reactnative',
  '.net',
  'dotnet',
  'asp.net',
  'aspnet',
]);
const OTHER_TECH_SKILLS = new Set([
  'docker',
  'kubernetes',
  'k8s',
  'kube',
  'aws',
  'gcp',
  'azure',
  'git',
  'nginx',
  'redis',
  'celery',
  'postgres',
  'postgresql',
  'psql',
  'mongo',
  'mongodb',
  'mysql',
  'nosql',
  'openapi',
  'restful api',
  'rest api',
  'rest',
  'jwt',
  'oauth',
  'jest',
  'mocha',
  'chai',
  'ci/cd',
  'github actions',
  'gitlab ci',
  'vercel',
  'netlify',
  'figma',
  'sketch',
  'unix/linux',
  'linux',
  'rdbms/sql',
  'rdbms',
  'webpack',
  'vite',
  'gatsby',
  'eslint',
  'openai api',
  'llm',
  'terraform',
  'ansible',
  'jenkins',
  'kafka',
  'rabbitmq',
  'airflow',
  'dbt',
  'snowflake',
  'dynamodb',
]);

type SkillCategory = HardSkillCategory;

type SkillCategoryGroup = {
  category: SkillCategory;
  skills: string[];
};

const SKILL_CATEGORY_ORDER: SkillCategory[] = [...HARD_SKILL_CATEGORIES];
const SKILL_CATEGORY_LANGUAGE_CATEGORY: SkillCategory = 'Languages';
const SKILL_CATEGORY_MIN_LANGUAGE_SKILLS = 3;
const SKILL_CATEGORY_MAX_LANGUAGE_SKILLS = 5;
const SKILL_CATEGORY_MIN_SKILLS_PER_CATEGORY = 5;
const SKILL_CATEGORY_MAX_SKILLS_PER_CATEGORY = 10;
const SKILL_CATEGORY_MIN_CATEGORY_COUNT = 5;
const SKILL_CATEGORY_LANGUAGE_FILL_EXCLUDED_SKILLS = new Set(['bash', 'c#', 'html', 'css']);

function formatDuration(start: bigint, end: bigint): string {
  return `${(Number(end - start) / 1_000_000_000).toFixed(2)}s`;
}

async function timePdfStage<T>(label: string, action: () => Promise<T>): Promise<T> {
  const startedAt = process.hrtime.bigint();
  try {
    return await action();
  } finally {
    console.log(`[Resume timing] PDF ${label} finished in ${formatDuration(startedAt, process.hrtime.bigint())}`);
  }
}

function timePdfStageSync<T>(label: string, action: () => T): T {
  const startedAt = process.hrtime.bigint();
  try {
    return action();
  } finally {
    console.log(`[Resume timing] PDF ${label} finished in ${formatDuration(startedAt, process.hrtime.bigint())}`);
  }
}

let sharedPdfBrowser: Browser | null = null;
let sharedPdfBrowserLaunch: Promise<Browser> | null = null;
const PDF_BROWSER_USER_DATA_DIR = path.join(os.tmpdir(), `free-tailor-pdf-chrome-${process.pid}`);

async function getSharedPdfBrowser(): Promise<Browser> {
  if (sharedPdfBrowser?.connected) {
    return sharedPdfBrowser;
  }
  if (sharedPdfBrowserLaunch) {
    return sharedPdfBrowserLaunch;
  }

  sharedPdfBrowserLaunch = puppeteer.launch({
    headless: true,
    userDataDir: PDF_BROWSER_USER_DATA_DIR,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-features=FirstPartySets',
    ]
  }).then((browser) => {
    sharedPdfBrowser = browser;
    sharedPdfBrowserLaunch = null;
    browser.once('disconnected', () => {
      if (sharedPdfBrowser === browser) {
        sharedPdfBrowser = null;
      }
    });
    return browser;
  }).catch((error) => {
    sharedPdfBrowserLaunch = null;
    throw error;
  });

  return sharedPdfBrowserLaunch;
}

const SKILL_CATEGORY_LANGUAGE_SKILLS = new Set([
  ...LANGUAGE_SKILLS,
  'dart',
  'perl',
  'r',
  'r language',
  'matlab',
  'lua',
  'groovy',
  'shell',
  'powershell',
  'objective-c',
  'html5',
  'css3',
]);

const SKILL_CATEGORY_FRAMEWORK_SKILLS = new Set([
  ...FRAMEWORK_SKILLS,
  'babel',
  'chakra ui',
  'cypress',
  'emotion',
  'gatsby',
  'junit',
  'langchain',
  'llamaindex',
  'playwright',
  'prettier',
  'pytest',
  'selenium',
  'styled-components',
  'testng',
  'css modules',
  'asp.net',
  'asp.net core',
  'codeigniter',
  'django rest framework',
  'echo',
  'fastify',
  'gin',
  'grpc',
  'koa',
  'ktor',
  'spring framework',
  'spring mvc',
  'spring security',
  'swiftui',
]);

const SKILL_CATEGORY_INFRASTRUCTURE_SKILLS = new Set([
  'amazon web services',
  'ansible',
  'api gateway',
  'argocd',
  'autoscaling',
  'auto scaling',
  'aws',
  'azure',
  'chef',
  'cloud',
  'cloudfront',
  'cloudwatch',
  'datadog',
  'deployment',
  'docker',
  'ec2',
  'ecs',
  'eks',
  'elk',
  'fargate',
  'flux',
  'gcp',
  'google cloud',
  'grafana',
  'helm',
  'iac',
  'iam',
  'infrastructure',
  'istio',
  'jenkins',
  'k8s',
  'kube',
  'kubernetes',
  'lambda',
  'linkerd',
  'linux',
  'load balanc',
  'netlify',
  'network',
  'new relic',
  'nginx',
  'openshift',
  'prometheus',
  'puppet',
  'route 53',
  's3',
  'terraform',
  'unix/linux',
  'vpc',
  'vercel',
]);

const SKILL_CATEGORY_DATABASE_SKILLS = new Set([
  'activerecord',
  'cassandra',
  'couchdb',
  'database',
  'databases',
  'data lake',
  'dynamodb',
  'elasticsearch',
  'etl',
  'firestore',
  'influxdb',
  'memcached',
  'mongo',
  'mongodb',
  'mongoose',
  'mysql',
  'neo4j',
  'nosql',
  'oracle',
  'orm',
  'postgres',
  'postgresql',
  'prisma',
  'psql',
  'query',
  'rdbms',
  'rdbms/sql',
  'redis',
  'replication',
  'schema',
  'sequelize',
  'shard',
  'snowflake',
  'solr',
  'sql server',
  'sqlalchemy',
  'timescaledb',
  'typeorm',
  'warehouse',
]);

const SKILL_CATEGORY_TOOL_PRACTICE_SKILLS = new Set([
  ...OTHER_TECH_SKILLS,
  'airflow',
  'api',
  'ci',
  'dbt',
  'eslint',
  'figma',
  'git',
  'github',
  'github actions',
  'gitlab',
  'gitlab ci',
  'jira',
  'jwt',
  'oauth',
  'openai api',
  'openapi',
  'rabbitmq',
  'kafka',
  'rest',
  'rest api',
  'restful api',
  'sketch',
  'tdd',
]);

const SKILL_CATEGORY_CATEGORY_FALLBACK_SKILLS: Record<SkillCategory, string[]> = {
  Languages: ['Python', 'Java', 'JavaScript', 'TypeScript', 'Go', 'Ruby', 'PHP', 'SQL', 'Swift', 'Kotlin', 'Rust'],
  'Frameworks and Libraries': [
    'React',
    'Vue',
    'Django',
    'Flask',
    'Spring Boot',
    'Node.js',
    'Next.js',
    'Express',
    'Redux',
    'GraphQL',
  ],
  'Software Architecture & Design': ['Microservices', 'System Design', 'Distributed Systems', 'Caching', 'Design Patterns'],
  Security: ['OAuth', 'JWT', 'SAML', 'AWS IAM', 'API Security'],
  'Cloud and Infrastructure': [
    'AWS',
    'Docker',
    'Kubernetes',
    'Terraform',
    'Azure',
    'GCP',
    'Linux',
    'GitHub Actions',
    'Jenkins',
  ],
  'Databases and Storage': ['PostgreSQL', 'MySQL', 'MongoDB', 'Redis', 'DynamoDB', 'Elasticsearch', 'Snowflake'],
  'DevOps and CI/CD': ['GitHub Actions', 'Jenkins', 'CI/CD', 'Docker', 'Kubernetes', 'Terraform', 'ArgoCD'],
  'Observability and Monitoring': ['Grafana', 'Prometheus', 'Datadog', 'CloudWatch', 'New Relic', 'ELK Stack'],
  'Testing and Quality': ['Jest', 'Pytest', 'Cypress', 'Playwright', 'Selenium', 'JUnit', 'TestNG'],
  'APIs and Integration': ['REST API', 'GraphQL', 'OpenAPI', 'OAuth', 'JWT', 'Kafka', 'RabbitMQ'],
  'Engineering Practices & Methodology': ['Agile', 'Scrum', 'Kanban', 'Technical Documentation', 'Pair Programming'],
  'Data Engineering & Streaming': ['Kafka', 'RabbitMQ', 'Amazon Kinesis', 'Apache Kafka', 'ETL Pipelines'],
  'AI/ML & Data Science': ['PyTorch', 'TensorFlow', 'scikit-learn', 'Pandas', 'NumPy'],
  'Version Control & Collaboration': ['Git', 'GitHub', 'GitLab', 'Bitbucket', 'Code Review'],
  'Operating Systems & Platforms': ['Linux', 'Unix/Linux', 'Nginx', 'Windows', 'Network Security'],
  'Frontend & UI/UX Development': ['Tailwind CSS', 'CSS Grid', 'CSS Modules', 'Figma', 'Responsive Design'],
  'Mobile Development': ['React Native', 'Flutter', 'iOS', 'Android', 'SwiftUI'],
};

const SKILL_CATEGORY_LANGUAGE_FRAMEWORK_SKILLS: Array<{ languages: string[]; frameworks: string[] }> = [
  {
    languages: ['javascript', 'typescript'],
    frameworks: ['React', 'Node.js', 'Next.js', 'Express', 'Vue.js', 'Angular', 'NestJS', 'Fastify'],
  },
  {
    languages: ['php'],
    frameworks: ['Laravel', 'Symfony', 'CodeIgniter'],
  },
  {
    languages: ['python'],
    frameworks: ['Django', 'FastAPI', 'Flask', 'Django REST Framework', 'Pandas', 'NumPy'],
  },
  {
    languages: ['java'],
    frameworks: ['Spring Boot', 'Spring MVC', 'Spring Security', 'JUnit', 'TestNG'],
  },
  {
    languages: ['go', 'golang'],
    frameworks: ['Gin', 'Echo', 'gRPC'],
  },
  {
    languages: ['ruby'],
    frameworks: ['Ruby on Rails', 'Rails'],
  },
  {
    languages: ['c#'],
    frameworks: ['ASP.NET Core', 'ASP.NET'],
  },
  {
    languages: ['kotlin'],
    frameworks: ['Ktor', 'Spring Boot'],
  },
  {
    languages: ['swift'],
    frameworks: ['SwiftUI'],
  },
  {
    languages: ['dart'],
    frameworks: ['Flutter'],
  },
];

// Register Handlebars helpers
Handlebars.registerHelper('join', function(array: string[], separator: string) {
  if (!Array.isArray(array)) return '';
  return array.join(separator || ', ');
});

Handlebars.registerHelper('formatDate', function(date: string) {
  return date; // Keep as is for now
});

function normalizeSkills(skills: unknown): string[] {
  if (!Array.isArray(skills)) return [];
  const seen = new Set<string>();
  const result: string[] = [];

  for (const entry of skills) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }

  return result;
}

function trimIncompleteEnd(s: string): string {
  return s.trim().replace(/,+\s*$/, '').replace(/\s+(and|or)\s*$/i, '').trim();
}

function clampRoleBrief(description: string): string {
  const clean = description.trim().replace(/\s+/g, ' ');
  if (clean.length <= MAX_ROLE_BRIEF_LENGTH) return trimIncompleteEnd(clean);
  const truncated = clean.slice(0, MAX_ROLE_BRIEF_LENGTH);
  let result: string;
  const lastSentenceEnd = Math.max(
    truncated.lastIndexOf('. '),
    truncated.lastIndexOf('! '),
    truncated.lastIndexOf('? ')
  );
  if (lastSentenceEnd >= MAX_ROLE_BRIEF_LENGTH - 80) {
    result = truncated.slice(0, lastSentenceEnd + 1).trim();
  } else {
    const lastComma = truncated.lastIndexOf(', ');
    if (lastComma >= MAX_ROLE_BRIEF_LENGTH - 50) {
      result = truncated.slice(0, lastComma).trim();
    } else {
      const lastSpace = truncated.trimEnd().lastIndexOf(' ');
      result = lastSpace > 0 && lastSpace >= MAX_ROLE_BRIEF_LENGTH - 40
        ? truncated.slice(0, lastSpace).trim()
        : truncated.trimEnd();
    }
  }
  return trimIncompleteEnd(result);
}

function normalizeExperienceDescriptions<T extends { experience?: Array<{ description?: string }> }>(data: T): T {
  const experience = Array.isArray(data.experience)
    ? data.experience.map((entry) => ({
      ...entry,
      description: clampRoleBrief(entry.description ?? ''),
    }))
    : data.experience;

  return {
    ...data,
    experience,
  };
}

function normalizeHardSkillAlias(skill: string): string {
  return skill.trim().toLowerCase().replace(/\s+/g, ' ');
}

function matchesSkillTerm(normalizedSkill: string, rawTerm: string): boolean {
  const term = normalizeHardSkillAlias(rawTerm);
  if (!term) return false;
  return normalizedSkill === term
    || normalizedSkill.startsWith(`${term} `)
    || normalizedSkill.startsWith(`${term}-`)
    || normalizedSkill.startsWith(`${term}/`)
    || normalizedSkill.endsWith(` ${term}`)
    || normalizedSkill.includes(` ${term} `);
}

function matchesAnySkillTerm(normalizedSkill: string, terms: Iterable<string>): boolean {
  for (const term of terms) {
    if (matchesSkillTerm(normalizedSkill, term)) return true;
  }
  return false;
}

function getSkillCategory(skill: string): SkillCategory {
  const normalized = normalizeHardSkillAlias(skill);
  if (!normalized) return 'Frameworks and Libraries';

  const libraryRecord = readHardSkillRecords().find((record) => normalizeHardSkillAlias(record.skill) === normalized);
  if (libraryRecord) return libraryRecord.category;

  if (matchesAnySkillTerm(normalized, SKILL_CATEGORY_DATABASE_SKILLS)) {
    return 'Databases and Storage';
  }
  if (matchesAnySkillTerm(normalized, SKILL_CATEGORY_INFRASTRUCTURE_SKILLS)) {
    return 'Cloud and Infrastructure';
  }
  if (matchesAnySkillTerm(normalized, SKILL_CATEGORY_FRAMEWORK_SKILLS)) {
    return 'Frameworks and Libraries';
  }
  if (matchesAnySkillTerm(normalized, SKILL_CATEGORY_LANGUAGE_SKILLS)) {
    return SKILL_CATEGORY_LANGUAGE_CATEGORY;
  }
  if (matchesAnySkillTerm(normalized, SKILL_CATEGORY_TOOL_PRACTICE_SKILLS)) {
    return 'APIs and Integration';
  }

  return 'Frameworks and Libraries';
}

function getLibraryHardSkillRecord(skill: string): ReturnType<typeof readHardSkillRecords>[number] | undefined {
  const normalized = normalizeHardSkillAlias(skill);
  if (!normalized) return undefined;
  return readHardSkillRecords().find((record) => normalizeHardSkillAlias(record.skill) === normalized);
}

function normalizeLibraryHardSkills(skills: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const skill of normalizeSkills(skills)) {
    const record = getLibraryHardSkillRecord(skill);
    if (!record) continue;
    const key = normalizeHardSkillAlias(record.skill);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(record.skill);
  }

  return result;
}

function getRelatedFrameworkSkillsForLanguages(languageSkills: string[]): string[] {
  const related: string[] = [];
  const seen = new Set<string>();
  const normalizedLanguages = languageSkills.map(normalizeHardSkillAlias);

  for (const language of normalizedLanguages) {
    const rule = SKILL_CATEGORY_LANGUAGE_FRAMEWORK_SKILLS.find((candidateRule) =>
      candidateRule.languages.some((candidate) => matchesSkillTerm(language, candidate))
    );
    if (!rule) continue;

    for (const framework of rule.frameworks) {
      const key = normalizeHardSkillAlias(framework);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      related.push(framework);
    }
  }

  return related;
}

function prioritizeRelatedFrameworkCandidates(
  languageSkills: string[],
  frameworkCandidates: string[],
  used: Set<string>
): string[] {
  const existingByKey = new Map(
    frameworkCandidates.map((skill) => [normalizeHardSkillAlias(skill), skill] as const)
  );
  const prioritized: string[] = [];
  const prioritizedKeys = new Set<string>();

  for (const skill of getRelatedFrameworkSkillsForLanguages(languageSkills)) {
    const key = normalizeHardSkillAlias(skill);
    if (!key || used.has(key) || prioritizedKeys.has(key)) continue;
    prioritizedKeys.add(key);
    prioritized.push(existingByKey.get(key) ?? skill);
  }

  return [
    ...prioritized,
    ...frameworkCandidates.filter((skill) => !prioritizedKeys.has(normalizeHardSkillAlias(skill))),
  ];
}

type SkillCategoryBuildOptions = {
  forceAllCategories?: boolean;
  relateFrameworksToLanguages?: boolean;
};

function buildSkillCategories(
  skills: string[],
  supplementalSkills: string[] = [],
  options: SkillCategoryBuildOptions = {}
): SkillCategoryGroup[] {
  const grouped = new Map<SkillCategory, string[]>(
    SKILL_CATEGORY_ORDER.map((category) => [category, []])
  );
  const used = new Set<string>();

  for (const skill of normalizeLibraryHardSkills(skills)) {
    const key = normalizeHardSkillAlias(skill);
    if (used.has(key)) continue;
    used.add(key);
    grouped.get(getSkillCategory(skill))?.push(skill);
  }

  const candidateByCategory = new Map<SkillCategory, string[]>(
    SKILL_CATEGORY_ORDER.map((category) => [category, []])
  );
  const candidateSeen = new Set<string>();

  const addFillCandidate = (skill: string) => {
    const record = getLibraryHardSkillRecord(skill);
    if (!record) return;
    const key = normalizeHardSkillAlias(record.skill);
    if (!key || used.has(key) || candidateSeen.has(key)) return;
    candidateSeen.add(key);
    candidateByCategory.get(record.category)?.push(record.skill);
  };

  for (const skill of sortHardSkillsByPriority(supplementalSkills)) {
    addFillCandidate(skill);
  }

  for (const category of SKILL_CATEGORY_ORDER) {
    for (const skill of SKILL_CATEGORY_CATEGORY_FALLBACK_SKILLS[category]) {
      if (getSkillCategory(skill) === category) {
        addFillCandidate(skill);
      }
    }
  }

  for (const skill of sortHardSkillsByPriority(readSkills('hard'))) {
    addFillCandidate(skill);
  }

  const includedCategories = new Set<SkillCategory>([SKILL_CATEGORY_LANGUAGE_CATEGORY]);
  for (const category of SKILL_CATEGORY_ORDER) {
    if (category !== SKILL_CATEGORY_LANGUAGE_CATEGORY && (grouped.get(category)?.length ?? 0) > 0) {
      includedCategories.add(category);
    }
  }

  if (includedCategories.size === 1 && options.forceAllCategories) {
    includedCategories.add('Frameworks and Libraries');
    includedCategories.add('Cloud and Infrastructure');
  }

  if (options.forceAllCategories) {
    for (const category of SKILL_CATEGORY_ORDER) {
      if (includedCategories.size >= SKILL_CATEGORY_MIN_CATEGORY_COUNT) break;
      if (category !== SKILL_CATEGORY_LANGUAGE_CATEGORY) {
        includedCategories.add(category);
      }
    }
  }

  for (const category of SKILL_CATEGORY_ORDER) {
    if (!includedCategories.has(category)) continue;
    const categorySkills = grouped.get(category) ?? [];
    if (category === SKILL_CATEGORY_LANGUAGE_CATEGORY) {
      for (const skill of candidateByCategory.get(category) ?? []) {
        const targetCount = options.forceAllCategories
          ? SKILL_CATEGORY_MIN_LANGUAGE_SKILLS
          : SKILL_CATEGORY_MAX_LANGUAGE_SKILLS;
        if (categorySkills.length >= targetCount) break;
        const key = normalizeHardSkillAlias(skill);
        if (SKILL_CATEGORY_LANGUAGE_FILL_EXCLUDED_SKILLS.has(key)) continue;
        if (used.has(key)) continue;
        used.add(key);
        categorySkills.push(skill);
      }

      if (!options.forceAllCategories) {
        categorySkills.splice(SKILL_CATEGORY_MAX_LANGUAGE_SKILLS);
      }
      if (options.relateFrameworksToLanguages) {
        candidateByCategory.set(
          'Frameworks and Libraries',
          prioritizeRelatedFrameworkCandidates(
            categorySkills,
            candidateByCategory.get('Frameworks and Libraries') ?? [],
            used
          )
        );
      }
      continue;
    }

    if (
      categorySkills.length >= SKILL_CATEGORY_MIN_SKILLS_PER_CATEGORY ||
      (!options.forceAllCategories && categorySkills.length === 0)
    ) {
      continue;
    }

    for (const skill of candidateByCategory.get(category) ?? []) {
      if (categorySkills.length >= SKILL_CATEGORY_MIN_SKILLS_PER_CATEGORY) break;
      const key = normalizeHardSkillAlias(skill);
      if (used.has(key)) continue;
      used.add(key);
      categorySkills.push(skill);
    }
  }

  return SKILL_CATEGORY_ORDER
    .filter((category) => includedCategories.has(category))
    .map((category) => ({
      category,
      skills: grouped.get(category) ?? [],
    }))
    .filter((group) => group.skills.length > 0);
}

function passesPromptHardSkillGate(skill: string): boolean {
  const normalized = normalizeHardSkillAlias(skill);
  if (!normalized) return false;

  const rejectedConcepts = new Set([
    'agile',
    'scrum',
    'kanban',
    'ci/cd',
    'cicd',
    'system design',
    'systems design',
    'microservices',
    'microservice architecture',
    'backend development',
    'frontend development',
    'full-stack development',
    'full stack development',
    'project management',
  ]);

  return !rejectedConcepts.has(normalized);
}

function enforcePromptSkillCategoryCounts(
  skills: string[],
  supplementalSkills: string[] = []
): SkillCategoryGroup[] {
  const promptHardSkills = normalizeSkills(skills).filter(passesPromptHardSkillGate);
  const promptSupplementalSkills = normalizeSkills(supplementalSkills).filter(passesPromptHardSkillGate);
  const groups = buildSkillCategories(promptHardSkills, promptSupplementalSkills, {
    forceAllCategories: true,
    relateFrameworksToLanguages: true,
  });

  return groups.map((group) => ({
    ...group,
    skills: group.skills.slice(
      0,
      group.category === SKILL_CATEGORY_LANGUAGE_CATEGORY ? SKILL_CATEGORY_MAX_LANGUAGE_SKILLS : SKILL_CATEGORY_MAX_SKILLS_PER_CATEGORY
    ),
  }));
}

const ALLOWED_TECH_SKILLS = new Set<string>();
let hardSkillPriorityMap = readHardSkillPriorityMap();

function loadAllowedTechSkills() {
  ALLOWED_TECH_SKILLS.clear();
  for (const skill of readSkills('hard')) {
    ALLOWED_TECH_SKILLS.add(normalizeHardSkillAlias(skill));
  }
  hardSkillPriorityMap = readHardSkillPriorityMap();
}

loadAllowedTechSkills();

export function refreshAllowedTechSkills() {
  loadAllowedTechSkills();
}


function sortHardSkillsByPriority(skills: string[]): string[] {
  return [...normalizeSkills(skills)].sort((a, b) => {
    const aPriority = hardSkillPriorityMap.get(normalizeHardSkillAlias(a)) ?? Number.MAX_SAFE_INTEGER;
    const bPriority = hardSkillPriorityMap.get(normalizeHardSkillAlias(b)) ?? Number.MAX_SAFE_INTEGER;

    if (aPriority !== bPriority) {
      return aPriority - bPriority;
    }

    return a.localeCompare(b, undefined, { sensitivity: 'base' });
  });
}

type SkillsData = {
  hardSkills?: string[];
  softSkills?: string[];
  skills?: string[];
  skillInventory?: string[];
};

type SkillsLimitedData<T> = T & {
  hardSkills: string[];
  softSkills: string[];
  skills: string[];
  skillCategories: SkillCategoryGroup[];
};

function applySkillsLimit<T extends SkillsData>(data: T): SkillsLimitedData<T> {
  const hasTailoredHardSkills = Array.isArray(data.hardSkills) && data.hardSkills.length > 0;
  if (hasTailoredHardSkills) {
    const selectedHardSkills = normalizeSkills(data.hardSkills ?? []);
    const skillCategories = enforcePromptSkillCategoryCounts(
      selectedHardSkills,
      data.skillInventory
    );

    return {
      ...data,
      hardSkills: skillCategories.map((group) => `${group.category}: ${group.skills.join(', ')}`),
      softSkills: [],
      skills: skillCategories.map((group) => `${group.category}: ${group.skills.join(', ')}`),
      strengths: [],
      skillCategories,
    } as SkillsLimitedData<T>;
  }

  const skillInventoryRaw = data.hardSkills && data.hardSkills.length > 0
    ? data.hardSkills
    : data.skills ?? [];
  const baseSkills = sortHardSkillsByPriority(skillInventoryRaw);
  const skillCategories = buildSkillCategories(baseSkills, data.skillInventory, {
    forceAllCategories: true,
    relateFrameworksToLanguages: true,
  });

  return {
    ...data,
    hardSkills: skillCategories.map((group) => `${group.category}: ${group.skills.join(', ')}`),
    softSkills: [],
    skills: skillCategories.map((group) => `${group.category}: ${group.skills.join(', ')}`),
    strengths: [],
    skillCategories,
  } as SkillsLimitedData<T>;
}

function getResumeTitle(profile: Profile): string {
  const profileTitle = profile.title?.trim();
  if (profileTitle) return profileTitle;
  const lastRole = profile.experience?.[0]?.title?.trim();
  return lastRole || 'Professional';
}

/** Sanitize title for ATS: remove hyphens, periods, commas, and other symbols */
function sanitizeTitleForATS(title: string): string {
  return title
    .replace(/[-.,;:'"()\[\]\/\\@#$%&*+=<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeExternalUrl(value: string | undefined): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed.replace(/^\/+/, '')}`;
}

function getExternalUrlDisplay(value: string | undefined): string {
  const normalized = normalizeExternalUrl(value);
  if (!normalized) return '';

  try {
    const url = new URL(normalized);
    const host = url.hostname.replace(/^www\./i, '');
    const path = `${url.pathname}${url.search}${url.hash}`;
    return `${host}${path}`.replace(/\/$/, '');
  } catch {
    return normalized
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
      .replace(/^www\./i, '')
      .replace(/\/$/, '');
  }
}

function rewriteLinkedInAnchorDisplay(html: string): string {
  return html.replace(
    /<a\b([^>]*)href=(["'])(https?:\/\/(?:www\.)?linkedin\.com\/[^"']+)\2([^>]*)>([^<]*)<\/a>/gi,
    (match, beforeHref, quote, href, afterHref, text) => {
      const trimmedText = String(text ?? '').trim();
      const displayText = getExternalUrlDisplay(href);
      const acceptableCurrentTexts = new Set([
        href,
        href.replace(/^https?:\/\//i, ''),
        href.replace(/^https?:\/\/www\./i, ''),
        displayText,
      ]);

      if (!acceptableCurrentTexts.has(trimmedText)) {
        return match;
      }

      return `<a${beforeHref}href=${quote}${href}${quote}${afterHref}>${displayText}</a>`;
    }
  );
}

function enforceSkillCategoryLineBreaks(html: string): string {
  const categoryPattern = '(Programming &(?:amp;)? Scripting Languages|Languages|Frameworks (?:and|&(?:amp;)?) Libraries|Software Architecture &(?:amp;)? Design|Security|Cloud (?:and|&(?:amp;)?) Infrastructure|Infrastructure &(?:amp;)? Cloud|Databases (?:and|&(?:amp;)?) Storage|DevOps (?:and|&(?:amp;)?) CI/CD|Observability (?:and|&(?:amp;)?) Monitoring|Testing (?:and|&(?:amp;)?) Quality|APIs (?:and|&(?:amp;)?) Integration|Engineering Practices &(?:amp;)? Methodology|Data Engineering &(?:amp;)? Streaming|AI/ML &(?:amp;)? Data Science|Version Control &(?:amp;)? Collaboration|Operating Systems &(?:amp;)? Platforms|Frontend &(?:amp;)? UI/UX Development|Mobile Development|Cloud &(?:amp;)? DevOps|Databases|Tools &(?:amp;)? Practices|Tools|Methods)';
  const categoryTextPattern = new RegExp(
    `<(span|div)\\b([^>]*)>\\s*${categoryPattern}:\\s*([^<]*?)\\s*(?:[•·]|â€¢)?\\s*<\\/\\1>`,
    'gi'
  );

  return html.replace(categoryTextPattern, (_match, _tagName, attributes, category, skills) => {
    const normalizedSkills = String(skills ?? '').trim();
    const rawAttributes = String(attributes ?? '');
    const hasSkillChip = rawAttributes.includes('skill-chip');
    const cleanedAttributes = rawAttributes.replace(/\sclass=(["']).*?\1/i, '');
    const className = hasSkillChip ? 'skill-category skill-chip' : 'skill-category';
    return `<div${cleanedAttributes} class="${className}"><div class="skill-category-title">${category}</div><div class="skill-category-skills">${normalizedSkills}</div></div>`;
  });
}

function stripTemplateSectionByClass(html: string, className: string): string {
  let output = html;
  let searchFrom = 0;

  while (searchFrom < output.length) {
    const classIndex = output.indexOf(className, searchFrom);
    if (classIndex === -1) break;

    const tagStart = output.lastIndexOf('<div', classIndex);
    if (tagStart === -1) {
      searchFrom = classIndex + className.length;
      continue;
    }

    let cursor = tagStart;
    let depth = 0;
    let sectionEnd = -1;
    const tagPattern = /<\/?div\b[^>]*>/gi;
    tagPattern.lastIndex = tagStart;

    let match: RegExpExecArray | null;
    while ((match = tagPattern.exec(output)) !== null) {
      const tag = match[0];
      if (tag.startsWith('</')) {
        depth -= 1;
        if (depth === 0) {
          sectionEnd = tagPattern.lastIndex;
          break;
        }
      } else {
        depth += 1;
      }
      cursor = tagPattern.lastIndex;
    }

    if (sectionEnd === -1 || cursor <= tagStart) {
      searchFrom = classIndex + className.length;
      continue;
    }

    const beforeSection = output.slice(0, tagStart);
    const blockPrefixMatch = beforeSection.match(/\s*\{\{#if\s+(?:strengths|softSkills)\.length\}\}\s*$/);
    const blockStart = blockPrefixMatch ? tagStart - blockPrefixMatch[0].length : tagStart;
    const blockSuffixMatch = output.slice(sectionEnd).match(/^\s*\{\{\/if\}\}/);
    const blockEnd = blockSuffixMatch ? sectionEnd + blockSuffixMatch[0].length : sectionEnd;

    output = `${output.slice(0, blockStart)}${output.slice(blockEnd)}`;
    searchFrom = blockStart;
  }

  return output;
}

function normalizeTemplateSkillsSections(html: string): string {
  let output = stripTemplateSectionByClass(html, 'section-soft-skills');
  output = stripTemplateSectionByClass(output, 'section-strengths');
  output = output
    .replace(/Hard Skills/g, 'Technical Skills')
    .replace(
      /\{\{#if hardSkills\.length\}\}\s*\{\{#each hardSkills\}\}\s*<div class="skill-box">\{\{this\}\}<\/div>\s*\{\{\/each\}\}\s*\{\{else\}\}\s*\{\{#each skills\}\}\s*<div class="skill-box">\{\{this\}\}<\/div>\s*\{\{\/each\}\}\s*\{\{\/if\}\}/g,
      '{{#each skillCategories}}<div class="skill-category"><div class="skill-category-title">{{category}}</div><div class="skill-category-skills">{{join skills ", "}}</div></div>{{/each}}'
    )
    .replace(
      /\{\{#if hardSkills\.length\}\}\s*\{\{#each hardSkills\}\}<span>\{\{this\}\}\{\{#unless @last\}\} . \{\{\/unless\}\}<\/span>\{\{\/each\}\}\s*\{\{else\}\}\s*\{\{#each skills\}\}<span>\{\{this\}\}\{\{#unless @last\}\} . \{\{\/unless\}\}<\/span>\{\{\/each\}\}\s*\{\{\/if\}\}/g,
      '{{#each skillCategories}}<div class="skill-category"><div class="skill-category-title">{{category}}</div><div class="skill-category-skills">{{join skills ", "}}</div></div>{{/each}}'
    )
    .replace(
      /\{\{#if hardSkills\.length\}\}\s*\{\{#each hardSkills\}\}\s*<span class="skill-chip">\{\{this\}\}<\/span>\s*\{\{\/each\}\}\s*\{\{else\}\}\s*\{\{#each skills\}\}\s*<span class="skill-chip">\{\{this\}\}<\/span>\s*\{\{\/each\}\}\s*\{\{\/if\}\}/g,
      '{{#each skillCategories}}<div class="skill-category skill-chip"><div class="skill-category-title">{{category}}</div><div class="skill-category-skills">{{join skills ", "}}</div></div>{{/each}}'
    )
    .replace(
      /\{\{#if hardSkills\.length\}\}\s*\{\{#each hardSkills\}\}<span>\{\{this\}\}\{\{#unless @last\}\}[^{}]*\{\{\/unless\}\}<\/span>\{\{\/each\}\}\s*\{\{else\}\}\s*\{\{#each skills\}\}<span>\{\{this\}\}\{\{#unless @last\}\}[^{}]*\{\{\/unless\}\}<\/span>\{\{\/each\}\}\s*\{\{\/if\}\}/g,
      '{{#each skillCategories}}<div class="skill-category"><div class="skill-category-title">{{category}}</div><div class="skill-category-skills">{{join skills ", "}}</div></div>{{/each}}'
    )
    .replace(
      /\{\{#each hardSkills\}\}\s*<li[^>]*>\{\{this\}\}<\/li>\s*\{\{\/each\}\}/g,
      '{{#each skillCategories}}<li><strong>{{category}}</strong><br>{{join skills ", "}}</li>{{/each}}'
    );

  return output;
}

export function prepareResumeRenderData(
  profile: Profile,
  tailoredContent?: TailoredContent,
  companyName?: string,
  role?: string
) {
  const linkedinHref = normalizeExternalUrl(profile.contact?.linkedin);
  const linkedinDisplay = getExternalUrlDisplay(profile.contact?.linkedin);
  const tailoredHardSkills = tailoredContent?.hardSkills ?? [];
  const tailoredSkills = tailoredContent?.skills ?? [];
  const data = {
    ...profile,
    contact: {
      ...profile.contact,
      linkedin: linkedinHref,
      linkedinHref,
      linkedinDisplay,
    },
    companyName: companyName || '',
    role: role || '',
    title: sanitizeTitleForATS(getResumeTitle(profile)),
    skillInventory: normalizeSkills([
      ...(profile.skills ?? []),
      ...tailoredHardSkills,
      ...tailoredSkills,
    ]),
    ...(tailoredContent && {
      summary: tailoredContent.summary,
      experience: tailoredContent.experience,
      skills: tailoredSkills,
      hardSkills: tailoredHardSkills,
      softSkills: [],
      strengths: []
    })
  };
  return normalizeExperienceDescriptions(applySkillsLimit(data));
}

function compileTemplate(template: Template) {
  if (typeof template.htmlContent !== 'string' || !template.htmlContent.trim()) {
    throw new Error(`Template "${template.name || template.id}" is missing htmlContent`);
  }

  return Handlebars.compile(normalizeTemplateSkillsSections(template.htmlContent));
}

export async function generateResumePDF(
  profile: Profile,
  template: Template,
  tailoredContent: TailoredContent | undefined,
  pathInfo: GeneratedPathInfo,
  companyName?: string,
  role?: string
): Promise<string> {
  const renderData = timePdfStageSync('render data preparation', () =>
    prepareResumeRenderData(
      profile,
      tailoredContent,
      companyName,
      role
    )
  );

  // Compile and render template
  const html = timePdfStageSync('template render', () => renderTemplateBody(template, renderData));

  // Add CSS if separate
  const fullHtml = timePdfStageSync('HTML assembly', () => assembleResumeDocument(template, html));

  // Generate PDF with Puppeteer
  const browser = await timePdfStage('browser ready', () => getSharedPdfBrowser());
  let page: Awaited<ReturnType<Browser['newPage']>> | null = null;

  try {
    const activePage = await timePdfStage('new page', () => browser.newPage());
    page = activePage;
    await timePdfStage('page setup', async () => {
      await activePage.setViewport({
        width: RESUME_PAGE_GEOMETRY.contentWidthPx,
        height: RESUME_PAGE_GEOMETRY.contentHeightPx,
        deviceScaleFactor: 1,
      });
      await activePage.emulateMediaType('print');
    });
    await timePdfStage('HTML load', () => activePage.setContent(fullHtml, { waitUntil: 'load' }));

    const pdfFilename = getResumeOutputFilename(pathInfo, 'pdf');
    const relativePath = `${pathInfo.storagePathBase}/${pdfFilename}`;
    const filepath = path.join(pathInfo.absoluteDir, pdfFilename);
    const finalPdf = await timePdfStage('export', async () =>
      Buffer.from(await activePage.pdf({
        format: RESUME_PAGE_GEOMETRY.format,
        margin: { ...RESUME_PAGE_GEOMETRY.margin },
        printBackground: true
      }))
    );

    await timePdfStage('file write', async () => {
      await fs.mkdir(path.dirname(filepath), { recursive: true });
      await fs.writeFile(filepath, finalPdf);
    });

    return relativePath;
  } finally {
    if (page) {
      const pageToClose = page;
      await timePdfStage('page close', () => pageToClose.close());
    }
  }
}

export async function generatePreviewHTML(
  profile: Profile,
  template: Template,
  tailoredContent?: TailoredContent
): Promise<string> {
  const renderData = prepareResumeRenderData(profile, tailoredContent);

  // Compile and render template
  const compiledTemplate = compileTemplate(template);
  const html = enforceSkillCategoryLineBreaks(rewriteLinkedInAnchorDisplay(compiledTemplate(renderData)));

  // Add CSS if separate
  return template.cssContent 
    ? `<style>${template.cssContent}</style>${html}`
    : html;
}

/** Sample profile for template preview */
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
 */
const SAMPLE_PROFILE: Profile = {
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

/** Compiles a template against render data. Shared so preview and PDF agree. */
function renderTemplateBody(template: Template, renderData: unknown): string {
  const compiledTemplate = compileTemplate(template);
  return enforceSkillCategoryLineBreaks(
    rewriteLinkedInAnchorDisplay(compiledTemplate(renderData))
  );
}

/** Prepends a template's separate stylesheet, if it has one. */
function assembleResumeDocument(template: Template, body: string): string {
  return template.cssContent ? `<style>${template.cssContent}</style>${body}` : body;
}

/**
 * Turns the printed page into something a browser can show, WITHOUT changing
 * the document the PDF renderer sees.
 *
 * The body is given the exact content width `page.pdf()` prints into, so every
 * width-dependent decision a template makes - `column-count`, flex wrapping,
 * where a line breaks - resolves the same way it will in the PDF.
 *
 * WIDTH IS ALL IT SETS ON THE BODY, and that restraint is load-bearing. An
 * earlier version drew the page margins as a border on the body, which looked
 * right and was wrong: a border stops the first child's top margin collapsing
 * through the body, and `timeline-bars` pulls its header up with
 * `margin: -10px`. Measured, that put every element below it 10px out against
 * the PDF. Padding and vertical margins on the body break collapsing the same
 * way, so the page margins go on `html`, where they cannot reach the body's
 * own box.
 *
 * Appended last so it wins ties against the template's own `body` rules.
 */
function previewPageChrome(): string {
  const { margin, contentWidthPx, contentHeightPx } = RESUME_PAGE_GEOMETRY;
  return `<style id="resume-preview-page">
    html {
      background: #ffffff;
      /* The printed page margins. On html, so the body's box is untouched. */
      padding: ${margin.top} ${margin.right} ${margin.bottom} ${margin.left};
      /* page.pdf runs with printBackground: true, so colours must not be
         dropped the way a screen render would drop them. */
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    body {
      width: ${contentWidthPx}px !important;
      min-height: ${contentHeightPx}px !important;
      margin-left: auto !important;
      margin-right: auto !important;
    }
  </style>`;
}

export function generateTemplatePreviewHTML(template: Template): string {
  const renderData = prepareResumeRenderData(SAMPLE_PROFILE);
  const document = assembleResumeDocument(template, renderTemplateBody(template, renderData));
  return `${document}${previewPageChrome()}`;
}

export async function getGeneratedPDFPath(filename: string): Promise<string | null> {
  return getGeneratedFilePath(filename);
}
