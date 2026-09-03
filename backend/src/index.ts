import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { getGeneratedFilePath } from './utils/generatedPath';

import profileRoutes from './routes/profiles';
import templateRoutes from './routes/templates';
import resumeRoutes from './routes/resume';
import adminRoutes from './routes/admin';
import groupRoutes from './routes/groups';
import importRoutes from './routes/import';
import promptRoutes from './routes/prompts';
import jobRoutes from './routes/jobs';
import bidAssistantRoutes from './routes/bidAssistant';

dotenv.config({ path: path.join(__dirname, '../../.env') });

const app = express();
const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';
const configuredFrontendOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowedOrigins = new Set<string>([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3001',
  ...configuredFrontendOrigins,
]);

// Middleware
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true
}));
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

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(Number(PORT), HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
});

export default app;
