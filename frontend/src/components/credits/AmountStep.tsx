'use client';

import { useId } from 'react';
import { IconCheck, IconPlus } from '@/components/icons';
import { CHOICE, CHOICE_ON, FIELD, LABEL, QUIET } from './chrome';
import { describeFitted, readPurchaseAmount } from './order';
import { formatMoney, MILLI_PER_DOLLAR, toDollarInput } from '@/lib/format';
import type { PaymentTarget } from '@/lib/payments';

/**
 * Step 2: how much.
 *
 * Six presets and one custom control, both bounded by the chosen target's own
 * limits. **A credit is a dollar**, so what is chosen here is an amount of
 * money: the buyer is charged exactly it, and exactly it goes on the balance -
 * nothing taken out, nothing to convert. The presets are the server's amounts,
 * and the custom box takes dollars and cents as typed, read by the same parser
 * the server uses (lib/format.ts), so a box that shows "$12.50 will be bought"
 * is never contradicted by the summary.
 *
 * The stepper steps a whole dollar at a time; the slider a cent. Both stay
 * inside the method's bounds, and the box beside them is where an exact amount
 * goes.
 */

/** The stepper's stride: one dollar. */
const STEP_MILLI = MILLI_PER_DOLLAR;

/** The slider's stride: one cent, so every amount between the bounds is on it. */
const SLIDER_STEP_MILLI = 10;

export default function AmountStep({
  target,
  amount,
  onAmount,
}: {
  target: PaymentTarget;
  /** What is in the box, as typed. */
  amount: string;
  onAmount: (amount: string) => void;
}) {
  const fieldId = useId();
  const hintId = useId();
  /*
   * The total is the FITTED amount, because that is the one that gets bought.
   *
   * The box itself stays unfitted while it is being typed - a minimum of $50
   * would otherwise make "120" impossible to type. But the figure beside it,
   * and the one on the Continue button, have to be what the next step will
   * charge: showing $1 and then opening a $2.50 order is the page quoting a
   * price of its own, which is the one thing this flow must never do.
   */
  const read = readPurchaseAmount(amount, target);
  const buying = read.ok ? read.milli : null;
  const atPreset = buying !== null && target.presets.some((preset) => preset.amountMilli === buying);
  const step = (direction: 1 | -1) => {
    const from = buying ?? target.minAmountMilli;
    const next = Math.min(Math.max(from + direction * STEP_MILLI, target.minAmountMilli), target.maxAmountMilli);
    onAmount(toDollarInput(next));
  };

  return (
    <div className="space-y-6">
      <section>
        <h3 className={LABEL}>Choose an amount</h3>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {target.presets.map((preset) => {
            const on = preset.amountMilli === buying;
            return (
              <button
                key={preset.amountMilli}
                type="button"
                aria-pressed={on}
                // `.tl-choice` draws the selected state from this attribute.
                data-on={on}
                onClick={() => onAmount(toDollarInput(preset.amountMilli))}
                className={`${on ? CHOICE_ON : CHOICE} relative`}
              >
                <span className="min-w-0 text-sm font-semibold tabular-nums text-ink">
                  {formatMoney(preset.amountMilli)}
                </span>
                {on && (
                  <IconCheck className="absolute right-2 top-2 h-3.5 w-3.5 text-accent-ink" />
                )}
              </button>
            );
          })}
          {target.presets.length === 0 && (
            <p className="col-span-full text-sm text-muted">
              No preset amount fits this method&apos;s limits. Use the box below.
            </p>
          )}
        </div>
      </section>

      <section>
        <h3 className={LABEL}>{atPreset ? 'Or choose your own' : 'Your amount'}</h3>

        <div className="mt-2 flex flex-wrap items-center gap-3">
          {target.custom === 'stepper' && (
            <button
              type="button"
              aria-label="One dollar less"
              disabled={buying !== null && buying <= target.minAmountMilli}
              onClick={() => step(-1)}
              className={QUIET}
            >
              {/* No minus icon in the set, and one path is not worth adding
                  one for: a rotated plus is the same two strokes. */}
              <span aria-hidden className="text-lg leading-none">
                &minus;
              </span>
            </button>
          )}

          <label htmlFor={fieldId} className="sr-only">
            Amount in dollars
          </label>
          {/* The width is on boxes around it: `.tl-input` is always full width, and an
              input in a flex row would not shrink below its own default size. */}
          <div className="flex w-36 items-center gap-1.5">
            <span aria-hidden className="text-sm font-semibold text-muted">
              $
            </span>
            <div className="min-w-0 flex-1">
              <input
                id={fieldId}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={amount}
                aria-describedby={hintId}
                aria-invalid={!read.ok}
                onChange={(event) => onAmount(event.target.value)}
                // Fitted on the way OUT, not on the way in: fitting each
                // keystroke makes "120" unreachable when the minimum is 50 - the
                // 1 snaps to 50 before the 2 is typed. An amount that is not one
                // is left as typed, with the reason below it.
                onBlur={() => {
                  if (read.ok) onAmount(toDollarInput(read.milli));
                }}
                placeholder="25.00"
                className={`${FIELD} text-center tabular-nums`}
              />
            </div>
          </div>

          {target.custom === 'stepper' && (
            <button
              type="button"
              aria-label="One dollar more"
              disabled={buying !== null && buying >= target.maxAmountMilli}
              onClick={() => step(1)}
              className={QUIET}
            >
              <IconPlus className="h-4 w-4" />
            </button>
          )}

          <div className="ml-auto text-right">
            <div className={LABEL}>Total</div>
            <div className="text-2xl font-semibold tabular-nums text-ink">
              {buying === null ? '—' : formatMoney(buying)}
            </div>
          </div>
        </div>

        {target.custom === 'slider' && (
          <input
            type="range"
            aria-label="Amount"
            min={target.minAmountMilli}
            max={target.maxAmountMilli}
            step={SLIDER_STEP_MILLI}
            value={buying ?? target.minAmountMilli}
            onChange={(event) => {
              const milli = Number(event.target.value);
              if (Number.isSafeInteger(milli)) onAmount(toDollarInput(milli));
            }}
            className="mt-4 w-full accent-accent"
          />
        )}

        {!read.ok ? (
          <p className="tl-status mt-3" data-tone="error" role="alert">
            {read.message}
          </p>
        ) : read.fitted !== null ? (
          <p className="tl-status mt-3" data-tone="error">
            {describeFitted(read, target)}
          </p>
        ) : null}

        <p id={hintId} className="mt-3 text-xs text-subtle">
          A credit is a dollar: you are charged exactly this amount, and all of it is added to your
          balance. Each resume costs the price set for the model it is built with. Between{' '}
          {formatMoney(target.minAmountMilli)} and {formatMoney(target.maxAmountMilli)} at a time
          {target.custom === 'stepper' ? ', a dollar at a time on the buttons.' : '.'}
        </p>
      </section>
    </div>
  );
}
