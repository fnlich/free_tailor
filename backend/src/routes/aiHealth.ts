import express, { Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth';
import { sendPublicError } from '../middleware/publicError';
import { getProviderDescriptor } from '../config/providerCatalog';
import {
  createAIProvider,
  deleteAIProvider,
  listAdminAIProviders,
  updateAIProvider,
  type ProviderMutationResult,
} from '../config/aiModelConfig';
import { AIProviderInputError, type AdminAIProvider } from '../config/aiProviders';
import {
  checkProviderHealth,
  getAdapter,
  getClaudeCliAdapter,
  getSemaphoreStats,
  getUsageSnapshot,
  listProviderCapabilities,
  providerReadiness,
} from '../services/ai';
import { getGenerationQueue } from '../services/queue';

/**
 * Provider readiness for the admin UI, and the providers themselves.
 *
 * A subscription seat can fail in ways a settings page cannot see - the binary
 * is not on PATH, the sign-in expired, the five-hour window is spent. The
 * health endpoint is what the seat cards on the admin pages read, ONE CARD PER
 * PROVIDER (config/aiProviders.ts): two Claude providers are two sign-ins, and
 * one signed out says nothing about the other.
 *
 * `/providers` is where an administrator adds a provider of a type at a
 * location of its own (owner decision P1), sets its `concurrency_max_requests`
 * (P2), switches it on or off, checks it, and removes it.
 */
const router = express.Router();
/**
 * Administrators only.
 *
 * It was any signed-in account, which handed everybody each seat's binary and
 * sign-in state, the signed-in Google account, the lanes and their outages, and
 * per-seat token and cost totals. Every page that reads it is an admin page,
 * and the provider routes name folders and binaries on this server.
 */
router.use(requireAdmin);

type Outage = { scope: string; reason: string; expiresAt: string };

/** A provider's own outage list, when its adapter keeps one (Codex and test stubs do not). */
function outagesOf(id: string): Outage[] {
  try {
    const adapter = getAdapter(id) as { outages?: () => Outage[] };
    return typeof adapter.outages === 'function' ? adapter.outages() : [];
  } catch {
    return [];
  }
}

/**
 * One provider's card: what it is, where it signs in, what a FRESH health
 * check says, whether the queue can give it work now, and how busy it is.
 */
async function providerCard(
  provider: AdminAIProvider,
  queueStats: ReturnType<ReturnType<typeof getGenerationQueue>['stats']>
) {
  const descriptor = getProviderDescriptor(provider.type);
  // Fresh, never the minute-old cached reading: this page is where an
  // operator looks after signing a seat back in, and a fresh check that finds
  // it signed in is what lifts that provider's sign-in hold. A switched-off
  // provider is not asked: it takes no work, and its folder may be gone.
  const health = provider.enabled
    ? await checkProviderHealth(provider.id, { fresh: true }).catch((error: unknown) => ({
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
        checkedAt: new Date().toISOString(),
        warning: undefined,
        authMethod: null,
      }))
    : null;
  const readiness = providerReadiness(provider.id);
  const semaphore = getSemaphoreStats()[provider.id] ?? null;
  const lane = queueStats[provider.id] ?? null;
  return {
    ...provider,
    summary: descriptor.summary,
    ok: health ? health.ok : false,
    detail: health ? health.detail : 'Switched off: this provider takes no work.',
    warning: health?.warning ?? null,
    authMethod: health?.authMethod ?? null,
    checkedAt: health?.checkedAt ?? null,
    ready: provider.enabled && readiness.ready !== false && !readiness.held && !provider.locked,
    held: readiness.held,
    outages: outagesOf(provider.id),
    queue: lane ? { queued: lane.queued, running: lane.running, width: lane.width, serving: lane.serving } : null,
    concurrency: semaphore,
  };
}

router.get('/health', async (req: Request, res: Response) => {
  try {
    const capabilities = listProviderCapabilities();
    const providers = await listAdminAIProviders();
    const queueStats = getGenerationQueue().stats();
    const cards = await Promise.all(
      providers.map(async (provider) => ({
        ...(await providerCard(provider, queueStats)),
        capabilities: capabilities.find((entry) => entry.id === provider.type) ?? null,
      }))
    );

    const cli = getClaudeCliAdapter();

    const snapshot = getUsageSnapshot();
    const usageRows = snapshot.entries.map((entry) => ({
      ...entry,
      // A Set does not survive JSON serialisation.
      resolvedModels: Array.from(entry.resolvedModels),
    }));

    // Totalled PER TYPE, the unit a model and its usage are counted in. A
    // single process-wide total attributed every seat's calls to the Claude
    // seat on the admin card.
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
      providers: cards,
      // The built-in Claude provider's usage window, where an already-loaded
      // page reads it.
      subscription: {
        seat: typeof cli.seatUsage === 'function' ? cli.seatUsage() : null,
        outages: outagesOf('claude-cli'),
      },
      // Every provider that holds itself off after a failure, by PROVIDER id.
      outagesByProvider: Object.fromEntries(cards.map((card) => [card.id, card.outages])),
      concurrency: getSemaphoreStats(),
      usage: { entries: usageRows, totals: snapshot.totals, byProvider: usageByProvider },
    });
  } catch (error) {
    sendPublicError(req, res, error, 'Failed to read AI provider health');
  }
});

