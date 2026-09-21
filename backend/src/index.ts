// Must be first: it loads .env before any other module reads process.env.
import './config/env';
import express from 'express';
import cors from 'cors';
import os from 'os';
import path from 'path';
import { getGeneratedFilePath } from './utils/generatedPath';
import { getDatabasePath, getDb } from './database/sqlite';

import profileRoutes from './routes/profiles';
import templateRoutes from './routes/templates';
import resumeRoutes from './routes/resume';
import generationRoutes from './routes/generation';
import orderRoutes from './routes/orders';
import paymentRoutes, { adminPaymentsRouter } from './routes/payments';
import paymentWebhookRoutes from './routes/paymentWebhooks';
import { ownerOfGeneratedFile } from './database/orderRepository';
import { orderRetentionDays, startOrderRetention } from './services/orders/retention';
import { chainProblems, startChainWatcher } from './services/payments/chain/watcher';
import { restoreGenerationQueue } from './services/queue';
import adminRoutes from './routes/admin';
import authRoutes from './routes/auth';
import accountRoutes from './routes/accounts';
import creditRoutes from './routes/credits';
import notificationRoutes, { adminNotificationsRouter } from './routes/notifications';
import sheetRoutes from './routes/sheet';
import { backfillAccountSheets } from './services/sheets/accountSheet';
import { reconcileCredits, warnIfNoAdmin } from './services/credits/reconcile';
import { describeAdminIdentity } from './config/adminIdentity';
import { promoteConfiguredAdmins } from './database/userRepository';
import { attachUser, requireUser } from './middleware/auth';
import groupRoutes from './routes/groups';
import importRoutes from './routes/import';
import promptRoutes from './routes/prompts';
import jobRoutes from './routes/jobs';
import bidAssistantRoutes from './routes/bidAssistant';
import aiHealthRoutes from './routes/aiHealth';
import { aiErrorHandler } from './middleware/aiErrors';
import { preflightAllProviders } from './services/ai';
import { describeApiPortMismatch, findApiPortMismatch } from './config/apiUrl';
import {
  describeBrowser,
  describeMissingBrowser,
  getResolvedBrowser,
  warmPuppeteerExecutablePath,
} from './config/browser';

const app = express();
const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST || '0.0.0.0';
const configuredFrontendOrigins = new Set(
  (process.env.FRONTEND_URL || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
);

function getHostname(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname;
  } catch {
    return null;
  }
}

/**
 * Allows an origin when it is explicitly configured or when it points at the
 * same host the API request arrived on. This keeps CORS working for whatever
 * IP or hostname the server is reached through without hard-coding addresses.
 */
function isOriginAllowed(origin: string | undefined, requestHost: string | undefined): boolean {
  if (!origin) return true;
  if (configuredFrontendOrigins.has(origin)) return true;

  const originHost = getHostname(origin);
  const serverHost = getHostname(requestHost);
  if (!originHost || !serverHost) return false;

  // WHATWG URL parsing keeps the brackets on an IPv6 literal, so `::1` alone
  // would never match what getHostname returns for http://[::1]:3000.
  const localHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  return originHost === serverHost || (localHosts.has(originHost) && localHosts.has(serverHost));
}

const reportedCorsRejections = new Set<string>();

/**
 * Says out loud that an origin was refused.
 *
 * A CORS rejection is invisible to the page by construction: the browser drops
 * the response because it has no Access-Control-Allow-Origin, so the fetch
 * rejects with a bare TypeError and the frontend can only report "cannot reach
 * the backend" - while the backend is running and answering perfectly well.
 * The one place the reason can be seen is here, so it is logged, once per
 * origin, with the variable that fixes it.
 */
function reportCorsRejection(origin: string, requestHost: string | undefined): void {
  if (reportedCorsRejections.has(origin)) {
    return;
  }
  reportedCorsRejections.add(origin);
  console.warn(
    `[cors] Refused origin ${origin} for a request to ${requestHost ?? 'this server'}. ` +
      'The browser reports this to the page as an unreachable server, not as a policy error. ' +
      `Add it to FRONTEND_URL in the repository .env to allow it (FRONTEND_URL=${origin}).`
  );
}

