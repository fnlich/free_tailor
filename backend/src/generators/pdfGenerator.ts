import puppeteer from 'puppeteer';
import type { Browser } from 'puppeteer';
import Handlebars from 'handlebars';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
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
const SOFT_SKILL_SIGNALS = [
  'communication',
  'collaboration',
  'mindset',
  'mentality',
  'ownership',
  'autonomy',
  'independent',
  'self-directed',
  'adapt',
  'ambiguity',
  'passion',
  'attention to detail',
  'team player',
  'cross-functional',
  'stakeholder',
  'leadership',
  'problem-solving',
  'product-minded',
  'driving clarity',
  'transparency',
];
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

type KimuraSkillCategory = HardSkillCategory;

type KimuraSkillCategoryGroup = {
  category: KimuraSkillCategory;
  skills: string[];
};

const KIMURA_SKILL_CATEGORY_ORDER: KimuraSkillCategory[] = [...HARD_SKILL_CATEGORIES];
const DAVID_KIMURA_PROFILE_ID = '2e7542a5-f9fd-473c-873a-28e7ab48e77b';
const LEO_WU_PROFILE_ID = 'c93ba1c1-390e-4d38-87d7-93cb74502cb1';
const KIMURA_LANGUAGE_CATEGORY: KimuraSkillCategory = 'Languages';
const KIMURA_MIN_LANGUAGE_SKILLS = 3;
const KIMURA_MAX_LANGUAGE_SKILLS = 5;
const KIMURA_MIN_SKILLS_PER_CATEGORY = 5;
const KIMURA_MAX_SKILLS_PER_CATEGORY = 10;
const KIMURA_MIN_CATEGORY_COUNT = 5;
const KIMURA_LANGUAGE_FILL_EXCLUDED_SKILLS = new Set(['bash', 'c#', 'html', 'css']);

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

