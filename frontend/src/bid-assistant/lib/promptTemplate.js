export const DEFAULT_PROMPT_TEMPLATE = `Candidate:
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
Avoid corporate buzzwords and make it sound like a real person.`;

export const PROMPT_TOKENS = [
  '{{candidateName}}',
  '{{candidateSkills}}',
  '{{candidateExperience}}',
  '{{candidateEducation}}',
  '{{candidateSummary}}',
  '{{jobTitle}}',
  '{{companyName}}',
  '{{jobDescription}}',
  '{{question}}',
  '{{charLimit}}'
];