// Middleware
app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (!isOriginAllowed(origin, req.headers.host)) {
    reportCorsRejection(origin ?? '(none)', req.headers.host);
    // 403 and stop. The previous code threw from the cors callback, which
    // reached the error handler and answered 500 - the wrong status for a
    // policy decision. Refusing by returning `false` to cors would be worse
    // still: the request would run and only the RESPONSE would be unreadable,
    // so a cross-site POST would take effect unseen. Neither the status nor
    // the body is visible to the page either way, which is what CORS is for;
    // the log line above is where the reason actually lands.
    res.status(403).json({
      error: `Origin ${origin ?? '(none)'} is not allowed by this server's CORS policy.`,
    });
    return;
  }

  cors({ origin: true, credentials: true })(req, res, next);
});
/*
 * Payment webhooks, mounted BEFORE the JSON parser and not by accident.
 *
 * A provider signs the bytes it sent. `express.json` replaces those bytes with
 * an object, and re-serializing that object gives back a string that is usually
 * identical to what was signed and occasionally is not - a different key order,
 * a unicode escape, a number that round-trips differently. "Usually" is not a
 * security property, so this router gets the raw Buffer and the parser never
 * sees these requests at all.
 *
 * It sits above `attachUser` too, because the caller is Stripe rather than a
 * person: the signature is the authentication, and there is no session to
 * attach. It passes the CORS gate above because a server-to-server POST sends
 * no Origin, and `isOriginAllowed` allows that.
 */
app.use('/api/payments/webhook', express.raw({ type: 'application/json', limit: '1mb' }), paymentWebhookRoutes);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

/**
 * Resolves the session before any route runs.
 *
 * App-wide and non-refusing: it only attaches `req.user`. Deciding who may do
 * what is each router's business, and putting the decision here would mean one
 * list of paths to keep in step with the routers - the classic way a new route
 * ends up unprotected because somebody forgot the list existed.
 */
app.use(attachUser);

/**
 * Downloading a generated file needs an account.
 *
 * The filename is derived from the profile, the company and the date, so it is
 * guessable enough that "you would have to know the URL" is not a control.
 */
app.get('/api/generated/:filename(*)', requireUser, async (req, res) => {
  try {
    // Express 4 exposes `:filename(*)` as `params.filename`; the bracketed key
    // is Express 5's shape. Reading the wrong one made this route answer 404
    // for every path. `/api/resume/download/:filename(*)` in routes/resume.ts
    // reads the correct key, which is why downloads themselves still worked.
    const params = req.params as Record<string, string | undefined>;
    const filename = params.filename ?? '';

    /*
     * Whose file this is, before it is handed over.
     *
     * Signed-in used to be the whole check, which was defensible while a path
     * was something you had to be told. Ordered resumes are filed under a
     * FIXED template - account email, date, order number, profile, company - so
     * their paths are derivable, not guessable, and this route would otherwise
     * serve every account's documents to anybody with a login.
     *
     * A path no order claims is a manually built resume and is left exactly as
     * it was; narrowing those as well is a separate change with a separate
     * blast radius. 404, not 403, for the same reason the order routes use it.
     */
    const owner = ownerOfGeneratedFile(filename);
    if (owner && owner !== req.user!.id) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    const filepath = await getGeneratedFilePath(filename);
    if (!filepath) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    res.download(filepath, path.basename(filepath));
  } catch {
    res.status(500).json({ error: 'Failed to download file' });
  }
});

// Routes. Auth first: it is the only one reachable while signed out.
app.use('/api/auth', authRoutes);
app.use('/api/admin/accounts', accountRoutes);
app.use('/api/credits', creditRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/sheet', sheetRoutes);
app.use('/api/profiles', profileRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/resume', resumeRoutes);
app.use('/api/generation', generationRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/admin/payments', adminPaymentsRouter);
app.use('/api/admin/notifications', adminNotificationsRouter);
app.use('/api/admin', adminRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/import', importRoutes);
app.use('/api/prompts', promptRoutes);
app.use('/api/jobs', jobRoutes);
app.use('/api/bid-assistant', bidAssistantRoutes);
app.use('/api/admin/ai', aiHealthRoutes);

// Health check
app.get('/api/health', (req, res) => {
  const browser = getResolvedBrowser();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    // PDF generation is the one feature with an external dependency that can
    // go missing without any config change, so it is reported here.
    browser: browser
      ? {
          ok: browser.exists,
          label: browser.label,
          source: browser.source,
          executablePath: browser.executablePath,
          ...(browser.exists ? {} : { detail: `No file at ${browser.executablePath}` }),
        }
      : { ok: false, detail: describeMissingBrowser(process) },
  });
});

// AI transport failures answer with a status and a message a person can act
// on; everything else falls through to the generic handler below.
app.use(aiErrorHandler);

// Error handling middleware
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

/** Lists the addresses the server is reachable on, resolved at runtime. */
function listServerUrls(): string[] {
  if (HOST !== '0.0.0.0' && HOST !== '::') {
    return [`http://${HOST}:${PORT}`];
  }

  const urls = [`http://localhost:${PORT}`];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const entry of interfaces ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        urls.push(`http://${entry.address}:${PORT}`);
      }
    }
  }
  return urls;
}

