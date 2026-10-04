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
 *
 * Run with the subscription seat unlocked. The stub is registered as the CLI
 * transport, so these describe an install where that seat is present - and
 * that keeps them about the facade rather than about the lock, which is what
 * providerLock.test.js covers. Set before any dist module loads: the lock is
 * read from the environment on every call, but the settings defaults are
 * computed at import.
 */
process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli';

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

test('a provider with no system channel gets the instructions exactly once, not twice and not never', async () => {
  // The trap this pins: the facade folds the system text into the user body for
  // a provider with no system channel (codex-cli and the OpenAI-compatible
  // transports), and an adapter that ALSO joined the three parts would send the
  // instructions twice. Get it wrong the other way and the JSON-only
  // instruction never arrives at all, which is silent - the reply is simply
  // prose that fails to parse somewhere else, later.
  const { staticDir } = useTempStorage('facade-flat-once');
  writePrompt(staticDir, 'analyze-job-description', 'SYSTEM-PREAMBLE-MARKER\nMore rules.\n[[jobDescription]]');

  const ai = loadAi();
  const { adapter, requests } = stubAdapter({ capabilities: { systemBlocks: false } });
  ai.registerAdapter('claude-cli', () => adapter);

  await ai.createPromptCompletion({
    promptId: 'analyze-job-description',
    promptValues: { jobDescription: 'USER-BODY-MARKER' },
    responseFormat: 'json',
    useExactPromptId: true,
  });

  assert.equal(requests.length, 1);
  const request = requests[0];
  // Everything an adapter could send, however it joins the parts.
  const sent = [request.stableSystem, request.volatileSystem, request.userBody].join('\n');
  const occurrences = (needle) => sent.split(needle).length - 1;

  assert.equal(occurrences('SYSTEM-PREAMBLE-MARKER'), 1, 'the preamble must arrive exactly once');
  assert.equal(occurrences('USER-BODY-MARKER'), 1, 'the rendered variables must arrive once');
  assert.equal(occurrences('valid JSON only'), 1, 'and so must the JSON-only instruction');
});

