const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const http = require('http');
const path = require('path');

const { useTempStorage, writeSettingRaw } = require('./helpers');

/**
 * The two older download routes, and the hole that orders opened in them.
 *
 * `/api/generated/:path` and `/api/resume/download/:path` take a path out of the
 * URL. That was defensible while a generated path was an opaque thing you had
 * to be told - the route's own comment concedes it is "guessable enough that
 * 'you would have to know the URL' is not a control".
 *
 * Orders changed the arithmetic, and every queued run is an order row now,
 * Generate Immediately included. An ordered resume is filed under a FIXED,
 * published template - account email, date, order number, profile, company -
 * so its path is DERIVABLE rather than guessable. Somebody who knows a
 * colleague's email address could otherwise walk straight past the whole
 * carefully-404'd `/api/orders` authorization layer and read their resumes.
 *
 * And not only by the path as recorded: `a//b`, `./a/b` and `x/../a/b` open the
 * same file, and an owner check that compared the raw parameter with the
 * recorded path served every one of them to anybody. These tests mount the REAL
 * handlers (routes/generatedFiles.ts and the resume router), never a copy, and
 * send the path RAW over node:http - fetch would resolve `.` and `..` (and
 * `%2E`) before the request left, and test nothing.
 *
 * The other claim here matters just as much: a path no order claims is a
 * resume built by the synchronous `/resume/generate`, and those routes must
 * behave for it exactly as they did before.
 */

const ROUTES = ['/api/generated/', '/api/resume/download/'];

async function serve() {
  const { rootDir, dbDir } = useTempStorage(`order-file-access-${Math.random().toString(36).slice(2)}`);
  const express = require('express');

  const outputBaseDir = path.join(rootDir, 'generated');
  fs.mkdirSync(outputBaseDir, { recursive: true });
  writeSettingRaw(dbDir, 'app-settings', JSON.stringify({ outputBaseDir }));

  const config = require('../dist/config/aiModelConfig');
  config.invalidateSettingsCache();
  const users = require('../dist/database/userRepository');
  const orders = require('../dist/database/orderRepository');
  const { attachUser, requireUser } = require('../dist/middleware/auth');
  const { downloadGeneratedFile } = require('../dist/routes/generatedFiles');
  const { accountFolderName, getGeneratedOutputPath } = require('../dist/utils/generatedPath');
  const { ORDER_OUTPUT_PATH_TEMPLATE } = require('../dist/utils/outputStorage');

  const bob = users.createUser({ email: 'bob.smith@acme.com' });
  const mallory = users.createUser({ email: 'mallory@example.com' });

  const app = express();
  app.use(express.json());
  app.use(attachUser);
  // As index.ts mounts it - the test below holds index.ts to this line.
  app.get('/api/generated/:filename(*)', requireUser, downloadGeneratedFile);
  app.use('/api/resume', require('../dist/routes/resume').default);

  const server = app.listen(0);
  const port = server.address().port;
  const tokens = { bob: users.createSession(bob.id), mallory: users.createSession(mallory.id) };

  /** A run of Bob's, filed where the queue files it, with its files written. */
  async function bobsRun(kind, { record = true } = {}) {
    const batchId = `bat_${kind}_${Math.random().toString(36).slice(2)}`;
    const order = orders.createOrder({ userId: bob.id, batchId, retentionDays: 5, kind }, [
      { seq: 0, profileId: 'p1', profileName: 'Bob Smith', companyName: 'Stripe', role: 'SWE' },
    ]);
    const { relativeBase } = await getGeneratedOutputPath({ name: 'Bob Smith', profileSettings: {} }, 'Stripe', 'SWE', {
      accountName: accountFolderName(bob),
      orderNumber: order.number,
      pathTemplate: ORDER_OUTPUT_PATH_TEMPLATE,
    });
    const resume = `${relativeBase}/Bob_Smith.pdf`;
    const coverLetter = `${relativeBase}/Bob_Smith_cover_letter.pdf`;
    write(outputBaseDir, resume, `BOB'S ${kind.toUpperCase()} RESUME`);
    write(outputBaseDir, coverLetter, `BOB'S ${kind.toUpperCase()} COVER LETTER`);
    if (record) {
      orders.recordItemOutcome(batchId, 0, { state: 'done', files: [{ kind: 'resume-pdf', path: resume }] });
      orders.settleOrderIfFinished(order.id);
    }
    return { order, resume, coverLetter, relativeBase };
  }

  return {
    orders,
    outputBaseDir,
    bob,
    mallory,
    bobsRun,
    close: () => server.close(),
    /** GET with the path exactly as given: no URL parsing, no dot-segment removal. */
    get: (who, rawPath) =>
      new Promise((resolve, reject) => {
        const request = http.request(
          {
            host: '127.0.0.1',
            port,
            method: 'GET',
            path: rawPath,
            headers: who ? { authorization: `Bearer ${tokens[who]}` } : {},
          },
          (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
          }
        );
        request.on('error', reject);
        request.end();
      }),
  };
}

