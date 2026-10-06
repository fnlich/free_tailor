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

/**
 * The family a Claude model name belongs to - `opus`, `sonnet`, `haiku`,
 * `fable` - whether it is the alias or a full name the CLI reports
 * (`claude-haiku-4-5-20251001`, `claude-3-5-sonnet-20241022`); null for
 * `default` and anything this build does not know.
 */
const MODEL_FAMILIES = [...CLI_MODEL_ALIASES].filter((alias) => /^[a-z]+$/.test(alias) && alias !== 'default');

export function claudeModelFamily(name: string | null | undefined): string | null {
  const words = (name ?? '').trim().toLowerCase().split(/[^a-z0-9]+/);
  return MODEL_FAMILIES.find((family) => words.includes(family)) ?? null;
}

/**
 * True when the model that ANSWERED is not the one the turn asked for - what
 * `--fallback-model` does when the asked-for model is overloaded. Compared by
 * family, never as strings: the CLI reports a full id for an alias request
 * (`opus` comes back as `claude-opus-4-...`). A turn that asked for `default`
 * (the account picks) counts as fallen back only when the answer came from a
 * family it named as a fallback. Unknown names on either side are not a
 * fallback: this only ever stops something being kept, so "cannot tell" keeps
 * the old behaviour.
 */
export function answeredByFallback(
  requested: string,
  answered: string | null | undefined,
  fallbackModels: readonly string[]
): boolean {
  const got = claudeModelFamily(answered);
  if (!got) return false;
  const asked = claudeModelFamily(requested);
  if (asked) return got !== asked;
  return fallbackModels.some((name) => claudeModelFamily(name) === got);
}
