import path from 'path';
import type { ProviderInstanceSpec } from '../../types';

/**
 * What every seat's adapter does the same way for a provider an administrator
 * added (config/aiProviders.ts): a fixed working directory of its own, and its
 * name in the detail an administrator reads. No process work here - runner.ts
 * stays the only module under services/ai that spawns anything.
 */

/**
 * A provider's own fixed working directory: the seat's directory for the
 * built-in one (unchanged, so an upgrade moves nothing), and the same name
 * with `-<id>` after it for every other. Two accounts never share the
 * per-directory state a CLI keeps (Claude's project entries, Gemini's
 * registered workspace and transcripts) or each other's scratch files.
 */
export function instanceWorkdir(base: string, instance: ProviderInstanceSpec | undefined): string {
  if (!instance || instance.builtIn) return base;
  return path.join(path.dirname(base), `${path.basename(base)}-${instance.id}`);
}

/**
 * A failure's detail, naming the provider when it is not the built-in one:
 * with two Claude providers, "not signed in" is only useful once it says which.
 * Administrators only - the detail never reaches anybody else.
 */
export function describeInstance(instance: ProviderInstanceSpec | undefined, detail: string): string {
  if (!instance || instance.builtIn) return detail;
  return `provider "${instance.label}" (${instance.id}): ${detail}`;
}
