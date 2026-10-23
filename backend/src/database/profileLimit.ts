import { resolveSubscription } from '../config/accountSubscriptions';
import type { UserAccount } from '../types/account';
import type Database from 'better-sqlite3';
import { PublicError } from '../middleware/publicError';
import { getDb } from './sqlite';

/**
 * The subscription's cap on how much an account may keep.
 *
 * The cap is a count of PROFILES - people - and nothing else: a profile holds
 * any number of resumes on every tier, and a resume is never counted. The
 * limit a tier states is `profileLimit`, the sentence a refusal speaks is
 * about profiles, and the wire code is `profile-limit`.
 *
 * It is checked INSIDE the transaction of every write that makes a profile
 * (database/profileTree.ts `inTreeTransaction`), against the connection that
 * transaction holds: a count taken first and a write made after would let two
 * creates racing at the limit both pass.
 */

/**
 * How many profiles an account holds.
 *
 * Counted in SQL against the indexed column (`idx_profiles_owner`) rather than
 * by listing and filtering: this runs on every account read, and the account
 * page asks for it on every load. `db` is the connection a transaction holds;
 * outside one, the shared connection.
 *
 * A profile with no resumes counts: it is still there, and not counting it
 * would make the limit meaningless the moment somebody worked out that an
 * empty one is free.
 */
export function countProfilesForOwner(ownerId: string, db: Database.Database = getDb()): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM profiles WHERE owner_id = ?').get(ownerId) as { n: number };
  return row.n;
}

export class ProfileLimitError extends PublicError {
  readonly limit: number;
  readonly used: number;
  readonly subscriptionLabel: string;

  /**
   * `forPerson` is set when the refusal is for a RESUME whose person has no
   * profile yet (a create or an import naming none): the sentence then says
   * whose resume it was, and to add it from one of the account's own profiles.
   */
  constructor(subscriptionLabel: string, limit: number, used: number, forPerson?: string) {
    const allowed = `${limit} profile${limit === 1 ? '' : 's'}`;
    super(
      forPerson === undefined
        ? // The account holder moves up on their own Subscription page now
          // (services/subscriptions): a tier is bought from the credit balance.
          `The ${subscriptionLabel} subscription allows ${allowed} and this ` +
            `account has ${used}. Delete one, or move up to a higher subscription on the Subscription page.`
        : `This resume is for ${forPerson}, who has no profile yet, and the ${subscriptionLabel} ` +
            `subscription allows ${allowed} - this account has ${used}. Add it from one of your profiles, ` +
            'or move up to a higher subscription on the Subscription page.',
      // 402: the subscription, not the request, is what is short - the same
      // status a run refused for want of credits answers.
      { status: 402, code: 'profile-limit', extra: { limit } }
    );
    this.name = 'ProfileLimitError';
    this.limit = limit;
    this.used = used;
    this.subscriptionLabel = subscriptionLabel;
  }
}

/**
 * Refuses a new profile that would put the account over its subscription.
 *
 * Called before a profile is made, never before anything else: an account
 * moved DOWN a subscription, or holding more profiles than its tier allows
 * (old resumes filed by their person's name, which ignores the limit), keeps
 * every profile it has and can add, move and edit resumes among them. Deleting
 * somebody's work because an admin changed a dropdown would be the wrong way
 * round - they lose the ability to add a profile, not the things they made.
 *
 * Admins are exempt. They can already change any account's subscription, so a
 * limit on them is a formality that only gets in the way of fixing somebody
 * else's.
 *
 * Call it inside the transaction that will make the profile, with that
 * transaction's connection.
 */
export function assertCanAddProfile(
  account: Pick<UserAccount, 'id' | 'role' | 'subscription'>,
  db: Database.Database = getDb(),
  adding = 1,
  options: { forPerson?: string } = {}
): void {
  if (account.role === 'admin') return;

  const subscription = resolveSubscription(account.subscription);
  if (subscription.profileLimit === null) return;

  const used = countProfilesForOwner(account.id, db);
  if (used + adding <= subscription.profileLimit) return;

  throw new ProfileLimitError(subscription.label, subscription.profileLimit, used, options.forPerson);
}
