import { Profile } from '../types/profile';
import type { AIProvider, JobAnalysis, RawNestedJobAnalysis, TailoredContent } from '../types/template';
import { createPromptCompletion, DEFAULT_PROVIDER } from './ai';
import {
  HARD_SKILL_CATEGORIES,
  HardSkillCategory as LibraryHardSkillCategory,
  readHardSkillPriorityMap,
  readHardSkillRecords,
  readSkills,
} from '../database/skillsDatabase';
import { moveCaseInsensitiveMatches, uniqueCaseInsensitive } from '../utils/array';
import { extractJSON } from '../utils/json';
import { removeDuplicateSubstrings, ensureMinTechSkills } from './utils/resumeBuilder';
import { supplimentSoftSkills } from './utils/config';
import {
  DEFAULT_ANALYZE_JOB_PROMPT_ID,
  DEFAULT_COVER_LETTER_PROMPT_ID,
  DEFAULT_RESUME_PROMPT_ID,
  getProfileHardSkillOrdering,
} from './profileService';

/**
 * Resume and cover-letter domain logic.
 *
 * Everything about HOW a model is reached now lives in `services/ai`; this
 * module only decides what to ask, and how to read the answer. The `.env` load
 * that used to sit here (with `override: true`, quietly beating the process
 * environment for every importer) belongs to the entry point and lives in
 * index.ts.
 */

const technicalSkills = readSkills('hard');
const softSkills = readSkills('soft');
let hardSkillPriorityMap = readHardSkillPriorityMap();
let hardSkillRecords = readHardSkillRecords();
const resumeBuildTiming = new WeakMap<JobAnalysis, { firstCallEndedAt: bigint }>();

function formatDuration(start: bigint, end: bigint): string {
  return `${(Number(end - start) / 1_000_000_000).toFixed(2)}s`;
}

export function refreshSkillCaches(): void {
  const nextTech = readSkills('hard');
  const nextSoft = readSkills('soft');
  const nextHardSkillPriorityMap = readHardSkillPriorityMap();
  const nextHardSkillRecords = readHardSkillRecords();

  technicalSkills.length = 0;
  technicalSkills.push(...nextTech);

  softSkills.length = 0;
  softSkills.push(...nextSoft);

  hardSkillPriorityMap = nextHardSkillPriorityMap;
  hardSkillRecords = nextHardSkillRecords;
}

// Lazy initialization to ensure env vars are loaded first

