import type { Browser } from 'puppeteer';
import { browserProfileDir, launchBrowser } from '../config/browser';
import { pdfRenderTimeoutMs } from '../config/operational';
import Handlebars from 'handlebars';
import fs from 'fs/promises';
import path from 'path';
import {
  Profile,
  type SkillCategoryGroup as ProfileSkillCategoryGroup,
  type TechnicalSkillsLayout,
} from '../types/profile';
import {
  getProfileResumeSections,
  profileForTemplate,
  type ResumeSectionChoices,
} from '../services/profileService';
import { SAMPLE_PROFILE } from '../services/sampleProfile';
import { TailoredContent, Template } from '../types/template';
import type { GeneratedPathInfo } from '../utils/generatedPath';
import { getResumeOutputFilename } from '../utils/generatedPath';
import {
  HARD_SKILL_CATEGORIES,
  HardSkillCategory,
  type HardSkillRecord,
  hardSkillIndexKey,
  readHardSkillIndex,
  readHardSkillPriorityMap,
  readSkills,
} from '../database/skillsDatabase';
const MAX_ROLE_BRIEF_LENGTH = 1200;
/** CSS absolute length units expressed in px at 96 DPI. */
const CSS_LENGTH_PX: Record<string, number> = {
  px: 1,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
  pt: 96 / 72,
  pc: 16,
};

/** Named `@page size` keywords, in px at 96 DPI. */
const PAGE_SIZE_PX: Record<string, { width: number; height: number }> = {
  a3: { width: 1123, height: 1587 },
  a4: { width: 794, height: 1123 },
  a5: { width: 559, height: 794 },
  letter: { width: 816, height: 1056 },
  legal: { width: 816, height: 1344 },
  tabloid: { width: 1056, height: 1632 },
  ledger: { width: 1632, height: 1056 },
};

const A4_PAGE_WIDTH_PX = PAGE_SIZE_PX.a4.width;
const A4_PAGE_HEIGHT_PX = PAGE_SIZE_PX.a4.height;

/**
 * The page box used when a template does not say otherwise.
 *
 * `format` and `margin` are what `page.pdf()` is called with. Note that the
 * margin here is a FALLBACK, not a guarantee: Chrome honours a template's own
 * `@page { margin }` and ignores the value passed to `page.pdf()`. That is
 * measurable - print the same markup with and without an `@page` rule and the
 * ink starts 34px in rather than 48px in - and every built-in template declares
 * one, so this margin only ever applies to a template that has no `@page` rule
 * at all. Use `resolveTemplatePageBox` to learn the box a given template will
 * actually be printed into; the preview is built from that, which is the whole
 * reason a preview resembles the PDF it is previewing.
 */
export const RESUME_PAGE_GEOMETRY = {
  format: 'A4',
  margin: { top: '0.4in', right: '0.5in', bottom: '0.3in', left: '0.5in' },
  pageWidthPx: A4_PAGE_WIDTH_PX,
  pageHeightPx: A4_PAGE_HEIGHT_PX,
  contentWidthPx: A4_PAGE_WIDTH_PX - 96, // 0.5in either side
  contentHeightPx: A4_PAGE_HEIGHT_PX - 38.4 - 28.8, // 0.4in top, 0.3in bottom
} as const;

export interface ResumePageBox {
  /** The page Chrome lays the document out on, per its `@page size`. */
  pageWidthPx: number;
  pageHeightPx: number;
  /** Page margins, as CSS lengths, per its `@page margin`. */
  margin: { top: string; right: string; bottom: string; left: string };
  /** The area content is laid out into: page minus margins. */
  contentWidthPx: number;
  contentHeightPx: number;
  /**
   * `page.pdf()` is always asked for A4, so a document that declares a
   * different `@page size` is laid out at that size and then scaled to fit the
   * A4 media box, centred. 1 and 0 when the sizes already agree.
   */
  mediaScale: number;
  mediaOffsetYPx: number;
  /** True when the CSS uses viewport units, whose basis differs off-page. */
  usesViewportUnits: boolean;
}

function parseCssLengthPx(value: string): number | null {
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+))([a-z]*)$/i.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const factor = CSS_LENGTH_PX[(match[2] || 'px').toLowerCase()];
  return factor === undefined ? null : amount * factor;
}

/**
 * The declarations of every `@page` rule in `css`, concatenated in source
 * order so that later rules win, with nested at-rules (`@top-center` and
 * friends) dropped.
 */
