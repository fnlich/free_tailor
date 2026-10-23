const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const path = require('node:path');

const { useAdminEmails, useTempStorage } = require('./helpers');

/**
 * A resume's keywords (services/resumeKeywords.ts): the technologies, tools and
 * concepts it claims and the kinds of role it is titled for, which the matcher
 * (services/resumeMatch.ts) reads to choose the suitable resume of a profile
 * for a posting. Written from the F2 contract (F2/contract.md section 2.3 and
 * section 3: "Keywords are computed, never stored, never read from a body,
 * excluded from resumeFingerprint, export and prompt JSON") and design G2
 * section (a) and (f), less everything about a STORED copy - there is none.
 *
 * Shape of the file:
 *   - the pure extraction needs no server: sources, the prose class rules, the
 *     vocabulary, caps, determinism;
 *   - the memo (`matchKeywordsOf`) and what it never does (write back);
 *   - one shared server for the routes: a body never sets keywords, the two
 *     GETs serve them derived, an import recomputes them;
 *   - nothing here sleeps, spawns a model or touches the network.
 */

useTempStorage('resume-keywords');
useAdminEmails('admin@example.com');

const keywords = require('../dist/services/resumeKeywords');
const resumeDocument = require('../dist/services/resumeDocument');
const contract = require('../dist/services/tailorContract');
const skillsDb = require('../dist/database/skillsDatabase');

const T0 = '2026-01-01T00:00:00.000Z';

/** A resume document; every field the extraction may read can be given in `extra`. */
function resume(extra = {}) {
  return {
    id: 'kw-1',
    name: 'Jane Doe',
    title: '',
    summary: '',
    skills: [],
    experience: [],
    education: [],
    createdAt: T0,
    updatedAt: T0,
    ...extra,
  };
}

const termsOf = (extra) => keywords.keywordsOf(resume(extra)).terms;
const lower = (list) => list.map((term) => term.toLowerCase());

/** A role with a description or bullets; the company is only there to be left alone. */
function role(extra = {}) {
  return { title: 'Engineer', company: 'Acme', startDate: '2020-01', endDate: '2022-01', ...extra };
}

/* ====================================================================== titles */

test('a bare resume\'s keywords are its titles: the kind of role the headline and each held title name, and no terms', () => {
  const out = keywords.keywordsOf(
    resume({
      title: 'Backend Engineer',
      experience: [role({ title: 'Backend Engineer' }), role({ title: 'Senior Software Engineer II' })],
    })
  );
  assert.deepEqual(out.terms, []);
  assert.deepEqual(out.headline, ['Backend Engineer']);
  // roleKind: levels off the edges (Senior, II), never a word inside the title.
  assert.deepEqual(out.roleTitles, ['Backend Engineer', 'Software Engineer']);
  assert.equal(out.version, keywords.KEYWORDS_VERSION);
  assert.match(out.vocabulary, /^[0-9a-f]{16}$/);
  assert.match(out.basedOn, /^[0-9a-f]{64}$/);
});

test('the normaliser\'s placeholder headline "Professional", or no headline, counts as no title', () => {
  assert.deepEqual(keywords.keywordsOf(resume({ title: 'Professional' })).headline, []);
  assert.deepEqual(keywords.keywordsOf(resume({ title: ' professional ' })).headline, []);
  assert.deepEqual(keywords.keywordsOf(resume({ title: '' })).headline, []);
  assert.deepEqual(keywords.keywordsOf(resume({})).roleTitles, []);
});

test('role titles are listed in resume order, repeats dropped case-insensitively, at most twelve; a headline can name two kinds', () => {
  const repeated = keywords.keywordsOf(
    resume({ experience: [role({ title: 'Backend Engineer' }), role({ title: 'backend engineer' }), role({ title: 'Data Engineer' })] })
  );
  assert.deepEqual(repeated.roleTitles, ['Backend Engineer', 'Data Engineer']);

  const many = keywords.keywordsOf(
    resume({ experience: Array.from({ length: 20 }, (_, index) => role({ title: `Role${index} Engineer` })) })
  );
  assert.equal(many.roleTitles.length, 12);
  assert.equal(many.roleTitles[0], 'Role0 Engineer');

  assert.deepEqual(keywords.keywordsOf(resume({ title: 'Backend Engineer | Platform Engineer' })).headline, [
    'Backend Engineer',
    'Platform Engineer',
  ]);
});

/* ================================================================ curated terms */

test('curated terms come first, in the person\'s order and the vocabulary\'s spelling; role skills follow; synonym repeats and unfit entries are dropped', () => {
  const out = termsOf({
    skills: ['go', 'kubernetes', 'terraform', 'node.js'],
    experience: [role({ skills: ['Docker', 'GO'] })],
  });
  // `go` is `Go`, `kubernetes` is `Kubernetes`: the shipped list's spelling.
  assert.deepEqual(out.slice(0, 5), ['Go', 'Kubernetes', 'Terraform', 'Node.js', 'Docker']);
  assert.equal(out.length, 5, 'GO on a role is Go again');

  // Two spellings of one thing are one term; the first spelling stays.
  const synonyms = termsOf({ skills: ['Golang', 'Go', 'K8s', 'Kubernetes', 'Postgres', 'PostgreSQL', 'JS', 'JavaScript'] });
  assert.deepEqual(synonyms.map(keywords.synonymKey), [
    keywords.synonymKey('Go'),
    keywords.synonymKey('Kubernetes'),
    keywords.synonymKey('PostgreSQL'),
    keywords.synonymKey('JavaScript'),
  ]);
  assert.equal(synonyms[0], 'Golang');
  assert.equal(synonyms.length, 4);

  // 60 characters stay; 61, empty and letterless entries do not.
  const sixty = 'x'.repeat(60);
  assert.deepEqual(termsOf({ skills: [sixty, 'y'.repeat(61), '', '   ', '###', '--'] }), [sixty]);
});

test('one-letter C and R come only from Skills, never from prose', () => {
  assert.deepEqual(termsOf({ skills: ['C', 'R'] }), ['C', 'R']);
  assert.deepEqual(termsOf({ summary: 'Wrote C and R code for years.', experience: [role({ description: 'Mostly C.' })] }), []);
});

/* ================================================================ the prose scan */

