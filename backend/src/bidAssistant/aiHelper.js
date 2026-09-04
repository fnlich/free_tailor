// Converts profile skills into a readable string.
function getProfileSkills(profile) {
  if (!Array.isArray(profile?.skills)) {
    return '';
  }

  return profile.skills
    .map((skill) => (typeof skill === 'string' ? skill : skill?.name || ''))
    .filter(Boolean)
    .join(', ');
}

// Converts profile experience entries into a readable summary.
function getProfileExperience(profile) {
  if (typeof profile?.experience === 'string') {
    return profile.experience;
  }

  if (!Array.isArray(profile?.experience)) {
    return '';
  }

  return profile.experience
    .map((item) => [item?.title, item?.company, item?.startDate, item?.endDate].filter(Boolean).join(' | '))
    .filter(Boolean)
    .join('\n');
}

// Converts profile education entries into a readable summary.
function getProfileEducation(profile) {
  if (typeof profile?.education === 'string') {
    return profile.education;
  }

  if (!Array.isArray(profile?.education)) {
    return '';
  }

  return profile.education
    .map((item) => [item?.degree, item?.institution, item?.startDate, item?.endDate].filter(Boolean).join(' | '))
    .filter(Boolean)
    .join('\n');
}

function getDefaultPromptTemplate() {
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

function fillPromptTemplate(template, variables) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => `${variables[key] || ''}`);
}

function getProfilePromptData(profile) {
  return {
    profileId: profile?.id || '',
    candidateName: profile?.name || 'Candidate',
    candidateSkills: getProfileSkills(profile),
    candidateExperience: getProfileExperience(profile),
    candidateEducation: getProfileEducation(profile),
    candidateSummary: profile?.summary || ''
  };
}

async function sendOpenRouterChat(messages, options = {}) {
  const model = process.env.OPENROUTER_MODEL || 'OpenAI/gpt-5.4-nano';
  const requestBody = {
    model,
    messages
  };

  if (options.responseFormat) {
    requestBody.response_format = options.responseFormat;
  }

  if (options.provider) {
    requestBody.provider = options.provider;
  }

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenRouter request failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  return data?.choices?.[0]?.message?.content?.trim() || '';
}

function parseJsonResponse(responseText) {
  const trimmedText = responseText.trim();

  try {
    return JSON.parse(trimmedText);
  } catch (error) {
    const fencedJson = trimmedText.match(/```(?:json)?\s*([\s\S]*?)```/i);

    if (fencedJson?.[1]) {
      return JSON.parse(fencedJson[1].trim());
    }

    const firstBraceIndex = trimmedText.indexOf('{');
    const lastBraceIndex = trimmedText.lastIndexOf('}');

    if (firstBraceIndex >= 0 && lastBraceIndex > firstBraceIndex) {
      return JSON.parse(trimmedText.slice(firstBraceIndex, lastBraceIndex + 1));
    }

    throw error;
  }
}

function findAnswerInArray(items, profileId, questionId) {
  if (!Array.isArray(items)) {
    return null;
  }

  const directItem = items.find((item) =>
    `${item?.profileId || item?.profile_id || ''}` === profileId
    && `${item?.questionId || item?.question_id || ''}` === questionId
  );

  if (typeof directItem?.answer === 'string') {
    return directItem.answer;
  }

  const profileItem = items.find((item) => `${item?.profileId || item?.profile_id || ''}` === profileId);
  const nestedAnswers = profileItem?.answers;

  if (Array.isArray(nestedAnswers)) {
    const nestedItem = nestedAnswers.find((item) => `${item?.questionId || item?.question_id || ''}` === questionId);
    return typeof nestedItem?.answer === 'string' ? nestedItem.answer : null;
  }

  if (nestedAnswers && typeof nestedAnswers === 'object' && typeof nestedAnswers[questionId] === 'string') {
    return nestedAnswers[questionId];
  }

  return null;
}

function getGeneratedAnswer(parsedResponse, profileId, questionId) {
  const answers = parsedResponse?.answers || parsedResponse;

  if (answers && typeof answers === 'object' && !Array.isArray(answers)) {
    const profileAnswers = answers[profileId];

    if (typeof profileAnswers?.[questionId] === 'string') {
      return profileAnswers[questionId];
    }

    if (Array.isArray(profileAnswers)) {
      const questionAnswer = profileAnswers.find((item) => `${item?.questionId || item?.question_id || ''}` === questionId);
      return typeof questionAnswer?.answer === 'string' ? questionAnswer.answer : null;
    }
  }

  if (Array.isArray(answers)) {
    return findAnswerInArray(answers, profileId, questionId);
  }

  if (Array.isArray(parsedResponse?.profiles)) {
    return findAnswerInArray(parsedResponse.profiles, profileId, questionId);
  }

  return null;
}

