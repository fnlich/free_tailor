import type { AIProvider } from './template';

export type PromptResponseFormat = 'json' | 'text';
export type PromptFeatureKey =
  | 'analyze-job-description'
  | 'tailor-resume'
  | 'generate-cover-letter'
  | 'extract-template-from-pdf'
  | 'extract-profile-from-resume'
  | 'filter-google-sheet-job';

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
  responseFormat: PromptResponseFormat;
  modelProvider?: AIProvider;
  modelName?: string;
  allowedVariables: PromptVariableDefinition[];
  validation: PromptValidation;
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
