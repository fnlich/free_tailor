const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Database = require('better-sqlite3');

const { loadFresh, useAdminEmails, useTempStorage } = require('./helpers');

/**
 * That each operational setting reaches the thing it is supposed to change.
 *
 * `operational.test.js` pins what the getters return; this file pins that the
 * code actually USES them - the cookie's Max-Age, the body Cryptomus is sent,
 * the options nodemailer is handed, the timeout Chrome is launched with. A
 * getter nobody calls passes every test in the other file.
 *
 * Nothing here reaches a network, a browser or a subprocess. fetch,
 * nodemailer's transport and puppeteer's launch are replaced for the duration
 * of each test and restored after it.
 */

/** Sets env vars for the duration of `run`, restoring whatever was there before. */
async function withEnv(vars, run) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/* ============================================================= sessions */

async function serveAuth(name) {
  useTempStorage(name);
  const express = require('express');
  const users = loadFresh('../dist/database/userRepository');
  const routes = loadFresh('../dist/routes/auth');
  const app = express();
  app.use(express.json());
  app.use('/api/auth', routes.default);
  const server = app.listen(0);
  const port = server.address().port;
  return {
    users,
    close: () => server.close(),
    verify: (email, code) =>
      fetch(`http://127.0.0.1:${port}/api/auth/email/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, code }),
      }),
  };
}

function sessionRowLifetimeMs(dbDir) {
  const db = new Database(path.join(dbDir, 'free_tailor.db'), { readonly: true });
  try {
    const row = db.prepare('SELECT created_at, expires_at FROM user_sessions').get();
    return Date.parse(row.expires_at) - Date.parse(row.created_at);
  } finally {
    db.close();
  }
}

test('SESSION_TTL_DAYS sets the session row AND the cookie, from the one reader', async () => {
  await withEnv({ SESSION_TTL_DAYS: '7' }, async () => {
    const server = await serveAuth('wiring-session-7');
    try {
      server.users.storeLoginCode('ttl@example.com', '123456');
      const response = await server.verify('ttl@example.com', '123456');
      assert.equal(response.status, 200, await response.text());
      assert.match(response.headers.get('set-cookie'), /Max-Age=604800/);
      assert.equal(sessionRowLifetimeMs(process.env.DB_DIR), 7 * 24 * 60 * 60 * 1000);
    } finally {
      server.close();
    }
  });
});

test('unset, a sign-in lasts thirty days, cookie and row alike, as it always did', async () => {
  await withEnv({ SESSION_TTL_DAYS: undefined }, async () => {
    const server = await serveAuth('wiring-session-default');
    try {
      server.users.storeLoginCode('ttl@example.com', '123456');
      const response = await server.verify('ttl@example.com', '123456');
      assert.equal(response.status, 200);
      assert.match(response.headers.get('set-cookie'), /Max-Age=2592000/);
      assert.equal(sessionRowLifetimeMs(process.env.DB_DIR), 30 * 24 * 60 * 60 * 1000);
    } finally {
      server.close();
    }
  });
});

/* ============================================================== uploads */

/**
 * An app with the real auth, profile and template routes. The upload
 * middleware is loaded fresh FIRST, after the environment is set, because it
 * reads UPLOAD_MAX_MB once when it loads - the routes then pick up that copy.
 */
async function serveUploads(name) {
  useTempStorage(name);
  useAdminEmails('admin@example.com');
  const express = require('express');
  loadFresh('../dist/database/sqlite');
  const users = loadFresh('../dist/database/userRepository');
  loadFresh('../dist/middleware/pdfUpload');
  const { attachUser } = loadFresh('../dist/middleware/auth');
  const authRoutes = loadFresh('../dist/routes/auth');
  const profileRoutes = loadFresh('../dist/routes/profiles');
  const templateRoutes = loadFresh('../dist/routes/templates');

  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use('/api/auth', authRoutes.default);
  app.use('/api/profiles', profileRoutes.default);
  app.use('/api/templates', templateRoutes.default);
  // The app's real last-resort handler, so a multer error that is NOT a size
  // problem lands where it does in production.
  app.use(loadFresh('../dist/middleware/publicError').publicErrorHandler);
  const server = app.listen(0);
  const port = server.address().port;

  const admin = users.createUser({ email: 'admin@example.com' });
  const member = users.createUser({ email: 'member@example.com' });
  return {
    adminToken: users.createSession(admin.id),
    memberToken: users.createSession(member.id),
    close: () => server.close(),
    get: (token, url) =>
      fetch(`http://127.0.0.1:${port}${url}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      }),
    upload: (token, url, field, bytes, type = 'application/pdf') => {
      const form = new FormData();
      form.append(field, new Blob([bytes], { type }), 'resume.pdf');
      return fetch(`http://127.0.0.1:${port}${url}`, {
        method: 'POST',
        body: form,
        headers: { authorization: `Bearer ${token}` },
      });
    },
  };
}

test('GET /api/auth/me serves the upload cap, signed in or not', async () => {
  await withEnv({ UPLOAD_MAX_MB: '3' }, async () => {
    const server = await serveUploads('wiring-upload-me');
    try {
      const signedOut = await (await server.get(null, '/api/auth/me')).json();
      assert.equal(signedOut.account, null);
      assert.equal(signedOut.uploadMaxMb, 3);

      const signedIn = await (await server.get(server.memberToken, '/api/auth/me')).json();
      assert.equal(signedIn.account.email, 'member@example.com');
      assert.equal(signedIn.uploadMaxMb, 3);
      assert.equal('uploadMaxMb' in signedIn.account, false, 'a server limit, not account data');
    } finally {
      server.close();
    }
  });
});

test('GET /api/auth/me says 10 when UPLOAD_MAX_MB is unset', async () => {
  await withEnv({ UPLOAD_MAX_MB: undefined }, async () => {
    const server = await serveUploads('wiring-upload-me-default');
    try {
      const body = await (await server.get(null, '/api/auth/me')).json();
      assert.equal(body.uploadMaxMb, 10);
    } finally {
      server.close();
    }
  });
});

test('a resume PDF over UPLOAD_MAX_MB is a 413 that names the limit, not a 500', async () => {
  await withEnv({ UPLOAD_MAX_MB: '1' }, async () => {
    const server = await serveUploads('wiring-upload-413');
    try {
      const response = await server.upload(
        server.memberToken,
        '/api/profiles/upload',
        'resume',
        Buffer.alloc(1024 * 1024 + 1, 0x41)
      );
      assert.equal(response.status, 413);
      const body = await response.json();
      assert.equal(body.code, 'upload-too-large');
      assert.equal(body.limitMb, 1);
      assert.match(body.error, /1 MB or larger; this server accepts PDFs under 1 MB/);
      // The number, never the setting: UPLOAD_MAX_MB is the administrator's.
      assert.doesNotMatch(body.error, /UPLOAD_MAX_MB/);
    } finally {
      server.close();
    }
  });
});

test('a PDF of exactly UPLOAD_MAX_MB is refused and one byte under is not - the rule the pages check', async () => {
  // busboy raises the limit as soon as a file reaches fileSize, so exactly the
  // cap is a 413 - as it always was. frontend/src/lib/upload.ts refuses at the
  // same size (frontendEnv.test.js), so the page never sends a file only for
  // the server to turn it away.
  await withEnv({ UPLOAD_MAX_MB: '1' }, async () => {
    const server = await serveUploads('wiring-upload-boundary');
    const realError = console.error;
    console.error = () => {};
    try {
      const exact = await server.upload(server.memberToken, '/api/profiles/upload', 'resume', Buffer.alloc(1024 * 1024, 0x41));
      assert.equal(exact.status, 413);
      assert.equal((await exact.json()).limitMb, 1);

      // Under the cap multer hands the bytes on; they are no real PDF, so the
      // parser fails after it - anything but a 413.
      const under = await server.upload(server.memberToken, '/api/profiles/upload', 'resume', Buffer.alloc(1024 * 1024 - 1, 0x41));
      assert.notEqual(under.status, 413);
      await under.text();
    } finally {
      console.error = realError;
      server.close();
    }
  });
});

test('the template upload shares the same cap and the same 413', async () => {
  await withEnv({ UPLOAD_MAX_MB: '1' }, async () => {
    const server = await serveUploads('wiring-upload-413-template');
    try {
      const response = await server.upload(
        server.adminToken,
        '/api/templates/upload',
        'pdf',
        Buffer.alloc(1024 * 1024 + 1, 0x41)
      );
      assert.equal(response.status, 413);
      assert.equal((await response.json()).limitMb, 1);
    } finally {
      server.close();
    }
  });
});

test('a resume upload under the cap is read in memory, and no uploads directory appears', async () => {
  const uploadsDir = path.join(__dirname, '..', 'uploads');
  const existedBefore = fs.existsSync(uploadsDir);
  await withEnv({ UPLOAD_MAX_MB: '1' }, async () => {
    const server = await serveUploads('wiring-upload-memory');
    try {
      // Not a real PDF, so the parse fails - but only AFTER multer accepted it
      // and handed the handler a buffer: the uploader's unreadable file, not a
      // 413, and never the parser's own words.
      const realError = console.error;
      console.error = () => {};
      let response;
      try {
        response = await server.upload(server.memberToken, '/api/profiles/upload', 'resume', Buffer.from('%PDF-1.4 not really'));
      } finally {
        console.error = realError;
      }
      assert.equal(response.status, 400);
      const unreadable = await response.json();
      assert.match(unreadable.error, /^Could not extract text from PDF/);
      assert.doesNotMatch(JSON.stringify(unreadable), /ENOENT|uploads/);
      assert.equal(unreadable.detail, undefined, 'the parser\'s reason is an administrator\'s');

      // A non-PDF is still refused by the filter, through the error handler -
      // as the caller's 415, where it used to be the server's 500.
      const text = await server.upload(server.memberToken, '/api/profiles/upload', 'resume', Buffer.from('hello'), 'text/plain');
      assert.equal(text.status, 415);
      const refused = await text.json();
      assert.equal(refused.error, 'Only PDF files can be uploaded.');
      assert.equal(refused.code, 'upload-not-pdf');

      // A form with the file under the wrong field is the form's fault too: a
      // 400 in plain words, not multer's "Unexpected field" as a 500.
      const misnamed = await server.upload(server.memberToken, '/api/profiles/upload', 'document', Buffer.from('%PDF-1.4'));
      assert.equal(misnamed.status, 400);
      const unreadable2 = await misnamed.json();
      assert.equal(unreadable2.code, 'upload-unreadable');
      assert.doesNotMatch(unreadable2.error, /Unexpected field|LIMIT_/);
    } finally {
      server.close();
    }
  });
  if (!existedBefore) {
    assert.equal(fs.existsSync(uploadsDir), false, 'nothing writes backend/uploads any more');
  }
});

/* ============================================================= Cryptomus */

async function captureInvoice(lifetime) {
  return withEnv(
    {
      CRYPTOMUS_MERCHANT_ID: 'merchant',
      CRYPTOMUS_PAYMENT_API_KEY: 'key',
      CRYPTOMUS_CALLBACK_URL: undefined,
      CRYPTOMUS_INVOICE_LIFETIME_S: lifetime,
    },
    async () => {
      useTempStorage(`wiring-cryptomus-${Math.random().toString(36).slice(2)}`);
      const cryptomus = loadFresh('../dist/integrations/cryptomus');
      const realFetch = globalThis.fetch;
      let body = null;
      globalThis.fetch = async (_url, init) => {
        body = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({ state: 0, result: { uuid: 'inv', order_id: 'pay_1', url: 'https://pay.example/inv' } }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      };
      try {
        await cryptomus.createInvoice({
          paymentId: 'pay_1',
          reference: 'FT-1',
          amountCents: 1000,
          currency: 'usd',
          returnUrl: 'https://app.example/r',
          cancelUrl: 'https://app.example/c',
        });
      } finally {
        globalThis.fetch = realFetch;
      }
      return body;
    }
  );
}

test('CRYPTOMUS_INVOICE_LIFETIME_S is the lifetime sent; unset or junk is the hour it always was', async () => {
  assert.equal((await captureInvoice('7200')).lifetime, 7200);
  assert.equal((await captureInvoice(undefined)).lifetime, 3600);
  assert.equal((await captureInvoice('an hour')).lifetime, 3600);
  // Cryptomus's documented ceiling is twelve hours.
  assert.equal((await captureInvoice('999999')).lifetime, 43_200);
});

/* ================================================================== SMTP */

async function captureTransportOptions(env) {
  const nodemailer = require('nodemailer');
  const target = nodemailer.default ?? nodemailer;
  const original = target.createTransport;
  const seen = [];
  target.createTransport = (options) => {
    seen.push(options);
    return { verify: async () => true, close() {}, sendMail: async () => ({}) };
  };
  try {
    const mailer = loadFresh('../dist/services/auth/mailer');
    await mailer.verifyMailTransport({ SMTP_HOST: 'smtp.example', SMTP_USER: 'u@example.com', SMTP_PASS: 'p', ...env });
    mailer.closeMailTransport();
  } finally {
    target.createTransport = original;
  }
  return seen[0];
}

test('the SMTP pool is built with the configured timeouts and width', async () => {
  const options = await captureTransportOptions({
    SMTP_CONNECTION_TIMEOUT_MS: '30000',
    SMTP_SOCKET_TIMEOUT_MS: '60000',
    SMTP_MAX_CONNECTIONS: '5',
  });
  assert.equal(options.connectionTimeout, 30_000);
  assert.equal(options.greetingTimeout, 30_000, 'the greeting shares the connection timeout');
  assert.equal(options.socketTimeout, 60_000);
  assert.equal(options.maxConnections, 5);
  assert.equal(options.pool, true);
});

test('unset, the SMTP pool is the 10s/20s/2 it always was - and 0 is never "wait for ever"', async () => {
  const defaults = await captureTransportOptions({});
  assert.equal(defaults.connectionTimeout, 10_000);
  assert.equal(defaults.greetingTimeout, 10_000);
  assert.equal(defaults.socketTimeout, 20_000);
  assert.equal(defaults.maxConnections, 2);

  const zero = await captureTransportOptions({ SMTP_CONNECTION_TIMEOUT_MS: '0', SMTP_SOCKET_TIMEOUT_MS: '' });
  assert.equal(zero.connectionTimeout, 1_000, 'clamped to the one-second floor');
  assert.equal(zero.socketTimeout, 20_000, 'empty is the default');
});

/* ======================================================= Chrome, stubbed */

/**
 * Replaces puppeteer's launch with one that hands back `browser`, and points
 * the browser resolution at a file that exists so `launchBrowser` gets as far
 * as launching. Records every launch's options.
 */
async function withFakeChrome(browser, run) {
  const puppeteer = require('puppeteer').default;
  const { resetResolvedBrowser } = require('../dist/config/browser');
  const hadOwn = Object.prototype.hasOwnProperty.call(puppeteer, 'launch');
  const original = puppeteer.launch;
  const launches = [];
  puppeteer.launch = async (options) => {
    launches.push(options);
    return browser;
  };
  try {
    return await withEnv({ PUPPETEER_EXECUTABLE_PATH: undefined, CHROME_PATH: process.execPath }, async () => {
      resetResolvedBrowser();
      await run();
      return launches;
    });
  } finally {
    if (hadOwn) puppeteer.launch = original;
    else delete puppeteer.launch;
    resetResolvedBrowser();
  }
}

function makeFakePage(overrides = {}) {
  const calls = [];
  const page = {
    calls,
    setDefaultTimeout: (ms) => calls.push(['setDefaultTimeout', ms]),
    setViewport: async () => {},
    emulateMediaType: async () => {},
    setContent: async () => {},
    setUserAgent: async (agent) => calls.push(['setUserAgent', agent]),
    goto: async (url, options) => calls.push(['goto', url, options]),
    evaluate: async () => 'x'.repeat(300),
    pdf: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    close: async () => {},
    ...overrides,
  };
  return page;
}

function makeFakeBrowser(page) {
  return {
    connected: true,
    once() {},
    newPage: async () => page,
    close: async () => {},
  };
}

const PROFILE = {
  id: 'p1',
  name: 'Jane Doe',
  title: 'Engineer',
  contact: { phone: '', email: 'jane@example.com', linkedin: '', location: '' },
  summary: 'Summary',
  experience: [],
  strengths: [],
  skills: [],
  education: [],
  createdAt: '',
  updatedAt: '',
};

function pathInfoIn(dir) {
  return {
    relativeBase: 'jane',
    absoluteDir: dir,
    storagePathBase: 'jane',
    profileSlug: 'jane',
    resumeFileStem: 'Jane',
    coverLetterFileStem: 'Jane_cover_letter',
    companyFolderName: 'acme',
    roleSlug: 'eng',
  };
}

test('PDF_RENDER_TIMEOUT_MS bounds both the Chrome launch and every step of a resume render', async () => {
  useTempStorage('wiring-pdf');
  const page = makeFakePage();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailor-wiring-pdf-'));
  const launches = await withEnv({ PDF_RENDER_TIMEOUT_MS: '90000' }, () =>
    withFakeChrome(makeFakeBrowser(page), async () => {
      const { generateResumePDF } = loadFresh('../dist/generators/pdfGenerator');
      await generateResumePDF(
        PROFILE,
        { id: 't', name: 'T', htmlContent: '<div>{{name}}</div>', cssContent: '', sections: [] },
        undefined,
        pathInfoIn(outDir)
      );
    })
  );
  assert.equal(launches.length, 1);
  assert.equal(launches[0].timeout, 90_000);
  assert.deepEqual(page.calls.find((call) => call[0] === 'setDefaultTimeout'), ['setDefaultTimeout', 90_000]);
});

test("unset, both are puppeteer's own 30 seconds - the value that was inherited, now written down", async () => {
  useTempStorage('wiring-pdf-default');
  const page = makeFakePage();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailor-wiring-pdf-'));
  const launches = await withEnv({ PDF_RENDER_TIMEOUT_MS: undefined }, () =>
    withFakeChrome(makeFakeBrowser(page), async () => {
      const { saveCoverLetter } = loadFresh('../dist/generators/coverLetterGenerator');
      await saveCoverLetter(PROFILE, 'Dear team,\n\nHello.', pathInfoIn(outDir));
    })
  );
  assert.equal(launches[0].timeout, 30_000);
  assert.deepEqual(page.calls.find((call) => call[0] === 'setDefaultTimeout'), ['setDefaultTimeout', 30_000]);
});

/* ============================================================= job pages */

test('the job-page fetch and its Chrome fallback use the configured timeouts and User-Agent', async () => {
  const page = makeFakePage();
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  const fetches = [];
  const signalTimeouts = [];
  globalThis.fetch = async (url, init) => {
    fetches.push({ url: String(url), headers: init.headers });
    // Too short to use, so the Chrome fallback runs as well.
    return new Response('<p>short</p>', { status: 200, headers: { 'content-type': 'text/html' } });
  };
  AbortSignal.timeout = (ms) => {
    signalTimeouts.push(ms);
    return realTimeout.call(AbortSignal, ms);
  };
  let launches;
  try {
    launches = await withEnv(
      {
        JOB_PAGE_FETCH_TIMEOUT_MS: '5000',
        JOB_PAGE_BROWSER_TIMEOUT_MS: '9000',
        JOB_PAGE_USER_AGENT: 'TailorTest/1.0',
        PDF_RENDER_TIMEOUT_MS: '45000',
      },
      () =>
        withFakeChrome(makeFakeBrowser(page), async () => {
          const { extractJobPageContent } = loadFresh('../dist/services/jobPageContent');
          const text = await extractJobPageContent('https://jobs.example/posting/1');
          assert.equal(text.length, 300);
        })
    );
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }

  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].headers['User-Agent'], 'TailorTest/1.0');
  assert.deepEqual(signalTimeouts, [5000]);
  assert.deepEqual(page.calls.find((call) => call[0] === 'setUserAgent'), ['setUserAgent', 'TailorTest/1.0']);
  const goto = page.calls.find((call) => call[0] === 'goto');
  assert.equal(goto[2].timeout, 9000);
  assert.equal(launches[0].timeout, 45_000, 'the Chrome start is bounded like every other launch');
});

