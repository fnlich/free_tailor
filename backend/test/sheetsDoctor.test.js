const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { loadFresh } = require('./helpers');

/**
 * What `sheets:doctor` tells an operator whose credential Google refused.
 *
 * THE FAILURE THIS PINS. A saved `sheets:login` consent expired - the seven-day
 * limit of an OAuth consent screen left in Testing - and the doctor answered
 * with the advice for a SERVICE ACCOUNT: issue a new key, check the clock. A
 * refresh token has neither. The right instruction was already built, in the
 * error's `detail`, and the doctor printed only `message`, which is the half
 * written for account holders: "until an administrator renews it", said to the
 * administrator.
 *
 * Nothing here reaches Google: `fetch` is a fake, and every credential file is
 * written to a temp directory the test runs in.
 */

// Loaded before any test clears the environment, because the doctor's first
// import loads the repository .env - which would put the variables straight back.
require('../dist/scripts/sheetsDoctor');

const CREDENTIAL_VARIABLES = ['GOOGLE_CREDENTIALS_PATH', 'GOOGLE_SERVICE_ACCOUNT_KEY_PATH'];

const USER_CREDENTIAL = {
  type: 'authorized_user',
  client_id: '395426598589-test.apps.googleusercontent.com',
  client_secret: 'client-secret',
  refresh_token: 'refresh-token',
};

function serviceAccountCredential() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    type: 'service_account',
    client_email: 'doctor@project.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

function tokenEndpointSays(status, body) {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url: String(url), body: String(init?.body ?? '') });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { fakeFetch, calls };
}

/**
 * Runs `body` from a temp directory holding `files`, with the credential
 * variables cleared (or set to `env`), console.warn captured and fetch faked.
 *
 * The integration and the doctor are loaded FRESH, and in that order, so the
 * doctor's `instanceof GoogleSheetsRequestError` is checked against the same
 * class the integration throws, and the warn-once flags start clear.
 */
