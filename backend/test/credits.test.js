const assert = require('node:assert/strict');
const test = require('node:test');

const { loadFresh, useTempStorage, useAdminEmails } = require('./helpers');

/**
 * Credits, and the ledger that explains them.
 *
 * The invariant everything here defends is: CREDITS SPENT EQUALS RESUMES
 * DELIVERED. A charge that survives a failure is a credit taken for nothing; a
 * refund that runs twice is a credit invented. Both are the kind of bug a user
 * notices and cannot prove, so they are pinned individually.
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
  credits.setBalance(alice.id, 10, 'admin-1');

  credits.reserveCredits(users.getUserById(alice.id), 3, { kind: 'batch', id: 'bat_1', label: '3 resumes' });

  assert.equal(users.getUserById(alice.id).credits, 7, 'charged before any work ran');

  const entries = credits.getLedger(alice.id);
  assert.equal(entries[0].delta, -3);
  assert.equal(entries[0].reason, 'generation-reserve');
  // Measured after the move, not predicted before it.
  assert.equal(entries[0].balanceAfter, 7);
  assert.equal(entries[0].refId, 'bat_1');
});

test('a run that cannot be afforded is refused and takes nothing', () => {
  const { users, credits } = setup('credits-refuse');
  users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  credits.setBalance(alice.id, 2, 'admin-1');

  assert.throws(
    () => credits.reserveCredits(users.getUserById(alice.id), 5, { kind: 'batch', id: 'bat_1' }),
    (error) => error.name === 'InsufficientCreditsError' && error.needed === 5 && error.balance === 2
  );

  // Nothing partial: the whole transaction rolls back, so a refused run leaves
  // no reservation to be refunded later and no row claiming a charge.
  assert.equal(users.getUserById(alice.id).credits, 2);
  assert.equal(credits.getReservation('bat_1'), null);
  assert.equal(credits.getLedger(alice.id).filter((e) => e.reason === 'generation-reserve').length, 0);
});

test('the refusal names the numbers, not just the problem', () => {
  const { users, credits } = setup('credits-refusal-message');
  users.createUser({ email: 'admin@example.com' });
  const broke = users.createUser({ email: 'broke@example.com' });

  try {
    credits.reserveCredits(users.getUserById(broke.id), 4, { kind: 'batch', id: 'bat_1' });
    assert.fail('should have refused');
  } catch (error) {
    // A zero balance and a merely-insufficient one point at different remedies.
    // The message deliberately does not name WHERE to get more: it is written
    // once and read on installs that may or may not have a checkout, so the
    // page catching it links accordingly.
    assert.match(error.message, /needs 4 credits and the account has none/i);
    assert.match(error.message, /add credits/i);
    assert.doesNotMatch(error.message, /administrator/i);
  }

  credits.setBalance(broke.id, 2, 'admin-1');
  try {
    credits.reserveCredits(users.getUserById(broke.id), 4, { kind: 'batch', id: 'bat_2' });
    assert.fail('should have refused');
  } catch (error) {
    assert.match(error.message, /needs 4 credits and the account has 2/i);
    assert.match(error.message, /fewer at once/i);
  }
});

test('two runs racing for the last credits cannot both win', () => {
  const { users, credits } = setup('credits-race');
  users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  credits.setBalance(alice.id, 10, 'admin-1');

  // The account object is read ONCE and handed to both, which is exactly the
  // stale snapshot a request holds in req.user. The guarantee has to come from
  // the conditional UPDATE, not from the caller re-reading.
  const snapshot = users.getUserById(alice.id);

  credits.reserveCredits(snapshot, 10, { kind: 'batch', id: 'bat_1' });
  assert.throws(
    () => credits.reserveCredits(snapshot, 10, { kind: 'batch', id: 'bat_2' }),
    /needs 10 credits and the account has none/i
  );

  assert.equal(users.getUserById(alice.id).credits, 0);
});

test('an admin is exempt, and every refund against an exempt run is a no-op', () => {
  const { users, credits } = setup('credits-exempt');
  const admin = users.createUser({ email: 'admin@example.com' });
  credits.setBalance(admin.id, 5, admin.id);

  const result = credits.reserveCredits(users.getUserById(admin.id), 100, {
    kind: 'batch',
    id: 'bat_1',
  });

  assert.equal(result.exempt, true);
  assert.equal(result.units, 0);
  assert.equal(users.getUserById(admin.id).credits, 5, 'balance untouched');
  // No reservation row exists, so the refund path finds nothing rather than
  // having to remember to re-check the role.
  assert.equal(credits.getReservation('bat_1'), null);
  assert.equal(credits.refundTaskUnit('bat_1', 'tsk_1', 'failed'), 0);
  assert.equal(users.getUserById(admin.id).credits, 5, 'a refund cannot invent credits');
});

test('a unit that did not deliver gives its credit back, once', () => {
  const { users, credits } = setup('credits-refund-once');
  users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  credits.setBalance(alice.id, 10, 'admin-1');
  credits.reserveCredits(users.getUserById(alice.id), 3, { kind: 'batch', id: 'bat_1' });

  assert.equal(credits.refundTaskUnit('bat_1', 'tsk_1', 'failed'), 1);
  assert.equal(users.getUserById(alice.id).credits, 8);

  // The same task again. A queue hook can fire twice - after a restart, or on a
  // re-settle - and the idempotency key is what makes the second one free.
  assert.equal(credits.refundTaskUnit('bat_1', 'tsk_1', 'failed'), 0);
  assert.equal(users.getUserById(alice.id).credits, 8);
});

test('a run can never refund more than it was charged', () => {
  const { users, credits } = setup('credits-cap');
  users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  credits.setBalance(alice.id, 10, 'admin-1');
  credits.reserveCredits(users.getUserById(alice.id), 2, { kind: 'batch', id: 'bat_1' });
  assert.equal(users.getUserById(alice.id).credits, 8);

  // Three distinct tasks against a two-unit reservation. The third is capped in
  // SQL, so a caller that invented a fresh key still cannot over-refund.
  assert.equal(credits.refundTaskUnit('bat_1', 'tsk_1', 'failed'), 1);
  assert.equal(credits.refundTaskUnit('bat_1', 'tsk_2', 'failed'), 1);
  assert.equal(credits.refundTaskUnit('bat_1', 'tsk_3', 'failed'), 0);

  assert.equal(users.getUserById(alice.id).credits, 10, 'back to where it started, never above');
});

test('releasing sweeps what is left, for a run that never accounted for itself', () => {
  const { users, credits } = setup('credits-release');
  users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  credits.setBalance(alice.id, 10, 'admin-1');
  credits.reserveCredits(users.getUserById(alice.id), 5, { kind: 'request', id: 'res_1' });
  credits.refundUnits('res_1', 2, 'two failed');

  assert.equal(credits.releaseReservation('res_1', 'done'), 3, 'the three still outstanding');
  assert.equal(users.getUserById(alice.id).credits, 10);

  // Closed, so a late refund cannot reopen it and hand back credits twice.
  assert.equal(credits.getReservation('res_1').state, 'closed');
  assert.equal(credits.releaseReservation('res_1', 'again'), 0);
  assert.equal(credits.refundTaskUnit('res_1', 'tsk_late', 'late'), 0);
  assert.equal(users.getUserById(alice.id).credits, 10);
});

test('a fully delivered run releases nothing', () => {
  const { users, credits } = setup('credits-delivered');
  users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  credits.setBalance(alice.id, 10, 'admin-1');
  credits.reserveCredits(users.getUserById(alice.id), 4, { kind: 'request', id: 'res_1' });

  // Nothing failed, so nothing is refunded and the run SETTLES: what was not
  // refunded was delivered, and its credits are spent. Four resumes, four
  // credits. Releasing instead would hand all four back - which is to say it
  // would make every successful run free.
  assert.equal(credits.refundUnits('res_1', 0, 'none failed'), 0);
  assert.equal(credits.settleRun('res_1'), true);
  assert.equal(users.getUserById(alice.id).credits, 6);

  // And the finally-sweep the handlers run unconditionally is then a no-op.
  assert.equal(credits.releaseReservation('res_1', 'did not finish'), 0);
  assert.equal(users.getUserById(alice.id).credits, 6);
});

test('the balance always equals the sum of the ledger', () => {
  const { users, credits, repo } = setup('credits-invariant');
  users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });

  credits.setBalance(alice.id, 20, 'admin-1');
  credits.reserveCredits(users.getUserById(alice.id), 6, { kind: 'batch', id: 'bat_1' });
  credits.refundTaskUnit('bat_1', 'tsk_1', 'failed');
  credits.refundTaskUnit('bat_1', 'tsk_2', 'cancelled');
  credits.releaseReservation('bat_1', 'done');
  credits.grantCredits(alice.id, 5, 'admin-1', 'top-up');

  const sum = credits.getLedger(alice.id, 500).reduce((total, entry) => total + entry.delta, 0);
  assert.equal(users.getUserById(alice.id).credits, sum);
  // And the standing check agrees, which is what the boot reconciler reports on.
  assert.deepEqual(repo.findInconsistentBalances(), []);
});

test('every movement is explainable, and the reserve does not claim to be a delivery', () => {
  const { users, credits } = setup('credits-explainable');
  users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  credits.setBalance(alice.id, 9, 'admin-1', 'opening');
  credits.reserveCredits(users.getUserById(alice.id), 2, { kind: 'batch', id: 'bat_1', label: '1 job x 2 profiles' });
  credits.refundTaskUnit('bat_1', 'tsk_1', 'Ada / Acme: failed');

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
  credits.setBalance(alice.id, 10, 'admin-1');
  credits.reserveCredits(users.getUserById(alice.id), 4, { kind: 'batch', id: 'bat_1' });

  // The dip is real and is named rather than hidden: 6 spendable, 4 held
  // against work that has not finished.
  let status = credits.getStatus(users.getUserById(alice.id));
  assert.equal(status.balance, 6);
  assert.equal(status.held, 4);
  assert.equal(status.exempt, false);

  credits.refundTaskUnit('bat_1', 'tsk_1', 'failed');
  status = credits.getStatus(users.getUserById(alice.id));
  assert.equal(status.balance, 7);
  assert.equal(status.held, 3);
});

test('a new account starts at zero unless an operator says otherwise', () => {
  useTempStorage('credits-signup-default');
  useAdminEmails('admin@example.com');
  const users = loadFresh('../dist/database/userRepository');
  users.createUser({ email: 'admin@example.com' });
  assert.equal(users.createUser({ email: 'alice@example.com' }).credits, 0);
});

test('CREDIT_SIGNUP_GRANT gives new accounts an opening balance, once', () => {
  useTempStorage('credits-signup-grant');
  useAdminEmails('admin@example.com');
  process.env.CREDIT_SIGNUP_GRANT = '3';
  try {
    const users = loadFresh('../dist/database/userRepository');
    const credits = loadFresh('../dist/services/credits');
    users.createUser({ email: 'admin@example.com' });
    const alice = users.createUser({ email: 'alice@example.com' });

    assert.equal(alice.credits, 3, 'the returned account already shows the grant');
    const entry = credits.getLedger(alice.id)[0];
    assert.equal(entry.reason, 'signup-grant');
    assert.equal(entry.delta, 3);

    // Keyed on the account, so a retried sign-in cannot grant twice.
    credits.applySignupGrant(users.getUserById(alice.id));
    assert.equal(users.getUserById(alice.id).credits, 3);
  } finally {
    delete process.env.CREDIT_SIGNUP_GRANT;
  }
});

test('an abandoned run has its credits released on restart', () => {
  const { users, credits } = setup('credits-reconcile');
  const { reconcileCredits } = loadFresh('../dist/services/credits/reconcile');
  users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  credits.setBalance(alice.id, 10, 'admin-1');
  credits.reserveCredits(users.getUserById(alice.id), 4, { kind: 'batch', id: 'bat_dead' });
  assert.equal(users.getUserById(alice.id).credits, 6);

  // A run younger than the cutoff is left alone - releasing one that is merely
  // slow would hand back credits for resumes that then arrive.
  assert.equal(reconcileCredits().released, 0);
  assert.equal(users.getUserById(alice.id).credits, 6);

  // Now pretend the restart is hours later.
  const report = reconcileCredits(Date.now() + 7 * 60 * 60_000);
  assert.equal(report.released, 1);
  assert.equal(report.credits, 4);
  assert.equal(users.getUserById(alice.id).credits, 10);
  assert.deepEqual(report.inconsistent, []);
});

test('a balance written behind the service\'s back is reported, not silently repaired', () => {
  const { users, credits, repo } = setup('credits-inconsistent');
  const { getDb } = loadFresh('../dist/database/sqlite');
  users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  credits.setBalance(alice.id, 5, 'admin-1');

  // Exactly what the removed updateUser branch used to do.
  getDb().prepare('UPDATE users SET credits = 99 WHERE id = ?').run(alice.id);

  const found = repo.findInconsistentBalances();
  assert.equal(found.length, 1);
  assert.equal(found[0].balance, 99);
  assert.equal(found[0].ledgerSum, 5);
  // Reported rather than corrected: a disagreement means something wrote the
  // column outside the service, and quietly fixing it would hide that.
  assert.equal(users.getUserById(alice.id).credits, 99);
});

test('updateUser can no longer move a balance at all', () => {
  const { users, credits } = setup('credits-no-backdoor');
  users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  credits.setBalance(alice.id, 4, 'admin-1');

  // The branch is gone. It did an absolute SET, so two debits through it
  // composed as "last one wins" and the first spend vanished.
  users.updateUser(alice.id, { credits: 1000, name: 'Alice' });

  assert.equal(users.getUserById(alice.id).credits, 4, 'the balance is untouched');
  assert.equal(users.getUserById(alice.id).name, 'Alice', 'the rest of the update still applies');
});

test('a run that threw before settling gives everything back', () => {
  const { users, credits } = setup('credits-threw');
  users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  credits.setBalance(alice.id, 10, 'admin-1');
  credits.reserveCredits(users.getUserById(alice.id), 5, { kind: 'request', id: 'res_1' });
  assert.equal(users.getUserById(alice.id).credits, 5);

  // What the handlers' `finally` does when the body threw before reaching
  // settleRun: nothing was delivered as far as anyone can prove, so the whole
  // reservation comes back.
  assert.equal(credits.releaseReservation('res_1', 'The run did not finish.'), 5);
  assert.equal(users.getUserById(alice.id).credits, 10);
});

test('settling and releasing are opposites, and settling wins the race', () => {
  const { users, credits } = setup('credits-settle-vs-release');
  users.createUser({ email: 'admin@example.com' });
  const alice = users.createUser({ email: 'alice@example.com' });
  credits.setBalance(alice.id, 8, 'admin-1');
  credits.reserveCredits(users.getUserById(alice.id), 3, { kind: 'request', id: 'res_1' });

  assert.equal(credits.settleRun('res_1'), true);
  // Settling twice is not a second close, and the sweep after it is inert.
  assert.equal(credits.settleRun('res_1'), false);
  assert.equal(credits.releaseReservation('res_1', 'late sweep'), 0);
  assert.equal(users.getUserById(alice.id).credits, 5, 'three resumes, three credits');
});
