const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

/**
 * Every seat is locked for this file, before any dist module loads: if the
 * preview asked a model anything, it would fail with AiUnavailableError rather
 * than answer. A 200 here is therefore also proof that no model was asked.
 */
process.env.AI_LOCKED_PROVIDERS = 'claude-cli,codex-cli,gemini-cli';

const { captureErrorLog, useAdminEmails, useTempStorage } = require('./helpers');

/**
 * POST /api/profiles/preview - the profile editor's live resume.
 *
 *   - the draft is rendered as it would print, through the same pipeline and
 *     template choice as a generated resume, untailored;
 *   - nothing is written, no plan limit is consulted, no model is asked and no
 *     credit moves;
 *   - another account's profile and a disabled template are 404s;
 *   - whatever is half-typed renders rather than failing, and nothing typed
 *     can run in the document (escaping, the link allow-list, the CSP).
 */

const SHIPPED = path.join(__dirname, '..', 'static');

/** The templates and the skill library a render needs, in the temp static dir. */
function seedStatic(staticDir) {
  fs.cpSync(path.join(SHIPPED, 'templates'), path.join(staticDir, 'templates'), { recursive: true });
  fs.cpSync(path.join(SHIPPED, 'skills'), path.join(staticDir, 'skills'), { recursive: true });
}

function draft(extra = {}) {
  return {
    name: 'Ada Lovelace',
    title: 'Analyst',
    contact: { email: 'ada@example.com', phone: '555', location: 'London', linkedin: 'linkedin.com/in/ada' },
    summary: 'Writes the first program.',
    experience: [
      {
        title: 'Analyst',
        company: 'Analytical Engines Ltd',
        startDate: '1842',
        endDate: '1843',
        location: 'London',
        description: 'Translated and annotated.',
        achievements: ['Note G'],
        skills: [],
      },
    ],
    strengths: [{ title: 'Foresight', description: 'Saw general-purpose computing coming.' }],
    softSkills: ['Persistence', 'Clear writing'],
    skills: ['Python', 'C#', 'TypeScript', 'PostgreSQL', 'Docker'],
    education: [],
    ...extra,
  };
}

async function serve(name) {
  const { staticDir } = useTempStorage(`profile-preview-${name}`);
  seedStatic(staticDir);
  useAdminEmails('admin@example.com');

  const users = require('../dist/database/userRepository');
  const admin = users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  const bob = users.createUser({ email: 'bob@example.com' });
  const tokens = {
    admin: users.createSession(admin.id),
    alice: users.createSession(alice.id),
    bob: users.createSession(bob.id),
  };

  const { saveProfile } = require('../dist/database/profileRepository');
  const { buildNewProfile } = require('../dist/services/profileService');
  saveProfile({
    ...buildNewProfile(
      draft({
        name: 'Stored Ada',
        summary: 'The stored summary.',
        certifications: [{ name: 'Stored Certificate', issuer: 'Royal Society', date: '1843' }],
      }),
      'p-alice'
    ),
    ownerId: alice.id,
  });

  const { attachUser } = require('../dist/middleware/auth');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(attachUser);
  app.use('/api/profiles', require('../dist/routes/profiles').default);
  const server = app.listen(0);
  const port = server.address().port;

  const call = async (who, body) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/profiles/preview`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(who ? { authorization: `Bearer ${tokens[who]}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: response.status, body: parsed };
  };
  return { call, close: () => server.close(), users, admin, alice, bob };
}

/** The rendered resume without the stylesheets, so a class name in CSS is not mistaken for content. */
function bodyOf(html) {
  return html.slice(html.lastIndexOf('</style>', html.indexOf('<style id="resume-preview-page">')));
}

test('a draft for a new profile renders, and nothing is written, charged or asked', async () => {
  const server = await serve('side-effects');
  try {
    const { listAllProfilesUnscoped } = require('../dist/database/profileRepository');
    const { getLedger } = require('../dist/services/credits');
    const profilesBefore = listAllProfilesUnscoped({ includeDisabled: true }).length;
    const creditsBefore = server.users.getUserById(server.alice.id).credits;
    const ledgerBefore = getLedger(server.alice.id).length;

    // Alice is on the default plan, whose one profile she already has: a SAVE
    // of this draft would be refused. A preview adds nothing, so it is not.
    const response = await server.call('alice', { profile: draft() });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(Object.keys(response.body).sort(), ['html', 'page', 'templateId']);
    assert.equal(response.body.templateId, 'default');
    assert.deepEqual(response.body.page, { widthPx: 794, heightPx: 1123, contentHeightPx: 1065 });
    assert.ok(response.body.html.includes('Ada Lovelace'));
    assert.ok(response.body.html.includes('Analytical Engines Ltd'));

    assert.equal(listAllProfilesUnscoped({ includeDisabled: true }).length, profilesBefore, 'no profile row written');
    assert.equal(server.users.getUserById(server.alice.id).credits, creditsBefore, 'no credit moved');
    assert.equal(getLedger(server.alice.id).length, ledgerBefore, 'no ledger entry');
  } finally {
    server.close();
  }
});

