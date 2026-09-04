import fs from 'fs';
import { getStaticSkillsFile } from '../config/staticPaths';
import { getDb } from './sqlite';

export type SkillType = 'hard' | 'soft';
export type HardSkillCategory =
  | 'Languages'
  | 'Frameworks and Libraries'
  | 'Software Architecture & Design'
  | 'Security'
  | 'Cloud and Infrastructure'
  | 'Databases and Storage'
  | 'DevOps and CI/CD'
  | 'Observability and Monitoring'
  | 'Testing and Quality'
  | 'APIs and Integration'
  | 'Engineering Practices & Methodology'
  | 'Data Engineering & Streaming'
  | 'AI/ML & Data Science'
  | 'Version Control & Collaboration'
  | 'Operating Systems & Platforms'
  | 'Frontend & UI/UX Development'
  | 'Mobile Development';

export const HARD_SKILL_CATEGORIES: HardSkillCategory[] = [
  'Languages',
  'Frameworks and Libraries',
  'Software Architecture & Design',
  'Security',
  'Cloud and Infrastructure',
  'Databases and Storage',
  'DevOps and CI/CD',
  'Observability and Monitoring',
  'Testing and Quality',
  'APIs and Integration',
  'Engineering Practices & Methodology',
  'Data Engineering & Streaming',
  'AI/ML & Data Science',
  'Version Control & Collaboration',
  'Operating Systems & Platforms',
  'Frontend & UI/UX Development',
  'Mobile Development',
];

export type SkillMutationResult = {
  skill: string;
  type: SkillType;
};

export type HardSkillRecord = {
  skill: string;
  priority: number;
  category: HardSkillCategory;
};

export type AddSkillResult = SkillMutationResult & {
  added: boolean;
};

export type UpdateSkillResult = SkillMutationResult & {
  updated: boolean;
};

export type DeleteSkillResult = SkillMutationResult & {
  deleted: boolean;
};

type SkillsStore = {
  hard: HardSkillRecord[];
  soft: string[];
};

type HardSkillMetadata = {
  priority?: number;
  category?: HardSkillCategory;
};

export class SkillDatabaseError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
    this.name = 'SkillDatabaseError';
  }
}


