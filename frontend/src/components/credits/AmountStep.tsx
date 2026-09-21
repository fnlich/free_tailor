'use client';

import { useId } from 'react';
import { IconCheck, IconPlus } from '@/components/icons';
import { CHOICE, CHOICE_ON, FIELD, LABEL } from './chrome';
import { formatAmount, type PaymentTarget } from '@/lib/payments';

/**
 * Step 2: how much.
 *
 * Six presets and one custom control, both bounded by the chosen target's own
 * limits. Two things about this are deliberate and neither is obvious.
 *
 * **Every figure shown is the server's.** A preset arrives as a COUNT with the
 * amount the server would charge for it, so a "$25.00" button renders a number
 * the server worked out rather than one this file multiplied. That is the
 * invariant the whole payments module exists to keep: the browser sends a
 * count and never a price, and it cannot display a price the server would not
 * charge because it never computes one. The only arithmetic here is on the
 * custom control, and it multiplies by the same `unitPriceCents` the server
 * quotes with - shown as a preview, and re-quoted server-side either way.
 *
 * **The stepper steps in credits, not in dollars**, even though the design it
 * follows says whole dollars. A credit is the atom: at 40c each, no whole
 * number of credits costs a whole number of dollars, so a dollar stepper would
 * either land on amounts that cannot be bought or quietly round somebody's
 * choice. It steps by the nearest whole count to a dollar instead, and says
 * what it is doing.
 */

/** About a dollar at a time, in whole credits, and at least one. */
function stepFor(unitPriceCents: number): number {
  if (unitPriceCents <= 0) return 1;
  return Math.max(1, Math.round(100 / unitPriceCents));
}

function clamp(credits: number, target: PaymentTarget): number {
  return Math.min(Math.max(credits, target.minCredits), target.maxCredits);
}

export default function AmountStep({
  target,
  credits,
  unitPriceCents,
  currency,
  onCredits,
}: {
  target: PaymentTarget;
  credits: number;
  unitPriceCents: number;
  currency: string;
  onCredits: (credits: number) => void;
}) {
  const fieldId = useId();
  const step = stepFor(unitPriceCents);
  /*
   * The total is the CLAMPED count, because that is the one that gets bought.
   *
   * The box itself stays unclamped while it is being typed - a maximum of 200
   * would otherwise make "2000" impossible to type, since the 2 snaps to 200
   * before the rest arrives. But the figure beside it, and the one on the
   * Continue button, have to be what the next step will charge: showing
   * `2000 x 50c` and then opening a $100 order is the page quoting a price of
   * its own, which is the one thing this flow must never do.
   */
  const buying = clamp(credits, target);
  const total = buying * unitPriceCents;
  const atPreset = target.presets.find((preset) => preset.credits === buying);
  const outOfRange = credits !== buying;

  return (
    <div className="space-y-6">
      <section>
        <h3 className={LABEL}>Choose an amount</h3>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {target.presets.map((preset) => {
            const on = preset.credits === buying;
            return (
              <button
                key={preset.credits}
                type="button"
                aria-pressed={on}
                onClick={() => onCredits(preset.credits)}
                className={`${on ? CHOICE_ON : CHOICE} relative`}
              >
                <span className="block text-sm font-semibold text-ink">
                  {formatAmount(preset.amountCents, currency)}
                </span>
                <span className="block text-xs text-subtle">
                  {preset.credits} {preset.credits === 1 ? 'credit' : 'credits'}
                </span>
                {on && (
                  <IconCheck className="absolute right-2 top-2 h-3.5 w-3.5 text-accent" />
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
        <h3 className={LABEL}>
          {atPreset ? 'Or choose your own' : 'Your amount'}
        </h3>

        <div className="mt-2 flex flex-wrap items-center gap-3">
          {target.custom === 'stepper' && (
            <button
              type="button"
              aria-label={`Fewer credits, ${step} at a time`}
              disabled={credits <= target.minCredits}
              onClick={() => onCredits(clamp(credits - step, target))}
              className="tl-icon-button border border-line disabled:opacity-40"
            >
              {/* No minus icon in the set, and one path is not worth adding
                  one for: a rotated plus is the same two strokes. */}
              <span aria-hidden className="text-lg leading-none">
                &minus;
              </span>
            </button>
          )}

          <label htmlFor={fieldId} className="sr-only">
            Number of credits
          </label>
          <input
            id={fieldId}
            type="number"
            inputMode="numeric"
            min={target.minCredits}
            max={target.maxCredits}
            value={credits}
            onChange={(event) => {
              const next = Number.parseInt(event.target.value, 10);
              // An empty or half-typed box must not throw the amount away, so
              // a value that is not a number leaves the last good one alone.
              if (Number.isInteger(next)) onCredits(next);
            }}
            // Clamped on the way OUT, not on the way in: clamping each
            // keystroke makes "12" unreachable when the minimum is 7 and the
            // maximum 9 - the 1 snaps to 9 before the 2 is typed.
            onBlur={() => onCredits(clamp(credits, target))}
            className={`${FIELD} w-24 text-center`}
          />

          {target.custom === 'stepper' && (
            <button
              type="button"
              aria-label={`More credits, ${step} at a time`}
              disabled={credits >= target.maxCredits}
              onClick={() => onCredits(clamp(credits + step, target))}
              className="tl-icon-button border border-line disabled:opacity-40"
            >
              <IconPlus className="h-4 w-4" />
            </button>
          )}

          <div className="ml-auto text-right">
            <div className={LABEL}>Total</div>
            <div className="text-2xl font-semibold text-ink">
              {formatAmount(total, currency)}
            </div>
          </div>
        </div>

        {target.custom === 'slider' && (
          <input
            type="range"
            aria-label="Number of credits"
            min={target.minCredits}
            max={target.maxCredits}
            step={1}
            value={credits}
            onChange={(event) => onCredits(Number.parseInt(event.target.value, 10))}
            className="mt-4 w-full accent-accent"
          />
        )}

        {outOfRange && (
          <p className="mt-3 text-sm text-red-700">
            {credits < target.minCredits
              ? `The smallest purchase is ${target.minCredits} credits. ${buying} will be bought.`
              : `The largest purchase is ${target.maxCredits} credits. ${buying} will be bought.`}
          </p>
        )}

        <p className="mt-3 text-xs text-subtle">
          {formatAmount(unitPriceCents, currency)} per credit, and one credit builds one resume.
          Between {target.minCredits} and {target.maxCredits} credits at a time
          {target.custom === 'stepper' && step > 1
            ? `, in steps of ${step} - about ${formatAmount(100, currency)} - on the buttons.`
            : '.'}
        </p>
      </section>
    </div>
  );
}
