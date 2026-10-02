import '../config/env';

import { describeAdminIdentity, resolveAdminIdentity } from '../config/adminIdentity';
import { ENV_PATH } from '../config/env';
import { summarizeEnvFile } from '../config/envFile';
import {
  describeMailConfig,
  MailNotConfiguredError,
  sendTestMessage,
  verifyMailTransport,
} from '../services/auth/mailer';

/**
 * Why sign-in emails are not arriving, step by step.
 *
 * THE PROBLEM THIS SOLVES, and it is the same shape as `sheets:doctor`'s. The
 * only code path that sends mail is the sign-in flow, so testing the mail setup
 * means running the frontend, the backend and a browser, and getting an account
 * to the point of asking for a code. When it fails it says
 * "Could not send the sign-in email via <host>: <reason>" - one sentence that is
 * equally true of a missing variable, a wrong password, a relay that has not
 * verified your domain, and a port whose TLS mode does not match.
 *
 * So this walks the same chain in order and stops at the first break, naming what
 * to change. It needs no server, no frontend and no domain pointed anywhere.
 *
 * THE DISTINCTION THAT MATTERS is between step 3 and step 4. Connecting proves
 * the host, the port, the TLS mode and the credentials. A relay then refuses to
 * send from a domain it has not verified - at MESSAGE time, long after auth
 * succeeded. "Connected fine, send refused" is the single most likely state while
 * you are mid-setup, and the one the app's own error cannot express.
 *
 *   npm run mail:doctor                         config, the traps, connect + auth
 *   npm run mail:doctor -- --to you@example.com  also sends one real message
 *
 * Never prints SMTP_PASS, and the test message is plainly a test rather than the
 * sign-in template - nothing here puts a six-digit number that looks like a live
 * code into an inbox or a scrollback.
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

const sendTo = argValue('--to');

function reason(error: unknown): string {
  if (error instanceof MailNotConfiguredError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** The address out of `Name <addr>`, or the value itself when it is bare. */
function addressOf(from: string): string {
  const angled = /<([^>]+)>/.exec(from);
  return (angled ? angled[1] : from).trim();
}

