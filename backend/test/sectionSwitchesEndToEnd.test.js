const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

// The stub below stands in for the subscription seat. Set before any dist
// module loads.
process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli';

const { useTempStorage } = require('./helpers');

/**
 * Two profiles, one posting, through the real routes.
 *
 * One profile has switched Strengths and Soft Skills on and lays its skills
 * out plain; the other is as every profile was before the switches. They are
 * previewed together - the builder's commonest shape - against a stub seat
 * that answers like the shipped prompt (the skills block in groups, the
 * posting's soft skills last under the heading the turn names), and this
 * follows each one from the turn its model is sent to the HTML the page
 * draws: the same kind of answer, drawn by each profile's own switches.
 *
 * It also pins what is deliberately NOT per profile: the job analysis. It is
 * a reading of the posting alone, so it is made once and shared - in one
 * request and, through the stored analyses (services/jobAnalysis/gate.ts),
 * for ever - whatever either profile's switches say. Keying it on the
 * switches would buy a second identical answer for a seat turn each.
 */

const POSTING = [
  'Senior engineer wanted to ship TypeScript services packaged with Docker.',
  'You are Adaptable and bring strong Communication to a small platform team.',
].join('\n');

const ANALYSIS_ANSWER = JSON.stringify({
  jobMeta: { title: 'Senior Engineer', seniority: 'senior', industry: 'SaaS', department: 'Platform' },
  skills: { technical: ['TypeScript', 'Docker'], tools: [], soft: ['Adaptable'] },
  responsibilities: ['container build pipeline delivery'],
  domainKnowledge: [],
  keywords: { actionVerbs: [], buzzwords: [], mustInclude: [] },
});

/** The analysis's second call: the Job Facts (Filter) prompt's facts, and the code's job field. */
const FACTS_ANSWER = JSON.stringify({
  job_type: 'remote',
  onsite_interview: 'no',
  company_category: 'saas',
  seniority: 'senior',
  clearance_required: 'none',
  salary: { min: null, max: null, period: null, raw: null },
  region: 'us',
  us_state: null,
  job_field: 'backend',
});

/** What each prompt answers, by its call site; one this test does not expect fails loudly. */
const ANSWERS = {
  'analyze-job-description': ANALYSIS_ANSWER,
  'filter-google-sheet-job': FACTS_ANSWER,
  'revise-resume-coverage': '{}',
};

/**
 * The tailoring, as the shipped prompt asks: the skills block in groups, the
 * last one the posting's soft skills under the heading this turn was told to
 * use. A strength too - which the prompt never asks for, and nothing reads.
 */
function tailorAnswer(request) {
  const heading = /Head it exactly (.+?) - that heading/.exec(request.userBody)?.[1];
  if (!heading) throw new Error('stub seat: the turn names no soft-skill heading');
  return JSON.stringify({
    title: 'Senior Engineer',
    summary: 'Engineer building reliable services.',
    experience: [
      {
        title: 'Engineer',
        company: 'Acme',
        startDate: '01/2020',
        endDate: 'Present',
        location: 'Remote',
        description: '',
        achievements: ['Cut build time by 37% by caching container layers.'],
      },
    ],
    skillGroups: [
      { category: 'Languages', skills: ['TypeScript'] },
      { category: 'Containers', skills: ['Docker'] },
      { category: heading, skills: ['Adaptable', 'Teamwork'] },
    ],
    strengths: [{ title: 'Container craft', description: 'Keeps builds fast and boring.' }],
    coverLetter: 'I build things.',
  });
}

function profileInput(name, settings) {
  return {
    name,
    title: 'Senior Engineer',
    contact: { email: `${name.toLowerCase()}@example.com`, phone: '1', location: 'Remote' },
    summary: 'Engineer who ships.',
    experience: [
      {
        title: 'Engineer',
        company: 'Acme',
        startDate: '01/2020',
        endDate: 'Present',
        location: 'Remote',
        description: 'Built product services.',
        achievements: ['Cut build time by 37%.'],
        skills: [],
      },
    ],
    strengths: [{ title: 'Own strength', description: 'In her own words.' }],
    skills: ['TypeScript', 'Kubernetes', 'Figma'],
    softSkills: ['Persistence'],
    education: [],
    profileSettings: settings,
  };
}

