/**
 * The job fields a posting is classified into: ONE per posting, from this list
 * (owner decision J3), or `unclassified` when none fits.
 *
 * The owner's own map of software development, at bullet level. Ten of its
 * eleven areas are offered; area 9, the computer-science foundations (data
 * structures, compilers, complexity...), is not, because those are subjects a
 * posting asks a candidate to know rather than the job it is for.
 *
 * The ID is the identity and never changes once shipped: it is what the job
 * analysis stores, what the sheet's Job Field cell is derived from, and what
 * the Job Data Lake hashes a job on (Phase 7) - rewording a label must not
 * move a single stored job to another field, so labels are display only and
 * may be edited freely. A field that is retired keeps its id out of use for
 * ever, for the same reason an analysis migration never reuses a number.
 *
 * The list reaches the model as the analysis prompt's `[[jobFieldList]]`
 * (`renderJobFieldListForPrompt`), which is stable text: the prompt carries it
 * BEFORE the posting so a CLI's prompt cache can reuse it from one posting to
 * the next. The answer is checked against this list in code
 * (`normalizeJobFieldId`), so a field the model invents - or one from area 9 -
 * is stored as `unclassified`, never as itself.
 */

export type JobFieldArea = {
  /** The area's number in the owner's list. 9 is deliberately absent. */
  number: number;
  label: string;
};

export type JobField = {
  /** Stable for ever. Lower-case words joined by `-`. */
  id: string;
  label: string;
  /** What the owner's list says the field covers; shown to the model, not stored. */
  covers: string;
  area: number;
};

export const JOB_FIELD_AREAS: readonly JobFieldArea[] = [
  { number: 1, label: 'Building software (by platform or target)' },
  { number: 2, label: 'Data, AI and machine learning' },
  { number: 3, label: 'Infrastructure and operations' },
  { number: 4, label: 'Quality and testing' },
  { number: 5, label: 'Security' },
  { number: 6, label: 'Architecture and engineering practice' },
  { number: 7, label: 'Design, product and communication' },
  { number: 8, label: 'Process, management and business' },
  { number: 10, label: 'Industry-specific software' },
  { number: 11, label: 'Emerging areas' },
];

/** What a posting that fits none of the fields is stored as. Never merged into the lake, never paid. */
export const UNCLASSIFIED_JOB_FIELD_ID = 'unclassified';
export const UNCLASSIFIED_JOB_FIELD_LABEL = 'Unclassified';

function field(area: number, id: string, label: string, covers = ''): JobField {
  return { id, label, covers, area };
}

