import type { PaymentTargetLimits, PaymentTargetLimitsInput } from '@/lib/api';
import { formatMoney, parseDollars, toDollarInput } from '@/lib/format';

/**
 * Admin -> Payments' purchase limits, while they are being edited, with no
 * React in them (backend/test/frontendSettings.test.js and frontendMoney run
 * them). The one runtime import is lib/format.ts.
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

/**
 * Whether the rows as typed differ from the limits in effect: a row added,
 * removed or reordered, or an amount that reads differently - "2.5" for a
 * stored $2.50 is no change. An untouched form is never a change, so Save
 * sends no limits and a `.env` value stays `.env`'s.
 */
export function limitsChanged(drafts: LimitDraft[], current: PaymentTargetLimits[]): boolean {
  if (drafts.length !== current.length) return true;
  return drafts.some((draft, index) => {
    const row = current[index];
    const typed = toLimitRow(draft);
    if (typed.target !== row.target) return true;
    if (amountOrText(typed.minUsd) !== row.minMilli || amountOrText(typed.maxUsd) !== row.maxMilli) return true;
    if (typed.presetsUsd.length !== row.presetsMilli.length) return true;
    return typed.presetsUsd.some((preset, position) => amountOrText(preset) !== row.presetsMilli[position]);
  });
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
