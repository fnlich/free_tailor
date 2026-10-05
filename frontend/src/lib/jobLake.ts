import { apiFetch } from './api';
import type { JobSalary } from './jobAnalysis';

/**
 * The Job Data Lake's API: Report Jobs (`/api/report`, a reporter's own sheet
 * and runs) and the administrators' lake (`/api/admin/job-lake`).
 *
 * Shapes only, as the server answers them - what a page decides about them
 * (the summary line, which rows are skipped, the query a filter form builds,
 * the settings a form sends) is lib/jobLakeDisplay.ts, which imports nothing
 * at runtime so backend/test/frontendJobLake.test.js can run it against the
 * server's own rules.
 *
 * Every amount served is an integer number of thousandths of a dollar in a
 * field ending `Milli`; every amount sent is dollars, as typed, in a field
 * ending `Usd` (CLAUDE.md, "Money").
 */

/* ---------------------------------------------------------- Report Jobs */

/**
 * The reporter's own sheet, as GET /api/report reads it: configured with its
 * address and today's tab; not configured (no Google credential on the
 * server), with a sentence for the reader; or configured but unreachable,
 * with the server's public sentence (which may end in a `Ref:`).
 */
export type ReportSheet = {
  configured: boolean;
  spreadsheetId?: string | null;
  spreadsheetUrl?: string | null;
  todayTab?: string;
  todayTabUrl?: string | null;
  message?: string;
  error?: string;
};

/** What a row of a run came to. `duplicate` is the one painted red, here and in the sheet. */
export type ReportRowStatus =
  | 'pending'
  | 'added'
  | 'replaced'
  | 'duplicate'
  | 'unclassified'
  | 'skipped'
  | 'failed'
  | 'already-reported';

/** What the run wrote into the row's Lake Status cell. */
export type LakeStatusText = 'Added' | 'Replaced' | 'Duplicate' | 'Unclassified' | 'Skipped';

export type ReportRowOutcome = {
  row: number;
  company: string;
  title: string;
  status: ReportRowStatus;
  lakeStatus: LakeStatusText | null;
  jobHash: string | null;
  lakeId: number | null;
  /** What this row paid, in thousandths of a dollar. */
  rewardMilli: number;
  /** Why a row was skipped, failed or not counted, in words for the reporter. */
  reason: string | null;
};

export type ReportRunSummary = {
  /** Jobs the lake accepted: added plus replaced (a replacement counts as added). */
  added: number;
  /** Rows the run took to the lake: every row holding a job, less those reported before. */
  total: number;
  duplicates: number;
  unclassified: number;
  replaced: number;
  skipped: number;
  failed: number;
  alreadyReported: number;
  earnedMilli: number;
  /** The reporter's balance when the run ended. */
  balanceMilli: number;
  /** False when the Lake Status cells could not be written; the lake has the jobs regardless. */
  sheetUpdated: boolean;
};

export type ReportRun = {
  id: string;
  state: 'running' | 'finished' | 'failed';
  spreadsheetId: string;
  tabName: string;
  fromRow: number;
  toRow: number;
  startedAt: string;
  finishedAt: string | null;
  progress: { total: number; done: number };
  rows: ReportRowOutcome[];
  summary: ReportRunSummary | null;
  /** Why the run stopped, when it failed - a public sentence. */
  error: string | null;
};

export type ReportOverview = {
  sheet: ReportSheet;
  /** False for an administrator, who may report but is never paid. */
  paid: boolean;
  rate: { rateMilli: number; source: 'own' | 'global' };
  dailyCapMilli: number | null;
  /** Earned from the lake since midnight UTC. */
  earnedTodayMilli: number;
  balanceMilli: number;
  /** Jobs in the lake that name this account as the one who reported them. */
  lakeJobs: number;
  maxRunRows: number;
  /** The latest run, running or kept for an hour after it ended. */
  run: ReportRun | null;
};

export type ReportTabs = {
  spreadsheetId: string;
  tabs: Array<{ title: string; gid?: number }>;
  /** Today's tab when the sheet has it, else the first; null for none. */
  defaultTab: string | null;
};

