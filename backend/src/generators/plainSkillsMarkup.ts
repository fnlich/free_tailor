import { insertStyleOnce } from './extraSectionsMarkup';
import { escapeRegExp, sectionLoops } from './sectionLocator';

/**
 * The Plain layout's safety net for a template written as a grid of category
 * cards.
 *
 * Plain reaches a `{{#each skillCategories}}` design as ONE group with no
 * heading (pdfGenerator.ts `flattenSkillCategories`), and the compile step
 * guards the empty heading away - but the group still sits in whatever box the
 * design gives a category: one cell of a three-column grid, one column of a
 * multi-column list, a float a third wide, a card with a fixed or minimum
 * height. Every template prints both layouts, so the compile step marks the
 * element that holds the loop with `data-plain-skills` and puts one small
 * stylesheet in the head that makes each child of it take the whole row:
 * `grid-column`, `column-span`, float, width and the heights. The holder is
 * marked rather than the item, so the rule reaches whatever the loop prints,
 * whatever its classes.
 *
 * Only an element that holds the loop and NOTHING else is a holder. The rule
 * is `!important` on every child, which beats a child's own inline style: a
 * sidebar holding the loop and then a divider, a badge or a photo lost their
 * sizes in Plain - the divider drawn by its height vanished, the photo came
 * out at its natural size - and an element that holds more than the skills is
 * the template's column, not its skills block.
 *
 * Plain only - Grouped is the design as written - and never the stored file:
 * this runs on the markup at compile time, and the compile cache is keyed on
 * the layout already.
 *
 * What it does not reach (README, Troubleshooting): a flex row with a fixed
 * `flex-basis` (a `flex: 1 1 100%` would stretch a column-flex sidebar too),
 * a loop in an element that holds anything else - a heading before it, a
 * divider or another block after it - and a template rule on the same
 * property that is `!important` and more specific. Burgundy Rule and Navy Rule
 * also carry a rule of their own in their stylesheets, so their Plain row does
 * not depend on this net finding their loop.
 */

export const PLAIN_SKILLS_ATTRIBUTE = 'data-plain-skills';
export const PLAIN_SKILLS_STYLE_ID = 'plain-skills-style';

const STYLE =
  `<style id="${PLAIN_SKILLS_STYLE_ID}">[${PLAIN_SKILLS_ATTRIBUTE}]>*{grid-column:1/-1!important;` +
  'column-span:all!important;float:none!important;width:auto!important;max-width:none!important;' +
  'height:auto!important;min-height:0!important}</style>';

/**
 * The opening tag right before a category loop: nothing between them but
 * whitespace and `{{#if ...}}` openers (a guard on the list, as uploaded
 * designs write one), and not one marked already. What follows the loop is
 * `closesRightAfter`'s to judge.
 */
const LOOP_HOLDER =
  /<([a-zA-Z][\w-]*)\b(?![^>]*\sdata-plain-skills\b)([^>]*)>(\s*(?:\{\{#if\s[^}]*\}\}\s*)*\{\{#each\s+skillCategories\b)/g;

/**
 * Elements never taken for the holder: those with no children, which hold
 * nothing a rule on their children could reach, and the document's own, whose
 * children are the page.
 */
const NOT_HOLDERS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
  'html',
  'head',
  'body',
]);

/**
 * Whether the holder closes right after its loop: past the loop's own
 * `{{/each}}` (`loopEnd`), nothing but whitespace, the `{{/if}}` of each guard
 * opened before the loop (`opening`), and the holder's closing tag. An
 * `{{else}}` on a guard is something else the holder would print.
 */
function closesRightAfter(html: string, loopEnd: number, tag: string, opening: string): boolean {
  const guards = (opening.match(/\{\{#if\s/g) ?? []).length;
  return new RegExp(`^(?:\\s*\\{\\{\\/if\\s*\\}\\}){${guards}}\\s*<\\/${escapeRegExp(tag)}\\s*>`, 'i').test(
    html.slice(loopEnd)
  );
}

/**
 * The markup with every element that holds a category loop and nothing else
 * marked, and the stylesheet once, before `</head>` - else right after a
 * leading doctype, so the document keeps its standards mode, else first.
 * Markup with no such holder comes back as it was. Idempotent.
 */
export function fitPlainSkillGroups(html: string): string {
  // Where each category loop ends - its own `{{/each}}`, nested loops counted - by where it opens.
  const loopEnds = new Map(
    sectionLoops(html, 'skillCategories')
      .filter((span) => html.startsWith('{{#each', span.start))
      .map((span) => [span.start, span.end] as const)
  );
  let marked = false;
  const output = html.replace(
    LOOP_HOLDER,
    (match: string, tag: string, attributes: string, opening: string, offset: number) => {
      if (NOT_HOLDERS.has(tag.toLowerCase()) || attributes.trimEnd().endsWith('/')) return match;
      const loopEnd = loopEnds.get(offset + match.lastIndexOf('{{#each'));
      if (loopEnd === undefined || !closesRightAfter(html, loopEnd, tag, opening)) return match;
      marked = true;
      return `<${tag}${attributes} ${PLAIN_SKILLS_ATTRIBUTE}>${opening}`;
    }
  );
  if (!marked) return html;
  const doctype = /^\s*<!DOCTYPE[^>]*>/i.exec(output);
  return insertStyleOnce(output, PLAIN_SKILLS_STYLE_ID, STYLE, doctype ? doctype[0].length : 0);
}