function extractTechSkills(text: string): string[] {
  return technicalSkills.filter((item: string) => {
    const escaped = item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const regex =
      item === "Go"
        ? new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`) // case-sensitive
        : new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, "i"); // case-insensitive

    return regex.test(text);
  });
}

function extractSoftSkills(text: string): string[] {
  return softSkills.filter((item: string) => {
    const escaped = item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, "i");
    return regex.test(text);
  });
}

type SkillReconciliationOptions = {
  extractedSkills: string[];
  modelSkills: string[];
  referenceSkills: string[];
  supplementSkills: string[];
  minimumCount: number;
  finalizeSkills?: (skills: string[]) => string[];
};

type SkillReconciliationResult = {
  confirmedSkills: string[];
  unconfirmedSkills: string[];
};

function getTailoringSourceText(jobAnalysis?: JobAnalysis): string {
  const directSource = jobAnalysis?.sourceJobDescription?.trim();
  if (directSource) {
    return directSource;
  }

  return [
    getJobAnalysisTitle(jobAnalysis),
    ...getTechnicalSkills(jobAnalysis),
    ...getRequiredSkills(jobAnalysis),
    ...getPreferredSkills(jobAnalysis),
    ...getSkillTools(jobAnalysis),
    ...getTechnologies(jobAnalysis),
    ...getProtocols(jobAnalysis),
    ...getMethodologies(jobAnalysis),
    ...getArchitecturePatterns(jobAnalysis),
    ...getKeywordChecklist(jobAnalysis),
    ...getResponsibilities(jobAnalysis),
    ...getDomainKnowledge(jobAnalysis),
    ...getSoftSkills(jobAnalysis),
  ]
    .filter((value) => value.trim().length > 0)
    .join('\n');
}

function reconcileSkillBuckets({
  extractedSkills,
  modelSkills,
  referenceSkills,
  supplementSkills,
  minimumCount,
  finalizeSkills,
}: SkillReconciliationOptions): SkillReconciliationResult {
  const confirmedSkills = [...extractedSkills];
  const unconfirmedSkills = [...modelSkills];

  moveCaseInsensitiveMatches(referenceSkills, unconfirmedSkills, confirmedSkills);

  const uniqueConfirmedSkills = uniqueCaseInsensitive(ensureMinTechSkills(
    removeDuplicateSubstrings(uniqueCaseInsensitive(confirmedSkills)),
    supplementSkills,
    minimumCount
  ));

  return {
    confirmedSkills: finalizeSkills ? finalizeSkills(uniqueConfirmedSkills) : uniqueConfirmedSkills,
    unconfirmedSkills: uniqueCaseInsensitive(unconfirmedSkills),
  };
}

function capitalizeFirstCharacter(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

const MAX_ROLE_BRIEF_LENGTH = 900;
const MIN_EXPERIENCE_SKILLS = 10;
const MAX_SOFT_SKILLS = 10;
const SOFT_SKILL_SIGNALS = [
  'accountability',
  'communication',
  'collaboration',
  'mindset',
  'mentality',
  'ownership',
  'reliability',
  'resilient',
  'supportive',
  'eager to learn',
  'adaptability',
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
const ATS_SOFT_SKILL_RULES: Array<{ canonical: string; patterns: string[] }> = [
  { canonical: 'Reliability', patterns: ['reliability', 'reliable'] },
  { canonical: 'Resilient', patterns: ['resilient', 'resilience'] },
  { canonical: 'Supportive', patterns: ['supportive', 'support'] },
  { canonical: 'Communication', patterns: ['communication', 'communicate'] },
  { canonical: 'Collaboration skills', patterns: ['collaboration', 'collaborative'] },
  { canonical: 'Cross-functional team', patterns: ['cross-functional', 'cross functional'] },
  { canonical: 'Strong problem-solving skills', patterns: ['problem-solving', 'problem solving'] },
  { canonical: 'Eager to learn', patterns: ['eager to learn', 'lifelong learning'] },
  { canonical: 'Accountability', patterns: ['accountability', 'accountable'] },
];
type HardSkillCategory =
  | 'backend'
  | 'frontend'
  | 'databases'
  | 'cloud-devops'
  | 'testing-automation'
  | 'ai-ml'
  | 'tools-methodologies'
  | 'other';
type HardSkillDefinition = {
  display: string;
  category: HardSkillCategory;
  aliases: string[];
  priority: number;
};

type HardSkillSeed = {
  display: string;
  aliases?: string[];
};

const HARD_SKILL_CATEGORY_SEEDS: Array<{
  category: Exclude<HardSkillCategory, 'other'>;
  skills: HardSkillSeed[];
}> = [
  {
    category: 'backend',
    skills: [
      { display: 'Python', aliases: ['python'] },
      { display: 'FastAPI', aliases: ['fastapi', 'fast api'] },
      { display: 'Django', aliases: ['django'] },
      { display: 'Django REST Framework', aliases: ['django rest framework', 'drf'] },
      { display: 'Flask', aliases: ['flask'] },
      { display: 'Pydantic', aliases: ['pydantic'] },
      { display: 'Node.js', aliases: ['node.js', 'nodejs', 'node'] },
      { display: 'Express.js', aliases: ['express.js', 'expressjs', 'express'] },
      { display: 'NestJS', aliases: ['nestjs', 'nest.js', 'nest'] },
      { display: 'Fastify', aliases: ['fastify'] },
      { display: 'Koa', aliases: ['koa'] },
      { display: 'Ruby on Rails', aliases: ['ruby on rails', 'rails'] },
      { display: 'Go', aliases: ['go', 'golang'] },
      { display: 'Gin', aliases: ['gin'] },
      { display: 'Echo', aliases: ['echo'] },
      { display: 'Java', aliases: ['java'] },
      { display: 'Spring Boot', aliases: ['spring boot', 'springboot'] },
      { display: 'Spring Framework', aliases: ['spring framework', 'spring'] },
      { display: 'C#', aliases: ['c#'] },
      { display: '.NET Core', aliases: ['.net core', 'dotnet core'] },
      { display: 'PHP', aliases: ['php'] },
      { display: 'Laravel', aliases: ['laravel'] },
      { display: 'Symfony', aliases: ['symfony'] },
      { display: 'Microservices Architecture', aliases: ['microservices architecture', 'microservices', 'microservice architecture'] },
      { display: 'Event-Driven Architecture', aliases: ['event-driven architecture', 'event driven architecture'] },
      { display: 'Domain-Driven Design (DDD)', aliases: ['domain-driven design', 'domain driven design', 'ddd'] },
      { display: 'gRPC', aliases: ['grpc'] },
      { display: 'WebSockets', aliases: ['websockets', 'websocket'] },
      { display: 'Server-Sent Events', aliases: ['server-sent events', 'server sent events', 'sse'] },
      { display: 'Celery', aliases: ['celery'] },
      { display: 'RabbitMQ', aliases: ['rabbitmq'] },
      { display: 'Apache Kafka', aliases: ['apache kafka', 'kafka'] },
      { display: 'RESTful APIs', aliases: ['restful apis', 'restful api', 'rest apis', 'rest api'] },
      { display: 'GraphQL', aliases: ['graphql'] },
      { display: 'Asynchronous Processing', aliases: ['asynchronous processing', 'async processing'] },
      { display: 'API Gateway Design', aliases: ['api gateway design', 'api gateway'] },
      { display: 'Serverless Functions', aliases: ['serverless functions', 'serverless function'] },
      { display: 'Background Jobs', aliases: ['background jobs', 'background job'] },
      { display: 'Message Queues', aliases: ['message queues', 'message queue'] },
    ],
  },
  {
    category: 'frontend',
    skills: [
      { display: 'React.js', aliases: ['react.js', 'reactjs', 'react'] },
      { display: 'React Hooks', aliases: ['react hooks', 'react hook'] },
      { display: 'Angular', aliases: ['angular'] },
      { display: 'Vue.js', aliases: ['vue.js', 'vuejs', 'vue'] },
      { display: 'Next.js', aliases: ['next.js', 'nextjs', 'next'] },
      { display: 'Nuxt.js', aliases: ['nuxt.js', 'nuxtjs', 'nuxt'] },
      { display: 'TypeScript', aliases: ['typescript', 'ts'] },
      { display: 'JavaScript', aliases: ['javascript', 'js', 'javascript (es6+)', 'es6+'] },
      { display: 'Redux', aliases: ['redux'] },
      { display: 'Redux Toolkit', aliases: ['redux toolkit'] },
      { display: 'Zustand', aliases: ['zustand'] },
      { display: 'MobX', aliases: ['mobx'] },
      { display: 'RxJS', aliases: ['rxjs'] },
      { display: 'HTML5', aliases: ['html5', 'html'] },
      { display: 'CSS3', aliases: ['css3', 'css'] },
      { display: 'SCSS', aliases: ['scss'] },
      { display: 'SASS', aliases: ['sass'] },
      { display: 'TailwindCSS', aliases: ['tailwindcss', 'tailwind css', 'tailwind'] },
      { display: 'Bootstrap', aliases: ['bootstrap'] },
      { display: 'Material UI (MUI)', aliases: ['material ui', 'material-ui', 'mui'] },
      { display: 'Ant Design', aliases: ['ant design', 'antd'] },
      { display: 'Chakra UI', aliases: ['chakra ui', 'chakra-ui'] },
      { display: 'Styled Components', aliases: ['styled components', 'styled-components'] },
      { display: 'Emotion', aliases: ['emotion'] },
      { display: 'Chart.js', aliases: ['chart.js', 'chartjs'] },
      { display: 'D3.js', aliases: ['d3.js', 'd3js', 'd3'] },
      { display: 'Three.js', aliases: ['three.js', 'threejs'] },
      { display: 'Responsive Design', aliases: ['responsive design'] },
      { display: 'Mobile-First Design', aliases: ['mobile-first design', 'mobile first design'] },
      { display: 'Progressive Web Apps (PWA)', aliases: ['progressive web apps', 'progressive web app', 'pwa'] },
      { display: 'Webpack', aliases: ['webpack'] },
      { display: 'Vite', aliases: ['vite'] },
      { display: 'Rollup', aliases: ['rollup'] },
      { display: 'Babel', aliases: ['babel'] },
      { display: 'ESLint', aliases: ['eslint', 'es lint'] },
      { display: 'Prettier', aliases: ['prettier'] },
    ],
  },
  {
    category: 'databases',
    skills: [
      { display: 'PostgreSQL', aliases: ['postgresql', 'postgres', 'psql'] },
      { display: 'MySQL', aliases: ['mysql'] },
      { display: 'SQL Server', aliases: ['sql server', 'mssql'] },
      { display: 'Oracle Database', aliases: ['oracle database', 'oracle'] },
      { display: 'MongoDB', aliases: ['mongodb', 'mongo'] },
      { display: 'DynamoDB', aliases: ['dynamodb'] },
      { display: 'Cassandra', aliases: ['cassandra'] },
      { display: 'CouchDB', aliases: ['couchdb'] },
      { display: 'Redis', aliases: ['redis'] },
      { display: 'Memcached', aliases: ['memcached'] },
      { display: 'Firebase Firestore', aliases: ['firebase firestore', 'firestore'] },
      { display: 'Elasticsearch', aliases: ['elasticsearch', 'elastic search'] },
      { display: 'Apache Solr', aliases: ['apache solr', 'solr'] },
      { display: 'InfluxDB', aliases: ['influxdb'] },
      { display: 'TimescaleDB', aliases: ['timescaledb'] },
      { display: 'Neo4j', aliases: ['neo4j'] },
      { display: 'ETL Pipelines', aliases: ['etl pipelines', 'etl pipeline', 'etl'] },
      { display: 'Data Warehousing', aliases: ['data warehousing', 'data warehouse'] },
      { display: 'Data Lakes', aliases: ['data lakes', 'data lake'] },
      { display: 'SQLAlchemy', aliases: ['sqlalchemy'] },
      { display: 'Prisma', aliases: ['prisma'] },
      { display: 'TypeORM', aliases: ['typeorm'] },
      { display: 'Sequelize', aliases: ['sequelize'] },
      { display: 'Mongoose', aliases: ['mongoose'] },
      { display: 'ActiveRecord', aliases: ['activerecord', 'active record'] },
      { display: 'Query Optimization', aliases: ['query optimization', 'query optimisation'] },
      { display: 'Database Indexing', aliases: ['database indexing', 'indexing'] },
      { display: 'Sharding', aliases: ['sharding'] },
      { display: 'Replication', aliases: ['replication'] },
      { display: 'Data Modeling', aliases: ['data modeling', 'data modelling'] },
      { display: 'Data Caching', aliases: ['data caching'] },
      { display: 'Database Migration', aliases: ['database migration', 'database migrations'] },
      { display: 'ACID Transactions', aliases: ['acid transactions', 'acid transaction', 'acid'] },
    ],
  },
  {
    category: 'cloud-devops',
    skills: [
      { display: 'AWS', aliases: ['aws', 'amazon web services'] },
      { display: 'AWS Lambda', aliases: ['aws lambda', 'lambda'] },
      { display: 'Amazon EKS', aliases: ['amazon eks', 'eks'] },
      { display: 'Amazon ECS', aliases: ['amazon ecs', 'ecs'] },
      { display: 'AWS Fargate', aliases: ['aws fargate', 'fargate'] },
      { display: 'Amazon EC2', aliases: ['amazon ec2', 'ec2'] },
      { display: 'Amazon S3', aliases: ['amazon s3', 's3'] },
      { display: 'Amazon CloudFront', aliases: ['amazon cloudfront', 'cloudfront'] },
      { display: 'Amazon RDS', aliases: ['amazon rds', 'rds'] },
      { display: 'Amazon API Gateway', aliases: ['amazon api gateway', 'api gateway'] },
      { display: 'CloudWatch', aliases: ['cloudwatch'] },
      { display: 'SageMaker', aliases: ['sagemaker'] },
      { display: 'Step Functions', aliases: ['step functions', 'aws step functions'] },
      { display: 'SNS', aliases: ['sns', 'amazon sns'] },
      { display: 'SQS', aliases: ['sqs', 'amazon sqs'] },
      { display: 'IAM', aliases: ['iam', 'aws iam'] },
      { display: 'VPC', aliases: ['vpc', 'amazon vpc'] },
      { display: 'Route 53', aliases: ['route 53', 'route53'] },
      { display: 'Google Cloud Platform (GCP)', aliases: ['google cloud platform', 'gcp', 'google cloud'] },
      { display: 'Microsoft Azure', aliases: ['microsoft azure', 'azure'] },
      { display: 'Docker', aliases: ['docker'] },
      { display: 'Docker Compose', aliases: ['docker compose'] },
      { display: 'Kubernetes', aliases: ['kubernetes', 'k8s', 'kube'] },
      { display: 'Helm', aliases: ['helm'] },
      { display: 'OpenShift', aliases: ['openshift'] },
      { display: 'Terraform', aliases: ['terraform'] },
      { display: 'CloudFormation', aliases: ['cloudformation', 'aws cloudformation'] },
      { display: 'Ansible', aliases: ['ansible'] },
      { display: 'Puppet', aliases: ['puppet'] },
      { display: 'Chef', aliases: ['chef'] },
      { display: 'GitHub Actions', aliases: ['github actions'] },
      { display: 'Jenkins', aliases: ['jenkins'] },
      { display: 'GitLab CI/CD', aliases: ['gitlab ci/cd', 'gitlab ci'] },
      { display: 'CircleCI', aliases: ['circleci', 'circle ci'] },
      { display: 'Travis CI', aliases: ['travis ci'] },
      { display: 'ArgoCD', aliases: ['argocd', 'argo cd'] },
      { display: 'Flux', aliases: ['flux'] },
      { display: 'CI/CD Pipelines', aliases: ['ci/cd pipelines', 'ci/cd pipeline', 'cicd pipelines'] },
      { display: 'Infrastructure as Code (IaC)', aliases: ['infrastructure as code', 'iac'] },
      { display: 'Grafana', aliases: ['grafana'] },
      { display: 'Prometheus', aliases: ['prometheus'] },
      { display: 'Datadog', aliases: ['datadog'] },
      { display: 'New Relic', aliases: ['new relic'] },
      { display: 'ELK Stack', aliases: ['elk stack', 'elk'] },
      { display: 'Istio', aliases: ['istio'] },
      { display: 'Linkerd', aliases: ['linkerd'] },
      { display: 'Load Balancing', aliases: ['load balancing', 'load balancer'] },
      { display: 'Auto Scaling', aliases: ['auto scaling', 'auto-scaling'] },
    ],
  },
  {
    category: 'testing-automation',
    skills: [
      { display: 'PyTest', aliases: ['pytest', 'py test'] },
      { display: 'Jest', aliases: ['jest'] },
      { display: 'JUnit', aliases: ['junit'] },
      { display: 'TestNG', aliases: ['testng'] },
      { display: 'Mocha', aliases: ['mocha'] },
      { display: 'Chai', aliases: ['chai'] },
      { display: 'Jasmine', aliases: ['jasmine'] },
      { display: 'Cypress', aliases: ['cypress'] },
      { display: 'Playwright', aliases: ['playwright'] },
      { display: 'Selenium', aliases: ['selenium'] },
      { display: 'Puppeteer', aliases: ['puppeteer'] },
      { display: 'WebDriverIO', aliases: ['webdriverio', 'webdriver io'] },
      { display: 'Postman', aliases: ['postman'] },
      { display: 'Insomnia', aliases: ['insomnia'] },
      { display: 'REST Assured', aliases: ['rest assured'] },
      { display: 'Locust', aliases: ['locust'] },
      { display: 'k6', aliases: ['k6'] },
      { display: 'JMeter', aliases: ['jmeter'] },
      { display: 'Artillery', aliases: ['artillery'] },
      { display: 'Unit Testing', aliases: ['unit testing'] },
      { display: 'Integration Testing', aliases: ['integration testing'] },
      { display: 'End-to-End Testing (E2E)', aliases: ['end-to-end testing', 'end to end testing', 'e2e'] },
      { display: 'API Testing', aliases: ['api testing'] },
      { display: 'Test-Driven Development (TDD)', aliases: ['test-driven development', 'test driven development', 'tdd'] },
      { display: 'Behavior-Driven Development (BDD)', aliases: ['behavior-driven development', 'behaviour-driven development', 'bdd'] },
      { display: 'Performance Testing', aliases: ['performance testing'] },
      { display: 'Security Testing', aliases: ['security testing'] },
      { display: 'Penetration Testing', aliases: ['penetration testing', 'pen testing', 'pentesting'] },
      { display: 'Code Coverage', aliases: ['code coverage'] },
      { display: 'SonarQube', aliases: ['sonarqube', 'sonar qube'] },
      { display: 'Quality Assurance', aliases: ['quality assurance', 'qa'] },
      { display: 'Test Automation Frameworks', aliases: ['test automation frameworks', 'test automation framework'] },
    ],
  },
  {
    category: 'ai-ml',
    skills: [
      { display: 'OpenAI GPT APIs', aliases: ['openai gpt apis', 'openai api', 'gpt api', 'gpt apis'] },
      { display: 'ChatGPT', aliases: ['chatgpt'] },
      { display: 'Claude API', aliases: ['claude api', 'anthropic api'] },
      { display: 'LangChain', aliases: ['langchain'] },
      { display: 'LlamaIndex', aliases: ['llamaindex', 'llama index'] },
      { display: 'Hugging Face Transformers', aliases: ['hugging face transformers', 'transformers', 'huggingface transformers'] },
      { display: 'TensorFlow', aliases: ['tensorflow', 'tensor flow'] },
      { display: 'PyTorch', aliases: ['pytorch', 'py torch'] },
      { display: 'Keras', aliases: ['keras'] },
      { display: 'Scikit-learn', aliases: ['scikit-learn', 'sklearn'] },
      { display: 'XGBoost', aliases: ['xgboost'] },
      { display: 'LightGBM', aliases: ['lightgbm'] },
      { display: 'SpaCy', aliases: ['spacy'] },
      { display: 'NLTK', aliases: ['nltk'] },
      { display: 'Pandas', aliases: ['pandas'] },
      { display: 'NumPy', aliases: ['numpy'] },
      { display: 'Matplotlib', aliases: ['matplotlib'] },
      { display: 'Seaborn', aliases: ['seaborn'] },
      { display: 'Jupyter Notebooks', aliases: ['jupyter notebooks', 'jupyter notebook', 'jupyter'] },
      { display: 'FastAPI AI Agents', aliases: ['fastapi ai agents', 'fastapi ai agent'] },
      { display: 'Prompt Engineering', aliases: ['prompt engineering'] },
      { display: 'Model Fine-tuning', aliases: ['model fine-tuning', 'model fine tuning', 'fine-tuning', 'fine tuning'] },
      { display: 'RAG (Retrieval-Augmented Generation)', aliases: ['rag', 'retrieval-augmented generation', 'retrieval augmented generation'] },
      { display: 'Pinecone', aliases: ['pinecone'] },
      { display: 'Chroma', aliases: ['chroma'] },
      { display: 'Weaviate', aliases: ['weaviate'] },
      { display: 'MLOps', aliases: ['mlops'] },
      { display: 'Model Deployment', aliases: ['model deployment'] },
      { display: 'Computer Vision', aliases: ['computer vision'] },
      { display: 'Natural Language Processing (NLP)', aliases: ['natural language processing', 'nlp'] },
      { display: 'Deep Learning', aliases: ['deep learning'] },
      { display: 'Machine Learning', aliases: ['machine learning', 'ml'] },
    ],
  },
  {
    category: 'tools-methodologies',
    skills: [
      { display: 'Git', aliases: ['git'] },
      { display: 'GitHub', aliases: ['github'] },
      { display: 'GitLab', aliases: ['gitlab'] },
      { display: 'Bitbucket', aliases: ['bitbucket'] },
      { display: 'Jira', aliases: ['jira'] },
      { display: 'Asana', aliases: ['asana'] },
      { display: 'Trello', aliases: ['trello'] },
      { display: 'Linear', aliases: ['linear'] },
      { display: 'Monday.com', aliases: ['monday.com', 'monday'] },
      { display: 'Confluence', aliases: ['confluence'] },
      { display: 'Notion', aliases: ['notion'] },
      { display: 'Swagger/OpenAPI', aliases: ['swagger/openapi', 'swagger', 'openapi'] },
      { display: 'Figma', aliases: ['figma'] },
      { display: 'Sketch', aliases: ['sketch'] },
      { display: 'Adobe XD', aliases: ['adobe xd', 'xd'] },
      { display: 'VSCode', aliases: ['vscode', 'vs code'] },
      { display: 'PyCharm', aliases: ['pycharm'] },
      { display: 'IntelliJ IDEA', aliases: ['intellij idea', 'intellij'] },
      { display: 'WebStorm', aliases: ['webstorm'] },
      { display: 'Sublime Text', aliases: ['sublime text', 'sublime'] },
      { display: 'Vim', aliases: ['vim'] },
      { display: 'Agile', aliases: ['agile'] },
      { display: 'Scrum', aliases: ['scrum'] },
      { display: 'Kanban', aliases: ['kanban'] },
      { display: 'DevOps', aliases: ['devops'] },
      { display: 'Microservices', aliases: ['microservices'] },
      { display: 'Clean Architecture', aliases: ['clean architecture'] },
      { display: 'SOLID Principles', aliases: ['solid principles', 'solid'] },
      { display: 'Design Patterns', aliases: ['design patterns', 'design pattern'] },
      { display: 'Code Review', aliases: ['code review', 'code reviews'] },
      { display: 'Pair Programming', aliases: ['pair programming'] },
      { display: 'npm', aliases: ['npm'] },
      { display: 'yarn', aliases: ['yarn'] },
      { display: 'pip', aliases: ['pip'] },
      { display: 'poetry', aliases: ['poetry'] },
      { display: 'Maven', aliases: ['maven'] },
      { display: 'Gradle', aliases: ['gradle'] },
    ],
  },
];

const HARD_SKILL_DEFINITIONS: HardSkillDefinition[] = HARD_SKILL_CATEGORY_SEEDS.flatMap(
  ({ category, skills }) =>
    skills.map((skill, index) => ({
      display: skill.display,
      category,
      aliases: uniqueCaseInsensitive([skill.display, ...(skill.aliases ?? [])]).map(normalizeHardSkillAlias),
      priority: index,
    }))
);

const HARD_SKILL_ALIAS_MAP = new Map<string, { display: string; category: HardSkillCategory; priority: number }>();
for (const definition of HARD_SKILL_DEFINITIONS) {
  for (const alias of definition.aliases) {
    HARD_SKILL_ALIAS_MAP.set(alias, {
      display: definition.display,
      category: definition.category,
      priority: definition.priority,
    });
  }
}

const HARD_SKILL_CATEGORY_WEIGHT: Record<HardSkillCategory, number> = {
  backend: 0,
  frontend: 1,
  databases: 2,
  'cloud-devops': 3,
  'testing-automation': 4,
  'ai-ml': 5,
  'tools-methodologies': 6,
  other: 7,
};
/**
 * Appended to the tailor-resume turn.
 *
 * The code below decides every skill list from the skill library and the job
 * analysis, then overwrites whatever the model returned. Telling the model to
 * omit those fields is therefore not a preference, it is what keeps the model
 * from spending output tokens on text that is discarded. It lives here rather
 * than in the stored prompt so an admin editing the prompt cannot remove it
 * without also changing the code that depends on it.
 */
const FINAL_SKILL_OVERRIDE = `FINAL SKILL OVERRIDE:
Do not decide, generate, or return skills. Omit the fields "skills", "hardSkills", "softSkills", "unconfirmedHardSkills", and "unconfirmedSoftSkills" from the JSON output. Technical skills and soft-skill keywords are already decided by code from skillsJSON and keywordsJson.`;

function usesJobPriorityHardSkillOrdering(profile?: Profile): boolean {
  return getProfileHardSkillOrdering(profile) === 'job-priority';
}

function normalizeSkillsList(skills: string[] | undefined): string[] {
  if (!Array.isArray(skills)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const raw of skills) {
    if (typeof raw !== 'string') continue;
    const skill = raw.trim();
    if (!skill) continue;
    const key = skill.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(skill);
  }

  return normalized;
}

const JOB_POSTING_PERSPECTIVE_PATTERN =
  /\b(?:we|our|ours|ourselves|you|your|yours|yourself|yourselves)\b/i;
const JOB_POSTING_RECRUITING_PATTERN =
  /\b(?:join us|help us|you will|you'll|you are|you would|the ideal candidate|successful candidate|next generation|break ground|ground-breaking)\b/i;
const RESUME_META_TAILORING_PATTERN =
  /\b(?:this background maps to|background maps to|maps to|mapped to|aligns with|aligned with|target role|target job|job description|job posting|ats|keyword coverage|required skills|key responsibilities|for this specific role|for this role)\b/i;
const IMPERATIVE_RESPONSIBILITY_VERBS = new Set([
  'build',
  'create',
  'develop',
  'design',
  'implement',
  'lead',
  'own',
  'manage',
  'drive',
  'deliver',
  'enable',
  'collaborate',
  'partner',
  'support',
  'improve',
  'optimize',
  'architect',
]);

function normalizeJobAnalysisPhrase(value: string): string {
  return value
    .replace(/^[\s\-*]+/, '')
    .replace(/\s+/g, ' ')
    .replace(/[;:,\s]+$/, '')
    .trim();
}

function isUnsafeJobPostingPhrase(value: string): boolean {
  const normalized = normalizeJobAnalysisPhrase(value);
  if (!normalized) return true;
  return (
    JOB_POSTING_PERSPECTIVE_PATTERN.test(normalized) ||
    JOB_POSTING_RECRUITING_PATTERN.test(normalized) ||
    RESUME_META_TAILORING_PATTERN.test(normalized)
  );
}

function neutralizeResponsibilityPhrase(value: string): string {
  const normalized = normalizeJobAnalysisPhrase(value).replace(/\.$/, '');
  if (!normalized || isUnsafeJobPostingPhrase(normalized)) return '';

  const words = normalized.split(/\s+/);
  const first = words[0]?.toLowerCase();
  if (first && IMPERATIVE_RESPONSIBILITY_VERBS.has(first) && words.length > 1) {
    return `${words.slice(1).join(' ')} delivery`;
  }

  return normalized;
}

function normalizeSafeKeywordList(values: string[]): string[] {
  return normalizeSkillsList(values)
    .map(normalizeJobAnalysisPhrase)
    .filter((item) => item && !isUnsafeJobPostingPhrase(item));
}

function normalizeSafeResponsibilityList(values: string[]): string[] {
  return normalizeSkillsList(values)
    .map(neutralizeResponsibilityPhrase)
    .filter(Boolean);
}


function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    return [value.trim()];
  }
  return [];
}

function normalizeJobAnalysisResponse(
  parsed: RawNestedJobAnalysis,
  jobDescription: string
): JobAnalysis {
  // const inferredSoft = inferAtsSoftSkillsFromText(jobDescription);
  // const inferredHard = inferHardSkillsFromText(jobDescription);

  const technical = normalizeSafeKeywordList([
    ...toStringList(parsed.skills?.technical),
    ...toStringList(parsed.skills?.required),
  ]);
  const required = normalizeSkillsList([
    ...technical,
    // ...inferredHard,
  ]);
  const preferred = normalizeSkillsList([
    ...toStringList(parsed.skills?.preferred),
  ]);
  const tools = normalizeSkillsList(toStringList(parsed.skills?.tools));
  const soft = prioritizeSoftSkills(
    normalizeSkillsList([
      ...toStringList(parsed.skills?.soft),
      ...toStringList(parsed.softSkills),
    ])
  );
  const technologies = normalizeSafeKeywordList([
    ...toStringList(parsed.technologies),
    ...toStringList(parsed.skills?.technologies),
  ]);
  const protocols = normalizeSafeKeywordList(toStringList(parsed.protocols));
  const methodologies = normalizeSafeKeywordList(toStringList(parsed.methodologies));
  const architecturePatterns = normalizeSafeKeywordList(toStringList(parsed.architecturePatterns));
  const responsibilities = normalizeSafeResponsibilityList([
    ...toStringList(parsed.responsibilities),
  ]);
  const domainKnowledge = normalizeSafeKeywordList([
    ...toStringList(parsed.domainKnowledge),
  ]);
  const keywordGroups = parsed.keywords && typeof parsed.keywords === 'object' && !Array.isArray(parsed.keywords)
    ? parsed.keywords as Record<string, unknown>
    : {};

  return {
    jobMeta: {
      title: asString(parsed.jobMeta?.title) || asString(parsed.jobMeta?.title),
      seniority: asString(parsed.jobMeta?.seniority),
      industry: asString(parsed.jobMeta?.industry),
      department: asString(parsed.jobMeta?.department),
    },
    skills: {
      technical,
      required,
      preferred,
      tools,
      soft,
      technologies,
    },
    technologies,
    protocols,
    methodologies,
    architecturePatterns,
    responsibilities,
    domainKnowledge,
    softSkills: soft,
    keywords: {
      actionVerbs: normalizeSafeKeywordList(toStringList(keywordGroups.actionVerbs)),
      buzzwords: normalizeSafeKeywordList(toStringList(keywordGroups.buzzwords)),
      mustInclude: normalizeSafeKeywordList([
        ...toStringList(keywordGroups.mustInclude),
      ]),
    },
    sourceJobDescription: jobDescription.trim(),
  };
}

function getJobAnalysisTitle(jobAnalysis?: JobAnalysis): string {
  return jobAnalysis?.jobMeta?.title?.trim() ?? '';
}

function getTechnicalSkills(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList(jobAnalysis?.skills?.technical);
}

function getRequiredSkills(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList([
    ...(jobAnalysis?.skills?.required ?? []),
    ...getTechnicalSkills(jobAnalysis),
  ]);
}

function getPreferredSkills(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList(jobAnalysis?.skills?.preferred);
}

function getSkillTools(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList(jobAnalysis?.skills?.tools);
}

function getTechnologies(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList([
    ...(jobAnalysis?.technologies ?? []),
    ...(jobAnalysis?.skills?.technologies ?? []),
  ]);
}

function getProtocols(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList(jobAnalysis?.protocols);
}

function getMethodologies(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList(jobAnalysis?.methodologies);
}

function getArchitecturePatterns(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList(jobAnalysis?.architecturePatterns);
}

function getResponsibilities(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList(jobAnalysis?.responsibilities);
}

function getDomainKnowledge(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList(jobAnalysis?.domainKnowledge);
}

function getSoftSkills(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList([
    ...(jobAnalysis?.softSkills ?? []),
    ...(jobAnalysis?.skills?.soft ?? []),
  ]);
}

function getIndustryTerms(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList([
    jobAnalysis?.jobMeta?.industry ?? '',
    jobAnalysis?.jobMeta?.department ?? '',
    ...getDomainKnowledge(jobAnalysis),
  ]);
}

function getKeywordChecklist(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList([
    ...(jobAnalysis?.keywords?.actionVerbs ?? []),
    ...(jobAnalysis?.keywords?.buzzwords ?? []),
    ...(jobAnalysis?.keywords?.mustInclude ?? []),
    ...getSoftSkills(jobAnalysis),
    ...getSkillTools(jobAnalysis),
    ...getTechnologies(jobAnalysis),
    ...getProtocols(jobAnalysis),
    ...getMethodologies(jobAnalysis),
    ...getArchitecturePatterns(jobAnalysis),
    ...getDomainKnowledge(jobAnalysis),
  ]);
}

function getHardSkillChecklist(jobAnalysis?: JobAnalysis): string[] {
  return normalizeSkillsList([
    ...getTechnicalSkills(jobAnalysis),
    ...getRequiredSkills(jobAnalysis),
    ...getPreferredSkills(jobAnalysis),
    ...getSkillTools(jobAnalysis),
    ...getTechnologies(jobAnalysis),
    ...getProtocols(jobAnalysis),
    ...getMethodologies(jobAnalysis),
    ...getArchitecturePatterns(jobAnalysis),
    ...getKeywordChecklist(jobAnalysis),
    ...getIndustryTerms(jobAnalysis),
  ]);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsLibraryTerm(text: string, term: string): boolean {
  const normalizedTerm = term.trim().replace(/\s+/g, ' ');
  if (!normalizedTerm) return false;

  const pattern = escapeRegex(normalizedTerm).replace(/\\\s+/g, '\\s+');
  const flags = normalizedTerm === 'Go' ? '' : 'i';
  return new RegExp(`(?<![A-Za-z0-9])${pattern}(?![A-Za-z0-9])`, flags).test(text);
}

function getLibraryMatches(sourceText: string, librarySkills: string[]): string[] {
  if (!sourceText.trim()) return [];
  return normalizeSkillsList(librarySkills.filter((skill) => containsLibraryTerm(sourceText, skill)));
}

function canonicalSkillKey(skill: string): string {
  return normalizeHardSkillAlias(skill)
    .replace(/[^a-z0-9+#.]+/g, ' ')
    .trim();
}

function isBroaderSkillCoveredBySpecificSkill(broader: string, specific: string): boolean {
  const broadKey = canonicalSkillKey(broader);
  const specificKey = canonicalSkillKey(specific);
  if (!broadKey || !specificKey || broadKey === specificKey) return false;

  return specificKey.startsWith(`${broadKey} `)
    || specificKey.startsWith(`${broadKey}.`)
    || specificKey.startsWith(`${broadKey}-`)
    || specificKey.startsWith(`${broadKey}/`);
}

function removeBroaderCoveredSkills(skills: string[]): string[] {
  const normalized = normalizeSkillsList(skills);
  return normalized.filter((skill) =>
    !normalized.some((candidate) => isBroaderSkillCoveredBySpecificSkill(skill, candidate))
  );
}

type CategorizedSkillGroup = {
  category: LibraryHardSkillCategory;
  skills: string[];
};

const LANGUAGE_LIBRARY_CATEGORY: LibraryHardSkillCategory = 'Languages';
const MIN_LANGUAGE_SKILLS_PER_LIBRARY_CATEGORY = 3;
const MAX_LANGUAGE_SKILLS_PER_LIBRARY_CATEGORY = 5;
const MIN_SKILLS_PER_LIBRARY_CATEGORY = 5;
const MAX_SKILLS_PER_LIBRARY_CATEGORY = 10;
const MIN_LIBRARY_CATEGORY_COUNT = 5;
const LANGUAGE_FILL_EXCLUDED_SKILLS = new Set(['bash', 'c#', 'html', 'css']);
const LANGUAGE_FILL_PRIORITY = new Map(
  [
    'python',
    'java',
    'javascript',
    'typescript',
    'go',
    'ruby',
    'php',
    'sql',
    'swift',
    'kotlin',
    'rust',
    'scala',
    'c++',
    'dart',
    'elixir',
    'r',
  ].map((skill, index) => [skill, index])
);

function getHardSkillRecord(skill: string): (typeof hardSkillRecords)[number] | undefined {
  const normalized = normalizeHardSkillAlias(skill);
  return hardSkillRecords.find((record) => normalizeHardSkillAlias(record.skill) === normalized);
}

function getLibraryPriority(skill: string): number {
  return getHardSkillRecord(skill)?.priority ?? Number.MAX_SAFE_INTEGER;
}

function sortByLibraryPriorityAndName(skills: string[]): string[] {
  return normalizeSkillsList(skills).sort((left, right) => {
    const priorityDiff = getLibraryPriority(left) - getLibraryPriority(right);
    if (priorityDiff !== 0) return priorityDiff;
    return left.localeCompare(right, undefined, { sensitivity: 'base' });
  });
}

function getCategorySkillMinimum(category: LibraryHardSkillCategory): number {
  return category === LANGUAGE_LIBRARY_CATEGORY
    ? MIN_LANGUAGE_SKILLS_PER_LIBRARY_CATEGORY
    : MIN_SKILLS_PER_LIBRARY_CATEGORY;
}

function getCategorySkillMaximum(category: LibraryHardSkillCategory): number {
  return category === LANGUAGE_LIBRARY_CATEGORY
    ? MAX_LANGUAGE_SKILLS_PER_LIBRARY_CATEGORY
    : MAX_SKILLS_PER_LIBRARY_CATEGORY;
}

function isLibraryFillAllowed(record: (typeof hardSkillRecords)[number]): boolean {
  return (
    record.category !== LANGUAGE_LIBRARY_CATEGORY ||
    !LANGUAGE_FILL_EXCLUDED_SKILLS.has(normalizeHardSkillAlias(record.skill))
  );
}

function compareLibraryFillRecords(
  left: (typeof hardSkillRecords)[number],
  right: (typeof hardSkillRecords)[number]
): number {
  if (left.category === LANGUAGE_LIBRARY_CATEGORY && right.category === LANGUAGE_LIBRARY_CATEGORY) {
    const leftRank = LANGUAGE_FILL_PRIORITY.get(normalizeHardSkillAlias(left.skill)) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = LANGUAGE_FILL_PRIORITY.get(normalizeHardSkillAlias(right.skill)) ?? Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) return leftRank - rightRank;
  }

  if (left.priority !== right.priority) return left.priority - right.priority;
  return left.skill.localeCompare(right.skill, undefined, { sensitivity: 'base' });
}

function buildCategorizedLibrarySkills(seedSkills: string[]): CategorizedSkillGroup[] {
  const grouped = new Map<LibraryHardSkillCategory, string[]>(
    HARD_SKILL_CATEGORIES.map((category) => [category, []])
  );
  const used = new Set<string>();

  for (const skill of sortByLibraryPriorityAndName(seedSkills)) {
    const record = getHardSkillRecord(skill);
    if (!record) continue;
    const display = record.skill;
    const key = normalizeHardSkillAlias(display);
    if (!key || used.has(key)) continue;
    used.add(key);
    grouped.get(record.category)?.push(display);
  }

  const hasDynamicCategory = HARD_SKILL_CATEGORIES
    .filter((category) => category !== LANGUAGE_LIBRARY_CATEGORY)
    .some((category) => (grouped.get(category)?.length ?? 0) > 0);
  const includedCategories = new Set<LibraryHardSkillCategory>([LANGUAGE_LIBRARY_CATEGORY]);
  for (const category of HARD_SKILL_CATEGORIES) {
    if (category !== LANGUAGE_LIBRARY_CATEGORY && (grouped.get(category)?.length ?? 0) > 0) {
      includedCategories.add(category);
    }
  }

  if (!hasDynamicCategory) {
    includedCategories.add('Frameworks and Libraries');
    includedCategories.add('Cloud and Infrastructure');
  }

  for (const category of HARD_SKILL_CATEGORIES) {
    if (includedCategories.size >= MIN_LIBRARY_CATEGORY_COUNT) break;
    if (category !== LANGUAGE_LIBRARY_CATEGORY) {
      includedCategories.add(category);
    }
  }

  const recordsByCategory = new Map<LibraryHardSkillCategory, typeof hardSkillRecords>(
    HARD_SKILL_CATEGORIES.map((category) => [
      category,
      hardSkillRecords
        .filter((record) => record.category === category)
        .sort(compareLibraryFillRecords),
    ])
  );

  for (const category of includedCategories) {
    const categorySkills = grouped.get(category) ?? [];
    for (const record of recordsByCategory.get(category) ?? []) {
      if (categorySkills.length >= getCategorySkillMinimum(category)) break;
      if (!isLibraryFillAllowed(record)) continue;
      const key = normalizeHardSkillAlias(record.skill);
      if (!key || used.has(key)) continue;
      used.add(key);
      categorySkills.push(record.skill);
    }
    grouped.set(category, categorySkills.slice(0, getCategorySkillMaximum(category)));
  }

  return HARD_SKILL_CATEGORIES
    .filter((category) => includedCategories.has(category))
    .map((category) => ({
      category,
      skills: grouped.get(category) ?? [],
    }))
    .filter((group) => group.skills.length > 0);
}

function flattenCategorizedSkills(groups: CategorizedSkillGroup[]): string[] {
  return uniqueCaseInsensitive(groups.flatMap((group) => group.skills));
}

function buildLibraryAugmentedPromptLists(jobAnalysis: JobAnalysis): {
  skills: CategorizedSkillGroup[];
  promptSkills: string[];
  keywords: string[];
} {
  const sourceText = getTailoringSourceText(jobAnalysis);
  const extractedKeywords = getKeywordChecklist(jobAnalysis);
  const matchedTechSkills = removeBroaderCoveredSkills(getLibraryMatches(sourceText, technicalSkills));
  const matchedSoftSkills = getLibraryMatches(sourceText, softSkills);
  const categorizedSkills = buildCategorizedLibrarySkills(matchedTechSkills);

  return {
    skills: categorizedSkills,
    promptSkills: matchedTechSkills,
    keywords: normalizeSkillsList([
      ...extractedKeywords,
      ...matchedSoftSkills,
    ]),
  };
}

function getMatchedLibrarySoftSkills(jobAnalysis?: JobAnalysis): string[] {
  if (!jobAnalysis) return [];
  return getLibraryMatches(getTailoringSourceText(jobAnalysis), softSkills);
}

function getResumePlainText(content: Pick<TailoredContent, 'summary' | 'experience'>): string {
  return [
    content.summary,
    ...(content.experience ?? []).flatMap((entry) => [
      entry.description,
      ...(entry.achievements ?? []),
    ]),
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n');
}

function ensureMatchedSoftKeywordsInSummary(
  summary: string,
  experience: TailoredContent['experience'],
  jobAnalysis?: JobAnalysis
): string {
  const matchedSoftSkills = getMatchedLibrarySoftSkills(jobAnalysis);
  if (matchedSoftSkills.length === 0) return summary;

  const resumeText = getResumePlainText({ summary, experience });
  const missingSoftSkills = matchedSoftSkills.filter((skill) => !containsLibraryTerm(resumeText, skill));
  if (missingSoftSkills.length === 0) return summary;

  const sentence = `Strengths include ${missingSoftSkills.join(', ')} across changing engineering contexts.`;
  return [summary.trim().replace(/\.$/, ''), sentence]
    .filter(Boolean)
    .join('. ');
}

function normalizeHardSkillAlias(skill: string): string {
  return skill.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Job titles to exclude from hard skills - these are roles, not technical skills */
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

function inferHardSkillCategory(skillAlias: string): HardSkillCategory {
  const rules: Array<{ category: HardSkillCategory; patterns: string[] }> = [
    {
      category: 'backend',
      patterns: [
        'python', 'fastapi', 'django', 'flask', 'pydantic', 'node', 'express', 'nestjs', 'fastify', 'koa',
        'rails', 'gin', 'echo', 'spring', 'laravel', 'symfony', 'grpc', 'websocket', 'server-sent',
        'microservice', 'event-driven', 'domain-driven', 'ddd', 'celery', 'rabbitmq', 'kafka', 'rest api',
        'restful api', 'graphql', 'async', 'background job', 'message queue', 'serverless', 'api gateway',
      ],
    },
    {
      category: 'frontend',
      patterns: [
        'react', 'angular', 'vue', 'next', 'nuxt', 'typescript', 'javascript', 'redux', 'zustand', 'mobx',
        'rxjs', 'html', 'css', 'scss', 'sass', 'tailwind', 'bootstrap', 'mui', 'material ui', 'ant design',
        'chakra', 'styled component', 'emotion', 'chart.js', 'd3', 'three.js', 'responsive design',
        'mobile-first', 'pwa', 'webpack', 'vite', 'rollup', 'babel', 'eslint', 'prettier',
      ],
    },
    {
      category: 'databases',
      patterns: [
        'postgres', 'mysql', 'sql server', 'oracle', 'mongodb', 'dynamodb', 'cassandra', 'couchdb', 'redis',
        'memcached', 'firestore', 'elasticsearch', 'solr', 'influxdb', 'timescaledb', 'neo4j', 'etl',
        'warehouse', 'data lake', 'sqlalchemy', 'prisma', 'typeorm', 'sequelize', 'mongoose', 'activerecord',
        'query optimization', 'indexing', 'sharding', 'replication', 'data model', 'database migration', 'acid',
      ],
    },
    {
      category: 'cloud-devops',
      patterns: [
        'aws', 'lambda', 'eks', 'ecs', 'fargate', 'ec2', 's3', 'cloudfront', 'rds', 'cloudwatch', 'sagemaker',
        'step function', 'sns', 'sqs', 'iam', 'vpc', 'route 53', 'gcp', 'google cloud', 'azure', 'docker',
        'kubernetes', 'helm', 'openshift', 'terraform', 'cloudformation', 'ansible', 'puppet', 'chef',
        'github actions', 'jenkins', 'gitlab ci', 'circleci', 'travis ci', 'argocd', 'flux', 'ci/cd',
        'infrastructure as code', 'iac', 'grafana', 'prometheus', 'datadog', 'new relic', 'elk', 'istio',
        'linkerd', 'load balancing', 'auto scaling',
      ],
    },
    {
      category: 'testing-automation',
      patterns: [
        'pytest', 'jest', 'junit', 'testng', 'mocha', 'chai', 'jasmine', 'cypress', 'playwright', 'selenium',
        'puppeteer', 'webdriverio', 'postman', 'insomnia', 'rest assured', 'locust', 'k6', 'jmeter',
        'artillery', 'unit testing', 'integration testing', 'end-to-end', 'e2e', 'api testing', 'tdd', 'bdd',
        'performance testing', 'security testing', 'penetration testing', 'code coverage', 'sonarqube', 'qa',
        'test automation',
      ],
    },
    {
      category: 'ai-ml',
      patterns: [
        'openai', 'chatgpt', 'claude api', 'langchain', 'llamaindex', 'transformers', 'tensorflow', 'pytorch',
        'keras', 'scikit-learn', 'xgboost', 'lightgbm', 'spacy', 'nltk', 'pandas', 'numpy', 'matplotlib',
        'seaborn', 'jupyter', 'prompt engineering', 'fine-tuning', 'rag', 'pinecone', 'chroma', 'weaviate',
        'mlops', 'computer vision', 'natural language processing', 'nlp', 'deep learning', 'machine learning',
      ],
    },
    {
      category: 'tools-methodologies',
      patterns: [
        'git', 'github', 'gitlab', 'bitbucket', 'jira', 'asana', 'trello', 'linear', 'monday', 'confluence',
        'notion', 'swagger', 'figma', 'sketch', 'adobe xd', 'vscode', 'pycharm', 'intellij', 'webstorm',
        'sublime', 'vim', 'agile', 'scrum', 'kanban', 'devops', 'clean architecture', 'solid', 'design pattern',
        'code review', 'pair programming', 'npm', 'yarn', 'pip', 'poetry', 'maven', 'gradle',
      ],
    },
  ];

  for (const rule of rules) {
    if (rule.patterns.some((pattern) => skillAlias.includes(pattern))) {
      return rule.category;
    }
  }

  return 'other';
}

function resolveHardSkill(skill: string): { display: string; category: HardSkillCategory; priority: number } | null {
  const normalized = skill.trim().replace(/\s+/g, ' ');
  if (!normalized || normalized.length > 50 || /[.!?]/.test(normalized)) return null;

  const lower = normalizeHardSkillAlias(normalized);
  // Exclude job titles (full stack developer, frontend developer, etc.)
  if (JOB_TITLE_EXCLUSIONS.has(lower)) return null;
  // Exclude soft skills only (communication, collaboration, ownership, etc.)
  if (SOFT_SKILL_SIGNALS.some((signal) => lower.includes(signal))) return null;

  // If in alias map, return canonical form (already properly capitalized)
  const mapped = HARD_SKILL_ALIAS_MAP.get(lower);
  if (mapped) return mapped;

  // Pass through as hard skill: frameworks, tools, architectures, methodologies, tech names
  const techIndicators = [
    'api', 'rest', 'graphql', 'backend', 'frontend', 'fullstack', 'full-stack',
    'microservice', 'event-driven', 'distributed', 'database', 'sql', 'etl',
    'devops', 'ci/cd', 'docker', 'kubernetes', 'aws', 'cloud', 'architecture',
    'python', 'javascript', 'typescript', 'react', 'vue', 'angular', 'nuxt', 'svelte', 'ember', 'django', 'node', 'go', 'rust', 'rails', 'spring', 'laravel',
    'redis', 'postgres', 'mysql', 'kafka', 'airflow', 'dbt', 'snowflake',
    'terraform', 'testing', 'celery', 'flutter', 'lambda', 'cloudflare',
  ];
  if (techIndicators.some((term) => lower.includes(term))) {
    return {
      display: capitalizeHardSkill(normalized),
      category: inferHardSkillCategory(lower),
      priority: Number.MAX_SAFE_INTEGER,
    };
  }

  // Single-word tech (Airflow, dbt, Kafka) - allow if looks like a tool/framework name
  if (/^[a-z0-9][a-z0-9+\-./]*$/.test(lower) && lower.length >= 2) {
    return {
      display: capitalizeHardSkill(normalized),
      category: inferHardSkillCategory(lower),
      priority: Number.MAX_SAFE_INTEGER,
    };
  }

  return null;
}

function normalizeAllowedHardSkills(skills: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of skills) {
    const resolved = resolveHardSkill(raw);
    if (!resolved) continue;
    const display = resolved.display;
    const key = display.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(display);
  }

  return result;
}

function getHardSkillPriority(skill: string): number {
  return hardSkillPriorityMap.get(skill.trim().toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
}

function containsHardSkillPhrase(text: string, skill: string): boolean {
  const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const flags = skill === 'Go' ? '' : 'i';
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, flags).test(text);
}

function getExperienceSkillText(experience: Profile['experience'][number]): string {
  return [
    experience.title,
    experience.company,
    experience.location,
    experience.description,
    ...(experience.achievements ?? []),
    ...(experience.skills ?? []),
  ]
    .filter((value) => typeof value === 'string' && value.trim().length > 0)
    .join('\n');
}

function getLibraryHardSkillDisplayMap(): Map<string, string> {
  return new Map(technicalSkills.map((skill) => [normalizeHardSkillAlias(skill), skill]));
}

function getMergedExperienceSkills(profile: Profile): string[] {
  const libraryDisplayByKey = getLibraryHardSkillDisplayMap();
  return uniqueCaseInsensitive(
    profile.experience.flatMap((experience) =>
      (experience.skills ?? [])
        .map((skill) => libraryDisplayByKey.get(normalizeHardSkillAlias(skill)))
        .filter((skill): skill is string => !!skill)
    )
  );
}

function restrictExperienceSkillsToLibrary(profile: Profile): Profile {
  const libraryDisplayByKey = getLibraryHardSkillDisplayMap();
  const experience = profile.experience.map((item) => ({
    ...item,
    skills: uniqueCaseInsensitive(
      (item.skills ?? [])
        .map((skill) => libraryDisplayByKey.get(normalizeHardSkillAlias(skill)))
        .filter((skill): skill is string => !!skill)
    ),
  }));

  return {
    ...profile,
    experience,
    skills: getMergedExperienceSkills({ ...profile, experience }),
  };
}

function getMatchedJobDescriptionHardSkills(jobAnalysis: JobAnalysis): string[] {
  const libraryDisplayByKey = getLibraryHardSkillDisplayMap();
  const originalOrder = new Map<string, number>();
  const matchedSkills: string[] = [];
  const candidates = [
    ...getTechnicalSkills(jobAnalysis),
    ...getRequiredSkills(jobAnalysis),
    ...getPreferredSkills(jobAnalysis),
    ...getSkillTools(jobAnalysis),
    ...getTechnologies(jobAnalysis),
    ...getProtocols(jobAnalysis),
    ...getMethodologies(jobAnalysis),
    ...getArchitecturePatterns(jobAnalysis),
    ...extractTechSkills(getTailoringSourceText(jobAnalysis)),
  ];

  for (const rawSkill of candidates) {
    const cleaned = rawSkill.trim();
    if (!cleaned) continue;
    const display = libraryDisplayByKey.get(normalizeHardSkillAlias(cleaned));
    if (!display) continue;

    const key = display.toLowerCase();
    if (!originalOrder.has(key)) {
      originalOrder.set(key, originalOrder.size);
    }
    matchedSkills.push(display);
  }

  return uniqueCaseInsensitive(matchedSkills).sort((a, b) => {
    const aPriority = getHardSkillPriority(a);
    const bPriority = getHardSkillPriority(b);
    if (aPriority !== bPriority) {
      return aPriority - bPriority;
    }

    return (originalOrder.get(a.toLowerCase()) ?? 0) - (originalOrder.get(b.toLowerCase()) ?? 0);
  });
}

function scoreSkillForExperience(
  skill: string,
  experience: Profile['experience'][number],
  assignedSkills: string[],
  experienceIndex: number
): number {
  const experienceText = getExperienceSkillText(experience);
  const resolved = resolveHardSkill(skill);
  const skillCategory = resolved?.category;
  const assignedCategories = new Set(
    assignedSkills
      .map((assignedSkill) => resolveHardSkill(assignedSkill)?.category)
      .filter((category): category is HardSkillCategory => !!category)
  );

  let score = 0;

  if (containsHardSkillPhrase(experienceText, skill)) {
    score += 100;
  }

  if (skillCategory && assignedCategories.has(skillCategory)) {
    score += 20;
  }

  // Small deterministic recency bias when other relevance signals tie.
  score += Math.max(0, 5 - experienceIndex);

  return score;
}

export function enrichProfileExperienceSkillsForJob(profile: Profile, jobAnalysis: JobAnalysis): Profile {
  const matchedJobSkills = getMatchedJobDescriptionHardSkills(jobAnalysis);
  if (matchedJobSkills.length === 0 || profile.experience.length === 0) {
    return restrictExperienceSkillsToLibrary(profile);
  }

  const libraryDisplayByKey = getLibraryHardSkillDisplayMap();
  const matchedSkillKeys = new Set(matchedJobSkills.map((skill) => skill.toLowerCase()));
  const matchedSkillDisplay = new Map(matchedJobSkills.map((skill) => [skill.toLowerCase(), skill]));
  const assignedSkillKeys = new Set<string>();
  const originalUnmatchedSkillsByExperience: string[][] = [];
  const enrichedExperience = profile.experience.map((experience, index) => {
    const originalSkills = experience.skills ?? [];
    const normalizedOriginalSkills = originalSkills
      .map((skill) => libraryDisplayByKey.get(normalizeHardSkillAlias(skill)))
      .filter((skill): skill is string => !!skill);
    const relevantExistingSkills = normalizedOriginalSkills
      .map((skill) => libraryDisplayByKey.get(normalizeHardSkillAlias(skill)) ?? skill)
      .map((skill) => matchedSkillDisplay.get(skill.toLowerCase()) ?? skill)
      .filter((skill) => matchedSkillKeys.has(skill.toLowerCase()));
    const skills = uniqueCaseInsensitive(relevantExistingSkills);
    const matchedExistingKeys = new Set(skills.map((skill) => skill.toLowerCase()));
    originalUnmatchedSkillsByExperience[index] = uniqueCaseInsensitive(
      normalizedOriginalSkills.filter((skill) => !matchedExistingKeys.has(skill.toLowerCase()))
    );

    for (const skill of skills) {
      assignedSkillKeys.add(skill.toLowerCase());
    }

    return {
      ...experience,
      skills,
    };
  });

  const remainingSkills = matchedJobSkills.filter((skill) => !assignedSkillKeys.has(skill.toLowerCase()));

  for (const skill of remainingSkills) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;

    enrichedExperience.forEach((experience, index) => {
      const currentSkills = experience.skills ?? [];
      const relevanceScore = scoreSkillForExperience(skill, experience, currentSkills, index);
      const balancePenalty = currentSkills.length * 8;
      const score = relevanceScore - balancePenalty;

      if (
        score > bestScore ||
        (score === bestScore && currentSkills.length < (enrichedExperience[bestIndex].skills ?? []).length)
      ) {
        bestIndex = index;
        bestScore = score;
      }
    });

    enrichedExperience[bestIndex] = {
      ...enrichedExperience[bestIndex],
      skills: uniqueCaseInsensitive([...(enrichedExperience[bestIndex].skills ?? []), skill]),
    };
  }

  enrichedExperience.forEach((experience, index) => {
    const filledSkills = [...(experience.skills ?? [])];
    const seen = new Set(filledSkills.map((skill) => skill.toLowerCase()));

    for (const skill of originalUnmatchedSkillsByExperience[index] ?? []) {
      if (filledSkills.length >= MIN_EXPERIENCE_SKILLS) {
        break;
      }

      const key = skill.toLowerCase();
      if (seen.has(key)) {
        continue;
      }

      filledSkills.push(skill);
      seen.add(key);
    }

    enrichedExperience[index] = {
      ...experience,
      skills: filledSkills,
    };
  });

  return {
    ...profile,
    skills: getMergedExperienceSkills({ ...profile, experience: enrichedExperience }),
    experience: enrichedExperience,
  };
}

const MAX_SOFT_SKILL_LENGTH = 30;

/** Map long soft skill phrases to short key points */
const SOFT_SKILL_CONDENSE: Array<{ patterns: RegExp | string[]; key: string }> = [
  { patterns: ['excellent communication', 'communication and collaboration', 'communication skills', 'communicate'], key: 'Communication' },
  { patterns: ['collaboration', 'collaborative', 'collaborate'], key: 'Collaboration' },
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
  { patterns: ['analytics', 'applied ai'], key: 'Analytics & AI' },
  { patterns: ['scalable', 'polished'], key: 'Quality focus' },
];

function condenseSoftSkill(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length <= MAX_SOFT_SKILL_LENGTH) {
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  }
  const lower = trimmed.toLowerCase();
  for (const { patterns, key } of SOFT_SKILL_CONDENSE) {
    const matches = Array.isArray(patterns)
      ? patterns.some((p) => lower.includes(p.toLowerCase()))
      : (patterns as RegExp).test(lower);
    if (matches) return key;
  }
  const firstWord = trimmed.split(/\s+/)[0];
  return firstWord ? firstWord.charAt(0).toUpperCase() + firstWord.slice(1) : trimmed;
}

function prioritizeSoftSkills(skills: string[]): string[] {
  return [...skills].sort((a, b) => {
    const aLower = a.toLowerCase();
    const bLower = b.toLowerCase();
    const aScore = SOFT_SKILL_SIGNALS.reduce((count, signal) =>
      count + (aLower.includes(signal) ? 1 : 0), 0);
    const bScore = SOFT_SKILL_SIGNALS.reduce((count, signal) =>
      count + (bLower.includes(signal) ? 1 : 0), 0);

    if (bScore !== aScore) return bScore - aScore;
    return a.length - b.length;
  });
}

function inferAtsSoftSkillsFromText(text: string): string[] {
  const lower = text.toLowerCase();
  return ATS_SOFT_SKILL_RULES
    .filter((rule) => rule.patterns.some((pattern) => lower.includes(pattern)))
    .map((rule) => rule.canonical);
}

function inferAtsSoftSkillsFromAnalysis(jobAnalysis?: JobAnalysis): string[] {
  if (!jobAnalysis) return [];

  const text = [
    ...getSoftSkills(jobAnalysis),
    ...getKeywordChecklist(jobAnalysis),
    ...getResponsibilities(jobAnalysis),
    ...getIndustryTerms(jobAnalysis),
  ].join(' | ');

  return inferAtsSoftSkillsFromText(text);
}

function buildJobDescriptionSkillPriority(jobAnalysis?: JobAnalysis): Map<string, number> {
  const normalized = normalizeAllowedHardSkills(getHardSkillChecklist(jobAnalysis));
  const priorityMap = new Map<string, number>();

  normalized.forEach((skill, index) => {
    priorityMap.set(skill.toLowerCase(), index);
  });

  return priorityMap;
}

function prioritizeHardSkills(skills: string[], jobAnalysis?: JobAnalysis): string[] {
  const normalized = normalizeAllowedHardSkills(skills);
  const originalOrder = new Map<string, number>();
  const jdPriority = buildJobDescriptionSkillPriority(jobAnalysis);

  normalized.forEach((skill, index) => {
    originalOrder.set(skill.toLowerCase(), index);
  });

  return [...normalized].sort((a, b) => {
    const aResolved = resolveHardSkill(a);
    const bResolved = resolveHardSkill(b);
    const aCategory = aResolved?.category ?? 'other';
    const bCategory = bResolved?.category ?? 'other';
    const categoryDiff = HARD_SKILL_CATEGORY_WEIGHT[aCategory] - HARD_SKILL_CATEGORY_WEIGHT[bCategory];

    if (categoryDiff !== 0) {
      return categoryDiff;
    }

    const aJdOrder = jdPriority.get(a.toLowerCase());
    const bJdOrder = jdPriority.get(b.toLowerCase());
    const aInJd = typeof aJdOrder === 'number';
    const bInJd = typeof bJdOrder === 'number';

    if (aInJd !== bInJd) {
      return aInJd ? -1 : 1;
    }

    if (aInJd && bInJd && aJdOrder !== bJdOrder) {
      return (aJdOrder ?? 0) - (bJdOrder ?? 0);
    }

    const libraryPriorityDiff = getHardSkillPriority(a) - getHardSkillPriority(b);
    if (libraryPriorityDiff !== 0) {
      return libraryPriorityDiff;
    }

    const templatePriorityDiff = (aResolved?.priority ?? Number.MAX_SAFE_INTEGER)
      - (bResolved?.priority ?? Number.MAX_SAFE_INTEGER);
    if (templatePriorityDiff !== 0) {
      return templatePriorityDiff;
    }

    return (originalOrder.get(a.toLowerCase()) ?? 0) - (originalOrder.get(b.toLowerCase()) ?? 0);
  });
}

function sortHardSkillsByLibraryPriority(skills: string[]): string[] {
  return [...skills].sort((a, b) => {
    const priorityDiff = getHardSkillPriority(a) - getHardSkillPriority(b);
    if (priorityDiff !== 0) {
      return priorityDiff;
    }

    return a.localeCompare(b, undefined, { sensitivity: 'base' });
  });
}

function finalizeSoftSkills(skills: string[]): string[] {
  const condensed = prioritizeSoftSkills(normalizeSkillsList(skills)).map(condenseSoftSkill);
  return uniqueCaseInsensitive(condensed).slice(0, MAX_SOFT_SKILLS);
}

function buildFallbackExperienceDescription(title: string, jobAnalysis?: JobAnalysis): string {
  const role = title.trim() || 'Engineer';
  const text = `${role} focused on reliable product delivery, maintainable systems, and practical engineering outcomes.`;
  return text.slice(0, MAX_ROLE_BRIEF_LENGTH).trim();
}

function buildFallbackAchievements(jobAnalysis?: JobAnalysis): string[] {
  const base = normalizeSafeResponsibilityList(getResponsibilities(jobAnalysis))
    .slice(0, 3);

  if (base.length > 0) {
    return base.map((item) => `Improved ${item.replace(/\.$/, '').trim()} through practical engineering execution.`);
  }

  return [
    'Improved delivery consistency across critical projects.',
    'Enhanced service reliability and operational efficiency.',
  ];
}

function ensureSummaryUsesExperienceYears(summary: string, profile: Profile): string {
  const years = profile.totalYearsExperience;
  if (typeof years !== 'number' || !Number.isFinite(years) || years < 0) {
    return summary.trim();
  }

  const normalizedSummary = summary.trim().replace(/\s+/g, ' ');
  const yearsText = Number.isInteger(years) ? String(years) : years.toFixed(1);
  const prefixRole = profile.title?.trim() || 'Professional';
  const topSkills = (profile.skills ?? []).slice(0, 3);
  const skillsText = topSkills.length > 0 ? ` in ${topSkills.join(', ')}` : '';
  const leadSentence = `${prefixRole} with about ${yearsText} years of experience${skillsText}.`;

  // Keep the remaining summary content, but avoid duplicate years-style lead sentences.
  const remainder = normalizedSummary
    .replace(/^[^.]*\b\d+(?:\.\d+)?\s*\+?\s*years?\b[^.]*\.?\s*/i, '')
    .trim();

  return remainder ? `${leadSentence} ${remainder}` : leadSentence;
}

function limitSummaryNumericMentions(summary: string, maxMentions = 1): string {
  const text = summary.trim().replace(/\s+/g, ' ');
  if (!text) return text;

  const numberPattern = /\b\d+(?:\.\d+)?\+?\b/g;
  let seen = 0;

  return text.replace(numberPattern, (match) => {
    seen += 1;
    return seen <= maxMentions ? match : '';
  }).replace(/\s+/g, ' ').replace(/\s([.,;:!?])/g, '$1').trim();
}

function toTitleCase(text: string): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function buildSimpleSeniorEngineerTitle(
  contentTitle: string | undefined,
  jobAnalysis?: JobAnalysis,
  profile?: Profile
): string {
  const source = (getJobAnalysisTitle(jobAnalysis) || contentTitle || profile?.title || '').trim();
  const cleaned = source
    .replace(/[^a-zA-Z0-9\s/+.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const stopWords = new Set([
    'a',
    'an',
    'and',
    'for',
    'of',
    'the',
    'to',
    'with',
    'at',
    'in',
    'on',
  ]);
  const roleWords = new Set([
    'engineer',
    'engineering',
    'developer',
    'development',
    'architect',
    'specialist',
    'manager',
    'lead',
    'principal',
    'staff',
    'sr',
    'senior',
    'mid',
    'junior',
    'ii',
    'iii',
    'iv',
  ]);

  const domainTokens = cleaned
    .split(/\s+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token && !stopWords.has(token) && !roleWords.has(token))
    .slice(0, 2);

  const domain = domainTokens.length > 0 ? toTitleCase(domainTokens.join(' ')) : 'Software';
  return `Senior ${domain} Engineer`;
}

function isCompanyDescriptionLike(value: string, company?: string): boolean {
  const normalized = value.trim().replace(/\s+/g, ' ');
  const companyName = company?.trim();
  if (!normalized || !companyName) return false;

  const escapedCompany = companyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const companyLeadPattern = new RegExp(
    `^(?:category:\\s*)?${escapedCompany}\\b\\s+(?:is|are|was|were|builds|provides|offers|serves|uses|aims|helps|connects|creates|develops|delivers)\\b`,
    'i'
  );
  const marketingContextPattern = new RegExp(
    `\\b${escapedCompany}\\b.{0,80}\\b(?:founded|headquartered|acquired|serves|customers|platform|company|nonprofit|non-profit)\\b`,
    'i'
  );

  return companyLeadPattern.test(normalized) || marketingContextPattern.test(normalized);
}

function stripUnsafeResumeSentences(value: string, company?: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) return '';

  const sentences = normalized.split(/(?<=[.!?])\s+/);
  const safeSentences = sentences
    .map((sentence) => sentence.trim())
    .filter((sentence) =>
      sentence &&
      !isUnsafeJobPostingPhrase(sentence) &&
      !isCompanyDescriptionLike(sentence, company)
    );

  return safeSentences.join(' ').trim();
}

function buildPromptProfile(profile: Profile): Profile {
  return {
    ...profile,
    experience: profile.experience.map((experience) => ({
      ...experience,
      description: '',
      companyContext: stripUnsafeResumeSentences(experience.description ?? '', experience.company),
    } as Profile['experience'][number] & { companyContext: string })),
  };
}

function normalizeTailoredContent(content: TailoredContent, jobAnalysis?: JobAnalysis, profile?: Profile): TailoredContent {
  const codeDecidedHardSkills = jobAnalysis
    ? flattenCategorizedSkills(buildLibraryAugmentedPromptLists(jobAnalysis).skills)
    : normalizeSkillsList(content.hardSkills ?? content.skills ?? []);

  const atsSoftPriority = inferAtsSoftSkillsFromAnalysis(jobAnalysis);
  const finalizedHardSkills = normalizeSkillsList(codeDecidedHardSkills);
  const hardSkills = usesJobPriorityHardSkillOrdering(profile)
    ? prioritizeHardSkills(finalizedHardSkills, jobAnalysis)
    : sortHardSkillsByLibraryPriority(finalizedHardSkills);
  const softFromModel = normalizeSkillsList(content.softSkills);
  const softFromAnalysis = getSoftSkills(jobAnalysis);
  const softMerged = normalizeSkillsList([...atsSoftPriority, ...softFromModel, ...softFromAnalysis]);
  const softLimited = finalizeSoftSkills(softMerged);

  const trimIncompleteEnd = (s: string): string =>
    s.trim().replace(/,+\s*$/, '').replace(/\s+(and|or)\s*$/i, '').trim();
  const stripBoldTags = (s: string): string =>
    s.replace(/<\/?strong>/gi, '').replace(/<\/?b>/gi, '');
  const sanitizeResumeText = (s: string): string => {
    const clean = stripUnsafeResumeSentences(stripBoldTags(s), undefined);
    return isUnsafeJobPostingPhrase(clean) ? '' : clean;
  };

  const clampRoleBrief = (description: string, company?: string, title?: string): string => {
    const stripped = stripBoldTags(description).trim().replace(/\s+/g, ' ');
    const cleanBase = stripUnsafeResumeSentences(stripped, company);
    const fallback = buildFallbackExperienceDescription(title ?? '', jobAnalysis);
    const clean = cleanBase || fallback;
    if (isUnsafeJobPostingPhrase(clean) || isCompanyDescriptionLike(clean, company)) {
      return fallback;
    }
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
  };

  const normalizeSummary = (summary: string): string =>
    stripUnsafeResumeSentences(stripBoldTags(summary), undefined);

  const normalizedExperience = (content.experience ?? []).map((item) => ({
    ...item,
    description: clampRoleBrief(
      item.description ?? buildFallbackExperienceDescription(item.title ?? '', jobAnalysis),
      item.company,
      item.title
    ),
    achievements: normalizeSkillsList(item.achievements).map(sanitizeResumeText).filter(Boolean).length > 0
      ? normalizeSkillsList(item.achievements).map(sanitizeResumeText).filter(Boolean)
      : buildFallbackAchievements(jobAnalysis),
  }));

  const strengthKeywordPool = normalizeSafeKeywordList([
    ...getRequiredSkills(jobAnalysis),
    ...getPreferredSkills(jobAnalysis),
    ...getKeywordChecklist(jobAnalysis),
    ...getIndustryTerms(jobAnalysis),
  ]).filter((keyword) => keyword.length >= 3);

  const fallbackStrengths = normalizeSafeResponsibilityList(getResponsibilities(jobAnalysis))
    .slice(0, 4)
    .map((item, index) => ({
      title: `Core Strength ${index + 1}`,
      description: `Demonstrated impact in ${item.trim().replace(/\.$/, '')}.`,
    }));

  const baseStrengths = (content.strengths ?? []).length > 0 ? (content.strengths ?? []) : fallbackStrengths;
  const normalizedStrengths = baseStrengths.map((strength, index) => {
    const title = capitalizeFirstCharacter(
      (strength?.title ?? `Core Strength ${index + 1}`).trim() || `Core Strength ${index + 1}`
    );
    const rawDescription = (strength?.description ?? '').trim();
    const keywordA = strengthKeywordPool[index % Math.max(strengthKeywordPool.length, 1)] ?? '';
    const keywordB = strengthKeywordPool[(index + 7) % Math.max(strengthKeywordPool.length, 1)] ?? '';
    const keywordSnippet = [keywordA, keywordB]
      .filter(Boolean)
      .join(' and ');

    const normalizedDescription = rawDescription && !isUnsafeJobPostingPhrase(rawDescription)
      ? stripBoldTags(rawDescription).replace(/\s+/g, ' ').replace(/\.$/, '')
      : 'Demonstrated impact in complex engineering environments';

    const hasKeyword = strengthKeywordPool.some((kw) =>
      normalizedDescription.toLowerCase().includes(kw.toLowerCase())
    );
    const suffix = hasKeyword || !keywordSnippet
      ? '.'
      : `. Focused on ${keywordSnippet}.`;

    return {
      title,
      description: `${normalizedDescription}${suffix}`,
    };
  });

  const normalizedSummary = limitSummaryNumericMentions(
    normalizeSummary(
      profile ? ensureSummaryUsesExperienceYears(content.summary ?? '', profile) : (content.summary ?? '').trim()
    ),
    1
  );
  const summaryWithMatchedSoftKeywords = ensureMatchedSoftKeywordsInSummary(
    normalizedSummary,
    normalizedExperience,
    jobAnalysis
  );

  return {
    ...content,
    title: buildSimpleSeniorEngineerTitle(content.title, jobAnalysis, profile),
    summary: summaryWithMatchedSoftKeywords,
    experience: normalizedExperience,
    hardSkills,
    softSkills: softLimited,
    strengths: normalizedStrengths,
    // Keep legacy field aligned with hard skills for older templates/components.
    skills: hardSkills,
  };
}

export async function analyzeJobDescription(
  jobDescription: string,
  provider: AIProvider = DEFAULT_PROVIDER,
  modelName?: string,
  promptId?: string,
  signal?: AbortSignal
): Promise<JobAnalysis> {
  const resolvedPromptId = promptId?.trim() || DEFAULT_ANALYZE_JOB_PROMPT_ID;
  const promptValues = buildAnalyzeJobDescriptionPromptValues(jobDescription);
  const firstCallStartedAt = process.hrtime.bigint();
  console.log(`[Resume timing] First LLM call started: analyze job description (${provider}${modelName ? `/${modelName}` : ''})`);
  const content = await createPromptCompletion({
    promptId: resolvedPromptId,
    promptValues,
    fallbackProvider: provider,
    fallbackModelName: modelName,
    maxTokens: 7000,
    temperature: 0,
    responseFormat: 'json',
    // Rendered by exact id, so resolved by exact id too. These used to
    // disagree: the text came from this literal record while the model
    // override came from whichever record was activated for the feature.
    useExactPromptId: true,
    signal,
  });
  const firstCallEndedAt = process.hrtime.bigint();
  console.log(`[Resume timing] First LLM call finished in ${formatDuration(firstCallStartedAt, firstCallEndedAt)}`);

  const analysis = parseJobAnalysisContent(content, jobDescription);
  resumeBuildTiming.set(analysis, { firstCallEndedAt });
  return analysis;
}

export async function analyzeJobDescriptionPromptRaw(
  jobDescription: string,
  provider: AIProvider = DEFAULT_PROVIDER,
  modelName?: string,
  promptId?: string
): Promise<unknown> {
  const resolvedPromptId = promptId?.trim() || DEFAULT_ANALYZE_JOB_PROMPT_ID;
  const promptValues = buildAnalyzeJobDescriptionPromptValues(jobDescription);
  const content = await createPromptCompletion({
    promptId: resolvedPromptId,
    promptValues,
    fallbackProvider: provider,
    fallbackModelName: modelName,
    maxTokens: 7000,
    temperature: 0,
    responseFormat: 'json',
    useExactPromptId: true,
  });

  try {
    return JSON.parse(extractJSON(content));
  } catch (error) {
    console.error('Failed to parse raw prompt test response:', error, content);
    throw new Error('Failed to parse prompt test response');
  }
}

export function buildAnalyzeJobDescriptionPromptValues(jobDescription: string): Record<string, string> {
  return {
    jobDescription,
  };
}

export function parseJobAnalysisContent(content: string, jobDescription: string): JobAnalysis {
  try {
    const jsonText = extractJSON(content);
    const parsed = JSON.parse(jsonText) as RawNestedJobAnalysis;
    return normalizeJobAnalysisResponse(parsed, jobDescription);
  } catch (error) {
    console.error('Failed to parse model response:', error, content);
    throw new Error('Failed to parse job analysis response');
  }
}

export function buildTailorResumePromptValues(
  profile: Profile,
  jobAnalysis: JobAnalysis
): Record<string, string> {
  const { sourceJobDescription: _sourceJobDescription, ...jobAnalysisForPrompt } = jobAnalysis;
  const profileForPrompt = buildPromptProfile(profile);
  const augmentedPromptLists = buildLibraryAugmentedPromptLists(jobAnalysis);
  const promptSkills = augmentedPromptLists.promptSkills;
  const promptValues = {
    profileJson: JSON.stringify(profileForPrompt, null, 2),
    jobAnalysisJson: JSON.stringify(jobAnalysisForPrompt, null, 2),
    jobTitle: getJobAnalysisTitle(jobAnalysis),
    skillsJSON: JSON.stringify(promptSkills),
    hardSkillsJson: JSON.stringify(promptSkills),
    keywordsJson: JSON.stringify(augmentedPromptLists.keywords),
    keyResponsibilitiesJson: JSON.stringify(getResponsibilities(jobAnalysis)),
    domainKnowledge: JSON.stringify([
      ...getDomainKnowledge(jobAnalysis),
      jobAnalysis.jobMeta.industry,
      jobAnalysis.jobMeta.department,
    ]),
  };

  return promptValues;
}

export function parseTailoredResumeContent(
  content: string,
  profile: Profile,
  jobAnalysis: JobAnalysis
): TailoredContent {
  const jsonText = extractJSON(content);
  const parsed = JSON.parse(jsonText) as TailoredContent;
  const finalResult = normalizeTailoredContent(parsed, jobAnalysis, profile);
  const tailoringSourceText = getTailoringSourceText(jobAnalysis);

  const {
    confirmedSkills: confirmedSoftSkills,
    unconfirmedSkills: unconfirmedSoftSkills,
  } = reconcileSkillBuckets({
    extractedSkills: extractSoftSkills(tailoringSourceText),
    modelSkills: finalResult.softSkills,
    referenceSkills: softSkills,
    supplementSkills: supplimentSoftSkills,
    minimumCount: 5,
    finalizeSkills: finalizeSoftSkills,
  });
  return {
    ...finalResult,
    softSkills: confirmedSoftSkills,
    unconfirmedHardSkills: [],
    unconfirmedSoftSkills,
    skills: finalResult.hardSkills,
  };
}

function getProfileResumePromptId(profile: Profile): string {
  return profile.profileSettings?.resumePromptId?.trim() || DEFAULT_RESUME_PROMPT_ID;
}

function getProfileCoverLetterPromptId(profile: Profile): string {
  return profile.profileSettings?.coverLetterPromptId?.trim() || DEFAULT_COVER_LETTER_PROMPT_ID;
}

export async function tailorResume(
  profile: Profile,
  jobAnalysis: JobAnalysis,
  provider: AIProvider = DEFAULT_PROVIDER,
  modelName?: string,
  signal?: AbortSignal
): Promise<TailoredContent> {
  const promptId = getProfileResumePromptId(profile);
  const promptValues = buildTailorResumePromptValues(profile, jobAnalysis);
  const secondCallStartedAt = process.hrtime.bigint();
  const timing = resumeBuildTiming.get(jobAnalysis);
  if (timing) {
    console.log(`[Resume timing] Time between first LLM finish and second LLM start: ${formatDuration(timing.firstCallEndedAt, secondCallStartedAt)}`);
  }
  console.log(`[Resume timing] Second LLM call started: tailor resume (${provider}${modelName ? `/${modelName}` : ''})`);
  const content = await createPromptCompletion({
    promptId,
    // The prompt record can be a per-profile custom one; the timeout and the
    // usage bucket belong to the FEATURE, which is always this.
    callSite: DEFAULT_RESUME_PROMPT_ID,
    promptValues,
    fallbackProvider: provider,
    fallbackModelName: modelName,
    maxTokens: 11000,
    temperature: 0.2,
    responseFormat: 'json',
    useExactPromptId: true,
    // Appended to the user turn rather than concatenated onto the rendered
    // text, which is what it used to be. That concatenation only reached
    // providers taking a single flat string, so the instruction was silently
    // absent on the structured path - and the code below assumes the model
    // obeyed it, because skills are decided here, not by the model.
    appendToUserBody: FINAL_SKILL_OVERRIDE,
    signal,
  });
  const secondCallEndedAt = process.hrtime.bigint();
  console.log(`[Resume timing] Second LLM call finished in ${formatDuration(secondCallStartedAt, secondCallEndedAt)}`);

  try {
    return parseTailoredResumeContent(content, profile, jobAnalysis);
  } catch {
    console.error('Failed to parse model response:', content);
    throw new Error('Failed to parse tailored resume response');
  }
}

/**
 * Generate a cover letter body when no job description is provided.
 * Returns only the body text (no salutation or sign-off).
 */
export async function generateCoverLetter(
  profile: Profile,
  companyName: string,
  role: string,
  provider: AIProvider = DEFAULT_PROVIDER,
  modelName?: string,
  signal?: AbortSignal
): Promise<string> {
  const promptId = getProfileCoverLetterPromptId(profile);
  const promptValues = {
    profileJson: JSON.stringify(profile, null, 2),
    companyName,
    role,
  };
  const content = await createPromptCompletion({
    promptId,
    callSite: DEFAULT_COVER_LETTER_PROMPT_ID,
    promptValues,
    fallbackProvider: provider,
    fallbackModelName: modelName,
    maxTokens: 1500,
    // The only caller that wants sampling variety rather than determinism.
    // The CLI provider cannot honour it and says so once; pin this prompt to
    // the `claude` provider in the admin UI if the prose becomes too uniform.
    temperature: 0.7,
    responseFormat: 'text',
    useExactPromptId: true,
    signal,
  });
  return content.trim();
}

export async function extractTemplateFromPDF(
  pdfText: string,
  templateName: string,
  provider: AIProvider = DEFAULT_PROVIDER,
  signal?: AbortSignal
): Promise<{ html: string; css: string; sections: string[] }> {
  const promptValues = {
    pdfText,
    templateName,
  };
  const content = await createPromptCompletion({
    promptId: 'extract-template-from-pdf',
    signal,
    promptValues,
    fallbackProvider: provider,
    maxTokens: 8000,
    temperature: 0,
    responseFormat: 'json',
    useExactPromptId: true,
  });

  try {
    const jsonText = extractJSON(content);
    return JSON.parse(jsonText);
  } catch {
    console.error('Failed to parse model response:', content);
    throw new Error('Failed to parse template extraction response');
  }
}

export async function extractProfileFromResume(
  resumeText: string,
  provider: AIProvider = DEFAULT_PROVIDER,
  signal?: AbortSignal
): Promise<Omit<Profile, 'id' | 'createdAt' | 'updatedAt'>> {
  const promptValues = {
    resumeText,
  };
  const content = await createPromptCompletion({
    promptId: 'extract-profile-from-resume',
    signal,
    promptValues,
    fallbackProvider: provider,
    maxTokens: 4000,
    temperature: 0,
    responseFormat: 'json',
    useExactPromptId: true,
  });

  try {
    const jsonText = extractJSON(content);
    return JSON.parse(jsonText);
  } catch {
    console.error('Failed to parse model response:', content);
    throw new Error('Failed to parse profile extraction response');
  }
}

export { DEFAULT_PROVIDER };
