import express, { Request, Response } from 'express';
import { requireUser } from '../middleware/auth';
import { AI_PROVIDER_IDS, getProviderDescriptor } from '../config/providerCatalog';
import {
  checkProviderHealth,
  getClaudeCliAdapter,
  getGeminiCliAdapter,
  getSemaphoreStats,
  getUsageSnapshot,
  listProviderCapabilities,
} from '../services/ai';

/**
 * Provider readiness for the admin UI.
 *
 * A subscription seat can fail in ways a settings page cannot see - the binary
 * is not on PATH, the sign-in expired, the five-hour window is spent. This
 * endpoint is what the seat cards on the admin Settings page read.
 */
const router = express.Router();
/**
 * Everything below needs a signed-in account.
 *
 * At the router rather than per route, so a route added later is protected by
 * default. Before v2 these were open, which was defensible with one user on one
 * machine and is not once profiles belong to people.
 */
router.use(requireUser);


router.get('/health', async (_req: Request, res: Response) => {
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
    const gemini = getGeminiCliAdapter();

    const snapshot = getUsageSnapshot();
    const usageRows = snapshot.entries.map((entry) => ({
      ...entry,
      // A Set does not survive JSON serialisation.
      resolvedModels: Array.from(entry.resolvedModels),
    }));

    // Totalled PER PROVIDER. A single process-wide total attributed every
    // seat's calls to the Claude seat on the admin card.
    const usageByProvider: Record<string, { calls: number; failures: number; inputTokens: number; outputTokens: number; costUsd: number }> = {};
    for (const entry of usageRows) {
      const totals = (usageByProvider[entry.provider] ??= {
        calls: 0,
        failures: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      });
      totals.calls += entry.calls;
      totals.failures += entry.failures;
      totals.inputTokens += entry.inputTokens;
      totals.outputTokens += entry.outputTokens;
      totals.costUsd += entry.costUsd;
    }

    res.json({
      providers,
      subscription: {
        seat: cli.seatUsage(),
        outages: cli.outages(),
      },
      // Every seat that holds itself off after a failure, keyed by provider.
      // `subscription.outages` above is the Claude seat's, kept where an
      // already-loaded page reads it; Codex keeps no holds of its own.
      outagesByProvider: {
        'claude-cli': cli.outages(),
        'gemini-cli': gemini?.outages() ?? [],
      },
      concurrency: getSemaphoreStats(),
      usage: { entries: usageRows, totals: snapshot.totals, byProvider: usageByProvider },
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to read AI provider health',
    });
  }
});

export default router;
