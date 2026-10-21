import {
  CUSTOM_KEY_PATTERN,
  EXTRA_SECTION_KINDS,
  SECTION_KIND_IDS,
  type SectionKind,
} from '../config/profileSections';

/**
 * Where a template's sections are, in its markup.
 *
 * The compile step (generators/pdfGenerator.ts) strips a Soft Skills or
 * Strengths section a profile switched off, guards one it switched on, and
 * moves every section into the order the profile stores; the template read
 * (services/templateImport.ts) derives from the same markup which kinds a
 * template prints and in what order. All of them need the one answer to
 * "where is this section", so it lives here, a leaf with no Handlebars, no
 * database and no import but the catalogue - pdfGenerator imports
 * profileService, which imports templateImport, so the locator could not
 * stay in pdfGenerator without a cycle.
 *
 * A section is found by, in order: the marker class every built-in and the
 * manual builder put on it (`section-<kind>`); a `data-section` attribute
 * (azure-stack and the manual builder); and, for markup that has neither -
 * an uploaded template, typically - from where its list is printed: the
 * element around the loop that holds the section and nothing else, or its
 * container and the heading element before it. The blocks the extra-sections
 * macro generates are found by the comments that delimit them.
 */

/** A stretch of a template's markup: [start, end). */
export type MarkupSpan = { start: number; end: number };

/**
 * How a compile finds the sections: 'all' of `findSections`; 'marked', only
 * the class and `data-section` (no section found from its loop); 'none', no
 * section removed, guarded or moved at all. Anything but 'all' is
 * `compilableMarkup`'s fallback for a template the finds would stop compiling.
 */
export type SectionFinds = 'all' | 'marked' | 'none';

/**
 * How one kind of section is marked and what it prints: the class the
 * built-ins and the manual builder put on it, the `data-section` values the
 * builder and azure-stack write, the fields its list may be printed from
 * (outermost first for skills, whose category loop holds a skills loop of its
 * own), and - for markup that has neither mark - the words its heading reads.
 */
export type SectionLocator = {
  kind: SectionKind | 'customSections';
  className: string;
  dataSections: readonly string[];
  fields: readonly string[];
  heading: RegExp;
};

const extraLocator = (kind: SectionKind, heading: RegExp): SectionLocator => ({
  kind,
  className: `section-${kind}`,
  dataSections: [kind],
  fields: [kind],
  heading,
});

/**
 * In the order sections are looked for: Soft Skills before Technical Skills,
 * so a "Soft Skills" heading is never read as the skills section's.
 */
export const SECTION_LOCATORS: readonly SectionLocator[] = [
  { kind: 'summary', className: 'section-summary', dataSections: ['summary'], fields: ['summary'], heading: /summary|profile|about/i },
  { kind: 'experience', className: 'section-experience', dataSections: ['experience'], fields: ['experience'], heading: /experience|employment|work history/i },
  { kind: 'education', className: 'section-education', dataSections: ['education'], fields: ['education'], heading: /education/i },
  { kind: 'softSkills', className: 'section-soft-skills', dataSections: ['softSkills', 'soft-skills'], fields: ['softSkills'], heading: /soft[\s-]*skill/i },
  { kind: 'strengths', className: 'section-strengths', dataSections: ['strengths'], fields: ['strengths'], heading: /strength/i },
  {
    kind: 'skills',
    className: 'section-skills',
    dataSections: ['skills', 'hardSkills', 'skillCategories', 'technicalSkills'],
    fields: ['skillCategories', 'hardSkills', 'skills'],
    heading: /^(?!.*\bsoft\b).*(skills?|technolog|tech stack)/i,
  },
  extraLocator('certifications', /certif|licen[cs]e/i),
  extraLocator('projects', /project/i),
  extraLocator('volunteering', /volunteer/i),
  extraLocator('awards', /award|honou?r/i),
  extraLocator('publications', /publication/i),
  extraLocator('courses', /course|training/i),
  extraLocator('languages', /language/i),
  extraLocator('interests', /interest|hobb/i),
  extraLocator('references', /reference/i),
  // Never found from a heading: a custom section has none that is fixed. Its
  // generated blocks are found by their comments, like every other kind's.
  { kind: 'customSections', className: 'section-custom', dataSections: ['customSections'], fields: ['customSections'], heading: /$^/ },
];

