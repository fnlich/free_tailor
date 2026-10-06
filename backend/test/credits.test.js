const assert = require('node:assert/strict');
const test = require('node:test');

const { loadFresh, useTempStorage, useAdminEmails } = require('./helpers');

/**
 * Credit, and the ledger that explains it.
 *
 * The invariant everything here defends is: CREDIT SPENT EQUALS RESUMES
 * DELIVERED. A charge that survives a failure is money taken for nothing; a
 * refund that runs twice is money invented. Both are the kind of bug a user
 * notices and cannot prove, so they are pinned individually.
 *
 * A credit is a dollar and every amount is an integer count of thousandths
 * (milli): 10000 is $10.000, 23 is $0.023. Nothing rounds.
 */

function setup(name) {
  useTempStorage(name);
  useAdminEmails('admin@example.com');
  const users = loadFresh('../dist/database/userRepository');
  const credits = loadFresh('../dist/services/credits');
  const repo = loadFresh('../dist/database/creditRepository');
  return { users, credits, repo };
}

test('a reserve takes the whole cost up front and the ledger explains it', () => {
  const { users, credits } = setup('credits-reserve');
  users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  credits.setBalance(alice.id, 10_000, 'admin-1');

  credits.reserveCredits(users.getUserById(alice.id), 3_000, { kind: 'batch', id: 'bat_1', label: '3 resumes' });

  assert.equal(users.getUserById(alice.id).balanceMilli, 7_000, 'charged before any work ran');

  const entries = credits.getLedger(alice.id);
  assert.equal(entries[0].deltaMilli, -3_000);
  assert.equal(entries[0].reason, 'generation-reserve');
  // Measured after the move, not predicted before it.
  assert.equal(entries[0].balanceAfterMilli, 7_000);
  // A row written in dollars has nothing in the old unit.
  assert.equal(entries[0].legacyCredits, null);
  assert.equal(entries[0].refId, 'bat_1');
});

test('a run that cannot be afforded is refused and takes nothing', () => {
  const { users, credits } = setup('credits-refuse');
  users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  credits.setBalance(alice.id, 2_000, 'admin-1');

  assert.throws(
    () => credits.reserveCredits(users.getUserById(alice.id), 5_000, { kind: 'batch', id: 'bat_1' }),
    (error) =>
      error.name === 'InsufficientCreditsError' && error.neededMilli === 5_000 && error.balanceMilli === 2_000
  );

  // Nothing partial: the whole transaction rolls back, so a refused run leaves
  // no reservation to be refunded later and no row claiming a charge.
  assert.equal(users.getUserById(alice.id).balanceMilli, 2_000);
  assert.equal(credits.getReservation('bat_1'), null);
  assert.equal(credits.getLedger(alice.id).filter((e) => e.reason === 'generation-reserve').length, 0);
});

test('the refusal names the numbers, not just the problem', () => {
  const { users, credits } = setup('credits-refusal-message');
  users.createUser({ email: 'admin@example.com' });
  const broke = users.createUser({ email: 'broke@example.com' });

  try {
    credits.reserveCredits(users.getUserById(broke.id), 161, { kind: 'batch', id: 'bat_1' });
    assert.fail('should have refused');
  } catch (error) {
    // A zero balance and a merely-insufficient one point at different remedies.
    // The message deliberately does not name WHERE to get more: it is written
    // once and read on installs that may or may not have a checkout, so the
    // page catching it links accordingly. Dollars, to the thousandth.
    assert.match(error.message, /needs \$0\.161 of credit and the account has none/i);
    assert.match(error.message, /add credit/i);
    assert.doesNotMatch(error.message, /administrator/i);
  }

  credits.setBalance(broke.id, 23, 'admin-1');
  try {
    credits.reserveCredits(users.getUserById(broke.id), 161, { kind: 'batch', id: 'bat_2' });
    assert.fail('should have refused');
  } catch (error) {
    assert.match(error.message, /needs \$0\.161 of credit and the account has \$0\.023/i);
    assert.match(error.message, /fewer at once/i);
  }
});