test('prose technologies are taken in first-appearance order, from every field the revise pass reads as evidence', () => {
  const out = termsOf({
    summary: 'Built services in Python.',
    skills: [],
    skillCategories: [{ category: 'Stores: Cassandra', skills: [] }],
    strengths: [{ title: 'Owner', description: 'Ran Elasticsearch clusters.' }],
    experience: [role({ description: 'Operated Redis caches.', achievements: ['Cut cost by moving to Rust.'] })],
    certifications: [{ name: 'Certified Kubernetes Administrator', issuer: 'CNCF' }],
    projects: [{ name: 'Open source Terraform modules', description: 'Wrote Haskell tooling.', achievements: ['Added Docker support.'] }],
    volunteering: [{ role: 'Mentor', organization: 'Code Club', description: 'Taught Scala to students.' }],
    courses: [{ name: 'Intro to Erlang' }],
    awards: [{ title: 'Best Kafka use', description: '' }],
    publications: [{ title: 'On Nginx tuning', description: '' }],
  });
  assert.deepEqual(lower(out), [
    'python',
    'cassandra',
    'elasticsearch',
    'redis',
    'rust',
    'kubernetes',
    'terraform',
    'haskell',
    'docker',
    'scala',
    'erlang',
    'kafka',
    'nginx',
  ]);
});

test('the name, contact, company fields, education, languages, interests, references, custom sections and soft skills are never read', () => {
  const out = termsOf({
    name: 'Kafka Docker',
    contact: { email: 'kafka@terraform.example', location: 'Kubernetes', linkedin: 'https://linkedin.com/in/python' },
    experience: [role({ company: 'Kafka Inc', location: 'Redis', description: 'Built Go services.' })],
    education: [{ degree: 'Terraform', institution: 'Docker University', field: 'Rust' }],
    languages: [{ name: 'Scala', level: 'native' }],
    interests: ['Haskell', 'Erlang'],
    references: [{ name: 'Elixir', company: 'Swift' }],
    customSections: [{ key: 'x', title: 'Cassandra', entries: [{ title: 'Nginx', description: 'Redis' }] }],
    softSkills: ['Elasticsearch', 'Swift'],
    resumeSettings: { includeSoftSkills: true },
  });
  assert.deepEqual(out, ['Go'], 'only the role\'s own sentence about its work');
});

test('a sentence about the company yields no technology; the person\'s own sentence beside it does', () => {
  const description = 'Acme is a fintech platform built on Kafka.\nBuilt the ledger in Go.';
  assert.deepEqual(termsOf({ experience: [role({ company: 'Acme', description })] }), ['Go']);
  // On one line, too: it is dropped sentence by sentence.
  assert.deepEqual(
    termsOf({ experience: [role({ company: 'Acme', description: 'Acme is a fintech platform built on Kafka. Built the ledger in Go.' })] }),
    ['Go']
  );
  // The same sentence under another company is not about that company: it is the person's.
  assert.deepEqual(
    lower(termsOf({ experience: [role({ company: 'Other', description: 'Acme is a fintech platform built on Kafka.' })] })),
    ['kafka']
  );
});

test('ordinary words of the shipped list are not skills: "Kind regards", "express interest", "rest of the team", a lowercase "spring"', () => {
  assert.deepEqual(termsOf({ summary: 'Kind regards\nexpress interest\nrest of the team\nthe spring semester' }), []);
  assert.deepEqual(termsOf({ experience: [role({ achievements: ['Kind regards to all.', 'We express interest in the rest.'] })] }), []);
  // And the names that ARE technologies, spelled as technologies, are taken.
  assert.deepEqual(termsOf({ summary: 'Built Express APIs on AWS.' }).slice(0, 3), ['Express', 'APIs', 'AWS']);
});

test('"Go-live" and a sentence-opening "Go" are not Go; "Go" in a stack line or mid-sentence is', () => {
  assert.deepEqual(termsOf({ summary: 'Go-live went well.' }), []);
  assert.deepEqual(termsOf({ summary: 'The Go-live went well.' }), []);
  assert.deepEqual(termsOf({ summary: 'Go is a language.' }), []);
  assert.deepEqual(termsOf({ summary: 'Shipped it. Go services followed.' }), []);
  assert.deepEqual(termsOf({ summary: '- Go services' }), [], 'a bullet\'s first word is a sentence start');
  assert.deepEqual(termsOf({ summary: 'Stack: Go' }), ['Go'], 'a colon does not end a sentence');
  assert.deepEqual(termsOf({ summary: 'Wrote services in Go.' }), ['Go']);
  assert.deepEqual(termsOf({ summary: '* Wrote Go services' }), ['Go']);
  // Exact case: the language is not the verb.
  assert.deepEqual(termsOf({ summary: 'Wrote services in go.' }), []);
});

test('short names with a digit or symbol (S3, C#) are taken in their own case only', () => {
  assert.deepEqual(termsOf({ summary: 'Stored files in S3 using C#.' }), ['S3', 'C#']);
  assert.deepEqual(termsOf({ summary: 'stored files in s3 using c#.' }), []);
});

test('a two-letter concept alias (CI) is exact-case: "CI" is taken, "ci" is not', () => {
  assert.deepEqual(termsOf({ summary: 'We run CI daily.' }), ['CI']);
  assert.deepEqual(termsOf({ summary: 'we run ci daily' }), []);
});

test('concept aliases of three characters or more match in any case ("Monitoring", "MICROSERVICES")', () => {
  assert.deepEqual(lower(termsOf({ summary: 'Monitoring and MICROSERVICES.' })), ['monitoring', 'microservices']);
  assert.deepEqual(lower(termsOf({ summary: 'monitoring and microservices.' })), ['monitoring', 'microservices']);
  assert.ok(lower(termsOf({ summary: 'Dashboards for Monitoring' })).includes('monitoring'));
});

/* ====================================== sentence starts, synonym spellings (matcher-1, matcher-2) */

const scanned = (text) => keywords.scanVocabulary(text).map((hit) => hit.term.spelling);