export function sectionLocator(kind: SectionKind | 'customSections'): SectionLocator {
  const found = SECTION_LOCATORS.find((locator) => locator.kind === kind);
  if (!found) throw new Error(`No section locator for ${kind}`);
  return found;
}

/** The macro a template carries where the extra sections print; `expandExtraSectionsMacro` replaces it. */
export const EXTRA_SECTIONS_MACRO = /\{\{>\s*extra-sections\b([^}]*)\}\}/g;

/** Whether the markup prints a field itself - a loop over it, a guard on it, an inline print. */
export function templateNamesField(html: string, field: string): boolean {
  return new RegExp(`\\{\\{[#\\w\\s]*${escapeRegExp(field)}\\b`).test(html);
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Where the element opened at `from` closes, counting nested elements of the same name; -1 if never. */
export function findClosingTag(html: string, tagName: string, from: number): number {
  const tags = new RegExp(`<(/?)${escapeRegExp(tagName)}(?![\\w-])[^>]*>`, 'gi');
  tags.lastIndex = from;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = tags.exec(html)) !== null) {
    if (match[1]) {
      depth -= 1;
      if (depth === 0) return tags.lastIndex;
    } else if (!match[0].endsWith('/>')) {
      depth += 1;
    }
  }
  return -1;
}

/**
 * The next element at or after `from` whose opening tag matches `opener` (a
 * global pattern capturing the tag name first), from its opening tag to the end
 * of its closing one.
 */
function nextElementOpenedBy(html: string, opener: RegExp, from: number): MarkupSpan | null {
  opener.lastIndex = from;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(html)) !== null) {
    const end = findClosingTag(html, match[1], opener.lastIndex);
    if (end !== -1) return { start: match.index, end };
  }
  return null;
}

/**
 * The next element at or after `from` whose class list holds `className` as a
 * whole token, from its opening tag to the end of its closing one.
 *
 * Anchored on the tag that CARRIES the class. The version this replaced found
 * the class name anywhere and then took the nearest `<div` before it - which
 * for `<div class="main">...<section class="section-strengths">` was the main
 * column, so stripping Strengths took Experience with it. A class named in a
 * stylesheet is not an opening tag, so a `<style>` is never mistaken for one.
 */
export function nextClassedElement(html: string, className: string, from: number): MarkupSpan | null {
  return nextElementOpenedBy(
    html,
    new RegExp(
      `<([a-zA-Z][\\w-]*)\\b[^>]*?(?<![\\w-])class\\s*=\\s*(["'])(?:(?!\\2)[\\s\\S])*?` +
        `(?<![\\w-])${escapeRegExp(className)}(?![\\w-])(?:(?!\\2)[\\s\\S])*?\\2[^>]*>`,
      'g'
    ),
    from
  );
}

/** The next element at or after `from` carrying `data-section="<one of names>"`. */
export function nextDataSectionElement(html: string, names: readonly string[], from: number): MarkupSpan | null {
  return nextElementOpenedBy(
    html,
    new RegExp(
      `<([a-zA-Z][\\w-]*)\\b[^>]*?(?<![\\w-])data-section\\s*=\\s*(["'])\\s*` +
        `(?:${names.map(escapeRegExp).join('|')})\\s*\\2[^>]*>`,
      'g'
    ),
    from
  );
}

/** `{{#if field.length}}` or `{{#if field}}` - an empty list is falsy either way. */
export function guardOpenerPattern(field: string): string {
  return `\\{\\{#if\\s+${escapeRegExp(field)}(?:\\.length)?\\s*\\}\\}`;
}

/**
 * The `{{#if field.length}} ... {{/if}}` immediately around [start, end), when
 * there is one - both halves, or neither. Taking only the opening half would
 * leave its `{{/if}}` behind and the template would no longer compile.
 */
