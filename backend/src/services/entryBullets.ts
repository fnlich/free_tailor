import { resolveRequestedAIModel } from '../config/aiModelConfig';
import { PublicError } from '../middleware/publicError';
import { extractJSON } from '../utils/json';
import { createPromptCompletionResult } from './ai';
import { normalizeSkillsInput } from './profileService';
import { cleanBullets } from './resumeService';

/**
 * Write Entry Bullets: the profile editor's "Write with AI" / "Improve with
 * AI" on one entry - a role, a project or a volunteering entry.
 *
 * Open to every builder and FREE (owner decision): no credit is reserved, as
 * for /resume/analyze and /profiles/upload. It runs the one built-in prompt
 * (`write-entry-bullets`, a single-prompt feature - no variants, no model
 * override) on the app default model, the way the Bid Assistant does, one
 * call per account at a time. The answer is held to the rule a tailoring's
 * bullets are held to (`cleanBullets`), then cut to eight bullets of at most
 * 300 characters. Nothing is written: the editor puts the bullets into its
 * draft, and the person saves or does not.
 *
 * What a refusal may say follows middleware/publicError: every refusal here is
 * about the caller's own entry, so it is specific; a seat failure is one of
 * the four public AI sentences; anything else is the route's generic sentence
 * with a ref.
 */

export type EntryBulletsKind = 'experience' | 'project' | 'volunteering';
export type EntryBulletsTask = 'write' | 'improve';

export const ENTRY_BULLETS_PROMPT_ID = 'write-entry-bullets';
export const ENTRY_BULLETS_KINDS: readonly EntryBulletsKind[] = ['experience', 'project', 'volunteering'];
/** What a tailored resume prints at most, and so what the editor is handed at most. */
export const MAX_ENTRY_BULLETS = 8;
export const MAX_ENTRY_BULLET_LENGTH = 300;
export const MAX_BULLET_INSTRUCTIONS_LENGTH = 500;
const MAX_PROFILE_SUMMARY_LENGTH = 2000;
const MAX_FIELD_LENGTH = 500;

/** The entry as the prompt reads it, whatever kind it is: a title and the organisation it was for. */
export type EntryForBullets = {
  kind: EntryBulletsKind;
  title: string;
  organization: string;
  startDate: string;
  endDate: string;
  location: string;
  description: string;
  bullets: string[];
  skills: string[];
};

export type ProfileForBullets = {
  name: string;
  title: string;
  totalYearsExperience?: number;
  summary: string;
  skills: string[];
};

const text = (value: unknown, max = MAX_FIELD_LENGTH): string =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';
const list = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 50)
    : [];
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const refuse = (message: string, code: string) => new PublicError(message, { status: 400, code });

/**
 * The entry, read by kind: an experience entry names its role as `title` and
 * its employer as `company`; a project is its `name` and `role`; a
 * volunteering entry its `role` and `organization`. Refused by name when the
 * fields that name it are both empty - the model would have nothing to write
 * from, and "Give the role a title" is something the person can act on.
 */
export function readEntryForBullets(kind: unknown, entry: unknown): EntryForBullets {
  if (!ENTRY_BULLETS_KINDS.includes(kind as EntryBulletsKind)) {
    throw refuse('kind must be experience, project or volunteering.', 'bad-kind');
  }
  const source = record(entry);
  const read = (title: string, organization: string): EntryForBullets => ({
    kind: kind as EntryBulletsKind,
    title,
    organization,
    startDate: text(source.startDate, 40),
    endDate: text(source.endDate, 40),
    location: text(source.location),
    description: text(source.description, MAX_PROFILE_SUMMARY_LENGTH),
    bullets: list(source.achievements ?? source.bullets),
    skills: list(source.skills),
  });
  switch (kind as EntryBulletsKind) {
    case 'experience': {
      const read1 = read(text(source.title), text(source.company ?? source.organization));
      if (!read1.title && !read1.organization) {
        throw refuse('Give the role a title or a company before asking for bullets.', 'entry-incomplete');
      }
      return read1;
    }
    case 'project': {
      const read1 = read(text(source.name ?? source.title), text(source.role ?? source.organization));
      if (!read1.title) throw refuse('Give the project a name before asking for bullets.', 'entry-incomplete');
      return read1;
    }
    case 'volunteering': {
      const read1 = read(text(source.role ?? source.title), text(source.organization));
      if (!read1.title && !read1.organization) {
        throw refuse('Give the volunteering entry a role or an organisation before asking for bullets.', 'entry-incomplete');
      }
      return read1;
    }
  }
}

