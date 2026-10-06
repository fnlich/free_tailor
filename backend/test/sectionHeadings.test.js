const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

/*
 * Locked before any dist module loads, as test/profilePreview.test.js does: the
 * preview route answering 200 is then also proof no model was asked.
 */
process.env.AI_LOCKED_PROVIDERS = 'claude-cli,codex-cli,gemini-cli';

const { useAdminEmails, useTempStorage } = require('./helpers');

/**
 * An unticked Strengths or Soft Skills section leaves NOTHING behind - not the
 * list, and not its heading - and takes nothing else with it.
 *
 * The render gate (`applySkillsLimit`) empties a switched-off list on every
 * path, and the compile step used to remove the section's markup only when it
 * carried the `section-strengths` / `section-soft-skills` class. Every built-in
 * does; an uploaded template usually does not, and there the list went and its
 * "Strengths" heading stayed, in the live preview, the PDF and the DOCX.
 * `findOptionalSections` (generators/pdfGenerator.ts) finds the section by its
 * class, then a `data-section` attribute, then from where the list is printed
 * (a loop or `{{join}}`): the element around it that holds the section and
 * nothing else, or its container and the heading element before it, past a
 * divider. The claims:
 *
 *   - switched off: no "Strengths" / "Soft Skills" text anywhere in the
 *     document, and nothing else gone - Experience and Technical Skills
 *     intact, and a photo, an icon or a static line beside the section kept;
 *   - switched on with items: the heading and the items are there;
 *   - switched on with none: no heading over an empty list;
 *   - for every built-in and for markups an uploaded template is written in,
 *     none of them needing the compile fallback;
 *   - an element that also holds other data (the summary, the Experience
 *     loop) is never taken, nor a paragraph past 60 characters that happens
 *     to say "strength";
 *   - a `data-section` element goes whole whatever its heading reads;
 *   - a template the finds would leave uncompilable still renders, with less
 *     found, and says so once;
 *   - the profile editor's preview route and the render a PDF prints from
 *     agree, and the stored template file is never rewritten
 *     (test/e2e/section-switches.js drives the editor itself).
 */

const SHIPPED = path.join(__dirname, '..', 'static');

function seeded(name) {
  const storage = useTempStorage(`section-headings-${name}`);
  fs.cpSync(path.join(SHIPPED, 'templates'), path.join(storage.staticDir, 'templates'), { recursive: true });
  fs.cpSync(path.join(SHIPPED, 'skills'), path.join(storage.staticDir, 'skills'), { recursive: true });
  return storage;
}

function profile(settings = {}, extra = {}) {
  return {
    id: 'p1',
    name: 'A Person',
    title: 'Engineer',
    contact: { email: 'a@b.c', phone: '1', location: 'X' },
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
        skills: [],
      },
    ],
    strengths: [{ title: 'Foresight', description: 'Sees the failure before it ships.' }],
    softSkills: ['Persistence', 'Clear writing'],
    education: [],
    certifications: [],
    skills: ['Python', 'Docker'],
    profileSettings: settings,
    createdAt: '',
    updatedAt: '',
    ...extra,
  };
}

const ON = { includeSoftSkills: true, includeStrengths: true };

/** What a reader sees: no stylesheet (a class name in CSS is not content), no tags. */
function seen(html) {
  return html
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<head\b[\s\S]*?<\/head>/i, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ');
}

const STRENGTHS_HEADING = /strengths?/i;
const SOFT_SKILLS_HEADING = /soft[\s-]*skills?/i;

/**
 * Markups an uploaded template is written in: no marker class, no
 * data-section - only a heading and a loop, laid out every way that matters.
 */
