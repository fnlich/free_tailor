import '../config/env';

import { resolveAdminIdentity } from '../config/adminIdentity';
import { ENV_PATH } from '../config/env';
import { summarizeEnvFile } from '../config/envFile';
import {
  createSpreadsheet,
  deleteSpreadsheet,
  describeServiceAccount,
  driveAbout,
  DRIVE_SCOPE,
  formatJobSheetTab,
  getAccessToken,
  getSpreadsheetVisibility,
  GoogleSheetsRequestError,
  setSpreadsheetVisibility,
  shareSpreadsheetWithEmail,
  SHEETS_SCOPE,
} from '../integrations/googleSheets';

/**
 * Why the per-account spreadsheet is not being created, step by step.
 *
 * THE PROBLEM THIS SOLVES. Allocation fails with a 403 whose message is
 * "The caller does not have permission" - a sentence that is true of a disabled
 * API, a narrow scope, a full Drive and a key for a deleted service account
 * alike. From inside a backend log there is no way to tell which, because each
 * of those failures happens on a different call and the log only shows the one
 * that threw.
 *
 * So this walks the SAME chain allocation walks, in order, and stops at the
 * first thing that breaks - naming what to change. Each step is the real API
 * call, not a simulation of one, because the failures worth finding are exactly
 * the ones a simulation would not reproduce.
 *
 * It creates one throwaway spreadsheet and deletes it again, and touches
 * nothing belonging to any account.
 *
 *   npm run sheets:doctor
 *   npm run sheets:doctor -- --email you@example.com   also tests sharing
 *   npm run sheets:doctor -- --keep                    leaves the throwaway behind
 */

type Step = {
  title: string;
  run: () => Promise<string>;
  /** Said when this step is what failed. */
  remedy: (error: unknown) => string;
};

function argValue(flag: string): string {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? (process.argv[index + 1] ?? '').trim() : '';
}

const keepThrowaway = process.argv.includes('--keep');
const shareWith = argValue('--email');

/** The two shapes a credential file comes in; step 2 says which one is in use. */
export type CredentialKind = 'authorized_user' | 'service_account';

/**
 * A failure, as the operator should read it.
 *
 * `detail` is the operator half of a Google error, kept apart so pages an
 * account holder can open never carry it (see `GoogleSheetsRequestError`).
 * Whoever runs this IS the operator - and since that split, this printed only
 * the half written for everyone else, "until an administrator renews it",
 * which is the one sentence the administrator can do nothing with.
 */
export function reason(error: unknown): string {
  if (error instanceof GoogleSheetsRequestError) {
    // Google's own status where the route-facing one had to differ from it.
    const status = error.upstreamStatus ?? error.statusCode;
    return `HTTP ${status}: ${error.message}` + (error.detail ? `\n    ${error.detail}` : '');
  }
  return error instanceof Error ? error.message : String(error);
}

/*
 * The remedies that depend on WHICH credential is in use.
 *
 * Every one of these was written when a service account was the only shape,
 * and kept being printed after `sheets:login` became the recommended one. The
 * result was an operator whose saved sign-in had expired being told to issue a
 * new service account key and check their clock - neither of which a refresh
 * token has. Exported so the tests can hold both halves without running the
 * doctor against Google.
 */

/** Step 3: the first time the credential itself is shown to Google. */
export function tokenRefusedRemedy(kind: CredentialKind): string {
  if (kind === 'authorized_user') {
    return (
      'Google refused the saved sign-in from "npm run sheets:login" - the reason above has its\n' +
      '  own words. The fix is to sign in again:\n' +
      '    1. If the OAuth consent screen is still in Testing, publish it FIRST: Cloud console ->\n' +
      '       Google Auth Platform -> Audience -> Publish app. Testing expires every consent seven\n' +
      '       days after it is given, and a consent given in Testing keeps that limit.\n' +
      '    2. Run "npm run sheets:login" in backend/ and approve BOTH Sheets and Drive. It re-uses\n' +
      '       the OAuth client already saved in the credential file.\n' +
      '  If Google said deleted_client, disabled_client or invalid_client rather than\n' +
      '  invalid_grant, the OAuth client itself is the problem and signing in again re-uses it -\n' +
      '  the reason above says what to do, ending in "npm run sheets:login -- --client <file>".'
    );
  }
  return (
    'The key was rejected outright. Usually the service account was deleted or its key\n' +
    '  revoked - issue a new key and replace the file. A clock more than a few minutes\n' +
    '  off will also do this, because the assertion is signed with a timestamp.'
  );
}

