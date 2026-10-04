/**
 * The sentinels a provider with no JSON mode is asked to wrap its JSON in.
 *
 * Deliberately not markdown. A fence is the obvious choice and a weak one: a
 * model fences an example as readily as it fences the answer, and nothing about
 * a fence says which one it is. These are ordinary text - no character in them
 * means anything to a markdown parser, so nothing that renders or reformats the
 * reply can strip them - and they are ugly enough that no model emits them by
 * accident, so what lies between them is the answer by construction.
 *
 * Read by promptAssembly.ts, which asks for them, and by the Gemini seat,
 * which refuses a JSON answer that opened them and never closed them.
 * utils/json.ts keeps its own copy, pinned to this one by a test.
 */
export const JSON_BEGIN_SENTINEL = '@@BEGIN_JSON@@';
export const JSON_END_SENTINEL = '@@END_JSON@@';