test('two runs racing for the last credits cannot both win', () => {
  const { users, credits } = setup('credits-race');
  users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  credits.setBalance(alice.id, 10_000, 'admin-1');

  // The account object is read ONCE and handed to both, which is exactly the
  // stale snapshot a request holds in req.user. The guarantee has to come from
  // the conditional UPDATE, not from the caller re-reading.
  const snapshot = users.getUserById(alice.id);

  credits.reserveCredits(snapshot, 10_000, { kind: 'batch', id: 'bat_1' });
  assert.throws(
    () => credits.reserveCredits(snapshot, 10_000, { kind: 'batch', id: 'bat_2' }),
    /needs \$10 of credit and the account has none/i
  );

  assert.equal(users.getUserById(alice.id).balanceMilli, 0);
});

test('an admin is exempt, and every refund against an exempt run is a no-op', () => {
  const { users, credits } = setup('credits-exempt');
  const admin = users.createUser({ email: 'admin@example.com' });
  credits.setBalance(admin.id, 5_000, admin.id);

  const result = credits.reserveCredits(users.getUserById(admin.id), 100_000, {
    kind: 'batch',
    id: 'bat_1',
  });

  assert.equal(result.exempt, true);
  assert.equal(result.costMilli, 0);
  assert.equal(users.getUserById(admin.id).balanceMilli, 5_000, 'balance untouched');
  // No reservation row exists, so the refund path finds nothing rather than
  // having to remember to re-check the role.
  assert.equal(credits.getReservation('bat_1'), null);
  assert.equal(credits.refundTaskUnit('bat_1', 'tsk_1', 1_000, 'failed'), 0);
  assert.equal(users.getUserById(admin.id).balanceMilli, 5_000, 'a refund cannot invent credit');
});

test('a unit that did not deliver gives its credit back, once', () => {
  const { users, credits } = setup('credits-refund-once');
  users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  credits.setBalance(alice.id, 10_000, 'admin-1');
  credits.reserveCredits(users.getUserById(alice.id), 3_000, { kind: 'batch', id: 'bat_1' });

  assert.equal(credits.refundTaskUnit('bat_1', 'tsk_1', 1_000, 'failed'), 1_000);
  assert.equal(users.getUserById(alice.id).balanceMilli, 8_000);

  // The same task again. A queue hook can fire twice - after a restart, or on a
  // re-settle - and the idempotency key is what makes the second one free.
  assert.equal(credits.refundTaskUnit('bat_1', 'tsk_1', 1_000, 'failed'), 0);
  assert.equal(users.getUserById(alice.id).balanceMilli, 8_000);
});

test('a run can never refund more than it was charged', () => {
  const { users, credits } = setup('credits-cap');
  users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  credits.setBalance(alice.id, 10_000, 'admin-1');
  credits.reserveCredits(users.getUserById(alice.id), 2_000, { kind: 'batch', id: 'bat_1' });
  assert.equal(users.getUserById(alice.id).balanceMilli, 8_000);

  // Three distinct tasks against a two-unit reservation. The third is capped in
  // SQL, so a caller that invented a fresh key still cannot over-refund.
  assert.equal(credits.refundTaskUnit('bat_1', 'tsk_1', 1_000, 'failed'), 1_000);
  assert.equal(credits.refundTaskUnit('bat_1', 'tsk_2', 1_000, 'failed'), 1_000);
  assert.equal(credits.refundTaskUnit('bat_1', 'tsk_3', 1_000, 'failed'), 0);

  assert.equal(users.getUserById(alice.id).balanceMilli, 10_000, 'back to where it started, never above');
});

