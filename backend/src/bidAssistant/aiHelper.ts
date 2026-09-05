import { createRawCompletion } from '../services/ai';
import { extractJSON } from '../utils/json';

/**
 * Answer generation for the bid assistant.
 *
 * Ported from `aiHelper.js`, which POSTed to openrouter.ai directly with its
 * own `process.env.OPENROUTER_API_KEY` read - bypassing the app's provider
 * settings, key store, concurrency limit and error taxonomy entirely. It now
 * runs on the shared transport like everything else.
 *
 * Its prompt template still lives in its own setting (`ask_ai_prompt_template`)
 * rather than in `promptService`, which is deliberate for this change: the two
 * stores use different variable syntaxes and merging them is a separate piece
 * of work. That separation is also what makes this the one legitimate place to
 * use native JSON-schema enforcement - the schema is generated from runtime
 * data by code, so no admin edit can put it out of step with the prompt.
 */

export type BidProfile = {
  id?: string;
  name?: string;
  summary?: string;
  skills?: unknown;
  experience?: unknown;
  education?: unknown;
};

export type BidQuestionInput = {
  question: string;
  charLimit?: number | string;
  questionIndex?: number;
};

type NormalizedQuestion = {
  questionId: string;
  questionIndex: number;
  question: string;
  charLimit: number;
};

function getProfileSkills(profile: BidProfile): string {
  if (!Array.isArray(profile?.skills)) {
    return '';
  }
  return profile.skills
    .map((skill) => (typeof skill === 'string' ? skill : (skill as { name?: string })?.name || ''))
    .filter(Boolean)
    .join(', ');
}

function joinEntries(value: unknown, fields: string[]): string {
  if (typeof value === 'string') {
    return value;
  }
  if (!Array.isArray(value)) {
    return '';
  }
  return value
    .map((item) =>
      fields
        .map((field) => (item as Record<string, unknown>)?.[field])
        .filter(Boolean)
        .join(' | ')
    )
    .filter(Boolean)
    .join('\n');
}

function getDefaultPromptTemplate(): string {
  return `
Candidate:
- Name: {{candidateName}}
- Skills: {{candidateSkills}}
- Experience: {{candidateExperience}}
- Education: {{candidateEducation}}
- Summary: {{candidateSummary}}

Job:
- Title: {{jobTitle}}
- Company: {{companyName}}
- Description: {{jobDescription}}

Question: {{question}}

Write a professional, natural-sounding answer from the candidate's perspective.
Keep it under {{charLimit}} characters.
Avoid corporate buzzwords and make it sound like a real person.
`;
}

function getProfilePromptData(profile: BidProfile): Record<string, string> {
  return {
    profileId: profile?.id || '',
    candidateName: profile?.name || 'Candidate',
    candidateSkills: getProfileSkills(profile),
    candidateExperience: joinEntries(profile?.experience, ['title', 'company', 'startDate', 'endDate']),
    candidateEducation: joinEntries(profile?.education, ['degree', 'institution', 'startDate', 'endDate']),
    candidateSummary: profile?.summary || '',
  };
}

function findAnswerInArray(items: unknown, profileId: string, questionId: string): string | null {
  if (!Array.isArray(items)) {
    return null;
  }

  const idOf = (item: unknown, ...keys: string[]): string => {
    const record = item as Record<string, unknown> | null;
    for (const key of keys) {
      const value = record?.[key];
      if (value !== undefined && value !== null) {
        return `${value}`;
      }
    }
    return '';
  };

  const directItem = items.find(
    (item) => idOf(item, 'profileId', 'profile_id') === profileId && idOf(item, 'questionId', 'question_id') === questionId
  ) as { answer?: unknown } | undefined;
  if (typeof directItem?.answer === 'string') {
    return directItem.answer;
  }

  const profileItem = items.find((item) => idOf(item, 'profileId', 'profile_id') === profileId) as
    | { answers?: unknown }
    | undefined;
  const nestedAnswers = profileItem?.answers;

  if (Array.isArray(nestedAnswers)) {
    const nestedItem = nestedAnswers.find((item) => idOf(item, 'questionId', 'question_id') === questionId) as
      | { answer?: unknown }
      | undefined;
    return typeof nestedItem?.answer === 'string' ? nestedItem.answer : null;
  }

  if (nestedAnswers && typeof nestedAnswers === 'object') {
    const value = (nestedAnswers as Record<string, unknown>)[questionId];
    if (typeof value === 'string') {
      return value;
    }
  }

  return null;
}

/**
 * Reads one answer out of the model's response.
 *
 * Deliberately tolerant of four shapes. Even with a schema enforced by the
 * provider, the older shapes remain reachable through a provider whose
 * capabilities do not include schema enforcement.
 */
export function getGeneratedAnswer(parsedResponse: unknown, profileId: string, questionId: string): string | null {
  const root = parsedResponse as { answers?: unknown; profiles?: unknown } | null;
  const answers = root?.answers ?? parsedResponse;

  if (answers && typeof answers === 'object' && !Array.isArray(answers)) {
    const profileAnswers = (answers as Record<string, unknown>)[profileId];

    if (profileAnswers && typeof profileAnswers === 'object' && !Array.isArray(profileAnswers)) {
      const value = (profileAnswers as Record<string, unknown>)[questionId];
      if (typeof value === 'string') {
        return value;
      }
    }

    if (Array.isArray(profileAnswers)) {
      const questionAnswer = profileAnswers.find(
        (item) => `${(item as Record<string, unknown>)?.questionId ?? (item as Record<string, unknown>)?.question_id ?? ''}` === questionId
      ) as { answer?: unknown } | undefined;
      return typeof questionAnswer?.answer === 'string' ? questionAnswer.answer : null;
    }
  }

  if (Array.isArray(answers)) {
    return findAnswerInArray(answers, profileId, questionId);
  }

  if (Array.isArray(root?.profiles)) {
    return findAnswerInArray(root.profiles, profileId, questionId);
  }

  return null;
}

