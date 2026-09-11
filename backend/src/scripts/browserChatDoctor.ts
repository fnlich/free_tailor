import '../config/env';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { getBrowserChatEndpoints, getBrowserChatEnvDefaults } from '../config/aiModelConfig';
import { getDatabasePath } from '../database/sqlite';
import fs from 'fs';
import { probeDebugBrowser } from '../services/debugBrowser';
import { wrapPuppeteerPage } from '../services/ai/providers/browserChat/page';
import { ChatTab } from '../services/ai/providers/browserChat/tab';
import {
  isChatSiteId,
  readChatSite,
  type ChatSite,
  type ChatSiteId,
} from '../services/ai/providers/browserChat/sites';
import { matchesSite } from '../services/ai/providers/browserChat/conversation';

/**
 * What the chat pages actually offer, read off the operator's own tabs.
 *
 * THE PROBLEM THIS SOLVES. claude.ai and chatgpt.com publish no markup
 * contract, and both rename the attributes this driver depends on. When one
 * does, every turn fails - and it fails from inside a backend, against a page
 * nobody can see, with a message that can only guess which of five selector
 * roles went stale. The person who CAN see the page is the operator, and until
 * now they had no way to ask it anything.
 *
 * So this attaches to the browser they already started and signed in to, and
 * for each role reports which candidate matched and how many nodes it found -
 * then, with --send, drives one real round trip and says which STEP failed.
 * The output is meant to be pasted into a bug report and to name the exact
 * AI_WEB_* override that fixes it.
 *
 * It writes nothing and sends nothing unless --send is given, and even then it
 * asks a throwaway question rather than anything from this app.
 *
 *   npm run browser:doctor
 *   npm run browser:doctor -- --site claude-web
 *   npm run browser:doctor -- --send
 */

const ROLES = ['composer', 'send', 'busy', 'assistant', 'newChat'] as const;
type Role = (typeof ROLES)[number];

const ENV_VAR: Record<Role, string> = {
  composer: 'COMPOSER',
  send: 'SEND',
  busy: 'BUSY',
  assistant: 'ASSISTANT',
  newChat: 'NEW_CHAT',
};

/**
 * The only role that must be visible on an IDLE page.
 *
 * `assistant` and `busy` cannot be: one matches a reply and the other matches a
 * reply in flight, and a fresh conversation has neither. Reporting those as
 * broken at rest would send the operator to fix selectors that are fine - which
 * is the exact failure mode this tool exists to end. They are checked by
 * `--send`, where a real answer either comes back or does not.
 */
const REQUIRED_AT_REST: ReadonlySet<Role> = new Set<Role>(['composer']);

/** Roles only a live turn can prove. Their absence at rest means nothing. */
const ONLY_VISIBLE_DURING_A_TURN: ReadonlySet<Role> = new Set<Role>(['assistant', 'busy']);

type RoleReport = {
  role: Role;
  matched: string | null;
  count: number;
  actionable: boolean | null;
  tried: string[];
};

function flag(name: string): string | undefined {
  const args = process.argv.slice(2);
  const equals = args.find((token) => token.startsWith(`--${name}=`));
  if (equals) return equals.slice(name.length + 3) || undefined;
  const index = args.indexOf(`--${name}`);
  if (index !== -1 && args[index + 1] && !args[index + 1].startsWith('--')) return args[index + 1];
  return undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).some((token) => token === `--${name}` || token.startsWith(`--${name}=`));
}

function envVarFor(site: ChatSiteId, role: Role): string {
  return `${site === 'claude-web' ? 'AI_WEB_CLAUDE' : 'AI_WEB_CHATGPT'}_${ENV_VAR[role]}`;
}

async function readRegistered(): Promise<Array<{ siteId: ChatSiteId; port: number }>> {
  if (!fs.existsSync(getDatabasePath())) return getBrowserChatEnvDefaults();
  try {
    return await getBrowserChatEndpoints();
  } catch {
    return getBrowserChatEnvDefaults();
  }
}

/** Every candidate for one role, measured against the live page. */
async function inspectRole(page: Page, site: ChatSite, role: Role): Promise<RoleReport> {
  const candidates = site[role];
  const chat = wrapPuppeteerPage(page);
  for (const candidate of candidates) {
    const count = await chat.count(candidate);
    if (count > 0) {
      // Only meaningful for something you click; a transcript node is not one.
      const actionable =
        role === 'send' || role === 'newChat' ? await chat.isActionable(candidate) : null;
      return { role, matched: candidate, count, actionable, tried: candidates };
    }
  }
  return { role, matched: null, count: 0, actionable: null, tried: candidates };
}

function describeRole(site: ChatSiteId, report: RoleReport): string[] {
  const lines: string[] = [];
  const name = report.role.padEnd(10);

  if (!report.matched) {
    if (ONLY_VISIBLE_DURING_A_TURN.has(report.role)) {
      lines.push(`  --      ${name} not on the page yet - only exists during a reply. Use --send to check.`);
      return lines;
    }
    const severity = REQUIRED_AT_REST.has(report.role) ? 'BROKEN ' : 'missing';
    lines.push(`  ${severity} ${name} nothing matched`);
    for (const candidate of report.tried) lines.push(`            tried: ${candidate}`);
    lines.push(`            fix:   set ${envVarFor(site, report.role)} in .env (candidates separated by |)`);
    return lines;
  }

  // A send control present but not clickable is the failure that used to look
  // like "no reply": the click lands on nothing and the turn waits out its
  // deadline. Worth saying plainly even though it is often only a timing state.
  const note =
    report.actionable === false
      ? '  <- matched but NOT clickable right now (disabled/hidden)'
      : '';
  lines.push(`  ok      ${name} ${report.matched}  (${report.count} node${report.count === 1 ? '' : 's'})${note}`);
  return lines;
}