test('a provider with no JSON mode is asked for sentinels; one that enforces JSON is not', async () => {
  // The instruction is chosen by what the TRANSPORT can enforce, not by its
  // name. One that enforces nothing (nativeJsonMode 'none' - a CLI with no
  // structured-output flag) needs the long instruction plus the markers the
  // extractor keys on. One with a native JSON mode is already constrained, and
  // asking IT for sentinels would put them inside the JSON it is obliged to
  // emit - turning the one output guaranteed to parse into one guaranteed not to.
  const { JSON_BEGIN_SENTINEL, JSON_END_SENTINEL } = require('../dist/services/ai/promptAssembly');
  const { staticDir } = useTempStorage('facade-sentinels');
  writePrompt(staticDir, 'analyze-job-description', 'Extract what matters.\n[[jobDescription]]');

  const run = async (capabilities, text) => {
    const ai = loadAi();
    const { adapter, requests } = stubAdapter({ capabilities, text });
    ai.registerAdapter('claude-cli', () => adapter);
    await ai.createPromptCompletion({
      promptId: 'analyze-job-description',
      promptValues: { jobDescription: 'a job description' },
      responseFormat: 'json',
      useExactPromptId: true,
    });
    const request = requests[0];
    return [request.stableSystem, request.volatileSystem, request.userBody].join('\n');
  };

  const unenforced = await run(
    { nativeJsonMode: 'none' },
    `${JSON_BEGIN_SENTINEL}\n{"ok":true}\n${JSON_END_SENTINEL}`
  );
  assert.ok(unenforced.includes(JSON_BEGIN_SENTINEL), 'it must be told which markers to emit');
  assert.ok(unenforced.includes(JSON_END_SENTINEL));
  assert.match(unenforced, /No preamble/i, 'and told not to narrate, which is what it does by default');
  assert.match(unenforced, /trailing commas/i);

  const enforced = await run({ nativeJsonMode: 'json-schema' });
  assert.equal(enforced.includes(JSON_BEGIN_SENTINEL), false, 'json-schema is not asked for sentinels');
  assert.match(enforced, /valid JSON only/);
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
    fallbackProvider: 'codex-cli',
    fallbackModelName: 'default',
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
    providersEnabled: { 'claude-cli': false, 'codex-cli': true },
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

test("each seat's failures name what that seat needs to an administrator, and nothing to anybody else", async () => {
  // Every provider shared the Claude seat's sentences once, so a signed-out
  // Codex seat told the person to sign the Claude subscription in - on an
  // install where that seat may well be locked. The seat-specific sentences
  // are now the administrator's `detail`; everybody else hears one of four
  // sentences that name no seat at all.
  const ai = loadAi();
  const { publicFailure } = require('../dist/middleware/publicError');
  const quiet = console.error;
  console.error = () => {};
  try {
    for (const kind of ['auth', 'rateLimited', 'binaryMissing']) {
      const error = new ai.AIProviderError({ provider: 'codex-cli', kind, detail: 'x' });
      const asAdmin = publicFailure(error, { admin: true });
      assert.match(asAdmin.body.detail, /Codex/, kind);
      assert.doesNotMatch(asAdmin.body.detail, /Claude|claude auth/, kind);

      const asUser = publicFailure(error, { admin: false });
      assert.equal(asUser.body.detail, undefined, `${kind}: no detail for anybody else`);
      assert.doesNotMatch(asUser.body.error, /Codex|Claude|codex|claude|CLI|PATH/, kind);
      assert.match(asUser.body.ref, /^ERR-[0-9A-F]{6}$/, kind);
      assert.equal('provider' in asUser.body, false, `${kind}: never the provider id`);
      assert.equal('adminAction' in asUser.body, false, `${kind}: never the admin action`);
    }
    // And the Claude seat keeps the sentences that were always its own - for
    // the administrator.
    const seat = publicFailure(new ai.AIProviderError({ provider: 'claude-cli', kind: 'auth' }), { admin: true });
    assert.match(seat.body.detail, /claude auth login/);
  } finally {
    console.error = quiet;
  }
});

test('an AI failure is one of four public sentences, by what the reader can do about it', async () => {
  const ai = loadAi();
  const { publicFailure } = require('../dist/middleware/publicError');
  const quiet = console.error;
  console.error = () => {};
  try {
    const said = (kind, extra = {}) =>
      publicFailure(new ai.AIProviderError({ provider: 'gemini-cli', kind, ...extra }), { admin: false });

    // Wait: a spent usage window is 429 with when to come back.
    const busy = said('rateLimited', { retryAfterSeconds: 120 });
    assert.equal(busy.status, 429);
    assert.equal(busy.body.error, ai.PUBLIC_AI_MESSAGE.busy);
    assert.equal(busy.body.code, 'ai-busy');
    assert.equal(busy.body.retryAfterSeconds, 120);
    assert.deepEqual(busy.headers, { 'Retry-After': '120' });

    // Ask for less.
    const timeout = said('timeout');
    assert.equal(timeout.status, 504);
    assert.equal(timeout.body.error, ai.PUBLIC_AI_MESSAGE.timeout);

    // Simply try again.
    for (const kind of ['stalled', 'unavailable', 'truncated', 'malformedOutput', 'failed']) {
      assert.equal(said(kind).body.error, ai.PUBLIC_AI_MESSAGE.retry, kind);
    }

    // Tell somebody - one sentence and a 503, whatever the server-side cause.
    for (const kind of ['auth', 'binaryMissing', 'misconfigured', 'locked', 'disabled', 'modelUnavailable']) {
      const failure = said(kind);
      assert.equal(failure.status, 503, kind);
      assert.equal(failure.body.error, ai.PUBLIC_AI_MESSAGE.contactAdmin, kind);
      assert.equal(failure.body.code, 'ai-unavailable', kind);
    }

    // A full semaphore is `unavailable` to the transport and "busy" to a person.
    const full = publicFailure(
      new ai.AIProviderError({ provider: 'claude-cli', kind: 'unavailable', publicFailure: 'busy' }),
      { admin: false }
    );
    assert.equal(full.body.error, ai.PUBLIC_AI_MESSAGE.busy);
  } finally {
    console.error = quiet;
  }
});

test('an explicitly registered adapter wins, and the other providers still exist', async () => {
  // registerDefaults used to bail when the factory map was non-empty, so a
  // single overridden provider left every other one unregistered - and once
  // fixed, the defaults must still not clobber the explicit registration.
  const ai = loadAi();
  const { adapter } = stubAdapter();
  ai.registerAdapter('claude-cli', () => adapter);

  const capabilities = ai.listProviderCapabilities();
  const ids = capabilities.map((entry) => entry.id).sort();
  // The subscription seats, and nothing else: the metered APIs are retired.
  assert.deepEqual(ids, ['claude-cli', 'codex-cli', 'gemini-cli']);
  for (const entry of capabilities) {
    assert.equal('requiresApiKey' in entry, false, `${entry.id} has no key to require`);
  }
  assert.equal(
    capabilities.find((entry) => entry.id === 'claude-cli').label,
    'stub',
    'the explicitly registered adapter must not be replaced by the built-in'
  );
});

test('the call site can be named separately from the prompt record', async () => {
  // Timeouts and usage buckets key on callSite. Defaulting it to the prompt id
  // meant a profile with a CUSTOM resume prompt silently got the short default
  // budget instead of the long tailor-resume one.
  const { staticDir } = useTempStorage('facade-callsite');
  writePrompt(staticDir, 'tailor-resume', 'Tailor.\n[[profileJson]]');

  // A per-profile custom prompt is a database record, which is exactly why its
  // id is a bad key for a feature-level timeout.
  const promptService = loadFresh('../dist/services/promptService');
  const custom = await promptService.createPrompt({
    name: 'My Resume Prompt',
    content: 'Tailor mine.\n[[profileJson]]',
    allowedVariables: [{ name: 'profileJson', description: 'Profile', sampleValue: '{}' }],
  });

  const ai = loadAi();
  const { adapter, requests } = stubAdapter();
  ai.registerAdapter('claude-cli', () => adapter);

  await ai.createPromptCompletion({
    promptId: custom.id,
    callSite: 'tailor-resume',
    promptValues: { profileJson: '{}' },
    useExactPromptId: true,
  });

  assert.notEqual(custom.id, 'tailor-resume');

  assert.equal(requests[0].callSite, 'tailor-resume');
});
