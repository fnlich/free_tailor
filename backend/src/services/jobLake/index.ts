import {
  mergeIntoLake as mergeWithPolicy,
  type LakeJob,
  type LakePolicy,
  type MergeOutcome,
  type SheetRowRef,
} from '../../database/jobLakeRepository';
import type { StoredJobAnalysis } from '../../database/jobAnalysisRepository';
import { analysisFactsOf } from '../jobAnalysis/facts';
import { readLakeSettings } from './settings';

export type { LakeJob, MergeOutcome, MergeStatus } from '../../database/jobLakeRepository';

/**
 * The Job Data Lake's one way in (Phase 7): the reporter run and the
 * administrator's merge both call `mergeIntoLake`, which decides added /
 * replaced / duplicate on the DATABASE alone and pays the reward in the same
 * transaction (database/jobLakeRepository.ts). This module only resolves what
 * the decision depends on - the duplicate window in effect (an
 * administrator's, else .env's, else 60 days) and, for a run that pays, the
 * global rate and the daily cap - from the settings, at the moment of the
 * merge.
 */

/** "Now" for the merge, replaceable by the tests' fake clock. */
let clock: () => number = () => Date.now();

export function setLakeClockForTests(next?: () => number): void {
  clock = next ?? (() => Date.now());
}

export function lakePolicy(options: { reward: boolean; now?: number }): LakePolicy {
  const settings = readLakeSettings();
  return {
    now: options.now ?? clock(),
    windowDays: settings.duplicateWindow.days,
    reward: options.reward
      ? { globalRateMilli: settings.reportRateMilli, dailyCapMilli: settings.dailyCapMilli }
      : null,
  };
}

/**
 * Merges one job. `reward: true` pays the requester for an added or
 * replacing job if they are a reporter (J7); the admin merge passes false, and
 * a build user earns nothing for it (J6).
 */
export function mergeIntoLake(
  job: LakeJob,
  requestedBy: string | null,
  options: { reward: boolean; now?: number }
): MergeOutcome {
  return mergeWithPolicy(job, requestedBy, lakePolicy(options));
}

/**
 * A lake job from a stored analysis: its field, salary, job type, clearance
 * and industry are the analysis's, never the caller's (a reporter cannot hand
 * the lake a field of their own), the posting's text is the one analysed, and
 * the company, title and link are the row's when the caller has one, else
 * what the store recorded. The facts of an analysis stored before they were
 * asked for are derived from what it holds (`analysisFactsOf`) - never asked
 * of a model. A report run names its sheet row too (`reportedFrom`), kept on
 * the report's record.
 */
export function lakeJobFromAnalysis(
  stored: StoredJobAnalysis,
  source: LakeJob['source'],
  row: { company?: string; title?: string; url?: string; reportedFrom?: SheetRowRef } = {}
): LakeJob {
  const company = row.company?.trim() || stored.companyName;
  const title = row.title?.trim() || stored.analysis.jobMeta?.title || '';
  return {
    company,
    jobFieldId: stored.jobFieldId,
    title,
    salary: stored.analysis.salary ?? null,
    url: row.url?.trim() || stored.jobLink || '',
    jobDescription: stored.analysis.sourceJobDescription ?? '',
    analysisId: stored.id,
    source,
    ...analysisFactsOf(stored.analysis),
    ...(row.reportedFrom ? { reportedFrom: row.reportedFrom } : {}),
  };
}
