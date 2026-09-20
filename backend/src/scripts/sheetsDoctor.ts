import '../config/env';

import { resolveAdminIdentity } from '../config/adminIdentity';
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

function reason(error: unknown): string {
  if (error instanceof GoogleSheetsRequestError) return `HTTP ${error.statusCode}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
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

async function main(): Promise<void> {
  console.log('Google Sheets doctor\n');

  let spreadsheetId = '';
  let firstTabGid = -1;
  let owner = '';

  const steps: Step[] = [
    {
      title: 'Find the Google credentials',
      run: async () => {
        const account = await describeServiceAccount();
        owner = account.identity;
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
      remedy: () =>
        'The key was rejected outright. Usually the service account was deleted or its key\n' +
        '  revoked - issue a new key and replace the file. A clock more than a few minutes\n' +
        '  off will also do this, because the assertion is signed with a timestamp.',
    },
    {
      title: 'Mint an access token for the Drive scope',
      run: async () => `${(await getAccessToken(DRIVE_SCOPE)).slice(0, 12)}... (ok)`,
      remedy: () =>
        'The Sheets scope worked and this one did not. With a service account that points at a\n' +
        '  domain-wide delegation policy; with your own account it means the consent did not\n' +
        '  include Drive - run "npm run sheets:login" again and accept both.',
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
            'This service account has NO Drive storage (limit is 0 bytes), so it cannot own ' +
              'any file - which is what creating a spreadsheet requires.'
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
      remedy: (error) => {
        const said = reason(error);
        if (said.includes('switched off')) {
          return 'Follow the URL above, enable the API, wait a minute and run this again.';
        }
        if (said.includes('NO Drive storage')) {
          return (
            'Nothing is misconfigured - a service account simply has no storage of its own on a\n' +
            '  consumer Google project, and Google stopped granting it. Two ways out:\n' +
            '    - a Google Workspace domain, and a SHARED DRIVE the service account belongs to,\n' +
            '      where files count against the shared drive rather than the account; or\n' +
            '    - credentials belonging to a real person, so the sheets live in THEIR Drive.\n' +
            '  The second needs no Workspace and no paid plan, and is the one to pick for a\n' +
            '  personal Google account.'
          );
        }
        return (
          'Enable the Google Drive API for this key\'s project. Creating a spreadsheet makes a\n' +
          '  Drive file, so allocation cannot work without it even though the error names Sheets.'
        );
      },
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
      remedy: () =>
        'This is the call that fails in your log. With the steps above green, the usual\n' +
        '  remaining cause is the service account having no Drive storage of its own - point\n' +
        '  the key at a shared drive, or grant it storage.',
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

  process.exit(failed ? 1 : 0);
}

void main().catch((error) => {
  console.error('The doctor itself failed:', error);
  process.exit(1);
});