function cleanSkill(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeSkillValue(value: string): string {
  return value.trim().toLowerCase();
}

function inferHardSkillPriority(skill: string): number {
  const normalized = normalizeSkillValue(skill);

  const languagePatterns = [
    'python', 'javascript', 'typescript', 'java', 'golang', 'go', 'rust', 'ruby', 'php', 'c#', 'c++', 'kotlin',
    'swift', 'scala', 'sql', 'bash', 'elixir', 'dart', 'perl', 'r language', 'matlab', 'lua', 'groovy', 'shell',
    'powershell', 'objective-c', 'html', 'css',
  ];
  if (languagePatterns.some((pattern) => normalized === pattern || normalized.startsWith(`${pattern} `))) {
    return 1;
  }

  const frameworkPatterns = [
    'react', 'next', 'vue', 'angular', 'django', 'flask', 'fastapi', 'spring', 'nestjs', 'express', 'laravel',
    'symfony', 'rails', 'redux', 'tailwind', 'bootstrap', 'material ui', 'mui', 'chakra', 'styled-components',
    'emotion', 'jquery', 'sass', 'scss', 'webpack', 'vite', 'babel', 'eslint', 'prettier', 'numpy', 'pandas',
    'pytorch', 'tensorflow', 'keras', 'scikit', 'langchain', 'llamaindex', 'playwright', 'cypress', 'jest',
    'pytest', 'selenium', 'mocha', 'chai', 'junit', 'testng',
  ];
  if (frameworkPatterns.some((pattern) => normalized.includes(pattern))) {
    return 2;
  }

  const databasePatterns = [
    'postgres', 'postgresql', 'mysql', 'sql server', 'oracle', 'mongodb', 'dynamodb', 'cassandra', 'couchdb',
    'redis', 'memcached', 'firestore', 'elasticsearch', 'solr', 'influxdb', 'timescaledb', 'neo4j', 'database',
    'databases', 'query', 'index', 'shard', 'replication', 'schema', 'orm', 'sqlalchemy', 'prisma', 'typeorm',
    'sequelize', 'mongoose', 'activerecord', 'etl', 'warehouse', 'data lake',
  ];
  if (databasePatterns.some((pattern) => normalized.includes(pattern))) {
    return 3;
  }

  const cloudPatterns = [
    'aws', 'azure', 'gcp', 'google cloud', 'cloud', 'docker', 'kubernetes', 'helm', 'terraform', 'ansible',
    'puppet', 'chef', 'openshift', 'ec2', 'ecs', 'eks', 'fargate', 's3', 'rds', 'cloudfront', 'lambda', 'vpc',
    'iam', 'route 53', 'api gateway', 'cloudwatch', 'grafana', 'prometheus', 'datadog', 'new relic', 'elk',
    'istio', 'linkerd', 'argocd', 'flux', 'ci/cd', 'deployment', 'infrastructure', 'iac', 'network', 'load balanc',
    'autoscaling', 'auto scaling',
  ];
  if (cloudPatterns.some((pattern) => normalized.includes(pattern))) {
    return 4;
  }

  return 5;
}

export function isHardSkillCategory(value: unknown): value is HardSkillCategory {
  return typeof value === 'string' && (HARD_SKILL_CATEGORIES as string[]).includes(value);
}

export function inferHardSkillCategory(skill: string): HardSkillCategory {
  const normalized = normalizeSkillValue(skill);
  const exactCategories = new Map<string, HardSkillCategory>([
    ['abap', 'Languages'],
    ['actionscript', 'Languages'],
    ['ada', 'Languages'],
    ['bash', 'Languages'],
    ['c', 'Languages'],
    ['c#', 'Languages'],
    ['c++', 'Languages'],
    ['css', 'Languages'],
    ['dart', 'Languages'],
    ['elixir', 'Languages'],
    ['go', 'Languages'],
    ['golang', 'Languages'],
    ['groovy', 'Languages'],
    ['html', 'Languages'],
    ['java', 'Languages'],
    ['javascript', 'Languages'],
    ['kotlin', 'Languages'],
    ['lua', 'Languages'],
    ['matlab', 'Languages'],
    ['objective-c', 'Languages'],
    ['perl', 'Languages'],
    ['php', 'Languages'],
    ['pl/sql', 'Languages'],
    ['powershell', 'Languages'],
    ['python', 'Languages'],
    ['r', 'Languages'],
    ['r language', 'Languages'],
    ['ruby', 'Languages'],
    ['rust', 'Languages'],
    ['scala', 'Languages'],
    ['shell', 'Languages'],
    ['shell scripting', 'Languages'],
    ['sql', 'Languages'],
    ['swift', 'Languages'],
    ['t-sql', 'Languages'],
    ['typescript', 'Languages'],
    ['vb.net', 'Languages'],
    ['jquery', 'Frameworks and Libraries'],
    ['tanstack query', 'Frameworks and Libraries'],
    ['react hook form', 'Frameworks and Libraries'],
    ['formik', 'Frameworks and Libraries'],
    ['spring webflux', 'Frameworks and Libraries'],
    ['fastapi', 'Frameworks and Libraries'],
    ['django rest framework', 'Frameworks and Libraries'],
    ['langchain', 'AI/ML & Data Science'],
    ['llamaindex', 'AI/ML & Data Science'],
    ['hugging face transformers', 'AI/ML & Data Science'],
    ['sentence transformers', 'AI/ML & Data Science'],
    ['nosql', 'Databases and Storage'],
    ['databricks sql', 'Databases and Storage'],
    ['sqlite', 'Databases and Storage'],
    ['presto', 'Databases and Storage'],
    ['s3', 'Databases and Storage'],
    ['query optimization', 'Databases and Storage'],
    ['query planning', 'Databases and Storage'],
    ['query tuning', 'Databases and Storage'],
    ['amazon kinesis', 'Data Engineering & Streaming'],
    ['data formats (json/xml)', 'APIs and Integration'],
    ['cloudtrail', 'Observability and Monitoring'],
    ['minitest', 'Testing and Quality'],
    ['unittest', 'Testing and Quality'],
    ['testflight', 'Testing and Quality'],
  ]);
  const exactCategory = exactCategories.get(normalized);
  if (exactCategory) {
    return exactCategory;
  }

  const aiMlPatterns = [
    'ai/ml', 'machine learning', 'deep learning', 'mlops', 'llm', 'nlp', 'natural language', 'computer vision',
    'rag', 'prompt engineering', 'fine-tuning', 'openai', 'chatgpt', 'claude', 'tensorflow', 'pytorch', 'keras',
    'scikit', 'xgboost', 'lightgbm', 'spacy', 'nltk', 'pandas', 'numpy', 'jupyter', 'model monitoring',
    'model training', 'feature engineering', 'vector', 'embedding', 'pinecone', 'chroma', 'weaviate',
  ];
  if (aiMlPatterns.some((pattern) => normalized.includes(pattern))) {
    return 'AI/ML & Data Science';
  }

  const testingPatterns = [
    'jest', 'pytest', 'cypress', 'playwright', 'selenium', 'mocha', 'chai', 'junit', 'testng', 'vitest',
    'testing', 'test automation', 'unit test', 'integration test', 'e2e', 'quality', 'qa', 'sonarqube',
    'coverage', 'load testing', 'performance testing', 'sql injection',
  ];
  if (testingPatterns.some((pattern) => normalized.includes(pattern))) {
    return 'Testing and Quality';
  }

  const securityPatterns = [
    'security', 'secure', 'auth', 'authorization', 'authentication', 'oauth', 'oidc', 'saml', 'jwt',
    'encryption', 'waf', 'iam', 'kms', 'secrets', 'vulnerability', 'penetration', 'sast', 'dast',
    'abac', 'rbac', 'access control', 'access reviews', 'sql injection', 'xss', 'csrf', 'threat',
  ];
  if (securityPatterns.some((pattern) => normalized.includes(pattern))) {
    return 'Security';
  }

  const observabilityPatterns = [
    'observability', 'monitoring', 'logging', 'metrics', 'tracing', 'grafana', 'prometheus', 'datadog',
    'new relic', 'cloudwatch', 'splunk', 'elk', 'opentelemetry', 'pagerduty', 'sentry', 'x-ray',
  ];
  if (observabilityPatterns.some((pattern) => normalized.includes(pattern))) {
    return 'Observability and Monitoring';
  }

  const dataEngineeringPatterns = [
    'kafka', 'kinesis', 'pub/sub', 'rabbitmq', 'stream', 'streaming', 'eventbridge', 'event hubs', 'event grid',
    'sqs', 'sns', 'airflow', 'dbt', 'etl', 'data pipeline', 'data lake', 'data warehouse', 'lake formation',
    'athena', 'glue', 'data factory', 'synapse', 'snowflake', 'bigquery',
  ];
  if (dataEngineeringPatterns.some((pattern) => normalized.includes(pattern))) {
    return 'Data Engineering & Streaming';
  }

  const databasePatterns = [
    'postgres', 'postgresql', 'mysql', 'sql server', 'oracle', 'mongodb', 'dynamodb', 'cassandra', 'couchdb',
    'redis', 'memcached', 'firestore', 'elasticsearch', 'solr', 'influxdb', 'timescaledb', 'neo4j', 'database',
    'databases', 'shard', 'replication', 'schema', 'orm', 'sqlalchemy', 'prisma', 'typeorm',
    'sequelize', 'mongoose', 'activerecord', 'etl', 'warehouse', 'data lake', 'storage', 's3', 'blob storage',
    'bigquery', 'snowflake', 'cloud sql', 'cloud spanner', 'athena', 'glue', 'synapse', 'data factory',
    'aurora', 'elasticache', 'presto',
  ];
  if (databasePatterns.some((pattern) => normalized.includes(pattern))) {
    return 'Databases and Storage';
  }

  const versionControlPatterns = [
    'git', 'github', 'gitlab', 'bitbucket', 'pull request', 'code review', 'branch', 'merge', 'version control',
  ];
  if (versionControlPatterns.some((pattern) => normalized.includes(pattern))) {
    return 'Version Control & Collaboration';
  }

  const devopsPatterns = [
    'ci/cd', 'cicd', 'deployment', 'pipeline', 'github actions', 'gitlab ci', 'jenkins', 'circleci',
    'travis ci', 'argocd', 'flux', 'terraform', 'cloudformation', 'ansible', 'puppet', 'chef', 'iac',
    'devops', 'gitops', 'docker', 'kubernetes', 'helm', 'openshift',
  ];
  if (devopsPatterns.some((pattern) => normalized.includes(pattern))) {
    return 'DevOps and CI/CD';
  }

  const apiPatterns = [
    'api', 'rest', 'graphql', 'grpc', 'websocket', 'webhook', 'oauth', 'oidc', 'saml', 'jwt', 'openapi',
    'swagger', 'integration', 'message queue', 'kafka', 'rabbitmq', 'pub/sub', 'eventbridge', 'sqs', 'sns',
    'service bus', 'kinesis',
  ];
  if (apiPatterns.some((pattern) => normalized.includes(pattern))) {
    return 'APIs and Integration';
  }

  const mobilePatterns = [
    'ios', 'android', 'react native', 'swiftui', 'flutter', 'mobile', 'kotlin multiplatform', 'app store',
    'google play', 'testflight',
  ];
  if (mobilePatterns.some((pattern) => normalized.includes(pattern))) {
    return 'Mobile Development';
  }

  const frontendPatterns = [
    'react', 'vue', 'angular', 'next', 'nuxt', 'svelte', 'frontend', 'front-end', 'ui', 'ux', 'css grid',
    'css modules', 'tailwind', 'sass', 'scss', 'bootstrap', 'material ui', 'chakra', 'figma', 'responsive',
    'web animations', 'canvas api', 'intersection observer', 'resize observer',
  ];
  if (frontendPatterns.some((pattern) => normalized.includes(pattern))) {
    return 'Frontend & UI/UX Development';
  }

  const cloudPatterns = [
    'aws', 'azure', 'gcp', 'google cloud', 'cloud', 'ec2', 'ecs', 'eks', 'fargate', 'rds', 'cloudfront',
    'lambda', 'vpc', 'iam', 'route 53', 'load balanc', 'autoscaling', 'auto scaling', 'serverless',
    'netlify', 'vercel',
  ];
  if (cloudPatterns.some((pattern) => normalized.includes(pattern))) {
    return 'Cloud and Infrastructure';
  }

  const osPlatformPatterns = [
    'linux', 'unix', 'windows', 'macos', 'android platform', 'ios platform', 'nginx', 'apache', 'operating system',
    'filesystem', 'file system', 'network',
  ];
  if (osPlatformPatterns.some((pattern) => normalized.includes(pattern))) {
    return 'Operating Systems & Platforms';
  }

  const architecturePatterns = [
    'architecture', 'microservice', 'serverless', 'distributed', 'event-driven', 'domain-driven', 'ddd',
    'cqrs', 'saga', 'solid', 'design pattern', 'clean architecture', 'hexagonal', 'monorepo',
    'multi-tenant', 'scalability', 'performance optimization', 'caching',
  ];
  if (architecturePatterns.some((pattern) => normalized.includes(pattern))) {
    return 'Software Architecture & Design';
  }

  const methodologyPatterns = [
    'agile', 'scrum', 'kanban', 'tdd', 'bdd', 'pair programming', 'technical documentation', 'adr',
    'requirements', 'root cause', 'incident response', 'on-call', 'sprint', 'retrospective',
  ];
  if (methodologyPatterns.some((pattern) => normalized.includes(pattern))) {
    return 'Engineering Practices & Methodology';
  }

  return 'Frameworks and Libraries';
}

function normalizeHardSkillList(input: unknown): HardSkillRecord[] {
  const source = Array.isArray(input) ? input : [];
  const seen = new Set<string>();
  const skills: HardSkillRecord[] = [];

  for (const item of source) {
    const skill = typeof item === 'string'
      ? cleanSkill(item)
      : cleanSkill(typeof item === 'object' && item !== null ? (item as { skill?: unknown }).skill : '');
    if (!skill) continue;

    const key = normalizeSkillValue(skill);
    if (seen.has(key)) continue;
    seen.add(key);

    const parsedPriority = typeof item === 'object' && item !== null
      ? (item as { priority?: unknown }).priority
      : undefined;
    const priority = typeof parsedPriority === 'number' && Number.isFinite(parsedPriority)
      ? parsedPriority
      : inferHardSkillPriority(skill);

    const parsedCategory = typeof item === 'object' && item !== null
      ? (item as { category?: unknown }).category
      : undefined;

    skills.push({
      skill,
      priority: Math.max(1, Math.min(5, Math.trunc(priority))),
      category: isHardSkillCategory(parsedCategory) ? parsedCategory : inferHardSkillCategory(skill),
    });
  }

  return skills.sort((left, right) => {
    if (left.priority !== right.priority) {
      return left.priority - right.priority;
    }

    return left.skill.localeCompare(right.skill, undefined, { sensitivity: 'base' });
  });
}

function normalizeSoftSkillList(input: unknown): string[] {
  const source = Array.isArray(input) ? input : [];
  const seen = new Set<string>();
  const skills: string[] = [];

  for (const item of source) {
    const skill = cleanSkill(item);
    if (!skill) continue;

    const key = normalizeSkillValue(skill);
    if (seen.has(key)) continue;

    seen.add(key);
    skills.push(skill);
  }

  return skills.sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }));
}