async function serve() {
  const { staticDir } = useTempStorage('section-switches-e2e');
  const shipped = path.join(__dirname, '..', 'static');
  fs.cpSync(path.join(shipped, 'skills'), path.join(staticDir, 'skills'), { recursive: true });
  fs.cpSync(path.join(shipped, 'prompts'), path.join(staticDir, 'prompts'), { recursive: true });
  fs.mkdirSync(path.join(staticDir, 'templates'), { recursive: true });
  for (const id of ['default', 'charcoal-sidebar']) {
    fs.copyFileSync(path.join(shipped, 'templates', `${id}.json`), path.join(staticDir, 'templates', `${id}.json`));
  }

  const ai = require('../dist/services/ai/index');
  ai.resetRegistryForTests();
  require('../dist/services/jobAnalysis/gate').resetAnalysisGateForTests();
  const calls = [];
  ai.registerAdapter('claude-cli', () => ({
    id: 'claude-cli',
    capabilities: {
      id: 'claude-cli', label: 'stub', temperature: false, maxOutputTokens: false,
      nativeJsonMode: 'json-schema', systemBlocks: true, maxConcurrency: 4,
    },
    defaultModelName: () => 'sonnet',
    health: async () => ({ ok: true, detail: 'stub', checkedAt: new Date().toISOString() }),
    async complete(request) {
      calls.push(request);
      const text = request.callSite === 'tailor-resume' ? tailorAnswer(request) : ANSWERS[request.callSite];
      if (text === undefined) throw new Error(`stub seat: no answer for call site "${request.callSite}"`);
      return { text, resolvedModel: request.modelName, providerId: 'claude-cli', droppedParams: [], latencyMs: 1 };
    },
  }));

  const users = require('../dist/database/userRepository');
  const { saveProfile } = require('../dist/database/profileRepository');
  const { buildNewProfile } = require('../dist/services/profileService');
  // Premium, because the preview below covers several profiles at once,
  // which a Default subscription may not (test/subscriptionGates.test.js).
  const owner = users.updateUser(users.createUser({ email: 'owner@example.com' }).id, { subscription: 'premium' });
  const token = users.createSession(owner.id);
  saveProfile({
    ...buildNewProfile(
      profileInput('Ada', { includeStrengths: true, includeSoftSkills: true, technicalSkillsLayout: 'flat' }),
      'p-on'
    ),
    ownerId: owner.id,
  });
  saveProfile({ ...buildNewProfile(profileInput('Bea', {}), 'p-off'), ownerId: owner.id });
  // Both switches on, drawn with a template that has nowhere to print either.
  saveProfile({
    ...buildNewProfile(
      {
        ...profileInput('Cy', { includeStrengths: true, includeSoftSkills: true }),
        preferredTemplate: 'charcoal-sidebar',
      },
      'p-charcoal'
    ),
    ownerId: owner.id,
  });

  const { attachUser } = require('../dist/middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/resume', require('../dist/routes/resume').default);
  const server = app.listen(0);
  const port = server.address().port;

  const post = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}/api${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  return { calls, post, close: () => server.close() };
}

