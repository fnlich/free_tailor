import type { PromptRecord } from '../../types/prompt';
import {
  renderPromptSegments,
  renderPromptSegmentsByExactId,
  resolvePromptByExactId,
  resolvePromptByRuntimeId,
  type RenderedPromptSegment,
} from '../promptService';

export const JSON_ONLY_SYSTEM_PROMPT =
  'You are a strict JSON generator. Return valid JSON only, with no markdown fences or extra text.';

/**
 * How a prompt id is looked up.
 *
 * `exact`   - this literal record id.
 * `runtime` - the record currently activated for the feature this id names.
 *
 * Making this explicit fixes a real inconsistency: `analyzeJobDescription`
 * rendered its text with the EXACT id while the model override and the
 * structured render were resolved with the RUNTIME id, so a feature with an
 * activated custom prompt could render one record's text and take another
 * record's model.
 */
export type PromptRef = { id: string; mode: 'exact' | 'runtime' };

export type AssembledPrompt = {
  record: PromptRecord | null;
  /** The literal run before the first `[[variable]]`: instructions, not data. */
  stableSystem: string;
  /** Everything from the first variable onward: the call's actual data. */
  userBody: string;
  /** stableSystem + userBody, for providers with no system channel. */
  flat: string;
};

function splitSegments(segments: RenderedPromptSegment[]): { stableSystem: string; userBody: string } {
  let index = 0;
  let stableSystem = '';
  while (index < segments.length && !segments[index].variableName) {
    stableSystem += segments[index].text;
    index += 1;
  }

  let userBody = '';
  for (const segment of segments.slice(index)) {
    userBody += segment.text;
  }

  // A prompt with no variables at all is all instruction and no data. Sending
  // an empty user turn is not valid, so the whole text becomes the user turn
  // and the system channel is left to the provider's own preamble.
  if (!userBody.trim()) {
    return { stableSystem: '', userBody: stableSystem || ' ' };
  }

  return { stableSystem, userBody };
}

/**
 * Resolves a prompt record ONCE and renders it ONCE.
 *
 * Every caller used to do both twice: render a flat string for the HTTP
 * providers and pass the same values again so the Anthropic path could
 * re-render them as segments. Both hit the prompt store, and on the Anthropic
 * path the flat string was computed and thrown away. For the tailor prompt that
 * is a 17 KB template plus full-profile JSON substituted twice per resume.
 */
export async function assemblePrompt(
  ref: PromptRef,
  values: Record<string, string>
): Promise<AssembledPrompt> {
  const [record, segments] = await Promise.all([
    ref.mode === 'exact' ? resolvePromptByExactId(ref.id) : resolvePromptByRuntimeId(ref.id),
    ref.mode === 'exact'
      ? renderPromptSegmentsByExactId(ref.id, values)
      : renderPromptSegments(ref.id, values),
  ]);

  const { stableSystem, userBody } = splitSegments(segments);
  return {
    record,
    stableSystem,
    userBody,
    flat: stableSystem ? `${stableSystem}${userBody}` : userBody,
  };
}

/**
 * An assembled prompt built from text the caller already has, for the one
 * caller whose prompt does not live in the prompt store (the bid assistant).
 */
export function assembleRawPrompt(input: { system: string; user: string }): AssembledPrompt {
  return {
    record: null,
    stableSystem: input.system,
    userBody: input.user || ' ',
    flat: input.system ? `${input.system}\n\n${input.user}` : input.user,
  };
}