function normalizeStore(input: unknown): SkillsStore {
  const source = typeof input === 'object' && input !== null
    ? input as Partial<Record<SkillType, unknown>>
    : {};

  return {
    hard: normalizeHardSkillList(source.hard),
    soft: normalizeSoftSkillList(source.soft),
  };
}

type SkillRow = {
  type: SkillType;
  skill: string;
  priority: number | null;
  category: string | null;
};

/** Reads the shipped skill library used to seed an empty database. */
function readSeedStore(): SkillsStore {
  try {
    const parsed = JSON.parse(fs.readFileSync(getStaticSkillsFile(), 'utf8')) as unknown;
    return normalizeStore(parsed);
  } catch {
    return { hard: [], soft: [] };
  }
}

function countSkillRows(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS count FROM skills').get() as { count: number };
  return row.count;
}

function writeStore(store: SkillsStore): void {
  const normalized = normalizeStore(store);
  const db = getDb();
  const insert = db.prepare(
    'INSERT INTO skills (type, skill_key, skill, priority, category) VALUES (@type, @skill_key, @skill, @priority, @category)'
  );

  db.transaction(() => {
    db.prepare('DELETE FROM skills').run();
    for (const record of normalized.hard) {
      insert.run({
        type: 'hard',
        skill_key: normalizeSkillValue(record.skill),
        skill: record.skill,
        priority: record.priority,
        category: record.category,
      });
    }
    for (const skill of normalized.soft) {
      insert.run({ type: 'soft', skill_key: normalizeSkillValue(skill), skill, priority: null, category: null });
    }
  })();
}