test('a requirement list names one technology per line or bullet: a Title-case name at a line, bullet or numbered item start is taken', () => {
  assert.deepEqual(termsOf({ summary: '- Python experience' }), ['Python']);
  assert.deepEqual(termsOf({ summary: 'Requirements:\nKubernetes\nTerraform' }), ['Kubernetes', 'Terraform']);
  assert.deepEqual(termsOf({ summary: '* Helm\n- Prometheus\n• Redis' }), ['Helm', 'Prometheus', 'Redis']);
  assert.deepEqual(scanned('1. Kubernetes\n2. Docker'), ['Kubernetes', 'Docker']);
  assert.deepEqual(scanned('1) Terraform'), ['Terraform']);
  // After "e.g." / "etc." / "i.e." the ". " reads as a sentence end.
  assert.deepEqual(scanned('container orchestration (e.g. Kubernetes or Nomad)'), ['container orchestration', 'Kubernetes', 'Nomad']);
  assert.deepEqual(scanned('Cloud tooling, e.g. Terraform and Docker'), ['Terraform', 'Docker']);
  assert.deepEqual(scanned('languages such as Java, etc. Python is a plus'), ['Java', 'Python']);
  assert.deepEqual(scanned('We use Kubernetes. Docker is a must.'), ['Kubernetes', 'Docker']);
  assert.deepEqual(termsOf({ experience: [role({ achievements: ['Airflow DAGs for 150 jobs', 'Snowflake warehouse'] })] }), ['Airflow', 'Snowflake']);
});

test('the everyday words of the title class are still refused at a sentence start, and taken anywhere else in it', () => {
  for (const text of [
    'Kind regards',
    'Kind regards, the team',
    'Express yourself',
    'Spring is here',
    'Swift Developer wanted',
    'Testing is hard',
    'Analysis of the requirements',
    'The rest of the stack. Go-live is in spring.',
    '- Go services',
    'American Express is hiring.',
  ]) {
    assert.deepEqual(scanned(text), [], text);
  }
  // Lower case is the everyday word whatever the place.
  for (const text of ['react to change', 'the rust belt', 'kind of', 'the spring semester', 'developing with swift changes']) {
    assert.deepEqual(scanned(text), [], text);
  }
  // Mid-sentence, the same names are technologies.
  assert.deepEqual(scanned('Built Express APIs on AWS.'), ['Express', 'APIs', 'AWS']);
  assert.deepEqual(scanned('Stack: Spring, Kafka'), ['Spring', 'Kafka']);
  assert.deepEqual(scanned('Fast Express server'), ['Express']);
  assert.deepEqual(scanned('Experience with Kind clusters'), ['Kind']);
  assert.deepEqual(scanned('We value Testing and Debugging'), ['Testing', 'Debugging']);
  // "Mr. Python" is a sentence start by the rule's own reading; Python is no everyday word, so it is taken.
  assert.deepEqual(scanned('Mr. Python wrote this'), ['Python']);
  // One-letter C and R are only ever curated.
  assert.deepEqual(scanned('- C\n- R'), []);
});

test('SENTENCE_START_AMBIGUOUS is pinned: the list is a decision, so changing it is a diff here', () => {
  const pinned = [
    'ada', 'analysis', 'apex', 'artillery', 'assembly', 'aurora', 'automation', 'bamboo', 'beam', 'behave',
    'benchmarking', 'blockchain', 'bun', 'calico', 'chef', 'chroma', 'closures', 'clustering', 'compression',
    'concurrency', 'confluent', 'consul', 'copilot', 'crystal', 'cybersecurity', 'debugging', 'denormalization',
    'deserialization', 'doppler', 'echo', 'ember', 'emotion', 'encryption', 'envoy', 'expo', 'express', 'falcon',
    'fiber', 'flux', 'generics', 'gin', 'hack', 'harbor', 'hashing', 'hive', 'honeycomb', 'hugo', 'idempotency',
    'immutability', 'indexing', 'infrastructure', 'insomnia', 'jasmine', 'julia', 'kind', 'kong', 'less',
    'lighthouse', 'linting', 'lit', 'logs', 'macros', 'math', 'metaprogramming', 'migrations', 'mocking', 'monolith',
    'namespaces', 'node', 'nomad', 'normalization', 'packer', 'pagination', 'paging', 'parallelism', 'parcel',
    'partitioning', 'phoenix', 'pony', 'presto', 'prettier', 'promises', 'puppet', 'quantization', 'queuing',
    'realm', 'refactoring', 'reflection', 'relay', 'remix', 'render', 'replication', 'ribbon', 'rocket', 'runbooks',
    'scheme', 'sed', 'semaphore', 'sentry', 'serialization', 'sharding', 'split', 'spring', 'spying', 'statistics',
    'streams', 'stubbing', 'subnets', 'subnetting', 'swift', 'temporal', 'testing', 'threading', 'throttling',
    'traceability', 'transactions', 'triggers', 'unleash', 'vapor', 'varnish', 'vault', 'vector', 'warp',
    'waterfall', 'webhooks', 'zig',
  ];
  assert.deepEqual([...keywords.SENTENCE_START_AMBIGUOUS].sort(), pinned);
  for (const word of pinned) assert.equal(word, word.toLowerCase());
});

test('every Title-case name of the shipped list is taken at a sentence start unless it is in the ambiguous set - and always taken mid-sentence', () => {
  const shipped = require('../static/skills/skills.json').hard.map((item) => (typeof item === 'string' ? item : item.skill));
  let checked = 0;
  for (const skill of shipped) {
    const info = keywords.describeTerm(skill);
    if (info.cls !== 'title') continue;
    checked += 1;
    const atStart = scanned(`${skill} is a must`).map((spelling) => spelling.toLowerCase());
    const ambiguous = keywords.SENTENCE_START_AMBIGUOUS.has(skill.toLowerCase());
    assert.equal(atStart.includes(skill.toLowerCase()), !ambiguous, `${skill} at a sentence start`);
    // A line that is only the name is a list item, ambiguous or not.
    assert.ok(scanned(`Requirements:\n- ${skill}\n`).map((spelling) => spelling.toLowerCase()).includes(skill.toLowerCase()), `${skill} as a bullet`);
    assert.ok(scanned(`We use ${skill} daily.`).map((spelling) => spelling.toLowerCase()).includes(skill.toLowerCase()), `${skill} mid-sentence`);
  }
  assert.ok(checked > 300, `${checked} title-class names checked`);
});

