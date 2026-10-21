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
  getProfileSectionLayout,
  profileForTemplate,
  type ResumeSectionChoices,
} from '../services/profileService';
import { SAMPLE_PROFILE, SAMPLE_TAILORED_CONTENT } from '../services/sampleProfile';
import { prepareExtraSectionData } from '../services/extraSections';
import { sectionSortKey } from '../config/profileSections';
import { expandExtraSectionsMacro, injectExtraSectionsStyle } from './extraSectionsMarkup';
import { fitPlainSkillGroups } from './plainSkillsMarkup';
import {
  escapeRegExp,
  findSections,
  guardOpenerPattern,
  locateSections,
  parentKeyOf,
  sectionLocator,
  templateNamesField,
  type SectionFinds,
} from './sectionLocator';
import { findSoftSkillGroup, flattenSkillGroups, sanitizeSkillGroups } from '../services/skillGroups';
import { TailoredContent, Template } from '../types/template';
import type { GeneratedPathInfo } from '../utils/generatedPath';
import { getResumeOutputFilename } from '../utils/generatedPath';
import {
  HARD_SKILL_CATEGORIES,
  HardSkillCategory,
  type HardSkillRecord,
  hardSkillIndexKey,
  readHardSkillIndex,
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
 * carry headings its author invented, a tailored resume prints the model's
 * own, and the flat layout carries the empty string - which is not a missing
 * heading but the statement that there is none.
 */
type SkillCategoryGroup = {
  category: string;
  skills: string[];
};

const SKILL_CATEGORY_ORDER: SkillCategory[] = [...HARD_SKILL_CATEGORIES];
const SKILL_CATEGORY_LANGUAGE_CATEGORY: SkillCategory = 'Languages';

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

type SkillsData = {
  /** Tailored content's flat list, from content that carries no `skillGroups`. */
  hardSkills?: string[];
  softSkills?: string[];
  strengths?: Array<{ title?: unknown; description?: unknown }>;
  /** The profile's own skills, in the order the person keeps them. */
  skills?: string[];
  /** The model's Technical Skills block; when it has a group it is the printed block. */
  skillGroups?: unknown;
  softSkillGroupHeading?: string;
  /** The author's own grouping, when the profile carries one. */
  skillCategories?: ProfileSkillCategoryGroup[];
  profileSettings?: Profile['profileSettings'];
};

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
 * arranges for every template, uploaded ones included - and lets the one
 * group take the whole row, which the Plain safety net arranges for a design
 * that gives a category one cell of a grid (plainSkillsMarkup.ts).
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
 * A group with no heading among headed ones (a model block, or one edited in
 * the builder, can carry one) is its skills alone, never ": a, b".
 */
function renderSkillLines(groups: SkillCategoryGroup[]): string[] {
  if (groups.length === 1 && !groups[0].category) return [...groups[0].skills];
  return groups.map((group) =>
    group.category ? `${group.category}: ${group.skills.join(', ')}` : group.skills.join(', ')
  );
}

type SkillsLimitedData<T> = Omit<T, 'strengths' | 'softSkills'> & {
  hardSkills: string[];
  softSkills: string[];
  skills: string[];
  strengths: RenderStrength[];
  skillCategories: SkillCategoryGroup[];
};

/**
 * The skills a person entered, each under the library's heading for it, in
 * the order they entered them, and nothing more. There is no padding: a block
 * listing Kubernetes under a heading the person never wrote, on a profile that
 * never claimed it, is a claim on their resume they did not make.
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

/** The author's own headings, when the profile has any with something under them. */
function authoredGroups(data: SkillsData): ProfileSkillCategoryGroup[] {
  return (data.skillCategories ?? []).filter(
    (group) => group?.category?.trim() && Array.isArray(group.skills) && group.skills.length > 0
  );
}

/**
 * The profile's OWN skills as a block - an untailored render, or the fallback
 * when tailored content has nothing printable. Unpadded. Grouped: the author's
 * own grouping as they typed it, else `groupClaimedSkills` - the library's
 * heading for each skill they claimed, the headings in the library's order and
 * the person's order under each, library-known skills only. Flat: the
 * library-known skills as one list, in the person's order and the library's
 * spelling.
 */
function ownSkillCategories(data: SkillsData, layout: TechnicalSkillsLayout): SkillCategoryGroup[] {
  const skills = normalizeSkills(data.skills ?? []);
  if (layout === 'flat') return flattenSkillCategories(normalizeLibraryHardSkills(skills));
  const authored = authoredGroups(data);
  return authored.length > 0 ? buildAuthoredSkillCategories(skills, authored) : groupClaimedSkills(skills);
}

/**
 * THE RENDER GATE. Every path - the builder's preview, the PDF, the DOCX, the
 * queue, the gallery, the profile editor's preview - prepares its data
 * through here, so whatever the caller handed in (a profile, fresh tailoring,
 * content a page held from a preview and sent back, a queued payload from
 * before a deploy) is decided once, the same way, on every render.
 *
 * The Technical Skills block, in order of precedence:
 *
 * 1. The model's `skillGroups`, when any group survives sanitising - printed
 *    as returned (the tailoring prompt promises "Nothing reorders it, merges
 *    it, spell-checks it or fills it out"). Grouped: the groups verbatim.
 *    Plain: one headless list of the same skills, same order, repeats
 *    removed. The soft-skill group goes to the Soft Skills section while that
 *    switch is on - as `profileForTemplate` left it, so a template with no
 *    Soft Skills section keeps the group in the block - and stays in the
 *    block, under its heading, while it is off. A block left empty (only the
 *    soft group came back, and it was routed) is the profile's own skills.
 * 2. Older tailored content with only `hardSkills`, unpadded. Plain: that
 *    list, unfiltered, in its own order. Grouped: under the author's headings
 *    when the profile has any (every skill; one they never placed goes under
 *    the library's heading), else regrouped by `groupClaimedSkills` - the
 *    library's headings in the library's order, library-known skills only.
 * 3. Otherwise the profile's own skills (`ownSkillCategories`), which also
 *    draws only library-known skills except under the author's own headings.
 *
 * Nothing is padded from the skill library on any path, and nothing is
 * reordered by its priority; only (2) and (3) are filed or filtered by it,
 * and the model's block in (1) never is.
 */
function applySkillsLimit<T extends SkillsData>(data: T): SkillsLimitedData<T> {
  const sections = getProfileResumeSections({ profileSettings: data.profileSettings });
  const layout: TechnicalSkillsLayout = sections.layout;

  const finish = (skillCategories: SkillCategoryGroup[], softSkills: unknown = data.softSkills): SkillsLimitedData<T> => {
    const lines = renderSkillLines(skillCategories);
    return {
      ...data,
      hardSkills: lines,
      // The two optional sections. A section the profile has switched off
      // renders nothing, whatever the content carries; one switched on renders
      // what it was given. The compile step strips or guards the same sections
      // independently (see `normalizeTemplateSkillsSections`).
      softSkills: sections.softSkills ? normalizeSkills(softSkills ?? []) : [],
      // The same lines under both names, because templates disagree about
      // which one they read and neither is more correct than the other.
      skills: lines,
      strengths: sections.strengths ? renderableStrengths(data.strengths) : [],
      skillCategories,
    } as SkillsLimitedData<T>;
  };

  const groups = sanitizeSkillGroups(data.skillGroups);
  if (groups.length > 0) {
    const softAt = findSoftSkillGroup(groups, data.softSkillGroupHeading);
    const routed = sections.softSkills && softAt !== -1;
    const block = routed ? groups.filter((_, index) => index !== softAt) : groups;
    const printed =
      layout === 'flat'
        ? flattenSkillCategories(flattenSkillGroups(block))
        : block.map(({ category, skills }) => ({ category, skills }));
    return finish(
      printed.length > 0 ? printed : ownSkillCategories(data, layout),
      routed ? groups[softAt].skills : data.softSkills
    );
  }

  const tailored = normalizeSkills(data.hardSkills ?? []);
  if (tailored.length > 0) {
    if (layout === 'flat') return finish(flattenSkillCategories(tailored));
    const authored = authoredGroups(data);
    const grouped = authored.length > 0 ? buildAuthoredSkillCategories(tailored, authored) : groupClaimedSkills(tailored);
    return finish(grouped.length > 0 ? grouped : ownSkillCategories(data, layout));
  }

  return finish(ownSkillCategories(data, layout));
}

function getResumeTitle(profile: Profile): string {
  const profileTitle = profile.title?.trim();
  if (profileTitle) return profileTitle;
  const lastRole = profile.experience?.[0]?.title?.trim();
  return lastRole || 'Professional';
}

/**
 * The headline as an ATS reads it: letters, digits, spaces and the
 * punctuation a title is written with - `| ( ) / , . & + # · -` - and nothing
 * else. Those are kept because tailoring composes the printed title from the
 * profile's headline and the kind of role ("Senior Software Engineer | Cloud
 * Engineer", "Software Engineer (AI/ML Engineer)"), and because "C#",
 * "C++", "Node.js" and "R&D" are names. Any other symbol (quotes, colons,
 * brackets, `@`, `%`, arrows, emoji) becomes a space. The same rule for an
 * untailored title and a tailored one.
 */
function sanitizeTitleForATS(title: string): string {
  return title
    .replace(/[^\p{L}\p{M}\p{N}\s|()/,.&+#·-]/gu, ' ')
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
 *
 * The headings looked for are this render's own (`skillCategories`), escaped
 * as the template printed them. They used to be a fixed list of the library's,
 * which turned "Languages: a, b" into a heading block and left a model's
 * "CI/CD & Automation: a, b" beside it as one plain line.
 *
 * A separator the template prints after each line inside the element - a
 * `{{#unless @last}} • {{/unless}}` in a span loop - is taken with the line,
 * so such a loop in Grouped comes out as heading blocks with no stray bullet.
 */
function enforceSkillCategoryLineBreaks(
  html: string,
  renderData: { hardSkills?: unknown; skills?: unknown; skillCategories?: unknown }
): string {
  const skillLines = new Set(
    [renderData.hardSkills, renderData.skills]
      .flatMap((list) => (Array.isArray(list) ? list : []))
      .filter((line): line is string => typeof line === 'string')
      .map((line) => Handlebars.escapeExpression(line).trim())
  );
  const headings = [
    ...new Set(
      (Array.isArray(renderData.skillCategories) ? renderData.skillCategories : [])
        .map((group: { category?: unknown }) => (typeof group?.category === 'string' ? group.category.trim() : ''))
        .filter(Boolean)
        .map((category: string) => escapeRegExp(Handlebars.escapeExpression(category)))
    ),
  ];
  if (skillLines.size === 0 || headings.length === 0) return html;
  const categoryTextPattern = new RegExp(
    `<(span|div)\\b([^>]*)>\\s*(${headings.join('|')}):\\s*([^<]*?)\\s*[•·]?\\s*<\\/\\1>`,
    'g'
  );

  return html.replace(categoryTextPattern, (match, _tagName, attributes, category, skills) => {
    const normalizedSkills = String(skills ?? '').trim();
    if (!skillLines.has(`${category}: ${normalizedSkills}`)) return match;
    const cleanedAttributes = String(attributes ?? '').replace(/\sclass=(["']).*?\1/i, '');
    return `<div${cleanedAttributes} class="skill-category"><div class="skill-category-title">${category}</div><div class="skill-category-skills">${normalizedSkills}</div></div>`;
  });
}

/**
 * The two optional sections a profile switches on and off, as the compile
 * step strips or guards them. WHERE each is in a template's markup is the
 * locator's to say (generators/sectionLocator.ts), shared with the reorder
 * step and with the template read that derives `printsSections` and
 * `nativeSectionOrder`.
 */
const OPTIONAL_SECTIONS = [
  { ...sectionLocator('softSkills'), field: 'softSkills', choice: 'softSkills' },
  { ...sectionLocator('strengths'), field: 'strengths', choice: 'strengths' },
] as const;

type OptionalSection = (typeof OPTIONAL_SECTIONS)[number];

/** Removes every occurrence of a section (`findOptionalSections`), with the guard around it if it has one. */
function stripTemplateSection(html: string, section: OptionalSection, finds: SectionFinds): string {
  let output = html;
  for (const cut of findSections(html, section, finds).reverse()) {
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
  for (const span of findSections(html, section, finds).reverse()) {
    if (new RegExp(`^${guardOpenerPattern(section.field)}`).test(output.slice(span.start))) continue;
    output = `${output.slice(0, span.start)}${open}${output.slice(span.start, span.end)}${close}${output.slice(span.end)}`;
  }
  return output;
}

/**
 * A Technical Skills line that is one element holding only the joined list -
 * `<p class="skills-line"><strong>Technical Skills:</strong> {{join hardSkills ", "}}</p>`,
 * the owner's uploaded `ats-*` templates - with its optional bold label.
 * Joined as written, Grouped's "Heading: a, b" lines ran into one paragraph,
 * "Languages: C#, Python, Frameworks: React, ...".
 */
const JOINED_SKILLS_LINE =
  /<(p|div|li|span|td)\b([^>]*)>\s*(?:<(strong|b)\b[^>]*>[^<{}]*<\/\3>\s*)?\{\{\s*join\s+hardSkills\s+("[^"]*"|'[^']*')\s*\}\}\s*<\/\1>/g;

/**
 * The joined line's elements that are a line of their own, so one per group
 * reads as a line per heading. A `span` or a `td` repeated is not: copies of
 * a span ran their groups together inside its line with nothing between them
 * ("...Python, CFrameworks and Libraries: ..."), and copies of a td were new
 * cells of its row, a column more in the table for every group.
 */
const JOINED_LINE_BLOCKS = new Set(['p', 'div', 'li']);

/**
 * The skills markup the built-ins, the manual builder and the owner's
 * uploaded templates write, rewritten into one line per group - its heading
 * and its joined skills. For the categorized layout only: flat hands these
 * shapes one entry per skill, which is exactly what they were written to draw.
 *
 * - The box per skill (`default`, `azure-stack`, the manual builder): a
 *   category cell per group.
 * - The list item per skill (fourteen built-ins): an item per group, its
 *   heading in bold over its skills.
 * - A joined line (`JOINED_SKILLS_LINE`): a `p`, `div` or `li` repeated per
 *   group; a `span` or `td` kept as the one element it is, its groups inside
 *   it on lines of their own (`JOINED_LINE_BLOCKS` says why). Either way the
 *   group's heading takes the static label's place and the template's own
 *   separator is kept. Guarded on the heading itself, so a headless group
 *   among headed ones (a model block can carry one) prints no ": ". A join
 *   inside an attribute or beside other text is left as written, and so is a
 *   join over anything but `hardSkills` - `{{join skills ...}}` is also a
 *   category's own list inside a category loop.
 *
 * A span loop over `hardSkills` is not rewritten here: its "Heading: a, b"
 * lines become heading blocks after the render (`enforceSkillCategoryLineBreaks`).
 */
function rewritePerItemSkillLoops(html: string): string {
  return html
    .replace(
      /\{\{#if hardSkills\.length\}\}\s*\{\{#each hardSkills\}\}\s*<div class="skill-box">\{\{this\}\}<\/div>\s*\{\{\/each\}\}\s*\{\{else\}\}\s*\{\{#each skills\}\}\s*<div class="skill-box">\{\{this\}\}<\/div>\s*\{\{\/each\}\}\s*\{\{\/if\}\}/g,
      '{{#each skillCategories}}<div class="skill-category"><div class="skill-category-title">{{category}}</div><div class="skill-category-skills">{{join skills ", "}}</div></div>{{/each}}'
    )
    .replace(
      /\{\{#each hardSkills\}\}\s*<li[^>]*>\{\{this\}\}<\/li>\s*\{\{\/each\}\}/g,
      '{{#each skillCategories}}<li><strong>{{category}}</strong><br>{{join skills ", "}}</li>{{/each}}'
    )
    .replace(
      JOINED_SKILLS_LINE,
      (_match, tag: string, attributes: string, _label: string | undefined, separator: string) => {
        const line = `{{#if category}}<strong>{{category}}:</strong> {{/if}}{{join skills ${separator}}}`;
        return JOINED_LINE_BLOCKS.has(tag)
          ? `{{#each skillCategories}}<${tag}${attributes}>${line}</${tag}>{{/each}}`
          : `<${tag}${attributes}>{{#each skillCategories}}${line}{{#unless @last}}<br>{{/unless}}{{/each}}</${tag}>`;
      }
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
 * - Categorized rewrites the per-item skills loops (and a joined skills line)
 *   into category headings; flat leaves them alone, because flat already
 *   hands them one entry per skill. The rewrite used to run for both, which
 *   drew a flat list as ONE item holding every skill, squeezed into a single
 *   column of a multi-column list - the shipped markup was already the right
 *   flat design.
 * - Flat marks the element holding a category loop - and nothing else -
 *   instead, so the one headless group takes the whole row of a grid of
 *   category cells (`fitPlainSkillGroups`, plainSkillsMarkup.ts): every
 *   template prints both layouts.
 * - Any element around `{{category}}` is guarded, so the flat layout's one
 *   headless group draws no empty heading in either.
 * - Any element holding only `{{description}}` is guarded, so a role with no
 *   description (every tailored one) leaves no empty box behind.
 */
function normalizeTemplateSkillsSections(
  html: string,
  choices: ResumeSectionChoices,
  finds: SectionFinds = 'all',
  templateId = ''
): string {
  // First, so the blocks it generates are plain markup the steps below can
  // guard and move like a built-in's own sections.
  let output = expandExtraSectionsMacro(html, choices.customKeys ?? []);
  for (const section of finds === 'none' ? [] : OPTIONAL_SECTIONS) {
    output = choices[section.choice]
      ? guardTemplateSection(output, section, finds)
      : stripTemplateSection(output, section, finds);
  }
  if (finds !== 'none' && choices.sectionOrder && choices.sectionOrder.length > 0) {
    output = reorderTemplateSections(output, choices.sectionOrder, finds, templateId);
  }
  output = output.replace(/Hard Skills/g, 'Technical Skills');
  output = choices.layout === 'categorized' ? rewritePerItemSkillLoops(output) : fitPlainSkillGroups(output);
  output = injectExtraSectionsStyle(output);
  return guardEmptyDescriptions(guardEmptyCategoryHeadings(output));
}

const warnedUnorderable = new Set<string>();
const warnedUnmovable = new Set<string>();

/**
 * The markup with its sections in the profile's stored order
 * (config/profileSections.ts has the semantics; the locator says where each
 * section is). Within each parent element - each column, in a two-column
 * template - the sections found are sorted by `sectionSortKey` and refilled
 * into the slots they occupied: a listed one to its place in the order, an
 * unlisted one after every listed one in the template's own order. What sits
 * between the slots - a header, a photo, a divider - stays where it is, and a
 * section never leaves the column the template put it in.
 *
 * A reorder follows the HTML; a Handlebars block need not. A result that no
 * longer parses when the input did is dropped for the input, warned once per
 * template, the same rule as `guardEmptyDescriptions`: sections in the
 * template's own order are a blemish, a template that will not compile is
 * every resume on it failing. A listed kind the template prints but the
 * locator cannot find is left where it is and warned once per template and
 * kind; a render never fails over the order.
 */
function reorderTemplateSections(html: string, order: readonly string[], finds: SectionFinds, templateId: string): string {
  const located = locateSections(html, finds);
  const groups = new Map<number, typeof located>();
  for (const section of located) {
    const key = parentKeyOf(html, section);
    const group = groups.get(key);
    if (group) group.push(section);
    else groups.set(key, [section]);
  }

  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const slots of groups.values()) {
    if (slots.length < 2) continue;
    const sorted = slots
      .map((section, nativeIndex) => ({ section, key: sectionSortKey(section.ref, order, nativeIndex) }))
      .sort((a, b) => a.key - b.key)
      .map((entry) => entry.section);
    if (sorted.every((section, index) => section === slots[index])) continue;
    slots.forEach((slot, index) => {
      const mover = sorted[index];
      edits.push({ start: slot.start, end: slot.end, text: html.slice(mover.start, mover.end) });
    });
  }

  const found = new Set(located.map((section) => section.ref));
  for (const ref of order) {
    if (found.has(ref) || ref.startsWith('custom:') || !templateNamesField(html, ref)) continue;
    const key = `${templateId}|${ref}`;
    if (warnedUnmovable.has(key)) continue;
    warnedUnmovable.add(key);
    console.warn(
      `[templates] Template "${templateId}" has a ${ref} section the profile's order cannot move: it is ` +
        'marked neither with a section-' +
        ref +
        ' class nor with data-section, and could not be found from its heading, so it prints where the ' +
        'template puts it.'
    );
  }

  if (edits.length === 0) return html;
  let output = html;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    output = `${output.slice(0, edit.start)}${edit.text}${output.slice(edit.end)}`;
  }
  if (parsesAsHandlebars(output) || !parsesAsHandlebars(html)) return output;
  if (!warnedUnorderable.has(templateId)) {
    warnedUnorderable.add(templateId);
    console.warn(
      `[templates] Template "${templateId}" cannot be drawn in the profile's section order: a Handlebars ` +
        'block opens inside one of its sections and closes outside it, so its sections print in the ' +
        "template's own order. Move the block wholly inside or outside the section."
    );
  }
  return html;
}

/**
 * Makes an element that holds only a description disappear when there is no
 * description.
 *
 * Tailored roles print none - the tailoring prompt tells the model the role
 * description "is discarded before the resume is printed", and the render
 * blanks it - but every built-in draws one in a wrapper of its own: seventeen
 * as `<div class="experience-desc">{{#if description}}{{description}}{{/if}}</div>`,
 * guarding the TEXT and keeping the element, and `default` and `azure-stack`
 * as `<div class="description">{{description}}</div>`, not guarded at all.
 * Most of those wrappers carry a margin, so each role opened with a visible
 * gap above its bullets.
 *
 * Applied to the markup rather than to the nineteen files, so uploaded,
 * extracted and manual templates get it too; the stored file is never
 * rewritten. It decides from the markup alone, so the compile cache needs no
 * new key. Idempotent: the lookbehind leaves an element somebody already
 * guarded - the strength descriptions in default and azure-stack - alone,
 * rather than nesting a second `{{#if}}` around it.
 *
 * The inner guard is taken WHOLE or not at all. A Handlebars block need not
 * follow the HTML - `<p>{{#if description}}{{description}}</p>{{/if}}` is valid
 * Handlebars - and taking its opening half without its closing one left a
 * stray `{{/if}}` that failed every render of the template, tailored or not
 * (the section fallbacks in `compilableMarkup` cannot help: every one of them
 * runs this guard too). Such an element is left as it is written. A cut can
 * still go wrong through a block opened inside the element's own tag, so a
 * result that stops parsing markup that parsed is dropped for the markup as it
 * was: an empty box is a blemish, a template that will not compile is every
 * resume on it failing.
 */
function guardEmptyDescriptions(html: string): string {
  const guarded = html.replace(
    /(?<!\{\{#if description\}\}\s*)(<(\w+)\b[^>]*>)\s*(?:\{\{#if description\}\}\s*\{\{description\}\}\s*\{\{\/if\}\}|\{\{description\}\})\s*(<\/\2>)/g,
    '{{#if description}}$1{{description}}$3{{/if}}'
  );
  if (guarded === html || parsesAsHandlebars(guarded) || !parsesAsHandlebars(html)) return guarded;
  return html;
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

/**
 * The most bullets a tailored role prints. The tailoring prompt promises
 * "anything past the eighth bullet is DISCARDED before the resume is
 * printed"; the parse keeps the eight carrying the most checklist terms, and
 * this is the backstop for content that reaches a render without it - a
 * preview with no analysis, a held preview whose re-parse failed.
 */
const MAX_TAILORED_BULLETS = 8;

/**
 * Tailored roles as they print: no description (the prompt tells the model
 * it is discarded, so whatever an older build or a JSON edit left there is
 * not shown) and at most `MAX_TAILORED_BULLETS` bullets, strings only.
 */
function tailoredRoles(experience: unknown): TailoredContent['experience'] {
  if (!Array.isArray(experience)) return [];
  return experience
    .filter((role): role is TailoredContent['experience'][number] => Boolean(role) && typeof role === 'object')
    .map((role) => ({
      ...role,
      description: '',
      achievements: (Array.isArray(role.achievements) ? role.achievements : [])
        .filter((bullet): bullet is string => typeof bullet === 'string' && bullet.trim() !== '')
        .slice(0, MAX_TAILORED_BULLETS),
    }));
}

export function prepareResumeRenderData(
  profile: Profile,
  tailoredContent?: TailoredContent,
  companyName?: string,
  role?: string
) {
  const linkedinHref = normalizeExternalUrl(profile.contact?.linkedin);
  const linkedinDisplay = getExternalUrlDisplay(profile.contact?.linkedin);
  const tailoredTitle = typeof tailoredContent?.title === 'string' ? tailoredContent.title.trim() : '';
  const tailoredSoftSkills = normalizeSkills(tailoredContent?.softSkills);
  const data = {
    ...profile,
    // The sections beyond the classic six, prepared (dates joined, links
    // policed like every other href here) under the profile fields' own
    // names, so a template that loops over `certifications` itself keeps
    // working and the generated blocks read the same lists. Tailored or not:
    // these sections always print from the profile, like education.
    ...prepareExtraSectionData(profile, { href: normalizeExternalUrl, display: getExternalUrlDisplay }),
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
    // Tailored, the title exactly as tailoring composed it; else the
    // profile's own headline.
    title: sanitizeTitleForATS(tailoredTitle || getResumeTitle(profile)),
    // The profile's own lists. Strengths stay the profile's own on every
    // render, tailored or not: the tailoring prompt writes none, and one an
    // older build or a JSON edit put in the content is not printed. Whether
    // either section is shown at all is the profile's switch, decided in
    // `applySkillsLimit`.
    softSkills: profile.softSkills ?? [],
    strengths: profile.strengths ?? [],
    ...(tailoredContent && {
      summary: tailoredContent.summary,
      experience: tailoredRoles(tailoredContent.experience),
      // The printed block when it has any group; see `applySkillsLimit`.
      skillGroups: tailoredContent.skillGroups,
      softSkillGroupHeading: tailoredContent.softSkillGroupHeading,
      // Content from before the model wrote the block carries only the flat
      // list, under either name.
      hardSkills: tailoredContent.hardSkills?.length ? tailoredContent.hardSkills : (tailoredContent.skills ?? []),
      // Used only when no soft-skill group is routed: the content's own list
      // when it has anything in it, else the profile's. Content can predate
      // the switch being turned on - a held preview, a queued task - and then
      // carries nothing for the section; the person's own entries beat an
      // empty section they asked for.
      softSkills: tailoredSoftSkills.length > 0 ? tailoredSoftSkills : (profile.softSkills ?? []),
    }),
  };
  return normalizeExperienceDescriptions(applySkillsLimit(data));
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
// Raised from 64 when the key gained the section order and the custom keys:
// one delegate per profile that arranged its sections, per template.
const COMPILED_TEMPLATE_CACHE_SIZE = 128;

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
 * be caught before a render; it runs only on a compile-cache miss. (The
 * description guard makes the same check of its own cut, since every rung
 * here runs it.)
 */
function compilableMarkup(template: Template, choices: ResumeSectionChoices): string {
  const markup = normalizeTemplateSkillsSections(template.htmlContent, choices, 'all', template.id);
  if (parsesAsHandlebars(markup) || !parsesAsHandlebars(template.htmlContent)) return markup;

  const marked = normalizeTemplateSkillsSections(template.htmlContent, choices, 'marked', template.id);
  const finds: SectionFinds = parsesAsHandlebars(marked) ? 'marked' : 'none';
  const key = `${template.id}|${finds}`;
  if (!warnedSectionFallbacks.has(key)) {
    warnedSectionFallbacks.add(key);
    console.warn(
      finds === 'marked'
        ? `[templates] Template "${template.id}" does not compile with its sections found from their lists, ` +
            'so only a section marked with its class or data-section is removed, guarded or moved into ' +
            "the profile's order; a switched-off section's heading may still print. Put section-<kind> " +
            '(section-strengths, section-soft-skills, section-experience, ...) on the element that holds ' +
            'the heading and the list.'
        : `[templates] Template "${template.id}" does not compile with its Strengths / Soft Skills section ` +
            'removed or its sections moved, so it is drawn with both sections in place and in its own ' +
            "section order: a switched-off list prints empty, its heading may still print, and the profile's " +
            'section order is not applied. A Handlebars block ({{#if}}, {{#each}}) probably opens inside ' +
            "a section's element and closes outside it; move it wholly inside or outside."
    );
  }
  return finds === 'marked' ? marked : normalizeTemplateSkillsSections(template.htmlContent, choices, 'none', template.id);
}

function compileTemplate(template: Template, choices: ResumeSectionChoices): HandlebarsTemplateDelegate {
  if (typeof template.htmlContent !== 'string' || !template.htmlContent.trim()) {
    throw new Error(`Template "${template.name || template.id}" is missing htmlContent`);
  }

  // The order and the custom keys are in the key: the markup compiled differs
  // with each (the blocks generated, the slots refilled), and two profiles'
  // orders must never share a delegate.
  const key =
    `${choices.layout}|${choices.softSkills ? 1 : 0}|${choices.strengths ? 1 : 0}|` +
    `${(choices.sectionOrder ?? []).join(',')}|${(choices.customKeys ?? []).join(',')}|${template.htmlContent}`;
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
  // The section order travels with the switches: the data carries the stored
  // order and the custom sections (spread from the profile), and the compile
  // step moves the markup to match - decided from one place, like the switches.
  const compiledTemplate = compileTemplate(template, {
    ...getProfileResumeSections(renderData),
    ...getProfileSectionLayout(renderData),
  });
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
 * A template rendered with the sample resume, for the gallery: the sample
 * person (`SAMPLE_PROFILE`) TAILORED (`SAMPLE_TAILORED_CONTENT`, both in
 * services/sampleProfile.ts), through the same tailored branch a generated
 * resume takes - a model's skill groups, no role descriptions, a composed
 * title - so the gallery shows what a generated resume looks like rather
 * than a block no generation prints.
 *
 * With no choices: Grouped, no Soft Skills or Strengths section, so the
 * sample's soft-skill group is the block's last heading. A caller may ask for
 * the flat layout or either section, so a template can be shown the way a
 * particular profile would get it; read through `profileForTemplate`, as
 * every generation is, so a switch the template has no section for keeps the
 * soft-skill group in the block.
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
  const renderData = prepareResumeRenderData(profileForTemplate(sample, template), SAMPLE_TAILORED_CONTENT);
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
 * One difference from generation, and a deliberate one: the document carries a
 * Content-Security-Policy, because it contains whatever is in the editor at
 * that moment. Its skills are the profile's own, unpadded - as every
 * untailored render's are (see `applySkillsLimit`).
 */
export function generateProfilePreviewHTML(profile: Profile, template: Template): ProfilePreview {
  const renderData = prepareResumeRenderData(profileForTemplate(profile, template));
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
