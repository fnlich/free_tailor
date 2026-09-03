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

export function extractJSON(text: string): string {
  const candidates: string[] = [];
  const direct = text.trim();
  if (direct) {
    candidates.push(direct);
  }

  const jsonBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (jsonBlockMatch?.[1]?.trim()) {
    candidates.unshift(jsonBlockMatch[1].trim());
  }

  for (const candidate of candidates) {
    const exact = tryParseJsonCandidate(candidate);
    if (exact) {
      return exact;
    }

    const balanced = findFirstBalancedJson(candidate);
    if (balanced) {
      return balanced;
    }
  }

  throw new Error('No valid JSON object found in model response');
}
