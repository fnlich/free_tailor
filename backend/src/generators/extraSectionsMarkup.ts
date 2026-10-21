import { EXTRA_SECTION_KINDS, sectionKindDefinition, type ExtraSectionKind } from '../config/profileSections';
import { EXTRA_SECTIONS_MACRO, isGeneratableCustomKey, templateNamesField } from './sectionLocator';

/**
 * The extra-sections macro: the one line a template carries where the
 * sections beyond the classic six print.
 *
 *   {{> extra-sections sectionClass="section" headingClass="section-title"
 *       headingTextClass="section-title-text" contentClass="section-content"
 *       entryClass="education-item" titleClass="degree" subClass="institution"
 *       datesClass="edu-date" bulletsClass="achievements"}}
 *
 * It looks like a Handlebars partial and is not one: OUR code expands it,
 * before Handlebars sees the markup, into one plain block per kind (and one
 * per custom section), each marked with `section-<kind>` and `data-section`
 * like a built-in's own sections, so the reorder step can move each one on
 * its own - a partial would be ONE node to Handlebars, and a custom section
 * could never be moved individually. The hash parameters name the template's
 * own classes, so the blocks are drawn in its look; the neutral `xs-*`
 * classes beside them carry a small baseline for anything a template leaves
 * unstyled. Every value prints through `{{ }}`, escaped; links print only as
 * the http(s) hrefs the render data prepared (services/extraSections.ts).
 *
 * A kind the template's own markup already names (the owner's uploaded
 * `ats-*` templates loop over `certifications` themselves) is left to the
 * template: the macro never prints a kind twice. The guard sits OUTSIDE each
 * block's element, as every built-in writes its Strengths block, so an empty
 * kind leaves no bordered card behind.
 */

/** The class names a macro call may name; each '' when it does not. */
export type MacroParams = Record<
  | 'sectionClass'
  | 'headingClass'
  | 'headingTextClass'
  | 'contentClass'
  | 'entryClass'
  | 'titleClass'
  | 'subClass'
  | 'datesClass'
  | 'bulletsClass',
  string
>;

const PARAM_NAMES: ReadonlyArray<keyof MacroParams> = [
  'sectionClass',
  'headingClass',
  'headingTextClass',
  'contentClass',
  'entryClass',
  'titleClass',
  'subClass',
  'datesClass',
  'bulletsClass',
];

/** The comment pair that delimits one generated block, by which the locator finds it. */
export function generatedBlockMarkers(ref: string): { open: string; close: string } {
  return { open: `<!--xs:${ref}-->`, close: `<!--/xs:${ref}-->` };
}

export function readMacroParams(hash: string): MacroParams {
  const params = Object.fromEntries(PARAM_NAMES.map((name) => [name, ''])) as MacroParams;
  const pairs = /(\w+)="([A-Za-z0-9_ -]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pairs.exec(hash)) !== null) {
    const name = match[1] as keyof MacroParams;
    if (PARAM_NAMES.includes(name)) params[name] = match[2].trim();
  }
  return params;
}

const classes = (...names: string[]) => names.filter(Boolean).join(' ');

