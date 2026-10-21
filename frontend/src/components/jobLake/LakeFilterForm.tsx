'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';

import MultiSelect, { type MultiSelectOption } from '@/components/ui/MultiSelect';
import type { ManagedAccount } from '@/lib/auth';
import { jobLakeApi, type CompanySuggestion, type JobFieldCatalog } from '@/lib/jobLake';
import {
  draftFilters,
  LAKE_CLEARANCE_CHOICES,
  LAKE_FILTER_CAP_SENTENCES,
  LAKE_FILTER_LABELS,
  LAKE_FILTER_MAX_VALUES,
  LAKE_FILTER_NOTE,
  LAKE_JOB_TYPE_CHOICES,
  LAKE_KEYWORD_SPLIT,
  lakeFilterOrderFor,
  type LakeFilterDraft,
  type LakeFilterOptions,
  type LakeFilters,
  type LakeMultiFilter,
} from '@/lib/jobLakeDisplay';

/**
 * The lake's filter form - Admin -> Job Lake's and Find Jobs', one form - in
 * the owner's order (lib/jobLakeDisplay.ts `LAKE_FILTER_ORDER`): when it was
 * updated, who reported it (an administrator's box only, `requesters` given),
 * the job field, job type, clearance and industry, the company, the salary
 * range, then the full text.
 *
 * Job field, Job type, Industry, Company, Requested by and Full text take
 * several values (components/ui/MultiSelect.tsx), and a job matching any of
 * them is found. Company and Full text take values of their own: Company
 * suggests the lake's companies as it is typed (asked of the server a moment
 * after the typing stops, the request before aborted), Full text splits
 * keywords on commas. What is typed and not yet a chip is the form's draft
 * (`typed`), and Search takes it (`draftFilters`) - nobody has to press Enter
 * first. The filters are applied by Search, not per keystroke: each is a
 * query the server runs.
 *
 * What is typed into the other four - Job field, Job type, Industry,
 * Requested by - only narrows their lists, and is no value the server could
 * take; it is the form's own, and Search and Clear both empty it, so no box
 * is left showing words that filter nothing.
 */

type ListText = Record<'field' | 'jobType' | 'industry' | 'requestedBy', string>;

const NO_LIST_TEXT: ListText = { field: '', jobType: '', industry: '', requestedBy: '' };

/** Each filter box's input id. `lake-company` and the rest are what the e2e scripts type into and pick from. */
const FILTER_INPUT_IDS: Readonly<Record<keyof LakeFilters, string>> = {
  updatedFrom: 'lake-updated-from',
  updatedTo: 'lake-updated-to',
  requestedBy: 'lake-requested-by',
  field: 'lake-field',
  jobType: 'lake-job-type',
  clearance: 'lake-clearance',
  industry: 'lake-industry',
  company: 'lake-company',
  salaryMin: 'lake-salary-min',
  salaryMax: 'lake-salary-max',
  q: 'lake-q',
};

/** How long the Company box waits after the typing stops before it asks for suggestions. */
const SUGGEST_DELAY_MS = 200;

