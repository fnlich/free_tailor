'use client';

import { MarkCardTrio, MarkCoinTrio, CoinMark } from '@/components/icons/marks';
import { IconChevronRight } from '@/components/icons';
import { CHOICE, LABEL } from './chrome';
import { formatAmount, type PaymentTarget } from '@/lib/payments';

/**
 * Step 1: what to pay with.
 *
 * The method is chosen FIRST, which is the whole point of the change - the
 * page this replaces put one button per method beside the amount box, so the
 * amount was typed before anybody knew what the limits for their method were,
 * and a card minimum and a crypto minimum that differ by a factor of twenty
 * could only be discovered by being refused.
 *
 * Only what this installation can serve is offered, and an unavailable target
 * is still LISTED with its reason rather than hidden. That is the house rule
 * already in force for AI providers and payment methods, and the reason is the
 * same: the person who needs to read "set STRIPE_SECRET_KEY" is the operator,
 * and a missing button tells them nothing at all.
 */

function Mark({ target }: { target: PaymentTarget }) {
  if (target.mark === 'card') return <MarkCardTrio />;
  // The method-level crypto entry, before the server offers a row per coin.
  if (target.mark === 'crypto') return <MarkCoinTrio />;
  return <CoinMark assetId={target.asset} symbol={target.symbol} className="h-6 w-6" />;
}

function Range({ targets, currency }: { targets: PaymentTarget[]; currency: string }) {
  /*
   * The widest range the section can actually serve.
   *
   * Taken across the AVAILABLE targets only: a coin that is switched off has
   * bounds of zero, and folding those in would advertise a $0.00 minimum.
   */
  const live = targets.filter((target) => target.available);
  if (live.length === 0) return null;
  const min = Math.min(...live.map((target) => target.minAmountCents));
  const max = Math.max(...live.map((target) => target.maxAmountCents));
  return (
    <span className="text-xs font-normal normal-case tracking-normal text-muted">
      {formatAmount(min, currency)} &ndash; {formatAmount(max, currency)}
    </span>
  );
}

function Choice({
  target,
  currency,
  showRange,
  onChoose,
}: {
  target: PaymentTarget;
  currency: string;
  /**
   * False when this is the only thing in its section.
   *
   * The section heading already carries the range, and with one target the
   * two are the same figures printed twice. Once there is a row per coin they
   * differ - USDT and Bitcoin need not share a minimum - and each button says
   * its own.
   */
  showRange: boolean;
  onChoose: (target: PaymentTarget) => void;
}) {
  return (
    <button
      type="button"
      className={`${CHOICE} flex gap-3 ${
        /*
         * Centred while the row is one or two lines, top-aligned once it is
         * not. An unavailable row carries setup instructions that run to
         * several lines in this dialog, and a mark centred against five lines
         * of text sits opposite nothing.
         */
        target.available ? 'items-center' : 'items-start'
      }`}
      disabled={!target.available}
      onClick={() => onChoose(target)}
      // The reason is on the element as well as in the text below it, so it
      // reaches a screen reader on a control it cannot press.
      title={target.available ? undefined : target.reason}
    >
      <Mark target={target} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-ink">{target.label}</span>
        {target.available
          ? showRange && (
              <span className="block truncate text-xs text-subtle">
                {formatAmount(target.minAmountCents, currency)} &ndash;{' '}
                {formatAmount(target.maxAmountCents, currency)}
              </span>
            )
          : /*
             * Wrapped, not truncated, and the difference matters.
             *
             * This is the only thing on screen telling an operator what to go
             * and set, and the part that says which keys is at the END of the
             * sentence - so one line with an ellipsis hides the whole point of
             * showing it. `break-words` is for the keys themselves:
             * COINBASE_COMMERCE_WEBHOOK_SECRET is one 32-character word with
             * nowhere a browser will break it, and in this column it has to go
             * somewhere.
             */
            <span className="block break-words text-xs text-subtle">
              {target.reason || 'Not available.'}
            </span>}
      </span>
      {target.available && <IconChevronRight className="h-4 w-4 shrink-0 text-subtle" />}
    </button>
  );
}

export default function PaymentOptionsStep({
  targets,
  currency,
  onChoose,
}: {
  targets: PaymentTarget[];
  currency: string;
  onChoose: (target: PaymentTarget) => void;
}) {
  const cards = targets.filter((target) => target.method === 'card');
  const coins = targets.filter((target) => target.method === 'crypto');
  const liveCards = cards.filter((target) => target.available).length;
  const liveCoins = coins.filter((target) => target.available).length;

  return (
    <div className="space-y-6">
      {cards.length > 0 && (
        <section>
          <h3 className={`${LABEL} flex items-baseline justify-between gap-3`}>
            <span>Card</span>
            <Range targets={cards} currency={currency} />
          </h3>
          <div className="mt-2 grid gap-2">
            {cards.map((target) => (
              <Choice
                key={target.id}
                target={target}
                currency={currency}
                showRange={liveCards > 1}
                onChoose={onChoose}
              />
            ))}
          </div>
        </section>
      )}

      {coins.length > 0 && (
        <section>
          <h3 className={`${LABEL} flex items-baseline justify-between gap-3`}>
            <span>Cryptocurrencies</span>
            <Range targets={coins} currency={currency} />
          </h3>
          {/*
            One column until there is more than one coin to choose between -
            a two-column grid holding a single button leaves a hole beside it.
          */}
          <div className={`mt-2 grid gap-2 ${coins.length > 1 ? 'sm:grid-cols-2' : ''}`}>
            {coins.map((target) => (
              <Choice
                key={target.id}
                target={target}
                currency={currency}
                showRange={liveCoins > 1}
                onChoose={onChoose}
              />
            ))}
          </div>
        </section>
      )}

      {targets.length === 0 && (
        <p className="text-sm text-muted">
          This installation cannot take payments yet. An administrator can turn a method on from
          Settings &rarr; Payments.
        </p>
      )}
    </div>
  );
}