const KIMURA_LANGUAGE_SKILLS = new Set([
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

const KIMURA_FRAMEWORK_SKILLS = new Set([
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

const KIMURA_INFRASTRUCTURE_SKILLS = new Set([
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

const KIMURA_DATABASE_SKILLS = new Set([
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

const KIMURA_TOOL_PRACTICE_SKILLS = new Set([
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

const KIMURA_CATEGORY_FALLBACK_SKILLS: Record<KimuraSkillCategory, string[]> = {
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

const KIMURA_LANGUAGE_FRAMEWORK_SKILLS: Array<{ languages: string[]; frameworks: string[] }> = [
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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getBoldKeywordPool(data: {
  hardSkills?: string[];
  skills?: string[];
  softSkills?: string[];
}): string[] {
  const all = [...(data.hardSkills ?? []), ...(data.skills ?? []), ...(data.softSkills ?? [])]
    .map((s) => s.trim())
    .filter((s) => s.length >= 3)
    .filter((s) => !/[<>]/.test(s));
  const seen = new Set<string>();
  return all.filter((s) => {
    const key = s.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => b.length - a.length);
}

function boldKeywordsInText(text: string, keywords: string[]): string {
  let out = text;
  for (const keyword of keywords) {
    const pattern = new RegExp(`(^|[^A-Za-z0-9_])(${escapeRegExp(keyword)})(?=[^A-Za-z0-9_]|$)`, 'gi');
    out = out.replace(pattern, (match, left, term) => `${left}<strong>${term}</strong>`);
  }
  return out;
}

function applyKeywordBolding<T extends {
  summary?: string;
  experience?: Array<{ description?: string; achievements?: string[] }>;
  hardSkills?: string[];
  skills?: string[];
  softSkills?: string[];
}>(data: T): T {
  const keywords = getBoldKeywordPool(data);
  if (keywords.length === 0) return data;

  const experience = Array.isArray(data.experience)
    ? data.experience.map((entry) => ({
      ...entry,
      description: entry.description ? boldKeywordsInText(entry.description, keywords) : entry.description,
      achievements: Array.isArray(entry.achievements)
        ? entry.achievements.map((a) => boldKeywordsInText(a, keywords))
        : entry.achievements,
    }))
    : data.experience;

  const hardSkills = Array.isArray(data.hardSkills)
    ? data.hardSkills.map((skill) => `<strong>${skill}</strong>`)
    : data.hardSkills;
  const skills = Array.isArray(data.skills)
    ? data.skills.map((skill) => `<strong>${skill}</strong>`)
    : data.skills;
  const softSkills = Array.isArray(data.softSkills)
    ? data.softSkills.map((skill) => `<strong>${skill}</strong>`)
    : data.softSkills;

  return {
    ...data,
    summary: data.summary ? boldKeywordsInText(data.summary, keywords) : data.summary,
    experience,
    hardSkills,
    skills,
    softSkills,
  };
}

function decodeAllowedTags(html: string): string {
  return html
    .replace(/&lt;(\/?)strong&gt;/gi, '<$1strong>')
    .replace(/&lt;(\/?)b&gt;/gi, '<$1b>');
}

const JOB_TITLE_EXCLUSIONS = new Set([
  'full stack developer', 'fullstack developer', 'full-stack developer',
  'frontend developer', 'front-end developer', 'frotnend developer',
  'backend developer', 'back-end developer',
  'full stack engineer', 'frontend engineer', 'backend engineer',
  'software developer', 'software engineer',
]);

function capitalizeHardSkill(s: string): string {
  if (!s || s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
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

function getKimuraSkillCategory(skill: string): KimuraSkillCategory {
  const normalized = normalizeHardSkillAlias(skill);
  if (!normalized) return 'Frameworks and Libraries';

  const libraryRecord = readHardSkillRecords().find((record) => normalizeHardSkillAlias(record.skill) === normalized);
  if (libraryRecord) return libraryRecord.category;

  if (matchesAnySkillTerm(normalized, KIMURA_DATABASE_SKILLS)) {
    return 'Databases and Storage';
  }
  if (matchesAnySkillTerm(normalized, KIMURA_INFRASTRUCTURE_SKILLS)) {
    return 'Cloud and Infrastructure';
  }
  if (matchesAnySkillTerm(normalized, KIMURA_FRAMEWORK_SKILLS)) {
    return 'Frameworks and Libraries';
  }
  if (matchesAnySkillTerm(normalized, KIMURA_LANGUAGE_SKILLS)) {
    return KIMURA_LANGUAGE_CATEGORY;
  }
  if (matchesAnySkillTerm(normalized, KIMURA_TOOL_PRACTICE_SKILLS)) {
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
    const rule = KIMURA_LANGUAGE_FRAMEWORK_SKILLS.find((candidateRule) =>
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

type KimuraSkillCategoryBuildOptions = {
  forceAllCategories?: boolean;
  relateFrameworksToLanguages?: boolean;
};

function buildKimuraSkillCategories(
  skills: string[],
  supplementalSkills: string[] = [],
  options: KimuraSkillCategoryBuildOptions = {}
): KimuraSkillCategoryGroup[] {
  const grouped = new Map<KimuraSkillCategory, string[]>(
    KIMURA_SKILL_CATEGORY_ORDER.map((category) => [category, []])
  );
  const used = new Set<string>();

  for (const skill of normalizeLibraryHardSkills(skills)) {
    const key = normalizeHardSkillAlias(skill);
    if (used.has(key)) continue;
    used.add(key);
    grouped.get(getKimuraSkillCategory(skill))?.push(skill);
  }

  const candidateByCategory = new Map<KimuraSkillCategory, string[]>(
    KIMURA_SKILL_CATEGORY_ORDER.map((category) => [category, []])
  );
  const candidateSeen = new Set<string>();

  const addKimuraFillCandidate = (skill: string) => {
    const record = getLibraryHardSkillRecord(skill);
    if (!record) return;
    const key = normalizeHardSkillAlias(record.skill);
    if (!key || used.has(key) || candidateSeen.has(key)) return;
    candidateSeen.add(key);
    candidateByCategory.get(record.category)?.push(record.skill);
  };

  for (const skill of sortHardSkillsByPriority(supplementalSkills)) {
    addKimuraFillCandidate(skill);
  }

  for (const category of KIMURA_SKILL_CATEGORY_ORDER) {
    for (const skill of KIMURA_CATEGORY_FALLBACK_SKILLS[category]) {
      if (getKimuraSkillCategory(skill) === category) {
        addKimuraFillCandidate(skill);
      }
    }
  }

  for (const skill of sortHardSkillsByPriority(readSkills('hard'))) {
    addKimuraFillCandidate(skill);
  }

  const includedCategories = new Set<KimuraSkillCategory>([KIMURA_LANGUAGE_CATEGORY]);
  for (const category of KIMURA_SKILL_CATEGORY_ORDER) {
    if (category !== KIMURA_LANGUAGE_CATEGORY && (grouped.get(category)?.length ?? 0) > 0) {
      includedCategories.add(category);
    }
  }

  if (includedCategories.size === 1 && options.forceAllCategories) {
    includedCategories.add('Frameworks and Libraries');
    includedCategories.add('Cloud and Infrastructure');
  }

  if (options.forceAllCategories) {
    for (const category of KIMURA_SKILL_CATEGORY_ORDER) {
      if (includedCategories.size >= KIMURA_MIN_CATEGORY_COUNT) break;
      if (category !== KIMURA_LANGUAGE_CATEGORY) {
        includedCategories.add(category);
      }
    }
  }

  for (const category of KIMURA_SKILL_CATEGORY_ORDER) {
    if (!includedCategories.has(category)) continue;
    const categorySkills = grouped.get(category) ?? [];
    if (category === KIMURA_LANGUAGE_CATEGORY) {
      for (const skill of candidateByCategory.get(category) ?? []) {
        const targetCount = options.forceAllCategories
          ? KIMURA_MIN_LANGUAGE_SKILLS
          : KIMURA_MAX_LANGUAGE_SKILLS;
        if (categorySkills.length >= targetCount) break;
        const key = normalizeHardSkillAlias(skill);
        if (KIMURA_LANGUAGE_FILL_EXCLUDED_SKILLS.has(key)) continue;
        if (used.has(key)) continue;
        used.add(key);
        categorySkills.push(skill);
      }

      if (!options.forceAllCategories) {
        categorySkills.splice(KIMURA_MAX_LANGUAGE_SKILLS);
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
      categorySkills.length >= KIMURA_MIN_SKILLS_PER_CATEGORY ||
      (!options.forceAllCategories && categorySkills.length === 0)
    ) {
      continue;
    }

    for (const skill of candidateByCategory.get(category) ?? []) {
      if (categorySkills.length >= KIMURA_MIN_SKILLS_PER_CATEGORY) break;
      const key = normalizeHardSkillAlias(skill);
      if (used.has(key)) continue;
      used.add(key);
      categorySkills.push(skill);
    }
  }

  return KIMURA_SKILL_CATEGORY_ORDER
    .filter((category) => includedCategories.has(category))
    .map((category) => ({
      category,
      skills: grouped.get(category) ?? [],
    }))
    .filter((group) => group.skills.length > 0);
}

function groupSelectedSkillsByKimuraCategory(skills: string[]): KimuraSkillCategoryGroup[] {
  const grouped = new Map<KimuraSkillCategory, string[]>(
    KIMURA_SKILL_CATEGORY_ORDER.map((category) => [category, []])
  );

  for (const skill of normalizeSkills(skills)) {
    if (!passesPromptHardSkillGate(skill)) continue;
    grouped.get(getKimuraSkillCategory(skill))?.push(skill);
  }

  return KIMURA_SKILL_CATEGORY_ORDER
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
): KimuraSkillCategoryGroup[] {
  const promptHardSkills = normalizeSkills(skills).filter(passesPromptHardSkillGate);
  const promptSupplementalSkills = normalizeSkills(supplementalSkills).filter(passesPromptHardSkillGate);
  const groups = buildKimuraSkillCategories(promptHardSkills, promptSupplementalSkills, {
    forceAllCategories: true,
    relateFrameworksToLanguages: true,
  });

  return groups.map((group) => ({
    ...group,
    skills: group.skills.slice(
      0,
      group.category === KIMURA_LANGUAGE_CATEGORY ? KIMURA_MAX_LANGUAGE_SKILLS : KIMURA_MAX_SKILLS_PER_CATEGORY
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


const MAX_SOFT_SKILL_LENGTH = 30;
const SOFT_SKILL_CONDENSE: Array<{ patterns: string[]; key: string }> = [
  { patterns: ['excellent communication', 'communication and collaboration', 'communication skills'], key: 'Communication' },
  { patterns: ['collaboration', 'collaborative'], key: 'Collaboration' },
  { patterns: ['cross-functional', 'cross functional'], key: 'Cross-functional' },
  { patterns: ['problem-solving', 'problem solving'], key: 'Problem-solving' },
  { patterns: ['ownership', 'high ownership'], key: 'Ownership' },
  { patterns: ['autonomy', 'self-directed', 'independent'], key: 'Autonomy' },
  { patterns: ['transparency', 'transparent'], key: 'Transparency' },
  { patterns: ['reliability', 'reliable'], key: 'Reliability' },
  { patterns: ['supportive', 'support'], key: 'Supportive' },
  { patterns: ['passionate', 'passion'], key: 'Passion' },
  { patterns: ['mentorship', 'mentor', 'help fellow'], key: 'Mentorship' },
  { patterns: ['adaptability', 'adapt'], key: 'Adaptability' },
  { patterns: ['eager to learn', 'lifelong learning'], key: 'Eager to learn' },
  { patterns: ['accountability', 'accountable'], key: 'Accountability' },
  { patterns: ['attention to detail', 'detail-oriented'], key: 'Attention to detail' },
  { patterns: ['team player', 'we are one team'], key: 'Team player' },
  { patterns: ['diverse', 'diversity'], key: 'Diversity' },
  { patterns: ['innovative', 'innovation', 'great ideas'], key: 'Innovation' },
];

function condenseSoftSkill(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length <= MAX_SOFT_SKILL_LENGTH) {
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  }
  const lower = trimmed.toLowerCase();
  for (const { patterns, key } of SOFT_SKILL_CONDENSE) {
    if (patterns.some((p) => lower.includes(p))) return key;
  }
  const firstWord = trimmed.split(/\s+/)[0];
  return firstWord ? firstWord.charAt(0).toUpperCase() + firstWord.slice(1) : trimmed;
}

function isTechnicalSkill(skill: string): boolean {
  const normalized = skill.trim().replace(/\s+/g, ' ');
  if (!normalized || normalized.length > 50 || /[.!?]/.test(normalized)) return false;

  const lower = normalized.toLowerCase();
  if (JOB_TITLE_EXCLUSIONS.has(lower)) return false;
  // Exclude soft skills (communication, collaboration, ownership, etc.)
  if (SOFT_SKILL_SIGNALS.some((signal) => lower.includes(signal))) return false;

  const allowedKey = normalizeHardSkillAlias(normalized);
  if (!ALLOWED_TECH_SKILLS.has(allowedKey)) return false;

  // If whitelisted, treat as technical
  return true;
}

function prioritizeSoftSkills(skills: string[]): string[] {
  const prioritized = skills.filter((skill) =>
    SOFT_SKILL_SIGNALS.some((signal) => skill.toLowerCase().includes(signal))
  );
  const remainder = skills.filter((skill) =>
    !SOFT_SKILL_SIGNALS.some((signal) => skill.toLowerCase().includes(signal))
  );
  return [...prioritized, ...remainder];
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
  kimuraSkillInventory?: string[];
  isDavidKimuraResume?: boolean;
  isLeoWuResume?: boolean;
};

type SkillsLimitedData<T> = T & {
  hardSkills: string[];
  softSkills: string[];
  skills: string[];
  kimuraSkillCategories: KimuraSkillCategoryGroup[];
};

function applySkillsLimit<T extends SkillsData>(data: T): SkillsLimitedData<T> {
  const hasTailoredHardSkills = Array.isArray(data.hardSkills) && data.hardSkills.length > 0;
  if (hasTailoredHardSkills) {
    const selectedHardSkills = normalizeSkills(data.hardSkills ?? []);
    const kimuraSkillCategories = enforcePromptSkillCategoryCounts(
      selectedHardSkills,
      data.kimuraSkillInventory
    );

    return {
      ...data,
      hardSkills: kimuraSkillCategories.map((group) => `${group.category}: ${group.skills.join(', ')}`),
      softSkills: [],
      skills: kimuraSkillCategories.map((group) => `${group.category}: ${group.skills.join(', ')}`),
      strengths: [],
      kimuraSkillCategories,
    } as SkillsLimitedData<T>;
  }

  const combinedHardRaw = data.hardSkills ?? data.skills ?? [];
  const hardLimited = sortHardSkillsByPriority(combinedHardRaw);
  const kimuraSkillRaw = data.hardSkills && data.hardSkills.length > 0
    ? data.hardSkills
    : data.skills ?? [];
  const kimuraBaseSkills = sortHardSkillsByPriority(kimuraSkillRaw);
  const kimuraSkillCategories = buildKimuraSkillCategories(kimuraBaseSkills, data.kimuraSkillInventory, {
    forceAllCategories: true,
    relateFrameworksToLanguages: true,
  });

  return {
    ...data,
    hardSkills: kimuraSkillCategories.map((group) => `${group.category}: ${group.skills.join(', ')}`),
    softSkills: [],
    skills: kimuraSkillCategories.map((group) => `${group.category}: ${group.skills.join(', ')}`),
    strengths: [],
    kimuraSkillCategories,
  } as SkillsLimitedData<T>;
}

function sanitizeFilename(str: string): string {
  return str
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
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

function isDavidKimuraProfile(profile: Profile): boolean {
  return profile.id === DAVID_KIMURA_PROFILE_ID || profile.name.trim().toLowerCase() === 'david kimura';
}

function isLeoWuProfile(profile: Profile): boolean {
  return profile.id === LEO_WU_PROFILE_ID || profile.name.trim().toLowerCase() === 'leo wu';
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
      '{{#each kimuraSkillCategories}}<div class="skill-category"><div class="skill-category-title">{{category}}</div><div class="skill-category-skills">{{join skills ", "}}</div></div>{{/each}}'
    )
    .replace(
      /\{\{#if hardSkills\.length\}\}\s*\{\{#each hardSkills\}\}<span>\{\{this\}\}\{\{#unless @last\}\} . \{\{\/unless\}\}<\/span>\{\{\/each\}\}\s*\{\{else\}\}\s*\{\{#each skills\}\}<span>\{\{this\}\}\{\{#unless @last\}\} . \{\{\/unless\}\}<\/span>\{\{\/each\}\}\s*\{\{\/if\}\}/g,
      '{{#each kimuraSkillCategories}}<div class="skill-category"><div class="skill-category-title">{{category}}</div><div class="skill-category-skills">{{join skills ", "}}</div></div>{{/each}}'
    )
    .replace(
      /\{\{#if hardSkills\.length\}\}\s*\{\{#each hardSkills\}\}\s*<span class="skill-chip">\{\{this\}\}<\/span>\s*\{\{\/each\}\}\s*\{\{else\}\}\s*\{\{#each skills\}\}\s*<span class="skill-chip">\{\{this\}\}<\/span>\s*\{\{\/each\}\}\s*\{\{\/if\}\}/g,
      '{{#each kimuraSkillCategories}}<div class="skill-category skill-chip"><div class="skill-category-title">{{category}}</div><div class="skill-category-skills">{{join skills ", "}}</div></div>{{/each}}'
    )
    .replace(
      /\{\{#if hardSkills\.length\}\}\s*\{\{#each hardSkills\}\}<span>\{\{this\}\}\{\{#unless @last\}\}[^{}]*\{\{\/unless\}\}<\/span>\{\{\/each\}\}\s*\{\{else\}\}\s*\{\{#each skills\}\}<span>\{\{this\}\}\{\{#unless @last\}\}[^{}]*\{\{\/unless\}\}<\/span>\{\{\/each\}\}\s*\{\{\/if\}\}/g,
      '{{#each kimuraSkillCategories}}<div class="skill-category"><div class="skill-category-title">{{category}}</div><div class="skill-category-skills">{{join skills ", "}}</div></div>{{/each}}'
    )
    .replace(
      /\{\{#each hardSkills\}\}\s*<li[^>]*>\{\{this\}\}<\/li>\s*\{\{\/each\}\}/g,
      '{{#each kimuraSkillCategories}}<li><strong>{{category}}</strong><br>{{join skills ", "}}</li>{{/each}}'
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
  const isDavidKimuraResume = isDavidKimuraProfile(profile);
  const isLeoWuResume = isLeoWuProfile(profile);
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
    isDavidKimuraResume,
    isLeoWuResume,
    kimuraSkillInventory: normalizeSkills([
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
  const html = timePdfStageSync('template render', () => {
    const compiledTemplate = compileTemplate(template);
    return enforceSkillCategoryLineBreaks(rewriteLinkedInAnchorDisplay(compiledTemplate(renderData)));
  });

  // Add CSS if separate
  const fullHtml = timePdfStageSync('HTML assembly', () =>
    template.cssContent
      ? `<style>${template.cssContent}</style>${html}`
      : html
  );

  // Generate PDF with Puppeteer
  const browser = await timePdfStage('browser ready', () => getSharedPdfBrowser());
  let page: Awaited<ReturnType<Browser['newPage']>> | null = null;

  try {
    const activePage = await timePdfStage('new page', () => browser.newPage());
    page = activePage;
    await timePdfStage('page setup', async () => {
      await activePage.setViewport({
        width: A4_PRINTABLE_WIDTH_PX,
        height: A4_PRINTABLE_HEIGHT_PX,
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
        format: 'A4',
        margin: {
          top: '0.4in',
          right: '0.5in',
          bottom: '0.3in',
          left: '0.5in'
        },
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
const SAMPLE_PROFILE: Profile = {
  id: 'preview',
  name: 'Jane Smith',
  title: 'Senior Software Engineer',
  totalYearsExperience: 5,
  contact: {
    phone: '+1 (555) 123-4567',
    email: 'jane.smith@email.com',
    linkedin: 'linkedin.com/in/janesmith',
    location: 'San Francisco, CA',
  },
  summary: 'Experienced software engineer with 5+ years building scalable web applications. Strong focus on clean code and team collaboration.',
  experience: [
    {
      title: 'Senior Software Engineer',
      company: 'Tech Corp',
      startDate: '01/2021',
      endDate: 'Present',
      location: 'San Francisco, CA',
      description: 'Lead development of customer-facing platforms.',
      achievements: ['Reduced load time by 40%', 'Mentored 3 junior engineers'],
      skills: [],
    },
    {
      title: 'Software Engineer',
      company: 'Startup Inc',
      startDate: '06/2019',
      endDate: '12/2020',
      location: 'Remote',
      description: 'Full-stack development for SaaS product.',
      achievements: ['Built REST APIs', 'Implemented CI/CD pipeline'],
      skills: [],
    },
  ],
  strengths: [
    { title: 'Problem Solving', description: 'Analytical approach to complex challenges.' },
    { title: 'Communication', description: 'Clear technical documentation and presentations.' },
  ],
  skills: ['JavaScript', 'TypeScript', 'React', 'Node.js', 'Python'],
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
};

export function generateTemplatePreviewHTML(template: Template): string {
  const renderData = prepareResumeRenderData(SAMPLE_PROFILE);
  const compiledTemplate = compileTemplate(template);
  const html = enforceSkillCategoryLineBreaks(rewriteLinkedInAnchorDisplay(compiledTemplate(renderData)));
  const fullHtml = template.cssContent
    ? `<style>${template.cssContent}</style>${html}`
    : html;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:8px;background:#f3f4f6;">${fullHtml}</body></html>`;
}

export async function getGeneratedPDFPath(filename: string): Promise<string | null> {
  return getGeneratedFilePath(filename);
}