test("each profile is tailored by its own switches, on one analysis of the posting", async (t) => {
  const { calls, post, close } = await serve();
  t.after(close);

  const response = await post('/resume/preview-all', { profileIds: ['p-on', 'p-off'], jobDescription: POSTING });
  assert.equal(response.status, 200, JSON.stringify(response.body));

  const of = (site) => calls.filter((call) => call.callSite === site);
  const tailorings = of('tailor-resume');
  assert.equal(of('analyze-job-description').length, 1, 'the posting is analysed once for both profiles');
  assert.equal(of('filter-google-sheet-job').length, 1, 'its facts asked once with it');
  assert.equal(tailorings.length, 2);
  // Each draft leaves the posting's terms out, so each is revised once (the
  // stub's revision changes nothing).
  assert.equal(of('revise-resume-coverage').length, 2);

  // What each model turn was told: the same lists - the posting's - and no
  // word about either profile's switches; a heading drawn for each resume.
  const turnFor = (name) => tailorings.find((call) => call.userBody.includes(`"name":"${name}"`)).userBody;
  const on = turnFor('Ada');
  const off = turnFor('Bea');
  for (const turn of [on, off]) {
    assert.match(turn, /THE FIVE THIS POSTING LEANS ON:\n\["TypeScript","Docker"\]/);
    assert.doesNotMatch(turn, /Strengths section|Soft skills section|Technical skills layout|FINAL SKILL OVERRIDE/);
  }
  // Strengths reach the model only as hers, only while the switch is on.
  assert.match(on, /"strengths":\[\{"title":"Own strength"/);
  assert.doesNotMatch(off, /Own strength/);

  // What came back, and what the page draws.
  const preview = (profileId) => response.body.previews.find((entry) => entry.profileId === profileId);
  const ada = preview('p-on');
  const bea = preview('p-off');

  // Ada: her OWN strength, never the model's; the posting's soft skills in
  // their own section; the technical skills one plain list.
  assert.deepEqual(ada.tailoredContent.strengths, [{ title: 'Own strength', description: 'In her own words.' }]);
  assert.deepEqual(ada.tailoredContent.softSkills, ['Adaptable', 'Teamwork']);
  assert.deepEqual(ada.tailoredContent.hardSkills, ['TypeScript', 'Docker']);
  assert.match(ada.html, /class="section-title">Strengths</);
  assert.match(ada.html, /Own strength/);
  assert.doesNotMatch(ada.html, /Container craft/);
  assert.match(ada.html, /class="section-title">Soft Skills</);
  assert.equal(ada.html.split('Adaptable').length - 1, 1, 'the soft skills print once - in their section');
  assert.doesNotMatch(ada.html, /Persistence/, "her own soft skills give way to the posting's");

  // Bea: no Strengths, no Soft Skills section - the soft group stays the last
  // group of her Technical Skills, under the heading drawn for her resume.
  const beaHeading = /Head it exactly (.+?) - that heading/.exec(off)[1];
  assert.deepEqual(bea.tailoredContent.strengths, []);
  assert.deepEqual(bea.tailoredContent.softSkills, []);
  assert.equal(bea.tailoredContent.skillGroups.at(-1).category, beaHeading);
  assert.equal(bea.tailoredContent.summary, 'Engineer building reliable services.', 'no sentence added');
  assert.doesNotMatch(bea.html, /Container craft|Persistence/);
  assert.doesNotMatch(bea.html, /class="section-title">(Strengths|Soft Skills)</);
  assert.ok(bea.html.includes(beaHeading.replace(/&/g, '&amp;')), 'the soft group prints under its heading');
  assert.equal(bea.html.split('Adaptable').length - 1, 1);
  // Nothing to confirm for a section the resume does not show.
  assert.deepEqual(bea.tailoredContent.unconfirmedSoftSkills, []);

  // The same posting again, for one profile at a time: the analysis comes
  // from the store whichever profile's switches ask, and - nothing about
  // either profile, the model or the prompts having changed - so does each
  // tailoring, revision included (owner decision P6), drawn by its own
  // switches again.
  for (const profileId of ['p-off', 'p-on']) {
    const again = await post('/resume/preview-all', { profileIds: [profileId], jobDescription: POSTING });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    const repeat = again.body.previews[0];
    assert.deepEqual(repeat.tailoredContent, preview(profileId).tailoredContent);
  }
  assert.equal(of('analyze-job-description').length, 1, 'still one analysis');
  assert.equal(of('filter-google-sheet-job').length, 1);
  assert.equal(of('tailor-resume').length, 2, 'and no second tailoring');
  assert.equal(of('revise-resume-coverage').length, 2, 'nor a second revision');
});

test('a switch the template has no section for is off for the model and the content too', async (t) => {
  const { calls, post, close } = await serve();
  t.after(close);

  // Charcoal Sidebar prints neither section. With both switches on, the turn
  // is not given strengths for a section that never prints, and the
  // posting's soft skills stay in the skills block rather than going to a
  // list that never prints - in the batch preview and the single one alike.
  for (const [route, body] of [
    ['/resume/preview-all', { profileIds: ['p-charcoal'], jobDescription: POSTING }],
    ['/resume/preview', { profileId: 'p-charcoal', jobDescription: POSTING }],
  ]) {
    const response = await post(route, body);
    assert.equal(response.status, 200, `${route}: ${JSON.stringify(response.body)}`);
    const turn = calls.filter((call) => call.callSite === 'tailor-resume').at(-1).userBody;
    assert.doesNotMatch(turn, /Own strength/, route);

    const content = route === '/resume/preview' ? response.body.tailoredContent : response.body.previews[0].tailoredContent;
    assert.deepEqual(content.strengths, [], route);
    assert.deepEqual(content.softSkills, [], route);
    assert.deepEqual(content.unconfirmedSoftSkills, [], route);
    assert.deepEqual(content.skillGroups.at(-1).skills, ['Adaptable', 'Teamwork'], route);
    assert.equal(content.summary, 'Engineer building reliable services.', route);
  }
});