const UPLOADED_MARKUPS = {
  'a heading as the sibling before the loop':
    '<div class="main"><h2>Experience</h2>{{#each experience}}<p>{{company}}</p>{{/each}}' +
    '<h2>Strengths</h2><ul>{{#each strengths}}<li>{{title}}: {{description}}</li>{{/each}}</ul>' +
    '<h2>Soft Skills</h2><ul>{{#each softSkills}}<li>{{this}}</li>{{/each}}</ul>' +
    '<h2>Technical Skills</h2>{{#each skills}}<span>{{this}}</span>{{/each}}</div>',
  'a heading inside a plain div with its loop':
    '<div class="main"><h2>Experience</h2>{{#each experience}}<p>{{company}}</p>{{/each}}' +
    '<div><h3>Strengths</h3>{{#each strengths}}<p>{{title}}</p>{{/each}}</div>' +
    '<div><h3>Soft Skills</h3>{{#each softSkills}}<span>{{this}}</span>{{/each}}</div>' +
    '<h2>Technical Skills</h2>{{#each skills}}<span>{{this}}</span>{{/each}}</div>',
  'a guard around the loop only, the heading outside it':
    '<div class="main"><h2>Experience</h2>{{#each experience}}<p>{{company}}</p>{{/each}}' +
    '<h2>Key Strengths</h2>{{#if strengths.length}}<ul>{{#each strengths}}<li>{{title}}</li>{{/each}}</ul>{{/if}}' +
    '<h2>Soft Skills</h2>{{#if softSkills}}<div class="list"><ul>{{#each softSkills}}<li>{{this}}</li>{{/each}}</ul></div>{{/if}}' +
    '<h2>Technical Skills</h2>{{#each skills}}<span>{{this}}</span>{{/each}}</div>',
  'both sections in one column with the skills':
    '<div class="row"><div class="side"><h3>Technical Skills</h3>{{#each skills}}<span>{{this}}</span>{{/each}}' +
    '<h3>Strengths</h3>{{#each strengths}}<p>{{title}}</p>{{/each}}' +
    '<h3>Soft Skills</h3><ul>{{#each softSkills}}<li>{{this}}</li>{{/each}}</ul></div>' +
    '<div class="main"><h2>Experience</h2>{{#each experience}}<p>{{company}}</p>{{/each}}</div></div>',
  'headings in capitals, h4 and a label before an inline list':
    '<div><p>{{summary}}</p><h4>STRENGTHS</h4><ol>{{#each strengths}}<li>{{title}}</li>{{/each}}</ol>' +
    '<p><strong>Soft Skills:</strong> {{#each softSkills}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}</p>' +
    '<h4>EXPERIENCE</h4>{{#each experience}}<p>{{company}}</p>{{/each}}' +
    '<h4>TECHNICAL SKILLS</h4>{{#each skills}}<span>{{this}}</span>{{/each}}</div>',
  'sections marked by data-section only':
    '<div><section data-section="strengths"><h2>Strengths</h2><div>{{#each strengths}}<p>{{title}}</p>{{/each}}</div></section>' +
    "<section data-section='softSkills'><h2>Soft Skills</h2>{{#each softSkills}}<i>{{this}}</i>{{/each}}</section>" +
    '<section data-section="experience"><h2>Experience</h2>{{#each experience}}<p>{{company}}</p>{{/each}}</section>' +
    '<section><h2>Technical Skills</h2>{{#each skills}}<span>{{this}}</span>{{/each}}</section></div>',
  'a heading element with an icon and a comment before the list':
    '<div class="main"><div class="head"><span class="icon"><svg width="8" height="8"><circle r="4"/></svg></span>' +
    '<h2>Strengths</h2></div><!-- the list --><div class="grid">{{#each strengths}}<div>{{title}}</div>{{/each}}</div>' +
    '<div class="head"><h2>Soft Skills</h2></div><div class="grid">{{#each softSkills}}<div>{{this}}</div>{{/each}}</div>' +
    '<h2>Experience</h2>{{#each experience}}<p>{{company}}</p>{{/each}}' +
    '<h2>Technical Skills</h2>{{#each skills}}<span>{{this}}</span>{{/each}}</div>',
  // The element right before the list is a divider, not the heading: the
  // heading is the one before that, and the divider goes with it.
  'a divider between the heading and the list, in a flat column':
    '<div class="main"><h2>Strengths</h2><hr><ul>{{#each strengths}}<li>{{title}}</li>{{/each}}</ul>' +
    '<h2>Soft Skills</h2><div class="rule"></div><!-- --><hr/><ul>{{#each softSkills}}<li>{{this}}</li>{{/each}}</ul>' +
    '<h2>Experience</h2>{{#each experience}}<p>{{company}}</p>{{/each}}' +
    '<h2>Technical Skills</h2>{{#each skills}}<span>{{this}}</span>{{/each}}</div>',
  // The app's own `join` helper prints the list with no loop at all, and the
  // switch is offered for it (inferTemplateCapabilities).
  'soft skills printed by the join helper, straight into a column':
    '<div class="main"><h2>Experience</h2>{{#each experience}}<p>{{company}}</p>{{/each}}' +
    '<h2>Strengths</h2><ul>{{#each strengths}}<li>{{title}}</li>{{/each}}</ul>' +
    '<h2>Soft Skills</h2><p>{{join softSkills ", "}}</p>' +
    '<h2>Technical Skills</h2>{{#each skills}}<span>{{this}}</span>{{/each}}</div>',
  'soft skills printed by the join helper, in a wrapper of their own':
    '<div class="main"><h2>Experience</h2>{{#each experience}}<p>{{company}}</p>{{/each}}' +
    '<section><h3>Strengths</h3>{{#each strengths}}<p>{{title}}</p>{{/each}}</section>' +
    '<section><h3>Soft Skills</h3><p>{{{join softSkills " / "}}}</p></section>' +
    '<h2>Technical Skills</h2>{{#each skills}}<span>{{this}}</span>{{/each}}</div>',
  'a bold label and a line break before the list, in a column with the summary':
    '<div class="side"><p>{{summary}}</p><b>Strengths</b><br>{{#each strengths}}<span>{{title}}</span>{{/each}}<br/>' +
    '<strong>Soft Skills</strong><br />{{#each softSkills}}<span>{{this}}</span>{{/each}}' +
    '<h4>Experience</h4>{{#each experience}}<p>{{company}}</p>{{/each}}' +
    '<h4>Technical Skills</h4>{{#each skills}}<span>{{this}}</span>{{/each}}</div>',
  // Valid Handlebars around mis-nested HTML: the guard opens inside the
  // section's element and closes after it. Taking the element took the
  // opener and left its `{{/if}}` dangling, and the template stopped
  // compiling with the switch off.
  'a guard that opens inside the section and closes after it':
    '<main><section><h2>Experience</h2>{{#each experience}}<p>{{company}}</p>{{/each}}</section>' +
    '<div class="s">{{#if strengths.length}}<h3>Strengths</h3>{{#each strengths}}<p>{{title}}</p>{{/each}}</div>{{/if}}' +
    '<div class="t">{{#if softSkills}}<h3>Soft Skills</h3>{{#each softSkills}}<i>{{this}}</i>{{/each}}</div>{{/if}}' +
    '<h2>Technical Skills</h2>{{#each skills}}<span>{{this}}</span>{{/each}}</main>',
};

