import path from 'path';

import { getOutputStorageSettings } from '../config/aiModelConfig';
import { envOutputPathPrefix, envOutputPathSuffix } from '../config/settingDefaults';
import { findOrderForBatch } from '../database/orderRepository';
import { listProfilesFor } from '../database/profileRepository';
import { getOutputPathSuffix, getUserById, setOutputPathSuffix } from '../database/userRepository';
import type { UserAccount } from '../types/account';
import { accountFolderName, type RunOutputPlace } from '../utils/generatedPath';
import {
  normalizeOutputBaseDir,
  outputDateText,
  outputSuffixNotes,
  renderOutputPath,
  renderOutputPrefix,
  requireValidOutputPath,
  sampleOutputPathValues,
  validateOutputPrefix,
  validateOutputSuffix,
} from '../utils/outputStorage';

/**
 * Where a resume is filed, as accounts and runs ask it (owner decisions O1-O3):
 * `<output folder>/<the administrator's prefix>/<the account's own folder
 * path>/<file>`. The rules and the rendering are utils/outputStorage.ts's;
 * this is the account's half - its stored folder path, where the one in
 * effect came from, the previews - and the one place a run's folder is
 * worked out when it is submitted.
 */

/** Where an account's folder path in effect came from: its own, `.env`'s `OUTPUT_PATH_SUFFIX`, or the code's. */
export type OutputPathSuffixSource = 'account' | 'env' | 'default';

/** What GET and PUT /api/auth/account carry about an account's folder path (a builder's only). */
export type AccountOutputPath = {
  /** The account's own, canonical, or null when it has set none. */
  outputPathSuffix: string | null;
  outputPathSuffixSource: OutputPathSuffixSource;
  /** The folder path its runs use: its own, else the default. */
  effectiveOutputPathSuffix: string;
  /** What Reset to default gives: `OUTPUT_PATH_SUFFIX`, else the code's. */
  defaultOutputPathSuffix: string;
};

/** A preview: the path, or every sentence about why there is none; and advice that refuses nothing. */
export type OutputPathPreview = { path: string | null; problems: string[]; notes: string[] };

const warnedStoredSuffixes = new Set<string>();

/**
 * The account's stored folder path, checked. One that no longer passes - typed
 * into the database by hand, or saved under rules since tightened - is not
 * used: its runs are filed under the default, and the log says so once.
 */
function storedSuffix(userId: string): string | null {
  const raw = getOutputPathSuffix(userId);
  if (raw === null) return null;
  const check = validateOutputSuffix(raw);
  if (check.ok) return check.value;
  const key = `${userId}\u0000${raw}`;
  if (!warnedStoredSuffixes.has(key)) {
    warnedStoredSuffixes.add(key);
    console.warn(
      `[output] The folder path saved for account ${userId} is refused (${check.problems.join(' ')}); ` +
        'its runs are filed under the default until it is saved again.'
    );
  }
  return null;
}

/** The account's folder path, the one in effect and where it came from. */
export function describeAccountOutputPath(userId: string): AccountOutputPath {
  const fallback = envOutputPathSuffix();
  const own = storedSuffix(userId);
  return {
    outputPathSuffix: own,
    outputPathSuffixSource: own !== null ? 'account' : fallback.fromEnv ? 'env' : 'default',
    effectiveOutputPathSuffix: own ?? fallback.value,
    defaultOutputPathSuffix: fallback.value,
  };
}

/** The folder path an account's runs are filed under now. */
export function effectiveOutputPathSuffix(userId: string): string {
  return describeAccountOutputPath(userId).effectiveOutputPathSuffix;
}

/** `null` or an empty text: Reset to default. */
function isReset(value: unknown): boolean {
  return value === null || (typeof value === 'string' && value.trim() === '');
}

/**
 * PUT /api/auth/account's `outputPathSuffix`: checked (an `OutputPathError`,
 * 400 with `field`, naming what is wrong) and stored in its canonical spelling;
 * `''` or `null` clears it, so the default applies again. Runs already
 * submitted keep the folder path they were placed with.
 */
export function saveAccountOutputPathSuffix(userId: string, value: unknown): AccountOutputPath {
  setOutputPathSuffix(userId, isReset(value) ? null : requireValidOutputPath('suffix', value));
  return describeAccountOutputPath(userId);
}

function sampleValuesFor(account: UserAccount) {
  return sampleOutputPathValues({
    email: account.email,
    profileName: listProfilesFor(account)[0]?.name ?? null,
  });
}

/**
 * POST /api/auth/output-path/preview: where a resume of the asker's would be
 * filed with this folder path - `/<prefix>/<folder path>`, rendered by the
 * same function a run uses, with their own email, a sample order number and
 * today's date, their first profile's name (else "Sample Profile") and a
 * made-up job. Without `outputPathSuffix` it is the one in effect; with
 * `''` or `null`, the default. Not the output folder: that is a path on the
 * server, the administrator's business.
 */