function pieces(p: MacroParams) {
  const heading = (text: string) =>
    `<div class="${classes('xs-heading', p.headingClass)}">${
      p.headingTextClass ? `<span class="${p.headingTextClass}">${text}</span>` : text
    }</div>`;
  const content = (inner: string) => `<div class="${classes('xs-content', p.contentClass)}">${inner}</div>`;
  const entry = (inner: string) => `<div class="${classes('xs-entry', p.entryClass)}">${inner}</div>`;
  const title = (inner: string) => `<div class="${classes('xs-title', p.titleClass)}">${inner}</div>`;
  const sub = (field: string) => `{{#if ${field}}}<div class="${classes('xs-sub', p.subClass)}">{{${field}}}</div>{{/if}}`;
  const note = (field: string) => `{{#if ${field}}}<div class="${classes('xs-note', p.datesClass)}">{{${field}}}</div>{{/if}}`;
  const datesClass = classes('xs-dates', p.datesClass);
  const dates =
    `{{#if dates}}<div class="${datesClass}">{{dates}}{{#if location}} | {{location}}{{/if}}</div>` +
    `{{else}}{{#if location}}<div class="${datesClass}">{{location}}</div>{{/if}}{{/if}}`;
  const description = '{{#if description}}<div class="xs-desc">{{description}}</div>{{/if}}';
  const bullets =
    `{{#if achievements.length}}<ul class="${classes('xs-bullets', p.bulletsClass)}">` +
    '{{#each achievements}}<li>{{this}}</li>{{/each}}</ul>{{/if}}';
  const link = '{{#if linkHref}} <a class="xs-link" href="{{linkHref}}">{{linkText}}</a>{{/if}}';
  const inlineItem = (inner: string) => `<div class="${classes('xs-inline-item', p.subClass)}">${inner}</div>`;
  return { heading, content, entry, title, sub, note, dates, description, bullets, link, inlineItem };
}

/** The items of one kind's block, inside its content element. */
function itemsOf(kind: ExtraSectionKind, p: MacroParams): string {
  const x = pieces(p);
  switch (kind) {
    case 'certifications':
      return `{{#each certifications}}${x.entry(`${x.title('{{name}}')}${x.sub('issuer')}${x.note('dates')}${x.note('note')}`)}{{/each}}`;
    case 'projects':
      return `{{#each projects}}${x.entry(`${x.title(`{{name}}${x.link}`)}${x.sub('role')}${x.dates}${x.description}${x.bullets}`)}{{/each}}`;
    case 'volunteering':
      return `{{#each volunteering}}${x.entry(`${x.title('{{role}}')}${x.sub('organization')}${x.dates}${x.description}${x.bullets}`)}{{/each}}`;
    case 'awards':
      return `{{#each awards}}${x.entry(`${x.title('{{title}}')}${x.sub('issuer')}${x.note('dates')}${x.description}`)}{{/each}}`;
    case 'publications':
      return `{{#each publications}}${x.entry(`${x.title(`{{title}}${x.link}`)}${x.sub('publisher')}${x.note('dates')}${x.description}`)}{{/each}}`;
    case 'courses':
      return `{{#each courses}}${x.entry(`${x.title('{{name}}')}${x.sub('institution')}${x.note('dates')}`)}{{/each}}`;
    case 'languages':
      return `{{#each languages}}${x.inlineItem('<span class="xs-strong">{{language}}</span>{{#if proficiency}} - {{proficiency}}{{/if}}')}{{/each}}`;
    case 'interests':
      return `<div class="${classes('xs-inline', p.subClass)}">{{join interests ", "}}</div>`;
    case 'references':
      return `{{#each references}}${x.entry(`${x.title('{{name}}')}${x.sub('subline')}${x.note('contactLine')}`)}{{/each}}`;
  }
}

/** One kind's block: guarded on its list, marked like a built-in's section, delimited for the locator. */
export function kindBlock(kind: ExtraSectionKind, p: MacroParams): string {
  const x = pieces(p);
  const { open, close } = generatedBlockMarkers(kind);
  const wrapper = `<div class="${classes(p.sectionClass, `section-${kind}`)}" data-section="${kind}">`;
  return `${open}{{#if ${kind}.length}}${wrapper}${x.heading(sectionKindDefinition(kind).heading)}${x.content(
    itemsOf(kind, p)
  )}</div>{{/if}}${close}`;
}

/**
 * One custom section's block, bound to its key through the built-in `lookup`
 * on the render data's `customSectionsByKey` (services/extraSections.ts), so
 * each is its own movable element. The key is `[a-z0-9-]{1,40}`, safe in the
 * class, the attribute and the string literal alike.
 */
