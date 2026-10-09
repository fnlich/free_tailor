const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const { loadFresh, useTempStorage } = require('./helpers');

/**
 * The account tier was called a plan, and is a subscription everywhere now:
 * the column, the API, the pages. A database this build creates has
 * `users.subscription` and no `plan` (an older one renamed in place is the
 * startup guard's to check, test/upgradeGuard.test.js); and no frontend code
 * or copy still calls the tier a plan.
 */

function columnsOf(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all();
}

test('a fresh database is created with the new name', () => {
  useTempStorage('subscription-rename-fresh');
  const db = loadFresh('../dist/database/sqlite').getDb();
  const names = columnsOf(db, 'users').map((column) => column.name);
  assert.ok(names.includes('subscription'));
  assert.ok(!names.includes('plan'));
});

// -- the frontend --------------------------------------------------------- //

const FRONTEND_SRC = path.join(__dirname, '..', '..', 'frontend', 'src');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

/**
 * Loads a frontend module, resolving its `@/` imports to other frontend
 * modules and refusing anything else - the frontendHelpers.test.js loader, made
 * to follow `@/` so navModel (which imports the tier order) can be loaded.
 */
function loadFrontend(relative, seen = new Map()) {
  const file = path.join(FRONTEND_SRC, relative);
  if (seen.has(file)) return seen.get(file).exports;
  const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: file,
  });
  const module = { exports: {} };
  seen.set(file, module);
  const requireFrontend = (specifier) => {
    if (!specifier.startsWith('@/')) throw new Error(`${relative} imports ${specifier} at runtime`);
    const base = specifier.slice(2);
    const candidate = ['.ts', '.tsx'].map((ext) => `${base}${ext}`).find((name) => fs.existsSync(path.join(FRONTEND_SRC, name)));
    if (!candidate) throw new Error(`${relative}: cannot resolve ${specifier}`);
    return loadFrontend(candidate, seen);
  };
  new Function('module', 'exports', 'require', outputText)(module, module.exports, requireFrontend);
  return module.exports;
}

/** Strips comments, so a comment about the history of a name is not a hit. */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ''))
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

test('Settings > Subscription is a tab', () => {
  const nav = loadFrontend('components/shell/navModel.ts');
  assert.deepEqual(
    nav.SETTINGS_ACCOUNT_TABS.find((tab) => tab.href === '/settings/subscription'),
    { href: '/settings/subscription', label: 'Subscription' }
  );
  assert.equal(nav.SETTINGS_ITEMS.some((tab) => tab.href === '/settings/plan'), false);
  // And no page answers at the old address: it was a redirect while the name
  // was new, and every link to it is gone.
  assert.equal(fs.existsSync(path.join(FRONTEND_SRC, 'app/settings/plan')), false);
  // Longest match: the subscription page lights its own tab, not Profile.
  assert.equal(nav.activeHref('/settings/subscription', nav.SETTINGS_ACCOUNT_TABS), '/settings/subscription');
  assert.equal(nav.isSettingsRoute('/settings/subscription'), true);

  // An entry a tier includes is shown from that tier up, to any builder on it
  // (the role half is test/frontendRoles.test.js's).
  const premiumOnly = { href: '/x', label: 'X', icon: 'build', needs: 'premium' };
  assert.equal(nav.canSee(premiumOnly, 'user', 'default'), false);
  assert.equal(nav.canSee(premiumOnly, 'user', 'premium-plus'), true);
  assert.equal(nav.canSee(premiumOnly, 'user', 'premium-ultra'), false, 'an unknown tier ranks lowest');

  assert.ok(fs.existsSync(path.join(FRONTEND_SRC, 'app/settings/subscription/page.tsx')));
});

/**
 * Words ("Plan", "plans", "/settings/plan"), and the name at either end of an
 * identifier (planLabel, invitePlan, RequiresPlan, PlanPill, PlanId,
 * PLAN_ORDER) - the rename covered the code as well as the copy. A word that
 * only begins with the letters (Planner, activePlanner) is not the tier.
 */
const TIER_PLAN = [/\bplans?\b/i, /[a-z]Plans?(?![a-z])/, /\b[pP]lans?[A-Z0-9_]/, /\bPLANS?_|_PLANS?\b/];
const namesTierPlan = (line) => TIER_PLAN.some((pattern) => pattern.test(line));

test('the plan guard catches the name in every identifier position, and nothing that merely starts with it', () => {
  // Pinned on its own because a guard that misses a shape passes silently: a
  // later <PlanPill> would have gone through before the leading-capital case
  // was added.
  for (const line of [
    'Plan',
    'your plans',
    "href: '/settings/plan'",
    'planLabel',
    'const invitePlan = 1;',
    'function RequiresPlan() {}',
    '<PlanPill tone="sky" />',
    'const PlanBadge = 1;',
    'type PlanId = string;',
    'export default function PlanSettingsPage() {',
    'PLAN_ORDER',
    'ACCOUNT_PLANS',
  ]) {
    assert.equal(namesTierPlan(line), true, `not caught: ${line}`);
  }
  for (const line of ['activePlanner', 'Planner', '<PlannerView />', 'plannerSubCalendarCount', 'explanation', 'airplane']) {
    assert.equal(namesTierPlan(line), false, `wrongly caught: ${line}`);
  }
});

test('no frontend code or copy still calls the account tier a plan', () => {
  const hits = [];
  for (const file of walk(FRONTEND_SRC)) {
    if (!/\.(tsx?|jsx?|css)$/.test(file)) continue;
    const relative = path.relative(FRONTEND_SRC, file);
    codeOnly(fs.readFileSync(file, 'utf8'))
      .split('\n')
      .forEach((line, index) => {
        if (namesTierPlan(line)) hits.push(`${relative}:${index + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(hits, []);

  const pathsNamedPlan = walk(FRONTEND_SRC)
    .map((file) => path.relative(FRONTEND_SRC, file).split(path.sep).join('/'))
    .filter((relative) => /(^|\/)plans?(\.|\/|$)/i.test(relative));
  assert.deepEqual(pathsNamedPlan, []);
});
