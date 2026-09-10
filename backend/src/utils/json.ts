function tryParseJsonCandidate(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    return null;
  }
}

function findFirstBalancedJson(text: string): string | null {
  const source = text.trim();
  if (!source) return null;

  for (let start = 0; start < source.length; start += 1) {
    const firstChar = source[start];
    if (firstChar !== '{' && firstChar !== '[') {
      continue;
    }

    const stack: string[] = [firstChar === '{' ? '}' : ']'];
    let inString = false;
    let escaping = false;

    for (let index = start + 1; index < source.length; index += 1) {
      const char = source[index];

      if (inString) {
        if (escaping) {
          escaping = false;
          continue;
        }
        if (char === '\\') {
          escaping = true;
          continue;
        }
        if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === '{') {
        stack.push('}');
        continue;
      }

      if (char === '[') {
        stack.push(']');
        continue;
      }

      if (char === '}' || char === ']') {
        const expected = stack.pop();
        if (expected !== char) {
          break;
        }

        if (stack.length === 0) {
          const candidate = source.slice(start, index + 1);
          if (tryParseJsonCandidate(candidate)) {
            return candidate;
          }
          break;
        }
      }
    }
  }

  return null;
}

/**
 * The markers the JSON prompt asks a chat window to wrap its answer in.
 *
 * Duplicated here rather than imported so this utility stays free of the AI
 * layer - it is called from places that have no business loading a provider
 * registry. `promptAssembly.ts` owns the canonical pair and a test pins the two
 * together, so they cannot drift apart silently.
 */
const BEGIN_SENTINEL = '@@BEGIN_JSON@@';
const END_SENTINEL = '@@END_JSON@@';

/**
 * What lies between the sentinels, if both are there.
 *
 * The LAST begin marker and the first end marker after it: a model that
 * restates the instruction before obeying it - "I will wrap it in
 * @@BEGIN_JSON@@ ... " - emits the marker twice, and the real answer is the
 * later one. Taking the first would return the instruction being quoted back.
 */
function betweenSentinels(text: string): string | null {
  const begin = text.lastIndexOf(BEGIN_SENTINEL);
  if (begin === -1) return null;
  const from = begin + BEGIN_SENTINEL.length;
  const end = text.indexOf(END_SENTINEL, from);
  // An answer cut off before its closing marker is still worth trying: the
  // balanced scan below can find a complete object inside a truncated reply.
  const slice = end === -1 ? text.slice(from) : text.slice(from, end);
  return slice.trim() || null;
}

/**
 * The mistakes a chat model actually makes, undone.
 *
 * Applied only AFTER an honest parse has failed, and only to a candidate that
 * already looks like JSON, so a valid document is never rewritten. Each of
 * these was chosen for the same reason: it is unambiguous. A trailing comma
 * before a closing brace cannot be anything but a mistake; a curly quote where
 * a delimiter belongs cannot be part of a string that has not started yet.
 * Anything that would require guessing at intent is deliberately not here -
 * a wrong repair produces confidently wrong data, which is worse than a clean
 * failure.
 */
function repairCommonJsonDamage(candidate: string): string {
  let out = candidate;

  // Curly quotes used as delimiters. Rewritten only when they sit where a
  // delimiter goes - after `{`, `[`, `,` or `:`, or before `:`, `,`, `}` or
  // `]` - so an apostrophe inside prose is left alone.
  out = out
    .replace(/([{\[,:]\s*)[\u201C\u201D]/g, '$1"')
    .replace(/[\u201C\u201D](\s*[:,}\]])/g, '"$1');

  // `// line` and `/* block */` comments, which no JSON parser accepts and
  // several models add anyway. Skipped inside strings.
  out = stripCommentsOutsideStrings(out);

  // A trailing comma before a close.
  out = out.replace(/,(\s*[}\]])/g, '$1');

  // A bare ellipsis standing in for "and so on", in either position it appears.
  out = out.replace(/,\s*\.\.\.\s*([}\]])/g, '$1').replace(/\[\s*\.\.\.\s*\]/g, '[]');

  return out;
}

function stripCommentsOutsideStrings(source: string): string {
  let out = '';
  let inString = false;
  let escaping = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      out += char;
      if (escaping) escaping = false;
      else if (char === '\\') escaping = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === '/' && source[i + 1] === '/') {
      const newline = source.indexOf('\n', i);
      if (newline === -1) break;
      i = newline - 1;
      continue;
    }
    if (char === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      if (close === -1) break;
      i = close + 1;
      continue;
    }
    out += char;
  }
  return out;
}

/**
 * The JSON inside a model's reply, in the order the answer is most likely to be.
 *
 * Ordered by how much each source PROVES. The sentinels are the only marker the
 * model was explicitly told to emit, so text between them is the answer by
 * construction. A fence is next: still deliberate, but a chat window renders it
 * away and a model may fence something that is not the answer. The whole reply
 * is next, for the providers that emit nothing else. The balanced scan is last,
 * because it finds the first thing SHAPED like JSON, which in a reply with
 * preamble can be an example rather than the result.
 *
 * Every candidate is tried honestly first and only then repaired, so a valid
 * document is never rewritten on its way through.
 */
export function extractJSON(text: string): string {
  const candidates: string[] = [];

  const sentinel = betweenSentinels(text);
  if (sentinel) candidates.push(sentinel);

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]?.trim()) candidates.push(fenced[1].trim());

  const direct = text.trim();
  if (direct) candidates.push(direct);

  for (const candidate of candidates) {
    const exact = tryParseJsonCandidate(candidate);
    if (exact) return exact;

    const balanced = findFirstBalancedJson(candidate);
    if (balanced) return balanced;
  }

  for (const candidate of candidates) {
    const repaired = repairCommonJsonDamage(candidate);
    if (repaired === candidate) continue;

    const exact = tryParseJsonCandidate(repaired);
    if (exact) return exact;

    const balanced = findFirstBalancedJson(repaired);
    if (balanced) return balanced;
  }

  throw new Error('No valid JSON object found in model response');
}