test('every spelling of a synonym group is found in a posting, and is the same term as its canonical one', () => {
  assert.deepEqual(scanned('Worked with K8s clusters'), ['K8s']);
  assert.equal(keywords.synonymKey('K8s'), keywords.synonymKey('Kubernetes'));
  assert.deepEqual(scanned('We run Golang services on K8s with Postgres.'), ['Golang', 'K8s', 'Postgres']);
  assert.deepEqual(scanned('Stack: Golang, K8s, Postgres, Mongo, gRPC.'), ['Golang', 'K8s', 'Postgres', 'Mongo', 'gRPC']);
  assert.deepEqual(scanned('React Native and Vue'), ['React Native', 'Vue']);
  assert.deepEqual(scanned('Our stack is NodeJS and Amazon Web Services or Google Cloud.'), ['NodeJS', 'Amazon Web Services', 'Google Cloud']);
  assert.deepEqual(scanned('CSharp and dotnet, plus sklearn'), ['CSharp', 'dotnet', 'sklearn']);
  assert.deepEqual(scanned('Fluent in JS/TS, HTML5, CSS3 and Python3; ES6 a plus'), ['JS', 'TS', 'HTML5', 'CSS3', 'Python3', 'ES6']);
  for (const [spelling, canonical] of [
    ['Golang', 'Go'], ['NodeJS', 'Node.js'], ['Node', 'Node.js'], ['Vue', 'Vue.js'], ['Mongo', 'MongoDB'], ['Amazon Web Services', 'AWS'],
    ['Google Cloud', 'GCP'], ['CSharp', 'C#'], ['dotnet', '.NET'], ['sklearn', 'scikit-learn'], ['TS', 'TypeScript'],
    ['HTML5', 'HTML'], ['CSS3', 'CSS'], ['Python3', 'Python'], ['ES6', 'JavaScript'], ['Spark', 'Apache Spark'],
  ]) {
    assert.equal(keywords.synonymKey(spelling), keywords.synonymKey(canonical), `${spelling} is ${canonical}`);
  }
  // A resume that says K8s and one that says Kubernetes have one term between them.
  assert.deepEqual(termsOf({ summary: 'Ran K8s clusters and Kubernetes upgrades.' }), ['K8s']);
});

test('the synonym spellings keep the class rules: lower-case go / node prose is not a technology, "Node" mid-sentence is, "TS/SCI" is not TypeScript', () => {
  assert.deepEqual(scanned('Looking for Node devs and node experience'), ['Node']);
  assert.deepEqual(scanned('we go to node and spark joy'), []);
  assert.deepEqual(scanned('Wrote services in go and shipped them'), []);
  assert.deepEqual(scanned('Node is a graph word'), [], 'a sentence-opening Node is the everyday word');
  assert.deepEqual(scanned('Active TS/SCI clearance required'), []);
  assert.deepEqual(scanned('Cleared (TS/SCI) and fluent in TS'), ['TS']);
  assert.deepEqual(scanned('Node.js and Node'), ['Node.js', 'Node'], 'a standalone Node elsewhere is still a hit');
  // Spark is the Apache project in a requirement list.
  assert.deepEqual(scanned('- Spark\n- Airflow'), ['Spark', 'Airflow']);
  assert.deepEqual(scanned('we spark joy'), []);
});

test('isVocabularyTerm: a whole entry, whatever its spelling (CI/CD, TCP/IP, A/B testing, K8s); not a compound of two', () => {
  for (const term of ['CI/CD', 'TCP/IP', 'A/B testing', 'K8s', 'Kubernetes', 'kubernetes']) assert.equal(keywords.isVocabularyTerm(term), true, term);
  for (const term of ['Go (Golang)', 'Go/Golang', 'Node.js/Express', 'Zorblaxian', '']) assert.equal(keywords.isVocabularyTerm(term), false, term);
});

test('the keywords version is 4 (list items and requirements at a sentence start): bump it by hand when the extraction changes', () => {
  assert.equal(keywords.KEYWORDS_VERSION, 4);
});

test('a refused name is taken at a sentence start when it reads as a list item or a requirement: a whole line, a list separator, a cue', () => {
  // (a) The whole line, after an optional bullet or number.
  for (const text of ['- Go', '- TS', '1. Swift', '* Node', '- Node', 'Express', 'Requirements:\nSwift', 'Requirements:\n- Go\n- Docker\n- PostgreSQL', '• Swift (iOS)', '- Go,']) {
    assert.ok(scanned(text).length > 0, `${JSON.stringify(text)} -> ${JSON.stringify(scanned(text))}`);
  }
  assert.deepEqual(scanned('Requirements:\n- Go\n- Docker\n- PostgreSQL'), ['Go', 'Docker', 'PostgreSQL']);
  assert.deepEqual(scanned('Requirements:\nSwift'), ['Swift']);
  assert.deepEqual(scanned('1. Swift\n2. TS'), ['Swift', 'TS']);
  assert.deepEqual(scanned('- Node'), ['Node']);
  // (b) A list separator and another technology.
  assert.deepEqual(scanned('Go, Docker'), ['Go', 'Docker']);
  assert.deepEqual(scanned('Go,'), ['Go']);
  assert.deepEqual(scanned('Go/Docker'), ['Go', 'Docker']);
  assert.deepEqual(scanned('Swift and Objective-C'), ['Swift', 'Objective-C']);
  assert.deepEqual(scanned('TS or JS'), ['TS', 'JS']);
  assert.deepEqual(scanned('Go & Rust'), ['Go', 'Rust']);
  assert.deepEqual(scanned('Go: 3 years'), ['Go']);
  assert.deepEqual(scanned('(e.g. Go or Rust)'), ['Go', 'Rust']);
  // (c) A requirement cue.
  assert.deepEqual(scanned('Swift required.'), ['Swift']);
  assert.deepEqual(scanned('Build iOS apps for millions of users. Swift required.'), ['Swift']);
  assert.deepEqual(scanned('Go experience a must'), ['Go']);
  assert.deepEqual(scanned('Node is a plus'), ['Node']);
  assert.deepEqual(scanned('TS preferred'), ['TS']);
  assert.deepEqual(scanned('Swift proficiency and Spring knowledge'), ['Swift', 'Spring']);
});