test('releasing sweeps what is left, for a run that never accounted for itself', () => {
  const { users, credits } = setup('credits-release');
  users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  credits.setBalance(alice.id, 10_000, 'admin-1');
  credits.reserveCredits(users.getUserById(alice.id), 5_000, { kind: 'request', id: 'res_1' });
  credits.refundTaskUnit('res_1', 'tsk_1', 2_000, 'two dollars failed');

  assert.equal(credits.releaseReservation('res_1', 'done'), 3_000, 'the three dollars still outstanding');
  assert.equal(users.getUserById(alice.id).balanceMilli, 10_000);

  // Closed, so a late refund cannot reopen it and hand back credits twice.
  assert.equal(credits.getReservation('res_1').state, 'closed');
  assert.equal(credits.releaseReservation('res_1', 'again'), 0);
  assert.equal(credits.refundTaskUnit('res_1', 'tsk_late', 1_000, 'late'), 0);
  assert.equal(users.getUserById(alice.id).balanceMilli, 10_000);
});

test('a fully delivered run releases nothing', () => {
  const { users, credits } = setup('credits-delivered');
  users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  credits.setBalance(alice.id, 10_000, 'admin-1');
  credits.reserveCredits(users.getUserById(alice.id), 4_000, { kind: 'request', id: 'res_1' });

  // Nothing failed, so nothing is refunded and the run SETTLES: what was not
  // refunded was delivered, and its credit is spent. Four resumes, four
  // dollars. Releasing instead would hand all four back - which is to say it
  // would make every successful run free. A refund of nothing writes nothing.
  assert.equal(credits.refundTaskUnit('res_1', 'tsk_free', 0, 'free model'), 0);
  assert.equal(credits.settleRun('res_1'), true);
  assert.equal(users.getUserById(alice.id).balanceMilli, 6_000);

  // And the finally-sweep the handlers run unconditionally is then a no-op.
  assert.equal(credits.releaseReservation('res_1', 'did not finish'), 0);
  assert.equal(users.getUserById(alice.id).balanceMilli, 6_000);
});

test('the balance always equals the sum of the ledger', () => {
  const { users, credits, repo } = setup('credits-invariant');
  users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });

  credits.setBalance(alice.id, 20_000, 'admin-1');
  credits.reserveCredits(users.getUserById(alice.id), 138, { kind: 'batch', id: 'bat_1' });
  credits.refundTaskUnit('bat_1', 'tsk_1', 23, 'failed');
  credits.refundTaskUnit('bat_1', 'tsk_2', 23, 'cancelled');
  credits.releaseReservation('bat_1', 'done');
  credits.grantCredits(alice.id, 5, 'admin-1', 'top-up');

  const sum = credits.getLedger(alice.id, 500).reduce((total, entry) => total + entry.deltaMilli, 0);
  assert.equal(users.getUserById(alice.id).balanceMilli, sum);
  assert.equal(sum, 20_005);
  // And the standing check agrees, which is what the boot reconciler reports on.
  assert.deepEqual(repo.findInconsistentBalances(), []);
});

test('every movement is explainable, and the reserve does not claim to be a delivery', () => {
  const { users, credits } = setup('credits-explainable');
  users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  credits.setBalance(alice.id, 9_000, 'admin-1', 'opening');
  credits.reserveCredits(users.getUserById(alice.id), 2_000, { kind: 'batch', id: 'bat_1', label: '1 job x 2 profiles' });
  credits.refundTaskUnit('bat_1', 'tsk_1', 1_000, 'Ada / Acme: failed');

  const reasons = credits.getLedger(alice.id).map((entry) => entry.reason);
  assert.deepEqual(reasons, ['generation-refund', 'generation-reserve', 'admin-set']);

  const reserve = credits.getLedger(alice.id).find((e) => e.reason === 'generation-reserve');
  // It claims a reservation, not a delivery. The row is written before a single
  // resume exists, so anything else would be a lie in the audit trail.
  assert.equal(reserve.note, '1 job x 2 profiles');

  const refund = credits.getLedger(alice.id).find((e) => e.reason === 'generation-refund');
  assert.match(refund.note, /Ada \/ Acme/);
});