/**
 * Markups whose section shares an element with something else the template
 * prints - a photo, an icon, a line of static text. The section goes; what
 * is beside it never does, in any mode. `keeps` is checked in the rendered
 * markup, because a picture has no text to read.
 */
const SECTIONS_WITH_NEIGHBOURS = {
  'a photo sidebar in a grid, with References under the sections': {
    html:
      '<div class="row" style="display:grid;grid-template-columns:200px 1fr"><aside>' +
      '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="photo">' +
      '<h3>Strengths</h3><ul>{{#each strengths}}<li>{{title}}</li>{{/each}}</ul>' +
      '<h3>Soft Skills</h3><ul>{{#each softSkills}}<li>{{this}}</li>{{/each}}</ul>' +
      '<h3>References</h3><p>Available upon request</p></aside>' +
      '<main><h2>Experience</h2>{{#each experience}}<p>{{company}}</p>{{/each}}' +
      '<h2>Technical Skills</h2>{{#each skills}}<span>{{this}}</span>{{/each}}</main></div>',
    keeps: ['<aside>', 'alt="photo"', 'References', 'Available upon request', '<main>'],
  },
  'a line of static text beside each section in its column': {
    html:
      '<div class="row"><div class="side"><h3>Strengths</h3>{{#each strengths}}<p>{{title}}</p>{{/each}}' +
      '<p>Open to relocation and remote work</p></div>' +
      '<div class="side">Languages: English, Spanish<h3>Soft Skills</h3><ul>{{#each softSkills}}<li>{{this}}</li>{{/each}}</ul></div>' +
      '<div class="main"><h2>Experience</h2>{{#each experience}}<p>{{company}}</p>{{/each}}' +
      '<h2>Technical Skills</h2>{{#each skills}}<span>{{this}}</span>{{/each}}</div></div>',
    keeps: ['Open to relocation and remote work', 'Languages: English, Spanish'],
  },
  'an image, an icon and a CSS picture beside the sections': {
    html:
      '<div class="side"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="logo">' +
      '<svg class="badge" width="8" height="8"><circle r="4"/></svg>' +
      '<h3>Strengths</h3>{{#each strengths}}<p>{{title}}</p>{{/each}}</div>' +
      '<div class="side"><div class="banner" style="background-image:url(data:image/gif;base64,R0lGODlhAQABAAAAACw=)"></div>' +
      '<h3>Soft Skills</h3><ul>{{#each softSkills}}<li>{{this}}</li>{{/each}}</ul></div>' +
      '<div class="main"><h2>Experience</h2>{{#each experience}}<p>{{company}}</p>{{/each}}' +
      '<h2>Technical Skills</h2>{{#each skills}}<span>{{this}}</span>{{/each}}</div>',
    keeps: ['alt="logo"', 'class="badge"', 'class="banner"'],
  },
};

/**
 * Runs `fn` with console.warn captured, and answers what it logged.
 * `compilableMarkup` logs a `[templates]` line when the section finds would
 * have stopped a template compiling and it fell back to finding less; the
 * markups here must never need that, or a section switched off would keep its
 * heading only because the fallback covered for a broken find.
 */
async function warningsOf(fn) {
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.warn = realWarn;
  }
  return warnings.filter((line) => line.includes('[templates]'));
}

