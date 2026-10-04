'use client';

import { FormEvent, ReactNode, useEffect, useMemo, useState } from 'react';
import {
  adminApi,
  AdminAppSettings,
  AIModelRecord,
  getAIProviderLabel,
  isProviderOffered,
  PromptSummary,
  promptsApi,
  resumeApi,
} from '@/lib/api';
import { applyTheme, getStoredTheme, setStoredDefaultTheme } from '@/lib/theme';
import { AdminOnly } from '@/components/auth/AuthGate';
import { Card, Field, Notice, Pill, Section } from '@/components/ui/kit';
import { messageWithDetail } from '@/lib/userMessage';

import styles from './test.module.css';

type HighlightKind = 'required' | 'preferred' | 'keyword' | 'industry' | 'domain' | 'soft';

type KeywordEntry = {
  value: string;
  kind: HighlightKind;
};

type HighlightMatch = KeywordEntry & {
  start: number;
  end: number;
};

type OutputKeySummary = {
  key: string;
  count: number;
};

const KIND_LABELS: Record<HighlightKind, string> = {
  required: 'Required',
  preferred: 'Preferred',
  keyword: 'Keyword',
  industry: 'Industry',
  domain: 'Domain knowledge',
  soft: 'Soft skill',
};

const KIND_CLASSES: Record<HighlightKind, string> = {
  required: 'bg-emerald-100 text-emerald-950 ring-1 ring-emerald-300 dark:bg-emerald-400/20 dark:text-emerald-100 dark:ring-emerald-300/30',
  preferred: 'bg-sky-100 text-sky-950 ring-1 ring-sky-300 dark:bg-sky-400/20 dark:text-sky-100 dark:ring-sky-300/30',
  keyword: 'bg-amber-100 text-amber-950 ring-1 ring-amber-300 dark:bg-amber-400/20 dark:text-amber-100 dark:ring-amber-300/30',
  industry: 'bg-violet-100 text-violet-950 ring-1 ring-violet-300 dark:bg-violet-400/20 dark:text-violet-100 dark:ring-violet-300/30',
  domain: 'bg-fuchsia-100 text-fuchsia-950 ring-1 ring-fuchsia-300 dark:bg-fuchsia-400/20 dark:text-fuchsia-100 dark:ring-fuchsia-300/30',
  soft: 'bg-rose-100 text-rose-950 ring-1 ring-rose-300 dark:bg-rose-400/20 dark:text-rose-100 dark:ring-rose-300/30',
};

const OUTPUT_KEY_CLASSES = [
  'bg-emerald-100 text-emerald-950 ring-1 ring-emerald-300 dark:bg-emerald-400/20 dark:text-emerald-100 dark:ring-emerald-300/30',
  'bg-sky-100 text-sky-950 ring-1 ring-sky-300 dark:bg-sky-400/20 dark:text-sky-100 dark:ring-sky-300/30',
  'bg-amber-100 text-amber-950 ring-1 ring-amber-300 dark:bg-amber-400/20 dark:text-amber-100 dark:ring-amber-300/30',
  'bg-violet-100 text-violet-950 ring-1 ring-violet-300 dark:bg-violet-400/20 dark:text-violet-100 dark:ring-violet-300/30',
  'bg-fuchsia-100 text-fuchsia-950 ring-1 ring-fuchsia-300 dark:bg-fuchsia-400/20 dark:text-fuchsia-100 dark:ring-fuchsia-300/30',
  'bg-rose-100 text-rose-950 ring-1 ring-rose-300 dark:bg-rose-400/20 dark:text-rose-100 dark:ring-rose-300/30',
];

/**
 * The models this page may run: enabled, on a provider this installation
 * offers.
 *
 * `isProviderOffered` and nothing else for the provider half. A private copy
 * that reads only `providersEnabled` drops the LOCK clause, so a model this
 * machine cannot run is offered here and picking it produces a backend error -
 * and the next clause the backend's rule grows is missed here as well.
 */
function runnableModels(settings: AdminAppSettings): AIModelRecord[] {
  return settings.aiModels.filter(
    (model) => model.enabled && isProviderOffered(settings, model.provider, settings.providersEnabled)
  );
}