/** Step 4. */
export function driveScopeRemedy(kind: CredentialKind): string {
  if (kind === 'authorized_user') {
    // One consent carries both scopes and a refresh token cannot be narrowed
    // per call, so a refresh that worked one step ago and fails now is not a
    // missing permission. A consent with Drive unticked fails later, at step 5.
    return (
      'Both scopes come from the same saved sign-in, which the step above just used, so this\n' +
      '  is not a missing permission. Read the reason above; if it repeats, run\n' +
      '  "npm run sheets:login" in backend/ again and approve both Sheets and Drive.'
    );
  }
  return (
    'The Sheets scope worked and this one did not, which points at a domain-wide delegation\n' +
    '  policy stripping the Drive scope from this service account.'
  );
}

/** Step 5, which is where a consent with Drive unticked first shows. */
export function driveAboutRemedy(said: string, kind: CredentialKind): string {
  if (said.includes('switched off')) {
    return 'Follow the URL above, enable the API, wait a minute and run this again.';
  }
  if (said.includes('did not carry the scope')) {
    return kind === 'authorized_user'
      ? 'The saved sign-in does not include Drive - Google lets each permission be unticked on\n' +
          '  the consent screen. Run "npm run sheets:login" in backend/ again and leave BOTH ticked.'
      : 'A domain-wide delegation policy is stripping the Drive scope from this service account.';
  }
  if (said.includes('NO Drive storage')) {
    if (kind === 'authorized_user') {
      return (
        'The signed-in Google account has no storage of its own - a Workspace administrator\n' +
        '  can set a user\'s limit to zero. Sign in as an account that has room\n' +
        '  ("npm run sheets:login" in backend/), or ask that administrator.'
      );
    }
    return (
      'Nothing is misconfigured - a service account simply has no storage of its own on a\n' +
      '  consumer Google project, and Google stopped granting it.\n\n' +
      '  Use credentials belonging to a real person instead, so the sheets live in THEIR\n' +
      '  Drive:  npm run sheets:login\n\n' +
      '  A Google Workspace SHARED DRIVE is the other way a service account can have room,\n' +
      '  but THIS APP CANNOT USE ONE: `createSpreadsheet` names no parent, so the Sheets\n' +
      '  API always puts the new file in the caller\'s own My Drive - which for a service\n' +
      '  account is the drive with no space. Setting a shared drive up would not help\n' +
      '  without a code change, so do not spend the afternoon on it.'
    );
  }
  return (
    'Enable the Google Drive API for the Cloud project this credential belongs to - for your\n' +
    '  own account, the project that owns the OAuth client. Creating a spreadsheet makes a\n' +
    '  Drive file, so allocation cannot work without it even though the error names Sheets.'
  );
}

/**
 * Step 6 - the run's first call to the SHEETS API.
 *
 * Every step before it talked to the token endpoint or to Drive, and step 5
 * has just proved Drive enabled, so a project with only Drive switched on gets
 * this far and no further.
 */
export function createSpreadsheetRemedy(said: string, kind: CredentialKind): string {
  if (said.includes('switched off')) {
    return (
      'This is the first call to the Google Sheets API, and it is switched off for the project.\n' +
      '  Follow the URL above, enable it, wait a minute and run this again.'
    );
  }
  if (kind === 'authorized_user') {
    return (
      'This is the call that fails in your log. Step 5 proved Drive is reachable, so read the\n' +
      '  reason above for the rest: a storage quota means the signed-in account\'s Drive is full -\n' +
      '  free space there, or run "npm run sheets:login" in backend/ as an account that has room.'
    );
  }
  return (
    'This is the call that fails in your log. With the steps above green, the usual\n' +
    '  remaining cause is the service account having no Drive storage of its own, and the\n' +
    '  fix is `npm run sheets:login` rather than a shared drive - see the step above for\n' +
    '  why a shared drive cannot help this app as it stands.'
  );
}

/**
 * The `.env` variables this doctor reports on.
 *
 * Named rather than matched on a `GOOGLE_` prefix, because GOOGLE_CLIENT_ID is
 * the sign-in button's OAuth client and has nothing to do with the credential
 * Sheets uses - listing it here invited reading it as the client step 2 names.
 */
function isSheetsSetting(key: string): boolean {
  return (
    key === 'GOOGLE_CREDENTIALS_PATH' ||
    key === 'GOOGLE_SERVICE_ACCOUNT_KEY_PATH' ||
    key.startsWith('SHEET_')
  );
}

