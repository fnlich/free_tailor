import { warnOnce } from './telemetry';
import type { CompletionRequest, DroppedParam, ProviderCapabilities } from './types';

/**
 * Reports an effort or thinking setting the chosen provider cannot apply.
 *
 * These two are chosen per profile and per generation, so a provider that
 * quietly ignores them leaves someone looking at a select box that does
 * nothing. Every provider that cannot honour one says so here, the same way
 * temperature and the output cap are already reported, and the value comes
 * back in `droppedParams` for anything that wants to surface it.
 */
export function collectUnsupportedReasoningParams(
  request: Pick<CompletionRequest, 'effort' | 'thinking' | 'callSite'>,
  capabilities: Pick<ProviderCapabilities, 'id' | 'label' | 'effort' | 'thinking'>
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

  // `default` is not a request for anything - it is the absence of one - so
  // only an explicit `off` can be dropped.
  if (request.thinking === 'off' && !capabilities.thinking) {
    dropped.push('thinking');
    warnOnce(
      `${capabilities.id}-drop-thinking:${request.callSite}`,
      `"${request.callSite}" asks for thinking to be off, but ${capabilities.label} has no thinking ` +
        'control here. The model thinks as it normally would. Thinking applies on the Claude CLI provider.'
    );
  }

  return dropped;
}