async function withCredentials(files, body, { fakeFetch, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailor-sheets-doctor-'));
  for (const [name, value] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
  }

  const sheets = loadFresh('../dist/integrations/googleSheets');
  const doctor = loadFresh('../dist/scripts/sheetsDoctor');

  const saved = Object.fromEntries(CREDENTIAL_VARIABLES.map((name) => [name, process.env[name]]));
  const cwd = process.cwd();
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  const warnings = [];

  for (const name of CREDENTIAL_VARIABLES) delete process.env[name];
  for (const [name, value] of Object.entries(env)) process.env[name] = value.replace('<dir>', dir);
  process.chdir(dir);
  console.warn = (...args) => warnings.push(args.join(' '));
  if (fakeFetch) globalThis.fetch = fakeFetch;

  try {
    return await body({ dir, sheets, doctor, warnings });
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
    process.chdir(cwd);
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('importing the doctor runs nothing, so its remedies can be tested', () => {
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  let fetched = 0;
  const printed = [];
  globalThis.fetch = async () => {
    fetched += 1;
    throw new Error('the doctor must not run on import');
  };
  console.log = (...args) => printed.push(args.join(' '));
  try {
    const doctor = loadFresh('../dist/scripts/sheetsDoctor');
    assert.equal(typeof doctor.tokenRefusedRemedy, 'function');
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
  }
  assert.equal(fetched, 0);
  assert.deepEqual(printed, []);
});

test('an expired sign-in is diagnosed as one, and the operator is told to sign in again', async () => {
  // Exactly the report that prompted this: the OAuth file in use, an old
  // service account key ignored beside it, and Google answering invalid_grant.
  const { fakeFetch, calls } = tokenEndpointSays(400, {
    error: 'invalid_grant',
    error_description: 'Token has been expired or revoked.',
  });

  await withCredentials(
    {
      'google-oauth-credentials.json': USER_CREDENTIAL,
      'service-account-key.json': serviceAccountCredential(),
    },
    async ({ sheets, doctor }) => {
      const account = await sheets.describeServiceAccount();
      assert.equal(account.kind, 'authorized_user', 'the OAuth file wins the tie, as before');

      const error = await sheets.getAccessToken(sheets.SHEETS_SCOPE).then(
        () => assert.fail('an invalid_grant must not mint a token'),
        (refused) => refused
      );
      assert.equal(calls.length, 1);
      assert.match(calls[0].body, /grant_type=refresh_token/);

      // The account-holder half is unchanged...
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /sign-in is no longer valid/);
      assert.doesNotMatch(error.message, /sheets:login/, 'a page must not hand out server commands');
      // ...and the operator half now carries Google's own words too, which is
      // what the README's Troubleshooting row is keyed on.
      assert.match(error.detail, /Testing/);
      assert.match(error.detail, /sheets:login/);
      assert.match(error.detail, /Google said: "invalid_grant: Token has been expired or revoked\./);

      // What the doctor prints: both halves, then a remedy for THIS credential.
      const printed = doctor.reason(error);
      assert.match(printed, /^HTTP 400: This server's Google sign-in is no longer valid/);
      assert.match(printed, /sheets:login/);
      assert.match(printed, /Token has been expired or revoked/);

      const remedy = doctor.tokenRefusedRemedy(account.kind);
      assert.match(remedy, /npm run sheets:login/);
      assert.match(remedy, /Publish app/);
      assert.match(remedy, /BOTH Sheets and Drive/);
      assert.doesNotMatch(remedy, /service account|clock|assertion|new key/i);
    },
    { fakeFetch }
  );
});

test('a deleted OAuth client is told apart from an expired sign-in', async () => {
  // Signing in again re-uses the client saved in the file, so with the CLIENT
  // gone that advice alone would loop. Google says invalid_client.
  const { fakeFetch } = tokenEndpointSays(401, {
    error: 'invalid_client',
    error_description: 'The OAuth client was not found.',
  });

  await withCredentials(
    { 'google-oauth-credentials.json': USER_CREDENTIAL },
    async ({ sheets, doctor }) => {
      const error = await sheets.getAccessToken(sheets.SHEETS_SCOPE).then(
        () => assert.fail('an invalid_client must not mint a token'),
        (refused) => refused
      );
      assert.equal(error.statusCode, 401);
      assert.match(error.message, /OAuth client Google no longer accepts/);
      assert.match(error.detail, /Desktop app OAuth client/);
      assert.match(error.detail, /Google said: "invalid_client: The OAuth client was not found\./);
      assert.match(doctor.tokenRefusedRemedy('authorized_user'), /invalid_client/);
    },
    { fakeFetch }
  );
});

test('a refused service account key still gets the service-account advice', async () => {
  const { fakeFetch, calls } = tokenEndpointSays(400, {
    error: 'invalid_grant',
    error_description: 'Invalid JWT Signature.',
  });

  await withCredentials(
    { 'service-account-key.json': serviceAccountCredential() },
    async ({ sheets, doctor }) => {
      const account = await sheets.describeServiceAccount();
      assert.equal(account.kind, 'service_account');
      assert.equal(account.identity, 'doctor@project.iam.gserviceaccount.com');

      const error = await sheets.getAccessToken(sheets.SHEETS_SCOPE).then(
        () => assert.fail('a refused key must not mint a token'),
        (refused) => refused
      );
      assert.match(calls[0].body, /jwt-bearer/);
      assert.match(error.message, /service account key was rejected/);
      assert.match(error.detail, /Google said: "invalid_grant: Invalid JWT Signature\./);

      const remedy = doctor.tokenRefusedRemedy(account.kind);
      assert.match(remedy, /issue a new key/);
      assert.match(remedy, /clock/);
      assert.doesNotMatch(remedy, /sheets:login/);
    },
    { fakeFetch }
  );
});

test('half a credential fails at step 2 with the loader\'s own words, not at step 3', async () => {
  // A downloaded OAuth client is not a credential. It used to pass step 2 as
  // "service account: (missing)" and surface one step later under the remedy
  // for a revoked key.
  await withCredentials(
    {
      'google-oauth-credentials.json': {
        installed: { client_id: 'id.apps.googleusercontent.com', client_secret: 'secret' },
      },
    },
    async ({ sheets }) => {
      await assert.rejects(
        () => sheets.describeServiceAccount(),
        (error) => {
          assert.match(error.message, /not a credential this app can use/);
          assert.match(error.message, /sheets:login/);
          return true;
        }
      );
    }
  );
});

test('the later remedies follow the credential kind as well', () => {
  const doctor = require('../dist/scripts/sheetsDoctor');

  // A consent with Drive unticked first fails at step 5, as a scope refusal.
  const scope = 'The access token did not carry the scope needed to read Drive.';
  assert.match(doctor.driveAboutRemedy(scope, 'authorized_user'), /leave BOTH ticked/);
  assert.match(doctor.driveAboutRemedy(scope, 'service_account'), /domain-wide delegation/);

  // A switched-off API is the same instruction for both.
  assert.match(doctor.driveAboutRemedy('Drive API is switched off', 'authorized_user'), /enable the API/);

  const noStorage = 'The signed-in account has NO Drive storage (limit is 0 bytes)';
  assert.doesNotMatch(doctor.driveAboutRemedy(noStorage, 'authorized_user'), /service account/);
  assert.match(
    doctor.driveAboutRemedy('This service account has NO Drive storage', 'service_account'),
    /SHARED DRIVE/
  );

  assert.match(doctor.driveScopeRemedy('service_account'), /domain-wide delegation/);
  assert.doesNotMatch(doctor.driveScopeRemedy('authorized_user'), /delegation/);

  assert.doesNotMatch(doctor.createSpreadsheetRemedy('authorized_user'), /service account/);
  assert.match(doctor.createSpreadsheetRemedy('service_account'), /service account/);
});

test('a credential path that names nothing is said out loud, then the search runs', async () => {
  await withCredentials(
    { 'google-oauth-credentials.json': USER_CREDENTIAL },
    async ({ sheets, warnings, dir }) => {
      const chosen = await sheets.resolveCredentialPath();
      assert.equal(
        fs.realpathSync(chosen),
        fs.realpathSync(path.join(dir, 'google-oauth-credentials.json')),
        'it still falls back'
      );

      const said = warnings.join('\n');
      assert.match(said, /GOOGLE_CREDENTIALS_PATH names .*gone\.json, which does not exist/);
      assert.match(said, /Searching the default locations instead/);
    },
    { env: { GOOGLE_CREDENTIALS_PATH: '<dir>/gone.json' } }
  );
});

test('the two-files warning does not tell you to set a variable that is why the file won', async () => {
  await withCredentials(
    {
      'google-oauth-credentials.json': USER_CREDENTIAL,
      'service-account-key.json': serviceAccountCredential(),
    },
    async ({ sheets, warnings, dir }) => {
      const chosen = await sheets.resolveCredentialPath();
      assert.equal(fs.realpathSync(chosen), fs.realpathSync(path.join(dir, 'service-account-key.json')));

      // \d+, not 2: the search also looks beside the compiled code, so a
      // developer's own backend/ credentials can add to the count.
      const said = warnings.join('\n');
      assert.match(said, /\d+ Google credential files were found/);
      assert.match(said, /It is used because GOOGLE_CREDENTIALS_PATH names it/);
      assert.doesNotMatch(said, /set GOOGLE_CREDENTIALS_PATH/);
    },
    { env: { GOOGLE_CREDENTIALS_PATH: '<dir>/service-account-key.json' } }
  );

  await withCredentials(
    {
      'google-oauth-credentials.json': USER_CREDENTIAL,
      'service-account-key.json': serviceAccountCredential(),
    },
    async ({ sheets, warnings }) => {
      await sheets.resolveCredentialPath();
      // Unset, the advice stands - and names the file that actually decides.
      assert.match(warnings.join('\n'), /set GOOGLE_CREDENTIALS_PATH in the repository \.env/);
    }
  );
});
