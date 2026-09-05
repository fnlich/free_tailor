const assert = require('node:assert/strict');
const test = require('node:test');

const { loadFresh, useTempStorage, writeStaticJson } = require('./helpers');

/**
 * The AI facade, with a stub adapter standing in for every transport.
 *
 * These pin the properties the migration could have changed silently, because
 * nothing about them fails loudly: which prompt record is resolved, how many
 * times the prompt store is hit, which channel each part of the prompt reaches
 * the model through, and whether the tailor-resume skill instruction is still
 * delivered at all.
 */

function writePrompt(staticDir, id, content, extra = {}) {
  return writeStaticJson(staticDir, `prompts/${id}.json`, {
    id,
    content,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  });
}

/** Captures the request instead of running it. */
function stubAdapter(overrides = {}) {
  const requests = [];
  const adapter = {
    id: 'claude-cli',
    capabilities: {
      id: 'claude-cli',
      label: 'stub',
      temperature: false,
      maxOutputTokens: false,
      nativeJsonMode: 'json-schema',
      systemBlocks: true,
      requiresApiKey: false,
      credentialKind: 'subscription-seat',
      maxConcurrency: 4,
      ...overrides.capabilities,
    },
    defaultModelName: () => 'sonnet',
    health: async () => ({ ok: true, detail: 'stub', checkedAt: new Date().toISOString() }),
    async complete(request) {
      requests.push(request);
      return {
        text: overrides.text ?? '{"ok":true}',
        resolvedModel: request.modelName,
        providerId: 'claude-cli',
        droppedParams: [],
        latencyMs: 1,
      };
    },
  };
  return { adapter, requests };
}

function loadAi() {
  // Loaded fresh so the registry starts empty and the stub is the only adapter.
  const ai = loadFresh('../dist/services/ai/index');
  ai.resetRegistryForTests();
  return ai;
}

test('a prompt is split into an instruction channel and a data channel', async () => {
  const { staticDir } = useTempStorage('facade-split');
  writePrompt(staticDir, 'analyze-job-description', 'You analyze job posts.\nRules follow.\n[[jobDescription]]\nEnd.');

  const ai = loadAi();
  const { adapter, requests } = stubAdapter();
  ai.registerAdapter('claude-cli', () => adapter);

  await ai.createPromptCompletion({
    promptId: 'analyze-job-description',
    promptValues: { jobDescription: 'Senior Backend Engineer' },
    responseFormat: 'json',
    useExactPromptId: true,
  });

  assert.equal(requests.length, 1);
  const request = requests[0];

  // Everything before the first [[variable]] is instruction and goes in the
  // system channel; the rendered variable and everything after it is data.
  assert.equal(request.stableSystem, 'You analyze job posts.\nRules follow.\n');
  assert.equal(request.userBody, 'Senior Backend Engineer\nEnd.');
  assert.match(request.volatileSystem, /valid JSON only/);
  assert.equal(request.callSite, 'analyze-job-description');
});

test('a provider with no system channel receives every instruction in one turn', async () => {
  // The previous flat path silently dropped the JSON-only instruction, which
  // is why the one caller that used it had no JSON enforcement at all.
  const { staticDir } = useTempStorage('facade-flat');
  writePrompt(staticDir, 'analyze-job-description', 'Instructions here.\n[[jobDescription]]');

  const ai = loadAi();
  const { adapter, requests } = stubAdapter({ capabilities: { systemBlocks: false } });
  ai.registerAdapter('claude-cli', () => adapter);

  await ai.createPromptCompletion({
    promptId: 'analyze-job-description',
    promptValues: { jobDescription: 'A job' },
    responseFormat: 'json',
    useExactPromptId: true,
  });

  const request = requests[0];
  assert.equal(request.stableSystem, '');
  assert.equal(request.volatileSystem, '');
  assert.match(request.userBody, /valid JSON only/);
  assert.match(request.userBody, /Instructions here\./);
  assert.match(request.userBody, /A job/);
});

test('a prompt with no variables at all still produces a non-empty user turn', async () => {
  const { staticDir } = useTempStorage('facade-novars');
  writePrompt(staticDir, 'analyze-job-description', 'Just instructions, no variables.');

  const ai = loadAi();
  const { adapter, requests } = stubAdapter();
  ai.registerAdapter('claude-cli', () => adapter);

  await ai.createPromptCompletion({
    promptId: 'analyze-job-description',
    promptValues: {},
    responseFormat: 'text',
    useExactPromptId: true,
  });

  assert.ok(requests[0].userBody.trim().length > 0, 'an empty user turn is not a valid request');
});

