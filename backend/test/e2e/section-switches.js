/*
 * The profile editor's preview with Strengths and Soft Skills switched off:
 * does each section go WHOLE - its heading with its list - and does nothing
 * else go with it?
 *
 * test/sectionHeadings.test.js proves the renderer on markup strings. This
 * proves the page: the real editor, its switches, the preview route and the
 * frame the person looks at. It saves two uploaded-style templates (no
 * section-strengths class, no data-section - only headings and loops, the
 * way an uploaded template is written) beside one built-in:
 *
 *   - a CSS-grid sidebar holding a photo, the Strengths section and a static
 *     "References / Available upon request" block, and Soft Skills in the
 *     main column under a divider (`<h2>Soft Skills</h2><hr><ul>...`). Before
 *     the fix the photo, References and the whole sidebar went with Strengths
 *     switched off - every profile's default - and the Soft Skills heading
 *     stayed;
 *   - two columns: a bold "Strengths" label and a line break before its loop
 *     in a column holding the summary and a static line, and Soft Skills
 *     printed by the `join` helper with no loop at all.
 *
 * For each template it opens the editor with both switches on, then unticks
 * Strengths, then Soft Skills, then ticks Strengths back, then Soft Skills,
 * and after every click waits for the frame to show the expected state:
 * the heading and items there or gone, and Experience, Technical Skills and
 * everything static beside the sections always there. A state the frame
 * never reaches fails with the text it last showed.
 *
 * Not part of `npm test`: it needs both servers up, as shell.js does, and
 * DB_DIR naming the backend's database, because the session is seeded
 * straight into it. The templates are saved through the admin API, so they
 * land in the backend's own templates directory, and removed again at the
 * end with the profile.
 *
 * Usage:
 *   DB_DIR=/path/to/db node test/e2e/section-switches.js
 *
 * Settings, all optional:
 *   E2E_APP    the frontend (default http://127.0.0.1:3000)
 *   E2E_API    the backend's /api (default http://127.0.0.1:3001/api)
 *   E2E_DIST   the compiled backend to seed the session with (default ../../dist)
 *   E2E_EMAIL  the administrator to sign in as (default sections.probe@example.com,
 *              created and made an administrator when missing)
 *   E2E_SHOTS  a directory to save a screenshot of every state into
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const DIST = process.env.E2E_DIST || path.join(__dirname, '..', '..', 'dist');
require(path.join(DIST, 'config', 'env'));
const users = require(path.join(DIST, 'database', 'userRepository'));

const APP = process.env.E2E_APP || 'http://127.0.0.1:3000';
const API = process.env.E2E_API || 'http://127.0.0.1:3001/api';
const EMAIL = process.env.E2E_EMAIL || 'sections.probe@example.com';
const SHOTS = process.env.E2E_SHOTS || '';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PHOTO = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACwAAAAAAQABAAACAkQBADs=';

/** Uploaded-style templates: what each must keep in EVERY state, read off the frame. */
const UPLOADED = [
  {
    name: 'E2E Photo Sidebar',
    htmlContent:
      '<div class="row" style="display:grid;grid-template-columns:200px 1fr;gap:16px">' +
      '<aside class="side" style="background:#eef">' +
      `<img class="photo" src="${PHOTO}" alt="photo" width="80" height="80">` +
      '<h3>Strengths</h3><ul>{{#each strengths}}<li>{{title}}</li>{{/each}}</ul>' +
      '<h3>References</h3><p>Available upon request</p></aside>' +
      '<main><h1>{{name}}</h1><h2>Experience</h2>{{#each experience}}<p>{{company}}</p>{{/each}}' +
      '<h2>Soft Skills</h2><hr><ul>{{#each softSkills}}<li>{{this}}</li>{{/each}}</ul>' +
      '<h2>Technical Skills</h2>{{#each skills}}<span>{{this}} </span>{{/each}}</main></div>',
    keepsText: ['References', 'Available upon request'],
    keepsSelectors: ['aside.side', 'img[alt="photo"]', 'main'],
  },
  {
    name: 'E2E Two Columns',
    htmlContent:
      '<div class="cols" style="display:flex;gap:16px"><div class="left" style="width:200px">' +
      '<p>{{summary}}</p><b>Strengths</b><br>{{#each strengths}}<span class="item">{{title}}</span> {{/each}}' +
      '<p>Open to relocation and remote work</p></div>' +
      '<div class="right"><h1>{{name}}</h1><h2>Experience</h2>{{#each experience}}<p>{{company}}</p>{{/each}}' +
      '<section><h3>Soft Skills</h3><p>{{join softSkills ", "}}</p></section>' +
      '<h2>Technical Skills</h2>{{#each skills}}<span>{{this}} </span>{{/each}}</div></div>',
    keepsText: ['Open to relocation and remote work', 'A summary of the work'],
    keepsSelectors: ['div.left', 'div.right'],
  },
];

