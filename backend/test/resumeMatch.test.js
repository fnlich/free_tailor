const assert = require('node:assert/strict');
const test = require('node:test');

const { useTempStorage } = require('./helpers');

/**
 * Choosing the suitable resume of a profile for a posting
 * (services/resumeMatch.ts, reading services/resumeKeywords.ts). Written from
 * the F2 contract (F2/contract.md 2.3 and 2.10) and design G2 section (b) and
 * (f): the score S = 0.45 * T + 0.55 * R, R = 0.7 * core + 0.3 * rest, the
 * factor table, the tie order, the explanation, and the worked example the
 * owner's question came from - a bare "Backend Engineer" resume must beat the
 * profile's default "Data Engineer" resume for a Senior Backend Engineer
 * (Go, Kubernetes) posting, on the analysis path and on the text path.
 *
 * Pure: no database, no model, no server, nothing sleeps. Every resume of a
 * test has an id of its own, because the keywords are memoised by id and time.
 */

useTempStorage('resume-match');

const keywords = require('../dist/services/resumeKeywords');
const match = require('../dist/services/resumeMatch');
const contract = require('../dist/services/tailorContract');

/* ------------------------------------------------------------------- fixtures */

let counter = 0;
const uid = (label) => `${label}-${(counter += 1)}`;
const T0 = '2026-01-01T00:00:00.000Z';

/** A resume: a headline, the titles of its roles and its skills. */
function resume({ id, title = '', roles = [], skills = [], summary = '', updatedAt = T0 }) {
  return {
    id: id ?? uid('r'),
    name: 'Jane Doe',
    title,
    summary,
    skills,
    experience: roles.map((roleTitle) => ({ title: roleTitle, company: 'Somewhere' })),
    education: [],
    createdAt: T0,
    updatedAt,
  };
}

const candidate = (r, isDefault = false) => ({ resume: r, isDefault });

/** Keywords for a score of one term at a time: no titles, exactly these terms. */
const kw = (terms, extra = {}) => ({
  version: keywords.KEYWORDS_VERSION,
  vocabulary: 'test',
  basedOn: 'test',
  headline: [],
  roleTitles: [],
  terms,
  ...extra,
});

/** A job analysis in the analysis prompt's schema, everything empty unless given. */
function analysis({
  title = '',
  technologies = [],
  tools = [],
  technical = [],
  soft = [],
  protocols = [],
  methodologies = [],
  architecturePatterns = [],
  responsibilities = [],
  domainKnowledge = [],
  mustInclude = [],
  actionVerbs = [],
  buzzwords = [],
  text = '',
} = {}) {
  return {
    jobMeta: { title, seniority: '', industry: '', department: '' },
    skills: { technical, required: [], preferred: [], tools, soft, technologies: [] },
    technologies,
    protocols,
    methodologies,
    architecturePatterns,
    responsibilities,
    domainKnowledge,
    softSkills: [],
    keywords: { actionVerbs, buzzwords, mustInclude },
    sourceJobDescription: text,
  };
}

