import '../config/env';

import crypto from 'crypto';
import fs from 'fs/promises';
import http from 'http';
import path from 'path';
import { AddressInfo } from 'net';

import { DRIVE_SCOPE, SHEETS_SCOPE } from '../integrations/googleSheets';

/**
 * Signs this installation in to Google as YOU, once, and saves the consent.
 *
 * WHY THIS EXISTS. The tidy way to let a server touch Google is a service
 * account - until you try it on a consumer project and find the account has a
 * Drive quota of zero bytes. It authenticates perfectly and cannot own a single
 * file, and creating a spreadsheet means owning one, so every allocation fails
 * with a 403 that blames permissions and means storage. Shared drives fix it
 * and need a paid Workspace domain.
 *
 * So instead the app can hold a refresh token that a person granted. The sheets
 * then live in that person's Drive, which has room, and they can see them in
 * Drive like any other file. Nothing about the app changes except whose
 * credential is on the request.
 *
 * The flow is the loopback one: a throwaway HTTP server on 127.0.0.1 receives
 * the redirect, so nothing is typed or pasted and no port has to be reachable
 * from outside this machine.
 *
 *   npm run sheets:login
 *   npm run sheets:login -- --client path\to\client_secret.json
 */

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const OUTPUT_FILE = 'google-oauth-credentials.json';

type ClientSecretFile = {
  installed?: { client_id?: string; client_secret?: string };
  web?: { client_id?: string; client_secret?: string };
  client_id?: string;
  client_secret?: string;
  /** Present once this script has already run against the file. */
  refresh_token?: string;
};

function argValue(flag: string): string {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? (process.argv[index + 1] ?? '').trim() : '';
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds the OAuth client Google gave you.
 *
 * Accepts the file exactly as downloaded - the console wraps the id and secret
 * in an `installed` or `web` object depending on the client type, and making
 * somebody unwrap that by hand is a step that can only go wrong.
 */
async function loadClient(): Promise<{ clientId: string; clientSecret: string; from: string }> {
  const explicit = argValue('--client');
  const candidates = explicit
    ? [explicit]
    : [
        path.join(process.cwd(), 'oauth-client.json'),
        path.join(process.cwd(), 'backend', 'oauth-client.json'),
        // The output filename is searched too, because saving the downloaded
        // client under it is an easy mistake and a miserable one: the app
        // prefers that name, finds no refresh_token in it and refuses, while
        // this script said "no client found" about the very file it needed.
        // Both messages were true and neither was any help.
        path.join(process.cwd(), OUTPUT_FILE),
        ...(await fs.readdir(process.cwd()).catch(() => [] as string[]))
          .filter((name) => name.startsWith('client_secret') && name.endsWith('.json'))
          .map((name) => path.join(process.cwd(), name)),
      ];

  for (const candidate of candidates) {
    if (!(await exists(candidate))) continue;
    const parsed = JSON.parse(await fs.readFile(candidate, 'utf8')) as ClientSecretFile;

    // Already finished - nothing to do, and re-running would only replace a
    // working consent with an identical one.
    if (parsed.refresh_token) continue;

    /**
     * A Web application client cannot complete this flow.
     *
     * The loopback redirect lands on a RANDOM free port, and a web client only
     * accepts redirect URIs registered in advance - so Google answers
     * `redirect_uri_mismatch`, which names the port rather than the client type
     * and sends people off registering ports one at a time. A Desktop client
     * accepts any loopback port by design.
     */
    if (parsed.web && !parsed.installed) {
      throw new Error(
        `${candidate} is a WEB APPLICATION OAuth client, and this flow needs a DESKTOP one.\n\n` +
          'The sign-in redirect comes back to a random port on 127.0.0.1. A web client only\n' +
          'accepts redirect URIs registered beforehand, so Google would refuse with\n' +
          '"redirect_uri_mismatch"; a desktop client accepts any loopback port.\n\n' +
          'In https://console.cloud.google.com/apis/credentials:\n' +
          '  CREATE CREDENTIALS -> OAuth client ID -> Application type: Desktop app\n' +
          'Download that one and put it in backend/. You can delete the web client.\n'
      );
    }

    const block = parsed.installed ?? parsed.web ?? parsed;
    const clientId = block.client_id?.trim();
    const clientSecret = block.client_secret?.trim();
    if (clientId && clientSecret) return { clientId, clientSecret, from: candidate };
  }

  throw new Error(
    'No OAuth client file found.\n\n' +
      'Make one in the Google Cloud console:\n' +
      '  1. APIs & Services -> OAuth consent screen. Choose External, fill in the app name and\n' +
      '     your own email, and add your own address under Test users.\n' +
      '  2. APIs & Services -> Credentials -> CREATE CREDENTIALS -> OAuth client ID.\n' +
      '     Application type: Desktop app. Create, then DOWNLOAD JSON.\n' +
      '  3. Put that file in backend/ (any name starting with client_secret is found\n' +
      '     automatically), or pass it: npm run sheets:login -- --client path\\to\\file.json\n'
  );
}

/** One request, one answer, then the server goes away. */
function waitForRedirect(server: http.Server, state: string): Promise<string> {
  return new Promise((resolve, reject) => {
    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      const say = (message: string) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          `<!doctype html><meta charset="utf-8"><title>Free Tailor</title>` +
            `<body style="font-family:system-ui;padding:3rem;max-width:32rem">` +
            `<h1 style="font-size:1.25rem">${message}</h1>` +
            `<p>You can close this tab and go back to the terminal.</p></body>`
        );
      };

      // Checked because the redirect arrives from a browser, and a browser will
      // follow any link somebody sends it.
      if (url.searchParams.get('state') !== state) {
        say('That sign-in did not match this request.');
        reject(new Error('The redirect carried the wrong state. Start again.'));
        return;
      }
      if (error) {
        say(`Google refused: ${error}`);
        reject(new Error(`Google refused the consent: ${error}`));
        return;
      }
      if (!code) {
        say('No authorization code came back.');
        reject(new Error('The redirect carried no authorization code.'));
        return;
      }

      say('Signed in. Free Tailor can now use your Google Sheets.');
      resolve(code);
    });
  });
}

