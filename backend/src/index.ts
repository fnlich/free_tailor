// Must be first: it loads .env before any other module reads process.env.
import './config/env';
import express from 'express';
import cors from 'cors';
import os from 'os';
import path from 'path';
import { getGeneratedFilePath } from './utils/generatedPath';
import { getDatabasePath, getDb } from './database/sqlite';
import { describeTemplatesDirectory } from './database/templateFiles';

import profileRoutes from './routes/profiles';
import templateRoutes from './routes/templates';
import resumeRoutes from './routes/resume';
import generationRoutes from './routes/generation';
import orderRoutes from './routes/orders';
import paymentRoutes, { adminPaymentsRouter } from './routes/payments';
import paymentWebhookRoutes from './routes/paymentWebhooks';
import { ownerOfGeneratedFile } from './database/orderRepository';
import { orderRetentionDays, startOrderRetention } from './services/orders/retention';
import { restoreGenerationQueue } from './services/queue';
import adminRoutes from './routes/admin';
import authRoutes from './routes/auth';
import accountRoutes from './routes/accounts';
import creditRoutes from './routes/credits';
import notificationRoutes, { adminNotificationsRouter } from './routes/notifications';
import refundRequestRoutes, { adminRefundRequestsRouter } from './routes/refundRequests';
import contactRoutes, { adminContactRouter } from './routes/contact';
import sheetRoutes from './routes/sheet';
import reportRoutes from './routes/report';
import jobLakeRoutes from './routes/jobLake';
import { requestAdminLakeSync } from './services/jobLake/adminSheet';
import { backfillAccountSheets } from './services/sheets/accountSheet';
import { reconcileCredits, warnIfNoAdmin } from './services/credits/reconcile';
import { describeAdminIdentity } from './config/adminIdentity';
import { applyConfiguredAdmins, describeSignInGap } from './services/auth/authService';
import { attachUser, isAdmin, requireUser } from './middleware/auth';
import groupRoutes from './routes/groups';
import importRoutes from './routes/import';
import promptRoutes from './routes/prompts';
import jobRoutes from './routes/jobs';
import bidAssistantRoutes from './routes/bidAssistant';
import aiHealthRoutes from './routes/aiHealth';
import { publicErrorHandler } from './middleware/publicError';
import { preflightAllProviders } from './services/ai';
import { startTailorCachePrune } from './services/tailorCache';
import { describeRetiredProviderVariables } from './config/providerCatalog';
import { describeApiPortMismatch, findApiPortMismatch } from './config/apiUrl';
import { applyProxyTrust } from './config/proxyTrust';
import {
  describeAiTimeoutsAboveRequestDeadline,
  describeNonDefaultOperationalSettings,
  httpRequestTimeoutMs,
  immediateFileRetentionMs,
  jsonBodyMaxMb,
  serverPort,
  tailorCacheDays,
} from './config/operational';
import { normalizeOrigin, publicBaseUrl } from './config/publicUrl';
import {
  describeBrowser,
  describeMissingBrowser,
  getResolvedBrowser,
  warmPuppeteerExecutablePath,
} from './config/browser';

const app = express();
// Behind a reverse proxy this is what lets the session cookie be marked
// Secure. See config/proxyTrust for why it is 1 and not true.
applyProxyTrust(app);
// Validated: junk or out-of-range warns and uses 3001 rather than reaching
// `listen`, which throws on it and takes the whole server down with it.
const PORT = serverPort();
const HOST = process.env.HOST || '0.0.0.0';
/**
 * Origins allowed outright, whatever Host the request arrived on.
 *
 * `APP_URL` is in here as well as `FRONTEND_URL` so a single-origin deployment
 * needs only the one variable - the hostname test below already covers the
 * usual case, and this is what carries a proxy that rewrites `Host`.
 *
 * Normalized through `normalizeOrigin` because the values are compared against
 * a browser's `Origin` header, which never carries a trailing slash or a path.
 * A perfectly reasonable `FRONTEND_URL=https://example.org/` used to match
 * nothing at all.
 */