/** Who the entry belongs to, in five fields: never contact details, never the other entries. */
export function readProfileForBullets(profile: unknown): ProfileForBullets {
  const source = record(profile);
  const years = source.totalYearsExperience;
  const parsedYears = typeof years === 'number' ? years : typeof years === 'string' ? Number(years) : NaN;
  return {
    name: text(source.name),
    title: text(source.title),
    ...(Number.isFinite(parsedYears) && parsedYears >= 0 ? { totalYearsExperience: parsedYears } : {}),
    summary: text(source.summary, MAX_PROFILE_SUMMARY_LENGTH),
    skills: normalizeSkillsInput(source.skills).skills.slice(0, 60),
  };
}

export function readBulletsTask(task: unknown, entry: EntryForBullets): EntryBulletsTask {
  if (task !== 'write' && task !== 'improve') throw refuse('task must be write or improve.', 'bad-task');
  if (task === 'improve' && entry.bullets.length === 0) {
    throw refuse('The entry has no bullets to improve yet. Choose Write instead.', 'nothing-to-improve');
  }
  return task;
}

/** The code's sentence for what is asked - a prompt variable, so an administrator's edit can place it. */
export function taskSentence(task: EntryBulletsTask, entry: EntryForBullets): string {
  if (task === 'write') {
    return (
      'Write 3 to 8 new bullets for this entry from the facts in it.' +
      (entry.bullets.length > 0
        ? ' Its current bullets are notes you may draw facts from, but write every bullet afresh.'
        : ' It has no bullets yet.')
    );
  }
  return (
    "Improve the entry's existing bullets: keep every fact and figure, tighten the wording, lead each with a " +
    'strong verb and add nothing that is not in the entry. Return one improved bullet for each existing ' +
    'bullet, in the same order, merging two only when they say the same thing, and never fewer than 3 when ' +
    'the entry has 3 or more.'
  );
}

export function readBulletInstructions(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, MAX_BULLET_INSTRUCTIONS_LENGTH) : '';
}

/**
 * The prompt's values: exactly `entryJson`, `profileJson`, `task` and
 * `instructions` - the variables PROMPT_FEATURES declares for the feature
 * (test/promptVariables.test.js holds the two lists equal). Every variable
 * has a value, '' included: a rendered record is refused only over an ABSENT
 * one.
 */
export function buildWriteEntryBulletsPromptValues(
  entry: EntryForBullets,
  profile: ProfileForBullets,
  task: EntryBulletsTask,
  instructions: string
): Record<string, string> {
  return {
    entryJson: JSON.stringify(entry),
    profileJson: JSON.stringify(profile),
    task: taskSentence(task, entry),
    instructions,
  };
}

/** A model's bullets, as the editor may show them: the tailoring's rule, then one line each, at most eight. */
export function finishBullets(raw: unknown): string[] {
  return cleanBullets(raw)
    .map((bullet) =>
      bullet
        .replace(/^[-*•]\s*/, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_ENTRY_BULLET_LENGTH)
        .trim()
    )
    .filter(Boolean)
    .slice(0, MAX_ENTRY_BULLETS);
}

/** The accounts with a call running; a second call for the same account is refused, not queued. */
const inFlight = new Set<string>();

export function resetEntryBulletsForTests(): void {
  inFlight.clear();
}

export type WriteEntryBulletsInput = {
  accountId: string;
  kind: unknown;
  entry: unknown;
  profile: unknown;
  task: unknown;
  instructions: unknown;
  signal?: AbortSignal;
};

export async function writeEntryBullets(input: WriteEntryBulletsInput): Promise<string[]> {
  const entry = readEntryForBullets(input.kind, input.entry);
  const task = readBulletsTask(input.task, entry);
  const profile = readProfileForBullets(input.profile);
  const instructions = readBulletInstructions(input.instructions);

  if (inFlight.has(input.accountId)) {
    throw new PublicError(
      'A Write with AI request is already running for your account. Wait for it to finish, then try again.',
      { status: 409, code: 'already-running' }
    );
  }
  inFlight.add(input.accountId);
  try {
    // The app default model, as every call that names none runs on (the Bid
    // Assistant's rule). AiUnavailableError passes through as its public 503.
    const model = await resolveRequestedAIModel();
    const result = await createPromptCompletionResult({
      promptId: ENTRY_BULLETS_PROMPT_ID,
      callSite: ENTRY_BULLETS_PROMPT_ID,
      promptValues: buildWriteEntryBulletsPromptValues(entry, profile, task, instructions),
      fallbackProvider: model.provider,
      fallbackModelName: model.modelName,
      maxTokens: 1200,
      temperature: 0.3,
      responseFormat: 'json',
      useExactPromptId: true,
      runChoiceWins: true,
      signal: input.signal,
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJSON(result.text));
    } catch (error) {
      throw new Error(`The model's answer was not JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const bullets = record(parsed).bullets;
    if (!Array.isArray(bullets)) throw new Error('The model answered without a bullets list');
    const finished = finishBullets(bullets);
    if (finished.length === 0) throw new Error('The model answered with no usable bullets');
    return finished;
  } finally {
    inFlight.delete(input.accountId);
  }
}
