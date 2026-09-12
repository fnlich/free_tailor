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
import adminRoutes from './routes/admin';
import groupRoutes from './routes/groups';
import importRoutes from './routes/import';
import promptRoutes from './routes/prompts';
import jobRoutes from './routes/jobs';
import bidAssistantRoutes from './routes/bidAssistant';
import aiHealthRoutes from './routes/aiHealth';
import { aiErrorHandler } from './middleware/aiErrors';
import { preflightAllProviders } from './services/ai';
import { describeApiPortMismatch, findApiPortMismatch } from './config/apiUrl';
import { describeBrowser, describeMissingBrowser, getResolvedBrowser } from './config/browser';

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
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/api/generated/:filename(*)', async (req, res) => {
  try {
    // Express 4 exposes `:filename(*)` as `params.filename`; the bracketed key
    // is Express 5's shape. Reading the wrong one made this route answer 404
    // for every path. `/api/resume/download/:filename(*)` in routes/resume.ts
    // reads the correct key, which is why downloads themselves still worked.
    const params = req.params as Record<string, string | undefined>;
    const filename = params.filename ?? '';
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

// Routes
app.use('/api/profiles', profileRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/resume', resumeRoutes);
app.use('/api/generation', generationRoutes);
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
  // Same idea for the browser every PDF is printed with: a missing Chrome
  // used to surface only when someone clicked Generate.
  const browser = getResolvedBrowser();
  if (browser?.exists) {
    console.log(`[pdf] Rendering with ${describeBrowser()}`);
  } else if (browser) {
    console.warn(`[pdf] ${describeBrowser()}. PDF generation will fail until that path is right.`);
  } else {
    console.warn(`[pdf] ${describeMissingBrowser(process)}`);
  }
});

// Node's `requestTimeout` bounds RECEIVING a request, and `headersTimeout` its
// headers; neither bounds producing the response. They are raised here so a
// slow or large upload on a busy box is not cut off, not because they limit
// generation - the AI layer's own per-call deadlines are what bound that.
server.requestTimeout = 15 * 60_000;
server.headersTimeout = 15 * 60_000 + 10_000;

export default app;
