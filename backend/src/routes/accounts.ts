import { Router, type Request, type Response } from 'express';

import { isAccountRole, listRoles, ROLE_LABELS } from '../config/accountRoles';
import { isSubscriptionId, listSubscriptions, resolveSubscription } from '../config/accountSubscriptions';
import { isConfiguredAdmin, resolveAdminIdentity, type AdminSource } from '../config/adminIdentity';
import { parseReportRateUsd } from '../config/reportRate';
import { globalReportRateMilli } from '../services/jobLake/settings';
import { countProfilesForOwner } from '../database/profileRepository';
import {
  countAdmins,
  createUser,
  deleteUser,
  destroySessionsForUser,
  getReportRateMilli,
  getUserByEmail,
  getUserById,
  listReportRates,
  listUsers,
  normalizeEmail,
  setReportRateMilli,
  updateUser,
} from '../database/userRepository';
import { requireAdmin } from '../middleware/auth';
import { sendPublicError } from '../middleware/publicError';
import { ensureAccountSheet } from '../services/sheets/accountSheet';
import { getLedger, grantCredits, PAYOUT_REQUEST_ID, readPayoutNote, setBalance } from '../services/credits';
import { recordDirectPayout } from '../services/refunds';
import type { AccountUpdate, UserAccount, UserRole } from '../types/account';
import { describeDollarProblem, formatMoney, parseDollars } from '../utils/money';

/**
 * Managing other people's accounts.
 *
 * Admin-only, and the interesting part is what an admin may NOT do: strand the
 * installation. Every guard below is a variation on that - the last admin
 * cannot be demoted, disabled or deleted, because there would then be nobody
 * who could undo it and no way in through the UI to appoint a replacement.
 * And no administrator may do any of the three to their OWN account: another
 * administrator can, which is the check that it was meant.
 */

const router = Router();
router.use(requireAdmin);

type AccountRow = UserAccount & {
  subscriptionLabel: string;
  profileLimit: number | null;
  profilesUsed: number;
  roleLabel: string;
  /**
   * A reporter's own pay per accepted job, in thousandths of a dollar; null
   * means the installation's global rate. On every row, whatever the role -
   * an account made a user keeps the figure it had, for if it is made a
   * reporter again. Served HERE only, to administrators; never on the
   * session payload.
   */
  reportRateMilli: number | null;
  /**
   * The address is in ADMIN_EMAILS (or is the SMTP_USER fallback), so it is
   * made an administrator again at its next sign-in and at every restart
   * (`promoteIfConfiguredAdmin`, promote-only). The page says so beside a role
   * select that cannot make anything else of it for long.
   */
  configuredAdmin: boolean;
  /**
   * Which setting names it - null when none does. The page names it on the
   * row, as `configuredAdminNote` does in a demotion's note: an install that
   * signs in by email and sets no ADMIN_EMAILS has its operator from
   * SMTP_USER, and a row pointing at an empty ADMIN_EMAILS sent them to the
   * wrong setting.
   */
  configuredAdminSource: Exclude<AdminSource, 'none'> | null;
};

/** The setting that makes `email` an administrator at every sign-in, if one does. */
function configuredAdminSource(email: string): Exclude<AdminSource, 'none'> | null {
  if (!isConfiguredAdmin(email)) return null;
  const { source } = resolveAdminIdentity();
  return source === 'none' ? null : source;
}

function describe(account: UserAccount, rates?: Map<string, number | null>): AccountRow {
  const subscription = resolveSubscription(account.subscription);
  return {
    ...account,
    subscriptionLabel: subscription.label,
    profileLimit: subscription.profileLimit,
    profilesUsed: countProfilesForOwner(account.id),
    roleLabel: ROLE_LABELS[account.role],
    reportRateMilli: rates ? (rates.get(account.id) ?? null) : getReportRateMilli(account.id),
    configuredAdmin: isConfiguredAdmin(account.email),
    configuredAdminSource: configuredAdminSource(account.email),
  };
}

/**
 * A `role` from a body: undefined when it is not there, the role when it is
 * one this build has, or null after answering 400. Refused rather than
 * ignored: an invite meant for a Reporter that quietly made a User would hand
 * somebody the builder nobody meant them to have.
 */
function readRole(req: Request, res: Response): UserRole | undefined | null {
  const value = req.body?.role;
  if (value === undefined) return undefined;
  if (isAccountRole(value)) return value;
  res.status(400).json({
    error: `The role must be one of ${listRoles().map((role) => role.id).join(', ')}.`,
    code: 'bad-role',
  });
  return null;
}