export async function previewAccountOutputPath(
  account: UserAccount,
  body: { outputPathSuffix?: unknown }
): Promise<OutputPathPreview> {
  const { outputPathPrefix } = await getOutputStorageSettings();
  const own = describeAccountOutputPath(account.id);
  let suffix = own.effectiveOutputPathSuffix;
  if (Object.prototype.hasOwnProperty.call(body, 'outputPathSuffix')) {
    if (isReset(body.outputPathSuffix)) {
      suffix = own.defaultOutputPathSuffix;
    } else {
      const check = validateOutputSuffix(body.outputPathSuffix);
      if (!check.ok) return { path: null, problems: check.problems, notes: [] };
      suffix = check.value;
    }
  }
  return {
    path: `/${renderOutputPath(outputPathPrefix, suffix, sampleValuesFor(account))}`,
    problems: [],
    notes: outputSuffixNotes(suffix),
  };
}

/**
 * POST /api/admin/output-path/preview: where a resume would be filed with this
 * prefix and the default folder path, under the output folder - the whole
 * path on the server, for the administrator. Without `outputPathPrefix` it is
 * the one in effect; with `null`, what Reset to default gives. `outputBaseDir`,
 * when given, is an output folder typed but not saved yet, read as a save
 * would store it; without it, the one in effect.
 */
export async function previewOutputPrefix(
  account: UserAccount,
  body: { outputPathPrefix?: unknown; outputBaseDir?: unknown }
): Promise<OutputPathPreview> {
  const settings = await getOutputStorageSettings();
  const outputBaseDir =
    typeof body.outputBaseDir === 'string' && body.outputBaseDir.trim()
      ? normalizeOutputBaseDir(body.outputBaseDir)
      : settings.outputBaseDir;
  let prefix = settings.outputPathPrefix;
  if (Object.prototype.hasOwnProperty.call(body, 'outputPathPrefix')) {
    if (body.outputPathPrefix === null) {
      prefix = envOutputPathPrefix().value;
    } else {
      const check = validateOutputPrefix(body.outputPathPrefix);
      if (!check.ok) return { path: null, problems: check.problems, notes: [] };
      prefix = check.value;
    }
  }
  const relative = renderOutputPath(prefix, envOutputPathSuffix().value, sampleValuesFor(account));
  return { path: path.join(outputBaseDir, ...relative.split('/')), problems: [], notes: [] };
}

/** Where a run about to be placed files its resumes, once its order has a number. */
export type RunOutputPlan = {
  /** `<output folder>/<rendered prefix>`: the order's `output_root`. */
  rootFor: (orderNumber: string) => string;
  /** What every task of the run carries (`ResumeTaskPayload.output`). */
  placeFor: (orderNumber: string) => RunOutputPlace;
};

/**
 * A run's place, worked out ONCE, when it is submitted: the output folder and
 * the prefix in effect, the submitter's folder path, and the day. The order's
 * number - which the prefix holds - is issued inside its insert
 * (database/orderRepository.ts `createOrder`), so the plan is a function of it.
 */
export async function planRunOutput(account: UserAccount, at: Date = new Date()): Promise<RunOutputPlan> {
  const { outputBaseDir, outputPathPrefix } = await getOutputStorageSettings();
  const date = outputDateText(at);
  const suffix = effectiveOutputPathSuffix(account.id);
  const accountName = accountFolderName(account);
  const prefixFor = (orderNumber: string): string =>
    renderOutputPrefix(outputPathPrefix, { user_email: accountName, order_number: orderNumber, date });
  return {
    rootFor: (orderNumber) => path.join(outputBaseDir, ...prefixFor(orderNumber).split('/')),
    placeFor: (orderNumber) => ({
      baseDir: outputBaseDir,
      prefix: prefixFor(orderNumber),
      suffix,
      date,
      accountName,
      orderNumber,
    }),
  };
}

/**
 * The place of a run a task names only by its batch: one queued before runs
 * carried their place (`ResumeTaskPayload.output`), restored after the
 * upgrade. Worked out from its order - its number, its account, the day it
 * was placed - so it still lands in a folder of its own rather than in one
 * every such run shares. Its recorded folder (`output_root`, which migration
 * 10 gives it from the files it recorded) is reused when it lies in the
 * output folder in effect, so the rest of the run joins the files it already
 * wrote. Null with no order to read: then the settings in effect decide.
 */
export async function placeOfPlacedRun(batchId: string): Promise<RunOutputPlace | null> {
  const order = findOrderForBatch(batchId);
  if (!order) return null;
  const account = getUserById(order.userId);
  const { outputBaseDir, outputPathPrefix } = await getOutputStorageSettings();
  const placedAt = new Date(order.createdAt);
  const date = outputDateText(Number.isNaN(placedAt.getTime()) ? new Date() : placedAt);
  const accountName = accountFolderName(account);
  const recorded = order.outputRoot ? path.relative(outputBaseDir, order.outputRoot) : '';
  const prefix =
    recorded && !recorded.startsWith('..') && !path.isAbsolute(recorded)
      ? recorded.split(path.sep).join('/')
      : renderOutputPrefix(outputPathPrefix, { user_email: accountName, order_number: order.number, date });
  return {
    baseDir: outputBaseDir,
    prefix,
    suffix: account ? effectiveOutputPathSuffix(account.id) : envOutputPathSuffix().value,
    date,
    accountName,
    orderNumber: order.number,
  };
}