async function main(): Promise<void> {
  const { clientId, clientSecret, from } = await loadClient();
  console.log(`Using OAuth client from ${from}\n`);

  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const redirectUri = `http://127.0.0.1:${port}`;
  const state = crypto.randomBytes(16).toString('hex');

  const authUrl =
    `${AUTH_ENDPOINT}?` +
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: `${SHEETS_SCOPE} ${DRIVE_SCOPE}`,
      // Both are required to be GIVEN a refresh token rather than just an
      // access token: offline asks for one, and consent forces the prompt even
      // if this client was approved before - without it a second run returns
      // nothing to save.
      access_type: 'offline',
      prompt: 'consent',
      state,
    }).toString();

  console.log('Open this in a browser and approve BOTH Sheets and Drive:\n');
  console.log(`  ${authUrl}\n`);
  console.log('Waiting for the redirect...');

  let code: string;
  try {
    code = await waitForRedirect(server, state);
  } finally {
    server.close();
  }

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
  });

  const token = (await response.json()) as {
    refresh_token?: string;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !token.refresh_token) {
    throw new Error(
      `Google did not return a refresh token: ${token.error ?? response.status} ` +
        `${token.error_description ?? ''}`.trim() +
        '\n\nIf the consent screen appeared and you approved it, the usual cause is that this ' +
        'client was already approved and Google reused the grant. Revoke it at ' +
        'https://myaccount.google.com/permissions and run this again.'
    );
  }

  const outputPath = path.join(process.cwd(), OUTPUT_FILE);
  await fs.writeFile(
    outputPath,
    `${JSON.stringify(
      {
        type: 'authorized_user',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: token.refresh_token,
      },
      null,
      2
    )}\n`,
    // Owner-only: this file lets anything that reads it act as you on Sheets
    // and Drive until the grant is revoked.
    { mode: 0o600 }
  );

  console.log(`\nSaved ${outputPath}`);
  console.log('Sheets will now be created in your own Google Drive.\n');
  console.log('Check it with:  npm run sheets:doctor');
}

void main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
