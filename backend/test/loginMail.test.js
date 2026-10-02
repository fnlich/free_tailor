const assert = require('node:assert/strict');
const test = require('node:test');

const { loadFresh } = require('./helpers');

/**
 * The sign-in email itself.
 *
 * There is no other outgoing mail in this app, and this message is the first
 * thing a new account ever sees from an installation - under the operator's own
 * domain once they move off a shared mailbox - so the envelope and the subject
 * are worth pinning. The transport is replaced rather than reached: a test that
 * opened a socket to a real SMTP host would be a test of somebody's mail
 * server.
 */

/**
 * Runs `send` with nodemailer's transport swapped for a recorder.
 *
 * The swap goes on `nodemailer.default`, and that detail is the whole trick.
 * nodemailer's CJS build sets `__esModule: true` and exports a SEPARATE
 * `default` object, so TypeScript's `__importDefault` hands the compiled mailer
 * `nodemailer.default` - and patching the module's own `createTransport`
 * changes an object nothing calls. The symptom is not a failure: the real
 * transport is used, and the test hangs on a live SMTP connection until
 * whatever timeout gets to it first.
 */
async function withRecordedMail(send) {
  const nodemailer = require('nodemailer');
  const target = nodemailer.default ?? nodemailer;
  const original = target.createTransport;
  const sent = [];
  target.createTransport = () => ({
    sendMail: async (message) => {
      sent.push(message);
      return { accepted: [message.to] };
    },
  });
  try {
    // Loaded INSIDE the swap: the module caches one transport per config, and a
    // copy made before this point would be the real one.
    await send(loadFresh('../dist/services/auth/mailer'));
  } finally {
    target.createTransport = original;
  }
  return sent;
}

const SMTP = {
  SMTP_HOST: 'smtp.gmail.com',
  SMTP_PORT: '587',
  SMTP_USER: 'you@yourdomain.com',
  SMTP_PASS: 'app-password',
};

test('the sign-in email carries the code, and the app is called Tailor', async () => {
  const sent = await withRecordedMail((mailer) =>
    mailer.sendLoginCode('applicant@example.com', '123456', 10, { ...SMTP })
  );

  assert.equal(sent.length, 1);
  const [message] = sent;
  assert.equal(message.to, 'applicant@example.com');
  assert.equal(message.subject, '123456 is your Tailor sign-in code');
  assert.match(message.text, /123456/);
  assert.match(message.html, /123456/);
  // The rebrand missed this file once, and an install sending from its own
  // domain is where that shows.
  assert.doesNotMatch(message.subject, /Free Tailor/);
});

test('From falls back to the authenticating mailbox, which is what providers demand', async () => {
  const fallback = await withRecordedMail((mailer) =>
    mailer.sendLoginCode('applicant@example.com', '111111', 10, { ...SMTP })
  );
  assert.equal(fallback[0].from, 'you@yourdomain.com');

  const explicit = await withRecordedMail((mailer) =>
    mailer.sendLoginCode('applicant@example.com', '222222', 10, {
      ...SMTP,
      SMTP_FROM: 'no-reply@yourdomain.com',
    })
  );
  assert.equal(explicit[0].from, 'no-reply@yourdomain.com');
});

test('an unconfigured mailbox names the missing variables and sends nothing', async () => {
  const sent = await withRecordedMail(async (mailer) => {
    await assert.rejects(
      () => mailer.sendLoginCode('applicant@example.com', '123456', 10, { SMTP_HOST: 'smtp.gmail.com' }),
      (error) => {
        // The names, never the values - this ends up in logs operators paste.
        assert.deepEqual(error.missing, ['SMTP_USER', 'SMTP_PASS']);
        return true;
      }
    );
  });
  assert.equal(sent.length, 0, 'a refusal must not reach the transport');
});

/* ------------------------------------------------ the mail:doctor seams -- */

/**
 * What `mail:doctor` checks, asserted at the seam rather than through the script.
 *
 * The script itself is a console walk - printing is most of it - so the parts
 * worth pinning are the two exports it leans on and the two relay traps it exists
 * to catch. Those traps are silent in production: each produces an install that
 * reads as configured and is not.
 */

/** Same swap as above, but the recorder refuses, so failures can be asserted. */
async function withFailingMail(send, failure) {
  const nodemailer = require('nodemailer');
  const target = nodemailer.default ?? nodemailer;
  const original = target.createTransport;
  target.createTransport = () => ({
    verify: async () => {
      throw failure;
    },
    sendMail: async () => {
      throw failure;
    },
  });
  try {
    return await send(loadFresh('../dist/services/auth/mailer'));
  } finally {
    target.createTransport = original;
  }
}

