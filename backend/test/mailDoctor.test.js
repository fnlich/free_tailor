const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { loadFresh } = require('./helpers');

/**
 * `npm run mail:doctor`'s first step: where the mail settings came from.
 *
 * The environment beats the .env now, so a line in the file is not always the
 * one in effect, and the doctor says which - by name, never by value, because
 * its output gets pasted into issues and one of these settings is a password.
 * The walk below stops at the second step for want of SMTP_USER and SMTP_PASS,
 * so nothing here connects to anything.
 */

const MAIL_VARIABLES = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'ADMIN_EMAILS'];

test('a mail setting the environment exports is named as overriding the file, never by value', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailor-mail-doctor-'));
  const envPath = path.join(dir, '.env');
  fs.writeFileSync(envPath, 'SMTP_HOST=smtp.file.example\nSMTP_PORT=587\nSMTP_USER=\nADMIN_EMAILS=boss@example.com\n');

  // Loaded first: importing it loads the repository's own .env, and the
  // variables below must be what this test says, whatever that file holds.
  const doctor = loadFresh('../dist/scripts/mailDoctor');
  const saved = Object.fromEntries(MAIL_VARIABLES.map((name) => [name, process.env[name]]));
  for (const name of MAIL_VARIABLES) delete process.env[name];
  process.env.SMTP_HOST = 'smtp.exported.example';
  process.env.SMTP_PORT = '587';

  const printed = [];
  const realLog = console.log;
  console.log = (...args) => printed.push(args.join(' '));
  let code;
  try {
    code = await doctor.main(envPath);
  } finally {
    console.log = realLog;
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const out = printed.join('\n');

  assert.equal(code, 1);
  assert.match(out, /OK +1\. Locate the \.env/);
  assert.match(out, /in the file but overridden by the environment: SMTP_HOST$/m);
  // The same value in both is not news; an empty line is not in effect.
  assert.match(out, /mail settings in effect: SMTP_PORT, ADMIN_EMAILS$/m);
  assert.match(out, /present but EMPTY - not in effect: SMTP_USER$/m);
  assert.match(out, /FAIL 2\. Read the SMTP configuration/);
  assert.doesNotMatch(out, /Connect and authenticate/, 'the walk stops at the first break');

  for (const value of ['smtp.exported.example', 'smtp.file.example', 'boss@example.com']) {
    assert.equal(out.includes(value), false, `${value} is never printed`);
  }
});
