import nodemailer, { type Transporter } from 'nodemailer';

/**
 * Sending the sign-in code.
 *
 * Real SMTP, configured from the environment. There is deliberately no
 * "pretend it sent" mode: a login that silently does not arrive is worse than
 * one that refuses, because the person retries instead of fixing the config.
 * What there IS is a clear refusal naming the missing variable, and
 * `describeMailConfig` so the startup banner and the login page can say up
 * front whether the code path is usable at all.
 */

export type MailConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
};

export class MailNotConfiguredError extends Error {
  readonly missing: string[];

  constructor(missing: string[]) {
    super(
      `Email sign-in is not configured on this server: ${missing.join(', ')} ` +
        `${missing.length === 1 ? 'is' : 'are'} not set. Set them in .env and restart, or sign in with Google.`
    );
    this.name = 'MailNotConfiguredError';
    this.missing = missing;
  }
}

export class MailSendError extends Error {
  /** The SMTP failure underneath, for the log. Never shown to the browser. */
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'MailSendError';
    this.cause = cause;
  }
}

function readConfig(env: NodeJS.ProcessEnv = process.env): { config: MailConfig | null; missing: string[] } {
  const host = env.SMTP_HOST?.trim() ?? '';
  const user = env.SMTP_USER?.trim() ?? '';
  const pass = env.SMTP_PASS ?? '';

  const missing: string[] = [];
  if (!host) missing.push('SMTP_HOST');
  if (!user) missing.push('SMTP_USER');
  if (!pass) missing.push('SMTP_PASS');
  if (missing.length > 0) return { config: null, missing };

  // 465 is implicit TLS, everything else is STARTTLS. Deriving it rather than
  // asking for a flag removes the single most common way to misconfigure this:
  // secure=false on 465 hangs until the socket times out, with no error that
  // says why.
  const port = Number.parseInt(env.SMTP_PORT?.trim() || '587', 10);
  const resolvedPort = Number.isInteger(port) && port > 0 && port < 65536 ? port : 587;

  const explicitSecure = env.SMTP_SECURE?.trim().toLowerCase();
  const secure =
    explicitSecure === 'true' ? true : explicitSecure === 'false' ? false : resolvedPort === 465;

  return {
    config: {
      host,
      port: resolvedPort,
      secure,
      user,
      pass,
      // Falls back to the authenticating user, which is what most providers
      // require the From to be anyway.
      from: env.SMTP_FROM?.trim() || user,
    },
    missing: [],
  };
}

export type MailStatus =
  | { configured: true; host: string; port: number; from: string }
  | { configured: false; missing: string[] };

export function describeMailConfig(env: NodeJS.ProcessEnv = process.env): MailStatus {
  const { config, missing } = readConfig(env);
  return config
    ? { configured: true, host: config.host, port: config.port, from: config.from }
    : { configured: false, missing };
}

/**
 * Held across sends so the connection pool is reused.
 *
 * Keyed on the config, so changing SMTP_HOST in a dev restart-in-place does not
 * keep talking to the old one.
 */
let cached: { key: string; transport: Transporter } | null = null;

function getTransport(config: MailConfig): Transporter {
  const key = `${config.host}:${config.port}:${config.secure}:${config.user}`;
  if (cached?.key === key) return cached.transport;

  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
    pool: true,
    maxConnections: 2,
  });
  cached = { key, transport };
  return transport;
}

/** Drops the pooled connection. Tests share a process; a live pool leaks. */
export function resetMailerForTests(): void {
  cached?.transport.close?.();
  cached = null;
}

const APP_NAME = 'Free Tailor';

function codeEmail(code: string, ttlMinutes: number): { subject: string; text: string; html: string } {
  const subject = `${code} is your ${APP_NAME} sign-in code`;
  const text =
    `Your ${APP_NAME} sign-in code is ${code}.\n\n` +
    `It expires in ${ttlMinutes} minutes and can be used once.\n\n` +
    'If you did not ask to sign in, you can ignore this email - nobody can use the code without it.';
  const html =
    `<p>Your <strong>${APP_NAME}</strong> sign-in code is:</p>` +
    `<p style="font-size:28px;letter-spacing:6px;font-weight:700;margin:16px 0">${code}</p>` +
    `<p>It expires in ${ttlMinutes} minutes and can be used once.</p>` +
    '<p style="color:#666;font-size:13px">If you did not ask to sign in, you can ignore this email - ' +
    'nobody can use the code without it.</p>';
  return { subject, text, html };
}

export async function sendLoginCode(
  to: string,
  code: string,
  ttlMinutes: number,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const { config, missing } = readConfig(env);
  if (!config) throw new MailNotConfiguredError(missing);

  const { subject, text, html } = codeEmail(code, ttlMinutes);
  try {
    await getTransport(config).sendMail({ from: config.from, to, subject, text, html });
  } catch (error) {
    // The code is never in this message. An SMTP error can end up in a log an
    // operator pastes somewhere, and a live sign-in code in it would hand the
    // account to whoever reads it.
    const reason = error instanceof Error ? error.message : String(error);
    throw new MailSendError(`Could not send the sign-in email via ${config.host}: ${reason}`, error);
  }
}