const RELAY = {
  SMTP_HOST: 'smtp.resend.com',
  SMTP_PORT: '587',
  SMTP_USER: 'resend',
  SMTP_PASS: 're_not_a_real_key',
};

test('an empty mail block names the variables it wants, rather than failing vaguely', () => {
  const mailer = loadFresh('../dist/services/auth/mailer');
  const status = mailer.describeMailConfig({});
  assert.equal(status.configured, false);
  assert.deepEqual(status.missing, ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS']);
});

test("a relay's username is not an address, so SMTP_FROM decides the sender", () => {
  const mailer = loadFresh('../dist/services/auth/mailer');

  // The trap: unset, `from` becomes the literal word "resend" and every sign-in
  // email is sent from it.
  const bare = mailer.describeMailConfig({ ...RELAY });
  assert.equal(bare.configured, true);
  assert.equal(bare.from, 'resend', 'this is the broken state mail:doctor step 2 catches');

  const named = mailer.describeMailConfig({
    ...RELAY,
    SMTP_FROM: 'Tailor <login@tailorit.org>',
  });
  assert.equal(named.from, 'Tailor <login@tailorit.org>');
});

test('the admin fallback ignores a relay username, which is why ADMIN_EMAILS is required', () => {
  const admin = loadFresh('../dist/config/adminIdentity');

  // Not promoted, deliberately - "resend" is not a person.
  const withRelay = admin.resolveAdminIdentity({ SMTP_USER: 'resend' });
  assert.equal(withRelay.source, 'none');
  assert.deepEqual(withRelay.emails, []);

  // An SMTP_USER that IS an address still works, which is the Gmail/Workspace case.
  const withMailbox = admin.resolveAdminIdentity({ SMTP_USER: 'you@tailorit.org' });
  assert.equal(withMailbox.source, 'SMTP_USER');

  // And an explicit list always wins.
  const explicit = admin.resolveAdminIdentity({
    SMTP_USER: 'resend',
    ADMIN_EMAILS: 'you@tailorit.org',
  });
  assert.equal(explicit.source, 'ADMIN_EMAILS');
  assert.deepEqual(explicit.emails, ['you@tailorit.org']);
});

test('verifyMailTransport sends nothing, and surfaces a refusal as a send error', async () => {
  const seen = [];
  const nodemailer = require('nodemailer');
  const target = nodemailer.default ?? nodemailer;
  const original = target.createTransport;
  target.createTransport = () => ({
    verify: async () => {
      seen.push('verify');
      return true;
    },
    sendMail: async () => {
      seen.push('sendMail');
      return {};
    },
  });
  try {
    const mailer = loadFresh('../dist/services/auth/mailer');
    const status = await mailer.verifyMailTransport({
      ...RELAY,
      SMTP_FROM: 'login@tailorit.org',
    });
    assert.equal(status.configured, true);
    assert.equal(status.host, 'smtp.resend.com');
    assert.deepEqual(seen, ['verify'], 'it must NOT send - that is the whole point of step 3');
  } finally {
    target.createTransport = original;
  }

  // A blocked port is the failure this exists to report, and it must arrive as an
  // error rather than a hang.
  await withFailingMail(async (mailer) => {
    await assert.rejects(
      () => mailer.verifyMailTransport({ ...RELAY, SMTP_FROM: 'login@tailorit.org' }),
      (error) => {
        assert.match(error.message, /Could not connect to smtp\.resend\.com:587/);
        assert.match(error.message, /Connection timeout/);
        return true;
      }
    );
  }, new Error('Connection timeout'));
});

test('the doctor test message is plainly a test, and never looks like a live code', async () => {
  const sent = await withRecordedMail((mailer) =>
    mailer.sendTestMessage('you@example.com', { ...RELAY, SMTP_FROM: 'login@tailorit.org' })
  );

  assert.equal(sent.length, 1);
  const [message] = sent;
  assert.equal(message.from, 'login@tailorit.org');
  assert.equal(message.subject, 'Tailor mail check');
  // Not the sign-in template: nothing resembling a six-digit code reaches an
  // inbox or a terminal from the doctor.
  assert.doesNotMatch(message.text, /\b\d{6}\b/);
  assert.doesNotMatch(message.subject, /sign-in code/);
});
