import { Router, type Request, type Response } from 'express';

import { isSubscriptionId, listSubscriptions, resolveSubscription } from '../config/accountSubscriptions';
import { countProfilesForOwner } from '../database/profileRepository';
import {
  countAdmins,
  createUser,
  deleteUser,
  destroySessionsForUser,
  getUserByEmail,
  getUserById,
  listUsers,
  normalizeEmail,
  updateUser,
} from '../database/userRepository';
import { requireAdmin } from '../middleware/auth';
import { ensureAccountSheet } from '../services/sheets/accountSheet';
import { getLedger, grantCredits, setBalance } from '../services/credits';
import type { AccountUpdate, UserAccount, UserRole } from '../types/account';

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
};

function describe(account: UserAccount): AccountRow {
  const subscription = resolveSubscription(account.subscription);
  return {
    ...account,
    subscriptionLabel: subscription.label,
    profileLimit: subscription.profileLimit,
    profilesUsed: countProfilesForOwner(account.id),
  };
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
 * True, after answering 400, when a body still names the tier `plan`.
 *
 * The field was renamed `subscription` with no alias, because the frontend
 * ships with this file. But an Accounts page left open across the upgrade
 * still sends the old name, and ignoring it would be silent in the worst way:
 * an invite meant for Premium would create a Default account, and a change
 * would answer "nothing to change". Admin-only, so the sentence may say why.
 *
 * The refusal is the guarantee; the sentence is reached only by that old
 * page's Add-an-account form. Its table answers a refused change by reloading
 * the list, which no longer carries the `plans` it reads, so it breaks with a
 * client-side exception before the sentence is drawn. Nothing is changed
 * either way, and README's Troubleshooting row says to reload.
 */
function refuseRetiredPlanField(req: Request, res: Response): boolean {
  if (req.body?.plan === undefined) return false;
  res.status(400).json({
    error: 'This page is from an older version of the app. Reload it and try again.',
    code: 'stale-page',
  });
  return true;
}

router.get('/', (_req: Request, res: Response) => {
  res.json({ accounts: listUsers().map(describe), subscriptions: listSubscriptions() });
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
 * them sign in on the Default subscription and be upgraded afterwards.
 */
router.post('/', (req: Request, res: Response) => {
  if (refuseRetiredPlanField(req, res)) return;
  const email = normalizeEmail(req.body?.email);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: 'A valid email address is required.' });
    return;
  }
  if (getUserByEmail(email)) {
    res.status(409).json({ error: 'An account already exists for that address.' });
    return;
  }

  const role: UserRole = req.body?.role === 'admin' ? 'admin' : 'user';
  const account = createUser({
    email,
    name: typeof req.body?.name === 'string' ? req.body.name : undefined,
    role,
  });

  const update: AccountUpdate = {};
  if (isSubscriptionId(req.body?.subscription)) update.subscription = req.body.subscription;
  const patched = Object.keys(update).length > 0 ? updateUser(account.id, update) : account;

  // Through the ledger, so even an opening balance typed on this form has a row
  // saying who granted it and when.
  const opening = Number(req.body?.credits);
  if (Number.isFinite(opening) && opening > 0) {
    grantCredits(account.id, Math.floor(opening), req.user!.id, 'Opening balance set when the account was added.');
  }

  // Started, not awaited, exactly as on the sign-in path: an account made here
  // would otherwise have no spreadsheet until its owner first signed in, or
  // until the next restart ran the backfill - which on a long-lived server
  // could be weeks.
  void ensureAccountSheet(account).catch((error) => {
    console.warn(`[sheets] Could not prepare the sheet for ${account.email}.`, error);
  });

  res.status(201).json({ account: describe(getUserById(account.id) ?? patched ?? account) });
});

router.patch('/:id', (req: Request<{ id: string }>, res: Response) => {
  if (refuseRetiredPlanField(req, res)) return;
  const target = getUserById(req.params.id);
  if (!target) {
    res.status(404).json({ error: 'No such account.' });
    return;
  }

  const update: AccountUpdate = {};
  if (req.body?.role === 'admin' || req.body?.role === 'user') update.role = req.body.role;
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
  // writes the difference and a row explaining it.
  let wantedCredits: number | null = null;
  if (req.body?.credits !== undefined) {
    const credits = Number(req.body.credits);
    if (!Number.isFinite(credits) || credits < 0) {
      res.status(400).json({ error: 'Credits must be a whole number of zero or more.' });
      return;
    }
    wantedCredits = Math.floor(credits);
  }
  if (typeof req.body?.disabled === 'boolean') update.disabled = req.body.disabled;
  if (typeof req.body?.name === 'string') update.name = req.body.name;

  if (Object.keys(update).length === 0 && wantedCredits === null) {
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

  if (wantedCredits !== null) {
    setBalance(target.id, wantedCredits, req.user!.id, 'Set from the accounts page.');
  }

  const updated =
    Object.keys(update).length > 0 ? updateUser(target.id, update) : getUserById(target.id);
  if (!updated) {
    res.status(404).json({ error: 'No such account.' });
    return;
  }

  // A disabled account's sessions go immediately. `resolveSession` refuses a
  // disabled account anyway, so this is belt and braces - but it also means the
  // rows are gone rather than sitting there until they expire.
  if (update.disabled === true) destroySessionsForUser(updated.id);

  res.json({ account: describe(updated) });
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
 * Adds to a balance, rather than setting it.
 *
 * Beside the absolute field on purpose: "give them ten more" and "make it ten"
 * are different intentions, and making an admin do the arithmetic to express the
 * first is how somebody ends up taking credits away by accident.
 */
router.post('/:id/credits', (req: Request<{ id: string }>, res: Response) => {
  const target = getUserById(req.params.id);
  if (!target) {
    res.status(404).json({ error: 'No such account.' });
    return;
  }

  const amount = Number(req.body?.amount);
  if (!Number.isFinite(amount) || Math.floor(amount) === 0) {
    res.status(400).json({ error: 'Give a whole number of credits to add, or a negative one to take away.' });
    return;
  }

  const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
  const balance = grantCredits(target.id, Math.floor(amount), req.user!.id, note);
  const updated = getUserById(target.id);
  res.json({ account: describe(updated ?? target), balance });
});

/** Every movement on one account, newest first, so a balance can be explained. */
router.get('/:id/credits', (req: Request<{ id: string }>, res: Response) => {
  const target = getUserById(req.params.id);
  if (!target) {
    res.status(404).json({ error: 'No such account.' });
    return;
  }
  res.json({ balance: target.credits, entries: getLedger(target.id, 200) });
});

export default router;
