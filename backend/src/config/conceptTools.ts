/**
 * Concepts a posting names, and the tools they are built with - the tailoring
 * prompt's `[[conceptToolsJson]]`.
 *
 * The prompt says: "A CONCEPT BECOMES THE TOOL IT IS BUILT WITH". A posting
 * asks for "CI/CD" or "observability", which nobody installs; the skills block
 * the model writes must carry a product instead, chosen to sit with the rest of
 * the candidate's stack, and the concept itself goes into a sentence. This
 * table is what the model is shown for that choice: for each concept the
 * posting named, the tools it is ordinarily built with.
 *
 * Closed and in code, like config/jobFields.ts: an administrator edits the
 * prompt, not the table, and the table is part of what the tailoring cache
 * keys on only through the values it renders (services/tailorCache.ts).
 *
 * A row is sent when one of its `aliases` is found in a term of the posting's
 * analysis - any of its lists, the responsibilities included - as a whole word,
 * case-insensitively (an alias of one or two characters, `CI`, `ML`, `BI`,
 * case-sensitively, so "ci" inside a word never counts). The prompt says the
 * list "is NOT exhaustive"; a concept with no row is the model's to judge.
 *
 * The order of `tools` here is a plain default: the code SHUFFLES each row's
 * tools per resume, seeded by the source resume and the posting
 * (services/tailorContract.ts), because the prompt tells the model to take the
 * first of two that fit equally "and that order is shuffled for each request,
 * so two candidates do not come back with the same block".
 */
export type ConceptToolRow = {
  /** The concept as this table names it; the model is sent the posting's own spelling instead. */
  concept: string;
  /** Spellings that identify the concept in a posting's terms. */
  aliases: readonly string[];
  tools: readonly string[];
};

