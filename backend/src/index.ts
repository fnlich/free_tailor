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
import adminRoutes from './routes/admin';
import groupRoutes from './routes/groups';
import importRoutes from './routes/import';
import promptRoutes from './routes/prompts';
import jobRoutes from './routes/jobs';
import bidAssistantRoutes from './routes/bidAssistant';
import aiHealthRoutes from './routes/aiHealth';
import { aiErrorHandler } from './middleware/aiErrors';
import { preflightAllProviders } from './services/ai';

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

  const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
  return originHost === serverHost || (localHosts.has(originHost) && localHosts.has(serverHost));
}

// Middleware
app.use((req, res, next) => {
  cors({
    origin(origin, callback) {
      if (isOriginAllowed(origin, req.headers.host)) {
        callback(null, true);
        return;
      }
      callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
  })(req, res, next);
});
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/api/generated/:filename(*)', async (req, res) => {
  try {
    const params = req.params as Record<string, string | undefined>;
    const filename = typeof params['filename(*)'] === 'string' ? params['filename(*)'] : '';
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
app.use('/api/admin', adminRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/import', importRoutes);
app.use('/api/prompts', promptRoutes);
app.use('/api/jobs', jobRoutes);
app.use('/api/bid-assistant', bidAssistantRoutes);
app.use('/api/admin/ai', aiHealthRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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
  // Reports a missing binary or a signed-out subscription seat where an
  // operator can see it, instead of hours later as a failed generation.
  void preflightAllProviders();
});

// A batch generation legitimately runs for many minutes. Node's default
// request timeout is 5 minutes, which severed those mid-flight with no partial
// result and nothing in the log; the AI layer's own per-call deadlines are the
// real bound.
server.requestTimeout = 15 * 60_000;
server.headersTimeout = 15 * 60_000 + 10_000;

export default app;
