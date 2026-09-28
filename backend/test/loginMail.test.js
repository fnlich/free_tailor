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