const NOTE_ID = 'lake-filter-note';

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export default function LakeFilterForm({
  ariaLabel,
  draft,
  onDraftChange,
  options,
  fields,
  requesters,
  problem,
  onSearch,
  onClear,
  clearable,
  actions,
  note,
}: {
  ariaLabel: string;
  draft: LakeFilterDraft;
  onDraftChange: (update: (current: LakeFilterDraft) => LakeFilterDraft) => void;
  /** The job type and industry lists, as the lake route serves them; null until it has answered. */
  options: LakeFilterOptions | null;
  fields: JobFieldCatalog | null;
  /** The accounts Requested by chooses from - an administrator's form only. Null: no Requested by box. */
  requesters: readonly ManagedAccount[] | null;
  /** The server's refusal of these filters, as the page worked it out (lakeFilterProblem). */
  problem: string;
  /** Search, with the filters it applies: the chosen values and what was typed. */
  onSearch: (filters: LakeFilters) => void;
  onClear: () => void;
  /** Whether the page has filters for Clear to clear - besides words typed into a list, which the form keeps and clears itself. */
  clearable: boolean;
  /** Buttons between Clear and Search (Admin -> Job Lake's Push to Google Sheet). */
  actions?: ReactNode;
  /** A sentence after the form's own note. */
  note?: ReactNode;
}) {
  const order = lakeFilterOrderFor(requesters !== null);
  // What is typed into the four list boxes that only filter their list.
  const [filterText, setFilterText] = useState<ListText>(NO_LIST_TEXT);
  const listTextTyped = Object.values(filterText).some((text) => text.trim() !== '');
  const [suggestions, setSuggestions] = useState<CompanySuggestion[]>([]);
  const [suggesting, setSuggesting] = useState(false);

  // The lake's companies starting with what is typed into Company, asked once
  // the typing stops; a newer question aborts the older.
  const typedCompany = draft.typed.company.trim();
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(
      () => {
        if (!typedCompany) {
          setSuggestions([]);
          setSuggesting(false);
          return;
        }
        setSuggesting(true);
        jobLakeApi.companies(typedCompany, controller.signal).then(
          (answer) => {
            if (controller.signal.aborted) return;
            setSuggestions(answer.companies);
            setSuggesting(false);
          },
          () => {
            if (controller.signal.aborted) return;
            setSuggestions([]);
            setSuggesting(false);
          }
        );
      },
      typedCompany ? SUGGEST_DELAY_MS : 0
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [typedCompany]);

  const fieldOptions = useMemo<MultiSelectOption[]>(
    () =>
      fields
        ? fields.areas.flatMap((area) =>
            fields.fields
              .filter((field) => field.area === area.number)
              .map((field) => ({ id: field.id, label: field.label, group: area.label }))
          )
        : [],
    [fields]
  );
  const requesterOptions = useMemo<MultiSelectOption[]>(
    () => (requesters ?? []).map((account) => ({ id: account.id, label: `${account.email} (${account.roleLabel})` })),
    [requesters]
  );
  const companyOptions = useMemo<MultiSelectOption[]>(
    () => suggestions.map((company) => ({ id: company.name, label: company.name, hint: plural(company.jobs, 'job') })),
    [suggestions]
  );

  const setFilter = <K extends keyof LakeFilters>(key: K, value: LakeFilters[K]) =>
    onDraftChange((current) => ({ ...current, filters: { ...current.filters, [key]: value } }));
  const setTyped = (key: 'company' | 'q', value: string) =>
    onDraftChange((current) => ({ ...current, typed: { ...current.typed, [key]: value } }));

  const search = (event: FormEvent) => {
    event.preventDefault();
    // What was typed becomes chips, and what only narrowed a list goes: the boxes then show what was searched.
    const filters = draftFilters(draft);
    onDraftChange(() => ({ filters, typed: { company: '', q: '' } }));
    setFilterText(NO_LIST_TEXT);
    onSearch(filters);
  };

  // Words typed into a list are cleared even when there is no filter to clear - the page's own Clear is not asked then.
  // Clear turns itself off once nothing is left to clear, so the focus moves on to Search, never to the page.
  const searchButton = useRef<HTMLButtonElement>(null);
  const clear = () => {
    setFilterText(NO_LIST_TEXT);
    if (clearable) onClear();
    searchButton.current?.focus();
  };

  const list = (key: LakeMultiFilter): ReactNode => {
    const id = FILTER_INPUT_IDS[key];
    const label = LAKE_FILTER_LABELS[key];
    const values = draft.filters[key];
    const change = (next: string[]) => setFilter(key, next);
    switch (key) {
      case 'company':
        return (
          <MultiSelect
            id={id}
            label={label}
            values={values}
            onChange={change}
            options={companyOptions}
            filterOptions={false}
            inputValue={draft.typed.company}
            onInputChange={(text) => setTyped('company', text)}
            creatable
            maxValues={LAKE_FILTER_MAX_VALUES.company}
            fullText={LAKE_FILTER_CAP_SENTENCES.company}
            loading={suggesting}
            placeholder="OpenAI, Inc. = Open AI LLC"
            emptyText="Type a company's name."
          />
        );
      case 'q':
        return (
          <MultiSelect
            id={id}
            label={label}
            values={values}
            onChange={change}
            options={[]}
            inputValue={draft.typed.q}
            onInputChange={(text) => setTyped('q', text)}
            creatable
            splitTyped={LAKE_KEYWORD_SPLIT}
            maxValues={LAKE_FILTER_MAX_VALUES.q}
            fullText={LAKE_FILTER_CAP_SENTENCES.q}
            placeholder="Words in the company, title or description"
            emptyText="Type a keyword, then a comma or Enter."
            describedBy={NOTE_ID}
          />
        );
      default: {
        const choices: readonly MultiSelectOption[] =
          key === 'field'
            ? fieldOptions
            : key === 'jobType'
              ? LAKE_JOB_TYPE_CHOICES
              : key === 'industry'
                ? (options?.industries ?? [])
                : requesterOptions;
        return (
          <MultiSelect
            id={id}
            label={label}
            values={values}
            onChange={change}
            options={choices}
            inputValue={filterText[key]}
            onInputChange={(text) => setFilterText((current) => ({ ...current, [key]: text }))}
            {...(key === 'requestedBy'
              ? { maxValues: LAKE_FILTER_MAX_VALUES.requestedBy, fullText: LAKE_FILTER_CAP_SENTENCES.requestedBy }
              : {})}
            placeholder="Any"
            emptyText={choices.length === 0 ? 'The list has not loaded yet.' : 'Nothing matches.'}
          />
        );
      }
    }
  };

  const control = (key: keyof LakeFilters): ReactNode => {
    const id = FILTER_INPUT_IDS[key];
    switch (key) {
      case 'updatedFrom':
      case 'updatedTo':
        return (
          <input
            id={id}
            type="date"
            value={draft.filters[key]}
            onChange={(event) => setFilter(key, event.target.value)}
            className="tl-input mt-2"
          />
        );
      case 'clearance':
        return (
          <select
            id={id}
            value={draft.filters.clearance}
            onChange={(event) => setFilter('clearance', event.target.value)}
            className="tl-input mt-2"
          >
            <option value="">Any</option>
            {LAKE_CLEARANCE_CHOICES.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.label}
              </option>
            ))}
          </select>
        );
      case 'salaryMin':
      case 'salaryMax':
        return (
          <input
            id={id}
            type="text"
            inputMode="numeric"
            value={draft.filters[key]}
            onChange={(event) => setFilter(key, event.target.value)}
            placeholder="Any"
            className="tl-input mt-2 tabular-nums"
          />
        );
      default:
        return list(key);
    }
  };

  return (
    <form onSubmit={search} className="tl-card space-y-4 p-5" aria-label={ariaLabel}>
      {/* The owner's order, row by row: when and who, what kind of job, which company and its pay, the words. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {order.map((key) => (
          <div key={key} className={key === 'q' ? 'min-w-0 sm:col-span-2' : 'min-w-0'}>
            <label htmlFor={FILTER_INPUT_IDS[key]} className="tl-label">
              {LAKE_FILTER_LABELS[key]}
            </label>
            {control(key)}
          </div>
        ))}
      </div>
      <p id={NOTE_ID} className="text-xs text-subtle">
        {LAKE_FILTER_NOTE}
        {note ? <> {note}</> : null}
      </p>
      {problem && (
        <p className="tl-status" data-tone="error" role="alert">
          {problem}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-3">
        <button type="button" className="tl-button-quiet" onClick={clear} disabled={!clearable && !listTextTyped}>
          Clear
        </button>
        {actions}
        <button ref={searchButton} type="submit" className="tl-button">
          Search
        </button>
      </div>
    </form>
  );
}
