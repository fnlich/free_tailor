import { Router, type Request, type Response } from 'express';

import { isAccountPlanId, listAccountPlans, resolveAccountPlan } from '../config/accountPlans';
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
import type { AccountUpdate, UserAccount, UserRole } from '../types/account';

/**
 * Managing other people's accounts.
 *
 * Admin-only, and the interesting part is what an admin may NOT do: strand the
 * installation. Every guard below is a variation on that - the last admin
 * cannot be demoted, disabled or deleted, because there would then be nobody
 * who could undo it and no way in through the UI to appoint a replacement.
 */

const router = Router();
router.use(requireAdmin);

type AccountRow = UserAccount & {
  planLabel: string;
  profileLimit: number | null;
  profilesUsed: number;
};

function describe(account: UserAccount): AccountRow {
  const plan = resolveAccountPlan(account.plan);
  return {
    ...account,
    planLabel: plan.label,
    profileLimit: plan.profileLimit,
    profilesUsed: countProfilesForOwner(account.id),
  };
}

/**
 * True when changing this account would leave the installation with no admin.
 *
 * Counts only ENABLED admins, because a disabled one cannot sign in and so is
 * not an answer to "who can fix this".
 */
function wouldStrandInstall(target: UserAccount, next: AccountUpdate): boolean {
  if (target.role !== 'admin' || target.disabled) return false;

  const losingAdmin = next.role === 'user' || next.disabled === true;
  if (!losingAdmin) return false;

  return countAdmins() <= 1;
}

router.get('/', (_req: Request, res: Response) => {
  res.json({ accounts: listUsers().map(describe), plans: listAccountPlans() });
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
 * set the plan and role BEFORE the person arrives, rather than having them sign
 * in on the Default plan and be upgraded afterwards.
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

  const role: UserRole = req.body?.role === 'admin' ? 'admin' : 'user';
  const account = createUser({
    email,
    name: typeof req.body?.name === 'string' ? req.body.name : undefined,
    role,
  });

  const update: AccountUpdate = {};
  if (isAccountPlanId(req.body?.plan)) update.plan = req.body.plan;
  if (Number.isFinite(Number(req.body?.credits))) update.credits = Number(req.body.credits);
  const finished = Object.keys(update).length > 0 ? updateUser(account.id, update) : account;

  res.status(201).json({ account: describe(finished ?? account) });
});

router.patch('/:id', (req: Request<{ id: string }>, res: Response) => {
  const target = getUserById(req.params.id);
  if (!target) {
    res.status(404).json({ error: 'No such account.' });
    return;
  }

  const update: AccountUpdate = {};
  if (req.body?.role === 'admin' || req.body?.role === 'user') update.role = req.body.role;
  if (req.body?.plan !== undefined) {
    if (!isAccountPlanId(req.body.plan)) {
      res.status(400).json({ error: `"${req.body.plan}" is not a plan this build knows about.` });
      return;
    }
    update.plan = req.body.plan;
  }
  if (req.body?.credits !== undefined) {
    const credits = Number(req.body.credits);
    if (!Number.isFinite(credits) || credits < 0) {
      res.status(400).json({ error: 'Credits must be a whole number of zero or more.' });
      return;
    }
    update.credits = credits;
  }
  if (typeof req.body?.disabled === 'boolean') update.disabled = req.body.disabled;
  if (typeof req.body?.name === 'string') update.name = req.body.name;

  if (Object.keys(update).length === 0) {
    res.status(400).json({ error: 'There is nothing to change.' });
    return;
  }

  if (wouldStrandInstall(target, update)) {
    res.status(409).json({
      error:
        'This is the only administrator left. Promote somebody else first, or this installation ' +
        'would have nobody who can manage it.',
      code: 'last-admin',
    });
    return;
  }

  const updated = updateUser(target.id, update);
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

  if (target.id === req.user!.id) {
    res.status(409).json({ error: 'You cannot delete the account you are signed in with.' });
    return;
  }
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

export default router;
