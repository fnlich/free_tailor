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

// Signing in again re-uses the client saved in the file, so with the CLIENT
// gone that advice alone would loop. Google has three codes for it - and
// `deleted_client` is the one a recently deleted client actually gets, which
// the first version of this branch did not recognise.
for (const { code, description, says } of [
  { code: 'deleted_client', description: 'The OAuth client was deleted.', says: /restored for 30 days/ },
  { code: 'disabled_client', description: 'The OAuth client was disabled.', says: /Re-enable it/ },
  { code: 'invalid_client', description: 'The OAuth client was not found.', says: /does not exist/ },
]) {
  test(`a dead OAuth client (${code}) is told apart from an expired sign-in`, async () => {
    const { fakeFetch } = tokenEndpointSays(401, { error: code, error_description: description });

    await withCredentials(
      { 'google-oauth-credentials.json': USER_CREDENTIAL },
      async ({ sheets, doctor }) => {
        const error = await sheets.getAccessToken(sheets.SHEETS_SCOPE).then(
          () => assert.fail(`${code} must not mint a token`),
          (refused) => refused
        );
        // NOT a 401 to the browser: the frontend reads that as the caller's own
        // session ending and signs them out. Google's status is kept aside.
        assert.equal(error.statusCode, 502);
        assert.equal(error.upstreamStatus, 401);
        assert.match(doctor.reason(error), /^HTTP 401: /, 'the doctor still shows what Google said');

        assert.match(error.message, /OAuth client Google no longer accepts/);
        assert.doesNotMatch(error.message, /sheets:login|backend\//);
        assert.match(error.detail, says);
        assert.match(error.detail, /sheets:login -- --client/);
        assert.ok(error.detail.includes(`Google said: "${code}: ${description}`));
        assert.match(doctor.tokenRefusedRemedy('authorized_user'), new RegExp(code));
      },
      { fakeFetch }
    );
  });
}

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
    // Pinned, because the search takes every google-oauth-credentials.json
    // before any service-account-key.json - including a developer's own
    // sheets:login file beside the compiled code, which would otherwise win.
    { fakeFetch, env: { GOOGLE_CREDENTIALS_PATH: '<dir>/service-account-key.json' } }
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
    async ({ sheets, doctor }) => {
      await assert.rejects(
        () => sheets.describeServiceAccount(),
        (error) => {
          // The file and the command are for the operator, who gets them from
          // the doctor; an account holder's page gets neither.
          assert.match(error.message, /credential file cannot be used/);
          assert.doesNotMatch(error.message, /sheets:login|google-oauth-credentials/);
          assert.match(error.detail, /not a credential this app can use/);
          assert.match(error.detail, /google-oauth-credentials\.json/);
          assert.match(error.detail, /sheets:login/);
          assert.match(doctor.reason(error), /sheets:login/);
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

  // Step 6 is the first Sheets API call, after step 5 proved Drive works.
  const refused = 'HTTP 403: The caller does not have permission';
  assert.doesNotMatch(doctor.createSpreadsheetRemedy(refused, 'authorized_user'), /service account|Drive API/);
  assert.match(doctor.createSpreadsheetRemedy(refused, 'service_account'), /service account/);
  assert.match(
    doctor.createSpreadsheetRemedy('Google Sheets API is switched off for project x', 'authorized_user'),
    /first call to the Google Sheets API/
  );
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

test('a missing path beside two default files is not claimed as the reason one won', async () => {
  // The stale-variable trap: the variable names nothing, so the search picks
  // a file it does NOT name - and must not say the variable chose it.
  await withCredentials(
    {
      'google-oauth-credentials.json': USER_CREDENTIAL,
      'service-account-key.json': serviceAccountCredential(),
    },
    async ({ sheets, warnings }) => {
      await sheets.resolveCredentialPath();
      const said = warnings.join('\n');
      assert.match(said, /which does not exist/);
      assert.match(said, /Google credential files were found/);
      assert.doesNotMatch(said, /It is used because/);
      assert.match(said, /set GOOGLE_CREDENTIALS_PATH in the repository \.env/);
    },
    { env: { GOOGLE_CREDENTIALS_PATH: '<dir>/gone.json' } }
  );
});

test('the older variable name is the one named when it is the one in use', async () => {
  await withCredentials(
    { 'google-oauth-credentials.json': USER_CREDENTIAL },
    async ({ sheets, warnings }) => {
      await sheets.resolveCredentialPath();
      assert.match(warnings.join('\n'), /GOOGLE_SERVICE_ACCOUNT_KEY_PATH names .*gone\.json/);
    },
    { env: { GOOGLE_SERVICE_ACCOUNT_KEY_PATH: '<dir>/gone.json' } }
  );

  await withCredentials(
    {
      'google-oauth-credentials.json': USER_CREDENTIAL,
      'service-account-key.json': serviceAccountCredential(),
    },
    async ({ sheets, warnings }) => {
      await sheets.resolveCredentialPath();
      assert.match(warnings.join('\n'), /It is used because GOOGLE_SERVICE_ACCOUNT_KEY_PATH names it/);
    },
    { env: { GOOGLE_SERVICE_ACCOUNT_KEY_PATH: '<dir>/service-account-key.json' } }
  );
});

test('the whole walk, as reported: an expired sign-in gets the sign-in advice', async () => {
  // The remedies being right is no use unless the steps hand them the
  // credential in use - so this runs the doctor itself, against a .env
  // shaped like one copied from .env.example.
  const { fakeFetch } = tokenEndpointSays(400, {
    error: 'invalid_grant',
    error_description: 'Token has been expired or revoked.',
  });

  await withCredentials(
    {
      'google-oauth-credentials.json': USER_CREDENTIAL,
      'service-account-key.json': serviceAccountCredential(),
    },
    async ({ dir, doctor }) => {
      const envPath = path.join(dir, '.env');
      fs.writeFileSync(
        envPath,
        'GOOGLE_CLIENT_ID=sign-in-button.apps.googleusercontent.com\n' +
          'GOOGLE_CREDENTIALS_PATH=\n' +
          'GOOGLE_SERVICE_ACCOUNT_KEY_PATH=\n' +
          'SHEET_TIMEZONE=Europe/Berlin\n'
      );

      const printed = [];
      const realLog = console.log;
      console.log = (...args) => printed.push(args.join(' '));
      let code;
      try {
        code = await doctor.main(envPath);
      } finally {
        console.log = realLog;
      }
      const out = printed.join('\n');

      assert.equal(code, 1);
      assert.match(out, /sheets settings in effect: SHEET_TIMEZONE/);
      assert.match(
        out,
        /present but EMPTY - not in effect, and blanking any shell value: GOOGLE_CREDENTIALS_PATH, GOOGLE_SERVICE_ACCOUNT_KEY_PATH/
      );
      assert.doesNotMatch(out, /GOOGLE_CLIENT_ID/, "the sign-in button's client is not this credential");
      assert.match(out, /kind: +your own Google account/);
      assert.match(out, /FAIL 3\. Mint an access token/);
      assert.match(out, /Token has been expired or revoked/);
      assert.match(out, /npm run sheets:login/);
      assert.match(out, /Publish app/);
      assert.doesNotMatch(out, /issue a new key|clock/);
      assert.doesNotMatch(out, /OK +4\./, 'the walk stops at the first break');
    },
    { fakeFetch }
  );
});

/** A fake Google for a doctor run that gets past the token: routes by URL. */
function googleThatRefusesTheSheetsCall() {
  return async (url) => {
    const at = String(url);
    const json = (status, body) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (at.startsWith('https://oauth2.googleapis.com/token')) {
      return json(200, { access_token: 'ya29.test-token', expires_in: 3600 });
    }
    if (at.startsWith('https://www.googleapis.com/drive/v3/about')) {
      return json(200, {
        user: { emailAddress: 'operator@example.com' },
        storageQuota: { limit: '16106127360', usage: '1024' },
      });
    }
    if (at.startsWith('https://sheets.googleapis.com/v4/spreadsheets')) {
      return json(403, { error: { code: 403, message: 'The caller does not have permission' } });
    }
    throw new Error(`unexpected request to ${at}`);
  };
}

test('the whole walk to step 6: the first Sheets call is not blamed on the Drive step 5 proved', async () => {
  await withCredentials(
    { 'google-oauth-credentials.json': USER_CREDENTIAL },
    async ({ dir, doctor }) => {
      const envPath = path.join(dir, '.env');
      fs.writeFileSync(envPath, '');
      const printed = [];
      const realLog = console.log;
      console.log = (...args) => printed.push(args.join(' '));
      let code;
      try {
        code = await doctor.main(envPath);
      } finally {
        console.log = realLog;
      }
      const out = printed.join('\n');

      assert.equal(code, 1);
      assert.match(out, /OK +3\./);
      assert.match(out, /OK +4\./);
      assert.match(out, /OK +5\..*\n.*drive reachable as operator@example\.com/);
      assert.match(out, /FAIL 6\. Create a throwaway spreadsheet/);
      // Each step past the token hands its remedy the credential in use:
      // a regression to service-account wiring would print these.
      assert.doesNotMatch(out, /service account|domain-wide delegation/);
      assert.match(out, /Step 5 proved Drive is reachable/);
      // And the reason above it names the Sheets API, not only Drive.
      assert.match(out, /the Sheets API too/);
    },
    { fakeFetch: googleThatRefusesTheSheetsCall() }
  );
});

test('the newer variable outranks the older one when both are set', async () => {
  await withCredentials(
    {
      'google-oauth-credentials.json': USER_CREDENTIAL,
      'service-account-key.json': serviceAccountCredential(),
    },
    async ({ sheets, dir }) => {
      assert.equal(sheets.credentialPathVariable(), 'GOOGLE_CREDENTIALS_PATH');
      const chosen = await sheets.resolveCredentialPath();
      assert.equal(fs.realpathSync(chosen), fs.realpathSync(path.join(dir, 'google-oauth-credentials.json')));
    },
    {
      env: {
        GOOGLE_CREDENTIALS_PATH: '<dir>/google-oauth-credentials.json',
        GOOGLE_SERVICE_ACCOUNT_KEY_PATH: '<dir>/service-account-key.json',
      },
    }
  );
});

test('a relative path that names nothing says where it was resolved from', async () => {
  await withCredentials(
    { 'google-oauth-credentials.json': USER_CREDENTIAL },
    async ({ sheets, warnings }) => {
      await sheets.resolveCredentialPath();
      assert.match(warnings.join('\n'), /which does not exist \(a relative path resolves from .+\)/);
    },
    { env: { GOOGLE_CREDENTIALS_PATH: 'nested/gone.json' } }
  );
});

test("a route hands the operator half to an administrator and the log, never to an account holder's page", async () => {
  await withCredentials({}, async ({ sheets }) => {
    const { sheetsOperatorDetail } = loadFresh('../dist/routes/sheetsDetail');
    const error = new sheets.GoogleSheetsRequestError(
      500,
      "This server's Google credential file cannot be used.",
      '/srv/backend/google-oauth-credentials.json is not valid JSON.'
    );

    const logged = [];
    const realError = console.error;
    console.error = (...args) => logged.push(args.join(' '));
    try {
      assert.deepEqual(sheetsOperatorDetail({ user: { role: 'user' } }, error), {});
      assert.deepEqual(sheetsOperatorDetail({ user: { role: 'admin' } }, error), {
        detail: '/srv/backend/google-oauth-credentials.json is not valid JSON.',
      });
      assert.deepEqual(sheetsOperatorDetail({ user: { role: 'admin' } }, new Error('other')), {});
    } finally {
      console.error = realError;
    }
    assert.equal(logged.length, 2, 'logged for both readers, so the operator half always lands somewhere');
    assert.match(logged[0], /not valid JSON/);
  });
});

test('sheets:login re-uses the client from the file the app reads, not a stale copy beside it', async () => {
  // The state an install is left in after GOOGLE_CREDENTIALS_PATH moved the
  // credential: an older consented copy here, holding a client since deleted.
  const stale = { ...USER_CREDENTIAL, client_id: 'stale-deleted.apps.googleusercontent.com' };
  const live = { ...USER_CREDENTIAL, client_id: 'live.apps.googleusercontent.com' };

  await withCredentials(
    { 'google-oauth-credentials.json': stale, 'elsewhere.json': live },
    async () => {
      const login = loadFresh('../dist/scripts/googleLogin');
      const realLog = console.log;
      console.log = () => {};
      try {
        const client = await login.loadClient();
        assert.equal(client.clientId, 'live.apps.googleusercontent.com');
      } finally {
        console.log = realLog;
      }
    },
    { env: { GOOGLE_CREDENTIALS_PATH: '<dir>/elsewhere.json' } }
  );

  // A fresh download still beats every consented file.
  await withCredentials(
    {
      'google-oauth-credentials.json': stale,
      'elsewhere.json': live,
      'client_secret_new.json': { installed: { client_id: 'fresh', client_secret: 'x' } },
    },
    async () => {
      const login = loadFresh('../dist/scripts/googleLogin');
      assert.equal((await login.loadClient()).clientId, 'fresh');
    },
    { env: { GOOGLE_CREDENTIALS_PATH: '<dir>/elsewhere.json' } }
  );
});

test('sheets:login tells one file under two names from two files', async () => {
  await withCredentials({ 'a.json': USER_CREDENTIAL, 'b.json': USER_CREDENTIAL }, async ({ dir }) => {
    const login = loadFresh('../dist/scripts/googleLogin');
    const a = path.join(dir, 'a.json');
    const link = path.join(dir, 'link');
    fs.symlinkSync(dir, link, 'junction');
    assert.equal(await login.sameFileOnDisk(a, path.join(link, 'a.json')), true, 'a symlinked directory');
    assert.equal(await login.sameFileOnDisk(a, path.join(dir, 'b.json')), false, 'identical content, two files');
  });
});