function write(baseDir, relative, contents) {
  const absolute = path.join(baseDir, ...relative.split('/'));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, contents);
}

/** Other spellings of one stored path, each of which opens the same file. */
function otherSpellings(stored) {
  const segments = stored.split('/');
  const file = segments.pop();
  const dir = segments.join('/');
  return [
    stored.replace('/', '//'),
    `/${stored}`,
    `./${stored}`,
    `%2E/${stored}`,
    `x/../${stored}`,
    `${dir}/./${file}`,
    `${segments[0]}/%2E%2E/${stored}`,
    stored.replace(/\//g, '%5C'),
  ];
}

test('index.ts mounts the handler these tests mount, behind the builder guard', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
  assert.match(source, /^app\.get\('\/api\/generated\/:filename\(\*\)', requireUser, downloadGeneratedFile\);$/m);
  assert.match(source, /^import \{ downloadGeneratedFile \} from '\.\/routes\/generatedFiles';$/m);
});

test('a signed-in stranger cannot read an ordered resume by deriving its path', async () => {
  const server = await serve();
  try {
    const { resume } = await server.bobsRun('order');

    for (const route of ROUTES) {
      // Mallory knows Bob's email address. That used to be enough.
      const stolen = await server.get('mallory', `${route}${resume}`);
      assert.equal(stolen.status, 404, `${route}: a derivable path must not be a readable one`);

      // Bob himself is unaffected.
      const his = await server.get('bob', `${route}${resume}`);
      assert.equal(his.status, 200, route);
      assert.equal(his.text, "BOB'S ORDER RESUME");

      // And signed out is still refused before any of this is reached.
      assert.equal((await server.get(null, `${route}${resume}`)).status, 401, route);
    }
  } finally {
    server.close();
  }
});

test('no other spelling of the path reaches another account\'s order or Generate Immediately file', async () => {
  // The bypass a review reproduced: the owner lookup compared the RAW parameter
  // with the recorded path, the file was opened after empty and dot segments
  // were resolved, so anything but the recorded spelling read as "no order
  // claims this" and was served.
  const server = await serve();
  try {
    for (const kind of ['order', 'immediate']) {
      const { resume } = await server.bobsRun(kind);
      for (const route of ROUTES) {
        for (const spelling of otherSpellings(resume)) {
          const stolen = await server.get('mallory', `${route}${spelling}`);
          assert.equal(stolen.status, 404, `${kind}: ${route}${spelling} answered ${stolen.status}`);
          assert.ok(!stolen.text.includes("BOB'S"), `${route}${spelling} leaked the file`);
        }
        // The owner reaches his own file however the path is spelled.
        const his = await server.get('bob', `${route}./${resume}`);
        assert.equal(his.status, 200, `${kind}: ${route}./ for the owner`);
        assert.equal(his.text, `BOB'S ${kind.toUpperCase()} RESUME`);
      }
    }
  } finally {
    server.close();
  }
});

test('a symlink inside the output directory is not another path to somebody\'s file', async () => {
  // The spelling the file system resolves rather than the string: what the
  // realpath half of the check is for. On Windows and macOS the same half is
  // what makes a change of case, an 8.3 short name or a trailing dot the same
  // path; a symlink is the alias Linux can show.
  const server = await serve();
  try {
    const { resume, relativeBase } = await server.bobsRun('immediate');
    fs.symlinkSync(path.join(server.outputBaseDir, ...relativeBase.split('/')), path.join(server.outputBaseDir, 'shortcut'));

    for (const route of ROUTES) {
      const stolen = await server.get('mallory', `${route}shortcut/Bob_Smith.pdf`);
      assert.equal(stolen.status, 404, `${route}: a symlink reached Bob's file`);
      assert.equal((await server.get('bob', `${route}shortcut/Bob_Smith.pdf`)).status, 200, route);
    }
    assert.equal((await server.get('bob', `${ROUTES[0]}${resume}`)).status, 200);
  } finally {
    server.close();
  }
});