export const CONCEPT_TOOLS: readonly ConceptToolRow[] = [
  {
    concept: 'CI/CD',
    aliases: ['CI/CD', 'continuous integration', 'continuous delivery', 'continuous deployment', 'CI', 'CD pipelines', 'build pipelines', 'deployment pipelines'],
    tools: ['GitHub Actions', 'Jenkins', 'GitLab CI', 'CircleCI', 'Buildkite', 'Azure Pipelines'],
  },
  {
    concept: 'containerization',
    aliases: ['containerization', 'containerisation', 'containerized', 'containerised', 'containers'],
    tools: ['Docker', 'Podman', 'containerd', 'Buildah'],
  },
  {
    concept: 'container orchestration',
    aliases: ['container orchestration', 'container platforms', 'container scheduling'],
    tools: ['Kubernetes', 'Amazon ECS', 'OpenShift', 'Nomad', 'Docker Swarm'],
  },
  {
    concept: 'infrastructure as code',
    aliases: ['infrastructure as code', 'infrastructure-as-code', 'IaC'],
    tools: ['Terraform', 'Pulumi', 'AWS CloudFormation', 'AWS CDK', 'Bicep'],
  },
  {
    concept: 'observability',
    aliases: ['observability'],
    tools: ['Datadog', 'Grafana', 'OpenTelemetry', 'Honeycomb', 'New Relic'],
  },
  {
    concept: 'monitoring',
    aliases: ['monitoring', 'alerting', 'metrics collection'],
    tools: ['Prometheus', 'Grafana', 'Datadog', 'Amazon CloudWatch', 'New Relic', 'Zabbix'],
  },
  {
    concept: 'logging',
    aliases: ['logging', 'log aggregation', 'log management', 'centralized logging', 'centralised logging'],
    tools: ['ELK Stack', 'Splunk', 'Grafana Loki', 'Fluentd', 'Graylog'],
  },
  {
    concept: 'tracing',
    aliases: ['tracing', 'distributed tracing', 'APM', 'application performance monitoring'],
    tools: ['OpenTelemetry', 'Jaeger', 'Zipkin', 'Datadog APM', 'AWS X-Ray'],
  },
  {
    concept: 'incident response',
    aliases: ['incident response', 'incident management', 'on-call', 'on call', 'production support'],
    tools: ['PagerDuty', 'Opsgenie', 'incident.io', 'Atlassian Statuspage'],
  },
  {
    concept: 'vector databases',
    aliases: ['vector database', 'vector databases', 'vector store', 'vector stores', 'vector search'],
    tools: ['Pinecone', 'pgvector', 'Weaviate', 'Milvus', 'Qdrant', 'Chroma'],
  },
  {
    concept: 'message queues',
    aliases: ['message queue', 'message queues', 'message broker', 'message brokers', 'message queuing', 'messaging systems'],
    tools: ['RabbitMQ', 'Amazon SQS', 'ActiveMQ', 'Google Cloud Pub/Sub', 'NATS'],
  },
  {
    concept: 'event streaming',
    aliases: ['event streaming', 'stream processing', 'streaming data', 'data streaming', 'real-time streaming', 'event-driven'],
    tools: ['Apache Kafka', 'Amazon Kinesis', 'Apache Flink', 'Apache Pulsar', 'Confluent'],
  },
  {
    concept: 'caching',
    aliases: ['caching', 'in-memory cache', 'distributed cache', 'cache layer'],
    tools: ['Redis', 'Memcached', 'Amazon ElastiCache', 'Varnish'],
  },
  {
    concept: 'search',
    // Never a bare "search engine": it is how "Search Engine Optimization"
    // and "search engine marketing" begin, and an SEO posting is not asking
    // for Elasticsearch.
    aliases: ['full-text search', 'search infrastructure', 'search indexing', 'search platform'],
    tools: ['Elasticsearch', 'OpenSearch', 'Apache Solr', 'Algolia', 'Typesense'],
  },
  {
    concept: 'data warehouse',
    aliases: ['data warehouse', 'data warehouses', 'data warehousing', 'lakehouse'],
    tools: ['Snowflake', 'BigQuery', 'Amazon Redshift', 'Databricks', 'ClickHouse'],
  },
  {
    concept: 'ETL / data pipelines',
    aliases: ['ETL', 'ELT', 'data pipeline', 'data pipelines', 'data ingestion', 'data integration'],
    tools: ['dbt', 'Apache Spark', 'Fivetran', 'AWS Glue', 'Airbyte'],
  },
  {
    concept: 'workflow orchestration',
    aliases: ['workflow orchestration', 'pipeline orchestration', 'data orchestration', 'job scheduling', 'workflow scheduling'],
    tools: ['Apache Airflow', 'Dagster', 'Prefect', 'Temporal', 'AWS Step Functions'],
  },
  {
    concept: 'feature flags',
    aliases: ['feature flags', 'feature flag', 'feature flagging', 'feature toggles'],
    tools: ['LaunchDarkly', 'Unleash', 'Flagsmith', 'Split'],
  },
  {
    concept: 'secrets management',
    aliases: ['secrets management', 'secret management', 'secrets handling'],
    tools: ['HashiCorp Vault', 'AWS Secrets Manager', 'Azure Key Vault', 'Doppler'],
  },
  {
    concept: 'service mesh',
    aliases: ['service mesh', 'service meshes'],
    tools: ['Istio', 'Linkerd', 'Consul', 'AWS App Mesh'],
  },
  {
    concept: 'API gateway',
    aliases: ['API gateway', 'API gateways', 'API management'],
    tools: ['Kong', 'Amazon API Gateway', 'Apigee', 'Tyk', 'NGINX'],
  },
  {
    concept: 'unit testing',
    aliases: ['unit testing', 'unit tests', 'TDD', 'test-driven development'],
    tools: ['Jest', 'pytest', 'JUnit', 'Vitest', 'Mocha', 'xUnit'],
  },
  {
    concept: 'end-to-end testing',
    aliases: ['end-to-end testing', 'e2e testing', 'E2E', 'UI testing', 'browser testing', 'integration testing', 'test automation', 'automated testing'],
    tools: ['Playwright', 'Cypress', 'Selenium', 'WebdriverIO', 'Puppeteer'],
  },
  {
    concept: 'load testing',
    aliases: ['load testing', 'performance testing', 'stress testing', 'capacity testing'],
    tools: ['k6', 'Apache JMeter', 'Gatling', 'Locust', 'Artillery'],
  },
  {
    concept: 'version control',
    aliases: ['version control', 'source control', 'source code management'],
    tools: ['Git', 'GitHub', 'GitLab', 'Bitbucket'],
  },
  {
    concept: 'backend frameworks',
    aliases: ['backend frameworks', 'backend framework', 'back-end frameworks', 'server-side frameworks', 'web frameworks'],
    tools: ['Spring Boot', 'Django', 'FastAPI', 'Express', 'NestJS', 'Ruby on Rails', 'ASP.NET Core'],
  },
  {
    concept: 'frontend frameworks',
    aliases: ['frontend frameworks', 'frontend framework', 'front-end frameworks', 'UI frameworks', 'JavaScript frameworks', 'SPA frameworks'],
    tools: ['React', 'Angular', 'Vue.js', 'Svelte', 'Next.js'],
  },
  {
    concept: 'mobile frameworks',
    aliases: ['mobile frameworks', 'cross-platform mobile', 'mobile development', 'mobile app development', 'mobile application development'],
    tools: ['React Native', 'Flutter', 'SwiftUI', 'Jetpack Compose', 'Kotlin Multiplatform'],
  },
  {
    concept: 'relational databases',
    aliases: ['relational databases', 'relational database', 'RDBMS', 'SQL databases'],
    tools: ['PostgreSQL', 'MySQL', 'Microsoft SQL Server', 'Oracle Database', 'MariaDB'],
  },
  {
    concept: 'NoSQL databases',
    aliases: ['NoSQL', 'NoSQL databases', 'document databases', 'document stores', 'key-value stores'],
    tools: ['MongoDB', 'Amazon DynamoDB', 'Apache Cassandra', 'Couchbase', 'Firestore'],
  },
  {
    concept: 'cloud platforms',
    aliases: ['cloud platforms', 'cloud platform', 'cloud infrastructure', 'cloud services', 'public cloud', 'cloud computing'],
    tools: ['AWS', 'Microsoft Azure', 'Google Cloud Platform'],
  },
  {
    concept: 'serverless',
    aliases: ['serverless', 'FaaS', 'functions as a service'],
    tools: ['AWS Lambda', 'Azure Functions', 'Google Cloud Functions', 'Cloudflare Workers'],
  },
  {
    concept: 'microservices',
    aliases: ['microservices', 'microservice architecture', 'service-oriented architecture', 'SOA'],
    tools: ['Docker', 'Kubernetes', 'gRPC', 'Spring Boot', 'NestJS'],
  },
  {
    concept: 'LLM frameworks',
    aliases: ['LLM frameworks', 'LLM orchestration', 'LLM applications', 'RAG', 'retrieval-augmented generation', 'AI agents', 'agent frameworks', 'LLMs', 'large language models', 'generative AI', 'GenAI'],
    tools: ['LangChain', 'LlamaIndex', 'LangGraph', 'Semantic Kernel', 'Hugging Face Transformers', 'OpenAI API'],
  },
  {
    concept: 'ML frameworks',
    aliases: ['machine learning', 'ML', 'ML frameworks', 'deep learning', 'model training'],
    tools: ['PyTorch', 'TensorFlow', 'scikit-learn', 'XGBoost', 'Keras'],
  },
  {
    concept: 'MLOps',
    aliases: ['MLOps', 'ML pipelines', 'model deployment', 'model serving', 'model monitoring', 'ML infrastructure'],
    tools: ['MLflow', 'Kubeflow', 'Amazon SageMaker', 'Weights & Biases', 'Vertex AI'],
  },
  {
    concept: 'data visualization / BI',
    aliases: ['data visualization', 'data visualisation', 'business intelligence', 'BI', 'dashboards', 'dashboarding'],
    tools: ['Tableau', 'Power BI', 'Looker', 'Apache Superset', 'Metabase'],
  },
  {
    concept: 'identity and access management',
    aliases: ['identity and access management', 'IAM', 'single sign-on', 'SSO', 'access control', 'authentication', 'authorization'],
    tools: ['Okta', 'Auth0', 'Keycloak', 'AWS IAM', 'Microsoft Entra ID'],
  },
  {
    concept: 'security scanning',
    aliases: ['security scanning', 'vulnerability scanning', 'SAST', 'DAST', 'static analysis', 'dependency scanning', 'application security'],
    tools: ['Snyk', 'SonarQube', 'Trivy', 'Checkmarx', 'OWASP ZAP', 'Dependabot'],
  },
  {
    concept: 'configuration management',
    aliases: ['configuration management', 'config management'],
    tools: ['Ansible', 'Chef', 'Puppet', 'SaltStack'],
  },
  {
    concept: 'package / build tools',
    aliases: ['build tools', 'build systems', 'build automation', 'package management', 'package managers', 'dependency management'],
    tools: ['Gradle', 'Maven', 'npm', 'Webpack', 'Bazel', 'Vite'],
  },
];

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `term` as a whole word or phrase, the way every tailoring check reads one:
 * not inside a longer word (letters and digits on either side end a match,
 * punctuation does not, so `CI/CD`, `C++` and `Node.js` match as written),
 * any run of spaces matching any other, and case-insensitive - except a term
 * of one or two characters (`Go`, `R`, `CI`, `ML`), matched as the posting
 * spells it so it is not found inside ordinary prose.
 */
export function termPattern(term: string, global = false): RegExp | null {
  const normalized = term.trim().replace(/\s+/g, ' ');
  if (!normalized) return null;
  const body = escapeRegex(normalized).replace(/ /g, '\\s+');
  const flags = `${normalized.length <= 2 ? '' : 'i'}${global ? 'g' : ''}`;
  return new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, flags);
}

/**
 * The rows the posting's terms name, each once, in the order the terms first
 * name them, with `concept` spelled as the posting spells it: the text the
 * alias matched inside the first term that named the row ("CI/CD" out of
 * "CI/CD pipelines", "incident response" out of "incident response
 * ownership"). `tools` in the table's order; the caller shuffles them.
 */
export function conceptRowsFor(terms: readonly string[]): Array<{ concept: string; tools: string[] }> {
  const found = new Map<ConceptToolRow, string>();
  for (const term of terms) {
    for (const row of CONCEPT_TOOLS) {
      if (found.has(row)) continue;
      for (const alias of row.aliases) {
        const match = termPattern(alias)?.exec(term);
        if (match) {
          found.set(row, match[0].replace(/\s+/g, ' '));
          break;
        }
      }
    }
  }
  return [...found.entries()].map(([row, concept]) => ({ concept, tools: [...row.tools] }));
}