/** One row of the preview: what a run over it would read, and whether it would skip it. */
export type ReportPreviewRow = {
  row: number;
  company: string;
  title: string;
  link: string;
  descriptionLength: number;
  jobHash: string | null;
  lakeStatus: string | null;
  /**
   * The row's Lake Status says it was reported (Added, Replaced, Duplicate,
   * Unclassified) beside the Analysis cell of the posting in the row now: a
   * run skips it. A status left by a posting the row held before is not
   * counted - the server decides, the page only shows it.
   */
  reported: boolean;
};

export type ReportPreview = {
  tabName: string;
  fromRow: number;
  toRow: number;
  /** False for a tab not laid out as a job sheet tab: it has no rows to report. */
  jobTab: boolean;
  rows: ReportPreviewRow[];
};

export const reportApi = {
  overview: () => apiFetch<ReportOverview>('/report'),
  tabs: () => apiFetch<ReportTabs>('/report/tabs'),
  rows: (tabName: string, fromRow: number, toRow: number) =>
    apiFetch<ReportPreview>(
      `/report/rows?${new URLSearchParams({ tab: tabName, from: String(fromRow), to: String(toRow) }).toString()}`
    ),
  /** 202 with the run's first view; 409 `run-in-progress` (with `runId`) while one goes. */
  start: (range: { tabName: string; fromRow: number; toRow: number }) =>
    apiFetch<{ run: ReportRun }>('/report/runs', { method: 'POST', body: JSON.stringify(range) }),
  current: () => apiFetch<{ run: ReportRun | null }>('/report/runs/current'),
  run: (id: string) => apiFetch<{ run: ReportRun }>(`/report/runs/${encodeURIComponent(id)}`),
};

/* --------------------------------------------------- the admin lake */

export type LakeRequester = { id: string; email: string; name: string } | null;

export type LakeReward = {
  milli: number;
  /** The rate the reward was worked out at; null when nobody was paid. */
  rateMilli: number | null;
  revokedMilli: number;
  revokedAt: string | null;
};

export type LakeEntry = {
  id: number;
  jobHash: string;
  hashVersion: number;
  company: string;
  companyKey: string;
  jobFieldId: string;
  jobFieldLabel: string;
  title: string;
  salary: JobSalary | null;
  url: string;
  /** Only on a single row's read. */
  jobDescription?: string;
  analysisId: string | null;
  requestedBy: string | null;
  source: 'report' | 'merge';
  createdAt: string;
  updatedAt: string;
  seenCount: number;
  lastSeenAt: string | null;
  sheetSyncedAt: string | null;
  reward: LakeReward;
  requester: LakeRequester;
};

export type LakeHistoryEntry = {
  id: number;
  lakeId: number;
  jobHash: string;
  company: string;
  jobFieldId: string;
  jobFieldLabel: string;
  title: string;
  salary: JobSalary | null;
  url: string;
  jobDescription: string;
  analysisId: string | null;
  requestedBy: string | null;
  source: 'report' | 'merge';
  /** When this version was added. */
  versionAt: string;
  seenCount: number;
  reward: LakeReward;
  replacedAt: string;
  requester: LakeRequester;
};

export type RevokeOutcome = {
  /** False when there was nothing to revoke: no reward, or revoked already. */
  revoked: boolean;
  /** What came off the balance: never more than it held. */
  takenMilli: number;
  rewardMilli: number;
  userId: string | null;
  balanceMilli: number | null;
};

export type DuplicateWindow = {
  days: number;
  source: 'admin' | 'env' | 'default';
  adminDays: number | null;
  envDays: number;
  envSet: boolean;
  envInvalid: boolean;
};

export type LakeSettings = {
  reportRateMilli: number;
  /** False until an administrator saves a global rate: nobody is paid yet. */
  reportRateSet: boolean;
  duplicateWindow: DuplicateWindow;
  dailyCapMilli: number | null;
  updatedAt: string | null;
};

export type AdminLakeSheet = {
  spreadsheetId: string;
  spreadsheetUrl: string;
  tabName: string;
  createdAt: string;
  sharedWith: string[];
};

export type AdminLakeSyncStatus = {
  /** Jobs whose current version is not on the admin sheet yet. */
  unsynced: number;
  running: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastAppended: number;
  /** Why the last sync failed - for administrators; null when it did not. */
  lastError: string | null;
};