const closeTo = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? ''} expected ${expected}, got ${actual}`);

/* ----------------------------------------------------------- the worked example */

const POSTING_TEXT = [
  'Senior Backend Engineer (Go, Kubernetes)',
  'Acme Pay is hiring a backend engineer to build our payments platform.',
  'What you will do:',
  '- Design and run Go microservices on Kubernetes',
  '- Build REST APIs and gRPC services backed by PostgreSQL',
  'Requirements:',
  '- 5+ years building distributed systems in Go',
  '- Production experience with Kubernetes and Docker',
  '- PostgreSQL and gRPC',
  'Nice to have: Terraform, CI/CD, AWS',
].join('\n');

function workedAnalysis() {
  return analysis({
    title: 'Senior Backend Engineer (Go, Kubernetes)',
    technologies: ['Go', 'Kubernetes', 'Docker', 'PostgreSQL', 'gRPC'],
    tools: ['Terraform', 'AWS'],
    technical: ['distributed systems', 'REST APIs'],
    architecturePatterns: ['microservices'],
    methodologies: ['CI/CD'],
    mustInclude: ['Go', 'Kubernetes'],
    domainKnowledge: ['payments'],
    text: POSTING_TEXT,
  });
}

/** Resume A: bare, titled for the role. Resume B: the profile's default, a data engineer with a stack. */
const bare = () => resume({ id: uid('A'), title: 'Backend Engineer', roles: ['Backend Engineer', 'Software Engineer'] });
const dataEngineer = (extraSkills = []) =>
  resume({
    id: uid('B'),
    title: 'Data Engineer',
    roles: ['Data Engineer', 'Software Engineer'],
    skills: ['Python', 'Apache Spark', 'Airflow', 'AWS', 'Kubernetes', 'PostgreSQL', 'Docker', ...extraSkills],
    updatedAt: '2025-01-01T00:00:00.000Z',
  });

test('the worked example, with the analysis: the bare Backend Engineer resume beats the default Data Engineer resume', () => {
  const job = { analysis: workedAnalysis(), title: 'Senior Backend Engineer' };
  const A = bare();
  const B = dataEngineer();

  // The five the posting leans on, as the tailoring prompt is told them.
  assert.deepEqual(contract.postingTermLists(workedAnalysis()).topSkills, ['Go', 'Kubernetes', 'gRPC', 'PostgreSQL', 'Docker']);

  const scoreA = match.scoreResumeForJob(keywords.keywordsOf(A), job);
  const scoreB = match.scoreResumeForJob(keywords.keywordsOf(B), job);

  // A: T = 1 (backend 2 + engineer 1, all said), no terms. B: T = 1/3, three of the five top terms (3 x 1 of 15) and AWS (2)
  // plus microservices through Docker or Kubernetes (1 x 0.5) of the rest (2+2+2+2+1+1+1 = 11).
  closeTo(scoreA.score, 0.45 * 1 + 0.55 * 0, 'A');
  const rCoreB = 9 / 15;
  const rRestB = 2.5 / 11;
  closeTo(scoreB.score, 0.45 * (1 / 3) + 0.55 * (0.7 * rCoreB + 0.3 * rRestB), 'B');
  closeTo(scoreB.score, 0.4185, 'B, as the design states it');
  assert.equal(scoreA.titleMatched, true);
  assert.equal(scoreB.titleMatched, false);
  assert.deepEqual(scoreA.matched, []);
  assert.deepEqual(scoreB.matched, ['Kubernetes', 'PostgreSQL', 'Docker', 'AWS', 'microservices']);
  assert.equal(scoreB.matchedCount, 5);
  assert.equal(scoreA.postingTermCount, 12);
  assert.equal(scoreA.basis, 'analysis');

  // B listed first and flagged the profile's default: it is still not chosen.
  const chosen = match.chooseForJob(job, [candidate(B, true), candidate(A)], 'suitable');
  assert.equal(chosen.resume.id, A.id);
  assert.equal(chosen.match.reason, 'matched');
  assert.equal(chosen.match.basis, 'analysis');
  assert.equal(chosen.match.score, 0.45, 'the stored score is the 4-decimal figure');
  assert.equal(chosen.match.titleMatched, true);
  assert.deepEqual(chosen.match.matched, []);
  assert.equal(chosen.match.postingTermCount, 12);
  assert.equal(chosen.match.candidates, 2);
  assert.equal(chosen.match.mode, 'suitable');
  assert.equal(chosen.match.v, 1);
});

test('the worked example, with the analysis alone (the posting\'s own title is the role)', () => {
  const job = { analysis: workedAnalysis() };
  const A = bare();
  const B = dataEngineer();
  const chosen = match.chooseForJob(job, [candidate(B, true), candidate(A)], 'suitable');
  assert.equal(chosen.resume.id, A.id, '"Senior Backend Engineer (Go, Kubernetes)" names the kind "Backend Engineer"');
});

test('the worked example, with the analysis: B with Go and gRPC added is chosen', () => {
  const job = { analysis: workedAnalysis(), title: 'Senior Backend Engineer' };
  const A = bare();
  const B2 = dataEngineer(['Go', 'gRPC']);

  const scoreB2 = match.scoreResumeForJob(keywords.keywordsOf(B2), job);
  closeTo(scoreB2.score, 0.45 * (1 / 3) + 0.55 * (0.7 * 1 + 0.3 * (2.5 / 11)), 'B with Go and gRPC');
  closeTo(scoreB2.score, 0.5725, 'as the design states it');
  assert.deepEqual(scoreB2.matched.slice(0, 5), ['Go', 'Kubernetes', 'gRPC', 'PostgreSQL', 'Docker']);

  const chosen = match.chooseForJob(job, [candidate(A), candidate(B2, true)], 'suitable');
  assert.equal(chosen.resume.id, B2.id);
  assert.equal(chosen.match.reason, 'matched');
  assert.equal(chosen.match.score, 0.5725);
  assert.equal(chosen.match.titleMatched, false);
});

test('the worked example, from the text alone: the same two answers', () => {
  const job = { text: POSTING_TEXT, title: 'Senior Backend Engineer' };
  const A = bare();
  const B = dataEngineer();
  // Same id and a later time: the memo keys on both, so this is another resume's keywords.
  const B2 = { ...dataEngineer(['Go', 'gRPC']), id: B.id, updatedAt: '2025-06-01T00:00:00.000Z' };

  const first = match.chooseForJob(job, [candidate(B, true), candidate(A)], 'suitable');
  assert.equal(first.resume.id, A.id, 'the bare Backend Engineer resume, on the text path');
  assert.equal(first.match.reason, 'matched');
  assert.equal(first.match.basis, 'text');
  assert.equal(first.match.titleMatched, true);
  assert.equal(first.match.score, 0.45);

  const scoreB = match.scoreResumeForJob(keywords.keywordsOf(B), job);
  assert.ok(scoreB.score < first.match.score, 'B scores below A');
  // Design G2 states about 0.384 for B here (its hand count of the vocabulary's hits has twelve terms; the scan finds two more).
  assert.ok(Math.abs(scoreB.score - 0.384) < 0.02, `B about 0.384, got ${scoreB.score}`);
  assert.deepEqual(scoreB.matched.slice(0, 3).sort(), ['Docker', 'Kubernetes', 'PostgreSQL']);

  const second = match.chooseForJob(job, [candidate(A), candidate(B2, true)], 'suitable');
  assert.equal(second.resume.id, B2.id, 'B with Go and gRPC wins on the text path too');
  assert.ok(Math.abs(second.match.score - 0.521) < 0.02, `about 0.521, got ${second.match.score}`);
  assert.equal(second.match.basis, 'text');
  assert.ok(second.match.matched.includes('Go') && second.match.matched.includes('gRPC'));
});

test('with a role but no text, the title alone decides; with nothing at all every score is 0 and the default is built', () => {
  const A = bare();
  const B = dataEngineer();

  const byRole = match.chooseForJob({ title: 'Senior Backend Engineer' }, [candidate(B, true), candidate(A)], 'suitable');
  assert.equal(byRole.resume.id, A.id);
  assert.equal(byRole.match.basis, 'title');
  closeTo(byRole.match.score, 1);
  assert.equal(byRole.match.reason, 'matched');
  assert.equal(byRole.match.postingTermCount, 0);

  const scored = match.scoreResumeForJob(keywords.keywordsOf(B), { title: 'Senior Backend Engineer' });
  closeTo(scored.score, 0.7 * (1 / 3) + 0.3 * (1 / 3), 'B: T alone');

  const nothing = match.chooseForJob({}, [candidate(A), candidate(B, true)], 'suitable');
  assert.equal(nothing.resume.id, B.id, 'the default');
  assert.ok(['tie', 'default'].includes(nothing.match.reason), `reason ${nothing.match.reason}`);
  assert.equal(nothing.match.basis, 'none');
  assert.equal(nothing.match.score, 0);
  assert.equal(nothing.match.candidates, 2);
  closeTo(match.scoreResumeForJob(keywords.keywordsOf(A), {}).score, 0);
});

/* ------------------------------------------------------------------ the reasons */

test('each TaskMatch reason: matched, tie, only, default - and the mode is recorded on it', () => {
  const job = { analysis: analysis({ technologies: ['Zorblax'] }) };
  const hit = resume({ skills: ['Zorblax'] });
  const miss = resume({ skills: ['Wumpus'] });

  const matched = match.chooseForJob(job, [candidate(miss, true), candidate(hit)], 'suitable');
  assert.equal(matched.resume.id, hit.id);
  assert.equal(matched.match.reason, 'matched');
  assert.equal(matched.match.mode, 'suitable');

  const partial = match.chooseForJob(job, [candidate(miss, true), candidate(hit)], 'partial');
  assert.equal(partial.resume.id, hit.id, 'Partial Tailor chooses the same way');
  assert.equal(partial.match.mode, 'partial');
  assert.equal(partial.match.reason, 'matched');

  const twin = resume({ skills: ['Zorblax'] });
  const tie = match.chooseForJob(job, [candidate(twin), candidate(hit, true)], 'suitable');
  assert.equal(tie.match.reason, 'tie');
  assert.equal(tie.resume.id, hit.id, 'the default');

  const only = match.chooseForJob(job, [candidate(miss)], 'suitable');
  assert.equal(only.resume.id, miss.id);
  assert.deepEqual(only.match, { v: 1, mode: 'suitable', reason: 'only', candidates: 1 });

  // Fully Tailor builds the effective default whatever scores: by rule.
  const full = match.chooseForJob(job, [candidate(hit), candidate(miss, true)], 'full');
  assert.equal(full.resume.id, miss.id);
  assert.equal(full.match.reason, 'default');
  assert.equal(full.match.mode, 'full');
  assert.equal(full.match.candidates, 2);
  assert.equal('score' in full.match, false, 'nothing was scored');
});

test('nothing matching at all builds the default, as a tie', () => {
  const job = { analysis: analysis({ technologies: ['Zorblax', 'Quibbit'] }) };
  const a = resume({ skills: ['Wumpus'], updatedAt: '2026-03-01T00:00:00.000Z' });
  const b = resume({ skills: ['Gribble'], updatedAt: '2026-04-01T00:00:00.000Z' });
  const d = resume({ skills: ['Plinth'], updatedAt: '2026-01-01T00:00:00.000Z' });
  const out = match.chooseForJob(job, [candidate(a), candidate(b), candidate(d, true)], 'suitable');
  assert.equal(out.resume.id, d.id, 'the default, though it is the oldest');
  assert.equal(out.match.reason, 'tie');
  assert.equal(out.match.score, 0);
  assert.deepEqual(out.match.matched, []);
  assert.equal(out.match.matchedCount, 0);
  assert.equal(out.match.postingTermCount, 2);
});

test('an analysis that names no terms is read as the text it was made from; with neither but a title, the title decides', () => {
  const fromText = analysis({ title: '', text: 'We use Zorblax every day.' });
  const hit = resume({ skills: ['Zorblax'] });
  const miss = resume({ skills: ['Wumpus'] });
  const out = match.chooseForJob({ analysis: fromText }, [candidate(miss, true), candidate(hit)], 'suitable');
  assert.equal(out.resume.id, hit.id);
  assert.equal(out.match.basis, 'text');

  const titleOnly = match.chooseForJob(
    { analysis: analysis({ title: 'Backend Engineer' }) },
    [candidate(resume({ title: 'Data Engineer' }), true), candidate(resume({ title: 'Backend Developer' }))],
    'suitable'
  );
  assert.equal(titleOnly.match.basis, 'title');
  assert.equal(titleOnly.resume.title, 'Backend Developer', 'developer is the engineer head');
});

/* -------------------------------------------------------------------- tie order */

test('ties go to the default, then precision, then the newer resume, then the lower id - whatever order they are listed in', () => {
  const job = { analysis: analysis({ technologies: ['Zorblax'] }) };
  const orders = (list) => [list, [...list].reverse(), [list[1], list[0], ...list.slice(2)]];
  const winnerOf = (list) => {
    const ids = new Set();
    for (const order of orders(list)) ids.add(match.chooseForJob(job, order, 'suitable').resume.id);
    assert.equal(ids.size, 1, 'the winner does not depend on the order candidates came in');
    return [...ids][0];
  };
  const plain = (id, skills, updatedAt = T0) => resume({ id: uid(id), skills, updatedAt });

  // 1. The default, though it is the least precise and the oldest.
  const loose = plain('loose', ['Zorblax', 'Quibbit', 'Wumpus'], '2025-01-01T00:00:00.000Z');
  const precise = plain('precise', ['Zorblax'], '2026-06-01T00:00:00.000Z');
  assert.equal(winnerOf([candidate(precise), candidate(loose, true)]), loose.id);

  // 2. No default among them: the more precise (the share of its terms the posting names).
  assert.equal(winnerOf([candidate(precise), candidate(loose)]), precise.id);
  const result = match.chooseForJob(job, [candidate(precise), candidate(loose)], 'suitable');
  assert.equal(result.match.reason, 'tie');
  assert.equal(result.match.score, 1);

  // 3. Equal precision: the newer updatedAt.
  const newer = plain('newer', ['Zorblax'], '2026-09-01T00:00:00.000Z');
  const older = plain('older', ['Zorblax'], '2026-02-01T00:00:00.000Z');
  assert.equal(winnerOf([candidate(older), candidate(newer)]), newer.id);

  // 4. Everything equal: the lower id (plain string order).
  const lowId = resume({ id: 'tie-aaa-' + counter, skills: ['Zorblax'] });
  const highId = resume({ id: 'tie-bbb-' + counter, skills: ['Zorblax'] });
  assert.equal(winnerOf([candidate(highId), candidate(lowId)]), lowId.id);
});

test('a resume\'s size alone scores nothing; of equal matches the more precise wins', () => {
  const job = { analysis: analysis({ technologies: ['Zorblax', 'Quibbit', 'Wumpus', 'Gribble', 'Plinth'] }) };
  const huge = resume({ skills: Array.from({ length: 70 }, (_, index) => `Unrelated${index}`) });
  closeTo(match.scoreResumeForJob(keywords.keywordsOf(huge), job).score, 0, 'seventy terms the posting never names');

  const one = resume({ skills: ['Zorblax'] });
  const oneAmongMany = resume({ skills: ['Zorblax', ...Array.from({ length: 30 }, (_, index) => `Filler${index}`)] });
  const a = match.scoreResumeForJob(keywords.keywordsOf(one), job);
  const b = match.scoreResumeForJob(keywords.keywordsOf(oneAmongMany), job);
  closeTo(a.score, b.score, 'the same match is the same score');
  assert.ok(a.precision > b.precision);
  assert.equal(match.chooseForJob(job, [candidate(oneAmongMany), candidate(one)], 'suitable').resume.id, one.id);
  assert.equal(match.chooseForJob(job, [candidate(one), candidate(huge)], 'suitable').resume.id, one.id, 'a long list does not win on size');
});

/* ---------------------------------------------------------------------- factors */

/** The recall R of a resume holding `held` for a posting whose one technology is `term` (no titles: S = R). */
function factorOf(term, held) {
  return match.scoreResumeForJob(kw(held), { analysis: analysis({ technologies: [term] }) }).score;
}

test('the match factors: synonym and the resume being more specific 1.0, the resume less specific 0.6, a concept alias 0.8, a concept tool 0.5', () => {
  // 1.0: the same thing under another spelling.
  closeTo(factorOf('Golang', ['Go']), 1);
  closeTo(factorOf('Kubernetes', ['K8s']), 1);
  closeTo(factorOf('K8s', ['Kubernetes']), 1);
  closeTo(factorOf('PostgreSQL', ['Postgres']), 1);
  closeTo(factorOf('Zorblax', ['Zorblax']), 1);
  // 1.0: the posting's term is a whole word inside the resume's (the resume is more specific).
  closeTo(factorOf('AWS', ['AWS Lambda']), 1);
  // 0.6: the resume's term is inside the posting's (the posting is more specific).
  closeTo(factorOf('AWS Lambda', ['AWS']), 0.6);
  // 0.8: the resume term is an alias of a concept row the posting term names.
  closeTo(factorOf('CI/CD', ['continuous integration']), 0.8);
  closeTo(factorOf('continuous integration', ['CI/CD']), 0.8);
  closeTo(factorOf('CI/CD pipelines', ['continuous integration']), 0.8, 'a term that names the concept stands for it');
  // 0.5: the resume term is a tool of that row.
  closeTo(factorOf('CI/CD', ['Jenkins']), 0.5);
  closeTo(factorOf('microservices', ['Docker']), 0.5);
  closeTo(factorOf('CI/CD pipelines', ['Jenkins']), 0.5);
  // The best of them counts, not their sum.
  closeTo(factorOf('CI/CD', ['Jenkins', 'continuous integration', 'GitLab CI']), 0.8);
  // Nothing in common.
  closeTo(factorOf('Python', ['Java']), 0);
});

test('short names are matched whole and in their own case: "C" is not "C++", "Nx" is not "nx", "Go" is not "Gopher"', () => {
  closeTo(factorOf('C', ['C++']), 0);
  closeTo(factorOf('C++', ['C']), 0);
  closeTo(factorOf('Nx', ['nx']), 0);
  closeTo(factorOf('Nx', ['Nx']), 1);
  closeTo(factorOf('Go', ['Gopher']), 0);
  closeTo(factorOf('Go', ['Go']), 1);
});

test('the score formula: S = 0.45 T + 0.55 R, R = 0.7 core + 0.3 rest, core = the five and the must-include (3 each), skills 2, concepts and domain 1', () => {
  const job = {
    title: 'Backend Engineer',
    analysis: analysis({
      technologies: ['Zorblax', 'Quibbit', 'Frobnitz Cloud', 'Wumpus', 'Gribble'],
      tools: ['Plinth', 'Snark'],
      architecturePatterns: ['microservices'],
      domainKnowledge: ['payments'],
    }),
  };
  // core: Zorblax 1, Quibbit (inside "Quibbit Pro") 1, Frobnitz Cloud 0.6 (the resume says Frobnitz), Wumpus 0, Gribble 0.
  // rest: Plinth 1 (2), Snark 0 (2), microservices 0.5 through Docker (1), payments 1 (1).
  const held = ['Zorblax', 'Quibbit Pro', 'Frobnitz', 'Plinth', 'Docker', 'payments'];
  const core = (3 * (1 + 1 + 0.6)) / 15;
  const rest = (2 * 1 + 2 * 0 + 1 * 0.5 + 1 * 1) / 6;
  const recall = 0.7 * core + 0.3 * rest;

  // Headline "Data Engineer" is a third of "Backend Engineer"; the role "Backend Engineer" says all of it.
  const titled = kw(held, { headline: ['Data Engineer'], roleTitles: ['Backend Engineer'] });
  const t = 0.7 * (1 / 3) + 0.3 * 1;
  const out = match.scoreResumeForJob(titled, job);
  closeTo(out.score, 0.45 * t + 0.55 * recall, 'title and terms');
  assert.equal(out.postingTermCount, 9);
  assert.equal(out.matchedCount, 6);
  assert.equal(out.titleMatched, true, 'a held title says the whole kind');
  assert.equal(out.basis, 'analysis');

  // No title on the job: S = R. No terms: S = T (above).
  closeTo(match.scoreResumeForJob(kw(held), { analysis: job.analysis }).score, recall, 'terms alone');

  // One tier empty: R is the other tier's value, not a share of it.
  const coreOnly = match.scoreResumeForJob(kw(['Zorblax']), { analysis: analysis({ technologies: ['Zorblax', 'Quibbit'] }) });
  closeTo(coreOnly.score, 0.5, 'core alone');
  const restOnly = match.scoreResumeForJob(kw(['Plinth']), { analysis: analysis({ architecturePatterns: ['Plinth', 'Snark'] }) });
  closeTo(restOnly.score, 0.5, 'rest alone');
});

test('title affinity: the last word counts 1, every qualifier 2, developer is engineer, spellings of a field fold together', () => {
  const affinity = (headline, job, roles = []) =>
    match.scoreResumeForJob(kw([], { headline: headline ? [headline] : [], roleTitles: roles }), { title: job }).score;

  closeTo(affinity('Backend Engineer', 'Backend Engineer'), 1);
  closeTo(affinity('Data Engineer', 'Backend Engineer'), 1 / 3);
  closeTo(affinity('Backend Developer', 'Backend Engineer'), 1, 'developer, programmer, dev and swe are engineer');
  closeTo(affinity('Back End Engineer', 'Backend Engineer'), 1, 'back end is backend');
  closeTo(affinity('Front End Developer', 'Frontend Engineer'), 1);
  closeTo(affinity('Full Stack Engineer', 'Fullstack Engineer'), 1);
  closeTo(affinity('Machine Learning Engineer', 'ML Engineer'), 1);
  closeTo(affinity('Backend Engineer', 'Senior Backend Engineer II'), 1, 'levels are not part of the kind');
  closeTo(affinity('Frontend Engineer', 'Backend Engineer'), 1 / 3);
  closeTo(affinity('', 'Backend Engineer'), 0);
  // 70% the headline, 30% the best held title.
  closeTo(affinity('Data Engineer', 'Backend Engineer', ['Backend Engineer', 'Software Engineer']), 0.7 / 3 + 0.3);
  // With no headline the held titles are all of T; with no held titles the headline is.
  closeTo(affinity('', 'Backend Engineer', ['Backend Engineer']), 1);
  // The job's title may be the analysis' or the caller's; the best of them counts.
  const both = match.scoreResumeForJob(kw([], { headline: ['Data Engineer'] }), {
    analysis: analysis({ title: 'Data Engineer' }),
    title: 'Backend Engineer',
  });
  closeTo(both.score, 1);
});

/* ---------------------------------------------------------------- the text path */

test('from text: a term in the title line weighs 3, one in a requirements block 2, one anywhere else 1, and only a term of a candidate\'s own can be a posting term outside the vocabulary', () => {
  // (A Title-case name is not taken where a sentence or bullet starts - "Zorblax Engineer", "- Quibbit" -
  // so each is mid-sentence here.)
  const text = [
    'Senior Zorblax Engineer',
    'We also love Wumpus.',
    'Requirements:',
    '- Experience with Quibbit',
    'Benefits',
    '- Lunch',
  ].join('\n');
  const job = { text };
  const X = resume({ skills: ['Zorblax'] });
  const Y = resume({ skills: ['Quibbit'] });
  const Z = resume({ skills: ['Wumpus'] });

  // Zorblax 3 against Quibbit 2, both core: X holds 3 of 5.
  const xy = match.chooseForJob(job, [candidate(X), candidate(Y)], 'suitable');
  assert.equal(xy.resume.id, X.id);
  assert.equal(xy.match.basis, 'text');
  closeTo(xy.match.score, 0.6);
  assert.deepEqual(xy.match.matched, ['Zorblax']);
  assert.equal(xy.match.postingTermCount, 2);

  // Quibbit (a requirement, core) against Wumpus (elsewhere, rest): core 1.0 x 0.7 against rest 1.0 x 0.3.
  const yz = match.chooseForJob(job, [candidate(Z), candidate(Y)], 'suitable');
  assert.equal(yz.resume.id, Y.id);
  closeTo(yz.match.score, 0.7);

  // All three together: Zorblax holds 3 of the core 5 (x 0.7); the others less.
  const xyz = match.chooseForJob(job, [candidate(Z), candidate(Y), candidate(X)], 'suitable');
  assert.equal(xyz.resume.id, X.id);
  closeTo(xyz.match.score, 0.7 * 0.6);

  // The caller's own title is a title line too: Zorblax is in it (core, 3), Quibbit is only in the body (rest, 1).
  const byTitle = match.chooseForJob(
    { text: 'Welcome to our team.\nWe love Quibbit and Zorblax.', title: 'Senior Zorblax Engineer' },
    [candidate(Y), candidate(X)],
    'suitable'
  );
  assert.equal(byTitle.resume.id, X.id);
  assert.deepEqual(byTitle.match.matched, ['Zorblax']);
});

test('from text: a one-letter term is never looked for in a posting, and a term the vocabulary knows is found without any candidate holding it', () => {
  const out = match.scoreResumeForJob(kw(['C']), { text: 'Experience in C and Terraform.' });
  assert.deepEqual(out.matched, [], 'C is a letter of the alphabet in prose');
  const vocabulary = match.scoreResumeForJob(kw(['Terraform']), { text: 'We run Terraform in production.' });
  assert.deepEqual(vocabulary.matched, ['Terraform']);
  assert.equal(vocabulary.basis, 'text');
});

/* ---------------------------------------------------------- the posting's lists */

test('the matcher reads the tailoring prompt\'s own lists: postingTermLists is what buildTailorLists is made of, and soft skills, verbs and responsibilities are never scored', () => {
  const full = analysis({
    title: 'Backend Engineer',
    technologies: ['Go', 'Kubernetes', 'Docker'],
    tools: ['Terraform'],
    technical: ['system design'],
    protocols: ['gRPC'],
    architecturePatterns: ['microservices'],
    methodologies: ['Agile'],
    buzzwords: ['cloud-native'],
    mustInclude: ['stakeholder management'],
    soft: ['Communication'],
    actionVerbs: ['built', 'migrated'],
    responsibilities: ['incident response ownership'],
    domainKnowledge: ['payments'],
    text: 'Backend Engineer. We use Go, Kubernetes, Docker and Terraform.',
  });
  const lists = contract.postingTermLists(full);
  const tailor = contract.buildTailorLists(full, 'seed');
  assert.deepEqual(lists.skills, tailor.skills);
  assert.deepEqual(lists.concepts, tailor.concepts);
  assert.deepEqual(lists.topSkills, tailor.topSkills);
  assert.deepEqual(lists.posting, tailor.posting);

  // A resume holding only what the matcher must ignore scores nothing: soft skills,
  // verbs, responsibilities (and the other half of the analysis, its title aside).
  const ignored = kw(['Communication', 'built', 'migrated', 'incident response ownership', 'Agile']);
  const out = match.scoreResumeForJob(ignored, { analysis: full });
  // Agile is a methodology, a concept: scored. The rest are not.
  assert.deepEqual(out.matched, ['Agile']);
  const none = match.scoreResumeForJob(kw(['Communication', 'built', 'migrated', 'incident response ownership']), { analysis: full });
  assert.deepEqual(none.matched, []);
  closeTo(none.score, 0);
  // postingTermCount: top five (Go, Kubernetes, gRPC? ...) + skills + concepts + must-include + domain, each once.
  const expected = new Set(
    [...lists.topSkills, ...lists.posting.mustInclude, ...lists.skills, ...lists.concepts, ...lists.posting.domainKnowledge].map((term) =>
      keywords.synonymKey(term)
    )
  );
  assert.equal(out.postingTermCount, expected.size);
  assert.ok(!out.matched.includes('Communication'));
});

/* ---------------------------------------------------------------- the explanation */

test('the explanation lists at most eight matched terms, best first (weight x factor, then the posting\'s order), and counts them all', () => {
  const names = Array.from({ length: 12 }, (_, index) => `Tech${String.fromCharCode(65 + index)}x`);
  // Five lead the list and are the five it leans on (weight 3); the rest are skills (weight 2).
  const job = { analysis: analysis({ technologies: names.slice(0, 7), tools: names.slice(7) }) };
  const all = match.scoreResumeForJob(kw([...names].reverse()), job);
  assert.equal(all.matchedCount, 12);
  assert.equal(all.postingTermCount, 12);
  assert.equal(all.matched.length, 8);
  // Weight 3 (the five it leans on) first, then weight 2 in the order of the tailoring prompt's own skills list.
  const lists = contract.postingTermLists(job.analysis);
  assert.deepEqual(lists.topSkills, names.slice(0, 5));
  const expected = [...lists.topSkills, ...lists.skills.filter((term) => !lists.topSkills.includes(term))].slice(0, 8);
  assert.deepEqual(all.matched, expected);
  closeTo(all.score, 1);

  // A weaker factor ranks below a full one of the same tier: a partial match comes after the exact ones.
  const mixed = match.scoreResumeForJob(kw(['TechAx', 'TechBx']), {
    analysis: analysis({ technologies: ['TechAx Cloud', 'TechBx'] }),
  });
  assert.deepEqual(mixed.matched, ['TechBx', 'TechAx Cloud'], 'weight x factor: 3 x 1 before 3 x 0.6, though the posting lists it second');

  const chosen = match.chooseForJob(job, [candidate(resume({ skills: names }), true), candidate(resume({ skills: ['Wumpus'] }))], 'suitable');
  assert.equal(chosen.match.matched.length, 8);
  assert.equal(chosen.match.matchedCount, 12);
  assert.equal(chosen.match.postingTermCount, 12);
});

/* ------------------------------------------------------------------ determinism */

test('the choice and its explanation are deterministic and independent of the order candidates are listed in', () => {
  const job = { analysis: workedAnalysis(), title: 'Senior Backend Engineer' };
  const list = [
    candidate(bare()),
    candidate(dataEngineer(), true),
    candidate(resume({ title: 'Platform Engineer', roles: ['Platform Engineer'], skills: ['Kubernetes', 'Terraform', 'Go'] })),
    candidate(resume({ title: 'Backend Engineer', roles: ['Backend Engineer'], skills: ['Go', 'gRPC', 'PostgreSQL'] })),
  ];
  const expected = match.chooseForJob(job, list, 'suitable');
  assert.deepEqual(match.chooseForJob(job, list, 'suitable'), expected, 'asked again');
  const permutations = [
    [...list].reverse(),
    [list[2], list[0], list[3], list[1]],
    [list[1], list[3], list[2], list[0]],
  ];
  for (const order of permutations) {
    const again = match.chooseForJob(job, order, 'suitable');
    assert.equal(again.resume.id, expected.resume.id);
    assert.deepEqual(again.match, expected.match);
  }
  assert.equal(expected.resume.title, 'Backend Engineer');
  assert.equal(expected.resume.skills.includes('gRPC'), true, 'the resume with the title and the stack');
});

/* ------------------------------------------------------------------ performance */

test('500 jobs among 25 resumes are chosen in well under 3 seconds', () => {
  const pool = [
    'Go', 'Kubernetes', 'Docker', 'PostgreSQL', 'gRPC', 'Terraform', 'AWS', 'Python', 'Java', 'Kafka', 'Redis', 'React',
    'TypeScript', 'Node.js', 'Rust', 'Scala', 'Spark', 'Airflow', 'Snowflake', 'dbt', 'Azure', 'GCP', 'Ansible', 'Jenkins',
    'Elasticsearch', 'MongoDB', 'MySQL', 'GraphQL', 'REST', 'Linux', 'CI/CD', 'microservices', 'observability', 'Grafana',
    ...Array.from({ length: 60 }, (_, index) => `PoolTool${index}`),
  ];
  const pick = (seed, count) => Array.from({ length: count }, (_, index) => pool[(seed * 7 + index * 13) % pool.length]);
  const kinds = ['Backend Engineer', 'Data Engineer', 'Platform Engineer', 'Frontend Engineer', 'Software Engineer'];

  const candidates = Array.from({ length: 25 }, (_, index) =>
    candidate(
      resume({
        id: uid('perf'),
        title: kinds[index % kinds.length],
        roles: [kinds[index % kinds.length], kinds[(index + 1) % kinds.length]],
        skills: pick(index + 1, 30),
        summary: `Built systems with ${pick(index + 3, 6).join(' and ')} for years.`,
        updatedAt: `2026-0${1 + (index % 9)}-01T00:00:00.000Z`,
      }),
      index === 0
    )
  );
  const postingText = (seed) =>
    [
      `${kinds[seed % kinds.length]} (${pick(seed, 2).join(', ')})`,
      'We are hiring an engineer to build our platform.',
      'Requirements:',
      ...pick(seed + 2, 6).map((term) => `- Experience with ${term}`),
      `Nice to have: ${pick(seed + 5, 4).join(', ')}`,
      'We offer a great team. '.repeat(40),
    ].join('\n');

  const jobs = Array.from({ length: 500 }, (_, seed) =>
    seed % 2 === 0
      ? {
          title: kinds[seed % kinds.length],
          analysis: analysis({
            title: kinds[seed % kinds.length],
            technologies: pick(seed, 5),
            tools: pick(seed + 9, 3),
            architecturePatterns: pick(seed + 4, 2),
            mustInclude: pick(seed, 2),
            text: postingText(seed),
          }),
        }
      : { title: kinds[seed % kinds.length], text: postingText(seed) }
  );

  const started = process.hrtime.bigint();
  const picked = jobs.map((job) => match.chooseForJob(job, candidates, 'suitable'));
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(picked.length, 500);
  for (const out of picked) {
    assert.ok(candidates.some((item) => item.resume.id === out.resume.id));
    assert.equal(out.match.candidates, 25);
  }
  assert.ok(new Set(picked.map((out) => out.resume.id)).size > 1, 'the choice varies with the posting');
  assert.ok(elapsedMs < 3000, `500 jobs x 25 resumes took ${Math.round(elapsedMs)} ms`);
});

/* ------------------------------------------- tie-break on strict titles, kin titles, opening line */

test('a tie on score and precision goes to the resume whose headline AND roles match, not to a headline-less one that is newer', () => {
  // Nothing in the posting names a term, so only titles decide; the bare resume (no headline) scores its one
  // matching role as high as the specialist's headline-and-roles, and is the newer.
  const job = { title: 'Backend Engineer, Payments' };
  const specialist = resume({ id: uid('specialist'), title: 'Backend Engineer', roles: ['Backend Engineer'], updatedAt: '2026-01-01T00:00:00.000Z' });
  const bare = resume({ id: uid('bare'), roles: ['Data Scientist', 'Backend Developer'], updatedAt: '2026-06-01T00:00:00.000Z' });
  const out = match.chooseForJob(job, [candidate(bare), candidate(specialist)], 'suitable');
  assert.equal(out.resume.id, specialist.id);
  assert.equal(out.match.reason, 'tie');
  closeTo(match.scoreResumeForJob(keywords.keywordsOf(bare), job).score, match.scoreResumeForJob(keywords.keywordsOf(specialist), job).score, 'the scores tie');
  // The default still beats it, and so does a better score.
  assert.equal(match.chooseForJob(job, [candidate(bare, true), candidate(specialist)], 'suitable').resume.id, bare.id);
});

test('DevOps, SRE and site reliability are one kind of role; Platform counts half for either', () => {
  const sre = resume({ id: uid('devops'), roles: ['DevOps Engineer', 'Systems Administrator'] });
  const backend = resume({ id: uid('backend'), roles: ['Backend Engineer'] });
  const frontend = resume({ id: uid('frontend'), roles: ['Frontend Engineer'] });
  for (const title of ['Site Reliability Engineer', 'SRE', 'Senior DevOps Engineer']) {
    const out = match.chooseForJob({ title }, [candidate(backend, true), candidate(frontend), candidate(sre)], 'suitable');
    assert.equal(out.resume.id, sre.id, title);
    assert.equal(out.match.reason, 'matched', title);
    assert.equal(out.match.titleMatched, true, title);
  }
  // Platform Engineer: head (1) + half of the qualifier (2 / 2) = 2 of 3 against a DevOps Engineer.
  closeTo(match.scoreResumeForJob(keywords.keywordsOf(sre), { title: 'Platform Engineer' }).score, 2 / 3, 'a platform posting reaches a DevOps resume');
  const platform = match.chooseForJob({ title: 'Platform Engineer' }, [candidate(backend, true), candidate(sre)], 'suitable');
  assert.equal(platform.resume.id, sre.id, 'half a qualifier beats none');
});

test('with no terms and no role, a short opening line that is not a sentence stands for the title', () => {
  const frontend = resume({ id: uid('fe'), roles: ['Frontend Engineer'] });
  const backend = resume({ id: uid('be'), roles: ['Backend Engineer'] });
  const job = { text: 'Senior Frontend Engineer\nWe build delightful web apps.' };
  const out = match.chooseForJob(job, [candidate(backend, true), candidate(frontend)], 'suitable');
  assert.equal(out.resume.id, frontend.id);
  assert.equal(out.match.basis, 'title');
  assert.equal(out.match.reason, 'matched');
  // A first line that reads as a sentence is not a title, and a role given wins over the text.
  const sentence = match.chooseForJob({ text: 'We are hiring a Frontend Engineer.\nJoin us.' }, [candidate(backend, true), candidate(frontend)], 'suitable');
  assert.equal(sentence.resume.id, backend.id, 'the default');
  assert.equal(sentence.match.basis, 'none');
  const given = match.chooseForJob({ title: 'Backend Engineer', text: job.text }, [candidate(backend), candidate(frontend, true)], 'suitable');
  assert.equal(given.resume.id, backend.id);
});

/* ------------------------------ realistic postings: sentence starts, synonym spellings, title tails, alternatives */

/** A resume with a stack and some history: what a real profile holds. */
function rich({ title, roles = [title], skills = [], summary = '', bullets = [] }) {
  const id = uid(title.replace(/\W+/g, '-').toLowerCase());
  return {
    ...resume({ id, title, roles, skills, summary }),
    experience: roles.map((roleTitle, index) => ({
      title: roleTitle,
      company: 'Somewhere',
      startDate: '2020-01',
      endDate: 'Present',
      achievements: index === 0 ? bullets : [],
      skills: [],
    })),
  };
}

const PEOPLE = () => ({
  backend: rich({
    title: 'Senior Backend Engineer',
    roles: ['Senior Backend Engineer', 'Backend Engineer'],
    skills: ['Go', 'PostgreSQL', 'gRPC', 'Kubernetes', 'Docker', 'Redis', 'Kafka', 'AWS'],
    summary: 'Backend engineer building payment services in Go.',
    bullets: ['Built Go microservices behind gRPC gateways', 'Migrated the ledger to PostgreSQL'],
  }),
  frontend: rich({
    title: 'Senior Frontend Engineer',
    roles: ['Senior Frontend Engineer', 'Frontend Developer'],
    skills: ['React', 'TypeScript', 'JavaScript', 'Next.js', 'Redux', 'GraphQL', 'Jest', 'CSS', 'HTML'],
    summary: 'Frontend engineer focused on React and TypeScript design systems.',
  }),
  data: rich({
    title: 'Data Engineer',
    roles: ['Data Engineer', 'Data Analyst'],
    skills: ['Python', 'SQL', 'Spark', 'Airflow', 'Snowflake', 'dbt', 'Kafka', 'AWS', 'Redshift'],
    summary: 'Data engineer building batch and streaming pipelines on AWS.',
  }),
  devops: rich({
    title: 'DevOps Engineer | Site Reliability Engineer',
    roles: ['Site Reliability Engineer', 'DevOps Engineer'],
    skills: ['Kubernetes', 'Terraform', 'AWS', 'Docker', 'Helm', 'Prometheus', 'Grafana', 'Ansible', 'Linux', 'Python'],
    summary: 'Platform engineer who automates infrastructure with Terraform on AWS.',
  }),
  general: rich({
    title: 'Full Stack Software Engineer',
    roles: ['Full Stack Developer'],
    skills: ['JavaScript', 'TypeScript', 'Node.js', 'React', 'PostgreSQL', 'Docker', 'AWS', 'Python', 'Git'],
    summary: 'Software engineer comfortable across the stack: Node.js APIs, React frontends, PostgreSQL and AWS.',
  }),
});

const nameOf = (people, picked) => Object.keys(people).find((name) => people[name].id === picked.resume.id);
const chooseAmong = (people, job, defaultName = 'general') =>
  match.chooseForJob(job, Object.entries(people).map(([name, r]) => candidate(r, name === defaultName)), 'suitable');

test('from text, a stack listed one technology per bullet is read: a generic title no longer picks the generalist (matcher-1)', () => {
  const people = PEOPLE();
  const dataPlatform = [
    'Software Engineer, Data Platform',
    'Join the team that runs our data platform on AWS. You will build the pipelines that feed analytics and ML.',
    '',
    'Requirements:',
    '- Python',
    '- Spark',
    '- Airflow',
    '- Snowflake',
    '- Strong communication skills',
  ].join('\n');
  const data = chooseAmong(people, { text: dataPlatform, title: 'Software Engineer, Data Platform' });
  assert.equal(nameOf(people, data), 'data', 'the Data Engineer resume, not the Full Stack Software Engineer one');
  assert.equal(data.match.basis, 'text');
  for (const term of ['Python', 'Spark', 'Airflow', 'Snowflake']) assert.ok(data.match.matched.includes(term), term);

  const platform = [
    'Software Engineer, Platform',
    'Our platform runs on AWS and we want someone who treats infrastructure as code.',
    '',
    'What you bring',
    '- Terraform',
    '- Kubernetes',
    '- Helm',
    '- Prometheus',
  ].join('\n');
  const ops = chooseAmong(people, { text: platform, title: 'Software Engineer, Platform' });
  assert.equal(nameOf(people, ops), 'devops');
  for (const term of ['Terraform', 'Kubernetes', 'Helm', 'Prometheus']) assert.ok(ops.match.matched.includes(term), term);

  // The same bare lines with no bullet marks, and numbered.
  const bare = 'Software Engineer\nRequirements:\nTerraform\nKubernetes\nHelm\nPrometheus';
  assert.equal(nameOf(people, chooseAmong(people, { text: bare, title: 'Software Engineer' })), 'devops');
  const numbered = 'Software Engineer\n1. Python\n2. Spark\n3. Airflow\n4. Snowflake';
  assert.equal(nameOf(people, chooseAmong(people, { text: numbered, title: 'Software Engineer' })), 'data');
  // A resume's own bullets and skill lines are read the same way.
  const bulleted = rich({ title: 'Engineer', skills: [], summary: '', bullets: ['Terraform modules for 40 accounts', 'Kubernetes upgrades'] });
  assert.deepEqual(keywords.keywordsOf(bulleted).terms, ['Terraform', 'Kubernetes']);
});

test('the everyday words stay out of a posting at a sentence start: Java and Spring Boot are found, "Kind regards", "Go-live" and "American Express" are not (matcher-1 guards)', () => {
  const text = [
    'Java Developer',
    'American Express is hiring. Kind regards from the team. The rest of the stack is Spring Boot. Go-live is in spring.',
    'Requirements',
    '- Java and Spring Boot',
    '- Express yourself in design reviews',
    '- Swift decisions under pressure',
  ].join('\n');
  const found = keywords.scanVocabulary(text).map((hit) => hit.term.spelling);
  assert.deepEqual(found, ['Java', 'Spring Boot']);
});

test('synonym spellings in a posting\'s text count: Golang and K8s name Go and Kubernetes (matcher-2)', () => {
  const people = PEOPLE();
  const text = 'Software Engineer\nWe run Golang services on K8s with Postgres.';
  const out = chooseAmong(people, { text, title: 'Software Engineer' });
  assert.equal(nameOf(people, out), 'backend');
  assert.deepEqual(out.match.matched.slice(0, 3).sort(), ['Golang', 'K8s', 'Postgres']);

  const small = chooseAmong(people, { text: 'Software Engineer\nWe are a small team using Golang and K8s.', title: 'Software Engineer' });
  assert.equal(nameOf(people, small), 'backend');
  assert.deepEqual([...small.match.matched].sort(), ['Golang', 'K8s'], 'before the synonyms were scanned, nothing matched and the title alone chose');
  closeTo(small.match.score, 0.45 * 0.5 + 0.55 * 1, 'T = Software Engineer against Backend Engineer, R = both terms');

  const abbreviations = chooseAmong(people, { text: 'Backend Engineer\nStack: Golang, K8s, Postgres, Mongo, gRPC.', title: 'Backend Engineer' });
  assert.equal(nameOf(people, abbreviations), 'backend');
  assert.ok(abbreviations.match.matchedCount >= 4, `${abbreviations.match.matchedCount} of ${abbreviations.match.postingTermCount}`);

  // "Node" in the middle of a sentence names Node.js; lower-case "node" and "go" prose do not.
  const node = resume({ id: uid('node'), skills: ['Node.js'] });
  const java = resume({ id: uid('java'), skills: ['Java'] });
  const nodeJob = match.chooseForJob({ text: 'We are hiring Node developers for the API.' }, [candidate(java, true), candidate(node)], 'suitable');
  assert.equal(nodeJob.resume.id, node.id);
  assert.deepEqual(nodeJob.match.matched, ['Node']);
  const prose = match.scoreResumeForJob(keywords.keywordsOf(node), { text: 'We hire node people who go the extra mile.' });
  assert.deepEqual(prose.matched, []);
});

test('a title\'s tail says what the role is: "Software Engineer, Backend" picks the Go backend resume over a Full Stack Software Engineer one (matcher-3)', () => {
  const people = PEOPLE();
  const pick = (title, extra = {}) => {
    const an = analysis({ title, technologies: ['Go', 'PostgreSQL', 'Docker'], mustInclude: ['Go'], ...extra });
    return chooseAmong({ backend: people.backend, general: people.general }, { analysis: an, title }, 'general');
  };
  for (const title of ['Backend Engineer', 'Software Engineer, Backend', 'Software Engineer (Backend)', 'Software Engineer - Backend Platform']) {
    const out = pick(title);
    assert.equal(out.resume.id, people.backend.id, title);
    assert.deepEqual(out.match.matched, ['Go', 'PostgreSQL', 'Docker'], title);
  }
  closeTo(pick('Software Engineer, Backend').match.score, 0.8875, 'T = 3/4 on the Backend resume, R = 1');
  closeTo(pick('Backend Engineer').match.score, 1);

  // With no technology in the posting the tail still decides, and the kind is the head of the title alone.
  const byTail = (title) => nameOf(people, chooseAmong(people, { title }, 'general'));
  assert.equal(byTail('Software Engineer, Backend'), 'backend');
  assert.equal(byTail('Software Engineer - Frontend'), 'frontend');
  assert.equal(byTail('Software Engineer (Data)'), 'data');
  assert.equal(byTail('Senior Software Engineer, Backend'), 'backend');
});

test('"Engineer II, Backend Platform" does not tie across a Frontend, a Data and a Backend resume (matcher-3)', () => {
  const people = PEOPLE();
  const score = (name) => match.scoreResumeForJob(keywords.keywordsOf(people[name]), { title: 'Engineer II, Backend Platform' }).score;
  const [backend, frontend, data, devops, general] = ['backend', 'frontend', 'data', 'devops', 'general'].map(score);
  // Engineer (1) + Backend (2) of 1 + 2 + 2: 3/5; the platform half-counts for DevOps: 1 + 1 of 5.
  closeTo(backend, 3 / 5);
  closeTo(frontend, 1 / 5);
  closeTo(data, 1 / 5);
  closeTo(devops, 2 / 5, 'platform is kin to DevOps');
  closeTo(general, 1 / 5);
  assert.ok(backend > devops && devops > frontend);
  assert.equal(nameOf(people, chooseAmong(people, { title: 'Engineer II, Backend Platform' })), 'backend');
});

test('title tails: levels, "Remote"-like words, the kind\'s own words and the posting\'s own terms are not qualifiers; titleMatched is about the kind alone (matcher-3)', () => {
  const headlineOf = (headline) => kw([], { headline: [headline] });
  const t = (headline, title, extra = {}) => match.scoreResumeForJob(headlineOf(headline), { title, ...extra });

  // "software" weighs 1: Software Engineer is 2, Software Engineer, Backend is 4.
  closeTo(t('Full Stack Software Engineer', 'Software Engineer, Backend').score, 2 / 4);
  closeTo(t('Backend Engineer', 'Software Engineer, Backend').score, 3 / 4);
  closeTo(t('Full Stack Software Engineer', 'Software Engineer').score, 1);
  closeTo(t('Backend Engineer', 'Software Engineer').score, 1 / 2);
  // The kind alone says "titleMatched": a Full Stack Software Engineer is titled for Software Engineer, Backend; a Backend Engineer is not.
  assert.equal(t('Full Stack Software Engineer', 'Software Engineer, Backend').titleMatched, true);
  assert.equal(t('Backend Engineer', 'Software Engineer, Backend').titleMatched, false);
  assert.equal(t('Backend Engineer', 'Backend Engineer, Payments').titleMatched, true);

  // Levels and noise change nothing.
  closeTo(t('Backend Engineer', 'Engineer III, Backend').score, t('Backend Engineer', 'Engineer, Backend').score);
  closeTo(t('Backend Engineer', 'Engineer II, Backend').score, t('Backend Engineer', 'Engineer, Backend').score);
  closeTo(t('Backend Engineer', 'Backend Engineer (Remote)').score, 1);
  closeTo(t('Backend Engineer', 'Backend Engineer - Full-time, Hybrid').score, 1);
  // A tail word that repeats the kind is not counted twice.
  closeTo(t('Backend Engineer', 'Backend Engineer, Backend').score, 1);

  // A technology in the tail is scored as the term it is (the worked example's "(Go, Kubernetes)"), not as a qualifier.
  const withTerms = analysis({ title: 'Senior Backend Engineer (Go, Kubernetes)', technologies: ['Go', 'Kubernetes'] });
  closeTo(match.scoreResumeForJob(kw(['Go', 'Kubernetes'], { headline: ['Backend Engineer'] }), { analysis: withTerms }).score, 1);
  // With no term to take it, it stays a qualifier a resume cannot say: 3 of 5.
  closeTo(t('Backend Engineer', 'Senior Backend Engineer (Go, Kubernetes)').score, 3 / 5);
});

test('an analysis term that spells alternatives is scored as each of them: Go (Golang), Golang (Go) and Go/Golang pick the Go resume (matcher-4)', () => {
  const people = PEOPLE();
  const pair = { backend: people.backend, general: people.general };
  for (const spelling of ['Go', 'Golang', 'Go (Golang)', 'Golang (Go)', 'Go/Golang', 'Golang or Go']) {
    const an = analysis({ title: 'Software Engineer', technologies: [spelling, 'PostgreSQL'], mustInclude: [spelling] });
    const out = chooseAmong(pair, { analysis: an, title: 'Software Engineer' }, 'general');
    assert.equal(out.resume.id, people.backend.id, spelling);
    assert.equal(out.match.postingTermCount, 2, `${spelling} is one term`);
    assert.ok(out.match.matched.includes(spelling), `${spelling} keeps its own spelling in the explanation`);
  }

  // Factors: the best alternative counts.
  closeTo(factorOf('Go (Golang)', ['Go']), 1);
  closeTo(factorOf('Go (Golang)', ['Golang']), 1);
  closeTo(factorOf('Go/Golang', ['Go']), 1);
  closeTo(factorOf('Kubernetes (K8s)', ['Kubernetes']), 1);
  closeTo(factorOf('Kubernetes (K8s)', ['K8s']), 1);
  closeTo(factorOf('Airflow or Dagster', ['Dagster']), 1);
  closeTo(factorOf('Zorblax (Quibbit)', ['Quibbit']), 1);
  closeTo(factorOf('Zorblax/Quibbit', ['Zorblax']), 1);
  closeTo(factorOf('Node.js/Express', ['Express']), 1);
  closeTo(factorOf('Zorblax (Quibbit)', ['Wumpus']), 0);
  // The whole term still names its concept ("CI/CD pipelines"), and a vocabulary entry with a slash is not split.
  closeTo(factorOf('CI/CD pipelines', ['continuous integration']), 0.8);
  closeTo(factorOf('TCP/IP', ['IP']), 0, 'TCP/IP is one entry');
  closeTo(factorOf('CI/CD', ['CD']), 0, 'CI/CD is one entry');
});

test('common spellings of one thing are one: TS, HTML5, CSS3, Python3 and ES6 against their plain names (matcher-4)', () => {
  const frontend = keywords.keywordsOf(PEOPLE().frontend);
  const against = (term) => match.scoreResumeForJob(frontend, { analysis: analysis({ technologies: [term] }) }).score;
  for (const term of ['TS', 'TypeScript', 'HTML5', 'CSS3', 'ES6', 'JS']) assert.ok(against(term) > 0, term);
  closeTo(against('TS'), 1);
  closeTo(against('HTML5'), 1);
  closeTo(against('CSS3'), 1);
  closeTo(factorOf('Python3', ['Python']), 1);
  closeTo(factorOf('Python', ['Python3']), 1);
  closeTo(factorOf('TypeScript', ['TS']), 1);
  closeTo(factorOf('CSS', ['CSS3']), 1);
  closeTo(factorOf('ES6', ['JavaScript']), 1);
  // And a different thing stays different.
  closeTo(factorOf('TS', ['JS']), 0);
  closeTo(factorOf('HTML5', ['CSS3']), 0);
});

test('a requirement that opens its line or sentence is read: "- Go" bullets pick the Go resume and "Swift required." picks the iOS one (list items, requirement cues)', () => {
  const people = {
    ...PEOPLE(),
    ios: rich({
      title: 'iOS Engineer',
      roles: ['iOS Engineer', 'Mobile Developer'],
      skills: ['Swift', 'Objective-C', 'Xcode', 'UIKit', 'SwiftUI', 'Core Data'],
      summary: 'iOS engineer shipping consumer apps in Swift.',
    }),
  };
  // Docker and PostgreSQL are on the generalist too, so Go is what separates the two.
  const bullets = 'Software Engineer\nRequirements:\n- Go\n- Docker\n- PostgreSQL';
  for (const defaultName of ['general', 'data', 'ios']) {
    const out = chooseAmong(people, { text: bullets, title: 'Software Engineer' }, defaultName);
    assert.equal(nameOf(people, out), 'backend', `default ${defaultName}`);
    assert.ok(out.match.matched.includes('Go'), 'Go is a term of the posting');
  }
  const inline = chooseAmong(people, { text: 'Software Engineer\nGo, Docker, PostgreSQL', title: 'Software Engineer' });
  assert.equal(nameOf(people, inline), 'backend');

  const mobile = 'Software Engineer (Mobile)\nBuild iOS apps for millions of users. Swift required.';
  for (const defaultName of ['general', 'backend', 'data']) {
    const out = chooseAmong(people, { text: mobile, title: 'Software Engineer (Mobile)' }, defaultName);
    assert.equal(nameOf(people, out), 'ios', `default ${defaultName}`);
    assert.ok(out.match.matched.includes('Swift'), 'Swift is a term of the posting');
    assert.notEqual(out.match.reason, 'default');
  }
  const swiftBullets = chooseAmong(people, { text: 'Software Engineer\n- Swift\n- Objective-C\n- Xcode', title: 'Software Engineer' });
  assert.equal(nameOf(people, swiftBullets), 'ios');

  // Prose that opens with the same words still scores nothing: the generalist stays the default.
  const prose = chooseAmong(people, { text: 'Software Engineer\nKind regards from the team. Swift reply expected. Go to market with us.', title: 'Software Engineer' });
  assert.deepEqual(prose.match.matched, []);
});