/** Seeds the skills table from the static skill library when it is still empty. */
function ensureSeeded(): void {
  if (countSkillRows() === 0) {
    const seed = readSeedStore();
    if (seed.hard.length > 0 || seed.soft.length > 0) {
      writeStore(seed);
    }
  }
}

function readStore(): SkillsStore {
  ensureSeeded();

  const rows = getDb().prepare('SELECT type, skill, priority, category FROM skills').all() as SkillRow[];
  return normalizeStore({
    hard: rows.filter((row) => row.type === 'hard'),
    soft: rows.filter((row) => row.type === 'soft').map((row) => row.skill),
  });
}

function findSoftSkillIndex(skills: string[], skill: string): number {
  const normalized = normalizeSkillValue(skill);
  return skills.findIndex((item) => normalizeSkillValue(item) === normalized);
}

function findHardSkillIndex(skills: HardSkillRecord[], skill: string): number {
  const normalized = normalizeSkillValue(skill);
  return skills.findIndex((item) => normalizeSkillValue(item.skill) === normalized);
}

export function ensureSkillsDatabase(): void {
  ensureSeeded();
}

export function isSkillType(value: unknown): value is SkillType {
  return value === 'hard' || value === 'soft';
}

export function readSkills(type: SkillType): string[] {
  const store = readStore();
  return type === 'hard'
    ? store.hard.map((item) => item.skill)
    : store.soft;
}