test('the sentence-start guards still hold: prose that opens with a technology-named word is not that technology', () => {
  for (const text of [
    'Kind regards',
    'rest of the stack',
    'Go-live',
    'Go to market',
    'Go ahead',
    'Go live next week',
    'Spring is here',
    'Swift reply',
    'Swift Developer wanted',
    'Swift development team',
    'Go developer',
    'Express yourself',
    'Express delivery',
    'American Express is hiring',
    'Make sure',
    'Teams of five',
    'Box lunch',
    'Drive to the office',
    'Vault of heaven',
    'Storm warning',
    'Pig farm',
    'Chef de cuisine',
    'Salt and pepper',
    'Unity of purpose',
    'Access to a car',
    'Word of mouth',
    'Ant colony',
    'Excel in a team',
    'Kind, caring people',
    'Swift, reliable delivery',
    'Spring and summer',
    'Kind and thoughtful',
    'Go and see',
    'Swift and go home',
    'Hello. Go',
  ]) {
    assert.deepEqual(scanned(text), [], text);
  }
  // Lower case is the everyday word even where a list item would be taken.
  for (const text of ['- go', 'go,', 'node required', '- node', 'go and rust', 'swift required.']) assert.deepEqual(scanned(text), [], text);
  // Mid-sentence behaviour is unchanged.
  assert.deepEqual(scanned('Wrote Swift required forms'), ['Swift']);
});

/* ========================================================================= vocabulary */

test('the prose is scanned against the SHIPPED list, whatever TAILOR_STATIC_DIR holds; a skill added to the live library is not a keyword', () => {
  // useTempStorage points TAILOR_STATIC_DIR at an empty directory, and the
  // shipped list is still found: it is read from the checkout, not from there.
  assert.ok(lower(termsOf({ summary: 'Used Terraform and Haskell.' })).includes('haskell'));

  skillsDb.ensureSkillsDatabase();
  assert.equal(skillsDb.addSkill('hard', 'Zorblaxian', {}).added, true);
  assert.ok(skillsDb.readSkills('hard').includes('Zorblaxian'));
  // Any builder can add to the live library (POST /resume/skills/confirm): that
  // must not move another account's keywords.
  assert.deepEqual(termsOf({ summary: 'Wrote services with Zorblaxian and Terraform.' }).map((term) => term.toLowerCase()), [
    'terraform',
  ]);
  // Typed in Skills, it is the person's own claim and stays, as typed.
  assert.deepEqual(termsOf({ skills: ['Zorblaxian'] }), ['Zorblaxian']);
});

test('the vocabulary seam replaces the shipped list; its fingerprint moves with it, and an unreadable list falls back to the concept table with one warning', () => {
  const before = keywords.keywordsOf(resume({ summary: 'Used Wumpus and Terraform.' }));
  try {
    keywords.setMatchVocabularyForTests(['Wumpus']);
    const after = keywords.keywordsOf(resume({ summary: 'Used Wumpus and Terraform.' }));
    assert.deepEqual(after.terms, ['Wumpus', 'Terraform'], 'the replacement list is read; the concept table\'s tools stay');
    assert.notEqual(after.vocabulary, before.vocabulary);
    assert.equal(after.basedOn, before.basedOn, 'basedOn is about the resume, not the vocabulary');
  } finally {
    keywords.setMatchVocabularyForTests(null);
  }
  assert.equal(keywords.keywordsOf(resume({ summary: 'Used Wumpus and Terraform.' })).vocabulary, before.vocabulary);

  // A shipped list that is missing: the concept table alone, one warning, no throw.
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    keywords.setMatchVocabularyFileForTests(path.join(__dirname, 'does-not-exist', 'skills.json'));
    const out = keywords.keywordsOf(resume({ summary: 'Used Haskell, Terraform and Kubernetes.' }));
    assert.deepEqual(lower(out.terms), ['terraform', 'kubernetes'], 'Haskell is the library\'s; Terraform and Kubernetes are the concept tools\'');
    keywords.keywordsOf(resume({ summary: 'Used Terraform.' }));
    assert.equal(warnings.length, 1, 'warned once');
    assert.match(warnings[0], /shipped skill list/);
    // The memoised read goes through the same path and still answers.
    assert.ok(keywords.matchKeywordsOf(resume({ id: 'fallback-1', summary: 'Used Terraform.' })).terms.length >= 1);
  } finally {
    console.warn = realWarn;
    keywords.setMatchVocabularyFileForTests(null);
  }
  assert.ok(lower(keywords.keywordsOf(resume({ summary: 'Used Haskell.' })).terms).includes('haskell'));
});

/* =============================================================================== caps */

test('terms are capped at 80, each at most 60 characters, and curated terms are never displaced by scanned ones', () => {
  const curated = Array.from({ length: 100 }, (_, index) => `Tool${String(index).padStart(3, '0')}`);
  const only = termsOf({ skills: curated });
  assert.equal(only.length, 80);
  assert.deepEqual(only, curated.slice(0, 80));

  // 79 curated, then the scanned ones: the first scanned fills the 80th place, the rest do not fit.
  const out = termsOf({ skills: curated.slice(0, 79), summary: 'Used Terraform and Docker.' });
  assert.equal(out.length, 80);
  assert.deepEqual(out.slice(0, 79), curated.slice(0, 79));
  assert.equal(out[79], 'Terraform');

  // Fewer curated: they come first, scanned follow.
  assert.deepEqual(termsOf({ skills: ['Tool001'], summary: 'Used Terraform and Docker.' }), ['Tool001', 'Terraform', 'Docker']);
  for (const term of termsOf({ skills: ['y'.repeat(60)], summary: 'Used Terraform.' })) assert.ok(term.length <= 60);
});

/* ================================================================ determinism, basedOn */