test('appended instructions reach the model, in the user turn', async () => {
  // tailorResume appends its skill override this way. It used to be
  // string-concatenated onto the rendered text, which only reached providers
  // taking a single flat string - so on the structured path the model never
  // saw it, while the code downstream assumed it had been obeyed.
  const { staticDir } = useTempStorage('facade-append');
  writePrompt(staticDir, 'tailor-resume', 'Tailor this resume.\n[[profileJson]]');

  const ai = loadAi();
  const { adapter, requests } = stubAdapter();
  ai.registerAdapter('claude-cli', () => adapter);

  await ai.createPromptCompletion({
    promptId: 'tailor-resume',
    promptValues: { profileJson: '{"name":"Jane"}' },
    responseFormat: 'json',
    useExactPromptId: true,
    appendToUserBody: 'FINAL SKILL OVERRIDE:\nDo not return skills.',
  });

  assert.match(requests[0].userBody, /FINAL SKILL OVERRIDE/);
  assert.match(requests[0].userBody, /Jane/);
  // It is an instruction about the DATA, so it belongs with the data - putting
  // it in the stable system prefix would make it look byte-stable when the
  // record it qualifies is not.
  assert.equal(requests[0].stableSystem.includes('FINAL SKILL OVERRIDE'), false);
});

test('tailorResume still delivers its skill override after the transport change', async () => {
  const { staticDir } = useTempStorage('facade-tailor');
  writePrompt(staticDir, 'tailor-resume', 'Tailor.\n[[profileJson]]\n[[jobAnalysisJson]]');
  writePrompt(staticDir, 'analyze-job-description', 'Analyze.\n[[jobDescription]]');

  const ai = loadAi();
  const { adapter, requests } = stubAdapter({
    text: JSON.stringify({
      title: 'Engineer',
      summary: 'A summary.',
      experience: [],
      strengths: [],
      hardSkills: [],
      softSkills: [],
      coverLetter: '',
    }),
  });
  ai.registerAdapter('claude-cli', () => adapter);

  const resumeService = loadFresh('../dist/services/resumeService');
  await resumeService.tailorResume(
    { id: 'p1', name: 'Jane', experience: [], skills: [], education: [] },
    {
      jobMeta: { title: 'Engineer', seniority: '', industry: '', department: '' },
      skills: { technical: [], required: [], preferred: [], tools: [], soft: [], technologies: [] },
      technologies: [],
      protocols: [],
      methodologies: [],
      architecturePatterns: [],
      responsibilities: [],
      domainKnowledge: [],
      softSkills: [],
      keywords: { actionVerbs: [], buzzwords: [], mustInclude: [] },
    },
    'claude-cli'
  );

  assert.equal(requests.length, 1);
  assert.match(
    requests[0].userBody,
    /FINAL SKILL OVERRIDE/,
    'the skill override must still reach the model on the structured path'
  );
});

test('a prompt record model override beats the caller, and a stale provider id still resolves', async () => {
  const { staticDir } = useTempStorage('facade-override');
  writePrompt(staticDir, 'analyze-job-description', 'Analyze.\n[[jobDescription]]', {
    modelProvider: 'openrouter',
    modelName: 'opus',
  });

  const ai = loadAi();
  const { adapter, requests } = stubAdapter();
  ai.registerAdapter('claude-cli', () => adapter);

  await ai.createPromptCompletion({
    promptId: 'analyze-job-description',
    promptValues: { jobDescription: 'A job' },
    fallbackProvider: 'openai',
    fallbackModelName: 'gpt-5.1',
    useExactPromptId: true,
  });

  // The record wins over the caller's fallback, and the removed provider id it
  // names is read as the provider that replaced it rather than throwing.
  assert.equal(requests[0].modelName, 'opus');
});

test('a disabled provider is refused with a status a route can act on', async () => {
  const { staticDir } = useTempStorage('facade-disabled');
  writePrompt(staticDir, 'analyze-job-description', 'Analyze.\n[[jobDescription]]');

  // Not loadFresh: the facade reads through the module-cached instance, so
  // a second copy would write settings the facade never sees.
  const config = require('../dist/config/aiModelConfig');
  await config.updateAppSettings({
    providersEnabled: { 'claude-cli': false, claude: true, openai: true, deepseek: true },
  });

  const ai = loadAi();
  const { adapter } = stubAdapter();
  ai.registerAdapter('claude-cli', () => adapter);

  await assert.rejects(
    () =>
      ai.createPromptCompletion({
        promptId: 'analyze-job-description',
        promptValues: { jobDescription: 'A job' },
        fallbackProvider: 'claude-cli',
        useExactPromptId: true,
      }),
    (error) => ai.isAIProviderError(error) && error.kind === 'disabled' && error.httpStatus === 409
  );
});
