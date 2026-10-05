import {
  countMergeableAnalyses,
  getJobAnalysisById,
  listMergeableAnalyses,
  type StoredJobAnalysis,
} from '../../database/jobAnalysisRepository';
import { jobFieldLabel } from '../../config/jobFields';
import type { JobSalary } from '../../types/template';
import { requestAdminLakeSync } from './adminSheet';
import { lakeJobFromAnalysis, mergeIntoLake, type MergeStatus } from './index';

/**
 * The administrator's merge (owner decision J6): jobs that builds analysed
 * - stored, analysed, not merged yet - into the lake. It reads the DATABASE
 * list (`job_analyses`), never a sheet and never a model; every job goes
 * through the same `mergeIntoLake` as a report, with `requested_by` the
 * account whose build produced the analysis and NO reward: a build user earns
 * nothing for it. A posting with no job field from the list, or no company
 * on record to hash the job on, is never offered.
 */

export type MergeCandidate = {
  analysisId: string;
  company: string;
  jobFieldId: string;
  jobFieldLabel: string;
  title: string;
  salary: JobSalary | null;
  url: string;
  /** The account whose build produced the analysis: `requested_by` once merged. */
  createdBy: string | null;
  createdAt: string;
};

function candidateOf(stored: StoredJobAnalysis): MergeCandidate {
  return {
    analysisId: stored.id,
    company: stored.companyName,
    jobFieldId: stored.jobFieldId,
    jobFieldLabel: jobFieldLabel(stored.jobFieldId),
    title: stored.analysis.jobMeta?.title ?? '',
    salary: stored.analysis.salary ?? null,
    url: stored.jobLink,
    createdBy: stored.createdBy,
    createdAt: stored.createdAt,
  };
}

/** A page of what the merge tab offers, oldest first, and how many there are. */
export function listMergeCandidates(limit: number, offset: number): { rows: MergeCandidate[]; total: number } {
  return { rows: listMergeableAnalyses(limit, offset).map(candidateOf), total: countMergeableAnalyses() };
}

/** Most analyses merged by one "Merge all": a bigger backlog is finished by pressing it again. */
export const MERGE_ALL_LIMIT = 1000;

export type MergeResult = {
  analysisId: string;
  status: MergeStatus | 'not-found' | 'merged-before' | 'not-offered';
  lakeId: number | null;
  jobHash: string | null;
};

export type MergeReport = {
  /** Analyses taken to the lake in this call. */
  merged: number;
  /** Of those, added as new jobs - or replacing an older duplicate, which counts as added. */
  added: number;
  replaced: number;
  duplicates: number;
  /** Named but not mergeable: unknown, merged before, unclassified, or no company. */
  skipped: number;
  /** What the merge tab still offers afterwards. */
  remaining: number;
  results: MergeResult[];
};

function mergeOne(stored: StoredJobAnalysis): MergeResult {
  const outcome = mergeIntoLake(lakeJobFromAnalysis(stored, 'merge'), stored.createdBy, { reward: false });
  return { analysisId: stored.id, status: outcome.status, lakeId: outcome.lakeId, jobHash: outcome.jobHash };
}

/**
 * Merges the named analyses, or - `all` - everything the tab offers, up to
 * `MERGE_ALL_LIMIT`. Synchronous: no model, no sheet, one transaction per
 * job. The admin sheet's sync is started afterwards for whatever was added.
 */
export function mergeAnalyses(input: { analysisIds?: string[]; all?: boolean }): MergeReport {
  const results: MergeResult[] = [];
  if (input.all) {
    // A merged analysis leaves the list; one the lake turned away (a company
    // that is all punctuation, a retired field) stays in it, ahead of the
    // rest in the list's order - so the next page starts after those.
    let stayed = 0;
    while (results.length < MERGE_ALL_LIMIT) {
      const page = listMergeableAnalyses(Math.min(200, MERGE_ALL_LIMIT - results.length), stayed);
      if (page.length === 0) break;
      for (const stored of page) {
        const result = mergeOne(stored);
        if (result.status === 'unclassified' || result.status === 'no-company') stayed += 1;
        results.push(result);
      }
    }
  } else {
    for (const id of new Set(input.analysisIds ?? [])) {
      const stored = getJobAnalysisById(id);
      if (!stored) results.push({ analysisId: id, status: 'not-found', lakeId: null, jobHash: null });
      else if (stored.mergedAt) results.push({ analysisId: id, status: 'merged-before', lakeId: null, jobHash: null });
      else if (!stored.companyName) results.push({ analysisId: id, status: 'not-offered', lakeId: null, jobHash: null });
      else results.push(mergeOne(stored));
    }
  }

  const count = (...statuses: MergeResult['status'][]) => results.filter((result) => statuses.includes(result.status)).length;
  const report: MergeReport = {
    merged: count('added', 'replaced', 'duplicate', 'already'),
    added: count('added', 'replaced'),
    replaced: count('replaced'),
    duplicates: count('duplicate', 'already'),
    skipped: count('not-found', 'merged-before', 'not-offered', 'unclassified', 'no-company'),
    remaining: countMergeableAnalyses(),
    results,
  };
  if (report.added > 0) requestAdminLakeSync('a merge');
  return report;
}