function formatBytes(value?: string): string {
  const bytes = Number(value ?? '');
  if (!Number.isFinite(bytes)) return 'unlimited';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(1)} ${units[unit]}`;
}

/**
 * The whole walk. Exported, with the `.env` to report on as a parameter, so a
 * test can run it end to end - the remedies being right is no use if the steps
 * stop passing them the credential in use.
 */
export async function main(envPath: string = ENV_PATH): Promise<number> {
  console.log('Google Sheets doctor\n');

  let spreadsheetId = '';
  let firstTabGid = -1;
  let owner = '';
  // Set by step 2, which every later step runs after.
  let credentialKind: CredentialKind = 'service_account';

  const steps: Step[] = [
    {
      /*
       * The same blind spot `mail:doctor` has: a setting that is plainly in the
       * file and plainly not in effect. The path is resolved from this compiled
       * module, so it is the repository root and never `backend/` - which is
       * where it lands for anyone running these scripts from `backend/`.
       */
      title: 'Locate the .env',
      run: async () => {
        const file = summarizeEnvFile(envPath);
        if (!file.exists) {
          // Not fatal: the credential search below has defaults that need no
          // .env at all, so this reports and moves on.
          return `No file at ${file.path} - relying on the default credential search`;
        }

        // A bare `NAME=` - which is how .env.example ships every one of
        // these - sets the variable to EMPTY, and reporting it as "found" said
        // otherwise. Worse than nothing, in fact: this .env overrides the real
        // environment, so the line blanks the same variable set in a shell.
        const named = file.keys.filter(isSheetsSetting);
        const inEffect = named.filter((key) => !file.empty.includes(key));
        const empty = named.filter((key) => file.empty.includes(key));
        const dupes = file.duplicates.filter(isSheetsSetting);

        return (
          `${file.path}\n` +
          `    ${file.bytes} bytes, ${file.encoding}\n` +
          `    sheets settings in effect: ${inEffect.length ? inEffect.join(', ') : 'none'}` +
          (empty.length ? `\n    present but EMPTY, so not in effect: ${empty.join(', ')}` : '') +
          (dupes.length ? `\n    DUPLICATED, and the LAST one wins: ${dupes.join(', ')}` : '')
        );
      },
      remedy: () =>
        'The path above is the only .env this app reads, and it is the repository root\n' +
        '  rather than backend/ - a file beside these scripts is ignored.',
    },
    {
      title: 'Find the Google credentials',
      run: async () => {
        const account = await describeServiceAccount();
        owner = account.identity;
        credentialKind = account.kind;
        const label = account.kind === 'authorized_user' ? 'OAuth client:   ' : 'service account:';
        return (
          `${account.path}\n` +
          `    kind:            ${
            account.kind === 'authorized_user' ? 'your own Google account' : 'service account'
          }\n` +
          `    ${label} ${account.identity}\n` +
          `    project:         ${account.projectId}`
        );
      },
      remedy: () =>
        'Run "npm run sheets:login" in backend/ to sign in with your own Google account, or put\n' +
        '  a service account key at backend/service-account-key.json. GOOGLE_CREDENTIALS_PATH\n' +
        '  overrides where to look.',
    },
    {
      title: 'Mint an access token for the Sheets scope',
      run: async () => `${(await getAccessToken(SHEETS_SCOPE)).slice(0, 12)}... (ok)`,
      remedy: () => tokenRefusedRemedy(credentialKind),
    },
    {
      title: 'Mint an access token for the Drive scope',
      run: async () => `${(await getAccessToken(DRIVE_SCOPE)).slice(0, 12)}... (ok)`,
      remedy: () => driveScopeRemedy(credentialKind),
    },
    {
      title: 'Ask Drive about itself (proves the Drive API is enabled)',
      run: async () => {
        const about = await driveAbout();
        const used = formatBytes(about.storageQuota?.usage);
        const rawLimit = about.storageQuota?.limit;
        const limit = rawLimit ? formatBytes(rawLimit) : 'unlimited';

        /**
         * A limit of zero is the whole answer, and it must not pass as green.
         *
         * It means this service account has no Drive storage of its own, so it
         * cannot OWN a file - and creating a spreadsheet creates a file it
         * would own. The next step then fails with "the caller does not have
         * permission", which reads like a misconfigured API and is not.
         * Service accounts on a consumer project get no storage; only a shared
         * drive, or credentials belonging to an actual person, have any.
         */
        if (rawLimit !== undefined && Number(rawLimit) === 0) {
          throw new Error(
            `${credentialKind === 'authorized_user' ? 'The signed-in account' : 'This service account'} ` +
              'has NO Drive storage (limit is 0 bytes), so it cannot own any file - which is ' +
              'what creating a spreadsheet requires.'
          );
        }

        /**
         * Whose Drive the sheets will land in, checked against who the app
         * calls an administrator.
         *
         * Nothing links the two. The credential belongs to whichever Google
         * account ran `sheets:login`, and the admin is whoever ADMIN_EMAILS or
         * SMTP_USER names - so signing in with the wrong account puts every
         * user's sheet in a Drive nobody expected, silently and permanently.
         * Cheap to notice now, expensive once sheets exist.
         */
        const owner = about.user?.emailAddress ?? '(not reported)';
        const admins = resolveAdminIdentity().emails;
        const mismatch =
          admins.length > 0 && !admins.includes(owner.trim().toLowerCase())
            ? `\n    NOTE: sheets will be owned by ${owner}, but this installation's ` +
              `administrator is ${admins.join(', ')}.\n` +
              '          That works, but the sheets land in a different Drive than you may expect.'
            : '';

        return `drive reachable as ${owner}, ${used} of ${limit} used${mismatch}`;
      },
      remedy: (error) => driveAboutRemedy(reason(error), credentialKind),
    },
    {
      title: 'Create a throwaway spreadsheet',
      run: async () => {
        const created = await createSpreadsheet('Free Tailor - doctor check', '01/01/2000');
        spreadsheetId = created.spreadsheetId;
        // Carried to the next step. It used to be assumed to be 0, which held
        // only while Google made the first tab itself and called it `Sheet1`;
        // naming the tab at creation means Google mints a random id for it.
        firstTabGid = created.firstTabGid;
        return `${created.spreadsheetUrl} (first tab gid ${firstTabGid})`;
      },
      remedy: (error) => createSpreadsheetRemedy(reason(error), credentialKind),
    },
    {
      title: 'Write the job sheet header into it',
      run: async () => {
        await formatJobSheetTab(spreadsheetId, firstTabGid);
        return 'header written';
      },
      remedy: () =>
        'The spreadsheet exists but cannot be written to, which should not happen when creating\n' +
        '  it just worked. "No grid with id" here means this check sent the wrong tab id rather\n' +
        '  than anything being wrong with your setup - report it.',
    },
  ];

  if (shareWith) {
    steps.push({
      title: `Share it with ${shareWith}`,
      run: async () => {
        await shareSpreadsheetWithEmail(spreadsheetId, shareWith);
        return 'shared as editor';
      },
      remedy: () =>
        'Everything but sharing works. Each account would get a spreadsheet it cannot open.\n' +
        '  Sharing is a Drive permission write - check the Drive API is enabled and that no\n' +
        '  organisation policy blocks sharing outside the domain.',
    });
  }

  steps.push({
    title: 'Make it link-shared, then withdraw that again',
    run: async () => {
      await setSpreadsheetVisibility(spreadsheetId, 'public');
      const asPublic = await getSpreadsheetVisibility(spreadsheetId);
      await setSpreadsheetVisibility(spreadsheetId, 'private');
      const asPrivate = await getSpreadsheetVisibility(spreadsheetId);
      return `public -> ${asPublic}, private -> ${asPrivate}`;
    },
    remedy: () =>
      'Allocation works but the public/private toggle does not. An organisation with Domain\n' +
      '  Restricted Sharing turned on blocks "anyone with the link" specifically; everything\n' +
      '  else will keep working, and sheets will stay private.',
  });

  let failed = false;

  for (const [index, step] of steps.entries()) {
    const label = `${index + 1}. ${step.title}`;
    try {
      const detail = await step.run();
      console.log(`  OK   ${label}\n    ${detail}`);
    } catch (error) {
      failed = true;
      console.log(`  FAIL ${label}`);
      console.log(`    ${reason(error)}`);
      console.log(`\n  What to do:\n  ${step.remedy(error)}`);
      break;
    }
  }

  if (spreadsheetId) {
    if (keepThrowaway) {
      console.log(`\n  Left behind for inspection: ${spreadsheetId}`);
    } else {
      try {
        await deleteSpreadsheet(spreadsheetId);
        console.log('\n  Throwaway spreadsheet deleted.');
      } catch (error) {
        console.log(`\n  Could not delete the throwaway ${spreadsheetId}: ${reason(error)}`);
      }
    }
  }

  if (!failed) {
    console.log(
      `\nEverything the per-account sheets need is working${owner ? ` for ${owner}` : ''}.` +
        '\nIf allocation still fails, restart the backend so it re-runs the backfill.'
    );
  }

  return failed ? 1 : 0;
}

/*
 * Only when run as a script, so the tests can import the remedies above
 * without running the doctor against Google.
 *
 * And `exitCode` rather than `process.exit()`, which is not tidiness. On
 * Windows, exiting outright straight after a fetch() races Node's own teardown
 * and aborts with "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING),
 * file src\win\async.c" - after the whole report has printed, but replacing
 * the exit code with a crash code. Fixed in Node itself only in 24.20 and 26.7
 * (nodejs/node#61999), never in 22. Letting the event loop drain avoids the
 * race on every version, and nothing here holds the loop open: fetch's idle
 * keep-alive sockets are unref'd.
 */
if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error('The doctor itself failed:', error);
      process.exitCode = 1;
    });
}