test("a file in another account's run folder is theirs before, and without, its item recording it", async () => {
  // A resume's PDF is on disk while the rest of it is still being built, and a
  // task that fails after writing one never records it. Both sit in the run's
  // own folder, which names its order number - and so its account.
  const server = await serve();
  try {
    for (const kind of ['order', 'immediate']) {
      const unrecorded = await server.bobsRun(kind, { record: false });
      const recorded = await server.bobsRun(kind);
      for (const { resume, coverLetter } of [unrecorded, recorded]) {
        for (const file of [resume, coverLetter]) {
          for (const route of ROUTES) {
            assert.equal((await server.get('mallory', `${route}${file}`)).status, 404, `${kind}: ${route}${file}`);
            assert.equal((await server.get('mallory', `${route}./${file}`)).status, 404, `${kind}: ${route}./${file}`);
            assert.equal((await server.get('bob', `${route}${file}`)).status, 200, `${kind}: ${route}${file} for Bob`);
          }
        }
      }
    }
  } finally {
    server.close();
  }
});

test('a file no order claims is served exactly as it was before', async () => {
  const server = await serve();
  try {
    // A /resume/generate build: the administrator's template, no account
    // segment, no order row anywhere. Unchanged behaviour is the point - under
    // any spelling, too.
    const manual = 'bob_smith/2026_09_20/stripe/swe/Bob_Smith.pdf';
    write(server.outputBaseDir, manual, 'A MANUAL BUILD');

    assert.deepEqual(server.orders.ownersOfGeneratedFile([manual]), []);

    for (const route of ROUTES) {
      for (const spelling of [manual, `./${manual}`, manual.replace('/', '//')]) {
        const response = await server.get('mallory', `${route}${spelling}`);
        assert.equal(response.status, 200, `${route}${spelling}`);
        assert.equal(response.text, 'A MANUAL BUILD');
      }
    }

    // Nothing outside the output directory, and no directory, is a file.
    for (const route of ROUTES) {
      assert.equal((await server.get('bob', `${route}..%2F..%2Fetc%2Fpasswd`)).status, 404, route);
      assert.equal((await server.get('bob', `${route}bob_smith/2026_09_20`)).status, 404, route);
    }
  } finally {
    server.close();
  }
});

test('the owner lookup matches the whole path, not a fragment of one, and not its case', async () => {
  const server = await serve();
  try {
    const { resume, order } = await server.bobsRun('order');

    assert.deepEqual(server.orders.ownersOfGeneratedFile([resume]), [server.bob.id]);

    // A LIKE is how the candidates are found, so a prefix of a real path must
    // not be mistaken for it - the candidates are confirmed exactly afterwards.
    const [account, date] = resume.split('/');
    assert.deepEqual(server.orders.ownersOfGeneratedFile([`${account}/${date}`]), []);
    assert.deepEqual(server.orders.ownersOfGeneratedFile([`${account}/${date}/stripe/x.pdf`]), []);
    assert.deepEqual(server.orders.ownersOfGeneratedFile(['']), []);

    // On a case-insensitive disk (Windows, macOS) a change of case opens the
    // same file, so it is the same claim. Folding only ever narrows what a
    // stranger is handed. (Away from the run's folder, so the folder claim
    // cannot be what answers.)
    const outsideFolder = 'loose/Bob_Smith.pdf';
    server.orders.recordItemFiles(server.orders.listOrderItems(order.id)[0].id, [
      { kind: 'resume-pdf', path: outsideFolder },
    ]);
    assert.deepEqual(server.orders.ownersOfGeneratedFile([outsideFolder]), [server.bob.id]);
    assert.deepEqual(server.orders.ownersOfGeneratedFile(['LOOSE/bob_smith.PDF']), [server.bob.id]);
    assert.deepEqual(server.orders.ownersOfGeneratedFile([`${outsideFolder}.bak`]), []);
  } finally {
    server.close();
  }
});