function collectAtPageDeclarations(css: string): string[] {
  const declarations: string[] = [];
  const ruleStart = /@page\b[^{]*\{/gi;
  let match: RegExpExecArray | null;

  while ((match = ruleStart.exec(css)) !== null) {
    let cursor = ruleStart.lastIndex;
    let depth = 1;
    while (cursor < css.length && depth > 0) {
      if (css[cursor] === '{') depth += 1;
      else if (css[cursor] === '}') depth -= 1;
      cursor += 1;
    }
    const body = css.slice(ruleStart.lastIndex, Math.max(cursor - 1, ruleStart.lastIndex));
    declarations.push(body.replace(/[^;{}]*\{[^{}]*\}/g, ''));
    ruleStart.lastIndex = cursor;
  }

  return declarations
    .join(';')
    .split(';')
    .map((declaration) => declaration.trim())
    .filter(Boolean);
}

function expandMarginShorthand(value: string): string[] | null {
  const parts = value.split(/\s+/).filter(Boolean);
  if (parts.length < 1 || parts.length > 4) return null;
  const [top, right = top, bottom = top, left = right] = parts;
  return [top, right, bottom, left];
}

function applyPageSize(
  value: string,
  fallback: { width: number; height: number }
): { width: number; height: number } {
  const tokens = value.toLowerCase().split(/\s+/).filter(Boolean);
  let size = fallback;
  let orientation: 'portrait' | 'landscape' | null = null;
  const lengths: number[] = [];

  for (const token of tokens) {
    if (token === 'auto') continue;
    if (token === 'portrait' || token === 'landscape') {
      orientation = token;
      continue;
    }
    if (PAGE_SIZE_PX[token]) {
      size = PAGE_SIZE_PX[token];
      continue;
    }
    const length = parseCssLengthPx(token);
    if (length !== null && length > 0) lengths.push(length);
  }

  if (lengths.length === 1) size = { width: lengths[0], height: lengths[0] };
  else if (lengths.length >= 2) size = { width: lengths[0], height: lengths[1] };

  if (orientation === 'landscape' && size.height > size.width) {
    size = { width: size.height, height: size.width };
  } else if (orientation === 'portrait' && size.width > size.height) {
    size = { width: size.height, height: size.width };
  }

  return size;
}

/**
 * The page box `page.pdf()` will actually print `template` into.
 *
 * Read from the template's own `@page` rule, because that is what Chrome
 * obeys - the margin handed to `page.pdf()` applies only in its absence.
 */
export function resolveTemplatePageBox(template: Template): ResumePageBox {
  const css = `${template.cssContent ?? ''}\n${template.htmlContent ?? ''}`;
  const fallback = RESUME_PAGE_GEOMETRY.margin;
  const margin: ResumePageBox['margin'] = { ...fallback };
  let size = { width: RESUME_PAGE_GEOMETRY.pageWidthPx, height: RESUME_PAGE_GEOMETRY.pageHeightPx };

  for (const declaration of collectAtPageDeclarations(css)) {
    const separator = declaration.indexOf(':');
    if (separator === -1) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim();
    if (!value) continue;

    if (property === 'size') {
      size = applyPageSize(value, size);
    } else if (property === 'margin') {
      const sides = expandMarginShorthand(value);
      if (sides) [margin.top, margin.right, margin.bottom, margin.left] = sides;
    } else if (property === 'margin-top') margin.top = value;
    else if (property === 'margin-right') margin.right = value;
    else if (property === 'margin-bottom') margin.bottom = value;
    else if (property === 'margin-left') margin.left = value;
  }

  const px = (value: string, fallbackValue: string) =>
    parseCssLengthPx(value) ?? parseCssLengthPx(fallbackValue) ?? 0;
  const marginPx = {
    top: px(margin.top, fallback.top),
    right: px(margin.right, fallback.right),
    bottom: px(margin.bottom, fallback.bottom),
    left: px(margin.left, fallback.left),
  };

  const mediaScale = Math.min(
    1,
    A4_PAGE_WIDTH_PX / size.width,
    A4_PAGE_HEIGHT_PX / size.height
  );

  return {
    pageWidthPx: size.width,
    pageHeightPx: size.height,
    margin,
    contentWidthPx: Math.max(1, size.width - marginPx.left - marginPx.right),
    contentHeightPx: Math.max(1, size.height - marginPx.top - marginPx.bottom),
    mediaScale,
    mediaOffsetYPx: (A4_PAGE_HEIGHT_PX - size.height * mediaScale) / 2,
    usesViewportUnits: /\b\d*\.?\d+(vh|vw|vmin|vmax)\b/i.test(css),
  };
}
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

/**
 * One rendered heading and the skills under it.
 *
 * `category` is a plain string, not the library's closed set: a profile may
 * carry headings its author invented, and the flat layout carries the empty
 * string - which is not a missing heading but the statement that there is none.
 */
type SkillCategoryGroup = {
  category: string;
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
const PDF_BROWSER_USER_DATA_DIR = browserProfileDir('pdf-chrome');

async function getSharedPdfBrowser(): Promise<Browser> {
  if (sharedPdfBrowser?.connected) {
    return sharedPdfBrowser;
  }
  if (sharedPdfBrowserLaunch) {
    return sharedPdfBrowserLaunch;
  }

  sharedPdfBrowserLaunch = launchBrowser({
    userDataDir: PDF_BROWSER_USER_DATA_DIR,
    args: ['--disable-features=FirstPartySets'],
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

  const libraryRecord = getLibraryHardSkillRecord(skill);
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

/**
 * The library's record for a skill, through the index `skillsDatabase` keeps
 * per change of the library rather than a fresh copy and a scan per lookup.
 * Read-only: the record is the library's own.
 */
function getLibraryHardSkillRecord(skill: string): Readonly<HardSkillRecord> | undefined {
  const normalized = hardSkillIndexKey(skill);
  if (!normalized) return undefined;
  return readHardSkillIndex().get(normalized);
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
  strengths?: Array<{ title?: unknown; description?: unknown }>;
  skills?: string[];
  skillInventory?: string[];
  /** The author's own grouping, when the profile carries one. */
  skillCategories?: ProfileSkillCategoryGroup[];
  profileSettings?: Profile['profileSettings'];
};

/** How a resume's render data is prepared, beyond what the profile itself says. */
export interface ResumeRenderOptions {
  /**
   * Fill an INFERRED categorized block from the skill library - five headings
   * of five - as generation always has. Off for the live profile preview, which
   * shows the person the skills they entered and nothing they did not: a
   * preview listing Kubernetes under a heading they never wrote, on a profile
   * that never claimed it, reads as a bug in the editor. Flat and an authored
   * grouping never pad, so this changes only the categorized, uncategorized,
   * untailored case.
   */
  padSkillCategories?: boolean;
}

/** A strength a template can show: one with a title or a description, as text. */
type RenderStrength = { title: string; description: string };

function renderableStrengths(strengths: SkillsData['strengths']): RenderStrength[] {
  if (!Array.isArray(strengths)) return [];
  return strengths
    .filter((item): item is { title?: unknown; description?: unknown } => Boolean(item) && typeof item === 'object')
    .map((item) => ({
      title: typeof item.title === 'string' ? item.title.trim() : '',
      description: typeof item.description === 'string' ? item.description.trim() : '',
    }))
    .filter((item) => item.title || item.description);
}

/**
 * The flat layout, as one group with no heading.
 *
 * One group rather than none, so every renderer keeps the single loop it
 * already has. A template written against `skillCategories` renders the flat
 * layout correctly without knowing the option exists, provided it guards its
 * heading with `{{#if category}}` - which `normalizeTemplateSkillsSections`
 * arranges for every template, uploaded ones included.
 */
function flattenSkillCategories(skills: string[]): SkillCategoryGroup[] {
  return skills.length > 0 ? [{ category: '', skills }] : [];
}

/**
 * Groups the SELECTED skills using the author's own categories.
 *
 * The author's grouping covers their whole profile; what reaches here is the
 * subset this job called for. So the profile is read as a MAP from skill to
 * heading rather than as the finished block - grouping the whole profile would
 * put back every skill the tailoring step deliberately left out.
 *
 * A selected skill the author never placed still has to appear, so it falls
 * back to the library's inference for its heading. That heading joins the
 * author's order at the end if it is new, and merges into theirs if they
 * already have one by that name.
 */
function buildAuthoredSkillCategories(
  selected: string[],
  authored: ProfileSkillCategoryGroup[]
): SkillCategoryGroup[] {
  const headingBySkill = new Map<string, string>();
  for (const group of authored) {
    const category = group.category?.trim();
    if (!category) continue;
    for (const skill of group.skills ?? []) {
      const key = normalizeHardSkillAlias(skill);
      if (key && !headingBySkill.has(key)) headingBySkill.set(key, category);
    }
  }

  const order: string[] = [];
  const grouped = new Map<string, string[]>();
  const place = (heading: string, skill: string) => {
    const key = heading.toLowerCase();
    if (!grouped.has(key)) {
      grouped.set(key, []);
      order.push(heading);
    }
    grouped.get(key)!.push(skill);
  };

  // The author's headings lead, in their order, whether or not this job's
  // selection reached them - an empty one is dropped below.
  for (const group of authored) {
    const category = group.category?.trim();
    if (category && !grouped.has(category.toLowerCase())) {
      grouped.set(category.toLowerCase(), []);
      order.push(category);
    }
  }

  const seen = new Set<string>();
  for (const skill of selected) {
    const key = normalizeHardSkillAlias(skill);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    place(headingBySkill.get(key) ?? getSkillCategory(skill), skill);
  }

  return order
    .map((category) => ({ category, skills: grouped.get(category.toLowerCase()) ?? [] }))
    .filter((group) => group.skills.length > 0);
}

/**
 * The Technical Skills block's lines, for templates that render a flat list.
 *
 * Categorized, each line is "Heading: a, b, c" - which is how every template
 * that predates `skillCategories` has always shown them. Flat, each line is one
 * skill, so a template rendering a chip per entry produces a chip per skill
 * rather than one enormous chip holding the whole list behind a stray colon.
 */
function renderSkillLines(groups: SkillCategoryGroup[]): string[] {
  if (groups.length === 1 && !groups[0].category) return [...groups[0].skills];
  return groups.map((group) => `${group.category}: ${group.skills.join(', ')}`);
}

type SkillsLimitedData<T> = Omit<T, 'strengths' | 'softSkills'> & {
  hardSkills: string[];
  softSkills: string[];
  skills: string[];
  strengths: RenderStrength[];
  skillCategories: SkillCategoryGroup[];
};

/**
 * The skills a person entered, each under the library's heading for it, and
 * nothing more - the categorized block without the padding. For the live
 * preview; see `ResumeRenderOptions.padSkillCategories`.
 *
 * Library-known skills only, as the flat layout keeps: the two layouts of one
 * profile must show the same skills, and the editor adds an unknown skill to
 * the library as it is entered.
 */
function groupClaimedSkills(skills: string[]): SkillCategoryGroup[] {
  const grouped = new Map<SkillCategory, string[]>(
    SKILL_CATEGORY_ORDER.map((category) => [category, []])
  );
  for (const skill of normalizeLibraryHardSkills(skills)) {
    grouped.get(getSkillCategory(skill))?.push(skill);
  }
  return SKILL_CATEGORY_ORDER
    .map((category) => ({ category, skills: grouped.get(category) ?? [] }))
    .filter((group) => group.skills.length > 0);
}

function applySkillsLimit<T extends SkillsData>(data: T, options: ResumeRenderOptions = {}): SkillsLimitedData<T> {
  const sections = getProfileResumeSections({ profileSettings: data.profileSettings });
  const layout: TechnicalSkillsLayout = sections.layout;
  const authored = (data.skillCategories ?? []).filter(
    (group) => group?.category?.trim() && Array.isArray(group.skills) && group.skills.length > 0
  );

  const finish = (skillCategories: SkillCategoryGroup[]): SkillsLimitedData<T> => {
    const lines = renderSkillLines(skillCategories);
    return {
      ...data,
      hardSkills: lines,
      // THE RENDER GATE for the two optional sections. Whatever the caller
      // handed in - a profile's own lists, freshly tailored content, or content
      // a client held from an earlier preview and sent back with a batch,
      // never re-parsed - a section the profile has switched off renders
      // nothing, and one switched on renders what it was given. Decided here,
      // on every render, because this is the one step every path (preview,
      // PDF, DOCX, the queue) goes through.
      softSkills: sections.softSkills ? normalizeSkills(data.softSkills ?? []) : [],
      // The same lines under both names, because templates disagree about
      // which one they read and neither is more correct than the other.
      skills: lines,
      strengths: sections.strengths ? renderableStrengths(data.strengths) : [],
      skillCategories,
    } as SkillsLimitedData<T>;
  };

  const hasTailoredHardSkills = Array.isArray(data.hardSkills) && data.hardSkills.length > 0;
  const selected = hasTailoredHardSkills
    ? normalizeSkills(data.hardSkills ?? [])
    : sortHardSkillsByPriority(data.skills ?? []);

  // Flat is decided before any of the category machinery runs, and that is the
  // point of it: the padding rules below exist to make a CATEGORIZED block look
  // right - five per heading, at least five headings - and a list with no
  // headings has no such shape to fill. Running them anyway would pad the list
  // with skills the profile never claimed, to satisfy a layout it is not using.
  if (layout === 'flat') {
    return finish(
      flattenSkillCategories(
        hasTailoredHardSkills
          ? selected.filter(passesPromptHardSkillGate)
          : normalizeLibraryHardSkills(selected)
      )
    );
  }

  // The author's grouping replaces the inference, not the selection. It has no
  // counts to enforce either: the headings are theirs, and padding them to five
  // apiece would put skills under headings they did not choose for them.
  if (authored.length > 0) {
    return finish(
      buildAuthoredSkillCategories(
        hasTailoredHardSkills ? selected.filter(passesPromptHardSkillGate) : selected,
        authored
      )
    );
  }

  if (hasTailoredHardSkills) {
    return finish(enforcePromptSkillCategoryCounts(selected, data.skillInventory));
  }

  if (options.padSkillCategories === false) {
    return finish(groupClaimedSkills(selected));
  }

  return finish(
    buildSkillCategories(selected, data.skillInventory, {
      forceAllCategories: true,
      relateFrameworksToLanguages: true,
    })
  );
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

/**
 * A link a person typed, as an http(s) URL - or nothing.
 *
 * http and https only. These land in an `href`, and the live profile preview
 * renders whatever is in the editor as it is typed: `javascript:` or `data:`
 * there is a link that runs something. Handlebars escapes quotes, not
 * schemes, so the scheme is the one thing the renderer has to police itself.
 *
 * A bare host ("linkedin.com/in/x") gets https, as it always has. Anything
 * else that names a scheme is dropped. "Names a scheme" means a run of scheme
 * characters with no dot before the first colon, so "www.example.com:8080/x"
 * is still read as a host with a port. What comes out must also parse as a
 * URL, so "https://javascript:alert(1)" - a scheme hidden behind the prefix -
 * does not survive either.
 *
 * A control character anywhere refuses the whole value. A browser deletes
 * tab, LF and CR from anywhere in an href before it parses it, so
 * "java<TAB>script:" is checked here as a host with no scheme yet followed as
 * `javascript:` there - and GitHub and portfolio keep the text as typed. The
 * text checked has to be the text the browser will use.
 */
function normalizeExternalUrl(value: string | undefined): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  // eslint-disable-next-line no-control-regex
  if (!trimmed || /[\u0000-\u001F\u007F]/.test(trimmed)) return '';

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  let candidate: string;
  if (/^https?:\/\//i.test(trimmed)) {
    candidate = trimmed;
  } else if (scheme && !scheme[1].includes('.')) {
    return '';
  } else {
    candidate = `https://${trimmed.replace(/^\/+/, '')}`;
  }

  try {
    const { protocol } = new URL(candidate);
    return protocol === 'http:' || protocol === 'https:' ? candidate : '';
  } catch {
    return '';
  }
}

/**
 * A contact link kept as the person wrote it when it is safe to put in an
 * `href`, and dropped when it is not. No built-in template links GitHub or a
 * portfolio, but an uploaded one may, and its text is shown as typed.
 */
function safeContactLink(value: string | undefined): string {
  return normalizeExternalUrl(value) ? (value ?? '').trim() : '';
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

/**
 * Turns a "Heading: a, b, c" skills line into a heading block over its skills,
 * for templates that print the categorized lines through a loop the compile
 * step did not rewrite.
 *
 * Only the Technical Skills lines themselves - the escaped `hardSkills` /
 * `skills` entries this render was given - are touched. It used to rewrite
 * any element of the whole page whose text merely began with a heading name,
 * which was harmless while those lines were the only such text a resume could
 * hold; a strength described as "Languages: English and Spanish" or a soft
 * skill "Tools: Jira" lost its own markup and styling for a skills heading.
 * A class cannot tell the sections apart (default.json draws hard and soft
 * skills in the same `skill-box`), the text can.
 */
function enforceSkillCategoryLineBreaks(
  html: string,
  renderData: { hardSkills?: unknown; skills?: unknown }
): string {
  const skillLines = new Set(
    [renderData.hardSkills, renderData.skills]
      .flatMap((list) => (Array.isArray(list) ? list : []))
      .filter((line): line is string => typeof line === 'string')
      .map((line) => Handlebars.escapeExpression(line).trim())
  );
  if (skillLines.size === 0) return html;
  const categoryPattern = '(Programming &(?:amp;)? Scripting Languages|Languages|Frameworks (?:and|&(?:amp;)?) Libraries|Software Architecture &(?:amp;)? Design|Security|Cloud (?:and|&(?:amp;)?) Infrastructure|Infrastructure &(?:amp;)? Cloud|Databases (?:and|&(?:amp;)?) Storage|DevOps (?:and|&(?:amp;)?) CI/CD|Observability (?:and|&(?:amp;)?) Monitoring|Testing (?:and|&(?:amp;)?) Quality|APIs (?:and|&(?:amp;)?) Integration|Engineering Practices &(?:amp;)? Methodology|Data Engineering &(?:amp;)? Streaming|AI/ML &(?:amp;)? Data Science|Version Control &(?:amp;)? Collaboration|Operating Systems &(?:amp;)? Platforms|Frontend &(?:amp;)? UI/UX Development|Mobile Development|Cloud &(?:amp;)? DevOps|Databases|Tools &(?:amp;)? Practices|Tools|Methods)';
  const categoryTextPattern = new RegExp(
    `<(span|div)\\b([^>]*)>\\s*${categoryPattern}:\\s*([^<]*?)\\s*(?:[•·]|â€¢)?\\s*<\\/\\1>`,
    'gi'
  );

  return html.replace(categoryTextPattern, (match, _tagName, attributes, category, skills) => {
    const normalizedSkills = String(skills ?? '').trim();
    if (!skillLines.has(`${category}: ${normalizedSkills}`)) return match;
    const rawAttributes = String(attributes ?? '');
    const hasSkillChip = rawAttributes.includes('skill-chip');
    const cleanedAttributes = rawAttributes.replace(/\sclass=(["']).*?\1/i, '');
    const className = hasSkillChip ? 'skill-category skill-chip' : 'skill-category';
    return `<div${cleanedAttributes} class="${className}"><div class="skill-category-title">${category}</div><div class="skill-category-skills">${normalizedSkills}</div></div>`;
  });
}

/**
 * The optional sections, the data each one renders, and how a template marks
 * one: the class the built-ins and the manual builder put on it, the
 * `data-section` value the builder also writes, and - for markup that has
 * neither, like an uploaded template - the words its heading reads.
 */
const OPTIONAL_SECTIONS = [
  {
    className: 'section-soft-skills',
    field: 'softSkills',
    choice: 'softSkills',
    dataSections: ['softSkills', 'soft-skills'],
    heading: /soft[\s-]*skill/i,
  },
  {
    className: 'section-strengths',
    field: 'strengths',
    choice: 'strengths',
    dataSections: ['strengths'],
    heading: /strength/i,
  },
] as const;

type OptionalSection = (typeof OPTIONAL_SECTIONS)[number];

/** A stretch of a template's markup: [start, end). */
type MarkupSpan = { start: number; end: number };

/**
 * How a compile finds the optional sections: 'all' of `findOptionalSections`;
 * 'marked', only the class and `data-section` (no section found from its
 * loop); 'none', no section removed or guarded at all. Anything but 'all' is
 * `compilableMarkup`'s fallback for a template the finds would stop compiling.
 */
type SectionFinds = 'all' | 'marked' | 'none';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Where the element opened at `from` closes, counting nested elements of the same name; -1 if never. */
function findClosingTag(html: string, tagName: string, from: number): number {
  const tags = new RegExp(`<(/?)${escapeRegExp(tagName)}(?![\\w-])[^>]*>`, 'gi');
  tags.lastIndex = from;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = tags.exec(html)) !== null) {
    if (match[1]) {
      depth -= 1;
      if (depth === 0) return tags.lastIndex;
    } else if (!match[0].endsWith('/>')) {
      depth += 1;
    }
  }
  return -1;
}

/**
 * The next element at or after `from` whose opening tag matches `opener` (a
 * global pattern capturing the tag name first), from its opening tag to the end
 * of its closing one.
 */
function nextElementOpenedBy(html: string, opener: RegExp, from: number): MarkupSpan | null {
  opener.lastIndex = from;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(html)) !== null) {
    const end = findClosingTag(html, match[1], opener.lastIndex);
    if (end !== -1) return { start: match.index, end };
  }
  return null;
}

/**
 * The next element at or after `from` whose class list holds `className` as a
 * whole token, from its opening tag to the end of its closing one.
 *
 * Anchored on the tag that CARRIES the class. The version this replaced found
 * the class name anywhere and then took the nearest `<div` before it - which
 * for `<div class="main">...<section class="section-strengths">` was the main
 * column, so stripping Strengths took Experience with it. A class named in a
 * stylesheet is not an opening tag, so a `<style>` is never mistaken for one.
 */
function nextClassedElement(html: string, className: string, from: number): MarkupSpan | null {
  return nextElementOpenedBy(
    html,
    new RegExp(
      `<([a-zA-Z][\\w-]*)\\b[^>]*?(?<![\\w-])class\\s*=\\s*(["'])(?:(?!\\2)[\\s\\S])*?` +
        `(?<![\\w-])${escapeRegExp(className)}(?![\\w-])(?:(?!\\2)[\\s\\S])*?\\2[^>]*>`,
      'g'
    ),
    from
  );
}

/** The next element at or after `from` carrying `data-section="<one of names>"`. */
function nextDataSectionElement(html: string, names: readonly string[], from: number): MarkupSpan | null {
  return nextElementOpenedBy(
    html,
    new RegExp(
      `<([a-zA-Z][\\w-]*)\\b[^>]*?(?<![\\w-])data-section\\s*=\\s*(["'])\\s*` +
        `(?:${names.map(escapeRegExp).join('|')})\\s*\\2[^>]*>`,
      'g'
    ),
    from
  );
}

/** `{{#if field.length}}` or `{{#if field}}` - an empty list is falsy either way. */
function guardOpenerPattern(field: string): string {
  return `\\{\\{#if\\s+${escapeRegExp(field)}(?:\\.length)?\\s*\\}\\}`;
}

/**
 * The `{{#if field.length}} ... {{/if}}` immediately around [start, end), when
 * there is one - both halves, or neither. Taking only the opening half would
 * leave its `{{/if}}` behind and the template would no longer compile.
 */
function sectionGuardAround(html: string, start: number, end: number, field: string): MarkupSpan | null {
  const before = new RegExp(`${guardOpenerPattern(field)}\\s*$`).exec(html.slice(0, start));
  const after = /^\s*\{\{\/if\s*\}\}/.exec(html.slice(end));
  return before && after ? { start: start - before[0].length, end: end + after[0].length } : null;
}

/** Whether `pos` falls inside a tag (`<div title="{{join softSkills}}">`) rather than between tags. */
function insideTag(html: string, pos: number): boolean {
  return html.lastIndexOf('<', pos) > html.lastIndexOf('>', pos - 1);
}

/**
 * Where the markup prints the field's list: every `{{#each field}} ...
 * {{/each}}` with its own closing tag (nested loops counted), and every
 * mustache that prints the whole list inline - `{{join softSkills ", "}}`, the
 * app's own helper, or a bare `{{softSkills}}` - outside those loops and
 * outside a tag. `inferTemplateCapabilities` offers the switch for both, so
 * both have to be findable: a `join` section used to keep its heading because
 * only loops were looked for.
 */
function sectionLoops(html: string, field: string): MarkupSpan[] {
  const loops: MarkupSpan[] = [];
  const opener = new RegExp(`\\{\\{#each\\s+${escapeRegExp(field)}(?![\\w.])[^}]*\\}\\}`, 'g');
  let match: RegExpExecArray | null;
  while ((match = opener.exec(html)) !== null) {
    const blocks = /\{\{(#each\b|\/each\s*\}\})/g;
    blocks.lastIndex = opener.lastIndex;
    let depth = 1;
    let token: RegExpExecArray | null;
    while ((token = blocks.exec(html)) !== null) {
      depth += token[1].startsWith('#') ? 1 : -1;
      if (depth === 0) break;
    }
    if (depth !== 0 || !token) continue;
    loops.push({ start: match.index, end: blocks.lastIndex });
    opener.lastIndex = blocks.lastIndex;
  }

  const inline = new RegExp(
    `\\{\\{\\{?~?\\s*(?:[a-zA-Z_][\\w-]*\\s+)?${escapeRegExp(field)}(?![\\w.-])[^{}]*\\}\\}\\}?`,
    'g'
  );
  const inLoop = (pos: number) => loops.some((loop) => pos >= loop.start && pos < loop.end);
  const printed: MarkupSpan[] = [];
  while ((match = inline.exec(html)) !== null) {
    if (inLoop(match.index) || insideTag(html, match.index)) continue;
    printed.push({ start: match.index, end: inline.lastIndex });
  }
  return [...loops, ...printed].sort((a, b) => a.start - b.start);
}

/** Elements that never close: an opening tag of one of these is no ancestor. */
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr',
]);

/** The elements open at `pos`, outermost first, each as its own span. */
function ancestorsAt(html: string, pos: number): MarkupSpan[] {
  const open: Array<{ name: string; start: number; openEnd: number }> = [];
  const tags = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)\b[^>]*>/g;
  let match: RegExpExecArray | null;
  while ((match = tags.exec(html)) !== null && match.index < pos) {
    if (!match[2]) continue;
    const name = match[2].toLowerCase();
    if (match[1]) {
      const at = open.map((tag) => tag.name).lastIndexOf(name);
      if (at !== -1) open.length = at;
      continue;
    }
    if (VOID_ELEMENTS.has(name) || match[0].endsWith('/>')) continue;
    if (name === 'style' || name === 'script') {
      const close = findClosingTag(html, name, tags.lastIndex);
      if (close === -1 || close > pos) return [];
      tags.lastIndex = close;
      continue;
    }
    open.push({ name, start: match.index, openEnd: tags.lastIndex });
  }
  const spans: MarkupSpan[] = [];
  for (const tag of open) {
    const end = findClosingTag(html, tag.name, tag.openEnd);
    if (end === -1) return spans;
    spans.push({ start: tag.start, end });
  }
  return spans;
}

/** What a reader sees of a fragment: no tags, no stylesheet, entities for spaces read as spaces. */
function visibleText(fragment: string): string {
  return fragment
    .replace(/<(style|script)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A fragment with the section's own loop and guard taken out - what is left
 * is everything ELSE an element around the loop holds. Null when what is left
 * still holds template data (another loop, `{{summary}}`, an `{{#if}}` of
 * something else): an element like that is somebody's column, not this
 * section, and removing it would take that data with it.
 *
 * Also null when the section's guards in the fragment do not pair up INSIDE
 * it - `<div>{{#if strengths.length}}<h3>..</h3>{{#each}}..</div>{{/if}}`,
 * valid Handlebars around mis-nested HTML. Counting openers and deleting as
 * many `{{/if}}` once took the div with its opener and left the `{{/if}}`
 * outside it dangling, and the template stopped compiling for every profile
 * with the switch off.
 */
function besidesTheLoop(fragment: string, loop: MarkupSpan, offset: number, field: string): string | null {
  const rest = `${fragment.slice(0, loop.start - offset)}${fragment.slice(loop.end - offset)}`;
  const guards = new RegExp(`${guardOpenerPattern(field)}|\\{\\{\\/if\\s*\\}\\}`, 'g');
  let depth = 0;
  for (const token of rest.match(guards) ?? []) {
    if (token.startsWith('{{#')) depth += 1;
    else if (depth === 0) return null;
    else depth -= 1;
  }
  if (depth !== 0) return null;
  const left = rest.replace(guards, '');
  return /\{\{/.test(left) ? null : left;
}

/** The longest text a heading may read - a heading, not a paragraph about the section. */
const MAX_SECTION_HEADING_TEXT = 60;

function readsAsHeading(text: string, section: OptionalSection): boolean {
  return text.length > 0 && text.length <= MAX_SECTION_HEADING_TEXT && section.heading.test(text);
}

/**
 * Markup that shows something even with no text in it: a picture or other
 * media, an image drawn by CSS (`style="background:url(...)"`), or a
 * stylesheet or script, which the rest of the page needs. `visibleText` reads
 * all of these as nothing, which is how a sidebar's photo once went with the
 * Strengths heading beside it.
 */
function holdsContent(markup: string): boolean {
  return (
    /<(?:img|svg|picture|video|audio|canvas|iframe|object|embed|style|script|link)\b/i.test(markup) ||
    /<[a-zA-Z][^>]*\burl\s*\(/i.test(markup)
  );
}

/** Markup that shows nothing of its own: a divider, a line break, an empty box - no text, no content, no data. */
function showsNothing(markup: string): boolean {
  return !/\{\{/.test(markup) && !visibleText(markup) && !holdsContent(markup);
}

/** A fragment's top-level pieces in order: each element whole, each lone tag or comment, each run of text. */
function topLevelPieces(fragment: string): MarkupSpan[] {
  const pieces: MarkupSpan[] = [];
  const tags = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)\b[^>]*>/g;
  let at = 0;
  let match: RegExpExecArray | null;
  while ((match = tags.exec(fragment)) !== null) {
    if (match.index > at) pieces.push({ start: at, end: match.index });
    let end = tags.lastIndex;
    const name = match[2]?.toLowerCase();
    if (name && !match[1] && !VOID_ELEMENTS.has(name) && !match[0].endsWith('/>')) {
      // An element never closed is a lone tag, and what follows it is a sibling.
      const close = findClosingTag(fragment, name, tags.lastIndex);
      if (close !== -1) end = close;
    }
    pieces.push({ start: match.index, end });
    at = end;
    tags.lastIndex = end;
  }
  if (at < fragment.length) pieces.push({ start: at, end: fragment.length });
  return pieces;
}

/**
 * Whether an element's inside, with the section's loop and guard already
 * taken out, is the section and nothing else: ONE piece - an element or a run
 * of text - that reads as its heading, and beside it only markup that shows
 * nothing (`showsNothing`: the loop's emptied list, a divider, whitespace).
 *
 * Measuring the whole inside instead - "is all its text short and about
 * strengths?" - took a grid sidebar holding a photo, the Strengths heading and
 * "References / Available upon request" whole: the photo read as no text, and
 * "Strengths References Available upon request" is under 60 characters. A
 * line of text, a picture or an icon beside the heading now keeps the
 * element, and only the heading and the list go (`sectionOfLoop`'s second
 * step).
 */
function holdsOnlyTheSection(inner: string, section: OptionalSection): boolean {
  for (const piece of topLevelPieces(inner)) {
    if (!readsAsHeading(visibleText(inner.slice(piece.start, piece.end)), section)) continue;
    if (showsNothing(`${inner.slice(0, piece.start)}${inner.slice(piece.end)}`)) return true;
  }
  return false;
}

/** The element whose closing tag ends exactly at `end`, from its opening tag, or null. */
function elementEndingAt(html: string, end: number): MarkupSpan | null {
  const closing = /<\/([a-zA-Z][\w-]*)\s*>$/.exec(html.slice(0, end));
  if (!closing) return null;
  const name = closing[1];
  const tags = new RegExp(`<(/?)${escapeRegExp(name)}(?![\\w-])[^>]*>`, 'gi');
  const found: Array<{ index: number; closing: boolean; selfClosing: boolean }> = [];
  let match: RegExpExecArray | null;
  const head = html.slice(0, closing.index);
  while ((match = tags.exec(head)) !== null) {
    found.push({ index: match.index, closing: Boolean(match[1]), selfClosing: match[0].endsWith('/>') });
  }
  let depth = 1;
  for (let i = found.length - 1; i >= 0; i -= 1) {
    const tag = found[i];
    if (tag.closing) depth += 1;
    else if (!tag.selfClosing) depth -= 1;
    if (depth === 0) return { start: tag.index, end };
  }
  return null;
}

/**
 * The element before `pos`, past whitespace, comments and anything between
 * that shows nothing of its own (`showsNothing`) - a divider under a heading
 * (`<hr>`, `<div class="rule"></div>`), the line break after a label
 * (`<b>Strengths</b><br>`) - or null. What it steps over lies between the
 * element and `pos`, so a cut from the element to `pos` takes it too; looking
 * only at the element right before `pos` found the divider, not the heading,
 * and left the heading printed.
 */
function previousSiblingElement(html: string, pos: number): MarkupSpan | null {
  let end = pos;
  for (;;) {
    const trimmed = html.slice(0, end).replace(/\s+$/, '');
    if (trimmed.endsWith('-->')) {
      const open = trimmed.lastIndexOf('<!--');
      if (open === -1) return null;
      end = open;
      continue;
    }
    end = trimmed.length;
    const lone = /<([a-zA-Z][\w-]*)\b[^<>]*>$/.exec(trimmed);
    if (lone && (VOID_ELEMENTS.has(lone[1].toLowerCase()) || lone[0].endsWith('/>'))) {
      if (!showsNothing(lone[0])) return null;
      end = lone.index;
      continue;
    }
    const element = elementEndingAt(html, end);
    if (!element || !showsNothing(html.slice(element.start, element.end))) return element;
    end = element.start;
  }
}

/**
 * The section a `{{#each field}}` loop (or an inline `{{join field}}`,
 * `sectionLoops`) belongs to, in markup that marks it neither by class nor by
 * `data-section` - an uploaded template, typically, whose heading the class
 * strip could never see, so a switched-off section left its title over an
 * emptied list:
 *
 * 1. the NEAREST element around the loop that holds the section and nothing
 *    else (`holdsOnlyTheSection`: its heading, the loop, markup that shows
 *    nothing - `<div><h3>Strengths</h3>{{#each strengths}}...</div>`);
 *    climbing stops at the first element that holds anything else - another
 *    loop, the summary, a line of text, a photo - because that one is a
 *    column, not the section, and everything further out holds it too;
 * 2. otherwise the loop's container - the outermost element around it that
 *    holds nothing but the loop (or the loop itself, written straight into a
 *    column) - with a guard right around it, plus the heading ELEMENT before
 *    it, past any divider (`<h3>Strengths</h3>{{#if strengths.length}}<ul>...</ul>{{/if}}`).
 *
 * Null when neither is found: the loop then renders nothing once the data is
 * gated, and no guess removes markup that might be something else.
 */
function sectionOfLoop(html: string, loop: MarkupSpan, section: OptionalSection): MarkupSpan | null {
  const ancestors = ancestorsAt(html, loop.start).filter((span) => span.end >= loop.end).reverse();

  let container: MarkupSpan = loop;
  for (const ancestor of ancestors) {
    const rest = besidesTheLoop(html.slice(ancestor.start, ancestor.end), loop, ancestor.start, section.field);
    if (rest === null) break;
    // Its inside: the element's own tags are no part of what it holds.
    const inner = rest.replace(/^<[^>]*>/, '').replace(/<\/[^>]*>$/, '');
    if (holdsOnlyTheSection(inner, section)) return ancestor;
    if (!showsNothing(inner)) break;
    container = ancestor;
  }

  const core = sectionGuardAround(html, container.start, container.end, section.field) ?? container;
  const heading = previousSiblingElement(html, core.start);
  if (!heading) return null;
  const headingMarkup = html.slice(heading.start, heading.end);
  if (/\{\{/.test(headingMarkup) || !readsAsHeading(visibleText(headingMarkup), section)) return null;
  return { start: heading.start, end: core.end };
}

/**
 * Every occurrence of an optional section in a template's markup, each with
 * the `{{#if field.length}}` guard right around it when it has one - the ONE
 * answer to "where is this section", used by both the strip (switched off)
 * and the guard (switched on, so an empty list leaves no heading). In order:
 *
 * 1. an element carrying the marker class (`section-strengths`,
 *    `section-soft-skills`) - every built-in and the manual builder;
 * 2. an element carrying `data-section="strengths|softSkills"`;
 * 3. otherwise, from each `{{#each field}}` loop (or inline `{{join field}}`)
 *    outside those, the element around it that holds the section and
 *    nothing else, or its container and the heading element before it
 *    (`sectionOfLoop`). Skipped when `finds` is 'marked'.
 *
 * Compile time only: the stored template is never rewritten, and the compile
 * cache is keyed on the markup plus the choices, so nothing found here is
 * stored anywhere. Overlapping finds are merged, so a cut never splits one.
 */
function findOptionalSections(html: string, section: OptionalSection, finds: SectionFinds = 'all'): MarkupSpan[] {
  const found: MarkupSpan[] = [];
  const inside = (pos: number) => found.some((span) => pos >= span.start && pos < span.end);

  for (let from = 0; ; ) {
    const element = nextClassedElement(html, section.className, from);
    if (!element) break;
    found.push(element);
    from = element.end;
  }
  for (let from = 0; ; ) {
    const element = nextDataSectionElement(html, section.dataSections, from);
    if (!element) break;
    if (!inside(element.start)) found.push(element);
    from = element.end;
  }
  for (const loop of finds === 'all' ? sectionLoops(html, section.field) : []) {
    if (inside(loop.start)) continue;
    const unit = sectionOfLoop(html, loop, section);
    if (unit) found.push(unit);
  }

  const merged: MarkupSpan[] = [];
  for (const span of found.sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1];
    if (last && span.start < last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  // A guard around a span, then any guard around THAT - an outer `{{#if}}`
  // that a template wrote twice is still one section.
  return merged.map((span) => {
    let current = span;
    for (;;) {
      const guarded = sectionGuardAround(html, current.start, current.end, section.field);
      if (!guarded) return current;
      current = guarded;
    }
  });
}

/** Removes every occurrence of a section (`findOptionalSections`), with the guard around it if it has one. */
function stripTemplateSection(html: string, section: OptionalSection, finds: SectionFinds): string {
  let output = html;
  for (const cut of findOptionalSections(html, section, finds).reverse()) {
    output = `${output.slice(0, cut.start)}${output.slice(cut.end)}`;
  }
  return output;
}

/**
 * Wraps every occurrence of a section in `{{#if field.length}}`, unless it is
 * already wrapped - so a section switched on but with nothing in it leaves no
 * heading over an empty list. Idempotent.
 */
function guardTemplateSection(html: string, section: OptionalSection, finds: SectionFinds): string {
  const open = `{{#if ${section.field}.length}}`;
  const close = '{{/if}}';
  let output = html;
  for (const span of findOptionalSections(html, section, finds).reverse()) {
    if (new RegExp(`^${guardOpenerPattern(section.field)}`).test(output.slice(span.start))) continue;
    output = `${output.slice(0, span.start)}${open}${output.slice(span.start, span.end)}${close}${output.slice(span.end)}`;
  }
  return output;
}

/**
 * The five per-item skills loops the built-ins and the manual builder write,
 * rewritten into one category heading and its joined skills per group. For the
 * categorized layout only: flat hands these loops one entry per skill, which
 * is exactly what they were written to draw.
 */
function rewritePerItemSkillLoops(html: string): string {
  return html
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
}

/**
 * A template's markup as it is compiled for one profile's choices.
 *
 * - Soft Skills and Strengths: a section the profile switched off is removed
 *   outright, so no template - however it is written - can show one; a section
 *   switched on is guarded on its list, so an empty one leaves no heading. The
 *   data step gates the same lists independently (see `applySkillsLimit`).
 * - "Hard Skills" headings read "Technical Skills", in both layouts.
 * - Categorized rewrites the per-item skills loops into category headings;
 *   flat leaves them alone, because flat already hands them one entry per
 *   skill. The rewrite used to run for both, which drew a flat list as ONE
 *   item holding every skill, squeezed into a single column of a multi-column
 *   list - the shipped markup was already the right flat design.
 * - Any element around `{{category}}` is guarded, so the flat layout's one
 *   headless group draws no empty heading in either.
 */
function normalizeTemplateSkillsSections(
  html: string,
  choices: ResumeSectionChoices,
  finds: SectionFinds = 'all'
): string {
  let output = html;
  for (const section of finds === 'none' ? [] : OPTIONAL_SECTIONS) {
    output = choices[section.choice]
      ? guardTemplateSection(output, section, finds)
      : stripTemplateSection(output, section, finds);
  }
  output = output.replace(/Hard Skills/g, 'Technical Skills');
  if (choices.layout === 'categorized') {
    output = rewritePerItemSkillLoops(output);
  }
  return guardEmptyCategoryHeadings(output);
}

/**
 * Makes a category heading disappear when there is no category.
 *
 * The flat layout is delivered as ONE group whose heading is the empty string,
 * so that every template keeps the single `{{#each skillCategories}}` loop it
 * already has instead of growing a second branch. The cost of that choice is
 * this: an unguarded heading element renders as an empty box, which in the
 * built-in templates is a visible blank line and a border above the skills.
 *
 * Applied to the markup rather than asked of template authors, and applied
 * after the rewrites above so it also covers the markup this file generates.
 * A template somebody uploads has never heard of the flat layout, and the
 * option would otherwise be one a profile can only safely use on the handful of
 * templates that happened to be written for it.
 *
 * Idempotent: the negative lookbehind leaves a heading somebody already guarded
 * alone, rather than nesting a second identical `{{#if}}` around it.
 */
function guardEmptyCategoryHeadings(html: string): string {
  return (
    html
      // First, because its <br> belongs to the heading rather than to the
      // skills. Let the general rule below claim the <strong> and the break is
      // left outside the guard, so the flat layout opens its list with a blank
      // line - which is exactly what it did until this ordering was measured.
      .replace(
        /(?<!\{\{#if category\}\})<strong>\s*\{\{category\}\}\s*<\/strong>\s*<br\s*\/?>/g,
        '{{#if category}}<strong>{{category}}</strong><br>{{/if}}'
      )
      .replace(
        /(?<!\{\{#if category\}\})(<(\w+)\b[^>]*>)\s*\{\{category\}\}\s*(<\/\2>)/g,
        '{{#if category}}$1{{category}}$3{{/if}}'
      )
  );
}

export function prepareResumeRenderData(
  profile: Profile,
  tailoredContent?: TailoredContent,
  companyName?: string,
  role?: string,
  options: ResumeRenderOptions = {}
) {
  const linkedinHref = normalizeExternalUrl(profile.contact?.linkedin);
  const linkedinDisplay = getExternalUrlDisplay(profile.contact?.linkedin);
  const tailoredHardSkills = tailoredContent?.hardSkills ?? [];
  const tailoredSkills = tailoredContent?.skills ?? [];
  const tailoredSoftSkills = normalizeSkills(tailoredContent?.softSkills);
  const tailoredStrengths = renderableStrengths(tailoredContent?.strengths);
  const data = {
    ...profile,
    contact: {
      ...profile.contact,
      ...(typeof profile.contact?.github === 'string' ? { github: safeContactLink(profile.contact.github) } : {}),
      ...(typeof profile.contact?.portfolio === 'string'
        ? { portfolio: safeContactLink(profile.contact.portfolio) }
        : {}),
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
    // The profile's own lists, for an untailored render. Whether either is
    // shown at all is the profile's switch, decided in `applySkillsLimit`.
    softSkills: profile.softSkills ?? [],
    strengths: profile.strengths ?? [],
    ...(tailoredContent && {
      summary: tailoredContent.summary,
      experience: tailoredContent.experience,
      skills: tailoredSkills,
      hardSkills: tailoredHardSkills,
      // The tailored lists when they have anything in them, and the profile's
      // own when they do not. Tailored content can predate the switch being
      // turned on - a preview held by the page and sent back with a batch, or
      // a queued task - and then carries nothing for the section; showing the
      // person's own entries beats an empty section they asked for.
      softSkills: tailoredSoftSkills.length > 0 ? tailoredSoftSkills : (profile.softSkills ?? []),
      strengths: tailoredStrengths.length > 0 ? tailoredStrengths : (profile.strengths ?? []),
    })
  };
  return normalizeExperienceDescriptions(applySkillsLimit(data, options));
}

/** The render data a template is compiled against. */
export type ResumeRenderData = ReturnType<typeof prepareResumeRenderData>;

/**
 * Compiled templates, by the markup and the choices it was compiled for.
 *
 * Keyed on the markup itself rather than id and updatedAt: a template object
 * is not always a stored one (tests and the manual builder hand over fresh
 * objects that can share an id), and a key that could match different markup
 * would render the wrong template. The live preview compiles the same
 * template on every pause in typing, which is what makes the cache worth
 * having; it is bounded, oldest out first.
 */
const compiledTemplates = new Map<string, HandlebarsTemplateDelegate>();
const COMPILED_TEMPLATE_CACHE_SIZE = 64;

function parsesAsHandlebars(markup: string): boolean {
  try {
    Handlebars.parse(markup);
    return true;
  } catch {
    return false;
  }
}

const warnedSectionFallbacks = new Set<string>();

/**
 * The markup a template is compiled from: `normalizeTemplateSkillsSections`,
 * unless finding its sections leaves markup Handlebars cannot parse when the
 * template itself parses. A cut follows the HTML, a Handlebars block need not
 * (`<div class="section-strengths">{{#if summary}}...</div>{{/if}}` is valid
 * Handlebars), and a cut through one used to fail every resume on the
 * template - with the switch off, which is every profile's default. Then the
 * sections found from their loops are left out, and if that still does not
 * parse, no section is removed at all: the render gate still empties a
 * switched-off list, and only its heading may print. Logged once per template
 * and fallback. A template that does not parse by itself fails as it always
 * did, with its own error.
 *
 * Handlebars compiles lazily, so this parse is the one place a broken cut can
 * be caught before a render; it runs only on a compile-cache miss.
 */
function compilableMarkup(template: Template, choices: ResumeSectionChoices): string {
  const markup = normalizeTemplateSkillsSections(template.htmlContent, choices);
  if (parsesAsHandlebars(markup) || !parsesAsHandlebars(template.htmlContent)) return markup;

  const marked = normalizeTemplateSkillsSections(template.htmlContent, choices, 'marked');
  const finds: SectionFinds = parsesAsHandlebars(marked) ? 'marked' : 'none';
  const key = `${template.id}|${finds}`;
  if (!warnedSectionFallbacks.has(key)) {
    warnedSectionFallbacks.add(key);
    console.warn(
      finds === 'marked'
        ? `[templates] Template "${template.id}" does not compile with its Strengths / Soft Skills section ` +
            'found from the list, so only a section marked with its class or data-section is removed or ' +
            "guarded; a switched-off section's heading may still print. Put section-strengths / " +
            'section-soft-skills on the element that holds the heading and the list.'
        : `[templates] Template "${template.id}" does not compile with its Strengths / Soft Skills section ` +
            'removed, so it is drawn with both sections in place: a switched-off list prints empty, and ' +
            'its heading may still print. A Handlebars block ({{#if}}, {{#each}}) probably opens inside ' +
            "the section's element and closes outside it; move it wholly inside or outside."
    );
  }
  return finds === 'marked' ? marked : normalizeTemplateSkillsSections(template.htmlContent, choices, 'none');
}

function compileTemplate(template: Template, choices: ResumeSectionChoices): HandlebarsTemplateDelegate {
  if (typeof template.htmlContent !== 'string' || !template.htmlContent.trim()) {
    throw new Error(`Template "${template.name || template.id}" is missing htmlContent`);
  }

  const key = `${choices.layout}|${choices.softSkills ? 1 : 0}|${choices.strengths ? 1 : 0}|${template.htmlContent}`;
  const cached = compiledTemplates.get(key);
  if (cached) {
    compiledTemplates.delete(key);
    compiledTemplates.set(key, cached);
    return cached;
  }

  const compiled = Handlebars.compile(compilableMarkup(template, choices));
  compiledTemplates.set(key, compiled);
  if (compiledTemplates.size > COMPILED_TEMPLATE_CACHE_SIZE) {
    const oldest = compiledTemplates.keys().next().value;
    if (oldest !== undefined) compiledTemplates.delete(oldest);
  }
  return compiled;
}

export async function generateResumePDF(
  profile: Profile,
  template: Template,
  tailoredContent: TailoredContent | undefined,
  pathInfo: GeneratedPathInfo,
  companyName?: string,
  role?: string
): Promise<string> {
  // A switch the template has no section for is off here, exactly as it is in
  // the DOCX and in the tailoring that wrote this content.
  const renderData = timePdfStageSync('render data preparation', () =>
    prepareResumeRenderData(
      profileForTemplate(profile, template),
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
  const pageBox = resolveTemplatePageBox(template);
  const browser = await timePdfStage('browser ready', () => getSharedPdfBrowser());
  let page: Awaited<ReturnType<Browser['newPage']>> | null = null;

  try {
    const activePage = await timePdfStage('new page', () => browser.newPage());
    page = activePage;
    // Loading the HTML and printing it both wait at most PDF_RENDER_TIMEOUT_MS
    // (puppeteer's own 30 seconds by default). Heavy templates on a slow or
    // shared machine are what run into it, and the fix there is a setting,
    // not a code change.
    activePage.setDefaultTimeout(pdfRenderTimeoutMs());
    await timePdfStage('page setup', async () => {
      // The viewport is what viewport units and the pre-print layout resolve
      // against, so give it this template's own content box rather than a
      // fixed one that may be up to 96px narrower than the page it prints on.
      await activePage.setViewport({
        width: Math.round(pageBox.contentWidthPx),
        height: Math.round(pageBox.contentHeightPx),
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

/**
 * The builder's preview of a tailored resume, shown in the page before it is
 * generated. It carries the same Content-Security-Policy as the profile
 * editor's preview: the document holds whatever the model wrote, and a frame
 * is only as safe as the strictest thing guarding it - the page frames it with
 * no permissions too, so either lock alone keeps a stray script or remote
 * fetch out.
 */
export async function generatePreviewHTML(
  profile: Profile,
  template: Template,
  tailoredContent?: TailoredContent
): Promise<string> {
  const renderData = prepareResumeRenderData(profileForTemplate(profile, template), tailoredContent);
  return withPreviewContentSecurityPolicy(assembleResumeDocument(template, renderTemplateBody(template, renderData)));
}

/**
 * Compiles a template against render data. Shared so preview and PDF agree.
 *
 * The compile choices are read from the render data's own profile settings -
 * the same ones `applySkillsLimit` gated the data on - so the markup kept and
 * the data handed to it can never be decided from two different places.
 */
function renderTemplateBody(template: Template, renderData: ResumeRenderData): string {
  const compiledTemplate = compileTemplate(template, getProfileResumeSections(renderData));
  return enforceSkillCategoryLineBreaks(
    rewriteLinkedInAnchorDisplay(compiledTemplate(renderData)),
    renderData
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
function previewPageChrome(box: ResumePageBox): string {
  const { margin, pageWidthPx, pageHeightPx, contentWidthPx, contentHeightPx } = box;

  /* A document that asks for a page size other than the A4 `page.pdf()` is
     called with is laid out at its own size and then scaled to fit, centred.
     Mirror that instead of showing the user an unscaled page. */
  const fitToMediaBox =
    box.mediaScale === 1
      ? ''
      : `
      transform: translateY(${box.mediaOffsetYPx.toFixed(2)}px) scale(${box.mediaScale.toFixed(5)});
      transform-origin: top left;
      /* A transform does not shrink layout overflow: the page still lays out
         at its own width (816px for Letter) inside a frame sized to the A4
         sheet it prints on (794px), and a classic-scrollbar browser paints a
         horizontal bar under it - which then takes 15px of height and forces a
         vertical one too. Horizontal only: on html this goes to the viewport,
         and a multi-page preview opened in its own tab must still scroll down. */
      overflow-x: hidden;`;

  /* `vh` and friends resolve against the viewport, which off-page is the
     preview iframe rather than the printed page. Only templates that actually
     use viewport units need the correction, so only they get it: pinning
     `body > *` on every template would force a full-page box on wrappers that
     paint a background. */
  const viewportUnitFix = box.usesViewportUnits
    ? `
    body > * {
      min-height: ${contentHeightPx.toFixed(2)}px !important;
    }`
    : '';

  return `<style id="resume-preview-page">
    html {
      box-sizing: border-box;
      width: ${pageWidthPx}px;
      min-height: ${pageHeightPx}px;
      background: #ffffff;
      /* The page margins this template declares, taken from its own @page
         rule. On html, so the body's box is untouched: a border or padding on
         body would stop a first child's top margin collapsing through it and
         shift the whole document relative to the print. */
      padding: ${margin.top} ${margin.right} ${margin.bottom} ${margin.left};
      /* Print clips to the page area, so an element that bleeds outside the
         margins - a header with a negative margin, say - is cut off at the
         margin edge rather than painted into it. A clip-path reproduces that
         without the layout side effects overflow would bring: a clip on body
         would open a block formatting context and stop the first child's top
         margin collapsing, moving the whole document down instead. */
      clip-path: inset(${margin.top} ${margin.right} ${margin.bottom} ${margin.left});
      /* page.pdf runs with printBackground: true, so colours must not be
         dropped the way a screen render would drop them. */
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;${fitToMediaBox}
    }
    body {
      width: ${contentWidthPx.toFixed(2)}px !important;
      min-height: ${contentHeightPx.toFixed(2)}px !important;
      margin-left: auto !important;
      margin-right: auto !important;
    }${viewportUnitFix}
  </style>`;
}

/**
 * A template rendered with the sample resume (`SAMPLE_PROFILE`, in
 * services/sampleProfile.ts), for the gallery.
 *
 * With no choices it is what the gallery has always shown: categorized, no
 * Soft Skills or Strengths. A caller may ask for the flat layout or either
 * section, so a template can be shown the way a particular profile would get
 * it.
 */
export function generateTemplatePreviewHTML(
  template: Template,
  choices: Partial<ResumeSectionChoices> = {}
): string {
  const sample: Profile = {
    ...SAMPLE_PROFILE,
    profileSettings: {
      ...(choices.layout ? { technicalSkillsLayout: choices.layout } : {}),
      includeSoftSkills: choices.softSkills === true,
      includeStrengths: choices.strengths === true,
    },
  };
  const renderData = prepareResumeRenderData(sample);
  const document = assembleResumeDocument(template, renderTemplateBody(template, renderData));
  return `${document}${previewPageChrome(resolveTemplatePageBox(template))}`;
}

/**
 * What the live profile preview's document may do: draw with its own inline
 * styles and embedded images and fonts, and nothing else - no script, no
 * request anywhere. The page frames it in a script-less sandbox as well; this
 * is the second lock, and it travels with the document.
 */
export const PREVIEW_CONTENT_SECURITY_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

/**
 * Puts the policy ahead of everything in the document that could fetch -
 * a policy only governs what is parsed after it, and a template's separate
 * stylesheet is prepended before its own markup - but never ahead of a
 * leading doctype: that would push the document into quirks mode, and the
 * preview would lay out differently from the PDF it is previewing.
 *
 * Right after the doctype the parser opens the head for it, so the policy is
 * in force from there; the template's own `<html>` and `<head>` tags then
 * merge into the ones already open, as they do for any content placed there.
 */
function withPreviewContentSecurityPolicy(document: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CONTENT_SECURITY_POLICY}">`;
  const doctype = /^\s*<!DOCTYPE[^>]*>/i.exec(document);
  return doctype
    ? `${doctype[0]}${meta}${document.slice(doctype[0].length)}`
    : `${meta}${document}`;
}

export interface ProfilePreview {
  html: string;
  /**
   * The printed page, in CSS px at 96 DPI: what the frame should be sized to
   * before it is scaled to fit. A template that asks for a page other than A4
   * is shrunk onto A4 by the print, and the preview chrome mirrors that, so
   * its page is the A4 sheet. `contentHeightPx` is the height of one page's
   * content box at that scale - approximately where a page break falls in the
   * continuous preview.
   */
  page: { widthPx: number; heightPx: number; contentHeightPx: number };
}

/**
 * A profile - an unsaved draft from the editor, usually - rendered through
 * exactly the pipeline a generated resume takes (the same render data,
 * compile choices, post-processing and document), untailored, with the
 * gallery's page chrome so it is as wide as the printed page.
 *
 * Two differences from generation, both deliberate. A categorized block is not
 * padded from the library (see `ResumeRenderOptions.padSkillCategories`). And
 * the document carries a Content-Security-Policy, because it contains whatever
 * is in the editor at that moment.
 */
export function generateProfilePreviewHTML(profile: Profile, template: Template): ProfilePreview {
  const renderData = prepareResumeRenderData(profileForTemplate(profile, template), undefined, undefined, undefined, {
    padSkillCategories: false,
  });
  const box = resolveTemplatePageBox(template);
  const document = assembleResumeDocument(template, renderTemplateBody(template, renderData));
  const shrunkOntoA4 = box.mediaScale !== 1;
  return {
    html: `${withPreviewContentSecurityPolicy(document)}${previewPageChrome(box)}`,
    page: {
      widthPx: Math.round(shrunkOntoA4 ? A4_PAGE_WIDTH_PX : box.pageWidthPx),
      heightPx: Math.round(shrunkOntoA4 ? A4_PAGE_HEIGHT_PX : box.pageHeightPx),
      contentHeightPx: Math.round(box.contentHeightPx * box.mediaScale),
    },
  };
}