export const JOB_FIELDS: readonly JobField[] = [
  // 1. Building software (by platform or target)
  field(1, 'frontend', 'Frontend / web UI', 'HTML, CSS, JavaScript/TypeScript, frameworks like React, Vue, Angular and Svelte'),
  field(1, 'backend', 'Backend', 'APIs, business logic, databases, authentication, queues'),
  field(1, 'full-stack', 'Full-stack', 'frontend and backend together'),
  field(1, 'mobile', 'Mobile', 'iOS (Swift), Android (Kotlin), cross-platform (Flutter, React Native, .NET MAUI)'),
  field(1, 'desktop-apps', 'Desktop apps', 'Windows, macOS, Linux, using Electron, Qt or native toolkits'),
  field(1, 'game-development', 'Game development', 'gameplay, engines (Unity, Unreal, Godot), graphics, netcode, tools, audio'),
  field(1, 'embedded-firmware', 'Embedded and firmware', 'microcontrollers, RTOS, device drivers, IoT'),
  field(1, 'systems-programming', 'Systems programming', 'OS kernels, hypervisors, file systems, language runtimes'),
  field(1, 'cloud-native-serverless', 'Cloud-native and serverless', 'functions, containers, managed services'),
  field(1, 'ar-vr-xr', 'AR/VR/XR and spatial computing'),
  field(1, 'robotics-autonomous-systems', 'Robotics and autonomous systems', 'ROS, perception, motion planning, control'),
  field(1, 'blockchain-web3', 'Blockchain / Web3', 'smart contracts, protocols, wallets'),
  field(1, 'scientific-hpc', 'Scientific and high-performance computing', 'simulation, GPU and parallel programming'),
  field(1, 'quantum-software', 'Quantum software', 'algorithms, SDKs, compilers'),
  field(1, 'low-code-automation', 'Low-code, no-code and automation', 'workflow tools, RPA'),
  field(1, 'enterprise-platforms', 'Enterprise platforms', 'SAP, Salesforce, ServiceNow, Dynamics customization'),
  field(1, 'browser-engines-webassembly', 'Browser engines and WebAssembly'),

  // 2. Data, AI and machine learning
  field(2, 'data-engineering', 'Data engineering', 'pipelines, ETL/ELT, warehouses and lakehouses, streaming (Kafka, Spark)'),
  field(2, 'database-engineering', 'Database engineering', 'administration, modeling, query tuning, database internals'),
  field(2, 'analytics-engineering-bi', 'Analytics engineering and BI', 'dbt, dashboards, metrics layers'),
  field(2, 'data-science', 'Data science', 'statistics, experimentation, modeling'),
  field(2, 'ml-engineering', 'ML engineering', 'training, evaluating and deploying models'),
  field(2, 'mlops-llmops', 'MLOps / LLMOps', 'model serving, monitoring, versioning, evaluation pipelines'),
  field(2, 'ai-llm-applications', 'AI / LLM application engineering', 'RAG, agents, prompt and context engineering, evals, fine-tuning'),
  field(2, 'ml-specialties', 'ML specialties', 'computer vision, NLP, speech, recommender systems, reinforcement learning, search and information retrieval'),
  field(2, 'ai-safety-responsible-ai', 'AI safety and responsible AI', 'red-teaming, interpretability, fairness, governance'),
  field(2, 'data-governance-privacy', 'Data governance and privacy', 'lineage, catalogs, compliance'),

  // 3. Infrastructure and operations
  field(3, 'devops', 'DevOps', 'CI/CD, automation, deployment practices'),
  field(3, 'site-reliability-engineering', 'Site reliability engineering (SRE)', 'SLOs, incident response, capacity planning'),
  field(3, 'platform-engineering', 'Platform engineering', 'internal developer platforms'),
  field(3, 'cloud-engineering', 'Cloud engineering and architecture', 'AWS, Azure, GCP'),
  field(3, 'infrastructure-as-code', 'Infrastructure as code', 'Terraform, Pulumi, Ansible'),
  field(3, 'containers-orchestration', 'Containers and orchestration', 'Docker, Kubernetes'),
  field(3, 'observability', 'Observability', 'logging, metrics, tracing'),
  field(3, 'build-release-engineering', 'Build and release engineering', 'build systems, packaging, release management'),
  field(3, 'networking-cdn-edge', 'Networking, CDN and edge computing'),
  field(3, 'systems-administration-it-ops', 'Systems administration and IT operations'),
  field(3, 'finops', 'FinOps', 'cloud cost optimization'),
  field(3, 'developer-experience', 'Developer experience (DX)', 'internal tooling and developer productivity'),

  // 4. Quality and testing
  field(4, 'manual-testing-qa', 'Manual testing and QA'),
  field(4, 'test-automation-sdet', 'Test automation / SDET'),
  field(4, 'performance-load-testing', 'Performance and load testing'),
  field(4, 'accessibility-testing', 'Accessibility testing'),
  field(4, 'chaos-resilience-engineering', 'Chaos and resilience engineering'),
  field(4, 'static-analysis-formal-verification', 'Static analysis, fuzzing and formal verification'),
  field(4, 'safety-reliability-regulated', 'Safety and reliability engineering for regulated domains'),

  // 5. Security
  field(5, 'application-security', 'Application security', 'secure coding, code review for vulnerabilities'),
  field(5, 'devsecops', 'DevSecOps', 'SAST/DAST, dependency scanning in pipelines'),
  field(5, 'penetration-testing', 'Penetration testing and red/blue/purple teaming'),
  field(5, 'threat-modeling-security-architecture', 'Threat modeling and security architecture'),
  field(5, 'cryptography-engineering', 'Cryptography engineering'),
  field(5, 'identity-access-management', 'Identity and access management (IAM)'),
  field(5, 'cloud-container-security', 'Cloud and container security'),
  field(5, 'software-supply-chain-security', 'Software supply chain security', 'SBOMs, signing, provenance'),
  field(5, 'vulnerability-research', 'Vulnerability research, reverse engineering and malware analysis'),
  field(5, 'incident-response-forensics', 'Incident response and digital forensics'),
  field(5, 'privacy-engineering-compliance', 'Privacy engineering and compliance', 'GDPR, SOC 2, HIPAA, PCI-DSS'),

  // 6. Architecture and engineering practice
  field(6, 'software-architecture', 'Software architecture', 'system, solution and enterprise architecture, domain-driven design'),
  field(6, 'api-design', 'API design', 'REST, GraphQL, gRPC, event-driven APIs'),
  field(6, 'distributed-systems', 'Distributed systems', 'consistency, scaling, resilience'),
  field(6, 'microservices-event-driven', 'Microservices, monoliths and event-driven design'),
  field(6, 'concurrency-performance', 'Concurrency and performance optimization'),
  field(6, 'design-patterns-refactoring', 'Design patterns, clean code and refactoring'),
  field(6, 'legacy-modernization', 'Legacy modernization and migration'),
  field(6, 'version-control-code-review', 'Version control, code review, monorepos and branching strategies'),
  field(6, 'technical-debt-management', 'Technical debt management'),
  field(6, 'engineering-metrics', 'Engineering metrics', 'DORA and similar'),
  field(6, 'open-source', 'Open source', 'maintenance, licensing, community'),

  // 7. Design, product and communication
  field(7, 'ui-ux-design', 'UI/UX design, interaction design, UX research'),
  field(7, 'design-systems', 'Design systems'),
  field(7, 'accessibility', 'Accessibility (a11y)'),
  field(7, 'product-management', 'Product management and technical product management'),
  field(7, 'business-analysis', 'Business analysis and requirements engineering'),
  field(7, 'technical-writing', 'Technical writing and developer documentation'),
  field(7, 'developer-relations', 'Developer relations (DevRel)'),
  field(7, 'localization-internationalization', 'Localization and internationalization'),
  field(7, 'solutions-sales-support-engineering', 'Solutions engineering, sales engineering, customer and support engineering'),

  // 8. Process, management and business
  field(8, 'methodologies', 'Methodologies', 'Agile, Scrum, Kanban, XP, Lean, Waterfall, SAFe'),
  field(8, 'project-program-management', 'Project, program and technical program management'),
  field(8, 'engineering-management', 'Engineering management and technical leadership', 'staff/principal engineer, CTO'),
  field(8, 'estimation-planning-roadmapping', 'Estimation, planning and roadmapping'),
  field(8, 'it-service-management', 'IT service management', 'ITIL, governance'),
  field(8, 'software-licensing-ip-regulation', 'Software licensing, IP and regulation'),
  field(8, 'software-business', 'Software business', 'startups, pricing, monetization'),
  field(8, 'mentoring-hiring-education', 'Mentoring, hiring and engineering education'),

  // 10. Industry-specific software
  field(10, 'fintech-trading', 'Fintech and trading systems'),
  field(10, 'healthcare-it', 'Healthcare IT', 'HL7/FHIR, medical device software'),
  field(10, 'automotive', 'Automotive', 'AUTOSAR, software-defined vehicles'),
  field(10, 'aerospace-defense', 'Aerospace and defense', 'safety-critical, DO-178C'),
  field(10, 'telecom', 'Telecom', '5G, network functions'),
  field(10, 'ecommerce-edtech-govtech-legaltech', 'E-commerce, EdTech, GovTech, LegalTech'),
  field(10, 'geospatial-gis', 'Geospatial / GIS'),
  field(10, 'energy-smart-grid', 'Energy and smart grid'),
  field(10, 'digital-twins-simulation', 'Digital twins and simulation'),
  field(10, 'bioinformatics', 'Bioinformatics and computational biology'),
  field(10, 'media-tech', 'Media tech', 'audio/DSP, video codecs and streaming, creative tools'),
  field(10, 'green-software', 'Green and sustainable software'),

  // 11. Emerging areas
  field(11, 'ai-assisted-agentic-development', 'AI-assisted and agentic development', 'coding agents, context engineering, reviewing AI-generated code'),
  field(11, 'agent-platforms-tool-protocols', 'Agent platforms and tool-integration protocols', 'e.g., MCP'),
  field(11, 'edge-ai-on-device-ml', 'Edge AI and on-device ML'),
  field(11, 'confidential-computing-pets', 'Confidential computing and privacy-enhancing technologies'),
  field(11, 'post-quantum-cryptography-migration', 'Post-quantum cryptography migration'),
  field(11, 'webgpu-wasm-runtimes', 'WebGPU and WebAssembly-based runtimes'),
];