export function sectionGuardAround(html: string, start: number, end: number, field: string): MarkupSpan | null {
  const before = new RegExp(`${guardOpenerPattern(field)}\\s*$`).exec(html.slice(0, start));
  const after = /^\s*\{\{\/if\s*\}\}/.exec(html.slice(end));
  return before && after ? { start: start - before[0].length, end: end + after[0].length } : null;
}

/** Whether `pos` falls inside a tag (`<div title="{{join softSkills}}">`) rather than between tags. */
function insideTag(html: string, pos: number): boolean {
  return html.lastIndexOf('<', pos) > html.lastIndexOf('>', pos - 1);
}

/**
 * Where the markup prints the field's list: every `{{#each field}} ...
 * {{/each}}` with its own closing tag (nested loops counted), and every
 * mustache that prints the whole list inline - `{{join softSkills ", "}}`, the
 * app's own helper, or a bare `{{softSkills}}` - outside those loops and
 * outside a tag. `inferTemplateCapabilities` offers the switch for both, so
 * both have to be findable: a `join` section used to keep its heading because
 * only loops were looked for.
 */
export function sectionLoops(html: string, field: string): MarkupSpan[] {
  const loops: MarkupSpan[] = [];
  const opener = new RegExp(`\\{\\{#each\\s+${escapeRegExp(field)}(?![\\w.])[^}]*\\}\\}`, 'g');
  let match: RegExpExecArray | null;
  while ((match = opener.exec(html)) !== null) {
    const blocks = /\{\{(#each\b|\/each\s*\}\})/g;
    blocks.lastIndex = opener.lastIndex;
    let depth = 1;
    let token: RegExpExecArray | null;
    while ((token = blocks.exec(html)) !== null) {
      depth += token[1].startsWith('#') ? 1 : -1;
      if (depth === 0) break;
    }
    if (depth !== 0 || !token) continue;
    loops.push({ start: match.index, end: blocks.lastIndex });
    opener.lastIndex = blocks.lastIndex;
  }

  const inline = new RegExp(
    `\\{\\{\\{?~?\\s*(?:[a-zA-Z_][\\w-]*\\s+)?${escapeRegExp(field)}(?![\\w.-])[^{}]*\\}\\}\\}?`,
    'g'
  );
  const inLoop = (pos: number) => loops.some((loop) => pos >= loop.start && pos < loop.end);
  const printed: MarkupSpan[] = [];
  while ((match = inline.exec(html)) !== null) {
    if (inLoop(match.index) || insideTag(html, match.index)) continue;
    printed.push({ start: match.index, end: inline.lastIndex });
  }
  return [...loops, ...printed].sort((a, b) => a.start - b.start);
}

/** Elements that never close: an opening tag of one of these is no ancestor. */
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr',
]);

/** The elements open at `pos`, outermost first, each as its own span. */
export function ancestorsAt(html: string, pos: number): MarkupSpan[] {
  const open: Array<{ name: string; start: number; openEnd: number }> = [];
  const tags = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)\b[^>]*>/g;
  let match: RegExpExecArray | null;
  while ((match = tags.exec(html)) !== null && match.index < pos) {
    if (!match[2]) continue;
    const name = match[2].toLowerCase();
    if (match[1]) {
      const at = open.map((tag) => tag.name).lastIndexOf(name);
      if (at !== -1) open.length = at;
      continue;
    }
    if (VOID_ELEMENTS.has(name) || match[0].endsWith('/>')) continue;
    if (name === 'style' || name === 'script') {
      const close = findClosingTag(html, name, tags.lastIndex);
      if (close === -1 || close > pos) return [];
      tags.lastIndex = close;
      continue;
    }
    open.push({ name, start: match.index, openEnd: tags.lastIndex });
  }
  const spans: MarkupSpan[] = [];
  for (const tag of open) {
    const end = findClosingTag(html, tag.name, tag.openEnd);
    if (end === -1) return spans;
    spans.push({ start: tag.start, end });
  }
  return spans;
}

