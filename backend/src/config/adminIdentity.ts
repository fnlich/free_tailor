/**
 * Who administers this installation, and how that is decided.
 *
 * One rule, in one place, because three callers need the same answer: the role a
 * new account is created with, the startup pass that promotes an existing one,
 * and the warning that fires when the install has nobody.
 *
 * It used to be "whoever signs in first", which is convenient and wrong: on a
 * server anybody can reach, the first person through the door is not
 * necessarily the operator. The operator is whoever holds the mailbox the
 * sign-in codes are sent FROM - that mailbox is a credential they had to
 * configure - so `SMTP_USER` names them.
 *
 * There is deliberately no fallback beyond these two. An install with neither
 * set has no administrator at all, which is a state `warnIfNoAdmin` reports
 * loudly at startup; the alternative was handing the keys to a stranger.
 */

export type AdminSource = 'ADMIN_EMAILS' | 'SMTP_USER' | 'none';

export type AdminIdentity = {
  /** Normalised addresses that should hold the admin role. */
  emails: string[];
  source: AdminSource;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalize(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

export function resolveAdminIdentity(env: NodeJS.ProcessEnv = process.env): AdminIdentity {
  const listed = normalize(env.ADMIN_EMAILS)
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => EMAIL_PATTERN.test(entry));

  // An explicit list wins. It is the only way to have more than one
  // administrator, and somebody who wrote it meant it.
  if (listed.length > 0) {
    return { emails: [...new Set(listed)], source: 'ADMIN_EMAILS' };
  }

  // Only when it is actually an address. Plenty of providers want a bare
  // username or an API key id here, and promoting "apikey" would promote
  // nobody while looking like it had worked.
  const smtpUser = normalize(env.SMTP_USER);
  if (EMAIL_PATTERN.test(smtpUser)) {
    return { emails: [smtpUser], source: 'SMTP_USER' };
  }

  return { emails: [], source: 'none' };
}

export function isConfiguredAdmin(email: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveAdminIdentity(env).emails.includes(normalize(email));
}

/** One sentence naming who is configured, for a startup log or a warning. */
export function describeAdminIdentity(env: NodeJS.ProcessEnv = process.env): string {
  const { emails, source } = resolveAdminIdentity(env);
  if (source === 'none') return 'No administrator is configured.';
  return `Administrator${emails.length === 1 ? '' : 's'} from ${source}: ${emails.join(', ')}.`;
}
