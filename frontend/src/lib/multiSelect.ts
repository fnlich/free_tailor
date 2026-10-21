/**
 * What the MultiSelect kit component (components/ui/MultiSelect.tsx) decides,
 * with no React in it: which options a typed filter leaves, choosing and
 * un-choosing a value, typed text turned into values, where the active
 * option moves (and is once one is chosen), how far the list scrolls to show
 * it, and what the live region says. Imports nothing, so
 * backend/test/frontendFindJobs.test.js runs it as it is.
 */

/** One choice of a box: `id` is the value it adds, `label` what it shows, under `group` when the list is grouped. */
export type MultiSelectOption = { id: string; label: string; group?: string; hint?: string };

/** A label or a typed value as compared: trimmed, single-spaced, lower case. */
function folded(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * The options a typed filter leaves, in their own order: every word typed is
 * in the label (or the id), case aside. Nothing typed leaves them all.
 */
export function matchingOptions(options: readonly MultiSelectOption[], typed: string): MultiSelectOption[] {
  const words = folded(typed).split(' ').filter(Boolean);
  if (words.length === 0) return [...options];
  return options.filter((option) => {
    const haystack = `${folded(option.label)} ${folded(option.id)}`;
    return words.every((word) => haystack.includes(word));
  });
}

/**
 * The values with `id` added - or taken out, when it is chosen already.
 * Adding past `max` changes nothing (`refused`), and a box never holds the
 * same value twice.
 */
export function toggleValue(
  values: readonly string[],
  id: string,
  max?: number
): { values: string[]; refused: boolean } {
  if (values.includes(id)) return { values: values.filter((value) => value !== id), refused: false };
  if (max !== undefined && values.length >= max) return { values: [...values], refused: true };
  return { values: [...values, id], refused: false };
}

/**
 * Typed text as values: split where `split` says (Full text splits keywords
 * on commas; Company never splits - "OpenAI, Inc." is one company), each part
 * trimmed and single-spaced, a part already chosen - case aside - skipped,
 * and nothing added past `max` (`full`). `added` is what went in.
 */
export function addTypedValue(
  values: readonly string[],
  typed: string,
  options: { split?: RegExp; max?: number } = {}
): { values: string[]; added: string[]; full: boolean } {
  const parts = (options.split ? typed.split(options.split) : [typed])
    .map((part) => part.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
  const next = [...values];
  const added: string[] = [];
  let full = false;
  for (const part of parts) {
    if (next.some((value) => folded(value) === folded(part))) continue;
    if (options.max !== undefined && next.length >= options.max) {
      full = true;
      break;
    }
    next.push(part);
    added.push(part);
  }
  return { values: next, added, full };
}

/**
 * Where the active option moves: `step` 1 (ArrowDown) or -1 (ArrowUp) from
 * `current` (-1: none yet), wrapping at either end; -1 when there is no
 * option to move to.
 */
export function nextActiveIndex(current: number, count: number, step: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return step === 1 ? 0 : count - 1;
  return (current + step + count) % count;
}

/**
 * The active option once one was chosen. Choosing clears what was typed, so a
 * list the typing had filtered is drawn whole again: the option just chosen
 * stays the active one, at its place in the whole list - never whatever
 * option now stands where it stood in the filtered one, which the next Enter
 * would choose unseen. Options that were the server's matches for what was
 * typed (`filterOptions` false: Company's suggestions) go with the typing, so
 * nothing is active. With nothing typed the list is as it was.
 */
export function activeAfterChoice(
  options: readonly MultiSelectOption[],
  chosenId: string,
  current: number,
  typed: string,
  filterOptions: boolean
): number {
  if (typed.trim() === '') return current;
  return filterOptions ? options.findIndex((option) => option.id === chosenId) : -1;
}

/**
 * How far a list that scrolls must move (its scrollTop, + down) so an option
 * is wholly in view: 0 when it already is. `view` is the list's visible box,
 * `item` the option's - with its group heading, when the heading sits right
 * above it, so moving up into a group shows the group's name too.
 */
export function revealOffset(view: { top: number; bottom: number }, item: { top: number; bottom: number }): number {
  if (item.top < view.top) return item.top - view.top;
  if (item.bottom > view.bottom) return Math.min(item.bottom - view.bottom, item.top - view.top);
  return 0;
}

/** A value as a chip shows it: its option's label, else the value itself (a company or a keyword typed). */
export function valueLabel(options: readonly MultiSelectOption[], value: string): string {
  return options.find((option) => option.id === value)?.label ?? value;
}

/**
 * What the live region says after the box changed: what went in and what
 * came out, by label, and how many are chosen now.
 */
export function describeChange(
  label: string,
  before: readonly string[],
  after: readonly string[],
  options: readonly MultiSelectOption[] = []
): string {
  const added = after.filter((value) => !before.includes(value)).map((value) => valueLabel(options, value));
  const removed = before.filter((value) => !after.includes(value)).map((value) => valueLabel(options, value));
  const parts = [
    ...(added.length > 0 ? [`Added ${added.join(', ')}`] : []),
    ...(removed.length > 0 ? [`Removed ${removed.join(', ')}`] : []),
  ];
  if (parts.length === 0) return '';
  return `${parts.join('. ')}. ${label}: ${after.length === 0 ? 'none chosen' : `${after.length} chosen`}.`;
}

/** What is said when a box is full. */
export function fullSentence(max: number): string {
  return `You can choose at most ${max} here.`;
}