test('the output is deterministic; basedOn moves with a source field and not with the name, contact, education, settings, order or profile', () => {
  const base = resume({
    title: 'Backend Engineer',
    summary: 'Used Terraform.',
    skills: ['Go'],
    experience: [role({ title: 'Backend Engineer', description: 'Ran Kafka.', achievements: ['Cut cost.'], skills: ['Docker'] })],
    contact: { email: 'a@example.com', phone: '1', location: 'Remote' },
    education: [{ degree: 'BSc', institution: 'Uni' }],
    resumeSettings: { includeStrengths: true },
    sectionOrder: [],
  });
  const first = keywords.keywordsOf(base);
  assert.deepEqual(keywords.keywordsOf(JSON.parse(JSON.stringify(base))), first, 'same resume, same answer');
  assert.equal(JSON.stringify(keywords.keywordsOf(base)), JSON.stringify(first));

  const same = {
    'the name': { name: 'Someone Else' },
    'the contact': { contact: { email: 'b@example.com', phone: '2', location: 'Paris' } },
    'the education': { education: [{ degree: 'MSc', institution: 'Other' }] },
    'the settings': { resumeSettings: { includeStrengths: false, technicalSkillsLayout: 'flat' } },
    'the section order': { sectionOrder: ['skills', 'summary'] },
    'the profile it is filed under': { profileId: 'person-9' },
    'the time it was saved': { updatedAt: '2027-01-01T00:00:00.000Z' },
    'its id': { id: 'another-id' },
    'its interests': { interests: ['Chess'] },
  };
  for (const [what, change] of Object.entries(same)) {
    assert.equal(keywords.keywordsOf({ ...base, ...change }).basedOn, first.basedOn, `${what} is not read`);
  }
  const moves = {
    'the headline': { title: 'Data Engineer' },
    'the summary': { summary: 'Used Terraform!' },
    'a skill': { skills: ['Go', 'Rust'] },
    'a role title': { experience: [{ ...base.experience[0], title: 'Platform Engineer' }] },
    'a role description': { experience: [{ ...base.experience[0], description: 'Ran Kafka!' }] },
    'a role bullet': { experience: [{ ...base.experience[0], achievements: ['Cut costs.'] }] },
    'a role skill': { experience: [{ ...base.experience[0], skills: ['Podman'] }] },
  };
  for (const [what, change] of Object.entries(moves)) {
    assert.notEqual(keywords.keywordsOf({ ...base, ...change }).basedOn, first.basedOn, `${what} is read`);
  }
});

/* ====================================================================== the memo */

test('matchKeywordsOf is a memo keyed by id and updatedAt: a hit is the same answer, a save (a new updatedAt) is computed afresh, and nothing is written back', () => {
  const stored = resume({ id: 'memo-1', summary: 'Used Terraform.', updatedAt: T0 });
  const snapshot = JSON.parse(JSON.stringify(stored));

  const first = keywords.matchKeywordsOf(stored);
  assert.deepEqual(first, keywords.keywordsOf(stored));
  assert.equal(keywords.matchKeywordsOf(stored), first, 'a second ask is the memoised answer');
  assert.equal(keywords.matchKeywordsOf({ ...stored }), first, 'a copy of the same id and time is the same key');

  // Never written back: the resume is as it was, with no keywords on it.
  assert.deepEqual(stored, snapshot);
  assert.equal('matchKeywords' in stored, false);
  assert.throws(() => first.terms.push('Injected'), TypeError, 'what the memo hands out cannot be changed by a caller');
  assert.equal(keywords.matchKeywordsOf(stored).terms.includes('Injected'), false);

  const saved = { ...stored, summary: 'Used Docker.', updatedAt: '2026-02-01T00:00:00.000Z' };
  const next = keywords.matchKeywordsOf(saved);
  assert.notEqual(next, first);
  assert.deepEqual(lower(next.terms), ['docker']);
  assert.equal(keywords.matchKeywordsOf(stored), first, 'the earlier time is still its own entry');

  assert.equal(Number.isInteger(keywords.KEYWORDS_VERSION) && keywords.KEYWORDS_VERSION >= 1, true);
  assert.equal(first.version, keywords.KEYWORDS_VERSION, 'the version is in the answer (and in the memo\'s key)');
});

test('the memo holds 512 entries, oldest out, and a read keeps an entry young', () => {
  assert.equal(keywords.MATCH_KEYWORDS_CACHE_SIZE, 512);
  const make = (index) => resume({ id: `lru-${index}`, summary: 'Used Terraform.', updatedAt: T0 });
  const answers = [];
  for (let index = 0; index < 512; index += 1) answers.push(keywords.matchKeywordsOf(make(index)));
  assert.equal(keywords.matchKeywordsOf(make(0)), answers[0], 'all 512 are held');
  // lru-0 was just read, so lru-1 is now the oldest: one more entry pushes lru-1 out.
  keywords.matchKeywordsOf(make(512));
  assert.equal(keywords.matchKeywordsOf(make(0)), answers[0], 'the entry read last survived');
  assert.notEqual(keywords.matchKeywordsOf(make(1)), answers[1], 'the oldest was computed afresh');
  assert.deepEqual(keywords.matchKeywordsOf(make(2)), answers[2], 'and an entry that was evicted is the same answer again');
});

test('a draft with no id or no time is answered but not memoised', () => {
  const draft = resume({ id: '', summary: 'Used Terraform.', updatedAt: '' });
  const first = keywords.matchKeywordsOf(draft);
  assert.deepEqual(lower(first.terms), ['terraform']);
  assert.notEqual(keywords.matchKeywordsOf(draft), first);
});

/* ====================================================== the builders, the render, the prompt */

const PLANTED = { version: 1, vocabulary: 'x', basedOn: 'y', headline: [], roleTitles: [], terms: ['COBOL'] };

test('the document builders store no keywords - a matchKeywords in the payload, or on the resume being updated, is not carried', () => {
  const sneaky = { name: 'Jane Doe', title: 'Engineer', skills: ['Go'], matchKeywords: PLANTED };
  const created = resumeDocument.buildNewResume(sneaky, 'built-1');
  assert.equal('matchKeywords' in created, false);

  const updated = resumeDocument.buildUpdatedResume({ ...created, matchKeywords: PLANTED }, { ...sneaky, summary: 'Edited.' });
  assert.equal('matchKeywords' in updated, false);
  assert.equal(updated.summary, 'Edited.');

  const previewed = resumeDocument.buildPreviewResume({ ...sneaky }, { ...created, matchKeywords: PLANTED });
  assert.equal('matchKeywords' in previewed, false, 'the preview runs on every pause in typing and works none out');
});

/** A resume as GET /api/resumes/:id serves it (keywords on it), for the places that must not pass them on. */
function servedResume() {
  return {
    ...resume({ title: 'Backend Engineer', summary: 'Used Terraform.', skills: ['Go'], experience: [role({ description: 'Ran Kafka.' })] }),
    matchKeywords: { ...PLANTED, terms: ['ZZSENTINEL', 'Go'] },
  };
}

test('what a template is drawn from never carries keywords (design G2 (a): "prepareResumeRenderData spreads the profile without matchKeywords")', () => {
  const { prepareResumeRenderData } = require('../dist/generators/pdfGenerator');
  const data = prepareResumeRenderData(servedResume());
  assert.equal('matchKeywords' in data, false, 'the render data');
  assert.doesNotMatch(JSON.stringify(data), /ZZSENTINEL/);
});