/** What a reader sees of a fragment: no tags, no stylesheet, entities for spaces read as spaces. */
export function visibleText(fragment: string): string {
  return fragment
    .replace(/<(style|script)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A fragment with the section's own loop and guard taken out - what is left
 * is everything ELSE an element around the loop holds. Null when what is left
 * still holds template data (another loop, `{{summary}}`, an `{{#if}}` of
 * something else): an element like that is somebody's column, not this
 * section, and removing it would take that data with it.
 *
 * Also null when the section's guards in the fragment do not pair up INSIDE
 * it - `<div>{{#if strengths.length}}<h3>..</h3>{{#each}}..</div>{{/if}}`,
 * valid Handlebars around mis-nested HTML. Counting openers and deleting as
 * many `{{/if}}` once took the div with its opener and left the `{{/if}}`
 * outside it dangling, and the template stopped compiling for every profile
 * with the switch off.
 */
function besidesTheLoop(fragment: string, loop: MarkupSpan, offset: number, field: string): string | null {
  const rest = `${fragment.slice(0, loop.start - offset)}${fragment.slice(loop.end - offset)}`;
  const guards = new RegExp(`${guardOpenerPattern(field)}|\\{\\{\\/if\\s*\\}\\}`, 'g');
  let depth = 0;
  for (const token of rest.match(guards) ?? []) {
    if (token.startsWith('{{#')) depth += 1;
    else if (depth === 0) return null;
    else depth -= 1;
  }
  if (depth !== 0) return null;
  const left = rest.replace(guards, '');
  return /\{\{/.test(left) ? null : left;
}

/** The longest text a heading may read - a heading, not a paragraph about the section. */
const MAX_SECTION_HEADING_TEXT = 60;

function readsAsHeading(text: string, heading: RegExp): boolean {
  return text.length > 0 && text.length <= MAX_SECTION_HEADING_TEXT && heading.test(text);
}

/**
 * Markup that shows something even with no text in it: a picture or other
 * media, an image drawn by CSS (`style="background:url(...)"`), or a
 * stylesheet or script, which the rest of the page needs. `visibleText` reads
 * all of these as nothing, which is how a sidebar's photo once went with the
 * Strengths heading beside it.
 */
function holdsContent(markup: string): boolean {
  return (
    /<(?:img|svg|picture|video|audio|canvas|iframe|object|embed|style|script|link)\b/i.test(markup) ||
    /<[a-zA-Z][^>]*\burl\s*\(/i.test(markup)
  );
}

/** Markup that shows nothing of its own: a divider, a line break, an empty box - no text, no content, no data. */
function showsNothing(markup: string): boolean {
  return !/\{\{/.test(markup) && !visibleText(markup) && !holdsContent(markup);
}

/** A fragment's top-level pieces in order: each element whole, each lone tag or comment, each run of text. */
function topLevelPieces(fragment: string): MarkupSpan[] {
  const pieces: MarkupSpan[] = [];
  const tags = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)\b[^>]*>/g;
  let at = 0;
  let match: RegExpExecArray | null;
  while ((match = tags.exec(fragment)) !== null) {
    if (match.index > at) pieces.push({ start: at, end: match.index });
    let end = tags.lastIndex;
    const name = match[2]?.toLowerCase();
    if (name && !match[1] && !VOID_ELEMENTS.has(name) && !match[0].endsWith('/>')) {
      // An element never closed is a lone tag, and what follows it is a sibling.
      const close = findClosingTag(fragment, name, tags.lastIndex);
      if (close !== -1) end = close;
    }
    pieces.push({ start: match.index, end });
    at = end;
    tags.lastIndex = end;
  }
  if (at < fragment.length) pieces.push({ start: at, end: fragment.length });
  return pieces;
}

/**
 * Whether an element's inside, with the section's loop and guard already
 * taken out, is the section and nothing else: ONE piece - an element or a run
 * of text - that reads as its heading, and beside it only markup that shows
 * nothing (`showsNothing`: the loop's emptied list, a divider, whitespace).
 *
 * Measuring the whole inside instead - "is all its text short and about
 * strengths?" - took a grid sidebar holding a photo, the Strengths heading and
 * "References / Available upon request" whole: the photo read as no text, and
 * "Strengths References Available upon request" is under 60 characters. A
 * line of text, a picture or an icon beside the heading now keeps the
 * element, and only the heading and the list go (`sectionOfLoop`'s second
 * step).
 */
function holdsOnlyTheSection(inner: string, heading: RegExp): boolean {
  for (const piece of topLevelPieces(inner)) {
    if (!readsAsHeading(visibleText(inner.slice(piece.start, piece.end)), heading)) continue;
    if (showsNothing(`${inner.slice(0, piece.start)}${inner.slice(piece.end)}`)) return true;
  }
  return false;
}

/** The element whose closing tag ends exactly at `end`, from its opening tag, or null. */
function elementEndingAt(html: string, end: number): MarkupSpan | null {
  const closing = /<\/([a-zA-Z][\w-]*)\s*>$/.exec(html.slice(0, end));
  if (!closing) return null;
  const name = closing[1];
  const tags = new RegExp(`<(/?)${escapeRegExp(name)}(?![\\w-])[^>]*>`, 'gi');
  const found: Array<{ index: number; closing: boolean; selfClosing: boolean }> = [];
  let match: RegExpExecArray | null;
  const head = html.slice(0, closing.index);
  while ((match = tags.exec(head)) !== null) {
    found.push({ index: match.index, closing: Boolean(match[1]), selfClosing: match[0].endsWith('/>') });
  }
  let depth = 1;
  for (let i = found.length - 1; i >= 0; i -= 1) {
    const tag = found[i];
    if (tag.closing) depth += 1;
    else if (!tag.selfClosing) depth -= 1;
    if (depth === 0) return { start: tag.index, end };
  }
  return null;
}

/**
 * The element before `pos`, past whitespace, comments and anything between
 * that shows nothing of its own (`showsNothing`) - a divider under a heading
 * (`<hr>`, `<div class="rule"></div>`), the line break after a label
 * (`<b>Strengths</b><br>`) - or null. What it steps over lies between the
 * element and `pos`, so a cut from the element to `pos` takes it too; looking
 * only at the element right before `pos` found the divider, not the heading,
 * and left the heading printed.
 */
function previousSiblingElement(html: string, pos: number): MarkupSpan | null {
  let end = pos;
  for (;;) {
    const trimmed = html.slice(0, end).replace(/\s+$/, '');
    if (trimmed.endsWith('-->')) {
      const open = trimmed.lastIndexOf('<!--');
      if (open === -1) return null;
      end = open;
      continue;
    }
    end = trimmed.length;
    const lone = /<([a-zA-Z][\w-]*)\b[^<>]*>$/.exec(trimmed);
    if (lone && (VOID_ELEMENTS.has(lone[1].toLowerCase()) || lone[0].endsWith('/>'))) {
      if (!showsNothing(lone[0])) return null;
      end = lone.index;
      continue;
    }
    const element = elementEndingAt(html, end);
    if (!element || !showsNothing(html.slice(element.start, element.end))) return element;
    end = element.start;
  }
}

/**
 * The section a `{{#each field}}` loop (or an inline `{{join field}}`,
 * `sectionLoops`) belongs to, in markup that marks it neither by class nor by
 * `data-section` - an uploaded template, typically, whose heading the class
 * strip could never see, so a switched-off section left its title over an
 * emptied list:
 *
 * 1. the NEAREST element around the loop that holds the section and nothing
 *    else (`holdsOnlyTheSection`: its heading, the loop, markup that shows
 *    nothing - `<div><h3>Strengths</h3>{{#each strengths}}...</div>`);
 *    climbing stops at the first element that holds anything else - another
 *    loop, the summary, a line of text, a photo - because that one is a
 *    column, not the section, and everything further out holds it too;
 * 2. otherwise the loop's container - the outermost element around it that
 *    holds nothing but the loop (or the loop itself, written straight into a
 *    column) - with a guard right around it, plus the heading ELEMENT before
 *    it, past any divider (`<h3>Strengths</h3>{{#if strengths.length}}<ul>...</ul>{{/if}}`).
 *
 * Null when neither is found: the loop then renders nothing once the data is
 * gated, and no guess removes markup that might be something else.
 */
function sectionOfLoop(html: string, loop: MarkupSpan, locator: SectionLocator, field: string): MarkupSpan | null {
  const ancestors = ancestorsAt(html, loop.start).filter((span) => span.end >= loop.end).reverse();

  let container: MarkupSpan = loop;
  for (const ancestor of ancestors) {
    const rest = besidesTheLoop(html.slice(ancestor.start, ancestor.end), loop, ancestor.start, field);
    if (rest === null) break;
    // Its inside: the element's own tags are no part of what it holds.
    const inner = rest.replace(/^<[^>]*>/, '').replace(/<\/[^>]*>$/, '');
    if (holdsOnlyTheSection(inner, locator.heading)) return ancestor;
    if (!showsNothing(inner)) break;
    container = ancestor;
  }

  const core = sectionGuardAround(html, container.start, container.end, field) ?? container;
  const heading = previousSiblingElement(html, core.start);
  if (!heading) return null;
  const headingMarkup = html.slice(heading.start, heading.end);
  if (/\{\{/.test(headingMarkup) || !readsAsHeading(visibleText(headingMarkup), locator.heading)) return null;
  return { start: heading.start, end: core.end };
}

/** A span widened to every `{{#if field.length}}` guard right around it - an outer `{{#if}}` a template wrote twice is still one section. */
function withGuards(html: string, span: MarkupSpan, fields: readonly string[]): MarkupSpan {
  let current = span;
  for (;;) {
    let widened: MarkupSpan | null = null;
    for (const field of fields) {
      widened = sectionGuardAround(html, current.start, current.end, field);
      if (widened) break;
    }
    if (!widened) return current;
    current = widened;
  }
}

/**
 * Every occurrence of one kind of section in a template's markup, each with
 * the `{{#if field.length}}` guard right around it when it has one - the ONE
 * answer to "where is this section", used by the strip (switched off), the
 * guard (switched on, so an empty list leaves no heading) and the reorder. In
 * order:
 *
 * 1. an element carrying the marker class (`section-strengths`,
 *    `section-projects`) - every built-in, the manual builder, the generated
 *    blocks;
 * 2. an element carrying `data-section="<one of its names>"`;
 * 3. otherwise, from each `{{#each field}}` loop (or inline `{{join field}}`)
 *    outside those, the element around it that holds the section and
 *    nothing else, or its container and the heading element before it
 *    (`sectionOfLoop`). Skipped when `finds` is 'marked'.
 *
 * Compile time only: the stored template is never rewritten, and the compile
 * cache is keyed on the markup plus the choices, so nothing found here is
 * stored anywhere. Overlapping finds are merged, so a cut never splits one.
 */
export function findSections(html: string, locator: SectionLocator, finds: SectionFinds = 'all'): MarkupSpan[] {
  const found: MarkupSpan[] = [];
  const inside = (pos: number) => found.some((span) => pos >= span.start && pos < span.end);

  for (let from = 0; ; ) {
    const element = nextClassedElement(html, locator.className, from);
    if (!element) break;
    found.push(element);
    from = element.end;
  }
  for (let from = 0; ; ) {
    const element = nextDataSectionElement(html, locator.dataSections, from);
    if (!element) break;
    if (!inside(element.start)) found.push(element);
    from = element.end;
  }
  if (finds === 'all') {
    for (const field of locator.fields) {
      for (const loop of sectionLoops(html, field)) {
        if (inside(loop.start)) continue;
        const unit = sectionOfLoop(html, loop, locator, field);
        if (unit && !inside(unit.start)) found.push(unit);
      }
    }
  }

  const merged: MarkupSpan[] = [];
  for (const span of found.sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1];
    if (last && span.start < last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged.map((span) => withGuards(html, span, locator.fields));
}

/** One section of a template, located: which (`projects`, `custom:cs-1a2b`), and where. */
export type LocatedSection = MarkupSpan & { ref: string };

/** The comments `expandExtraSectionsMacro` puts around each block it generates. */
const GENERATED_BLOCK = new RegExp(
  `<!--xs:((?:${SECTION_KIND_IDS.join('|')})|custom:[a-z0-9-]{1,40})-->[\\s\\S]*?<!--/xs:\\1-->`,
  'g'
);

/**
 * Every section the markup has, by kind or custom ref, in document order:
 * the generated blocks by their comments first (and nothing is looked for
 * inside them), then each kind by `findSections`. A span inside another is
 * dropped, so what comes back never nests and a reorder can move each span
 * whole.
 */
export function locateSections(html: string, finds: SectionFinds = 'all'): LocatedSection[] {
  const located: LocatedSection[] = [];
  const inside = (pos: number) => located.some((span) => pos >= span.start && pos < span.end);

  GENERATED_BLOCK.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = GENERATED_BLOCK.exec(html)) !== null) {
    located.push({ ref: match[1], start: match.index, end: GENERATED_BLOCK.lastIndex });
  }
  for (const locator of SECTION_LOCATORS) {
    if (locator.kind === 'customSections') continue;
    for (const span of findSections(html, locator, finds)) {
      if (inside(span.start)) continue;
      // A span that holds an earlier find whole is its column, not a section.
      if (located.some((other) => other.start >= span.start && other.end <= span.end)) continue;
      located.push({ ref: locator.kind, ...span });
    }
  }
  return located.sort((a, b) => a.start - b.start);
}

/**
 * The key of the element a section sits in: the innermost element open at its
 * start that holds it whole - its column, in a two-column template - or -1
 * for a fragment with nothing around it. Sections sharing a key are siblings a
 * reorder may swap; ones that do not are in different columns, and a stored
 * order never moves a section out of the column its template put it in.
 */
export function parentKeyOf(html: string, span: MarkupSpan): number {
  const holding = ancestorsAt(html, span.start).filter((ancestor) => ancestor.end >= span.end);
  return holding.length > 0 ? holding[holding.length - 1].start : -1;
}

/**
 * The order a template prints its sections in, by its own markup: every kind
 * located in document order, first occurrence each, and - where the markup
 * carries the extra-sections macro - the kinds the macro will generate, in
 * canonical order, at the first macro's position. Custom sections are never
 * in it (nothing fixed marks one). What the editor shows a profile with no
 * stored order in, and what `printsSections` is read beside.
 */
export function inferNativeSectionOrder(html: string): string[] {
  const source = typeof html === 'string' ? html : '';
  const placed: Array<{ ref: string; at: number; tie: number }> = [];
  const seen = new Set<string>();
  for (const section of locateSections(source, 'all')) {
    if (seen.has(section.ref) || section.ref.startsWith('custom:')) continue;
    seen.add(section.ref);
    placed.push({ ref: section.ref, at: section.start, tie: 0 });
  }
  EXTRA_SECTIONS_MACRO.lastIndex = 0;
  const macro = EXTRA_SECTIONS_MACRO.exec(source);
  if (macro) {
    EXTRA_SECTION_KINDS.forEach((kind, index) => {
      if (seen.has(kind) || templateNamesField(source.replace(EXTRA_SECTIONS_MACRO, ''), kind)) return;
      seen.add(kind);
      placed.push({ ref: kind, at: macro.index, tie: index + 1 });
    });
  }
  return placed.sort((a, b) => a.at - b.at || a.tie - b.tie).map((entry) => entry.ref);
}

/** Whether a custom section's key may stand in a class, an attribute and a Handlebars string literal. */
export function isGeneratableCustomKey(key: string): boolean {
  return CUSTOM_KEY_PATTERN.test(key);
}