/**
 * A `reportRateUsd` from a body, for an account whose role will be
 * `resultingRole`: undefined when it is not there, `{ milli }` when it is
 * (null clears the override), or null after answering 400/409.
 *
 * Only a reporter is paid per job, so setting a rate on any other account is
 * refused - in the same change that makes it a reporter is fine. Clearing one
 * is accepted on any account.
 */
function readReportRate(
  req: Request,
  res: Response,
  resultingRole: UserRole
): { milli: number | null } | undefined | null {
  if (req.body?.reportRateUsd === undefined) return undefined;
  const parsed = parseReportRateUsd(req.body.reportRateUsd);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error, code: 'bad-rate' });
    return null;
  }
  if (parsed.milli !== null && resultingRole !== 'reporter') {
    res.status(409).json({
      error: 'Only a reporter is paid per job. Make the account a Reporter first, or in the same change.',
      code: 'not-a-reporter',
    });
    return null;
  }
  return { milli: parsed.milli };
}

/**
 * What the response says when an administrator takes the admin role from an
 * address the configuration names. Allowed - the configuration is the
 * operator's, and the page may be how they find out - but it does not stick,
 * and saying so now beats them discovering it at that person's next sign-in.
 */
function configuredAdminNote(target: UserAccount, nextRole: UserRole | undefined): string | undefined {
  if (nextRole === undefined || nextRole === 'admin' || !isConfiguredAdmin(target.email)) return undefined;
  const { source } = resolveAdminIdentity();
  return (
    `${target.email} is named by ${source}, so it becomes an administrator again the next time it signs in ` +
    `or the server restarts. Remove it from ${source} to make this change last.`
  );
}

/**
 * True when this change takes an administrator away: any role that is not
 * `admin`, or disabling the account.
 *
 * Any role, not `user` by name. It used to read `next.role === 'user'`, which
 * was the same thing while there were two roles - and would let the last
 * administrator be demoted to a third one straight past every guard below.
 */
function losesAdmin(next: AccountUpdate): boolean {
  return (next.role !== undefined && next.role !== 'admin') || next.disabled === true;
}

/**
 * True when changing this account would leave the installation with no admin.
 *
 * Counts only ENABLED admins, because a disabled one cannot sign in and so is
 * not an answer to "who can fix this".
 *
 * Behind `refuseOwnAccountChange` now, which reaches the commonest way here -
 * the last administrator stepping down - first. Kept as its own guard because
 * it is the one that protects the installation rather than the person: it
 * asks the database, not who is asking.
 */
export function wouldStrandInstall(target: UserAccount, next: AccountUpdate): boolean {
  if (target.role !== 'admin' || target.disabled) return false;
  if (!losesAdmin(next)) return false;
  return countAdmins() <= 1;
}

/**
 * Refuses, after answering 409, an administrator disabling, demoting or
 * deleting the account they are signed in with.
 *
 * Another administrator may do any of those to them - the last-admin guard
 * still decides whether the installation can spare one - but not they
 * themselves. Disabling yourself ends your own sessions on the spot, and a
 * demotion takes this page away mid-click; either way the person who made the
 * mistake is the one person who can no longer undo it. Asking somebody else
 * is the check that it was meant.
 *
 * `code: 'own-account'` so the page can say it without reading the English.
 */
function refuseOwnAccountChange(
  req: Request,
  res: Response,
  target: UserAccount,
  next: AccountUpdate | 'delete'
): boolean {
  if (target.id !== req.user?.id) return false;
  if (next !== 'delete' && !losesAdmin(next)) return false;
  const action =
    next === 'delete'
      ? 'delete'
      : next.disabled === true
        ? 'disable'
        : 'remove the administrator role from';
  res.status(409).json({
    error:
      `You cannot ${action} the account you are signed in with. ` +
      'Another administrator can, if it is really meant.',
    code: 'own-account',
  });
  return true;
}

/**
 * An amount an administrator typed, in dollars, as thousandths - or null after
 * answering 400 with what was wrong with it. Admin-only, so the sentence may
 * say exactly what to type.
 */
function readDollars(
  res: Response,
  value: unknown,
  label: string,
  options: { allowNegative?: boolean } = {}
): number | null {
  const parsed = parseDollars(value, options);
  if (!parsed.ok) {
    res.status(400).json({ error: describeDollarProblem(parsed.problem, label) });
    return null;
  }
  return parsed.milli;
}