/** An administrator's input refused by name; anything else is a fault, by reference. */
function sendProviderError(req: Request, res: Response, error: unknown, fallback: string): void {
  if (error instanceof AIProviderInputError) {
    res.status(error.status).json({
      error: error.message,
      code: error.code,
      ...(error.field ? { field: error.field } : {}),
    });
    return;
  }
  sendPublicError(req, res, error, fallback);
}

/**
 * Re-reads every lane after a change, so a new limit, a provider switched on
 * or off, or one removed is in the queue at once - not at the next reading.
 * Waiting work on a provider that stopped serving moves then (taskQueue.ts
 * `rebalance`).
 */
async function applyToQueue(): Promise<void> {
  try {
    await getGenerationQueue().refreshCapacity();
  } catch (error) {
    console.warn('[queue] Could not re-read the providers after an administrator changed one.', error);
  }
}

function waitingOn(id: string): number {
  return getGenerationQueue().stats()[id]?.queued ?? 0;
}

function runningOn(id: string): number {
  return getGenerationQueue().stats()[id]?.running ?? 0;
}

router.get('/providers', async (req: Request, res: Response) => {
  try {
    res.json({ providers: await listAdminAIProviders() });
  } catch (error) {
    sendPublicError(req, res, error, 'Failed to load the AI providers');
  }
});

router.post('/providers', async (req: Request, res: Response) => {
  try {
    const result: ProviderMutationResult = await createAIProvider(req.body ?? {});
    await applyToQueue();
    console.log(
      `[ai] ${req.user?.email ?? 'An administrator'} added provider ${result.provider?.id} ` +
        `("${result.provider?.label}", ${result.provider?.type}) at ${result.provider?.homeDir}.`
    );
    res.status(201).json(result);
  } catch (error) {
    sendProviderError(req, res, error, 'Failed to add the AI provider');
  }
});

router.put('/providers/:id', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const waiting = waitingOn(req.params.id);
    const result = await updateAIProvider(req.params.id, req.body ?? {});
    await applyToQueue();
    // How much waiting work left it, when the change took it out of service.
    const moved = Math.max(0, waiting - waitingOn(req.params.id));
    res.json({ ...result, moved });
  } catch (error) {
    sendProviderError(req, res, error, 'Failed to update the AI provider');
  }
});

router.delete('/providers/:id', async (req: Request<{ id: string }>, res: Response) => {
  try {
    // Refused while it is building something: those resumes are being made
    // with this sign-in now, and removing it would leave them answering to a
    // provider nobody can see. Waiting work is another matter - it moves.
    const running = runningOn(req.params.id);
    if (running > 0) {
      res.status(409).json({
        error:
          `This provider is building ${running} resume(s) right now. Switch it off instead - nothing new ` +
          'reaches it, and its waiting work moves to another provider of its type - then remove it once ' +
          'they finish.',
        code: 'provider-busy',
        running,
      });
      return;
    }
    const moved = waitingOn(req.params.id);
    const result = await deleteAIProvider(req.params.id);
    await applyToQueue();
    console.log(`[ai] ${req.user?.email ?? 'An administrator'} removed provider ${req.params.id}.`);
    res.json({ ...result, moved });
  } catch (error) {
    sendProviderError(req, res, error, 'Failed to remove the AI provider');
  }
});

/** A fresh check of one provider: the card, as /health draws it. */
router.post('/providers/:id/check', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const providers = await listAdminAIProviders();
    const provider = providers.find((entry) => entry.id === req.params.id);
    if (!provider) {
      res.status(404).json({ error: 'That provider does not exist.', code: 'not-found' });
      return;
    }
    const card = await providerCard({ ...provider, enabled: true }, getGenerationQueue().stats());
    // Readiness again after the check, which may have lifted a sign-in hold.
    res.json({ provider: { ...card, enabled: provider.enabled } });
  } catch (error) {
    sendProviderError(req, res, error, 'Failed to check the AI provider');
  }
});

export default router;