test('what the revise pass reads as evidence and what a model is told never carry keywords', () => {
  const { resumeEvidence } = require('../dist/services/reviseCoverage');
  const resumeService = require('../dist/services/resumeService');

  const served = servedResume();
  assert.doesNotMatch(resumeEvidence(served), /ZZSENTINEL|COBOL/);

  const analysis = {
    jobMeta: { title: 'Backend Engineer', seniority: '', industry: '', department: '' },
    skills: { technical: [], tools: ['Terraform'], soft: [] },
    technologies: ['Go'],
    protocols: [],
    methodologies: [],
    architecturePatterns: [],
    responsibilities: [],
    domainKnowledge: [],
    keywords: { actionVerbs: [], buzzwords: [], mustInclude: [] },
    sourceJobDescription: 'Backend Engineer. Go and Terraform.',
  };
  for (const mode of ['partial', 'full']) {
    const values = resumeService.buildTailorResumePromptValues(served, analysis, mode);
    const sent = JSON.stringify(values);
    assert.doesNotMatch(sent, /ZZSENTINEL/, `the ${mode} tailoring prompt's values`);
    assert.doesNotMatch(sent, /matchKeywords/, `the ${mode} tailoring prompt's values name no such field`);
  }
  const cover = JSON.stringify(resumeService.buildCoverLetterPromptValues(served, 'Acme', 'Backend Engineer'));
  assert.doesNotMatch(cover, /ZZSENTINEL|matchKeywords/, 'the cover letter prompt\'s values');
  // The shared projection of the posting's lists is the contract's, unchanged by any of it.
  assert.equal(typeof contract.postingTermLists, 'function');
});

/* ================================================================== the routes */

let worldPromise = null;
function world() {
  worldPromise ??= startWorld();
  return worldPromise;
}

async function startWorld() {
  const users = require('../dist/database/userRepository');
  const sqlite = require('../dist/database/sqlite');
  const { attachUser } = require('../dist/middleware/auth');
  const { publicErrorHandler } = require('../dist/middleware/publicError');

  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/resumes', require('../dist/routes/resumes').default);
  app.use(publicErrorHandler);
  const server = app.listen(0);
  const port = server.address().port;

  let counter = 0;
  const account = (label) => {
    counter += 1;
    const user = users.createUser({ email: `${label}-${counter}@example.com` });
    // Several people are filed in some tests; the limit is not under test here.
    users.updateUser(user.id, { subscription: 'premium-plus' });
    return { user, id: user.id, token: users.createSession(user.id) };
  };
  const call = async (who, method, route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${who.token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: response.status, body: parsed };
  };
  const row = (id) => sqlite.getDb().prepare('SELECT data, updated_at FROM resumes WHERE id = ?').get(id);
  const doc = (id) => JSON.parse(row(id).data);
  /** Writes a document straight into the table, as a hand edit or an older build would have left it. */
  const plant = (id, change) => {
    const current = row(id);
    const next = { ...JSON.parse(current.data), ...change };
    sqlite.getDb().prepare('UPDATE resumes SET data = ? WHERE id = ?').run(JSON.stringify(next), id);
  };
  // Not closed: the runner ends the process, and an open handle must not hold it.
  server.unref();
  return { account, call, row, doc, plant };
}

const person = (name, extra = {}) => ({
  name,
  title: 'Backend Engineer',
  summary: 'Used Terraform and Kubernetes in production.',
  skills: ['Go'],
  experience: [role({ title: 'Backend Engineer', description: 'Ran Kafka.' })],
  ...extra,
});

test('a matchKeywords in a POST or a PUT body is ignored: nothing of it is stored or answered', async () => {
  const w = await world();
  const who = w.account('post-put');

  const posted = await w.call(who, 'POST', '/api/resumes', person('Jane Doe', { matchKeywords: PLANTED }));
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  assert.equal('matchKeywords' in posted.body, false, 'the create answers the resume, not its keywords');
  assert.equal('matchKeywords' in w.doc(posted.body.id), false, 'and stores none');
  assert.doesNotMatch(w.row(posted.body.id).data, /COBOL/);

  const put = await w.call(who, 'PUT', `/api/resumes/${posted.body.id}`, person('Jane Doe', { summary: 'Edited.', matchKeywords: PLANTED }));
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal('matchKeywords' in put.body, false);
  assert.equal('matchKeywords' in w.doc(posted.body.id), false);
  assert.equal(w.doc(posted.body.id).summary, 'Edited.');
  assert.doesNotMatch(w.row(posted.body.id).data, /COBOL/);

  // And the keywords the GET serves are the resume's, not the body's.
  const got = await w.call(who, 'GET', `/api/resumes/${posted.body.id}`);
  assert.equal(got.status, 200);
  assert.equal(got.body.matchKeywords.terms.includes('COBOL'), false);
});

test('GET /api/resumes and GET /api/resumes/:id serve keywords derived from the resume now, and write nothing back', async () => {
  const w = await world();
  const who = w.account('get');

  const a = await w.call(who, 'POST', '/api/resumes', person('Jane Doe'));
  const b = await w.call(who, 'POST', '/api/resumes', { name: 'Jane Doe', title: 'Data Engineer', skills: ['Python'] });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);

  const before = { a: w.row(a.body.id), b: w.row(b.body.id) };
  const one = await w.call(who, 'GET', `/api/resumes/${a.body.id}`);
  assert.equal(one.status, 200);
  const served = one.body.matchKeywords;
  assert.ok(served, 'a single resume carries its keywords');
  assert.equal(served.version, keywords.KEYWORDS_VERSION);
  assert.deepEqual(served.headline, ['Backend Engineer']);
  assert.deepEqual(lower(served.terms), ['go', 'terraform', 'kubernetes', 'kafka']);
  const stored = w.doc(a.body.id);
  assert.deepEqual(served, JSON.parse(JSON.stringify(keywords.keywordsOf(stored))), 'it is exactly keywordsOf of the stored resume');

  const list = await w.call(who, 'GET', '/api/resumes');
  assert.equal(list.status, 200);
  const listed = Object.fromEntries(list.body.map((item) => [item.id, item]));
  assert.deepEqual(listed[a.body.id].matchKeywords, served);
  assert.deepEqual(listed[b.body.id].matchKeywords.headline, ['Data Engineer']);
  assert.deepEqual(listed[b.body.id].matchKeywords.terms, ['Python']);

  // Reads change nothing: the document and its time are what they were.
  assert.deepEqual({ a: w.row(a.body.id), b: w.row(b.body.id) }, before);
  assert.equal('matchKeywords' in w.doc(a.body.id), false);
});

