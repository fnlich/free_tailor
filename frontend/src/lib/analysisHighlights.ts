/**
 * The terms Admin -> Prompt Test marks in the posting: what the analysis read
 * OUT of it, and nothing the analysis says ABOUT it.
 *
 * An analysis is two calls (services/jobAnalysis/gate.ts): the keywords
 * (Analyze Job Description) and the posting's facts (Job Facts (Filter)) -
 * `jobField`, `industry` on an older analysis, `salary` and `filter`. The
 * facts are classifications, not words of the posting: marking them marked
 * every "us" in "join us" for a region of `us`, and every "remote" in a
 * sentence about remote tooling. They are shown as facts beside the result
 * instead (components/AnalysisFacts).
 *
 * Imports nothing at runtime, so backend/test/frontendAnalysis.test.js runs it.
 */

export type HighlightKind = 'required' | 'preferred' | 'keyword' | 'industry' | 'domain' | 'soft';

export type KeywordEntry = {
  value: string;
  kind: HighlightKind;
};

/** The facts call's keys - and an older analysis's industry - which are never marked as terms. */
export const ANALYSIS_FACT_KEYS: readonly string[] = ['jobField', 'industry', 'salary', 'filter'];

function normalizeTerm(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function addTerms(entries: KeywordEntry[], seen: Set<string>, values: string[] | undefined, kind: HighlightKind) {
  for (const rawValue of values ?? []) {
    const value = normalizeTerm(rawValue);
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    entries.push({ value, kind });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function collectStringValues(value: unknown, output: string[] = []): string[] {
  if (typeof value === 'string') {
    output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, output);
    return output;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) collectStringValues(item, output);
  }
  return output;
}

/** The analysis without its facts: the keyword half, which is what the posting's words were read into. */
export function keywordPart(analysis: unknown): unknown {
  if (!isRecord(analysis)) return analysis;
  return Object.fromEntries(Object.entries(analysis).filter(([key]) => !ANALYSIS_FACT_KEYS.includes(key)));
}

/**
 * Every term to mark, longest first (so a longer term wins an overlap), each
 * once whatever its case, with the kind its list gives it - and any other
 * string of the keyword half as a plain keyword. Reads both analysis shapes:
 * the current one (`skills.technical`, `tools`, `soft`) and an older one
 * (`skills.required`, `preferred`, `technologies`, top-level `softSkills`).
 */
export function collectHighlightTerms(analysis: unknown): KeywordEntry[] {
  if (!analysis) return [];
  const keywords = keywordPart(analysis);

  const seen = new Set<string>();
  const entries: KeywordEntry[] = [];

  if (isRecord(keywords)) {
    const skills = isRecord(keywords.skills) ? keywords.skills : {};
    const keywordLists = isRecord(keywords.keywords) ? keywords.keywords : {};
    const jobMeta = isRecord(keywords.jobMeta) ? keywords.jobMeta : {};

    addTerms(entries, seen, [...getStringArray(skills.technical), ...getStringArray(skills.required)], 'required');
    addTerms(entries, seen, getStringArray(skills.preferred), 'preferred');
    addTerms(
      entries,
      seen,
      [
        ...getStringArray(keywordLists.actionVerbs),
        ...getStringArray(keywordLists.buzzwords),
        ...getStringArray(keywordLists.mustInclude),
        ...getStringArray(skills.tools),
        ...getStringArray(keywords.technologies),
        ...getStringArray(skills.technologies),
        ...getStringArray(keywords.protocols),
        ...getStringArray(keywords.methodologies),
        ...getStringArray(keywords.architecturePatterns),
      ],
      'keyword'
    );
    addTerms(
      entries,
      seen,
      [
        typeof jobMeta.industry === 'string' ? jobMeta.industry : '',
        typeof jobMeta.department === 'string' ? jobMeta.department : '',
      ],
      'industry'
    );
    addTerms(entries, seen, getStringArray(keywords.domainKnowledge), 'domain');
    addTerms(entries, seen, [...getStringArray(keywords.softSkills), ...getStringArray(skills.soft)], 'soft');
  }

  addTerms(entries, seen, collectStringValues(keywords), 'keyword');

  return entries.sort((a, b) => b.value.length - a.value.length);
}