test("the draft is laid over the caller's stored profile, and somebody else's is a 404", async () => {
  const server = await serve('scoping');
  try {
    // The draft omits the summary and never carries certifications - the form
    // does not edit them - so both come from the stored profile.
    const { summary, ...withoutSummary } = draft({ name: 'Draft Ada' });
    void summary;
    const own = await server.call('alice', { profileId: 'p-alice', profile: withoutSummary });
    assert.equal(own.status, 200);
    const html = own.body.html;
    assert.ok(html.includes('Draft Ada'), 'the draft wins where it speaks');
    assert.ok(html.includes('The stored summary.'), 'the stored profile fills what the draft omits');
    assert.equal(html.includes('Stored Ada'), false);

    const stranger = await server.call('bob', { profileId: 'p-alice', profile: draft() });
    assert.equal(stranger.status, 404);
    assert.deepEqual(stranger.body, { error: 'Profile not found' });

    const missing = await server.call('alice', { profileId: 'no-such-profile', profile: draft() });
    assert.equal(missing.status, 404);
  } finally {
    server.close();
  }
});

test('signed out, the preview is a 401', async () => {
  const server = await serve('signed-out');
  try {
    assert.equal((await server.call(null, { profile: draft() })).status, 401);
  } finally {
    server.close();
  }
});

test('whatever is half-typed renders instead of failing', async () => {
  const server = await serve('lenient');
  try {
    const cases = [
      // A file-name token the save would refuse, half-typed and misspelt.
      { profileSettings: { resumeFileNameTemplate: '{{bogus}}', companyFolderNameTemplate: '{{profile na' } },
      // A model the account could not pick: the save checks it, the preview never looks.
      { profileSettings: { ai: { modelId: 'no-such-model' } } },
      // Fields of the wrong shape, as a client mid-edit might send them.
      { experience: 'not a list', strengths: [null, 7, { title: 'Kept' }], education: {}, contact: 'x' },
      { skills: 42, skillCategories: 'nope', softSkills: 'Grit' },
      { name: 12, title: null, totalYearsExperience: 'many' },
    ];
    for (const extra of cases) {
      const response = await server.call('alice', { profile: draft(extra) });
      assert.equal(response.status, 200, `${JSON.stringify(extra)} -> ${JSON.stringify(response.body)}`);
    }
    for (const profile of [undefined, null, 'a string', [1, 2]]) {
      const response = await server.call('alice', { profile });
      assert.equal(response.status, 200, `profile ${JSON.stringify(profile)}`);
    }
  } finally {
    server.close();
  }
});

test('nothing typed can run in the preview', async () => {
  const server = await serve('escaping');
  try {
    const response = await server.call('alice', {
      profile: draft({
        name: 'Ada <script>alert(1)</script>',
        summary: '<img src=x onerror=alert(2)>',
        contact: { email: 'a@b.c', phone: '1', location: 'X', linkedin: 'javascript:alert(3)' },
      }),
    });
    assert.equal(response.status, 200);
    const html = response.body.html;
    assert.equal(html.includes('<script>alert(1)'), false, 'markup in a field is escaped');
    assert.ok(html.includes('&lt;script&gt;'));
    assert.equal(html.includes('<img src=x'), false);
    assert.equal(/javascript:/i.test(html), false, 'a javascript: link never reaches an href');

    // The policy travels with the document, ahead of anything that could
    // fetch, but behind the doctype - which stays first, so the preview lays
    // out in the same mode as the PDF. The page chrome is still appended last
    // so it wins ties.
    assert.match(
      html,
      /^<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">/i
    );
    assert.match(html, /<style id="resume-preview-page">[\s\S]*?<\/style>$/);

    // A template with a separate stylesheet has it prepended before its own
    // doctype; the policy goes in front of that too.
    const separate = await server.call('alice', {
      profile: draft(),
      templateId: 'burgundy-rule',
    });
    assert.equal(separate.body.templateId, 'burgundy-rule');
    assert.match(separate.body.html, /^<meta http-equiv="Content-Security-Policy"[^>]*><style>/);
  } finally {
    server.close();
  }
});

