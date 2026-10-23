import { recordedRunFilePaths } from '../../database/orderRepository';
import type { GeneratedPathInfo } from '../../utils/generatedPath';

/**
 * Two resumes of one run never share a file.
 *
 * A run's folder is its own - the prefix holds its order number - but inside
 * it the account's folder path and the resume's file-name templates decide,
 * and the default folder path (`/{{date}}/{{profile_name}}/{{company_name}}/
 * {{role}}`) renders ONE folder for two postings with one title at one
 * company: rows 5 and 9 of a sheet, say. The generators write with
 * `fs.writeFile`, so the second resume replaced the first, and both items
 * recorded - and downloaded - the second.
 *
 * So a task claims its file stems before it writes. When another task of the
 * run has claimed the same folder and stem in this process, or recorded it on
 * its order item (before a restart), this one's resume and cover letter stems
 * both get `_2`, else `_3`, and so on: the first number free. Claims are keyed
 * by the task's place in its batch, so a retry - and a restored task, which
 * keeps its place - finds its own claim and keeps its name. Forgotten when the
 * batch finishes (queue/index.ts's `batchFinished` hook).
 */
const claims = new Map<string, Map<string, number>>();

/** A stem's key: its folder and name, '/'-separated, case folded (Windows and macOS fold it too). */
function stemKey(folder: string, stem: string): string {
  return [folder, stem].filter(Boolean).join('/').toLowerCase();
}

/** A recorded file's key: its path without the extension. */
function recordedKey(recorded: string): string {
  const spelled = recorded.replace(/\\/g, '/');
  const name = spelled.slice(spelled.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return (dot > 0 ? spelled.slice(0, spelled.length - (name.length - dot)) : spelled).toLowerCase();
}

/**
 * `info` with stems no other resume of the run has, claimed for the task at
 * `seq` of `batchId`. `recorded` lists what the run's OTHER items recorded
 * (by default, from the order rows).
 */
export function claimRunFileStems(
  batchId: string,
  seq: number,
  info: GeneratedPathInfo,
  recorded: () => readonly string[] = () => recordedRunFilePaths(batchId, seq)
): GeneratedPathInfo {
  const resumeStem = info.resumeFileStem || info.resumeSlug;
  const coverStem = info.coverLetterFileStem || `${info.resumeSlug}_cover_letter`;
  let batchClaims = claims.get(batchId);
  if (!batchClaims) {
    batchClaims = new Map();
    claims.set(batchId, batchClaims);
  }
  const elsewhere = new Set(recorded().map(recordedKey));

  for (let number = 1; ; number += 1) {
    const tag = number === 1 ? '' : `_${number}`;
    const keys = [stemKey(info.storagePathBase, resumeStem + tag), stemKey(info.storagePathBase, coverStem + tag)];
    const free = keys.every((key) => {
      const owner = batchClaims!.get(key);
      return (owner === undefined || owner === seq) && !elsewhere.has(key);
    });
    if (!free) continue;
    for (const key of keys) batchClaims.set(key, seq);
    return number === 1
      ? info
      : { ...info, resumeFileStem: resumeStem + tag, coverLetterFileStem: coverStem + tag };
  }
}

/** The run is over: nothing of it writes again. */
export function forgetRunFileClaims(batchId: string): void {
  claims.delete(batchId);
}
