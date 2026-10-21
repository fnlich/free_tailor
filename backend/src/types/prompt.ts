import type { PromptCategoryId } from '../config/promptCategories';
import type { AIProvider } from './template';

export type PromptResponseFormat = 'json' | 'text';
export type PromptFeatureKey =
  | 'analyze-job-description'
  | 'filter-google-sheet-job'
  | 'tailor-resume'
  | 'tailor-resume-full'
  | 'revise-resume-coverage'
  | 'generate-cover-letter'
  | 'write-entry-bullets'
  | 'extract-template-from-pdf'
  | 'extract-profile-from-resume';

export interface PromptVariableDefinition {
  name: string;
  description?: string;
  sampleValue?: string;
  /**
   * True on a feature variable every record of that feature must use
   * (services/promptService.ts `requiredVariables`); absent otherwise.
   */
  required?: true;
}

export interface PromptValidation {
  usedVariables: string[];
  unknownVariables: string[];
  /**
   * The feature's required variables the text does not use, in the
   * feature's order; [] for a complete record and for an unattached prompt.
   * A save with any is refused; a stored record with any is `needsUpdate`.
   */
  missingVariables: string[];
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
   * Present (true) only on a stored FEATURE record that lacks one of its
   * feature's required variables (`validation.missingVariables` names them),
   * uses one its feature's code does not supply
   * (`validation.unknownVariables`), or was saved before its feature's
   * prompt contract changed (`savedForOlderVersion`). Such a record is never
   * run: the feature's built-in prompt runs in its place until an
   * administrator fixes it under Admin -> Prompts. An unattached record is
   * never flagged - it has no built-in to give way to.
   */
  needsUpdate?: true;
  /**
   * Present (true) on a stored feature record saved before its feature's
   * current prompt contract took effect (services/promptService.ts
   * `contractSince`) - always with `needsUpdate`. Its variables may all be
   * ones the code still supplies: it is its date that says it was written for
   * the older prompt. Saving it again clears it.
   */
  savedForOlderVersion?: true;
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
