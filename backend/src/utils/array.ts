export function moveCaseInsensitiveMatches(
  referenceValues: string[],
  candidateValues: string[],
  matchedValues: string[]
): void {
  const referenceSet = new Set(referenceValues.map((item) => item.toLowerCase()));

  for (let index = candidateValues.length - 1; index >= 0; index -= 1) {
    if (referenceSet.has(candidateValues[index].toLowerCase())) {
      matchedValues.push(candidateValues[index]);
      candidateValues.splice(index, 1);
    }
  }
}

export function uniqueCaseInsensitive(values: string[]): string[] {
  const seen = new Set<string>();

  return values.filter((item) => {
    const key = item.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