/** Every claim of this file about one rendered markup. */
async function assertSectionsFollowSwitches(render, name) {
  const off = seen(await render({}));
  assert.doesNotMatch(off, STRENGTHS_HEADING, `${name}: switched off, a Strengths heading was left`);
  assert.doesNotMatch(off, SOFT_SKILLS_HEADING, `${name}: switched off, a Soft Skills heading was left`);
  assert.equal(off.includes('Foresight') || off.includes('Persistence'), false, `${name}: items left`);
  assert.ok(off.includes('Acme Widgets'), `${name}: Experience was removed with the section`);
  assert.ok(off.includes('Docker'), `${name}: Technical Skills was removed with the section`);

  const on = seen(await render(ON));
  assert.match(on, STRENGTHS_HEADING, `${name}: switched on, the Strengths heading is drawn`);
  assert.match(on, SOFT_SKILLS_HEADING, `${name}: switched on, the Soft Skills heading is drawn`);
  assert.ok(on.includes('Foresight') && on.includes('Persistence'), `${name}: switched on, the items are drawn`);
  assert.ok(on.includes('Acme Widgets') && on.includes('Docker'), `${name}: switched on, the rest is drawn`);

  const empty = seen(await render(ON, { strengths: [], softSkills: [] }));
  assert.doesNotMatch(empty, STRENGTHS_HEADING, `${name}: switched on with none, an empty Strengths heading`);
  assert.doesNotMatch(empty, SOFT_SKILLS_HEADING, `${name}: switched on with none, an empty Soft Skills heading`);
  assert.ok(empty.includes('Acme Widgets') && empty.includes('Docker'), `${name}: switched on with none, the rest`);

  // One section on and the other off: only that one goes.
  const onlyStrengths = seen(await render({ includeStrengths: true }));
  assert.match(onlyStrengths, STRENGTHS_HEADING, `${name}: Strengths alone`);
  assert.doesNotMatch(onlyStrengths, SOFT_SKILLS_HEADING, `${name}: Soft Skills off beside Strengths on`);
}

test('every built-in leaves no heading for a section switched off, and nothing else goes with it', async () => {
  seeded('built-ins');
  const { getAllTemplates } = require('../dist/extractors/templateExtractor');
  const { generatePreviewHTML } = require('../dist/generators/pdfGenerator');

  const templates = await getAllTemplates();
  assert.equal(templates.length, 19);
  const warnings = await warningsOf(() => checkBuiltIns(templates, generatePreviewHTML));
  assert.deepEqual(warnings, [], 'a built-in needed the compile fallback');
});

async function checkBuiltIns(templates, generatePreviewHTML) {
  for (const template of templates) {
    const render = (settings, extra) => generatePreviewHTML(profile(settings, extra), template);
    const off = seen(await render({}));
    assert.doesNotMatch(off, STRENGTHS_HEADING, `${template.id}: a Strengths heading`);
    assert.doesNotMatch(off, SOFT_SKILLS_HEADING, `${template.id}: a Soft Skills heading`);
    assert.ok(off.includes('Acme Widgets'), `${template.id}: Experience intact`);
    assert.ok(off.includes('Docker'), `${template.id}: Technical Skills intact`);

    const on = seen(await render(ON));
    assert.equal(on.includes('Foresight'), template.supportsStrengths, `${template.id}: strengths when on`);
    assert.equal(on.includes('Persistence'), template.supportsSoftSkills, `${template.id}: soft skills when on`);
    if (template.supportsStrengths) assert.match(on, STRENGTHS_HEADING, `${template.id}: the Strengths heading when on`);
    if (template.supportsSoftSkills) {
      assert.match(on, SOFT_SKILLS_HEADING, `${template.id}: the Soft Skills heading when on`);
    }
    assert.ok(on.includes('Acme Widgets') && on.includes('Docker'), `${template.id}: the rest when on`);
  }
}

test('an uploaded-style template, marked by neither class nor attribute, loses the whole section when it is off', async () => {
  seeded('uploaded');
  const { generatePreviewHTML } = require('../dist/generators/pdfGenerator');
  for (const [name, htmlContent] of Object.entries(UPLOADED_MARKUPS)) {
    const template = { id: `uploaded-style-${name}`, name, htmlContent, cssContent: '.main { color: #111 }' };
    const warnings = await warningsOf(() =>
      assertSectionsFollowSwitches((settings, extra) => generatePreviewHTML(profile(settings, extra), template), name)
    );
    assert.deepEqual(warnings, [], `${name}: the section finds left markup that does not compile`);
  }
});