function buildBatchPrompt(profiles, jobTitle, companyName, jobDescription, questions, promptTemplate) {
  const profileData = profiles.map(getProfilePromptData);
  const questionData = questions.map((item) => ({
    questionId: item.questionId,
    question: item.question,
    charLimit: item.charLimit
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
${JSON.stringify({
    jobTitle: jobTitle || '',
    companyName: companyName || '',
    jobDescription: jobDescription || ''
  }, null, 2)}

Profiles:
${JSON.stringify(profileData, null, 2)}

Questions:
${JSON.stringify(questionData, null, 2)}`;
}

function buildAnswersJsonSchema(profiles, questions) {
  const questionProperties = {};
  const requiredQuestionIds = questions.map((question) => question.questionId);

  for (const question of questions) {
    questionProperties[question.questionId] = {
      type: 'string',
      description: `Answer for ${question.questionId}. Keep it under ${question.charLimit} characters.`
    };
  }

  const profileProperties = {};
  const requiredProfileIds = profiles.map((profile) => `${profile?.id || ''}`);

  for (const profileId of requiredProfileIds) {
    profileProperties[profileId] = {
      type: 'object',
      additionalProperties: false,
      required: requiredQuestionIds,
      properties: questionProperties
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
        properties: profileProperties
      }
    }
  };
}

function buildAnswersResponseFormat(profiles, questions) {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'job_application_answers',
      strict: true,
      schema: buildAnswersJsonSchema(profiles, questions)
    }
  };
}
// Calls OpenRouter to generate an answer for one profile and one question.
async function generateAnswer(profile, jobTitle, companyName, jobDescription, question, charLimit, promptTemplate) {
  const profileData = getProfilePromptData(profile);

  const systemPrompt = 'You are a job application assistant. Follow the prompt exactly and return only the answer text.';
  const userPrompt = fillPromptTemplate(
    promptTemplate?.trim() || getDefaultPromptTemplate(),
    {
      candidateName: profileData.candidateName,
      candidateSkills: profileData.candidateSkills,
      candidateExperience: profileData.candidateExperience,
      candidateEducation: profileData.candidateEducation,
      candidateSummary: profileData.candidateSummary,
      jobTitle: jobTitle || '',
      companyName: companyName || '',
      jobDescription: jobDescription || '',
      question,
      charLimit
    }
  );

  const answerText = await sendOpenRouterChat([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ]);

  return answerText;
}

// Calls OpenRouter once to generate answers for many profiles and questions.
async function generateAnswers(profiles, jobTitle, companyName, jobDescription, questions, promptTemplate) {
  const normalizedQuestions = questions.map((item, index) => {
    const questionIndex = Number.isInteger(item?.questionIndex) ? item.questionIndex : index;

    return {
      questionId: `q${questionIndex}`,
      questionIndex,
      question: item.question,
      charLimit: Number(item.charLimit) || 500
    };
  });

  if (profiles.length === 0 || normalizedQuestions.length === 0) {
    return {};
  }

  const systemPrompt = 'You are a job application assistant. Return valid JSON only.';
  const userPrompt = buildBatchPrompt(
    profiles,
    jobTitle,
    companyName,
    jobDescription,
    normalizedQuestions,
    promptTemplate
  );

  const responseText = await sendOpenRouterChat([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ], {
    responseFormat: buildAnswersResponseFormat(profiles, normalizedQuestions),
    provider: {
      require_parameters: true
    }
  });
  const parsedResponse = parseJsonResponse(responseText);
  const generatedAnswers = {};

  for (const profile of profiles) {
    const profileId = `${profile?.id || ''}`;
    generatedAnswers[profileId] = {};

    for (const question of normalizedQuestions) {
      const answer = getGeneratedAnswer(parsedResponse, profileId, question.questionId);

      if (typeof answer !== 'string') {
        throw new Error(`OpenRouter response did not include an answer for profile ${profileId} and question ${question.questionId}.`);
      }

      generatedAnswers[profileId][question.questionIndex] = answer.trim();
    }
  }

  return generatedAnswers;
}

module.exports = {
  generateAnswer,
  generateAnswers
};