router.get('/', (_req: Request, res: Response) => {
  const rates = listReportRates();
  res.json({
    accounts: listUsers().map((account) => describe(account, rates)),
    subscriptions: listSubscriptions(),
    // The role catalog rides along like the subscriptions, so the page's
    // select is not a second copy of it.
    roles: listRoles(),
    // What a reporter with no rate of their own is paid per accepted job
    // (Admin -> Job Lake), so the per-reporter rate box can name it.
    globalReportRateMilli: globalReportRateMilli(),
  });
});

router.get('/:id', (req: Request<{ id: string }>, res: Response) => {
  const account = getUserById(req.params.id);
  if (!account) {
    res.status(404).json({ error: 'No such account.' });
    return;
  }
  res.json({ account: describe(account) });
});

/**
 * Creates an account ahead of its first sign-in.
 *
 * Not a way to let somebody in - there is no password to set, and they still
 * have to prove the address through Google or a code. It exists so an admin can
 * set the subscription and role BEFORE the person arrives, rather than having
 * them sign in on the Default subscription and be upgraded afterwards - and,
 * for a reporter, before they ever see the builder.
 *
 * `{ email, name?, role?, subscription?, balanceUsd?, reportRateUsd? }`.
 * `role` is user (the default), reporter or admin; `reportRateUsd` only with
 * reporter. An address the configuration names as an administrator is made
 * one at its first sign-in whatever role it was created with
 * (`configuredAdmin` on the row says so).
 */
router.post('/', (req: Request, res: Response) => {
  const email = normalizeEmail(req.body?.email);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: 'A valid email address is required.' });
    return;
  }
  if (getUserByEmail(email)) {
    res.status(409).json({ error: 'An account already exists for that address.' });
    return;
  }
  // Read before the account exists, so a mistyped opening balance creates nothing.
  let openingMilli = 0;
  if (req.body?.balanceUsd !== undefined && req.body.balanceUsd !== '') {
    const opening = readDollars(res, req.body.balanceUsd, 'The opening balance');
    if (opening === null) return;
    openingMilli = opening;
  }

  const requestedRole = readRole(req, res);
  if (requestedRole === null) return;
  const role: UserRole = requestedRole ?? 'user';
  const rate = readReportRate(req, res, role);
  if (rate === null) return;

  const account = createUser({
    email,
    name: typeof req.body?.name === 'string' ? req.body.name : undefined,
    role,
  });

  const update: AccountUpdate = {};
  if (isSubscriptionId(req.body?.subscription)) update.subscription = req.body.subscription;
  const patched = Object.keys(update).length > 0 ? updateUser(account.id, update) : account;
  if (rate && rate.milli !== null) setReportRateMilli(account.id, rate.milli);

  // Through the ledger, so even an opening balance typed on this form has a row
  // saying who granted it and when.
  if (openingMilli > 0) {
    grantCredits(account.id, openingMilli, req.user!.id, 'Opening balance set when the account was added.');
  }

  // Started, not awaited, exactly as on the sign-in path: an account made here
  // would otherwise have no spreadsheet until its owner first signed in, or
  // until the next restart ran the backfill - which on a long-lived server
  // could be weeks.
  void ensureAccountSheet(account).catch((error) => {
    console.warn(`[sheets] Could not prepare the sheet for ${account.email}.`, error);
  });

  const note = configuredAdminNote(account, role);
  res.status(201).json({
    account: describe(getUserById(account.id) ?? patched ?? account),
    ...(note ? { note } : {}),
  });
});