async function findTab(browser: Browser, site: ChatSite): Promise<Page | null> {
  const open = await browser.pages();
  return open.find((page) => matchesSite(page.url(), site)) ?? null;
}

async function inspectSite(
  browser: Browser,
  site: ChatSite,
  port: number,
  wantSend: boolean
): Promise<boolean> {
  console.log('');
  console.log(`${site.label}  (${site.id}, port ${port})`);

  const page = await findTab(browser, site);
  if (!page) {
    console.log(`  BROKEN  no tab on ${site.host} in this browser.`);
    console.log(`          Open ${site.url} in it and sign in, then run this again.`);
    return false;
  }

  console.log(`  tab     ${page.url()}`);

  const reports: RoleReport[] = [];
  for (const role of ROLES) reports.push(await inspectRole(page, site, role));
  for (const report of reports) for (const line of describeRole(site.id, report)) console.log(line);

  const brokenRoles = reports.filter((entry) => !entry.matched && REQUIRED_AT_REST.has(entry.role));
  if (brokenRoles.length > 0) {
    console.log('  => this site cannot run a turn until the roles above are fixed.');
    console.log('  => no composer usually means the tab is signed out. Sign in and run this again.');
    return false;
  }

  // A composer on the page is not a signed-in composer. The site renders a
  // sign-in wall with no message box at all, so "composer ok" is already
  // decent evidence - but say what was found either way.
  if (!wantSend) {
    console.log('  => looks usable at rest. Add --send to prove it end to end - that is the');
    console.log('     only way to check the assistant and busy roles, and the send control.');
    return true;
  }

  console.log('  --send  asking the tab a throwaway question...');
  const started = Date.now();
  try {
    const tab = new ChatTab(wrapPuppeteerPage(page), site, {});
    const answer = await tab.ask('Reply with exactly: DOCTOR-OK', 90_000);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`  ok      round trip in ${seconds}s`);
    console.log(`          answered: ${JSON.stringify(answer.slice(0, 120))}`);
    return true;
  } catch (error) {
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`  BROKEN  the round trip failed after ${seconds}s`);
    console.log(`          ${error instanceof Error ? error.message : String(error)}`);
    console.log('          The overrides for this site, if the message names a selector role:');
    for (const role of ROLES) console.log(`            ${envVarFor(site.id, role)}`);
    return false;
  }
}

async function main(): Promise<number> {
  if (hasFlag('help') || hasFlag('h')) {
    console.log(
      [
        'Report what the chat pages in your debug browser actually offer.',
        '',
        '  npm run browser:doctor                      every registered browser',
        '  npm run browser:doctor -- --site claude-web only this site',
        '  npm run browser:doctor -- --send            also drive one real round trip',
        '',
        'Reads the page only, unless --send is given. Start the browsers first with',
        '`npm run browser:debug` and sign in to each tab.',
      ].join('\n')
    );
    return 0;
  }

  const only = flag('site');
  if (only && !isChatSiteId(only)) {
    console.error(`[doctor] "${only}" is not a chat site. Choose claude-web or chatgpt-web.`);
    return 1;
  }

  const wantSend = hasFlag('send');
  const registered = (await readRegistered()).filter((entry) => !only || entry.siteId === only);

  if (registered.length === 0) {
    console.error('[doctor] No browsers are registered for that site.');
    console.error('[doctor] Register one under Admin -> Settings -> Browser Chat (free).');
    return 1;
  }

  const override = (process.env.AI_WEB_CDP_URL ?? '').trim();
  if (override) {
    console.log(`[doctor] NOTE: AI_WEB_CDP_URL=${override} overrides the registered list for the`);
    console.log('[doctor] providers, so what they use may not be what is checked below.');
  }

  let healthy = 0;
  for (const entry of registered) {
    const site = readChatSite(entry.siteId);
    const status = await probeDebugBrowser(entry.port);
    if (!status.running) {
      console.log('');
      console.log(`${site.label}  (${site.id}, port ${entry.port})`);
      console.log('  BROKEN  nothing is listening on that port.');
      console.log('          Start it: npm run browser:debug');
      continue;
    }

    let browser: Browser | null = null;
    try {
      browser = await puppeteer.connect({
        browserURL: `http://127.0.0.1:${entry.port}`,
        defaultViewport: null,
        protocolTimeout: 120_000,
      });
      if (await inspectSite(browser, site, entry.port, wantSend)) healthy += 1;
    } catch (error) {
      console.log('');
      console.log(`${site.label}  (${site.id}, port ${entry.port})`);
      console.log(`  BROKEN  could not attach: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      // Disconnect, never close: this is the operator's browser and their
      // sign-in. Closing it would be a very rude diagnostic.
      if (browser) await browser.disconnect().catch(() => undefined);
    }
  }

  console.log('');
  console.log(`[doctor] ${healthy} of ${registered.length} checked browser(s) look usable.`);
  if (healthy < registered.length) {
    console.log('[doctor] Every BROKEN line above names what to fix. Selector overrides go in .env');
    console.log('[doctor] and take effect on a backend restart - no rebuild needed.');
  }
  return healthy === registered.length ? 0 : 1;
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`[doctor] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