test('the held figure shows what a run is holding while it is in flight', () => {
  const { users, credits } = setup('credits-held');
  users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  credits.setBalance(alice.id, 10_000, 'admin-1');
  credits.reserveCredits(users.getUserById(alice.id), 4_000, { kind: 'batch', id: 'bat_1' });

  // The dip is real and is named rather than hidden: $6 spendable, $4 held
  // against work that has not finished.
  let status = credits.getStatus(users.getUserById(alice.id));
  assert.deepEqual(status, { balanceMilli: 6_000, heldMilli: 4_000, exempt: false });

  credits.refundTaskUnit('bat_1', 'tsk_1', 1_000, 'failed');
  status = credits.getStatus(users.getUserById(alice.id));
  assert.equal(status.balanceMilli, 7_000);
  assert.equal(status.heldMilli, 3_000);
});

test('a new account starts at zero unless an operator says otherwise', () => {
  useTempStorage('credits-signup-default');
  useAdminEmails('admin@example.com');
  const users = loadFresh('../dist/database/userRepository');
  users.createUser({ email: 'admin@example.com' });
  assert.equal(users.createUser({ email: 'alice@example.com' }).balanceMilli, 0);
});

test('CREDIT_SIGNUP_GRANT gives new accounts an opening balance in dollars, once', () => {
  useTempStorage('credits-signup-grant');
  useAdminEmails('admin@example.com');
  // Dollars since credits became dollars: 2.5 is $2.500, not two and a half credits.
  process.env.CREDIT_SIGNUP_GRANT = '2.5';
  try {
    const users = loadFresh('../dist/database/userRepository');
    const credits = loadFresh('../dist/services/credits');
    users.createUser({ email: 'admin@example.com' });
    const alice = users.createUser({ email: 'alice@example.com' });

    assert.equal(alice.balanceMilli, 2_500, 'the returned account already shows the grant');
    const entry = credits.getLedger(alice.id)[0];
    assert.equal(entry.reason, 'signup-grant');
    assert.equal(entry.deltaMilli, 2_500);
    assert.match(entry.note, /\$2\.5\./);

    // Keyed on the account, so a retried sign-in cannot grant twice.
    credits.applySignupGrant(users.getUserById(alice.id));
    assert.equal(users.getUserById(alice.id).balanceMilli, 2_500);
  } finally {
    delete process.env.CREDIT_SIGNUP_GRANT;
  }
});

test('an abandoned run has its credits released on restart', () => {
  const { users, credits } = setup('credits-reconcile');
  const { reconcileCredits } = loadFresh('../dist/services/credits/reconcile');
  users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  credits.setBalance(alice.id, 10_000, 'admin-1');
  credits.reserveCredits(users.getUserById(alice.id), 4_000, { kind: 'batch', id: 'bat_dead' });
  assert.equal(users.getUserById(alice.id).balanceMilli, 6_000);

  // A run younger than the cutoff is left alone - releasing one that is merely
  // slow would hand back credit for resumes that then arrive.
  assert.equal(reconcileCredits().released, 0);
  assert.equal(users.getUserById(alice.id).balanceMilli, 6_000);

  // Now pretend the restart is hours later.
  const report = reconcileCredits(Date.now() + 7 * 60 * 60_000);
  assert.equal(report.released, 1);
  assert.equal(report.releasedMilli, 4_000);
  assert.equal(users.getUserById(alice.id).balanceMilli, 10_000);
  assert.deepEqual(report.inconsistent, []);
});

test('a balance written behind the service\'s back is reported, not silently repaired', () => {
  const { users, credits, repo } = setup('credits-inconsistent');
  const { getDb } = loadFresh('../dist/database/sqlite');
  users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  credits.setBalance(alice.id, 5_000, 'admin-1');

  // Exactly what the removed updateUser branch used to do.
  getDb().prepare('UPDATE users SET balance_milli = 99000 WHERE id = ?').run(alice.id);

  const found = repo.findInconsistentBalances();
  assert.equal(found.length, 1);
  assert.equal(found[0].balanceMilli, 99_000);
  assert.equal(found[0].ledgerSumMilli, 5_000);
  // Reported rather than corrected: a disagreement means something wrote the
  // column outside the service, and quietly fixing it would hide that.
  assert.equal(users.getUserById(alice.id).balanceMilli, 99_000);
});