test('a stored row with no keywords, or with a planted or older copy, is answered with the current ones; the row itself is untouched', async () => {
  const w = await world();
  const who = w.account('planted');
  const created = await w.call(who, 'POST', '/api/resumes', person('Jane Doe'));
  const id = created.body.id;

  // A hand edit (or an older build) left a copy with another version, vocabulary and terms.
  w.plant(id, { matchKeywords: { ...PLANTED, version: 0, vocabulary: 'old', basedOn: 'old' } });
  const rowBefore = w.row(id);

  const got = await w.call(who, 'GET', `/api/resumes/${id}`);
  assert.equal(got.status, 200);
  assert.equal(got.body.matchKeywords.version, keywords.KEYWORDS_VERSION);
  assert.notEqual(got.body.matchKeywords.vocabulary, 'old');
  assert.equal(got.body.matchKeywords.terms.includes('COBOL'), false);
  assert.deepEqual(lower(got.body.matchKeywords.terms), ['go', 'terraform', 'kubernetes', 'kafka']);

  const list = await w.call(who, 'GET', '/api/resumes');
  assert.equal(list.body.find((item) => item.id === id).matchKeywords.terms.includes('COBOL'), false);

  assert.deepEqual(w.row(id), rowBefore, 'the GETs did not save the resume');
});

test('an unreadable shipped list never fails a GET or a save', async () => {
  const w = await world();
  const who = w.account('missing-list');
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    keywords.setMatchVocabularyFileForTests(path.join(__dirname, 'does-not-exist', 'skills.json'));
    const created = await w.call(who, 'POST', '/api/resumes', person('Jane Doe'));
    assert.equal(created.status, 201);
    const got = await w.call(who, 'GET', `/api/resumes/${created.body.id}`);
    assert.equal(got.status, 200);
    assert.ok(Array.isArray(got.body.matchKeywords.terms));
    assert.equal((await w.call(who, 'GET', '/api/resumes')).status, 200);
    assert.equal(
      (await w.call(who, 'PUT', `/api/resumes/${created.body.id}`, person('Jane Doe', { summary: 'Edited.' }))).status,
      200
    );
  } finally {
    console.warn = realWarn;
    keywords.setMatchVocabularyFileForTests(null);
  }
  assert.equal(warnings.length, 1, 'one warning for the whole run');
});

test('an imported file\'s keywords are recomputed: a file as the GET serves it (or one that carries a COBOL) stores none', async () => {
  const w = await world();
  const who = w.account('import');

  const source = await w.call(who, 'POST', '/api/resumes', person('Jane Doe'));
  const served = (await w.call(who, 'GET', `/api/resumes/${source.body.id}`)).body;
  assert.ok(served.matchKeywords, 'the file a person would save holds the derived keywords');

  // The saved file, with a keyword list somebody edited by hand, and a second entry in the wrapper shape.
  const file = {
    resumes: [
      { ...served, id: 'imported-from-file', matchKeywords: { ...served.matchKeywords, terms: ['COBOL'] } },
      person('Jane Doe', { title: 'Data Engineer', matchKeywords: PLANTED }),
    ],
  };
  const imported = await w.call(who, 'POST', '/api/resumes/import', file);
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  assert.equal(imported.body.imported, 2);
  for (const entry of imported.body.resumes) {
    assert.equal('matchKeywords' in w.doc(entry.id), false, 'nothing of it is stored');
    assert.doesNotMatch(w.row(entry.id).data, /COBOL/);
    const got = await w.call(who, 'GET', `/api/resumes/${entry.id}`);
    assert.equal(got.body.matchKeywords.terms.includes('COBOL'), false);
    assert.deepEqual(got.body.matchKeywords, JSON.parse(JSON.stringify(keywords.keywordsOf(w.doc(entry.id)))));
  }
});

/* ----------------------------------------- longer names, company names, names that are no English word */

test('a name inside a longer name is not a hit of its own; a standalone mention elsewhere is', () => {
  const names = (text) => lower(keywords.scanVocabulary(text).map((hit) => hit.term.spelling));
  assert.ok(names('We run CI/CD pipelines.').includes('ci/cd'));
  assert.equal(names('We run CI/CD pipelines.').includes('ci'), false, 'CI inside CI/CD');
  assert.ok(names('Workflows on GitHub Actions.').includes('github actions'));
  assert.equal(names('Workflows on GitHub Actions.').includes('github'), false, 'GitHub inside GitHub Actions');
  assert.ok(names('Workflows on GitHub Actions; code lives on GitHub too.').includes('github'), 'GitHub on its own');
  assert.ok(names('We run CI/CD, and CI daily.').includes('ci'), 'CI on its own');
});

test('a company\'s name is not the technology it holds: "American Express" is not Express', () => {
  const names = (text) => keywords.scanVocabulary(text).map((hit) => hit.term.spelling);
  assert.deepEqual(names('American Express is hiring.'), []);
  assert.deepEqual(names('Worked at American Express on payments.'), []);
  assert.deepEqual(names('Built Express APIs on AWS.').slice(0, 1), ['Express']);
  assert.ok(names('American Express uses Express for its APIs.').includes('Express'), 'a real mention elsewhere');
});

test('names that are no English word are found in any case; everyday words still need their own', () => {
  const names = (text) => lower(keywords.scanVocabulary(text).map((hit) => hit.term.spelling));
  const casual = names('experience with docker and kubernetes and python');
  for (const name of ['docker', 'kubernetes', 'python']) assert.ok(casual.includes(name), `${name} in ${casual.join(', ')}`);
  const shout = names('EXPERIENCE WITH DOCKER AND KUBERNETES AND PYTHON');
  for (const name of ['docker', 'kubernetes', 'python']) assert.ok(shout.includes(name), `${name} in ${shout.join(', ')}`);
  assert.deepEqual(names('react to change, the rust belt, spring is here, kind regards, an express train'), []);
});
