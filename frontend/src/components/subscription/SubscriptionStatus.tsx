'use client';

import { ContactAdminLink } from '@/components/contact/ContactAdminDialog';
import { Field, StaticValue } from '@/components/ui/kit';
import { describeProfileUsage, type Account } from '@/lib/auth';
import type { SubscriptionView } from '@/lib/subscriptionBilling';
import { cardAction, statusSummary, type CardAction } from '@/lib/subscriptionDisplay';
import css from './subscription.module.css';

/**
 * "Current subscription": the tier the account is on and where it came from
 * - paid from credit, set by an administrator, Default, or an
 * administrator's own, which is never charged - how many profiles it uses,
 * and, for one paid from credit, when it started and renews, ends or
 * switches, and the next charge. Cancel subscription while it renews, and
 * Keep while it is cancelled or switching; the page asks before either.
 * The words are lib/subscriptionDisplay.ts `statusSummary`'s.
 */
export default function SubscriptionStatus({
  view,
  account,
  busy,
  onCancel,
  onKeep,
}: {
  view: SubscriptionView;
  account: Account;
  busy: boolean;
  onCancel: () => void;
  onKeep: (action: Extract<CardAction, { kind: 'keep' }>) => void;
}) {
  const summary = statusSummary(view);
  const currentTier = view.tiers.find((tier) => tier.offer === 'current');
  const keep = currentTier ? cardAction(currentTier, view) : null;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
        <Field label="Subscription" hint={summary.source}>
          <StaticValue>{summary.headline}</StaticValue>
        </Field>
        <Field
          label="Profiles used"
          hint="Your profiles belong to this account and are not visible to anybody else on this installation."
        >
          <StaticValue>{describeProfileUsage(account)}</StaticValue>
        </Field>
      </div>

      {view.source === 'admin' && (
        <p className="text-sm text-muted">
          To change it, ask your administrator. A higher subscription bought on this page is paid from your credit,
          and your account comes back to this one when it ends. <ContactAdminLink />
        </p>
      )}

      {summary.rows.length > 0 && (
        <dl className={css.rows} aria-label="Your paid subscription">
          {summary.rows.map((row) => (
            <div key={row.label}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {(summary.canCancel || keep?.kind === 'keep') && (
        <div className="flex flex-wrap items-center gap-3">
          {keep?.kind === 'keep' && (
            <button type="button" className="tl-button" disabled={busy} onClick={() => onKeep(keep)}>
              {keep.label}
            </button>
          )}
          {summary.canCancel && (
            <button type="button" className="tl-button-quiet" data-tone="danger" disabled={busy} onClick={onCancel}>
              Cancel subscription
            </button>
          )}
        </div>
      )}
    </div>
  );
}
