import { createHash } from 'crypto';
import { isJobFieldId } from '../../config/jobFields';

/**
 * What makes two jobs the SAME job in the Job Data Lake (owner decisions J2a,
 * J3): the company, compared loosely, and the job field, by its stable id.
 *
 * Not the posting's identity - that is services/jobAnalysis/identity.ts, by
 * link or text, and decides whether a posting is analysed. This one decides
 * whether a job the lake already holds is being reported again, and it can
 * only be computed AFTER the analysis, because the field comes from it.
 *
 * The real values are stored unchanged beside the hash; the hash is an
 * identity and nothing else, never shown as a name.
 *
 * VERSIONED. The steps below and the suffix list are version
 * `JOB_LAKE_HASH_VERSION`, which goes into the hash and onto every lake row
 * (`hash_version`). Changing either - one more suffix, a different treatment
 * of `&` - is a NEW version, never an edit of this one: an edit would move
 * every company it touched to another hash and silently split their stored
 * jobs from the ones reported next. A new version comes with a deliberate
 * re-hash of the rows on the old one.
 */

export const JOB_LAKE_HASH_VERSION = 1;

/**
 * Version 1's legal suffixes, written as they read AFTER punctuation is gone
 * ("S.A." is `sa`, "L.L.C." is `llc`, "S.p.A." is `spa`). A suffix is a whole
 * trailing word or words: "Visa" keeps its `sa`, "Acme Co" loses its `co`.
 *
 * Multi-word ones are listed whole so "Pty Ltd" and "Co., Ltd." go together,
 * and the stripping repeats - "Acme Holdings Co., Ltd." is `acmeholdings` -
 * but never strips a name to nothing: a company called just "Company" stays
 * `company`.
 *
 * Not "Group", "Holdings", "Labs" or "Technologies": those are part of what
 * a company is called, and "Acme Labs" is not "Acme" (the owner's own case).
 */
export const LEGAL_SUFFIXES_V1: readonly string[] = [
  'incorporated',
  'inc',
  'llc',
  'l l c',
  'llp',
  'lllp',
  'pllc',
  'lp',
  'ltd',
  'limited',
  'corp',
  'corporation',
  'co',
  'company',
  'pc',
  'plc',
  'gmbh',
  'gmbh co kg',
  'co kg',
  'kg',
  'ag',
  'se',
  'sa',
  'sas',
  'sarl',
  'srl',
  'spa',
  'sl',
  'bv',
  'nv',
  'oy',
  'oyj',
  'ab',
  'as',
  'asa',
  'aps',
  'kk',
  'pty',
  'pty ltd',
  'pte',
  'pte ltd',
  'sdn bhd',
  'bhd',
  'ulc',
  'co ltd',
];

/** Longest first, so "pty ltd" is taken whole before "ltd" alone. */
const SUFFIXES_BY_LENGTH = [...LEGAL_SUFFIXES_V1].sort((a, b) => b.length - a.length);

/**
 * A company name as version 1 compares it (J2a):
 *
 *  1. symbols dropped (`™`, `®`, `©`...) - first, because NFKC would spell
 *     `™` as the letters TM and glue them to the name;
 *  2. Unicode NFKC, so a full-width or ligatured spelling is the plain one;
 *  3. lower case;
 *  4. punctuation dropped: a full stop or an apostrophe with nothing in its
 *     place, since it sits inside an abbreviation or a word ("S.A." is `sa`,
 *     "Macy's" is `macys`); any other mark as a space, since it separates
 *     words ("Acme,Inc." is `acme inc`, "AT&T" is `at t`);
 *  5. a trailing legal suffix dropped, repeatedly, never to nothing;
 *  6. every space removed (`Open AI` is `openai`).
 *
 * '' for a name with nothing left - which has no hash, so is never merged.
 */
export function normaliseCompany(name: unknown): string {
  if (typeof name !== 'string') return '';
  const words = name
    .replace(/\p{S}/gu, ' ')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[.'\u2018\u2019]/g, '')
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!words) return '';

  let rest = words;
  for (let stripped = true; stripped; ) {
    stripped = false;
    for (const suffix of SUFFIXES_BY_LENGTH) {
      if (rest.endsWith(` ${suffix}`)) {
        rest = rest.slice(0, rest.length - suffix.length - 1).trimEnd();
        stripped = true;
        break;
      }
    }
  }
  return rest.replace(/\s+/g, '');
}

/** The lake identity of a job: its hash, the version that made it, and the company as compared. */
export type LakeIdentity = {
  hash: string;
  hashVersion: number;
  companyKey: string;
  jobFieldId: string;
};

/**
 * SHA-256, hex, of `v<version> \0 companyKey \0 jobFieldId` - the null
 * separators so no company can run into a field id - or null when the job
 * has no identity: no company left after normalising, or a job field that is
 * not one of the list's (`unclassified` included). Such a job is never merged
 * into the lake and never paid for (J2a, J3).
 */
export function lakeIdentity(company: unknown, jobFieldId: unknown): LakeIdentity | null {
  const companyKey = normaliseCompany(company);
  if (!companyKey || !isJobFieldId(jobFieldId)) return null;
  const hash = createHash('sha256')
    .update(`v${JOB_LAKE_HASH_VERSION}\u0000${companyKey}\u0000${jobFieldId}`, 'utf8')
    .digest('hex');
  return { hash, hashVersion: JOB_LAKE_HASH_VERSION, companyKey, jobFieldId };
}

/** Just the hash, or null - what a sheet's Job Hash cell shows. */
export function jobHash(company: unknown, jobFieldId: unknown): string | null {
  return lakeIdentity(company, jobFieldId)?.hash ?? null;
}
