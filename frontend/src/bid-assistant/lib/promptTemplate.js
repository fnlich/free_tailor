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
Avoid corporate buzzwords and make it sound like a real person.
Use only facts from the candidate data above; never invent an employer, a date, a number of years, a tool, a degree, or an eligibility or availability status.
If the candidate data does not answer the question, say so plainly instead of guessing.`;

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