// Open the database eagerly so schema problems - and the provider migration -
// surface at startup rather than on the first request.
getDb();

const server = app.listen(PORT, HOST, () => {
  console.log(`Database: ${getDatabasePath()}`);
  console.log(`Server listening on ${listServerUrls().join(', ')}`);
  // Said here because this is the process that can see both values, and the
  // browser cannot tell a wrong port from a stopped server.
  const mismatch = findApiPortMismatch(process.env.NEXT_PUBLIC_API_URL, PORT);
  if (mismatch) {
    console.warn(describeApiPortMismatch(mismatch));
  }
  // Reports a missing binary or a signed-out subscription seat where an
  // operator can see it, instead of hours later as a failed generation.
  void preflightAllProviders();
  // Picks up a generation run the last process was part way through. Whatever
  // was in a browser when it stopped is built again, and whatever was queued
  // carries on - which is the whole point of the queue being on disk.
  restoreGenerationQueue();
  // After the queue, not before: restore requeues what was mid-flight, and a
  // reservation whose tasks are about to run again must not be released as
  // abandoned in between.
  reconcileCredits();
  // Reachable whenever ADMIN_EMAILS is set and somebody else signs in first -
  // that path never falls back to the first-account rule, so the install can
  // genuinely end up with nobody who can administer it.
  // Before the warning, not after: an account that already exists and is named
  // by ADMIN_EMAILS or SMTP_USER becomes an administrator here, and warning
  // first would report a problem this line is about to fix.
  try {
    const promoted = promoteConfiguredAdmins();
    if (promoted > 0) console.log(`[auth] ${describeAdminIdentity()}`);
  } catch (error) {
    console.warn('[auth] Could not apply the configured administrator.', error);
  }
  warnIfNoAdmin();
  // Gives a spreadsheet to accounts created before this feature existed. Serial
  // and paced, so it is a slow trickle in the background rather than a burst of
  // Drive calls the moment the process comes up, and never able to fail a boot.
  void backfillAccountSheets().catch((error) => {
    console.warn('[sheets] The account spreadsheet backfill did not finish.', error);
  });
  /*
   * Deletes ordered resumes once their keep-until has passed, now and every six
   * hours after.
   *
   * Started HERE rather than when the module loads, which is the whole reason
   * it is a function: every test in this suite loads the modules it exercises,
   * and a sweep that began on import would delete files under a temp directory
   * while an unrelated test was still using them. The interval is unref'd, so
   * it never holds the process open.
   */
  startOrderRetention();
  console.log(`[orders] Ordered files are kept for ${orderRetentionDays()} day(s).`);

  /*
   * The chain watcher, for the same reasons and in the same shape.
   *
   * Started here rather than on import, unref'd so it never holds the process
   * open, and it sweeps once immediately - a transfer that arrived while this
   * server was down is found on boot rather than on the next interval.
   *
   * It starts nothing at all when no asset is configured, so an installation
   * taking only cards pays nothing for this existing. An asset the operator
   * asked for that CANNOT be served is named out loud instead of silently
   * dropped, because a misconfigured address is a payment that arrives
   * somewhere nobody is looking.
   */
  startChainWatcher();
  for (const problem of chainProblems()) {
    console.warn(`[chain] ${problem.asset} is not available: ${problem.reason}`);
  }
  // Same idea for the browser every PDF is printed with: a missing Chrome
  // used to surface only when someone clicked Generate.
  //
  // Awaited first, because puppeteer 25 answers "where is my download" with a
  // promise where 24 answered with a string. Resolving it once here keeps
  // every reader of that answer synchronous, which they all are.
  void warmPuppeteerExecutablePath()
    .catch(() => {})
    .then(() => {
      const browser = getResolvedBrowser();
      if (browser?.exists) {
        console.log(`[pdf] Rendering with ${describeBrowser()}`);
      } else if (browser) {
        console.warn(`[pdf] ${describeBrowser()}. PDF generation will fail until that path is right.`);
      } else {
        console.warn(`[pdf] ${describeMissingBrowser(process)}`);
      }
    });
});

// Node's `requestTimeout` bounds RECEIVING a request, and `headersTimeout` its
// headers; neither bounds producing the response. They are raised here so a
// slow or large upload on a busy box is not cut off, not because they limit
// generation - the AI layer's own per-call deadlines are what bound that.
server.requestTimeout = 15 * 60_000;
server.headersTimeout = 15 * 60_000 + 10_000;

export default app;
