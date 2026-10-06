import type { PromptCategoryId } from '../config/promptCategories';
import type { AIProvider } from './template';

export type PromptResponseFormat = 'json' | 'text';
export type PromptFeatureKey =
  | 'analyze-job-description'
  | 'tailor-resume'
  | 'generate-cover-letter'
  | 'extract-template-from-pdf'
  | 'extract-profile-from-resume';

export interface PromptVariableDefinition {
  name: string;
  description?: string;
  sampleValue?: string;
}

export interface PromptValidation {
  usedVariables: string[];
  unknownVariables: string[];
}

export interface PromptSummary {
  id: string;
  name: string;
  description: string;
  featureKey?: PromptFeatureKey;
  featureLabel?: string;
  /**
   * Building, Extracting, or unattached.
   *
   * Derived from `featureKey` on the way out rather than stored, so it can
   * never disagree with the feature the prompt actually runs as.
   */
  category: PromptCategoryId;
  categoryLabel: string;
  responseFormat: PromptResponseFormat;
  modelProvider?: AIProvider;
  modelName?: string;
  /**
   * For a feature prompt, every variable its code supplies - which is also
   * the only ones it may use; for an unattached one, the ones its author
   * declared.
   */
  allowedVariables: PromptVariableDefinition[];
  validation: PromptValidation;
  /**
   * Present (true) only on a tailor-resume record whose text never mentions
   * `[[includeStrengths]]`: written before a profile could switch its Strengths
   * and Soft Skills sections. Admin -> Prompts says so; the app enforces the
   * switches for it anyway.
   */
  predatesSectionSwitches?: boolean;
  /**
   * Present (true) only on the analysis record whose text never mentions
   * `[[jobFieldList]]`: written before a posting had a job field. Admin ->
   * Prompts says so; the analysis appends the job field, salary and filter
   * instructions to every turn it runs for such a record.
   */
  predatesJobField?: boolean;
  /**
   * Present (true) only on an analysis record that names `[[jobFieldList]]`
   * but never `[[industryList]]`: written after postings had a job field and
   * before they had an industry. Admin -> Prompts says so; the analysis
   * appends the industry instructions to every turn it runs for such a record.
   */
  predatesIndustry?: boolean;
  isBuiltIn: boolean;
  isActiveForFeature?: boolean;
  usage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PromptRecord extends PromptSummary {
  content: string;
}

export interface PromptCreateInput {
  name: string;
  description?: string;
  featureKey?: PromptFeatureKey;
  content: string;
  responseFormat?: PromptResponseFormat;
  modelProvider?: AIProvider;
  modelName?: string;
  allowedVariables?: PromptVariableDefinition[];
}

export interface PromptUpdateInput {
  name?: string;
  description?: string;
  featureKey?: PromptFeatureKey;
  content: string;
  responseFormat?: PromptResponseFormat;
  modelProvider?: AIProvider;
  modelName?: string;
  allowedVariables?: PromptVariableDefinition[];
}

export interface PromptPreviewInput {
  id?: string;
  /**
   * For a draft not saved yet: the feature it is written for, so it is checked
   * against the variables that feature's code supplies. Ignored with `id`,
   * where the stored record says.
   */
  featureKey?: PromptFeatureKey;
  content?: string;
  allowedVariables?: PromptVariableDefinition[];
  sampleValues?: Record<string, string>;
}

export interface PromptPreviewResult {
  renderedContent: string;
  sampleValues: Record<string, string>;
  validation: PromptValidation;
}

export interface PromptActivationResult {
  featureKey: PromptFeatureKey;
  promptId: string;
}