const configuredFrontendOrigins = new Set(
  [...(process.env.FRONTEND_URL || '').split(','), process.env.APP_URL || '']
    .map((origin) => normalizeOrigin(origin))
    .filter((origin): origin is string => origin !== null)
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
    // Not even the origin is echoed: the reason is the operator's, and the
    // log line above names it with the variable that fixes it.
    res.status(403).json({ error: 'Request not allowed.' });
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

/*
 * The one JSON parser, for every /api route. Its cap is JSON_BODY_MAX_MB (10 by
 * default), read once here because the parser is built once. Batch requests and
 * imports are what come near it, and how near depends on the operator's batch
 * sizes rather than on anything in the code. A router-level parser further down
 * would never run - this one has already consumed the body - so there is no
 * second, smaller cap anywhere to look for.
 */
app.use(express.json({ limit: `${jsonBodyMaxMb()}mb` }));
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
 * Downloading a generated file needs an account that builds resumes
 * (`requireUser`: a user or an administrator, never a reporter).
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
// Every mount below has a row in test/routeAccess.test.js deciding who it is
// for, and a router mounted without one fails the suite.
app.use('/api/auth', authRoutes);
// Public, like auth: how to reach the administrator is for people who cannot
// sign in as much as for anybody (routes/contact.ts).
app.use('/api/contact', contactRoutes);
app.use('/api/admin/contact', adminContactRouter);
app.use('/api/admin/accounts', accountRoutes);
app.use('/api/credits', creditRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/sheet', sheetRoutes);
// The Job Data Lake: a reporter's Report Jobs (reporters and administrators),
// and the administrators' lake, merge, settings and admin sheet.
app.use('/api/report', reportRoutes);
app.use('/api/admin/job-lake', jobLakeRoutes);
app.use('/api/profiles', profileRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/resume', resumeRoutes);
app.use('/api/generation', generationRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/admin/payments', adminPaymentsRouter);
app.use('/api/admin/notifications', adminNotificationsRouter);
app.use('/api/refund-requests', refundRequestRoutes);
app.use('/api/admin/refund-requests', adminRefundRequestsRouter);
app.use('/api/admin', adminRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/import', importRoutes);
app.use('/api/prompts', promptRoutes);
app.use('/api/jobs', jobRoutes);
app.use('/api/bid-assistant', bidAssistantRoutes);
app.use('/api/admin/ai', aiHealthRoutes);

/*
 * Health check. Unauthenticated, so it says only whether the server is up.
 *
 * The browser block - which Chrome PDFs are printed with, where it lives on
 * disk, and the commands that install one - is for an administrator, and is
 * sent to an administrator's session only. Everybody else, and every
 * monitoring probe, gets the status and the time.
 */
app.get('/api/health', (req, res) => {
  const healthy = { status: 'ok', timestamp: new Date().toISOString() };
  if (!isAdmin(req)) {
    res.json(healthy);
    return;
  }
  const browser = getResolvedBrowser();
  res.json({
    ...healthy,
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

/*
 * The last handler, for anything a route passed on or threw: a multer refusal,
 * a body-parser error, an AI failure, a bug. It answers with what the reader may
 * see - the generic sentence and a ref for anybody, the cause as well for an
 * administrator - and logs the cause under the ref. It used to send
 * `err.message` to whoever asked, with a 500 even for a body that was not JSON.
 */
app.use(publicErrorHandler);

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
  // Beside the database, because saved templates are files there now and a
  // directory this user cannot write fails every save with a generic error.
  const templatesDirectory = describeTemplatesDirectory();
  console[templatesDirectory.level](templatesDirectory.line);
  console.log(`Server listening on ${listServerUrls().join(', ')}`);
  // Every operational setting (config/operational.ts) that is not at its
  // default, effective values after validation, on one line. None is a secret.
  // A clamped value shows the number in use; a junk one has already warned and
  // is back at its default, so it is not listed.
  const nonDefault = describeNonDefaultOperationalSettings();
  if (nonDefault) console.log(nonDefault);
  // A CLI budget above the request deadline is read and then capped without a
  // word; this is the one place that can say so before somebody waits for it.
  for (const warning of describeAiTimeoutsAboveRequestDeadline()) console.warn(warning);
  // The address people actually type, which is none of the above on a
  // proxied install - the bind addresses are all loopback there.
  const publicUrl = publicBaseUrl();
  if (publicUrl) console.log(`Public address: ${publicUrl} (APP_URL)`);
  // Said here because this is the process that can see both values, and the
  // browser cannot tell a wrong port from a stopped server.
  const mismatch = findApiPortMismatch(process.env.NEXT_PUBLIC_API_URL, PORT);
  if (mismatch) {
    console.warn(describeApiPortMismatch(mismatch));
  }
  // Reports a missing binary or a signed-out subscription seat where an
  // operator can see it, instead of hours later as a failed generation.
  void preflightAllProviders();
  // An upgraded .env still holding the metered providers' keys or the seats'
  // old allow-a-key switches: nothing reads them, and saying so once here is
  // the only way an operator learns it. Names only - never a value.
  const retiredVariables = describeRetiredProviderVariables();
  if (retiredVariables) console.warn(retiredVariables);
  // Reachable whenever ADMIN_EMAILS is set and somebody else signs in first -
  // that path never falls back to the first-account rule, so the install can
  // genuinely end up with nobody who can administer it.
  // Before the warning, not after: an account that already exists and is named
  // by ADMIN_EMAILS or SMTP_USER becomes an administrator here, and warning
  // first would report a problem this line is about to fix.
  try {
    // And runs the migrations that were waiting for an administrator, at once.
    const promoted = applyConfiguredAdmins();
    if (promoted > 0) console.log(`[auth] ${describeAdminIdentity()}`);
  } catch (error) {
    console.warn('[auth] Could not apply the configured administrator.', error);
  }
  warnIfNoAdmin();
  // The sign-in page names no setting when neither path is configured, so the
  // operator is told here which ones to set.
  const signInGap = describeSignInGap();
  if (signInGap) console.warn(signInGap);
  // Picks up a generation run the last process was part way through. Whatever
  // was mid-build when it stopped is built again, and whatever was queued
  // carries on - which is the whole point of the queue being on disk.
  //
  // After the promotion above, not before it. Promoting an administrator runs
  // the migrations that were waiting for one, 006 among them, synchronously;
  // the restore reads profiles and settings as it starts, and reading them
  // first meant warning about a profile's choice - and residue in the settings
  // row - that 006 cleared a moment later.
  //
  // Then the credits, and only once the restore has FINISHED: restore requeues
  // what was mid-flight, and a reservation whose tasks are about to run again
  // must not be released as abandoned in between. The restore resolves a model
  // again for a task queued on a provider that has since been removed, which
  // is a settings read and so asynchronous; chaining on it keeps the order.
  // Neither ever rejects.
  //
  // And told WHICH batches came back: age alone cannot tell an abandoned
  // reservation from an order that was six hours into its run when the
  // process stopped, and releasing that one built the rest of it for free.
  void restoreGenerationQueue().then((restored) => {
    reconcileCredits(Date.now(), { liveBatchIds: restored.batchIds });
  });
  // Gives a spreadsheet to accounts created before this feature existed. Serial
  // and paced, so it is a slow trickle in the background rather than a burst of
  // Drive calls the moment the process comes up, and never able to fail a boot.
  void backfillAccountSheets().catch((error) => {
    console.warn('[sheets] The account spreadsheet backfill did not finish.', error);
  });
  // The Job Data Lake's admin sheet catches up with whatever the last process
  // added and never got to append - the database is the record, the sheet its
  // outbox. Asks Google nothing when there is nothing to send.
  requestAdminLakeSync('startup');
  /*
   * Deletes ordered resumes once their keep-until has passed, now and every
   * ORDER_RETENTION_SWEEP_MS after (six hours by default) - and Generate
   * Immediately runs' files IMMEDIATE_FILE_RETENTION_MS after each run ends,
   * checked every minute.
   *
   * Started HERE rather than when the module loads, which is the whole reason
   * it is a function: every test in this suite loads the modules it exercises,
   * and a sweep that began on import would delete files under a temp directory
   * while an unrelated test was still using them. The interval is unref'd, so
   * it never holds the process open.
   */
  startOrderRetention();
  // Tailored answers older than TAILOR_CACHE_DAYS go now and once a day after
  // (services/tailorCache.ts). Never fatal; unref'd like the sweep above.
  startTailorCachePrune();
  console.log(`[tailor-cache] Tailored resumes and cover letters are reused for ${tailorCacheDays()} day(s).`);
  console.log(
    `[orders] Ordered files are kept for ${orderRetentionDays()} day(s); a Generate Immediately ` +
      `run's for ${Math.round(immediateFileRetentionMs() / 60_000)} minute(s) after it ends.`
  );

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
//
// HTTP_REQUEST_TIMEOUT_MS, fifteen minutes by default, read once. It has to grow
// with UPLOAD_MAX_MB and JSON_BODY_MAX_MB on a slow link. `headersTimeout` stays
// derived from it, ten seconds longer, as it always was.
const requestTimeoutMs = httpRequestTimeoutMs();
server.requestTimeout = requestTimeoutMs;
server.headersTimeout = requestTimeoutMs + 10_000;

export default app;
