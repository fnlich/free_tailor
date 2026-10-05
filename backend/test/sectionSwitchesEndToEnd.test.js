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
 * previewed together - the builder's commonest shape - against a stub seat,
 * and this follows each one from the turn its model is sent to the HTML the
 * page draws.
 *
 * It also pins what is deliberately NOT per profile: the job analysis. It is
 * a function of the posting, the prompt and the model alone, so it is made
 * once and shared - in one request and, through the analysis cache, across
 * requests - whatever either profile's switches say. Putting the switches in
 * its key would buy a second identical answer for a seat turn each.
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

const TAILOR_ANSWER = JSON.stringify({
  title: 'Senior Engineer',
  summary: 'Engineer building reliable services.',
  experience: [
    {
      title: 'Engineer',
      company: 'Acme',
      startDate: '01/2020',
      endDate: 'Present',
      location: 'Remote',
      description: 'Built product services.',
      achievements: ['Cut build time by 37% by caching container layers.'],
    },
  ],
  strengths: [{ title: 'Container craft', description: 'Keeps builds fast and boring.' }],
  coverLetter: 'I build things.',
});

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
  ai.resetAnalysisCacheForTests();
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
      const text = request.callSite === 'tailor-resume' ? TAILOR_ANSWER : ANALYSIS_ANSWER;
      return { text, resolvedModel: request.modelName, providerId: 'claude-cli', droppedParams: [], latencyMs: 1 };
    },
  }));

  const users = require('../dist/database/userRepository');
  const { saveProfile } = require('../dist/database/profileRepository');
  const { buildNewProfile } = require('../dist/services/profileService');
  const owner = users.createUser({ email: 'owner@example.com' });
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

  const analyses = calls.filter((call) => call.callSite !== 'tailor-resume');
  const tailorings = calls.filter((call) => call.callSite === 'tailor-resume');
  assert.equal(analyses.length, 1, 'the posting is analysed once for both profiles');
  assert.equal(tailorings.length, 2);

  // What each model turn was told: the shipped prompt's variables and the
  // appended override agree, and each turn says its own profile's choices.
  const turnFor = (name) => tailorings.find((call) => call.userBody.includes(`"name":"${name}"`));
  const on = turnFor('Ada').userBody;
  const off = turnFor('Bea').userBody;
  assert.match(on, /Strengths section: yes\n/, 'the shipped prompt filled [[includeStrengths]]');
  assert.match(on, /Technical skills layout: plain\n/);
  assert.match(on, /Strengths section: yes\. Return 2-4/, 'and the override says the same');
  assert.match(off, /Strengths section: no\n/);
  assert.match(off, /Soft skills section: no\n/);
  assert.match(off, /Technical skills layout: grouped\n/);
  assert.match(off, /Return "strengths": \[\]/);

  // What came back, and what the page draws.
  const preview = (profileId) => response.body.previews.find((entry) => entry.profileId === profileId);
  const ada = preview('p-on');
  const bea = preview('p-off');

  assert.equal(ada.tailoredContent.strengths[0].title, 'Container craft');
  assert.equal(ada.tailoredContent.softSkills[0], 'Persistence');
  assert.ok(ada.tailoredContent.hardSkills.includes('Docker'));
  assert.equal(ada.tailoredContent.hardSkills.includes('Figma'), false, 'plain lists what is relevant, not everything');
  assert.match(ada.html, /class="section-title">Strengths</);
  assert.match(ada.html, /Container craft/);
  assert.match(ada.html, /class="section-title">Soft Skills</);
  assert.match(ada.html, /Persistence/);

  assert.deepEqual(bea.tailoredContent.strengths, []);
  assert.deepEqual(bea.tailoredContent.softSkills, []);
  assert.match(bea.tailoredContent.summary, /Working style: [^.]*Adaptable/);
  assert.ok(bea.tailoredContent.hardSkills.length > ada.tailoredContent.hardSkills.length, 'grouped still fills its headings');
  assert.doesNotMatch(bea.html, /Container craft|Persistence/);
  assert.doesNotMatch(bea.html, /class="section-title">(Strengths|Soft Skills)</);
  // Nothing to confirm for a section the resume does not show.
  assert.deepEqual(bea.tailoredContent.unconfirmedSoftSkills, []);

  // The same posting again, for one profile at a time: the analysis comes
  // from the cache whichever profile's switches ask.
  for (const profileId of ['p-off', 'p-on']) {
    const again = await post('/resume/preview-all', { profileIds: [profileId], jobDescription: POSTING });
    assert.equal(again.status, 200, JSON.stringify(again.body));
  }
  assert.equal(calls.filter((call) => call.callSite !== 'tailor-resume').length, 1, 'still one analysis');
  assert.equal(calls.filter((call) => call.callSite === 'tailor-resume').length, 4);
});

test('a switch the template has no section for is off for the model and the summary too', async (t) => {
  const { calls, post, close } = await serve();
  t.after(close);

  // Charcoal Sidebar prints neither section. With both switches on, the turn
  // must not be told to write strengths into a section that never prints, and
  // the posting's soft skills must stay in the summary rather than go to a
  // list that never prints - in the batch preview and the single one alike.
  for (const [route, body] of [
    ['/resume/preview-all', { profileIds: ['p-charcoal'], jobDescription: POSTING }],
    ['/resume/preview', { profileId: 'p-charcoal', jobDescription: POSTING }],
  ]) {
    const response = await post(route, body);
    assert.equal(response.status, 200, `${route}: ${JSON.stringify(response.body)}`);
    const turn = calls.filter((call) => call.callSite === 'tailor-resume').at(-1).userBody;
    assert.match(turn, /Strengths section: no\n/, route);
    assert.match(turn, /Soft skills section: no\n/, route);
    assert.match(turn, /Return "strengths": \[\]/, route);

    const content = route === '/resume/preview' ? response.body.tailoredContent : response.body.previews[0].tailoredContent;
    assert.deepEqual(content.strengths, [], route);
    assert.deepEqual(content.softSkills, [], route);
    assert.deepEqual(content.unconfirmedSoftSkills, [], route);
    assert.match(content.summary, /Working style: [^.]*Adaptable/, route);
  }
});