router.patch('/:id', (req: Request<{ id: string }>, res: Response) => {
  const target = getUserById(req.params.id);
  if (!target) {
    res.status(404).json({ error: 'No such account.' });
    return;
  }

  const update: AccountUpdate = {};
  const role = readRole(req, res);
  if (role === null) return;
  if (role !== undefined) update.role = role;
  // Checked against the role the account will HAVE, so `{ role: 'reporter',
  // reportRateUsd: '0.050' }` makes a reporter and sets their rate at once.
  const rate = readReportRate(req, res, update.role ?? target.role);
  if (rate === null) return;
  if (req.body?.subscription !== undefined) {
    if (!isSubscriptionId(req.body.subscription)) {
      res
        .status(400)
        .json({ error: `"${req.body.subscription}" is not a subscription this build knows about.` });
      return;
    }
    update.subscription = req.body.subscription;
  }
  // Read from the same body but applied separately: a balance is the sum of a
  // ledger, not a column to be overwritten, so it goes through setBalance which
  // writes the difference and a row explaining it. Dollars, exactly: "3.977"
  // is 3977 thousandths, and "3.9775" is refused rather than rounded.
  let wantedMilli: number | null = null;
  if (req.body?.balanceUsd !== undefined) {
    wantedMilli = readDollars(res, req.body.balanceUsd, 'The balance');
    if (wantedMilli === null) return;
  }
  if (typeof req.body?.disabled === 'boolean') update.disabled = req.body.disabled;
  if (typeof req.body?.name === 'string') update.name = req.body.name;

  if (Object.keys(update).length === 0 && wantedMilli === null && rate === undefined) {
    res.status(400).json({ error: 'There is nothing to change.' });
    return;
  }

  if (refuseOwnAccountChange(req, res, target, update)) return;
  if (wouldStrandInstall(target, update)) {
    res.status(409).json({
      error:
        'This is the only administrator left. Promote somebody else first, or this installation ' +
        'would have nobody who can manage it.',
      code: 'last-admin',
    });
    return;
  }

  if (wantedMilli !== null) {
    setBalance(target.id, wantedMilli, req.user!.id, 'Set from the accounts page.');
  }
  if (rate) setReportRateMilli(target.id, rate.milli);

  const updated =
    Object.keys(update).length > 0 ? updateUser(target.id, update) : getUserById(target.id);
  if (!updated) {
    res.status(404).json({ error: 'No such account.' });
    return;
  }

  // A disabled account's sessions go immediately. `resolveSession` refuses a
  // disabled account anyway, so this is belt and braces - but it also means the
  // rows are gone rather than sitting there until they expire.
  //
  // A ROLE change keeps them: `resolveSession` reads the account row on every
  // request, so the next request a new reporter makes is already refused the
  // builder (and a new user's already allowed it) - there is nothing stale to
  // end. What the account owned stays where it was, hidden behind the routes
  // its new role cannot reach. An order already queued finishes; a Generate
  // Immediately run of a user made a reporter does not: its tab can no longer
  // re-attach the stream that holds its lease (generation.ts is behind
  // requireUser), so it is cancelled, and what had not started refunded, about
  // LEASE_READER_LIFETIME_MS + IMMEDIATE_TAB_GRACE_MS after the change.
  if (update.disabled === true) destroySessionsForUser(updated.id);

  const note = configuredAdminNote(target, update.role);
  res.json({ account: describe(updated), ...(note ? { note } : {}) });
});

/**
 * Ends every session for an account without changing anything about it.
 *
 * The remedy for "somebody left their laptop on a train": they can sign in
 * again, and whoever has the old cookie cannot.
 */
router.post('/:id/sign-out', (req: Request<{ id: string }>, res: Response) => {
  const target = getUserById(req.params.id);
  if (!target) {
    res.status(404).json({ error: 'No such account.' });
    return;
  }
  res.json({ ended: destroySessionsForUser(target.id) });
});

router.delete('/:id', (req: Request<{ id: string }>, res: Response) => {
  const target = getUserById(req.params.id);
  if (!target) {
    res.status(404).json({ error: 'No such account.' });
    return;
  }

  if (refuseOwnAccountChange(req, res, target, 'delete')) return;
  if (wouldStrandInstall(target, { disabled: true })) {
    res.status(409).json({
      error: 'This is the only administrator left, so deleting it would lock everybody out.',
      code: 'last-admin',
    });
    return;
  }

  // The profiles are NOT deleted with the account. Deleting somebody's work as
  // a side effect of removing their login is not recoverable, and an admin who
  // wants that can delete the profiles first - or reassign them.
  const owned = countProfilesForOwner(target.id);
  deleteUser(target.id);

  res.json({
    deleted: true,
    orphanedProfiles: owned,
    ...(owned > 0
      ? {
          note:
            `${owned} profile${owned === 1 ? '' : 's'} belonged to that account and ` +
            'still exist. They are visible to administrators only until they are reassigned or deleted.',
        }
      : {}),
  });
});

/**
 * Adds to a balance, rather than setting it: `{ amountUsd, note? }`, dollars,
 * negative to take away.
 *
 * Beside the absolute field on purpose: "give them ten more" and "make it ten"
 * are different intentions, and making an admin do the arithmetic to express the
 * first is how somebody ends up taking credit away by accident. Exact to $0.001:
 * "0.005" grants five thousandths, "0.0005" is refused.
 */
router.post('/:id/credits', (req: Request<{ id: string }>, res: Response) => {
  const target = getUserById(req.params.id);
  if (!target) {
    res.status(404).json({ error: 'No such account.' });
    return;
  }

  const amountMilli = readDollars(res, req.body?.amountUsd, 'The amount', { allowNegative: true });
  if (amountMilli === null) return;
  if (amountMilli === 0) {
    res.status(400).json({ error: 'Give an amount in dollars to add, or a negative one to take away.' });
    return;
  }

  const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
  const balanceMilli = grantCredits(target.id, amountMilli, req.user!.id, note);
  const updated = getUserById(target.id);
  res.json({ account: describe(updated ?? target), balanceMilli });
});