export function readHardSkillRecords(): HardSkillRecord[] {
  return readStore().hard.map((item) => ({ ...item }));
}

export function readHardSkillPriorityMap(): Map<string, number> {
  return new Map(
    readStore().hard.map((item) => [normalizeSkillValue(item.skill), item.priority] as const)
  );
}

export function readHardSkillCategoryMap(): Map<string, HardSkillCategory> {
  return new Map(
    readStore().hard.map((item) => [normalizeSkillValue(item.skill), item.category] as const)
  );
}

export function addSkill(type: SkillType, skill: string, metadata: HardSkillMetadata = {}): AddSkillResult {
  const cleaned = cleanSkill(skill);
  if (!cleaned) {
    throw new SkillDatabaseError('Skill type and value are required', 400);
  }

  const store = readStore();
  const existingIndex = type === 'hard'
    ? findHardSkillIndex(store.hard, cleaned)
    : findSoftSkillIndex(store.soft, cleaned);
  if (existingIndex !== -1) {
    return { added: false, skill: cleaned, type };
  }

  if (type === 'hard') {
    store.hard.push({
      skill: cleaned,
      priority: metadata.priority ?? inferHardSkillPriority(cleaned),
      category: metadata.category ?? inferHardSkillCategory(cleaned),
    });
  } else {
    store.soft.push(cleaned);
  }
  writeStore(store);

  return { added: true, skill: cleaned, type };
}

