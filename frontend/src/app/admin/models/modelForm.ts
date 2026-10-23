import type { AdminAppSettings, AIModelRecord, AIProvider } from '@/lib/api';
import { blankDraftChoice, displayNameOwner } from './modelDraft';

/**
 * Admin -> Models' Create New Model / Edit dialog (owner decision M1), with
 * no React in it, so backend/test/frontendSettings.test.js runs it against
 * the server's own model routes: what the form starts as, what it may not
 * send - in the server's own sentences - what a save sends, and which box a
 * refusal belongs under.
 *
 * Its one runtime import is this folder's modelDraft.ts, which is pure.
 * A model carries no price: what a resume costs is the price of its build
 * mode (Settings > General > Price per resume).
 */

/** The form, as typed. */
export type ModelDraft = {
  name: string;
  provider: AIProvider;
  modelName: string;
  description: string;
  enabled: boolean;
};

/**
 * The dialog's boxes, by the name each has in a create or edit body - a copy
 * of the server's `AI_MODEL_FIELDS`, held to it by a test. A refusal naming
 * one (`{ error, field }`) is shown under it.
 */
export const MODEL_FIELDS = ['name', 'provider', 'modelName', 'description', 'enabled'] as const;

export type ModelField = (typeof MODEL_FIELDS)[number];

export type ModelProblems = Partial<Record<ModelField, string>>;

type FormSettings = Pick<AdminAppSettings, 'aiModels' | 'providerModelOptions'>;

/** An existing model, as the Edit dialog opens on it. */
export function draftFromModel(model: AIModelRecord): ModelDraft {
  return {
    name: model.name,
    provider: model.provider,
    modelName: model.modelName,
    description: model.description,
    enabled: model.enabled,
  };
}

/** A blank form on the first seat with a free model name, on that name. */
export function blankModelDraft(settings: FormSettings | null): ModelDraft {
  const { provider, modelName } = blankDraftChoice(settings);
  return {
    name: '',
    provider,
    modelName,
    description: '',
    enabled: true,
  };
}

/** A seat's name as the server writes it in a sentence (its `providerModelOptions` label). */
function seatLabel(settings: FormSettings, provider: AIProvider): string {
  return settings.providerModelOptions.find((entry) => entry.provider === provider)?.label ?? provider;
}

/**
 * What the form may not send, per box, in the words the server would refuse
 * it with (config/aiModelConfig.ts): a display name, one no other model goes
 * by, and a model name. What only the server knows -
 * the seat's current list, another record's pair - comes back as a refusal
 * naming its box.
 */
export function modelDraftProblems(
  draft: ModelDraft,
  settings: FormSettings,
  editingId: string | null
): ModelProblems {
  const problems: ModelProblems = {};
  const name = draft.name.trim();
  if (!name) {
    problems.name = 'Display name is required.';
  } else {
    const owner = displayNameOwner(settings, name, editingId);
    // On an edit only when the name changes, as the server checks it: a pair
    // stored before the rule can still be toggled or edited.
    const current = editingId ? settings.aiModels.find((model) => model.id === editingId) : null;
    const renamed = !current || current.name.trim().toLowerCase() !== name.toLowerCase();
    if (owner && renamed) {
      problems.name =
        `"${owner.name}" is already the name of a ${seatLabel(settings, owner.provider)} model. Users see only ` +
        'display names, so give this one a different name.';
    }
  }
  if (!draft.modelName.trim()) problems.modelName = 'Model name is required.';
  return problems;
}

/** A create's body: every box. */
export function createModelBody(draft: ModelDraft) {
  return {
    name: draft.name.trim(),
    provider: draft.provider,
    modelName: draft.modelName.trim(),
    description: draft.description.trim(),
    enabled: draft.enabled,
  };
}

export type ModelEditBody = Partial<ReturnType<typeof createModelBody>>;

/**
 * An edit's body: only what differs from the model as stored. Empty when
 * nothing does - the dialog then closes without a request. A model name is
 * compared as the server compares it, in any case.
 */
export function editModelBody(model: AIModelRecord, draft: ModelDraft): ModelEditBody {
  const body: ModelEditBody = {};
  const name = draft.name.trim();
  if (name !== model.name) body.name = name;
  if (draft.provider !== model.provider) body.provider = draft.provider;
  const modelName = draft.modelName.trim();
  if (draft.provider !== model.provider || modelName.toLowerCase() !== model.modelName.toLowerCase()) {
    body.modelName = modelName;
  }
  const description = draft.description.trim();
  if (description !== model.description) body.description = description;
  if (draft.enabled !== model.enabled) body.enabled = draft.enabled;
  return body;
}

/** The box a refusal is about, when the server names one the dialog has; null puts it above the form. */
export function modelRefusalField(body: Record<string, unknown> | null | undefined): ModelField | null {
  const field = body?.field;
  return typeof field === 'string' && (MODEL_FIELDS as readonly string[]).includes(field) ? (field as ModelField) : null;
}
