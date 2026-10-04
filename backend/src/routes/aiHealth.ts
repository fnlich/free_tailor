import express, { Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth';
import { sendPublicError } from '../middleware/publicError';
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
 * Administrators only.
 *
 * It was any signed-in account, which handed everybody each seat's binary and
 * sign-in state, the signed-in Google account, the lanes and their outages, and
 * per-seat token and cost totals. Only the admin Settings page reads it.
 */
router.use(requireAdmin);


router.get('/health', async (req: Request, res: Response) => {
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
    sendPublicError(req, res, error, 'Failed to read AI provider health');
  }
});

export default router;