export function updateSkill(
  type: SkillType,
  original: string,
  skill: string,
  metadata: HardSkillMetadata = {}
): UpdateSkillResult {
  const cleanedOriginal = cleanSkill(original);
  const cleaned = cleanSkill(skill);
  if (!cleanedOriginal || !cleaned) {
    throw new SkillDatabaseError('Skill type, original value, and new value are required', 400);
  }

  const store = readStore();
  const originalIndex = type === 'hard'
    ? findHardSkillIndex(store.hard, cleanedOriginal)
    : findSoftSkillIndex(store.soft, cleanedOriginal);
  if (originalIndex === -1) {
    throw new SkillDatabaseError('Skill not found', 404);
  }

  const duplicateIndex = type === 'hard'
    ? findHardSkillIndex(store.hard, cleaned)
    : findSoftSkillIndex(store.soft, cleaned);
  if (duplicateIndex !== -1 && duplicateIndex !== originalIndex) {
    throw new SkillDatabaseError('Skill already exists', 409);
  }

  if (type === 'hard') {
    const existing = store.hard[originalIndex];
    store.hard[originalIndex] = {
      skill: cleaned,
      priority: metadata.priority ?? existing.priority,
      category: metadata.category ?? existing.category,
    };
  } else {
    store.soft[originalIndex] = cleaned;
  }
  writeStore(store);

  return { updated: true, skill: cleaned, type };
}

export function deleteSkill(type: SkillType, skill: string): DeleteSkillResult {
  const cleaned = cleanSkill(skill);
  if (!cleaned) {
    throw new SkillDatabaseError('Skill type and value are required', 400);
  }

  const store = readStore();
  const index = type === 'hard'
    ? findHardSkillIndex(store.hard, cleaned)
    : findSoftSkillIndex(store.soft, cleaned);
  if (index === -1) {
    throw new SkillDatabaseError('Skill not found', 404);
  }

  if (type === 'hard') {
    store.hard.splice(index, 1);
  } else {
    store.soft.splice(index, 1);
  }
  writeStore(store);

  return { deleted: true, skill: cleaned, type };
}
