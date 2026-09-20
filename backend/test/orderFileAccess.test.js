const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const path = require('path');

const { loadFresh, useTempStorage, writeSettingRaw } = require('./helpers');

/**
 * The two older download routes, and the hole that orders opened in them.
 *
 * `/api/generated/:path` and `/api/resume/download/:path` check only that the
 * caller is signed in. That was defensible while a generated path was an opaque
 * thing you had to be told - the route's own comment concedes it is "guessable
 * enough that 'you would have to know the URL' is not a control".
 *
 * Orders changed the arithmetic. An ordered resume is filed under a FIXED,
 * published template - account email, date, order number, profile, company -
 * so its path is DERIVABLE rather than guessable. Somebody who knows a
 * colleague's email address could otherwise walk straight past the whole
 * carefully-404'd `/api/orders` authorization layer and read their resumes.
 *
 * The second claim here matters just as much: a path no order claims is a
 * manually built resume, and those routes must behave for it exactly as they
 * did before. Narrowing those is a separate change with a separate blast
 * radius.
 */

async function serve() {
  const { rootDir, dbDir } = useTempStorage(`order-file-access-${Math.random().toString(36).slice(2)}`);
  const express = require('express');

  const outputBaseDir = path.join(rootDir, 'generated');
  fs.mkdirSync(outputBaseDir, { recursive: true });
  writeSettingRaw(dbDir, 'app-settings', JSON.stringify({ outputBaseDir }));

  loadFresh('../dist/database/sqlite');
  const users = loadFresh('../dist/database/userRepository');
  const orders = loadFresh('../dist/database/orderRepository');
  loadFresh('../dist/config/aiModelConfig');
  const { attachUser, requireUser } = loadFresh('../dist/middleware/auth');
  const { getGeneratedFilePath } = loadFresh('../dist/utils/generatedPath');
  const { ownerOfGeneratedFile } = orders;

  const bob = users.createUser({ email: 'bob.smith@acme.com' });
  const mallory = users.createUser({ email: 'mallory@example.com' });

  const app = express();
  app.use(express.json());
  app.use(attachUser);

  // The route as index.ts mounts it, including its guard.
  app.get('/api/generated/:filename(*)', requireUser, async (req, res) => {
    const params = req.params;
    const filename = params.filename ?? '';
    const owner = ownerOfGeneratedFile(filename);
    if (owner && owner !== req.user.id) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    const filepath = await getGeneratedFilePath(filename);
    if (!filepath) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    res.download(filepath, path.basename(filepath));
  });

  const server = app.listen(0);
  const port = server.address().port;

  return {
    orders,
    outputBaseDir,
    bob,
    mallory,
    bobToken: users.createSession(bob.id),
    malloryToken: users.createSession(mallory.id),
    close: () => server.close(),
    get: (token, suffix) =>
      fetch(`http://127.0.0.1:${port}/api/generated/${suffix}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      }),
  };
}

function write(baseDir, relative, contents) {
  const absolute = path.join(baseDir, ...relative.split('/'));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, contents);
}

test("a signed-in stranger cannot read an ordered resume by deriving its path", async () => {
  const server = await serve();
  try {
    // Exactly the path the fixed order template produces.
    const bobsResume = 'bob_smith_acme_com/2026-09-20/ft-20260920-0001/bob_smith/14_stripe/Bob_Smith.pdf';
    write(server.outputBaseDir, bobsResume, "BOB'S TAILORED RESUME");

    const order = server.orders.createOrder(
      { userId: server.bob.id, batchId: 'bat_bob', retentionDays: 5 },
      [{ seq: 0, profileId: 'p1', profileName: 'Bob Smith', companyName: 'Stripe', role: 'SWE' }]
    );
    server.orders.recordItemOutcome('bat_bob', 0, {
      state: 'done',
      files: [{ kind: 'resume-pdf', path: bobsResume }],
    });
    server.orders.settleOrderIfFinished(order.id);

    // Mallory knows Bob's email address. That used to be enough.
    const stolen = await server.get(server.malloryToken, bobsResume);
    assert.equal(stolen.status, 404, 'a derivable path must not be a readable one');

    // Bob himself is unaffected.
    const his = await server.get(server.bobToken, bobsResume);
    assert.equal(his.status, 200);
    assert.equal(await his.text(), "BOB'S TAILORED RESUME");

    // And signed out is still refused before any of this is reached.
    assert.equal((await server.get(null, bobsResume)).status, 401);
  } finally {
    server.close();
  }
});

test('a file no order claims is served exactly as it was before', async () => {
  const server = await serve();
  try {
    // A manual build: the administrator's template, no account segment, no
    // order row anywhere. Unchanged behaviour is the point.
    const manual = 'bob_smith/2026_09_20/stripe/swe/Bob_Smith.pdf';
    write(server.outputBaseDir, manual, 'A MANUAL BUILD');

    assert.equal(server.orders.ownerOfGeneratedFile(manual), null);

    const response = await server.get(server.malloryToken, manual);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'A MANUAL BUILD');
  } finally {
    server.close();
  }
});

test('the owner lookup matches the whole path, not a fragment of one', async () => {
  const server = await serve();
  try {
    const real = 'bob_smith_acme_com/2026-09-20/ft-20260920-0001/bob_smith/14_stripe/Bob_Smith.pdf';
    server.orders.createOrder(
      { userId: server.bob.id, batchId: 'bat_bob', retentionDays: 5 },
      [{ seq: 0, profileId: 'p1', profileName: 'Bob Smith', companyName: 'Stripe', role: 'SWE' }]
    );
    server.orders.recordItemOutcome('bat_bob', 0, {
      state: 'done',
      files: [{ kind: 'resume-pdf', path: real }],
    });

    assert.equal(server.orders.ownerOfGeneratedFile(real), server.bob.id);

    // A LIKE is how the candidates are found, so a prefix of a real path must
    // not be mistaken for it - the candidates are confirmed exactly afterwards.
    assert.equal(server.orders.ownerOfGeneratedFile('bob_smith_acme_com/2026-09-20'), null);
    assert.equal(server.orders.ownerOfGeneratedFile(`${real}.bak`), null);
    assert.equal(server.orders.ownerOfGeneratedFile(''), null);
  } finally {
    server.close();
  }
});
