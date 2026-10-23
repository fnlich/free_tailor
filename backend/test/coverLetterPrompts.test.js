const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

/**
 * The two cover letters this app can produce, held to one standard.
 *
 * There are two paths and they are both legitimate. With a job description,
 * `tailor-resume` writes the letter as one field of its JSON, informed by the
 * job analysis. Without one - the caller gave only a company and a role -
 * `generate-cover-letter` writes it from the source resume alone. routes/resume.ts
 * picks between them on whether the tailored content came back with a letter.
 *
 * What is NOT legitimate is the two writing differently, because they produce
 * the same artifact: the cover letter PDF the candidate sends. Before this,
 * the fallback asked for "2-4 short paragraphs ... professional, concise and
 * confident" and said nothing about first person, the opening word, clichés or
 * em-dashes, so which path ran decided how the letter read.
 *
 * There is no include mechanism for prompts - they are plain text a person can
 * edit in the admin UI, and a hidden partial would mean the editor no longer
 * showed what the model receives. So the rules are written out in both, and
 * this test is what keeps them the same.
 */

function promptText(id) {
  const file = path.join(__dirname, '..', 'static', 'prompts', `${id}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8')).content;
}

const TAILORED = promptText('tailor-resume');
/** Fully tailor's prompt writes the letter as one field of its JSON too, beside the resume it wrote. */
const FULLY = promptText('tailor-resume-full');
const FALLBACK = promptText('generate-cover-letter');

/** The voice every cover letter this app produces has to have. */
const SHARED_RULES = [
  ['length', /3-4 paragraphs/],
  ['no salutation or sign-off', /No salutation, no sign-off, no bullet points/],
  ['opens on "I"', /The first word is "I"/],
  ['first person throughout', /the whole letter is first person/],
  ['no resume verbs to open a sentence', /Never open a sentence with a resume-style action verb/],
  ['varied sentence length', /Vary sentence length/],
  ['opens with enthusiasm, years, domain', /genuine enthusiasm for this kind of work/],
  ['one achievement as a story', /brief story connecting to/],
  ['a second, more personal moment', /personality and real technical depth/],
  ['says what excites them', /what actually excites you about this work/],
  ['confident, untemplated close', /does not sound templated/],
  ['no clichés', /No clichés/],
  ['no "look forward to hearing"', /I look forward to hearing from you/],
  ['warm and specific', /warm, specific to this candidate/],
  ['earns an interview', /compelling enough to earn an interview/],
  ['concise', /Concise, not verbose/],
  ['no em-dashes', /Never use em-dashes/],
];

test('both cover letter prompts carry the same voice rules', () => {
  const missing = [];
  for (const [label, pattern] of SHARED_RULES) {
    if (!pattern.test(TAILORED)) missing.push(`tailor-resume is missing: ${label}`);
    if (!pattern.test(FULLY)) missing.push(`tailor-resume-full is missing: ${label}`);
    if (!pattern.test(FALLBACK)) missing.push(`generate-cover-letter is missing: ${label}`);
  }
  assert.deepEqual(
    missing,
    [],
    'the two paths produce the same PDF and must read the same:\n' + missing.join('\n')
  );
});

test('each prompt still asks for the output its caller parses', () => {
  // The paths differ here on purpose and must not be "reconciled" into
  // agreement: resumeService reads the fallback's reply as raw text, while
  // tailorResume parses JSON and takes the coverLetter field out of it.
  assert.match(FALLBACK, /Return only the cover letter body text/);
  assert.doesNotMatch(FALLBACK, /"coverLetter": string/);

  for (const tailoring of [TAILORED, FULLY]) {
    assert.match(tailoring, /"coverLetter": string/);
    assert.match(tailoring, /Return only a valid JSON object/);
  }
});

test('the fallback asks only for inputs it is actually given', () => {
  // generateCoverLetter passes profileJson, companyName and role - there is no
  // job analysis on that path, because the whole point of it is that no job
  // description was provided. A rule referring to one would be unfollowable.
  const variables = [...FALLBACK.matchAll(/\[\[(\w+)\]\]/g)].map((match) => match[1]).sort();
  assert.deepEqual(variables, ['companyName', 'profileJson', 'role']);
  assert.doesNotMatch(FALLBACK, /KEY_RESPONSIBILITIES|jobAnalysisJson|skillsJSON/);
});

test('no prompt invents facts it is not asked to write', () => {
  assert.match(FALLBACK, /Never invent an achievement, employer or metric/);
  // Partial: the frame never, and nothing in a role the resume describes;
  // only a role it leaves empty is written from the posting (the owner kept
  // that rule, 2026-10-20), and the summary holds what the resume shows and
  // what those bullets describe.
  assert.match(TAILORED, /Never invent a company, title, date or location/);
  assert.match(TAILORED, /In every described role, never a metric, project, outcome, technology, tool or certification the profile does not show/);
  assert.match(TAILORED, /The summary holds what the profile shows and what the bullets you wrote for an empty role describe/);
  // Fully: the frame never; the work is what it is asked to write.
  assert.match(FULLY, /Never change or invent a company, title or date, and never add or drop a role/);
  // Every letter tells only what its resume tells.
  for (const tailoring of [TAILORED, FULLY]) assert.match(tailoring, /The letter tells only what the resume/);
});
