'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

import { Field, Section, SettingsPage, StaticValue } from '@/components/settings/SettingsParts';
import { useAuth } from '@/contexts/AuthContext';
import { authApi, describeProfileUsage, type AccountPlan } from '@/lib/auth';

/**
 * Settings > Plan: the plan this account is on, what it allows, and the plans
 * this installation has.
 *
 * Read-only. Plans are an administrator's to set; there is no checkout.
 */
export default function PlanSettingsPage() {
  const { account, refresh } = useAuth();
  const [plans, setPlans] = useState<AccountPlan[]>([]);

  useEffect(() => {
    authApi.plans().then(({ plans: list }) => setPlans(list)).catch(() => setPlans([]));
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
      <Section title="Current plan" description="What your account is on, and what it allows.">
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          <Field label="Plan" hint={account.planSummary}>
            <StaticValue>{account.planLabel}</StaticValue>
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
        title="Plans"
        description="Every plan on this installation, and how many profiles each one allows."
      >
        {plans.length > 0 && (
          <div className="tl-table-box">
            <table className="tl-table">
              <thead>
                <tr>
                  <th scope="col">Plan</th>
                  <th scope="col">Profiles</th>
                  <th scope="col">Includes</th>
                </tr>
              </thead>
              <tbody>
                {plans.map((plan) => {
                  const current = plan.id === account.plan;
                  return (
                    <tr key={plan.id} aria-current={current ? 'true' : undefined}>
                      {/* The ink is on a span, not the cell: `.tl-table td`
                          sets its own colour and is unlayered, so it beats any
                          colour utility put on the td itself. */}
                      <td className="whitespace-nowrap">
                        <span className="font-medium text-ink">{plan.label}</span>
                        {current && (
                          <span className="ml-2 inline-flex items-center rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-semibold text-accent-ink">
                            Current
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap">
                        {plan.profileLimit === null
                          ? 'Unlimited'
                          : `${plan.profileLimit} profile${plan.profileLimit === 1 ? '' : 's'}`}
                      </td>
                      <td className="min-w-[14rem]">{plan.summary}</td>
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
          Plans are set by an administrator of this installation. Ask them to move your account if
          you need more profiles.
        </p>
      </Section>

      <Section
        title="Credits"
        description="Bought and spent apart from your plan. One credit builds one resume, however many files it produces."
      >
        <div>
          <Link href="/credits" className="tl-button-quiet">
            Go to Credits
          </Link>
          <p className="mt-2 text-sm text-subtle">
            Your balance, buying more and every purchase and spend are on the Credits page.
          </p>
        </div>
      </Section>
    </SettingsPage>
  );
}