test('what shares an element with the section - a photo, an icon, a line of text - stays in every mode', async () => {
  seeded('neighbours');
  const { generatePreviewHTML } = require('../dist/generators/pdfGenerator');
  for (const [name, { html: htmlContent, keeps }] of Object.entries(SECTIONS_WITH_NEIGHBOURS)) {
    const template = { id: `uploaded-neighbours-${name}`, name, htmlContent, cssContent: '' };
    const render = (settings, extra) => generatePreviewHTML(profile(settings, extra), template);
    const warnings = await warningsOf(async () => {
      await assertSectionsFollowSwitches(render, name);
      for (const [mode, settings, extra] of [
        ['switched off', {}],
        ['switched on', ON],
        ['switched on with none', ON, { strengths: [], softSkills: [] }],
      ]) {
        const html = await render(settings, extra);
        for (const kept of keeps) assert.ok(html.includes(kept), `${name}, ${mode}: ${kept} was removed with the section`);
      }
    });
    assert.deepEqual(warnings, [], `${name}: the section finds left markup that does not compile`);
  }

  // The section's own wrapper - its heading (an icon inside it), a divider and
  // the list, nothing else - still goes whole, wrapper and all.
  const own = {
    id: 'uploaded-own-wrapper',
    name: 'Own wrapper',
    htmlContent:
      '<div class="strengths-box"><h3><svg width="8" height="8"><circle r="4"/></svg> Strengths</h3><hr>' +
      '<ul>{{#each strengths}}<li>{{title}}</li>{{/each}}</ul></div>' +
      '<div class="soft-box">\n  <h3>Soft Skills</h3>\n  <div class="rule"></div>\n  {{#if softSkills.length}}<p>{{join softSkills ", "}}</p>{{/if}}\n</div>' +
      '<h2>Experience</h2>{{#each experience}}<p>{{company}}</p>{{/each}}' +
      '<h2>Technical Skills</h2>{{#each skills}}<span>{{this}}</span>{{/each}}',
    cssContent: '',
  };
  const off = await generatePreviewHTML(profile({}), own);
  assert.equal(off.includes('strengths-box') || off.includes('soft-box'), false, 'the wrappers go with their sections');
  assert.ok(off.includes('Acme Widgets') && off.includes('Docker'));
  const on = await generatePreviewHTML(profile(ON), own);
  assert.ok(on.includes('strengths-box') && on.includes('soft-box') && on.includes('Persistence, Clear writing'));
});

test('a template the section finds would stop compiling still renders, and says why once', async () => {
  seeded('compile-fallback');
  const { generatePreviewHTML } = require('../dist/generators/pdfGenerator');

  // The marker class is on an element a Handlebars block crosses: cutting the
  // element leaves the block's `{{/if}}` behind. That failed every render
  // with the switch off - every profile's default.
  const crossed = {
    id: 'uploaded-crossed',
    name: 'Crossed',
    htmlContent:
      '<div class="main"><h2>Experience</h2>{{#each experience}}<p>{{company}}</p>{{/each}}' +
      '<div class="section-strengths">{{#if summary}}<h3>Strengths</h3>{{#each strengths}}<p>{{title}}</p>{{/each}}</div>{{/if}}' +
      '<h2>Technical Skills</h2>{{#each skills}}<span>{{this}}</span>{{/each}}</div>',
    cssContent: '',
  };
  const fallbacks = await warningsOf(async () => {
    for (let n = 0; n < 2; n += 1) {
      const off = seen(await generatePreviewHTML(profile({}), crossed));
      assert.ok(off.includes('Acme Widgets') && off.includes('Docker'), 'drawn, the rest intact');
      assert.equal(off.includes('Foresight'), false, 'the switched-off list still prints nothing');
    }
    const on = seen(await generatePreviewHTML(profile(ON), crossed));
    assert.ok(on.includes('Foresight'), 'switched on, the section draws');
  });
  assert.equal(fallbacks.length, 1, 'logged once');
  assert.match(fallbacks[0], /Template "uploaded-crossed" .*drawn with both sections in place/);

  // A template that does not parse by itself fails with its own error, as it
  // always did, and is not blamed on the section finds.
  const broken = {
    id: 'uploaded-broken',
    name: 'Broken',
    htmlContent: '<div>{{#if summary}}<h3>Strengths</h3>{{#each strengths}}<p>{{title}}</p>{{/each}}</div>',
    cssContent: '',
  };
  const blamed = await warningsOf(() =>
    assert.rejects(() => generatePreviewHTML(profile({}), broken), /Parse error|Expecting/)
  );
  assert.deepEqual(blamed, []);
});

