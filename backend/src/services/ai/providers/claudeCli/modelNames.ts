/**
 * Which model names the `claude` CLI is handed as they are.
 *
 * A leaf with no imports, so the per-provider option lists in
 * config/providerModels.ts can ask exactly the question `resolveCliModel` asks
 * - would this name reach the CLI, or be swapped for the default? - without
 * importing the adapter and, through it, the operational table that imports
 * those lists.
 */

/** Model aliases the CLI resolves to the current model in that family. */
export const CLI_MODEL_ALIASES: ReadonlySet<string> = new Set([
  'default',
  'opus',
  'sonnet',
  'haiku',
  'fable',
  'sonnet[1m]',
]);

/** Full model names the CLI accepts, e.g. `claude-sonnet-5`, `claude-opus-4-1`. */
export const CLI_CANONICAL_MODEL = /^claude-[a-z0-9]+(?:-[a-z0-9]+)*$/i;

/** True when `resolveCliModel` passes `name` through rather than replacing it. */
export function isClaudeCliModelName(name: string): boolean {
  return CLI_MODEL_ALIASES.has(name) || CLI_CANONICAL_MODEL.test(name);
}