/** The app default when it can run, otherwise the first model that can. */
function pickDefaultModelId(settings: AdminAppSettings): string {
  const models = runnableModels(settings);
  return (models.find((model) => model.id === settings.defaultModelId) ?? models[0])?.id ?? '';
}

function normalizeTerm(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function addTerms(
  entries: KeywordEntry[],
  seen: Set<string>,
  values: string[] | undefined,
  kind: HighlightKind
) {
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
    for (const item of value) {
      collectStringValues(item, output);
    }
    return output;
  }

  if (isRecord(value)) {
    for (const item of Object.values(value)) {
      collectStringValues(item, output);
    }
  }

  return output;
}

function collectHighlightTerms(analysis: unknown): KeywordEntry[] {
  if (!analysis) return [];

  const seen = new Set<string>();
  const entries: KeywordEntry[] = [];

  if (isRecord(analysis)) {
    const skills = isRecord(analysis.skills) ? analysis.skills : {};
    const keywords = isRecord(analysis.keywords) ? analysis.keywords : {};
    const jobMeta = isRecord(analysis.jobMeta) ? analysis.jobMeta : {};

    addTerms(entries, seen, [
      ...getStringArray(skills.technical),
      ...getStringArray(skills.required),
    ], 'required');
    addTerms(entries, seen, getStringArray(skills.preferred), 'preferred');
    addTerms(entries, seen, [
      ...getStringArray(keywords.actionVerbs),
      ...getStringArray(keywords.buzzwords),
      ...getStringArray(keywords.mustInclude),
      ...getStringArray(skills.tools),
      ...getStringArray(analysis.technologies),
      ...getStringArray(skills.technologies),
      ...getStringArray(analysis.protocols),
      ...getStringArray(analysis.methodologies),
      ...getStringArray(analysis.architecturePatterns),
      ...getStringArray(analysis.skills),
      ...getStringArray(analysis.keywords),
    ], 'keyword');
    addTerms(entries, seen, [
      typeof jobMeta.industry === 'string' ? jobMeta.industry : '',
      typeof jobMeta.department === 'string' ? jobMeta.department : '',
      typeof analysis.industry === 'string' ? analysis.industry : '',
      typeof analysis.department === 'string' ? analysis.department : '',
    ], 'industry');
    addTerms(entries, seen, getStringArray(analysis.domainKnowledge), 'domain');
    addTerms(entries, seen, [
      ...getStringArray(analysis.softSkills),
      ...getStringArray(skills.soft),
    ], 'soft');
  }

  addTerms(entries, seen, collectStringValues(analysis), 'keyword');

  return entries.sort((a, b) => b.value.length - a.value.length);
}

function countJsonItems(value: unknown): number {
  if (typeof value === 'string') return value.trim() ? 1 : 0;
  if (typeof value === 'number' || typeof value === 'boolean') return 1;
  if (Array.isArray(value)) {
    return value.reduce<number>((total, item) => total + countJsonItems(item), 0);
  }
  if (isRecord(value)) {
    return Object.values(value).reduce<number>((total, item) => total + countJsonItems(item), 0);
  }
  return 0;
}

function summarizeOutputKeys(analysis: unknown): OutputKeySummary[] {
  if (!isRecord(analysis)) {
    return analysis == null ? [] : [{ key: 'result', count: countJsonItems(analysis) }];
  }

  return Object.entries(analysis).map(([key, value]) => ({
    key,
    count: countJsonItems(value),
  }));
}

function isWordChar(value: string | undefined): boolean {
  return Boolean(value && /[A-Za-z0-9]/.test(value));
}

function isBoundarySafe(text: string, start: number, end: number, term: string): boolean {
  const first = term[0];
  const last = term[term.length - 1];
  if (!isWordChar(first) && !isWordChar(last)) return true;

  const previous = text[start - 1];
  const next = text[end];
  const needsStartBoundary = isWordChar(first);
  const needsEndBoundary = isWordChar(last);

  return (!needsStartBoundary || !isWordChar(previous)) && (!needsEndBoundary || !isWordChar(next));
}

function rangesOverlap(a: HighlightMatch, b: HighlightMatch): boolean {
  return a.start < b.end && b.start < a.end;
}

