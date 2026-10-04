import nodemailer, { type Transporter } from 'nodemailer';
import { smtpConnectionTimeoutMs, smtpMaxConnections, smtpSocketTimeoutMs } from '../../config/operational';

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
  /** SMTP_CONNECTION_TIMEOUT_MS: connect and greeting. */
  connectionTimeoutMs: number;
  /** SMTP_SOCKET_TIMEOUT_MS: idle socket. */
  socketTimeoutMs: number;
  /** SMTP_MAX_CONNECTIONS: width of the pool. */
  maxConnections: number;
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
      connectionTimeoutMs: smtpConnectionTimeoutMs(env),
      socketTimeoutMs: smtpSocketTimeoutMs(env),
      maxConnections: smtpMaxConnections(env),
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
 * keep talking to the old one. The pool's width and timeouts are in the key
 * too: they are fixed when the transport is built, so a transport is only
 * reused while they are what it was built with.
 */
let cached: { key: string; transport: Transporter } | null = null;

function getTransport(config: MailConfig): Transporter {
  const key = [
    config.host,
    config.port,
    config.secure,
    config.user,
    config.connectionTimeoutMs,
    config.socketTimeoutMs,
    config.maxConnections,
  ].join(':');
  if (cached?.key === key) return cached.transport;

  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
    pool: true,
    // SMTP_MAX_CONNECTIONS, two by default. Some relays and plans cap
    // concurrent connections, and sign-in codes are not bulk mail.
    maxConnections: config.maxConnections,
    /*
     * Bounded, because the interesting failure is silence.
     *
     * A network that BLOCKS outbound SMTP - many home ISPs, most corporate ones,
     * and this project's own build container - does not refuse the connection, it
     * drops the packets. With no timeout nodemailer waits indefinitely: the sign-in
     * request hangs rather than returning an error, and `mail:doctor` sits there
     * instead of reporting the one thing it exists to report. Ten seconds is far
     * longer than any reachable relay needs to answer.
     *
     * SMTP_CONNECTION_TIMEOUT_MS (10s) and SMTP_SOCKET_TIMEOUT_MS (20s) tune them
     * for a slow relay or network. Neither can be 0 or empty-means-infinite:
     * empty is the default and the floor is one second, because an unbounded
     * wait is precisely the hang described above.
     */
    connectionTimeout: config.connectionTimeoutMs,
    greetingTimeout: config.connectionTimeoutMs,
    socketTimeout: config.socketTimeoutMs,
  });
  cached = { key, transport };
  return transport;
}

/**
 * Closes the pooled connection, for a one-shot script.
 *
 * The pool is right for the server, where the next sign-in re-uses it. A script
 * that has sent its one message would otherwise sit there, finished, until the
 * idle connection's socket timeout (SMTP_SOCKET_TIMEOUT_MS, twenty seconds by
 * default) let the process end.
 */
export function closeMailTransport(): void {
  cached?.transport.close();
  cached = null;
}

const APP_NAME = 'Tailor';

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

/**
 * Connects and authenticates, and sends NOTHING.
 *
 * Exists for `mail:doctor`, and the distinction from a real send is the whole
 * value: this proves the host, the port, the TLS mode and the credentials, while
 * a relay's refusal to send from an unverified domain happens later, at message
 * time. Separating them turns one ambiguous error into two precise ones.
 *
 * Reuses `readConfig` and `getTransport` deliberately - a doctor that built its
 * own transport would be checking its own second opinion rather than the one the
 * app uses.
 */
export async function verifyMailTransport(env: NodeJS.ProcessEnv = process.env): Promise<MailStatus> {
  const { config, missing } = readConfig(env);
  if (!config) throw new MailNotConfiguredError(missing);

  try {
    await getTransport(config).verify();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new MailSendError(`Could not connect to ${config.host}:${config.port}: ${reason}`, error);
  }

  return { configured: true, host: config.host, port: config.port, from: config.from };
}

/**
 * One real message, for `mail:doctor --to`.
 *
 * Deliberately NOT the sign-in template: nothing here should put a six-digit
 * number that looks like a live code into somebody's inbox or a terminal
 * scrollback. Returns the resolved `From` so the caller can show which address
 * the relay actually accepted.
 */
export async function sendTestMessage(
  to: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const { config, missing } = readConfig(env);
  if (!config) throw new MailNotConfiguredError(missing);

  const subject = `${APP_NAME} mail check`;
  const text =
    `This is a test message from ${APP_NAME}'s mail:doctor.\n\n` +
    `It confirms this server can send as ${config.from}. No action is needed.`;

  try {
    await getTransport(config).sendMail({ from: config.from, to, subject, text });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new MailSendError(`${config.host} refused the message: ${reason}`, error);
  }

  return config.from;
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