test('updateUser can no longer move a balance at all', () => {
  const { users, credits } = setup('credits-no-backdoor');
  users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  credits.setBalance(alice.id, 4_000, 'admin-1');

  // The branch is gone. It did an absolute SET, so two debits through it
  // composed as "last one wins" and the first spend vanished.
  users.updateUser(alice.id, { credits: 1000, balanceMilli: 1_000_000, name: 'Alice' });

  assert.equal(users.getUserById(alice.id).balanceMilli, 4_000, 'the balance is untouched');
  assert.equal(users.getUserById(alice.id).name, 'Alice', 'the rest of the update still applies');
});

test('a run that threw before settling gives everything back', () => {
  const { users, credits } = setup('credits-threw');
  users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  credits.setBalance(alice.id, 10_000, 'admin-1');
  credits.reserveCredits(users.getUserById(alice.id), 5_000, { kind: 'request', id: 'res_1' });
  assert.equal(users.getUserById(alice.id).balanceMilli, 5_000);

  // What the handlers' `finally` does when the body threw before reaching
  // settleRun: nothing was delivered as far as anyone can prove, so the whole
  // reservation comes back.
  assert.equal(credits.releaseReservation('res_1', 'The run did not finish.'), 5_000);
  assert.equal(users.getUserById(alice.id).balanceMilli, 10_000);
});

test('settling and releasing are opposites, and settling wins the race', () => {
  const { users, credits } = setup('credits-settle-vs-release');
  users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  credits.setBalance(alice.id, 8_000, 'admin-1');
  credits.reserveCredits(users.getUserById(alice.id), 3_000, { kind: 'request', id: 'res_1' });

  assert.equal(credits.settleRun('res_1'), true);
  // Settling twice is not a second close, and the sweep after it is inert.
  assert.equal(credits.settleRun('res_1'), false);
  assert.equal(credits.releaseReservation('res_1', 'late sweep'), 0);
  assert.equal(users.getUserById(alice.id).balanceMilli, 5_000, 'three resumes, three dollars');
});

test('a $0.023 resume seven times is exactly $0.161, and two refunds give back exactly $0.046', () => {
  const { users, credits, repo } = setup('credits-exact');
  users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  // A dollar exactly: the case floats get wrong (ten $0.10 grants as floats sum
  // to 0.9999999999999999, and a balance that holds exactly enough is refused).
  credits.setBalance(alice.id, 1_000, 'admin-1');

  const price = 23;
  const run = credits.reserveCredits(users.getUserById(alice.id), price * 7, { kind: 'batch', id: 'bat_7' });
  assert.equal(run.costMilli, 161);
  assert.equal(users.getUserById(alice.id).balanceMilli, 839);
  assert.equal(credits.getReservation('bat_7').unitsMilli, 161);

  // Two of the seven did not deliver; each gives back exactly its own price.
  credits.refundTaskUnit('bat_7', 'tsk_a', price, 'failed');
  credits.refundTaskUnit('bat_7', 'tsk_b', price, 'cancelled');
  const reservation = credits.getReservation('bat_7');
  assert.equal(reservation.refundedMilli, 46);
  assert.equal(users.getUserById(alice.id).balanceMilli, 885, '$1.000 - $0.161 + $0.046');
  assert.equal(credits.settleRun('bat_7'), true);
  assert.equal(users.getUserById(alice.id).balanceMilli, 885, 'the five delivered stay spent: $0.115');
  assert.deepEqual(repo.findInconsistentBalances(), []);

  // And an account holding EXACTLY the price can buy it.
  const bob = users.createUser({ email: 'bob@example.com' });
  for (let grant = 0; grant < 10; grant += 1) credits.grantCredits(bob.id, 100, 'admin-1', '$0.100');
  assert.equal(users.getUserById(bob.id).balanceMilli, 1_000);
  credits.reserveCredits(users.getUserById(bob.id), 1_000, { kind: 'request', id: 'res_dollar' });
  assert.equal(users.getUserById(bob.id).balanceMilli, 0);
});