export type SyncReport = { appended: number; failed: boolean; skipped?: 'nothing-to-sync' | 'not-configured' };

export type LakeSettingsAnswer = { settings: LakeSettings; sheet: AdminLakeSheet | null; sync: AdminLakeSyncStatus };

/** The settings form's body: each field optional, null or '' clears it. */
export type LakeSettingsUpdate = {
  reportRateUsd?: string | null;
  duplicateWindowDays?: string | null;
  dailyCapUsd?: string | null;
};

export type MergeCandidate = {
  analysisId: string;
  company: string;
  jobFieldId: string;
  jobFieldLabel: string;
  title: string;
  salary: JobSalary | null;
  url: string;
  createdBy: string | null;
  createdAt: string;
  requester: LakeRequester;
};

export type MergeStatus =
  | 'added'
  | 'replaced'
  | 'duplicate'
  | 'already'
  | 'unclassified'
  | 'no-company'
  | 'not-found'
  | 'merged-before'
  | 'not-offered';

export type MergeReport = {
  merged: number;
  /** Includes replaced. */
  added: number;
  replaced: number;
  duplicates: number;
  skipped: number;
  /** What the Merge tab still offers afterwards. */
  remaining: number;
  results: Array<{ analysisId: string; status: MergeStatus; lakeId: number | null; jobHash: string | null }>;
};

/** The job fields, as GET /api/resume/job-fields lists them for a filter. */
export type JobFieldCatalog = {
  areas: Array<{ number: number; label: string }>;
  fields: Array<{ id: string; label: string; area: number }>;
  unclassified: { id: string; label: string };
};

export type Paged<Row> = { rows: Row[]; total: number; limit: number; offset: number };

export const adminJobLakeApi = {
  /** `query` is lib/jobLakeDisplay.ts's `lakeQueryString`. */
  list: (query: string) => apiFetch<Paged<LakeEntry>>(`/admin/job-lake${query ? `?${query}` : ''}`),
  get: (id: number) => apiFetch<{ entry: LakeEntry; history: LakeHistoryEntry[] }>(`/admin/job-lake/${id}`),
  remove: (id: number, revokeReward: boolean) =>
    apiFetch<{ deleted: true; id: number; revoke: RevokeOutcome | null }>(
      `/admin/job-lake/${id}${revokeReward ? '?revokeReward=1' : ''}`,
      { method: 'DELETE' }
    ),
  revokeReward: (id: number) =>
    apiFetch<{ revoke: RevokeOutcome; entry: LakeEntry }>(`/admin/job-lake/${id}/revoke-reward`, { method: 'POST' }),
  settings: () => apiFetch<LakeSettingsAnswer>('/admin/job-lake/settings'),
  saveSettings: (body: LakeSettingsUpdate) =>
    apiFetch<LakeSettingsAnswer>('/admin/job-lake/settings', { method: 'PUT', body: JSON.stringify(body) }),
  sync: () =>
    apiFetch<{ sheet: AdminLakeSheet | null; sync: AdminLakeSyncStatus }>('/admin/job-lake/sync'),
  /** "Retry now": the sync, awaited. */
  retrySync: () =>
    apiFetch<{ report: SyncReport; sheet: AdminLakeSheet | null; sync: AdminLakeSyncStatus }>('/admin/job-lake/sync', {
      method: 'POST',
    }),
  /** Creates the admin sheet now - or, with `recreate`, a new one that is sent the whole lake. */
  createSheet: (recreate: boolean) =>
    apiFetch<{ sheet: AdminLakeSheet; sync: AdminLakeSyncStatus }>('/admin/job-lake/sheet', {
      method: 'POST',
      body: JSON.stringify(recreate ? { recreate: true } : {}),
    }),
  mergeCandidates: (offset: number, limit: number) =>
    apiFetch<Paged<MergeCandidate>>(`/admin/job-lake/merge?offset=${offset}&limit=${limit}`),
  merge: (body: { analysisIds: string[] } | { all: true }) =>
    apiFetch<MergeReport>('/admin/job-lake/merge', { method: 'POST', body: JSON.stringify(body) }),
  jobFields: () => apiFetch<JobFieldCatalog>('/resume/job-fields'),
};
