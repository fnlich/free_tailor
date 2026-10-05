'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

import { ContactAdminLink } from '@/components/contact/ContactAdminDialog';
import { Field, Section, SettingsPage, StaticValue } from '@/components/settings/SettingsParts';
import { useAuth } from '@/contexts/AuthContext';
import { authApi, describeProfileUsage, type AccountSubscription } from '@/lib/auth';
import { formatMoney } from '@/lib/format';

/**
 * Settings > Subscription: the subscription this account is on, what it
 * allows, and the subscriptions this installation has.
 *
 * Read-only. Subscriptions are an administrator's to set; there is no checkout.
 * Called Settings > Plan before the tier was renamed, and that address
 * redirects here.
 */
export default function SubscriptionSettingsPage() {
  const { account, refresh } = useAuth();
  const [subscriptions, setSubscriptions] = useState<AccountSubscription[]>([]);

  useEffect(() => {
    authApi
      .subscriptions()
      .then(({ subscriptions: list }) => setSubscriptions(list))
      .catch(() => setSubscriptions([]));
  }, []);

  // The profile count is stale the moment somebody adds one on another page,
  // and this is where it is read most carefully.
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!account) return null;

  return (
    <SettingsPage>
      <Section title="Current subscription" description="What your account is on, and what it allows.">
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          <Field label="Subscription" hint={account.subscriptionSummary}>
            <StaticValue>{account.subscriptionLabel}</StaticValue>
          </Field>
          <Field
            label="Profiles used"
            hint="Your profiles belong to this account and are not visible to anybody else on this installation."
          >
            <StaticValue>{describeProfileUsage(account)}</StaticValue>
          </Field>
        </div>
      </Section>

      <Section
        title="Subscriptions"
        description="Every subscription on this installation, and how many profiles each one allows."
      >
        {subscriptions.length > 0 && (
          <div className="tl-table-box">
            <table className="tl-table">
              <thead>
                <tr>
                  <th scope="col">Subscription</th>
                  <th scope="col">Profiles</th>
                  <th scope="col">Includes</th>
                </tr>
              </thead>
              <tbody>
                {subscriptions.map((subscription) => {
                  const current = subscription.id === account.subscription;
                  return (
                    <tr key={subscription.id} aria-current={current ? 'true' : undefined}>
                      {/* The ink is on a span, not the cell: `.tl-table td`
                          sets its own colour and is unlayered, so it beats any
                          colour utility put on the td itself. */}
                      <td className="whitespace-nowrap">
                        <span className="font-medium text-ink">{subscription.label}</span>
                        {current && (
                          <span className="ml-2 inline-flex items-center rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-semibold text-accent-ink">
                            Current
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap">
                        {subscription.profileLimit === null
                          ? 'Unlimited'
                          : `${subscription.profileLimit} profile${subscription.profileLimit === 1 ? '' : 's'}`}
                      </td>
                      <td className="min-w-[14rem]">{subscription.summary}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-sm text-muted">
          {/* There is no checkout, and pretending otherwise with a disabled
              "Upgrade" button would just raise the question this sentence
              answers. */}
          Subscriptions are set by an administrator of this installation. Ask them to move your
          account if you need more profiles. <ContactAdminLink />
        </p>
      </Section>

      <Section
        title="Credits"
        description="Bought and spent apart from your subscription. A credit is a dollar, counted to $0.001: each resume costs the price set for the model it is built with, however many files it produces."
      >
        <Field label="Balance">
          <StaticValue>{formatMoney(account.balanceMilli)}</StaticValue>
        </Field>
        <div>
          <Link href="/credits" className="tl-button-quiet">
            Go to Credits
          </Link>
          <p className="mt-2 text-sm text-subtle">
            Buying more, and every purchase and spend, are on the Credits page.
          </p>
        </div>
      </Section>
    </SettingsPage>
  );
}