test('nothing floors: a fraction of a thousandth is refused, never rounded into a cheaper charge', () => {
  const { users, credits } = setup('credits-no-floor');
  users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  credits.setBalance(alice.id, 1_000, 'admin-1');

  // 22.6 floored would be 22 - a resume sold below its price without a word.
  for (const bad of [22.6, -1, Number.NaN, 0.5]) {
    assert.throws(() => credits.reserveCredits(users.getUserById(alice.id), bad, { kind: 'batch', id: `bat_${bad}` }));
  }
  credits.reserveCredits(users.getUserById(alice.id), 23, { kind: 'batch', id: 'bat_ok' });
  assert.throws(() => credits.refundTaskUnit('bat_ok', 'tsk_1', 0.4, 'half a thousandth'));
  assert.throws(() => credits.grantCredits(alice.id, 0.5, 'admin-1'));
  assert.throws(() => credits.setBalance(alice.id, 12.5, 'admin-1'));
  // One thousandth is a real amount, and moves as one.
  credits.grantCredits(alice.id, 1, 'admin-1', 'a tenth of a cent');
  assert.equal(users.getUserById(alice.id).balanceMilli, 978);
});

test('a charge line names each model and the total in dollars', () => {
  const { credits } = setup('credits-describe');
  assert.equal(
    credits.describeCharge([
      { modelLabel: 'Claude Sonnet', costMilli: 23 },
      { modelLabel: 'Claude Sonnet', costMilli: 23 },
      { modelLabel: 'Codex', costMilli: 10 },
    ]),
    '3 resumes: 2 x Claude Sonnet @ $0.023, 1 x Codex @ $0.01 = $0.056'
  );
  assert.equal(credits.describeCharge([{ modelLabel: 'Free', costMilli: 0 }]), '1 resume: 1 x Free @ $0 = $0');
});

test('CREDIT_SIGNUP_GRANT is dollars to $0.001, and junk grants nothing rather than a guess', () => {
  const { credits } = setup('credits-signup-parse');
  const { resetEnvWarningsForTests } = require('../dist/config/envValue');
  const warned = [];
  const realWarn = console.warn;
  console.warn = (...args) => warned.push(args.join(' '));
  try {
    resetEnvWarningsForTests();
    assert.equal(credits.signupGrantMilli({}), 0);
    assert.equal(credits.signupGrantMilli({ CREDIT_SIGNUP_GRANT: '5' }), 5_000);
    assert.equal(credits.signupGrantMilli({ CREDIT_SIGNUP_GRANT: '0.025' }), 25);
    assert.equal(credits.signupGrantMilli({ CREDIT_SIGNUP_GRANT: '0.0005' }), 0);
    assert.equal(credits.signupGrantMilli({ CREDIT_SIGNUP_GRANT: 'five' }), 0);
    assert.equal(credits.signupGrantMilli({ CREDIT_SIGNUP_GRANT: '-2' }), 0);
    assert.equal(credits.signupGrantMilli({ CREDIT_SIGNUP_GRANT: '1e3' }), 0);
    // Above the ceiling clamps, like every number envValue reads.
    assert.equal(credits.signupGrantMilli({ CREDIT_SIGNUP_GRANT: '5000' }), credits.MAX_SIGNUP_GRANT_MILLI);
  } finally {
    console.warn = realWarn;
    resetEnvWarningsForTests();
  }
  assert.ok(warned.some((line) => /CREDIT_SIGNUP_GRANT="0\.0005" has more than three decimal places/.test(line)), warned.join('\n'));
});