test('the layout and both switches reach the preview', async () => {
  const server = await serve('choices');
  try {
    const render = async (profileSettings, templateId = 'classic-serif') => {
      const response = await server.call('alice', { profile: draft({ profileSettings }), templateId });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.templateId, templateId);
      return bodyOf(response.body.html);
    };

    const flat = await render({ technicalSkillsLayout: 'flat' });
    for (const skill of ['Python', 'C#', 'TypeScript', 'PostgreSQL', 'Docker']) {
      assert.match(flat, new RegExp(`<li[^>]*>${skill.replace('#', '\\#')}</li>`), `flat draws ${skill} as its own item`);
    }
    assert.doesNotMatch(flat, />\s*Languages\s*</, 'flat has no headings');

    const grouped = await render({ technicalSkillsLayout: 'categorized' });
    assert.match(grouped, />\s*Languages\s*</, 'grouped has headings');
    // Only the skills entered: the generated resume pads a short list from the
    // library, and the live preview must not show skills nobody typed.
    for (const padded of ['Kubernetes', 'Django', 'Jenkins', 'Terraform']) {
      assert.equal(grouped.includes(padded), false, `${padded} was never entered`);
    }

    const off = await render({});
    assert.equal(off.includes('Persistence'), false, 'soft skills off by default');
    assert.equal(off.includes('Foresight'), false, 'strengths off by default');
    assert.equal(off.includes('Soft Skills'), false);

    const on = await render({ includeSoftSkills: true, includeStrengths: true });
    assert.ok(on.includes('Persistence') && on.includes('Clear writing'), 'soft skills shown when switched on');
    assert.ok(on.includes('Foresight'), 'strengths shown when switched on');
  } finally {
    server.close();
  }
});

test('the template is the requested one, else the draft\'s own, else default - and fits the layout', async () => {
  const server = await serve('template-choice');
  try {
    const own = await server.call('alice', { profile: draft({ preferredTemplate: 'ink-ledger' }) });
    assert.equal(own.body.templateId, 'ink-ledger');

    const requested = await server.call('alice', {
      profile: draft({ preferredTemplate: 'ink-ledger' }),
      templateId: 'developer-mono',
    });
    assert.equal(requested.body.templateId, 'developer-mono');

    // Burgundy Rule is offered for the grouped layout only. A plain draft
    // naming it is drawn the way generation would draw it - with the default -
    // and the response says so instead of rendering a squeezed grid.
    const mismatch = await server.call('alice', {
      profile: draft({ profileSettings: { technicalSkillsLayout: 'flat' } }),
      templateId: 'burgundy-rule',
    });
    assert.equal(mismatch.status, 200);
    assert.equal(mismatch.body.templateId, 'default');

    const unknownOwn = await server.call('alice', { profile: draft({ preferredTemplate: 'deleted-template' }) });
    assert.equal(unknownOwn.body.templateId, 'default', "a draft naming a template that is gone falls back");

    const unknownRequested = await server.call('alice', { profile: draft(), templateId: 'no-such-template' });
    assert.equal(unknownRequested.status, 404);
    assert.deepEqual(unknownRequested.body, { error: 'Template not found' });
  } finally {
    server.close();
  }
});

test('a disabled template is a 404 for a user and renders for an administrator', async () => {
  const server = await serve('disabled');
  try {
    const { updateTemplate } = require('../dist/extractors/templateExtractor');
    await updateTemplate('developer-mono', { disabled: true });

    const user = await server.call('alice', { profile: draft(), templateId: 'developer-mono' });
    assert.equal(user.status, 404);

    const admin = await server.call('admin', { profile: draft(), templateId: 'developer-mono' });
    assert.equal(admin.status, 200);
    assert.equal(admin.body.templateId, 'developer-mono');

    // Not requested but the draft's own: skipped quietly, as generation skips it.
    const preferred = await server.call('alice', { profile: draft({ preferredTemplate: 'developer-mono' }) });
    assert.equal(preferred.status, 200);
    assert.equal(preferred.body.templateId, 'default');
  } finally {
    server.close();
  }
});

test('with no template enabled at all the preview says whom to ask, with a ref', async () => {
  const server = await serve('no-template');
  try {
    const dir = path.join(process.env.TAILOR_STATIC_DIR, 'templates');
    for (const file of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, file));
    const { result: response, lines } = await captureErrorLog(() => server.call('alice', { profile: draft() }));
    assert.equal(response.status, 503);
    assert.equal(response.body.error, 'No resume template is available right now. Please contact your administrator.');
    assert.match(response.body.ref, /^ERR-[0-9A-F]{6}$/);
    assert.equal('detail' in response.body, false, 'the cause is for an administrator');
    assert.ok(lines.some((line) => line.includes(`[error ${response.body.ref}]`)), 'and is logged under the ref');
  } finally {
    server.close();
  }
});
