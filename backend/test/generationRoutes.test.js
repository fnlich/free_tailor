const assert = require('node:assert/strict');
const test = require('node:test');

process.env.AI_UNLOCKED_PROVIDERS = 'claude-cli';

const { loadFresh, useTempStorage } = require('./helpers');

/**
 * The batch HTTP surface.
 *
 * What it has to get right is the CONTRACT, not the work: the submit returns
 * before anything has run, the snapshot tells a page where the work has got to,
 * and the stream opens with a complete picture so a page that reloaded can pick
 * it back up without reconciling what it missed.
 */

async function serve() {
  const { dbDir } = useTempStorage(`generation-routes-${Math.random().toString(36).slice(2)}`);
  const express = require('express');

  const { saveProfile } = loadFresh('../dist/database/profileRepository');
  const { buildNewProfile } = loadFresh('../dist/services/profileService');
  saveProfile(
    buildNewProfile(
      {
        name: 'Ada',
        title: 'Engineer',
        skills: ['C#'],
        contact: { email: 'a@b.c', phone: '1', location: 'X' },
        summary: 's',
        experience: [],
        strengths: [],
        education: [],
      },
      'p1'
    )
  );

  const config = loadFresh('../dist/config/aiModelConfig');
  await config.updateAppSettings({
    browserChatEndpoints: [
      { siteId: 'claude-web', port: 9801 },
      { siteId: 'chatgpt-web', port: 9802 },
    ],
  });

  const queue = loadFresh('../dist/services/queue/index');
  queue.resetGenerationQueueForTests();
  const routes = loadFresh('../dist/routes/generation');

  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use('/api/generation', routes.default);
  const server = app.listen(0);
  const port = server.address().port;

  return {
    dbDir,
    routes,
    close: () => server.close(),
    call: (path, init) =>
      fetch(`http://127.0.0.1:${port}/api/generation${path}`, init),
    post: (path, body) =>
      fetch(`http://127.0.0.1:${port}/api/generation${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
  };
}

function jobsFor(count) {
  return Array.from({ length: count }, (_, index) => ({
    companyName: `Company ${index}`,
    role: 'Engineer',
    jobDescription: 'A job description long enough to be analysed. '.repeat(4),
    sourceRowNumber: index + 1,
  }));
}

test('submitting returns before any of the work has run', async () => {
  // The whole contract. Ten resumes are minutes of work; the page must get its
  // id back immediately and read the rest separately.
  const server = await serve();
  try {
    const startedAt = Date.now();
    const response = await server.post('/batches', { jobs: jobsFor(10), profileIds: ['p1'] });
    const elapsed = Date.now() - startedAt;
    const body = await response.json();

    assert.equal(response.status, 202, 'accepted, not "here is your answer"');
    assert.ok(body.batchId.startsWith('bat_'));
    assert.equal(body.total, 10, 'ten jobs and one profile is ten tasks');
    assert.equal(body.jobCount, 10);
    assert.ok(elapsed < 5_000, `submitting took ${elapsed}ms, so it waited for work`);
  } finally {
    server.close();
  }
});

test('the cross-product is built on the server, not sent by the page', async () => {
  // Three jobs and one profile is three tasks. The page sends jobs and profile
  // ids; it does not have to know that a task is a pair.
  const server = await serve();
  try {
    const body = await (await server.post('/batches', { jobs: jobsFor(3) })).json();
    assert.equal(body.total, 3);
    assert.equal(body.profileCount, 1);
  } finally {
    server.close();
  }
});

test('a snapshot says where the work has got to', async () => {
  const server = await serve();
  try {
    const { batchId } = await (await server.post('/batches', { jobs: jobsFor(4) })).json();
    const snapshot = await (await server.call(`/batches/${batchId}`)).json();

    assert.equal(snapshot.batchId, batchId);
    assert.equal(snapshot.total, 4);
    assert.equal(snapshot.queued + snapshot.running + snapshot.completed + snapshot.failed, 4);
    assert.equal(snapshot.tasks.length, 4);
    assert.equal(snapshot.tasks[0].companyName, 'Company 0');
    assert.equal(snapshot.tasks[0].seq, 0, 'tasks stay in submitted order');
    assert.equal(snapshot.label, 'Generation');
  } finally {
    server.close();
  }
});

test('a batch can be found again without knowing its id', async () => {
  // What a reloaded page needs: it may have lost the id, or be a different
  // browser entirely.
  const server = await serve();
  try {
    const { batchId } = await (await server.post('/batches', { jobs: jobsFor(2) })).json();
    const listed = await (await server.call('/batches?active=1')).json();
    assert.ok(
      listed.batches.some((batch) => batch.batchId === batchId) ||
        (await (await server.call('/batches')).json()).batches.some((b) => b.batchId === batchId),
      'the batch must be discoverable by listing'
    );
  } finally {
    server.close();
  }
});

test('an id the server no longer holds says so, and says why', async () => {
  // A page holding an id from before a restart would otherwise retry for ever.
  const server = await serve();
  try {
    const response = await server.call('/batches/bat_gone');
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.reason, 'restarted-or-expired');
    assert.match(body.error, /no longer on the server/);
  } finally {
    server.close();
  }
});

test('the stream opens with a complete snapshot', async () => {
  // This is what makes reconnecting trivially correct: a reader that joins late
  // never has to reconcile the events it missed.
  const server = await serve();
  try {
    const { batchId } = await (await server.post('/batches', { jobs: jobsFor(3) })).json();
    const stream = await server.call(`/batches/${batchId}/stream`);

    assert.equal(stream.status, 200);
    assert.match(stream.headers.get('content-type'), /application\/x-ndjson/);

    const reader = stream.body.getReader();
    const chunk = await reader.read();
    const first = JSON.parse(new TextDecoder().decode(chunk.value).split('\n')[0]);
    assert.equal(first.type, 'snapshot');
    assert.equal(first.total, 3);
    assert.ok(Array.isArray(first.tasks), 'the whole picture, not a delta');
    await reader.cancel();
  } finally {
    server.close();
  }
});

test('a submission that could never work is refused before anything is queued', async () => {
  // Refused once, rather than discovered thirty times as thirty failed tasks.
  const server = await serve();
  try {
    const noJobs = await server.post('/batches', { jobs: [] });
    assert.equal(noJobs.status, 400);
    assert.match((await noJobs.json()).error, /At least one job/);

    const noCompany = await server.post('/batches', {
      jobs: [{ role: 'Engineer', jobDescription: 'x'.repeat(200) }],
    });
    assert.equal(noCompany.status, 400);
    assert.match((await noCompany.json()).error, /company name/);
  } finally {
    server.close();
  }
});

test('a missing role is NOT refused when a job description could name one', async () => {
  // The analysis is what names the role when a sheet row does not, and it has
  // not run at submit time. Refusing here would reject a perfectly good import.
  const server = await serve();
  try {
    const response = await server.post('/batches', {
      jobs: [{ companyName: 'Acme', jobDescription: 'A long job description. '.repeat(10) }],
    });
    assert.equal(response.status, 202);
  } finally {
    server.close();
  }
});

test('cancelling reports what it dropped, and twice is not an error', async () => {
  const server = await serve();
  try {
    const { batchId } = await (await server.post('/batches', { jobs: jobsFor(6) })).json();
    const first = await server.post(`/batches/${batchId}/cancel`, {});
    if (first.status === 200) {
      const outcome = await first.json();
      assert.ok(outcome.cancelled + outcome.aborted > 0);
      const second = await server.post(`/batches/${batchId}/cancel`, {});
      assert.equal(second.status, 404, 'cancelling a stopped batch is a 404, not a 500');
    } else {
      // The batch finished before the cancel landed, which is also correct.
      assert.equal(first.status, 404);
    }
  } finally {
    server.close();
  }
});

test('a task routes to a queue by the profile model, not by the request', async () => {
  const { routeFor } = loadFresh('../dist/routes/generation');
  assert.deepEqual(routeFor({ provider: 'claude-web' }), {
    queue: 'browser',
    sites: ['claude-web'],
  });
  assert.deepEqual(routeFor({ provider: 'chatgpt-web' }), {
    queue: 'browser',
    sites: ['chatgpt-web'],
  });
  assert.deepEqual(routeFor({ provider: 'claude-web', route: 'hybrid' }), {
    queue: 'browser',
    sites: ['claude-web', 'chatgpt-web'],
  });
  // The seat and the metered providers share the non-browser queue: neither has
  // a local browser to wait for, and a third queue would do nothing.
  assert.deepEqual(routeFor({ provider: 'claude-cli' }), { queue: 'cli' });
  assert.deepEqual(routeFor({ provider: 'openai' }), { queue: 'cli' });
});