test('unset, the job-page values are the 20s, 25s and Chrome 131 agent they always were', async () => {
  const page = makeFakePage();
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  const fetches = [];
  const signalTimeouts = [];
  globalThis.fetch = async (_url, init) => {
    fetches.push(init.headers);
    return new Response('<p>short</p>', { status: 200, headers: { 'content-type': 'text/html' } });
  };
  AbortSignal.timeout = (ms) => {
    signalTimeouts.push(ms);
    return realTimeout.call(AbortSignal, ms);
  };
  try {
    await withEnv(
      { JOB_PAGE_FETCH_TIMEOUT_MS: undefined, JOB_PAGE_BROWSER_TIMEOUT_MS: undefined, JOB_PAGE_USER_AGENT: undefined },
      () =>
        withFakeChrome(makeFakeBrowser(page), async () => {
          const { extractJobPageContent } = loadFresh('../dist/services/jobPageContent');
          await extractJobPageContent('https://jobs.example/posting/2');
        })
    );
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
  const chrome131 =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  assert.equal(fetches[0]['User-Agent'], chrome131);
  assert.deepEqual(signalTimeouts, [20_000]);
  assert.deepEqual(page.calls.find((call) => call[0] === 'setUserAgent'), ['setUserAgent', chrome131]);
  assert.equal(page.calls.find((call) => call[0] === 'goto')[2].timeout, 25_000);
});

/* ============================================== read-once resource sizes */

test('GENERATION_RENDER_CONCURRENCY sizes the render lane, read once when the queue loads', async () => {
  useTempStorage('wiring-render');
  await withEnv({ GENERATION_RENDER_CONCURRENCY: '2' }, async () => {
    const resumeTask = loadFresh('../dist/services/queue/resumeTask');
    assert.equal(resumeTask.resumeRenderConcurrency(), 2);
  });
  await withEnv({ GENERATION_RENDER_CONCURRENCY: undefined }, async () => {
    const resumeTask = loadFresh('../dist/services/queue/resumeTask');
    assert.equal(resumeTask.resumeRenderConcurrency(), 4);
  });
});

async function captureSweepInterval(value) {
  useTempStorage(`wiring-retention-${Math.random().toString(36).slice(2)}`);
  return withEnv({ ORDER_RETENTION_SWEEP_MS: value }, async () => {
    loadFresh('../dist/database/sqlite');
    loadFresh('../dist/database/orderRepository');
    loadFresh('../dist/config/aiModelConfig');
    const retention = loadFresh('../dist/services/orders/retention');
    const realSetInterval = global.setInterval;
    const intervals = [];
    global.setInterval = (fn, ms, ...args) => {
      intervals.push(ms);
      return realSetInterval(fn, ms, ...args);
    };
    try {
      retention.startOrderRetention();
    } finally {
      global.setInterval = realSetInterval;
      retention.stopOrderRetention();
    }
    // Let the immediate first sweep finish against this test's database.
    await new Promise((resolve) => setTimeout(resolve, 50));
    return intervals;
  });
}

test('ORDER_RETENTION_SWEEP_MS is the sweep interval; unset it is six hours', async () => {
  // The second interval is the Generate Immediately runs' own sweep, every
  // minute whatever this says: their files live minutes, not days.
  assert.deepEqual(await captureSweepInterval('120000'), [120_000, 60_000]);
  assert.deepEqual(await captureSweepInterval(undefined), [6 * 60 * 60 * 1000, 60_000]);
});

async function captureBackfillPauses(value) {
  useTempStorage(`wiring-backfill-${Math.random().toString(36).slice(2)}`);
  useAdminEmails('admin@example.com');
  return withEnv({ SHEET_BACKFILL_PAUSE_MS: value, SHEET_BACKFILL: undefined }, async () => {
    loadFresh('../dist/database/sqlite');
    const users = loadFresh('../dist/database/userRepository');
    const sheets = loadFresh('../dist/services/sheets/accountSheet');
    const refuse = async () => {
      throw new Error('no Google in tests');
    };
    sheets.setSheetsClientForTests({
      isConfigured: async () => true,
      checkCredential: async () => {},
      createSpreadsheet: refuse,
      formatJobSheetTab: refuse,
      addSheetTabWithHeaders: refuse,
      shareSpreadsheetWithEmail: refuse,
      hasPersonalGrant: refuse,
      getSpreadsheetVisibility: refuse,
      setSpreadsheetVisibility: refuse,
    });
    users.createUser({ email: 'one@example.com' });
    users.createUser({ email: 'two@example.com' });

    const realSetTimeout = global.setTimeout;
    const pauses = [];
    global.setTimeout = (fn, ms, ...args) => {
      pauses.push(ms);
      return realSetTimeout(fn, 0, ...args);
    };
    const realWarn = console.warn;
    const realLog = console.log;
    console.warn = () => {};
    console.log = () => {};
    try {
      // No argument: the pause comes from the environment.
      await sheets.backfillAccountSheets();
    } finally {
      global.setTimeout = realSetTimeout;
      console.warn = realWarn;
      console.log = realLog;
    }
    return pauses;
  });
}

test('SHEET_BACKFILL_PAUSE_MS paces the backfill; unset it is 250ms, and 0 means no pause', async () => {
  assert.deepEqual(await captureBackfillPauses('40'), [40, 40]);
  assert.deepEqual(await captureBackfillPauses(undefined), [250, 250]);
  assert.deepEqual(await captureBackfillPauses('0'), []);
});