function findMatches(text: string, terms: KeywordEntry[]): HighlightMatch[] {
  const lowerText = text.toLowerCase();
  const matches: HighlightMatch[] = [];

  for (const term of terms) {
    const needle = term.value.toLowerCase();
    let index = lowerText.indexOf(needle);

    while (index !== -1) {
      const end = index + needle.length;
      const candidate = { ...term, start: index, end };
      if (
        isBoundarySafe(text, index, end, term.value) &&
        !matches.some((match) => rangesOverlap(match, candidate))
      ) {
        matches.push(candidate);
      }
      index = lowerText.indexOf(needle, index + Math.max(needle.length, 1));
    }
  }

  return matches.sort((a, b) => a.start - b.start || b.end - a.end);
}

function renderHighlightedText(text: string, matches: HighlightMatch[]): ReactNode[] {
  if (matches.length === 0) return [text];

  const nodes: ReactNode[] = [];
  let cursor = 0;

  matches.forEach((match, index) => {
    if (match.start > cursor) {
      nodes.push(text.slice(cursor, match.start));
    }
    nodes.push(
      <mark
        key={`${match.start}-${match.end}-${index}`}
        className={`rounded px-1 py-0.5 font-medium ${KIND_CLASSES[match.kind]}`}
        title={KIND_LABELS[match.kind]}
      >
        {text.slice(match.start, match.end)}
      </mark>
    );
    cursor = match.end;
  });

  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }

  return nodes;
}

