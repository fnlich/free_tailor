import express, { Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { AI_PROVIDER_IDS, getProviderDescriptor } from '../config/providerCatalog';
import {
  checkProviderHealth,
  getClaudeCliAdapter,
  getSemaphoreStats,
  getUsageSnapshot,
  listProviderCapabilities,
} from '../services/ai';

/**
 * Provider readiness for the admin UI.
 *
 * A subscription seat can fail in ways an API key cannot - the binary is not on
 * PATH, the sign-in expired, the five-hour window is spent - and none of those
 * are visible from a settings page that only knows how to render a key. This
 * endpoint is what the "Claude Subscription" card reads.
 */
const router = express.Router();

router.get('/health', authMiddleware, async (_req: Request, res: Response) => {
  try {
    const capabilities = listProviderCapabilities();
    const providers = await Promise.all(
      AI_PROVIDER_IDS.map(async (id) => {
        const descriptor = getProviderDescriptor(id);
        const health = await checkProviderHealth(id);
        return {
          id,
          label: descriptor.label,
          summary: descriptor.summary,
          credentialKind: descriptor.credentialKind,
          requiresApiKey: descriptor.requiresApiKey,
          ok: health.ok,
          detail: health.detail,
          warning: health.warning ?? null,
          authMethod: health.authMethod ?? null,
          checkedAt: health.checkedAt,
          capabilities: capabilities.find((entry) => entry.id === id) ?? null,
        };
      })
    );

    const cli = getClaudeCliAdapter();

    res.json({
      providers,
      subscription: {
        seat: cli.seatUsage(),
        outages: cli.outages(),
      },
      concurrency: getSemaphoreStats(),
      usage: getUsageSnapshot(),
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to read AI provider health',
    });
  }
});

export default router;
