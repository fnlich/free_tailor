import type {
  PaymentLimitSource,
  PaymentTargetLimits,
  PaymentTargetLimitsInput,
  PaymentTargetLimitsReset,
} from '@/lib/api';
import { formatMoney, parseDollars, toDollarInput } from '@/lib/format';
import { sourceLabel, type SettingSource } from '@/lib/settingSources';

/**
 * Admin -> Payments' purchase limits, while they are being edited, with no
 * React in them (backend/test/frontendSettings.test.js and frontendMoney run
 * them). The runtime imports are lib/format.ts and lib/settingSources.ts.
 *
 * Strings, not numbers, and that is the point: an operator clearing a box to
 * retype it produces "" for a moment, and a number-typed state turns that into
 * NaN or - worse - silently into 0, which is a live setting that offers a
 * purchase of nothing. They are DOLLARS as typed ("2.50"), sent to the server
 * as typed, and the server parses them exactly and refuses anything that is
 * not a whole number of cents by name - so a bad value is reported on save
 * instead of applied.
 */
export type LimitDraft = {
  target: string;
  min: string;
  max: string;
  presets: string;
};

export function toLimitDraft(row: PaymentTargetLimits): LimitDraft {
  return {
    target: row.target,
    min: toDollarInput(row.minMilli),
    max: toDollarInput(row.maxMilli),
    presets: row.presetsMilli.map(toDollarInput).join(', '),
  };
}

export function toLimitRow(draft: LimitDraft): PaymentTargetLimitsInput {
  return {
    target: draft.target.trim(),
    minUsd: draft.min.trim(),
    maxUsd: draft.max.trim(),
    /*
     * Commas, spaces or both - an operator pasting a list should not have to
     * guess the separator. Each is sent as typed: one that is not an amount is
     * refused by the server naming the preset, rather than dropped here where
     * nobody would notice it went.
     */
    presetsUsd: draft.presets
      .split(/[\s,]+/)
      .map((part) => part.replace(/^\$/, ''))
      .filter(Boolean),
  };
}

/** One typed amount as thousandths, or the text itself when it is not an amount - so it can only equal itself. */
function amountOrText(text: string): number | string {
  const parsed = parseDollars(text);
  return parsed.ok ? parsed.milli : text.trim();
}

/** Whether a typed row reads as a method's limits in effect: "2.5" for a stored $2.50 is no change. */
function sameLimits(draft: LimitDraft, row: PaymentTargetLimits): boolean {
  const typed = toLimitRow(draft);
  if (typed.target !== row.target) return false;
  if (amountOrText(typed.minUsd) !== row.minMilli || amountOrText(typed.maxUsd) !== row.maxMilli) return false;
  if (typed.presetsUsd.length !== row.presetsMilli.length) return false;
  return typed.presetsUsd.every((preset, position) => amountOrText(preset) === row.presetsMilli[position]);
}

/**
 * What a save sends, PER METHOD: each method resolves on its own on the
 * server, so only the methods whose row was changed go - as typed - beside
 * any method added. A method's row taken off the page while it is set here
 * goes as its Reset to default (`{ target, reset: true }`); one that follows
 * `.env` has nothing stored to take away, and it comes back. Empty when
 * nothing changed: then nothing is sent, and no method's `.env` limits are
 * frozen by a save about another.
 */
export function limitChanges(
  drafts: LimitDraft[],
  current: PaymentTargetLimits[],
  sources: Record<string, PaymentLimitSource>
): Array<PaymentTargetLimitsInput | PaymentTargetLimitsReset> {
  const changes: Array<PaymentTargetLimitsInput | PaymentTargetLimitsReset> = [];
  for (const draft of drafts) {
    const row = current.find((entry) => entry.target === draft.target.trim());
    if (!row || !sameLimits(draft, row)) changes.push(toLimitRow(draft));
  }
  for (const row of current) {
    const kept = drafts.some((draft) => draft.target.trim() === row.target);
    if (!kept && sources[row.target]?.source === 'admin') changes.push({ target: row.target, reset: true });
  }
  return changes;
}

/**
 * The rows being edited after ONE method was reset: that method's row as the
 * server now has it, in its place (or gone, or added at the end), and every
 * other row as typed - a Reset never throws away what is typed elsewhere.
 */
export function replaceLimitDraft(drafts: LimitDraft[], rows: PaymentTargetLimits[], target: string): LimitDraft[] {
  const row = rows.find((entry) => entry.target === target);
  const at = drafts.findIndex((draft) => draft.target.trim() === target);
  if (at < 0) return row ? [...drafts, toLimitDraft(row)] : drafts;
  return row
    ? drafts.map((draft, position) => (position === at ? toLimitDraft(row) : draft))
    : drafts.filter((_, position) => position !== at);
}

/**
 * The words beside one method's row: "Set here", "From .env (NAME)" naming
 * only the variables that set it, or "Default".
 */
export function limitSourceLabel(target: string, sources: Record<string, PaymentLimitSource>): string {
  const entry = sources[target];
  return sourceLabel(entry?.source ?? 'default', entry?.variables ?? []);
}

/**
 * The words for the limits as a whole: "From .env (...)" names only the
 * variables that set a method's limits, never all four.
 */
export function allLimitsSourceLabel(source: SettingSource, sources: Record<string, PaymentLimitSource>): string {
  const variables = Object.values(sources).flatMap((entry) => (entry.source === 'env' ? entry.variables : []));
  return sourceLabel(source, [...new Set(variables)]);
}

/** What one method's Reset to default gives, in words: its default limits, or none of its own. */
export function describeLimitDefault(target: string, defaults: PaymentTargetLimits[]): string {
  const row = defaults.find((entry) => entry.target === target);
  return row
    ? `${formatMoney(row.minMilli)} to ${formatMoney(row.maxMilli)}`
    : 'no row of its own: its method\'s limits';
}

/** A method's name on the page. */
export function targetLabel(target: string): string {
  if (target === 'card') return 'Card';
  if (target === 'crypto') return 'Crypto — every coin';
  return target;
}

/**
 * The limits Reset to default gives, in words, for the source line: the
 * methods in the order the server sends them, "card $2.50 to $100".
 */
export function describeLimits(rows: PaymentTargetLimits[]): string {
  if (rows.length === 0) return 'the built-in limits';
  return rows
    .map((row) => `${row.target} ${formatMoney(row.minMilli)} to ${formatMoney(row.maxMilli)}`)
    .join(', ');
}