/**
 * Records that a reporter was paid: `{ amountUsd, note, requestId? }` ->
 * `{ account, balanceMilli, entry, recorded }`.
 *
 * The money itself left OUTSIDE the app - owner decision A4: earnings are
 * paid by hand, and nothing here sends any - so this is the record of it, a
 * `reporter-payout` deduction carrying the administrator's note (how, when,
 * a reference), which the reporter reads in their own history. Refused for
 * an account that is not a reporter (409 `not-a-reporter`), and above the
 * balance (409 `insufficient-balance`, with `balanceMilli`): a payout record
 * is never clamped, because one that says less was paid than was is wrong.
 *
 * `requestId` (optional, the page's id for this one payout) makes a repeat -
 * a double press, a retried request - answer `recorded: false` with the first
 * row, instead of recording the payout twice.
 *
 * A payout recorded here also closes the reporter's open payout request, if
 * they have one, in the same transaction (`recordDirectPayout`) - so the
 * refund queue cannot pay that request a second time. `closedRequestId`
 * names it; null when none was open.
 */
router.post('/:id/payout', (req: Request<{ id: string }>, res: Response) => {
  const target = getUserById(req.params.id);
  if (!target) {
    res.status(404).json({ error: 'No such account.' });
    return;
  }
  if (target.role !== 'reporter') {
    res.status(409).json({
      error: 'Only a reporter is paid out. Use the +/- button beside the balance to add or take away credit on any other account.',
      code: 'not-a-reporter',
    });
    return;
  }

  const amountMilli = readDollars(res, req.body?.amountUsd, 'The payout');
  if (amountMilli === null) return;
  if (amountMilli === 0) {
    res.status(400).json({ error: 'Give the amount paid, in dollars.' });
    return;
  }

  const readNote = readPayoutNote(req.body?.note);
  if (!readNote.ok) {
    res.status(400).json({ error: readNote.error, code: readNote.code });
    return;
  }
  const note = readNote.note;

  const rawRequestId = req.body?.requestId;
  let requestId: string | undefined;
  if (rawRequestId !== undefined && rawRequestId !== null && rawRequestId !== '') {
    if (typeof rawRequestId !== 'string' || !PAYOUT_REQUEST_ID.test(rawRequestId)) {
      res.status(400).json({ error: 'The request id must be 8 to 100 letters, digits, - or _.', code: 'bad-request-id' });
      return;
    }
    requestId = rawRequestId;
  }

  let direct: ReturnType<typeof recordDirectPayout>;
  try {
    direct = recordDirectPayout({
      accountId: target.id,
      amountMilli,
      admin: req.user!,
      note,
      ...(requestId ? { requestId } : {}),
    });
  } catch (error) {
    sendPublicError(req, res, error, 'Could not record the payout');
    return;
  }
  const outcome = direct.outcome;
  if (!outcome.ok) {
    if (outcome.reason === 'no-account') {
      res.status(404).json({ error: 'No such account.' });
    } else if (outcome.reason === 'not-a-reporter') {
      res.status(409).json({ error: 'Only a reporter is paid out.', code: 'not-a-reporter' });
    } else {
      res.status(409).json({
        error:
          `That is more than this reporter's balance of ${formatMoney(outcome.balance)}. ` +
          'Record what was actually paid, up to the balance.',
        code: 'insufficient-balance',
        balanceMilli: outcome.balance,
      });
    }
    return;
  }

  // The reporter's notice ("Payout recorded: $X", in the bell as well as in
  // their history) went out with it, after the commit: a notice that could
  // not be written must not undo a record of money that has already left.

  const updated = getUserById(target.id) ?? target;
  res.status(outcome.applied ? 201 : 200).json({
    account: describe(updated),
    balanceMilli: outcome.balance,
    entry: outcome.entry,
    recorded: outcome.applied,
    closedRequestId: direct.closedRequest?.id ?? null,
  });
});

/** Every movement on one account, newest first, so a balance can be explained. */
router.get('/:id/credits', (req: Request<{ id: string }>, res: Response) => {
  const target = getUserById(req.params.id);
  if (!target) {
    res.status(404).json({ error: 'No such account.' });
    return;
  }
  res.json({ balanceMilli: target.balanceMilli, entries: getLedger(target.id, 200) });
});

export default router;