const BY_ID = new Map(JOB_FIELDS.map((entry) => [entry.id, entry]));
const BY_LABEL = new Map(JOB_FIELDS.map((entry) => [foldLabel(entry.label), entry]));

function foldLabel(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** True for an id in the list. `unclassified` is not one: it is the absence of one. */
export function isJobFieldId(value: unknown): value is string {
  return typeof value === 'string' && BY_ID.has(value);
}

/**
 * What the model answered, as a field id - or `unclassified`.
 *
 * The id itself, case and surrounding space forgiven; or, because a model
 * sometimes echoes the label it was shown rather than the id beside it, the
 * label exactly (case and spacing forgiven). Nothing looser: a near miss is
 * a field the model was not offered, and storing a guess would put a posting
 * in the wrong field for ever, where `unclassified` merely keeps it out of
 * the lake.
 */
export function normalizeJobFieldId(value: unknown): string {
  if (typeof value !== 'string') return UNCLASSIFIED_JOB_FIELD_ID;
  const trimmed = value.trim().toLowerCase();
  if (BY_ID.has(trimmed)) return trimmed;
  return BY_LABEL.get(foldLabel(value))?.id ?? UNCLASSIFIED_JOB_FIELD_ID;
}

/** A field's display label; `Unclassified` for anything not in the list. */
export function jobFieldLabel(id: unknown): string {
  return (typeof id === 'string' && BY_ID.get(id)?.label) || UNCLASSIFIED_JOB_FIELD_LABEL;
}

/**
 * The list as the analysis prompt shows it: one `id: Label - what it covers`
 * line per field, under its area's heading.
 *
 * A pure function of this module, so it is byte-identical for every posting -
 * which is what lets it sit in the cached part of the prompt.
 */
export function renderJobFieldListForPrompt(): string {
  const lines: string[] = [];
  for (const area of JOB_FIELD_AREAS) {
    lines.push(`${area.label}:`);
    for (const entry of JOB_FIELDS.filter((candidate) => candidate.area === area.number)) {
      lines.push(`- ${entry.id}: ${entry.label}${entry.covers ? ` (${entry.covers})` : ''}`);
    }
  }
  lines.push(`- ${UNCLASSIFIED_JOB_FIELD_ID}: none of the above fits`);
  return lines.join('\n');
}

/** The list as a page shows it: `GET /api/resume/job-fields`. */
export function listJobFieldsForClient(): {
  areas: Array<{ number: number; label: string }>;
  fields: Array<{ id: string; label: string; area: number }>;
  unclassified: { id: string; label: string };
} {
  return {
    areas: JOB_FIELD_AREAS.map((area) => ({ ...area })),
    fields: JOB_FIELDS.map(({ id, label, area }) => ({ id, label, area })),
    unclassified: { id: UNCLASSIFIED_JOB_FIELD_ID, label: UNCLASSIFIED_JOB_FIELD_LABEL },
  };
}