export function customBlock(key: string, p: MacroParams): string {
  const x = pieces(p);
  const { open, close } = generatedBlockMarkers(`custom:${key}`);
  const wrapper = `<div class="${classes(p.sectionClass, 'section-custom')}" data-section="custom:${key}">`;
  const entries = `{{#each entries}}${x.entry(`${x.title('{{heading}}')}${x.sub('subheading')}${x.dates}${x.description}${x.bullets}`)}{{/each}}`;
  return (
    `${open}{{#with (lookup @root.customSectionsByKey "${key}")}}{{#if hasEntries}}${wrapper}` +
    `{{#if title}}${x.heading('{{title}}')}{{/if}}${x.content(entries)}</div>{{/if}}{{/with}}${close}`
  );
}

/**
 * The markup with every extra-sections macro replaced by its blocks: one per
 * kind the template does not print itself, in canonical order, then one per
 * custom section. The template's own markup, with the macros taken out, is
 * what decides whether it names a kind - the macro's own text names them all.
 */
export function expandExtraSectionsMacro(html: string, customKeys: readonly string[]): string {
  if (!EXTRA_SECTIONS_MACRO.test(html)) {
    EXTRA_SECTIONS_MACRO.lastIndex = 0;
    return html;
  }
  EXTRA_SECTIONS_MACRO.lastIndex = 0;
  const own = html.replace(EXTRA_SECTIONS_MACRO, '');
  const kinds = EXTRA_SECTION_KINDS.filter((kind) => !templateNamesField(own, kind));
  const keys = customKeys.filter(isGeneratableCustomKey);
  return html.replace(EXTRA_SECTIONS_MACRO, (_match, hash: string) => {
    const params = readMacroParams(hash);
    return [...kinds.map((kind) => kindBlock(kind, params)), ...keys.map((key) => customBlock(key, params))].join('');
  });
}

export const EXTRA_SECTIONS_STYLE_ID = 'xs-style';

/**
 * The baseline the generated blocks fall back on where a template's classes
 * do not reach them: eleven built-ins scope their entry rules under their
 * Education section (`.section.section-education .section-content .edu-date`),
 * so a generated entry gets the heading's look from the template and the rest
 * from here. Light on purpose - the template's own, unscoped rules win ties
 * by coming later in the cascade with the same specificity, or by being more
 * specific.
 */
const BASELINE_STYLE =
  `<style id="${EXTRA_SECTIONS_STYLE_ID}">` +
  '.xs-entry{margin-bottom:6px;break-inside:avoid}.xs-title{font-weight:600}.xs-sub{font-style:italic}' +
  '.xs-dates,.xs-note{font-size:.9em;opacity:.8}.xs-desc{margin-top:1px}.xs-bullets{margin:2px 0 0;padding-left:16px}' +
  '.xs-inline{margin:0}.xs-inline-item{margin:0 0 2px}.xs-strong{font-weight:600}' +
  '.xs-link{margin-left:4px;font-size:.9em;font-weight:normal;color:inherit;text-decoration:none}' +
  '</style>';

/**
 * Puts a stylesheet the compile step generates into markup that does not
 * carry one of that id yet: before `</head>` when there is one, else at
 * `fallbackAt`. In the head on purpose - test/profilePreview.test.js's reading
 * of a preview's body starts after the last `</style>`, and so would a
 * reader's. Idempotent by the stylesheet's id. Shared with the Plain safety
 * net (plainSkillsMarkup.ts).
 */
export function insertStyleOnce(html: string, id: string, styleTag: string, fallbackAt: number): string {
  if (html.includes(`id="${id}"`)) return html;
  const head = /<\/head\s*>/i.exec(html);
  const at = head ? head.index : Math.min(Math.max(fallbackAt, 0), html.length);
  return `${html.slice(0, at)}${styleTag}${html.slice(at)}`;
}

/** The baseline stylesheet, into markup that carries a generated block: in the head, else before the first block. */
export function injectExtraSectionsStyle(html: string): string {
  if (!html.includes('<!--xs:')) return html;
  return insertStyleOnce(html, EXTRA_SECTIONS_STYLE_ID, BASELINE_STYLE, html.indexOf('<!--xs:'));
}