test('markup that only looks like a section is left alone', async () => {
  seeded('lookalikes');
  const { generatePreviewHTML } = require('../dist/generators/pdfGenerator');
  const render = (htmlContent, settings) =>
    generatePreviewHTML(profile(settings), { id: 'u', name: 'U', htmlContent, cssContent: '' });

  // Soft skills drawn inside the Technical Skills block, under its heading:
  // the heading belongs to the skills, so it stays, and only the soft skills go.
  const mixed = seen(
    await render(
      '<div class="skills"><h3>Skills</h3>{{#each skills}}<span>{{this}}</span>{{/each}}' +
        '{{#each softSkills}}<span>{{this}}</span>{{/each}}</div>',
      {}
    )
  );
  assert.ok(mixed.includes('Skills') && mixed.includes('Docker'), 'the skills block stays');
  assert.equal(mixed.includes('Persistence'), false);

  // A static paragraph that happens to say "strength", and a heading that
  // names it but sits over another section's data, are not the section. (The
  // experience loop beside the paragraph keeps it either way; the 60-character
  // limit on a heading is pinned on its own in the next test.)
  const wording =
    '<div><p>Strength through clarity is the motto printed on every page of this resume template.</p>' +
    '<h2>Strengths and Experience</h2>{{#each experience}}<p>{{company}}</p>{{/each}}' +
    '<div class="s">{{#each strengths}}<b>{{title}}</b>{{/each}}</div></div>';
  const kept = seen(await render(wording, {}));
  assert.ok(kept.includes('Strength through clarity'), 'a paragraph is not a heading');
  assert.ok(kept.includes('Strengths and Experience') && kept.includes('Acme Widgets'), 'another section is kept');
  assert.equal(kept.includes('Foresight'), false);

  // A section whose markup the template wrote with its own guard still compiles,
  // and switched on draws exactly once.
  const guarded = '{{#if strengths.length}}<h2>Strengths</h2>{{#each strengths}}<p>{{title}}</p>{{/each}}{{/if}}<p>{{summary}}</p>';
  assert.equal((await render(guarded, { includeStrengths: true })).match(/<p>Foresight<\/p>/g).length, 1);
  assert.doesNotMatch(seen(await render(guarded, {})), STRENGTHS_HEADING);
});

/**
 * "Anything holding other data is never taken" (CLAUDE.md), held on its own.
 * Each of these elements holds the section AND something else the template
 * prints - the summary, the Experience loop - or reads as a paragraph rather
 * than a heading, and losing it loses that from the page. The checks that
 * keep them overlap, which is why removing one left every other test here
 * green: `besidesTheLoop` stops the climb at an element holding other data;
 * a mustache counts as text, so such an element never `holdsOnlyTheSection`
 * - unless the data sits inside the piece that reads as the heading, which
 * only the climb's check catches; the heading element before a list may hold
 * no mustache; and a heading reads at most 60 characters.
 */
const SHARED_WITH_OTHER_DATA = {
  'the heading and the list in a column with the summary': {
    html:
      '<div class="side"><h3>Strengths</h3>{{#each strengths}}<p>{{title}}</p>{{/each}}<p>{{summary}}</p></div>' +
      '<div><h2>Experience</h2>{{#each experience}}<p>{{company}}</p>{{/each}}' +
      '{{#each skills}}<span>{{this}}</span>{{/each}}</div>',
    keeps: ['A summary of the work.', 'Acme Widgets', 'Docker'],
    headingGoes: true,
  },
  'the heading and the list in a column with the Experience loop': {
    html:
      '<div class="col"><h3>Strengths</h3>{{#each strengths}}<p>{{title}}</p>{{/each}}' +
      '{{#each experience}}<p>{{company}}</p>{{/each}}</div>' +
      '<div><p>{{summary}}</p>{{#each skills}}<span>{{this}}</span>{{/each}}</div>',
    keeps: ['A summary of the work.', 'Acme Widgets', 'Docker'],
    headingGoes: true,
  },
  // The heading shares a box with the summary: that box reads "Strengths
  // {{summary}}", short enough for a heading, and is the column's only piece
  // beside the list - only the climb's own check keeps the column.
  'the heading in a box with the summary, above the list in a column': {
    html:
      '<div class="side"><div class="head"><h3>Strengths</h3><p>{{summary}}</p></div>' +
      '{{#each strengths}}<p>{{title}}</p>{{/each}}</div>' +
      '<div><h2>Experience</h2>{{#each experience}}<p>{{company}}</p>{{/each}}' +
      '{{#each skills}}<span>{{this}}</span>{{/each}}</div>',
    keeps: ['A summary of the work.', 'Acme Widgets', 'Docker'],
    headingGoes: false,
  },
  // The element right before the list reads "Strengths" in under 60
  // characters, mustaches and all - but it prints the Experience loop, so it
  // is not the list's heading, whatever it says.
  'the element before the list holds the Experience loop under a Strengths heading': {
    html:
      '<div class="main"><div class="exp"><h3>Strengths</h3>{{#each experience}}<p>{{company}}</p>{{/each}}</div>' +
      '<ul>{{#each strengths}}<li>{{title}}</li>{{/each}}</ul>' +
      '<p>{{summary}}</p><h2>Technical Skills</h2>{{#each skills}}<span>{{this}}</span>{{/each}}</div>',
    keeps: ['A summary of the work.', 'Acme Widgets', 'Docker'],
    headingGoes: false,
  },
  // A paragraph is not a heading: past 60 characters it is static text that
  // happens to say "strength", in the section's own element and before a list
  // written straight into a column alike.
  'a long paragraph and the list, in an element holding nothing else': {
    html:
      '<div class="s"><p>Strength through clarity is the motto printed on every page of this resume template.</p>' +
      '{{#each strengths}}<b>{{title}}</b>{{/each}}</div>' +
      '<div><p>{{summary}}</p><h2>Experience</h2>{{#each experience}}<p>{{company}}</p>{{/each}}' +
      '{{#each skills}}<span>{{this}}</span>{{/each}}</div>',
    keeps: ['Strength through clarity is the motto printed on every page of this resume template.', 'Acme Widgets'],
    headingGoes: false,
  },
  'a long paragraph right before the list, in a flat column': {
    html:
      '<div class="main"><p>{{summary}}</p>' +
      '<p>Strength through clarity is the motto printed on every page of this resume template.</p>' +
      '<ul>{{#each strengths}}<li>{{title}}</li>{{/each}}</ul>' +
      '<h2>Experience</h2>{{#each experience}}<p>{{company}}</p>{{/each}}{{#each skills}}<span>{{this}}</span>{{/each}}</div>',
    keeps: ['Strength through clarity is the motto printed on every page of this resume template.', 'Acme Widgets'],
    headingGoes: false,
  },
};