async function api(token, method, route, body) {
  const response = await fetch(`${API}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${route} answered ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/** Saves a template the way an administrator uploads one (a JSON file), and answers its id. */
async function uploadTemplate(token, template) {
  const form = new FormData();
  const file = JSON.stringify({ name: template.name, description: 'section-switches.js', htmlContent: template.htmlContent, cssContent: '' });
  form.append('template', new Blob([file], { type: 'application/json' }), 'template.json');
  const response = await fetch(`${API}/templates/upload-json`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const body = await response.json().catch(() => ({}));
  if (response.status !== 201 || !body.id) {
    throw new Error(`Uploading "${template.name}" answered ${response.status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body.id;
}

async function signIn(page, token) {
  await page.goto(`${APP}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((value) => {
    window.localStorage.setItem('adminToken', value);
    window.localStorage.setItem('tailor-theme', 'light');
  }, token);
  await page.setCookie({ name: 'ft_session', value: token, domain: new URL(APP).hostname, path: '/', httpOnly: true, sameSite: 'Lax' });
}

/** What the preview pane shows now: its status, the template it names, the front frame's text and which selectors match. */
function readPreview(page, selectors) {
  return page.evaluate((wanted) => {
    const pane = document.querySelector('aside[aria-label="Resume preview"]');
    const frame = pane?.querySelector('iframe[data-front="true"]');
    const doc = frame?.contentDocument;
    return {
      status: pane?.querySelector('[role="status"]')?.textContent?.trim() ?? '',
      shown: pane?.querySelector('p.truncate')?.textContent?.trim() ?? '',
      text: doc?.body?.innerText ?? '',
      present: Object.fromEntries(wanted.map((selector) => [selector, Boolean(doc?.querySelector(selector))])),
    };
  }, selectors);
}

/** Every way the frame can be wrong for one state, or [] when it is right. */
function problemsWith(preview, expected, template) {
  const problems = [];
  const text = preview.text;
  const heading = (pattern, on, label) => {
    if (pattern.test(text) !== on) problems.push(`${label} ${on ? 'missing' : 'still printed'}`);
  };
  heading(/strengths?/i, expected.strengths, 'the Strengths heading');
  heading(/soft[\s-]*skills?/i, expected.softSkills, 'the Soft Skills heading');
  if (text.includes('Foresight') !== expected.strengths) problems.push(`the strength items ${expected.strengths ? 'missing' : 'still printed'}`);
  if (text.includes('Persistence') !== expected.softSkills) {
    problems.push(`the soft skill items ${expected.softSkills ? 'missing' : 'still printed'}`);
  }
  for (const kept of ['Acme Widgets', 'Docker', ...template.keepsText]) {
    if (!text.includes(kept)) problems.push(`"${kept}" was removed`);
  }
  for (const selector of template.keepsSelectors) {
    if (!preview.present[selector]) problems.push(`${selector} was removed`);
  }
  return problems;
}

/** Waits until the pane is up to date, shows `template`, and its frame is right for `expected`. */
async function waitForState(page, template, expected, label, timeoutMs = 20_000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await readPreview(page, template.keepsSelectors);
    if (last.status === 'Up to date' && last.shown === template.name && problemsWith(last, expected, template).length === 0) {
      if (SHOTS) {
        const pane = await page.$('aside[aria-label="Resume preview"]');
        await (pane ?? page).screenshot({ path: path.join(SHOTS, `${template.id}-${label.replace(/\W+/g, '-')}.png`) });
      }
      return;
    }
    await wait(150);
  }
  const problems = last ? problemsWith(last, expected, template) : ['no preview pane'];
  throw new Error(
    `${template.name}, ${label}: ${problems.join('; ')} (status "${last?.status}", showing "${last?.shown}")\n` +
      `  the frame read: ${JSON.stringify((last?.text ?? '').replace(/\s+/g, ' ').slice(0, 500))}`
  );
}

/** Sets a section switch through the DOM, as a click on its box does. */
async function setSwitch(page, id, on) {
  const changed = await page.evaluate(
    (switchId, wanted) => {
      const box = document.getElementById(switchId);
      if (!box) throw new Error(`#${switchId} is not on the page`);
      if (box.checked === wanted) return false;
      box.click();
      return true;
    },
    id,
    on
  );
  if (changed) await wait(100);
}

async function main() {
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const { account } = users.findOrCreateUser({ email: EMAIL, name: 'Sections Probe' });
  if (account.role !== 'admin') users.updateUser(account.id, { role: 'admin' });
  const token = users.createSession(account.id);

  const saved = [];
  let profileId = '';
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  let failures = 0;
  try {
    for (const template of UPLOADED) {
      template.id = await uploadTemplate(token, template);
      saved.push(template.id);
    }
    // One built-in too, which marks its sections by class.
    const listed = await api(token, 'GET', '/templates');
    const builtIns = (Array.isArray(listed) ? listed : listed.templates || []).filter(
      (entry) => entry.isBuiltIn && entry.supportsStrengths && entry.supportsSoftSkills
    );
    const builtIn = builtIns.find((entry) => entry.id === 'default') ?? builtIns[0];
    if (!builtIn) throw new Error('No built-in template prints both sections.');
    const templates = [...UPLOADED, { id: builtIn.id, name: builtIn.name, keepsText: [], keepsSelectors: [] }];

    const profile = await api(token, 'POST', '/profiles', {
      name: 'Pat Example',
      title: 'Engineer',
      contact: { email: 'pat@example.com', phone: '555 0100', location: 'Remote' },
      summary: 'A summary of the work.',
      experience: [
        {
          title: 'Developer',
          company: 'Acme Widgets',
          startDate: '2020',
          endDate: '2023',
          location: 'Remote',
          description: 'Built the widget pipeline.',
          achievements: ['Shipped it'],
        },
      ],
      strengths: [{ title: 'Foresight', description: 'Sees the failure before it ships.' }],
      softSkills: ['Persistence', 'Clear writing'],
      skills: ['Python', 'Docker'],
      preferredTemplate: UPLOADED[0].id,
      profileSettings: { includeStrengths: true, includeSoftSkills: true },
    });
    profileId = profile.id || profile.profile?.id;
    if (!profileId) throw new Error(`Creating the profile answered ${JSON.stringify(profile).slice(0, 300)}`);

    const page = await browser.newPage();
    // Changing the template or a switch dirties the draft; nothing here leaves the page.
    page.on('dialog', (dialog) => dialog.accept().catch(() => {}));
    await page.setViewport({ width: 1440, height: 1000 });
    await signIn(page, token);
    await page.goto(`${APP}/admin/profiles/${profileId}`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('#profile-template option[value]:not([value=""])', { timeout: 15_000 });

    const STEPS = [
      ['both switched on', { strengths: true, softSkills: true }],
      ['Strengths unticked', { strengths: false, softSkills: true }],
      ['both unticked', { strengths: false, softSkills: false }],
      ['Strengths ticked again', { strengths: true, softSkills: false }],
      ['both ticked again', { strengths: true, softSkills: true }],
    ];
    for (const template of templates) {
      await setSwitch(page, 'profile-include-strengths', true);
      await setSwitch(page, 'profile-include-soft-skills', true);
      await page.select('#profile-template', template.id);
      for (const [label, expected] of STEPS) {
        await setSwitch(page, 'profile-include-strengths', expected.strengths);
        await setSwitch(page, 'profile-include-soft-skills', expected.softSkills);
        try {
          await waitForState(page, template, expected, label);
          console.log(`ok      ${template.name.padEnd(20)} ${label}`);
        } catch (error) {
          failures += 1;
          console.log(`FAILED  ${template.name.padEnd(20)} ${label}\n  ${error.message}`);
        }
      }
    }
  } finally {
    await browser.close();
    if (profileId) await api(token, 'DELETE', `/profiles/${profileId}`).catch((error) => console.warn(error.message));
    for (const id of saved) await api(token, 'DELETE', `/templates/${id}`).catch((error) => console.warn(error.message));
  }

  console.log(failures === 0 ? '\nEvery state matched.' : `\n${failures} state(s) did not match.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