function TestPageBody() {
  const [jobDescription, setJobDescription] = useState('');
  const [analysis, setAnalysis] = useState<unknown>(null);
  /*
   * A MODEL id, the way every other caller names what to run - not a bare
   * provider, which ran whichever of that provider's models came first, so the
   * test could not be pointed at the model a real run would use.
   */
  const [selectedModelId, setSelectedModelId] = useState('');
  const [analyzePrompts, setAnalyzePrompts] = useState<PromptSummary[]>([]);
  const [selectedPromptId, setSelectedPromptId] = useState('analyze-job-description');
  const [models, setModels] = useState<AIModelRecord[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const [settings, promptList] = await Promise.all([
          adminApi.getSettings(),
          promptsApi.getAll(),
        ]);
        const analyzerPrompts = promptList.filter((prompt) => prompt.featureKey === 'analyze-job-description');
        const offered = runnableModels(settings);
        setModels(offered);
        setAnalyzePrompts(analyzerPrompts);
        setSelectedPromptId((current) =>
          analyzerPrompts.some((prompt) => prompt.id === current)
            ? current
            : analyzerPrompts[0]?.id ?? 'analyze-job-description'
        );
        setSelectedModelId((current) =>
          offered.some((model) => model.id === current) ? current : pickDefaultModelId(settings)
        );
        setStoredDefaultTheme(settings.defaultTheme);
        applyTheme(getStoredTheme() ?? settings.defaultTheme);
      } catch (err) {
        setError(messageWithDetail(err, 'Failed to load test settings'));
      }
    };

    void loadSettings();
  }, []);

  const highlightTerms = useMemo(() => collectHighlightTerms(analysis), [analysis]);
  const matches = useMemo(
    () => findMatches(jobDescription, highlightTerms),
    [jobDescription, highlightTerms]
  );
  const outputKeySummaries = useMemo(() => summarizeOutputKeys(analysis), [analysis]);
  const formattedJson = useMemo(
    () => (analysis ? JSON.stringify(analysis, null, 2) ?? String(analysis) : '{\n  "result": "Run analysis to see JSON here."\n}'),
    [analysis]
  );

  const handleAnalyze = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = jobDescription.trim();

    if (trimmed.length < 50) {
      setError('Job description must be at least 50 characters.');
      setStatus('');
      setAnalysis(null);
      return;
    }

    setIsAnalyzing(true);
    setError('');
    setStatus('');

    try {
      const result = await resumeApi.analyzePromptTest(trimmed, { model: selectedModelId }, selectedPromptId);
      setAnalysis(result);
      setStatus('Analysis complete.');
    } catch (err) {
      setAnalysis(null);
      setError(messageWithDetail(err, 'Failed to analyze job description'));
    } finally {
      setIsAnalyzing(false);
    }
  };

  const hasAnyModel = models.length > 0;

  return (
    <main className="mx-auto w-full max-w-7xl px-4 pb-16 pt-8 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-2xl font-bold tracking-tight text-ink">Job Keyword Prompt Test</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            Paste a job description, run the analyzer, and compare the raw JSON against highlighted extracted terms.
          </p>
        </div>
        <Pill tone={analysis ? 'sky' : 'grey'}>
          {analysis ? `${matches.length} visible matches from ${highlightTerms.length} extracted terms` : 'No analysis yet'}
        </Pill>
      </div>

      <Section title="Analyzer" description="The job description to run, the analyze prompt to run it through, and the model to run it on.">
        <form onSubmit={handleAnalyze} className="space-y-6">
          <Field label="Job description" htmlFor="prompt-test-description">
            <textarea
              id="prompt-test-description"
              value={jobDescription}
              onChange={(event) => setJobDescription(event.target.value)}
              placeholder="Paste the job description here..."
              className="tl-input"
              // Inline: `textarea.tl-input` is unlayered and outranks a min-h utility.
              style={{ minHeight: '10rem' }}
            />
          </Field>

          <div className="grid gap-6 sm:grid-cols-2">
            <Field label="Analyze prompt" htmlFor="prompt-test-prompt">
              <select
                id="prompt-test-prompt"
                value={selectedPromptId}
                onChange={(event) => setSelectedPromptId(event.target.value)}
                className="tl-input"
                disabled={isAnalyzing}
              >
                {analyzePrompts.length === 0 && (
                  <option value="analyze-job-description">Built-in analyzer</option>
                )}
                {analyzePrompts.map((prompt) => (
                  <option key={prompt.id} value={prompt.id}>
                    {prompt.name}{prompt.isBuiltIn ? ' (built-in)' : ''}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Model" htmlFor="prompt-test-model">
              <select
                id="prompt-test-model"
                value={selectedModelId}
                onChange={(event) => setSelectedModelId(event.target.value)}
                className="tl-input"
                disabled={!hasAnyModel || isAnalyzing}
              >
                {!hasAnyModel && <option value="">No model can run</option>}
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {`${model.name} (${getAIProviderLabel(model.provider)})`}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div>
            <button
              type="submit"
              disabled={isAnalyzing || !hasAnyModel}
              className="tl-button"
            >
              <span aria-hidden="true">{"->"}</span>
              {isAnalyzing ? 'Analyzing...' : 'Analyze'}
            </button>
          </div>

          {error && (
            <Notice tone="error" role="alert">
              {error}
            </Notice>
          )}

          {status && !error && (
            <Notice tone="success" role="status">
              {status}
            </Notice>
          )}
        </form>
      </Section>

      <Section title="Results" description="The description with every extracted term marked, beside the JSON the analyzer returned.">
        {Boolean(analysis) && (
          <div className="flex flex-wrap gap-2">
            {outputKeySummaries.map((summary, index) => (
              <span
                key={summary.key}
                className={`rounded-md px-2.5 py-1 text-xs font-semibold ${OUTPUT_KEY_CLASSES[index % OUTPUT_KEY_CLASSES.length]}`}
              >
                {summary.key}: {summary.count}
              </span>
            ))}
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="Highlighted job description" padded={false} className="min-w-0">
            <div className="max-h-[720px] overflow-auto p-5">
              <div className="whitespace-pre-wrap break-words rounded-md bg-surface-muted p-4 text-sm leading-7 text-ink">
                {jobDescription
                  ? renderHighlightedText(jobDescription, matches)
                  : 'Paste a job description above to preview highlights here.'}
              </div>
            </div>
          </Card>

          <Card title="JSON result" padded={false} className="min-w-0">
            <div className="max-h-[720px] overflow-auto p-5">
              <pre className={`whitespace-pre-wrap break-words rounded-md p-4 font-mono text-xs leading-6 ${styles.json}`}>
                {formattedJson}
              </pre>
            </div>
          </Card>
        </div>
      </Section>
    </main>
  );
}

/**
 * Administrator-only. It runs prompts directly and shows the raw model output,
 * which is a tool for whoever maintains the prompts rather than for the people
 * building resumes with them.
 */
export default function TestPage() {
  return (
    <AdminOnly>
      <TestPageBody />
    </AdminOnly>
  );
}
