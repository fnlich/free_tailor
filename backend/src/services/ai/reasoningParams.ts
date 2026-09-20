import { warnOnce } from './telemetry';
import type { CompletionRequest, DroppedParam, ProviderCapabilities } from './types';

/**
 * Reports an effort setting the chosen provider cannot apply.
 *
 * Effort is chosen per profile and per generation, so a provider that quietly
 * ignores it leaves someone looking at a select box that does nothing. Every
 * provider that cannot honour it says so here, the same way temperature and the
 * output cap are already reported, and the value comes back in `droppedParams`
 * for anything that wants to surface it.
 */
export function collectUnsupportedReasoningParams(
  request: Pick<CompletionRequest, 'effort' | 'callSite'>,
  capabilities: Pick<ProviderCapabilities, 'id' | 'label' | 'effort'>
): DroppedParam[] {
  const dropped: DroppedParam[] = [];

  if (request.effort && !capabilities.effort) {
    dropped.push('effort');
    warnOnce(
      `${capabilities.id}-drop-effort:${request.callSite}`,
      `"${request.callSite}" asks for ${request.effort} effort, but ${capabilities.label} has no effort ` +
        'control. The request runs at the model default. Effort applies on the Claude CLI provider.'
    );
  }

  return dropped;
}