test('an element that holds other data, or a paragraph rather than a heading, is never taken with the section', async () => {
  seeded('other-data');
  const { generatePreviewHTML } = require('../dist/generators/pdfGenerator');
  for (const [name, { html: htmlContent, keeps, headingGoes }] of Object.entries(SHARED_WITH_OTHER_DATA)) {
    const template = { id: `uploaded-other-data-${name}`, name, htmlContent, cssContent: '' };
    const warnings = await warningsOf(async () => {
      for (const technicalSkillsLayout of ['categorized', 'flat']) {
        const render = (settings, extra) =>
          generatePreviewHTML(profile({ technicalSkillsLayout, ...settings }, extra), template);
        const label = `${name} (${technicalSkillsLayout})`;
        for (const [mode, settings, extra] of [
          ['switched off', {}],
          ['switched on with none', ON, { strengths: [], softSkills: [] }],
        ]) {
          const page = seen(await render(settings, extra));
          for (const kept of keeps) assert.ok(page.includes(kept), `${label}, ${mode}: "${kept}" went with the section`);
          assert.equal(page.includes('Foresight'), false, `${label}, ${mode}: the items are left`);
          if (headingGoes) assert.doesNotMatch(page, STRENGTHS_HEADING, `${label}, ${mode}: the heading is left`);
        }
        const on = seen(await render(ON));
        for (const kept of keeps) assert.ok(on.includes(kept), `${label}, switched on: "${kept}"`);
        assert.ok(on.includes('Foresight'), `${label}, switched on: the items are drawn`);
        if (headingGoes) assert.match(on, STRENGTHS_HEADING, `${label}, switched on: the heading is drawn`);
      }
    });
    assert.deepEqual(warnings, [], `${name}: the section finds left markup that does not compile`);
  }
});

/**
 * Step 2 of `findOptionalSections`, decisive: a `data-section` element whose
 * heading reads nothing like "Strengths" or "Soft Skills", so finding the
 * section from its loop (step 3) cannot. This is the README's remedy for an
 * uploaded template whose heading stays, so it is held without the class's
 * or the heading's help - the 'sections marked by data-section only' markup
 * above is found by its headings either way.
 */
const DATA_SECTION_ONLY = {
  'double quotes, the hyphenated soft-skills spelling':
    '<div><p>{{summary}}</p><section data-section="strengths"><h2>What I bring</h2>{{#each strengths}}<p>{{title}}</p>{{/each}}</section>' +
    '<section class="box" data-section="soft-skills" id="work"><h2>How I work</h2>{{#each softSkills}}<i>{{this}}</i>{{/each}}</section>' +
    '<h2>Experience</h2>{{#each experience}}<p>{{company}}</p>{{/each}}' +
    '<h2>Technical Skills</h2>{{#each skills}}<span>{{this}}</span>{{/each}}</div>',
  'single quotes, the softSkills spelling, the list in a box of its own':
    "<div><p>{{summary}}</p><div data-section='strengths'><h2>What I bring</h2><div class=\"grid\">{{#each strengths}}<p>{{title}}</p>{{/each}}</div></div>" +
    "<aside data-section='softSkills'><h2>How I work</h2><ul>{{#each softSkills}}<li>{{this}}</li>{{/each}}</ul></aside>" +
    '<h2>Experience</h2>{{#each experience}}<p>{{company}}</p>{{/each}}' +
    '<h2>Technical Skills</h2>{{#each skills}}<span>{{this}}</span>{{/each}}</div>',
};