export function buildBatchPrompt(
  profiles: BidProfile[],
  jobTitle: string,
  companyName: string,
  jobDescription: string,
  questions: NormalizedQuestion[],
  promptTemplate?: string
): string {
  const profileData = profiles.map(getProfilePromptData);
  const questionData = questions.map((item) => ({
    questionId: item.questionId,
    question: item.question,
    charLimit: item.charLimit,
  }));
  const answerPromptTemplate = promptTemplate?.trim() || getDefaultPromptTemplate();

  return `Generate job application answers for every profile and every question in one batch.

Use the editable per-answer prompt template as the content and style instruction for each individual answer.
Apply its placeholders using the matching profile, this one job, and the matching question.
If the template says to return only answer text, that applies to each answer string inside the JSON response.

Return valid JSON only, with this exact top-level shape:
{
  "answers": {
    "<profileId>": {
      "<questionId>": "<answer text>"
    }
  }
}

Every profile must have one answer for every question.
Keep each answer under that question's charLimit.
Do not include markdown, explanations, or extra fields.

Editable per-answer prompt template:
${JSON.stringify(answerPromptTemplate)}

Job:
${JSON.stringify(
    {
      jobTitle: jobTitle || '',
      companyName: companyName || '',
      jobDescription: jobDescription || '',
    },
    null,
    2
  )}

Profiles:
${JSON.stringify(profileData, null, 2)}

Questions:
${JSON.stringify(questionData, null, 2)}`;
}

export function buildAnswersJsonSchema(
  profiles: BidProfile[],
  questions: NormalizedQuestion[]
): Record<string, unknown> {
  const questionProperties: Record<string, unknown> = {};
  const requiredQuestionIds = questions.map((question) => question.questionId);

  for (const question of questions) {
    questionProperties[question.questionId] = {
      type: 'string',
      description: `Answer for ${question.questionId}. Keep it under ${question.charLimit} characters.`,
    };
  }

  const profileProperties: Record<string, unknown> = {};
  const requiredProfileIds = profiles.map((profile) => `${profile?.id || ''}`);

  for (const profileId of requiredProfileIds) {
    profileProperties[profileId] = {
      type: 'object',
      additionalProperties: false,
      required: requiredQuestionIds,
      properties: questionProperties,
    };
  }

  return {
    type: 'object',
    additionalProperties: false,
    required: ['answers'],
    properties: {
      answers: {
        type: 'object',
        additionalProperties: false,
        required: requiredProfileIds,
        properties: profileProperties,
      },
    },
  };
}

function normalizeQuestions(questions: BidQuestionInput[]): NormalizedQuestion[] {
  return questions.map((item, index) => {
    const questionIndex = Number.isInteger(item?.questionIndex) ? (item.questionIndex as number) : index;
    return {
      questionId: `q${questionIndex}`,
      questionIndex,
      question: item.question,
      charLimit: Number(item.charLimit) || 500,
    };
  });
}

const SYSTEM_PROMPT = 'You are a job application assistant. Return valid JSON only.';

/**
 * One model call for every profile and every question.
 *
 * Batched on purpose: a per-profile-per-question loop would be P x Q calls,
 * and on a provider that spawns a process per call that is the difference
 * between one request and thirty.
 */
export async function generateAnswers(
  profiles: BidProfile[],
  jobTitle: string,
  companyName: string,
  jobDescription: string,
  questions: BidQuestionInput[],
  promptTemplate?: string,
  options: { signal?: AbortSignal } = {}
): Promise<Record<string, Record<number, string>>> {
  const normalizedQuestions = normalizeQuestions(questions);

  if (profiles.length === 0 || normalizedQuestions.length === 0) {
    return {};
  }

  const responseText = await createRawCompletion({
    callSite: 'bid-assistant-answers',
    system: SYSTEM_PROMPT,
    user: buildBatchPrompt(profiles, jobTitle, companyName, jobDescription, normalizedQuestions, promptTemplate),
    responseFormat: 'json',
    maxTokens: Math.min(16000, 800 + normalizedQuestions.length * profiles.length * 400),
    temperature: 0.4,
    jsonSchema: buildAnswersJsonSchema(profiles, normalizedQuestions),
    signal: options.signal,
  });

  const parsedResponse: unknown = JSON.parse(extractJSON(responseText));
  const generatedAnswers: Record<string, Record<number, string>> = {};

  for (const profile of profiles) {
    const profileId = `${profile?.id || ''}`;
    generatedAnswers[profileId] = {};

    for (const question of normalizedQuestions) {
      const answer = getGeneratedAnswer(parsedResponse, profileId, question.questionId);

      if (typeof answer !== 'string') {
        throw new Error(
          `The model did not return an answer for profile ${profileId}, question ${question.questionIndex + 1}.`
        );
      }

      generatedAnswers[profileId][question.questionIndex] = answer.trim();
    }
  }

  return generatedAnswers;
}
