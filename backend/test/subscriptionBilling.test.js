const assert = require('node:assert/strict');
const test = require('node:test');

const billing = require('../dist/services/subscriptions/billing');
const catalogue = require('../dist/config/accountSubscriptions');

/**
 * The rules of a paid subscription, as tables (services/subscriptions/billing.ts):
 * the days left of a period and what they are worth, what moving up costs now,
 * the period a renewal buys, what each tier's card offers in every state, and
 * what a due tier does at renewal - a disabled account's included, and one
 * whose price cannot be read. Pure: no database, no clock of its own.
 * Every amount is thousandths of a dollar, and every division exact.
 */

const DAY = 86_400_000;
const T0 = Date.parse('2026-10-19T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

/** A row's paid state; unpaid unless `paidThrough` is given. */
function state(fields = {}) {
  return {
    role: 'user',
    disabled: false,
    subscription: 'default',
    base: null,
    periodStart: null,
    paidThrough: null,
    periodPriceMilli: 0,
    renews: false,
    next: null,
    ...fields,
  };
}

/** Premium bought at T0 for $9.99 by a Default account, renewing. */
const paidPremium = (fields = {}) =>
  state({
    subscription: 'premium',
    base: 'default',
    periodStart: iso(T0),
    paidThrough: iso(T0 + 30 * DAY),
    periodPriceMilli: 9_990,
    renews: true,
    ...fields,
  });

const PRICES = { premium: 9_990, 'premium-plus': 19_990, 'premium-max': null };

test('the catalogue: the ids and labels as they were, what each tier includes, and the paid ones', () => {
  assert.deepEqual(catalogue.listSubscriptions().map((tier) => tier.id), ['default', 'premium', 'premium-plus', 'premium-max']);
  assert.deepEqual(catalogue.listSubscriptions().map((tier) => tier.label), ['Default', 'Premium', 'Premium+', 'Premium Max']);
  assert.deepEqual([...catalogue.PAID_SUBSCRIPTION_IDS], ['premium', 'premium-plus', 'premium-max']);
  assert.equal(catalogue.isPaidSubscriptionId('default'), false, 'Default is not bought');
  assert.equal(catalogue.isPaidSubscriptionId('premium-ultra'), false);
  for (const tier of catalogue.listSubscriptions()) {
    assert.ok(tier.features.length > 0, `${tier.id} says what it includes`);
    assert.ok(tier.features.every((line) => typeof line === 'string' && line.length > 0));
  }
  // Each tier says how many PROFILES (people) it keeps, and that each holds any number of resumes.
  assert.deepEqual([...catalogue.SUBSCRIPTIONS.premium.features], ['Up to 5 profiles', 'Any number of resumes in each']);
  assert.equal(catalogue.SUBSCRIPTIONS.premium.summary, 'Up to five profiles, each with any number of resumes.');
  assert.equal(
    catalogue.SUBSCRIPTIONS.default.summary,
    'One profile, with any number of resumes. Everything else in the app is included.'
  );
  assert.equal(catalogue.SUBSCRIPTION_PERIOD_DAYS, 30);
  assert.equal(catalogue.MAX_SUBSCRIPTION_PRICE_MILLI, 10_000_000, '$10,000');
  assert.deepEqual(catalogue.SUBSCRIPTION_PRICE_FIELDS['premium-plus'], {
    setting: 'premiumPlusPriceMilli',
    request: 'premiumPlusPriceUsd',
    env: 'SUBSCRIPTION_PREMIUM_PLUS_PRICE_USD',
  });
});

test('a period is 30 days, and the days left count a day that has started', () => {
  const end = T0 + 30 * DAY;
  assert.equal(billing.addPeriod(iso(T0)), iso(end));
  assert.equal(billing.daysLeft(T0, end), 30);
  assert.equal(billing.daysLeft(T0 + 1, end), 30, 'a day that has started is left');
  assert.equal(billing.daysLeft(T0 + DAY - 1, end), 30);
  assert.equal(billing.daysLeft(T0 + DAY, end), 29, 'it changes once a day, at the hour it was bought');
  assert.equal(billing.daysLeft(T0 + DAY + 3_600_000, end), 29);
  assert.equal(billing.daysLeft(end - 1, end), 1);
  assert.equal(billing.daysLeft(end, end), 0);
  assert.equal(billing.daysLeft(end + DAY, end), 0, 'never below 0');
  assert.equal(billing.daysLeft(T0 - 5 * DAY, end), 30, 'never above 30');
  assert.equal(billing.daysLeft(T0, Number.NaN), 0);
});

test('the unused days are worth price x days / 30, rounded down to the thousandth, exactly', () => {
  assert.equal(billing.unusedCreditMilli(9_990, 29), 9_657, '$9.657');
  assert.equal(billing.unusedCreditMilli(9_990, 30), 9_990);
  assert.equal(billing.unusedCreditMilli(9_990, 1), 333);
  assert.equal(billing.unusedCreditMilli(10, 1), 0, '$0.000333 is under a thousandth: nothing');
  assert.equal(billing.unusedCreditMilli(1, 30), 1);
  assert.equal(billing.unusedCreditMilli(9_990, 0), 0);
  assert.equal(billing.unusedCreditMilli(9_990, 45), 9_990, 'never more than the period');
  // The largest price there is: the product stays exact.
  assert.equal(billing.unusedCreditMilli(10_000_000, 29), 9_666_666);
  assert.equal(billing.unusedCreditMilli(10_000_000, 30), 10_000_000);
  for (const junk of [-5, 1.5, Number.NaN, '9990', null]) assert.equal(billing.unusedCreditMilli(junk, 10), 0, String(junk));
});

test('moving up costs the new price less the unused days, and never less than nothing', () => {
  // Bought Premium at $9.99; a day and an hour later, 29 days are left.
  const now = T0 + DAY + 3_600_000;
  assert.deepEqual(billing.chargeNowMilli(paidPremium(), 19_990, now), { chargeMilli: 10_333, creditMilli: 9_657, daysLeft: 29 });
  // A tier that is not paid is worth nothing: the full price.
  assert.deepEqual(billing.chargeNowMilli(state(), 19_990, now), { chargeMilli: 19_990, creditMilli: 0, daysLeft: 0 });
  assert.deepEqual(billing.chargeNowMilli(state({ subscription: 'premium' }), 19_990, now), {
    chargeMilli: 19_990,
    creditMilli: 0,
    daysLeft: 0,
  });
  // A higher tier priced below what is left of this one costs nothing - and pays nothing out.
  assert.deepEqual(billing.chargeNowMilli(paidPremium(), 5_000, now), { chargeMilli: 0, creditMilli: 9_657, daysLeft: 29 });
  // Due and not renewed yet: nothing is left.
  assert.equal(billing.chargeNowMilli(paidPremium(), 19_990, T0 + 31 * DAY).chargeMilli, 19_990);
});

test('a renewal starts at the old end - or now, when the whole period it would buy has gone by', () => {
  const end = T0 + 30 * DAY;
  assert.deepEqual(billing.renewalPeriod(iso(end), iso(end + 3_600_000)), { start: iso(end), end: iso(end + 30 * DAY) });
  assert.deepEqual(billing.renewalPeriod(iso(end), iso(end + 29 * DAY)), { start: iso(end), end: iso(end + 30 * DAY) });
  assert.deepEqual(billing.renewalPeriod(iso(end), iso(end + 30 * DAY)), {
    start: iso(end + 30 * DAY),
    end: iso(end + 60 * DAY),
  });
  assert.deepEqual(billing.renewalPeriod(iso(end), iso(end + 75 * DAY)), {
    start: iso(end + 75 * DAY),
    end: iso(end + 105 * DAY),
  });
});

/** Every tier's offer, as [id, offer, chargeMilli]. */
function offers(row, prices = PRICES, now = T0 + DAY + 3_600_000) {
  return catalogue.SUBSCRIPTION_IDS.map((tier) => {
    const offer = billing.offerFor(tier, row, prices, now);
    return [tier, offer.offer, offer.chargeMilli];
  });
}

test('what each card offers, in every state', () => {
  // Default, nothing paid: a priced tier is bought at its price; an unpriced one is not offered.
  assert.deepEqual(offers(state()), [
    ['default', 'current', null],
    ['premium', 'subscribe', 9_990],
    ['premium-plus', 'subscribe', 19_990],
    ['premium-max', 'not-offered', null],
  ]);
  // An administrator's Premium: what is below it is included, and above it bought at full price.
  assert.deepEqual(offers(state({ subscription: 'premium' })), [
    ['default', 'included', null],
    ['premium', 'current', null],
    ['premium-plus', 'subscribe', 19_990],
    ['premium-max', 'not-offered', null],
  ]);
  // Premium paid for: Default is where cancelling returns; Premium+ is the upgrade, prorated.
  assert.deepEqual(offers(paidPremium()), [
    ['default', 'return-here', null],
    ['premium', 'current', null],
    ['premium-plus', 'upgrade', 10_333],
    ['premium-max', 'not-offered', null],
  ]);
  const upgrade = billing.offerFor('premium-plus', paidPremium(), PRICES, T0 + DAY + 3_600_000);
  assert.deepEqual(upgrade, { offer: 'upgrade', chargeMilli: 10_333, creditMilli: 9_657, daysLeft: 29 });

  // Premium Max paid for from Default, everything priced: the paid tiers below switch at renewal.
  const everything = { premium: 9_990, 'premium-plus': 19_990, 'premium-max': 49_990 };
  const max = paidPremium({ subscription: 'premium-max', periodPriceMilli: 49_990 });
  assert.deepEqual(offers(max, everything), [
    ['default', 'return-here', null],
    ['premium', 'switch-at-renewal', null],
    ['premium-plus', 'switch-at-renewal', null],
    ['premium-max', 'current', null],
  ]);
  // ...one of them already chosen; one nobody prices any more.
  assert.equal(billing.offerFor('premium-plus', { ...max, next: 'premium-plus' }, everything, T0).offer, 'switching');
  assert.equal(billing.offerFor('premium-plus', max, { ...everything, 'premium-plus': null }, T0).offer, 'not-offered');
  // Bought from an administrator's Premium: that is the base; below it is included.
  assert.deepEqual(offers({ ...max, base: 'premium' }, everything), [
    ['default', 'included', null],
    ['premium', 'return-here', null],
    ['premium-plus', 'switch-at-renewal', null],
    ['premium-max', 'current', null],
  ]);

  // An administrator buys nothing; a reporter has no tier to change.
  assert.deepEqual(offers(state({ role: 'admin' })), [
    ['default', 'current', null],
    ['premium', 'none', null],
    ['premium-plus', 'none', null],
    ['premium-max', 'none', null],
  ]);
  assert.deepEqual(
    offers(state({ role: 'reporter', subscription: 'premium' })).map(([, offer]) => offer),
    ['none', 'current', 'none', 'none']
  );
});

test('at renewal a due tier renews at today\'s price, as itself or as the tier chosen - or ends, and says why, or holds while its price cannot be read', () => {
  assert.deepEqual(billing.renewalDecision(paidPremium(), PRICES), { kind: 'renew', tier: 'premium', priceMilli: 9_990 });
  const switching = paidPremium({ subscription: 'premium-plus', next: 'premium' });
  assert.deepEqual(billing.renewalDecision(switching, { ...PRICES, premium: 8_000 }), {
    kind: 'renew',
    tier: 'premium',
    priceMilli: 8_000,
  });
  assert.deepEqual(billing.renewalDecision(paidPremium({ renews: false }), PRICES), {
    kind: 'lapse',
    reason: 'cancelled',
    tier: 'premium',
  });
  assert.deepEqual(billing.renewalDecision(paidPremium(), { ...PRICES, premium: null }), {
    kind: 'lapse',
    reason: 'not-offered',
    tier: 'premium',
  });
  assert.equal(billing.renewalDecision(switching, { ...PRICES, premium: null }).reason, 'not-offered', 'the tier chosen is the one renewed');
  for (const role of ['reporter', 'admin']) {
    assert.deepEqual(billing.renewalDecision(paidPremium({ role }), PRICES), {
      kind: 'lapse',
      reason: 'not-a-user',
      tier: 'premium',
    });
  }
  // A disabled account can neither use another 30 days nor sign in to cancel
  // them: it is not charged for them, and the tier ends - whatever it costs.
  assert.deepEqual(billing.renewalDecision(paidPremium({ disabled: true }), PRICES), {
    kind: 'lapse',
    reason: 'disabled',
    tier: 'premium',
  });
  assert.equal(
    billing.renewalDecision(paidPremium({ disabled: true, renews: false }), PRICES).reason,
    'cancelled',
    'cancelled first: it was ending anyway, as the person chose'
  );
  assert.equal(billing.renewalDecision(paidPremium({ disabled: true, role: 'reporter' }), PRICES).reason, 'not-a-user');
  // A price somebody set that cannot be read holds the tier: neither renewed
  // nor ended as "not offered", which nobody decided.
  const unreadable = { ...PRICES, premium: null };
  assert.deepEqual(billing.renewalDecision(paidPremium(), unreadable, ['premium']), { kind: 'hold', tier: 'premium' });
  assert.deepEqual(billing.renewalDecision(switching, unreadable, ['premium']), { kind: 'hold', tier: 'premium' }, 'the tier it renews as');
  assert.deepEqual(billing.renewalDecision(paidPremium(), PRICES, ['premium-plus']), {
    kind: 'renew',
    tier: 'premium',
    priceMilli: 9_990,
  });
  // ...but what ends whatever the price still ends.
  assert.equal(billing.renewalDecision(paidPremium({ renews: false }), unreadable, ['premium']).reason, 'cancelled');
  assert.equal(billing.renewalDecision(paidPremium({ disabled: true }), unreadable, ['premium']).reason, 'disabled');
  assert.equal(billing.renewalDecision(paidPremium({ role: 'reporter' }), unreadable, ['premium']).reason, 'not-a-user');
  // A paid tier returns to its base, else Default.
  assert.equal(billing.lapsesTo(paidPremium({ base: 'premium' })), 'premium');
  assert.equal(billing.lapsesTo(paidPremium({ base: null })), 'default');
});