test('a section marked by data-section goes whole whatever its heading reads, and is guarded when on', async () => {
  seeded('data-section');
  const { generatePreviewHTML } = require('../dist/generators/pdfGenerator');
  for (const [name, htmlContent] of Object.entries(DATA_SECTION_ONLY)) {
    const template = { id: `uploaded-data-section-${name}`, name, htmlContent, cssContent: '' };
    const render = async (settings, extra) => seen(await generatePreviewHTML(profile(settings, extra), template));
    const rest = (page, mode) =>
      assert.ok(
        ['A summary of the work.', 'Acme Widgets', 'Docker'].every((kept) => page.includes(kept)),
        `${name}, ${mode}: the rest of the page`
      );
    const warnings = await warningsOf(async () => {
      const off = await render({});
      for (const gone of ['What I bring', 'How I work', 'Foresight', 'Persistence']) {
        assert.equal(off.includes(gone), false, `${name}, switched off: "${gone}" is left`);
      }
      rest(off, 'switched off');

      const empty = await render(ON, { strengths: [], softSkills: [] });
      assert.equal(empty.includes('What I bring') || empty.includes('How I work'), false, `${name}: a heading over none`);
      rest(empty, 'switched on with none');

      const on = await render(ON);
      for (const drawn of ['What I bring', 'How I work', 'Foresight', 'Persistence']) {
        assert.ok(on.includes(drawn), `${name}, switched on: "${drawn}" is drawn`);
      }
      rest(on, 'switched on');

      const onlyStrengths = await render({ includeStrengths: true });
      assert.ok(onlyStrengths.includes('What I bring') && onlyStrengths.includes('Foresight'), `${name}: Strengths alone`);
      assert.equal(onlyStrengths.includes('How I work'), false, `${name}: Soft Skills off beside Strengths on`);
    });
    assert.deepEqual(warnings, [], `${name}: the section finds left markup that does not compile`);
  }
});

test('the profile preview route and the render a PDF prints from agree, and the stored file is never rewritten', async () => {
  const { staticDir } = seeded('route');
  useAdminEmails('admin@example.com');
  const { saveStoredTemplate } = require('../dist/database/templateRepository');
  const { getTemplateById } = require('../dist/extractors/templateExtractor');
  const { generatePreviewHTML } = require('../dist/generators/pdfGenerator');

  const htmlContent = UPLOADED_MARKUPS['a heading as the sibling before the loop'];
  saveStoredTemplate({
    id: 'uploaded-classic',
    name: 'Uploaded Classic',
    description: '',
    htmlContent,
    cssContent: '',
    sections: [],
    createdAt: 'x',
    updatedAt: 'x',
  });
  const file = path.join(staticDir, 'templates', 'uploaded-classic.json');
  const before = fs.readFileSync(file, 'utf8');
  const template = await getTemplateById('uploaded-classic');
  assert.equal(template.supportsStrengths, true);
  assert.equal(template.supportsSoftSkills, true);

  const users = require('../dist/database/userRepository');
  const alice = users.createUser({ email: 'alice@example.com' });
  const token = users.createSession(alice.id);
  const { attachUser } = require('../dist/middleware/auth');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(attachUser);
  app.use('/api/profiles', require('../dist/routes/profiles').default);
  const server = app.listen(0);
  try {
    const preview = async (profileSettings) => {
      const { createdAt, updatedAt, id, ...draft } = profile(profileSettings);
      void createdAt;
      void updatedAt;
      void id;
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/profiles/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ profile: draft, templateId: 'uploaded-classic' }),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.templateId, 'uploaded-classic');
      return seen(body.html);
    };

    for (const settings of [{}, ON, { includeStrengths: true }, { includeSoftSkills: true }]) {
      const viaRoute = await preview(settings);
      const viaRender = seen(await generatePreviewHTML(profile(settings), template));
      for (const [label, pattern] of [
        ['Strengths', STRENGTHS_HEADING],
        ['Soft Skills', SOFT_SKILLS_HEADING],
      ]) {
        assert.equal(pattern.test(viaRoute), pattern.test(viaRender), `${label} with ${JSON.stringify(settings)}`);
      }
      assert.equal(STRENGTHS_HEADING.test(viaRoute), settings.includeStrengths === true);
      assert.equal(SOFT_SKILLS_HEADING.test(viaRoute), settings.includeSoftSkills === true);
      assert.ok(viaRoute.includes('Acme Widgets') && viaRender.includes('Acme Widgets'));
    }
  } finally {
    server.close();
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'compile time only: the stored template is never rewritten');
});
