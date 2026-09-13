import type { PromptFeatureKey } from '../types/prompt';

/**
 * The two kinds of prompt, and which feature is which.
 *
 * The line is what the prompt PRODUCES, not what it reads. An extracting prompt
 * turns source material - a posting, a PDF, a scraped page - into structured
 * data the app can act on; a building prompt turns that data into something the
 * user receives. Both read and both write, so any other line would be arbitrary.
 *
 * Derived from the feature rather than stored on the prompt. A custom prompt is
 * always attached to a feature to be used at all, so a stored category would be
 * a second source of truth that could disagree with the first - and the failure
 * would be a prompt filed under Building that runs as an extractor.
 */

export const PROMPT_CATEGORY_IDS = ['extracting', 'building', 'other'] as const;

export type PromptCategoryId = (typeof PROMPT_CATEGORY_IDS)[number];

export type PromptCategory = {
  id: PromptCategoryId;
  label: string;
  description: string;
  order: number;
};

export const PROMPT_CATEGORIES: Readonly<Record<PromptCategoryId, PromptCategory>> = Object.freeze({
  extracting: {
    id: 'extracting',
    label: 'Extracting Prompts',
    description:
      'Turn source material into structured data: a job posting into keywords and requirements, ' +
      'a resume PDF into a profile, a scraped page into job attributes.',
    order: 0,
  },
  building: {
    id: 'building',
    label: 'Building Prompts',
    description:
      'Turn that structured data into what the user receives: the tailored resume content and the ' +
      'cover letter.',
    order: 1,
  },
  other: {
    id: 'other',
    label: 'Unattached Prompts',
    description:
      'Prompts that are not attached to a feature. They are stored and editable but nothing runs ' +
      'them until one is chosen.',
    order: 2,
  },
});

const BY_FEATURE: Readonly<Record<PromptFeatureKey, PromptCategoryId>> = Object.freeze({
  'analyze-job-description': 'extracting',
  'extract-template-from-pdf': 'extracting',
  'extract-profile-from-resume': 'extracting',
  'filter-google-sheet-job': 'extracting',
  'tailor-resume': 'building',
  'generate-cover-letter': 'building',
});

export function categoryForFeature(featureKey?: PromptFeatureKey): PromptCategoryId {
  return featureKey ? BY_FEATURE[featureKey] ?? 'other' : 'other';
}

export function getPromptCategory(id: PromptCategoryId): PromptCategory {
  return PROMPT_CATEGORIES[id];
}

export function listPromptCategories(): PromptCategory[] {
  return PROMPT_CATEGORY_IDS.map((id) => PROMPT_CATEGORIES[id]).sort((a, b) => a.order - b.order);
}
