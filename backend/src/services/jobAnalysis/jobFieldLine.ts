import { renderJobFieldListForPrompt } from '../../config/jobFields';

/**
 * How a posting's job field is asked for: by the CODE, on the job facts call
 * (the Job Facts (Filter) prompt, the second call of the one analysis -
 * services/jobAnalysis/gate.ts).
 *
 * The owner's facts prompt asks for job type, clearance, salary and the rest
 * and says nothing of a job field, and the job field is what files a job in
 * the Job Data Lake for ever (a field is part of its identity, and
 * `unclassified` keeps it out). So the code asks for it itself, in two pieces
 * no edit of the prompt can drop:
 *
 * - `JOB_FIELD_PREAMBLE`, placed BEFORE the record's own stable part
 *   (`systemPreamble`, services/ai/promptExecution.ts): the closed list, one
 *   `id: Label (what it covers)` line per field under its area. The same text
 *   for every posting, so it is cached with the rest of the system part - the
 *   list is some 8 KB, and a seat's rate limits count every uncached token.
 * - `JOB_FIELD_REMINDER`, one line appended AFTER the posting
 *   (`appendToUserBody`): the prompt's own OUTPUT FORMAT ends "Return ONLY the
 *   JSON object below" with eight keys, so the last thing the model reads has
 *   to say there is a ninth.
 *
 * Both are constants of this build, and part of the analysis's audit hash
 * (`prompt_hash`), so a change here is told apart from a change of the
 * prompts. The answer is checked against the list in code
 * (`normalizeJobFieldId`); an answer with no job field at all is asked once
 * more before it is stored as `unclassified`.
 */

export const JOB_FIELD_PREAMBLE = [
  'ONE MORE FIELD. Besides the fields the instructions below ask for, the JSON object carries "job_field": ' +
    'exactly ONE id from the JOB FIELDS list - the field the job is mostly about. Write the id (the text before ' +
    'the colon), never the label. "unclassified" when none fits.',
  '',
  'JOB FIELDS (id: label):',
  renderJobFieldListForPrompt(),
].join('\n');

export const JOB_FIELD_REMINDER =
  'Also return "job_field" in the same JSON object: one id from the JOB FIELDS list.';