async function main(): Promise<void> {
  console.log('Mail doctor\n');

  const steps: Step[] = [
    {
      /*
       * Before judging the configuration, say where it came from.
       *
       * "SMTP_HOST is not set" against a file that visibly contains it has four
       * causes that look the same from outside: a DIFFERENT file was read, a
       * later duplicate key won, the encoding did not decode, or the edit was
       * never saved. This step separates them, and it informs rather than gates -
       * it only fails when there is no file, or nothing mail-related in it.
       */
      title: 'Locate the .env',
      run: async () => {
        const file = summarizeEnvFile(ENV_PATH);
        if (!file.exists) {
          throw new Error(`No file at ${file.path}`);
        }

        const mailKeys = file.keys.filter(
          (key) => key.startsWith('SMTP_') || key === 'ADMIN_EMAILS'
        );
        if (mailKeys.length === 0) {
          throw new Error(
            `${file.path} holds ${file.keys.length} setting(s), and none of them is SMTP_ or ADMIN_EMAILS`
          );
        }

        const dupes = file.duplicates.filter(
          (key) => key.startsWith('SMTP_') || key === 'ADMIN_EMAILS'
        );

        return (
          `${file.path}\n` +
          `    ${file.bytes} bytes, ${file.encoding}\n` +
          `    mail settings found: ${mailKeys.join(', ')}` +
          (dupes.length
            ? `\n    DUPLICATED, and the LAST one wins: ${dupes.join(', ')}`
            : '')
        );
      },
      remedy: () =>
        'This is the only .env the app reads, and the path is resolved from the compiled\n' +
        '  module rather than from where you ran the command - so a file at backend/.env is\n' +
        '  ignored no matter which directory you are in. Check in order:\n' +
        '    1. the file is at the path above, i.e. the REPOSITORY ROOT, not backend/;\n' +
        '    2. your editor saved it;\n' +
        '    3. the encoding above is utf8 or utf16le - a UTF-16 file written WITHOUT a\n' +
        '       byte-order mark decodes to nonsense, and PowerShell\'s > writes UTF-16;\n' +
        '    4. no key is listed as duplicated, since the last assignment silently wins.',
    },
    {
      title: 'Read the SMTP configuration',
      run: async () => {
        const status = describeMailConfig();
        if (!status.configured) throw new MailNotConfiguredError(status.missing);
        return (
          `host:   ${status.host}:${status.port}\n` +
          `    from:   ${status.from}\n` +
          `    secure: ${status.port === 465 ? 'implicit TLS' : 'STARTTLS'} (derived from the port)`
        );
      },
      remedy: () =>
        'Set those in the repository .env and run this again. For Resend they are:\n' +
        '    SMTP_HOST=smtp.resend.com, SMTP_PORT=587, SMTP_USER=resend,\n' +
        '    SMTP_PASS=<your re_... API key>.\n' +
        '  Leave SMTP_SECURE unset - the TLS mode is derived from the port.',
    },
    {
      title: 'Check the two settings a relay makes mandatory',
      run: async () => {
        const status = describeMailConfig();
        if (!status.configured) throw new MailNotConfiguredError(status.missing);

        const user = (process.env.SMTP_USER ?? '').trim();
        const userIsAddress = EMAIL_SHAPE.test(user);
        const notes: string[] = [];

        // SMTP_FROM falls back to SMTP_USER, and a relay's username is not an
        // address - Resend's is the word "resend", SendGrid's is "apikey".
        if (!userIsAddress && !(process.env.SMTP_FROM ?? '').trim()) {
          throw new Error(
            `SMTP_USER is "${user}", which is not an email address, and SMTP_FROM is not set. ` +
              `Every sign-in email would be sent from "${user}".`
          );
        }
        notes.push(
          userIsAddress
            ? `SMTP_USER is an address, so SMTP_FROM is optional here`
            : `SMTP_USER is "${user}" (a relay username), and SMTP_FROM covers it`
        );

        // The admin fallback reads SMTP_USER too, and ignores it unless it looks
        // like an address - so with a relay it names nobody at all.
        const admin = resolveAdminIdentity();
        if (admin.source === 'none') {
          throw new Error(
            'No administrator is configured. ADMIN_EMAILS is unset, and the SMTP_USER fallback ' +
              `ignores "${user}" because it is not an email address.`
          );
        }
        notes.push(describeAdminIdentity());

        const from = addressOf(status.from);
        if (!EMAIL_SHAPE.test(from)) {
          throw new Error(`SMTP_FROM does not contain a usable address: "${status.from}"`);
        }

        return notes.join('\n    ');
      },
      remedy: () =>
        'Set SMTP_FROM to a real address on your domain, and ADMIN_EMAILS to the address you\n' +
        '  sign in with. Both look optional and are not when the SMTP username is not an\n' +
        '  address: without the first, mail is sent from the username; without the second,\n' +
        '  the installation has no administrator and cannot appoint one from its own UI.',
    },
    {
      title: 'Connect and authenticate (sends nothing)',
      run: async () => {
        const status = await verifyMailTransport();
        return status.configured ? `${status.host}:${status.port} accepted the credentials` : 'ok';
      },
      remedy: (error) => {
        const message = reason(error).toLowerCase();
        if (message.includes('invalid login') || message.includes('535') || message.includes('auth')) {
          return (
            'The host answered and rejected the credentials. Check SMTP_PASS is the whole key\n' +
            '  including the re_ prefix, and that SMTP_USER is the literal word "resend" rather\n' +
            '  than your account email.'
          );
        }
        if (message.includes('timeout') || message.includes('econnrefused') || message.includes('enotfound')) {
          return (
            'Nothing answered. Check SMTP_HOST for a typo, and that outbound SMTP is not blocked\n' +
            '  on this network - some home ISPs and most corporate ones block 587 and 465.'
          );
        }
        return (
          'Connecting failed before any message was attempted. If the error mentions TLS or a\n' +
          '  wrong version number, the port and the TLS mode disagree: use 587 (STARTTLS) or\n' +
          '  465 (implicit TLS) and leave SMTP_SECURE unset so it is derived.'
        );
      },
    },
  ];

  if (sendTo) {
    steps.push({
      title: `Send one real message to ${sendTo}`,
      run: async () => {
        const from = await sendTestMessage(sendTo);
        return `accepted for delivery, from ${from}`;
      },
      remedy: () =>
        'Authentication worked and the message did not, which almost always means the relay\n' +
        '  has not verified your sending domain yet - until it does, most relays refuse to\n' +
        '  send to anybody but your own account address. Finish the DNS records the relay\n' +
        '  asked for, wait for it to read "Verified", then run this again. Also check the\n' +
        '  domain in SMTP_FROM is EXACTLY the one you verified: a relay that verified\n' +
        '  send.example.com will refuse a From of login@example.com.',
    });
  }

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

  if (!failed) {
    console.log(
      sendTo
        ? `\nMail is working. Check ${sendTo} - including its spam folder, which is where a` +
            '\nbrand-new sending domain lands until it has some history.'
        : '\nConfiguration and the connection are good. Nothing was sent: add' +
            '\n  -- --to you@example.com\nto prove a real message leaves, which is the half that' +
            '\ncatches an unverified sending domain.'
    );
  }

  process.exit(failed ? 1 : 0);
}

void main().catch((error) => {
  console.error('The doctor itself failed:', error);
  process.exit(1);
});
