import type { AdminAppSettings, AIModelRecord, AIProvider } from '@/lib/api';
import { toDollarInput } from '@/lib/format';
import { blankDraftChoice, displayNameOwner } from './modelDraft';
import { readPriceDraft } from './modelPrice';

/**
 * Admin -> Models' Create New Model / Edit dialog (owner decision M1), with
 * no React in it, so backend/test/frontendSettings.test.js runs it against
 * the server's own model routes: what the form starts as, what it may not
 * send - in the server's own sentences - what a save sends, and which box a
 * refusal belongs under.
 *
 * Runtime imports: lib/format.ts and this folder's two other helpers, all
 * pure.
 */

/** The form, as typed. The price is dollars as typed ("0.023"), sent as typed - the server parses it exactly. */
export type ModelDraft = {
  name: string;
  provider: AIProvider;
  modelName: string;
  price: string;
  description: string;
  enabled: boolean;
};

/**
 * The dialog's boxes, by the name each has in a create or edit body - a copy
 * of the server's `AI_MODEL_FIELDS`, held to it by a test. A refusal naming
 * one (`{ error, field }`) is shown under it.
 */
export const MODEL_FIELDS = ['name', 'provider', 'modelName', 'pricePerResumeUsd', 'description', 'enabled'] as const;

export type ModelField = (typeof MODEL_FIELDS)[number];

export type ModelProblems = Partial<Record<ModelField, string>>;

type FormSettings = Pick<AdminAppSettings, 'aiModels' | 'providerModelOptions'>;

/** An existing model, as the Edit dialog opens on it. */
export function draftFromModel(model: AIModelRecord): ModelDraft {
  return {
    name: model.name,
    provider: model.provider,
    modelName: model.modelName,
    price: toDollarInput(model.pricePerResumeMilli),
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
    // EMPTY, not a default: a new model is priced by whoever adds it, and the
    // server refuses a create without a price. A pre-filled figure is a price
    // somebody would save without having chosen it.
    price: '',
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
 * by, a model name, and a price the server reads. What only the server knows -
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
    // stored before the rule can still be toggled or repriced.
    const current = editingId ? settings.aiModels.find((model) => model.id === editingId) : null;
    const renamed = !current || current.name.trim().toLowerCase() !== name.toLowerCase();
    if (owner && renamed) {
      problems.name =
        `"${owner.name}" is already the name of a ${seatLabel(settings, owner.provider)} model. Users see only ` +
        'display names, so give this one a different name.';
    }
  }
  if (!draft.modelName.trim()) problems.modelName = 'Model name is required.';
  const price = readPriceDraft(draft.price);
  // An edit that leaves the box as it was sends no price, so only a changed box is judged.
  if (!price.ok) problems.pricePerResumeUsd = price.message;
  return problems;
}

/** A create's body: every box, the price as typed. */
export function createModelBody(draft: ModelDraft) {
  return {
    name: draft.name.trim(),
    provider: draft.provider,
    modelName: draft.modelName.trim(),
    // As typed: the server reads "0.023" exactly. Sending the parsed number
    // back as a float would be the one way to lose that precision.
    pricePerResumeUsd: draft.price.trim(),
    description: draft.description.trim(),
    enabled: draft.enabled,
  };
}

export type ModelEditBody = Partial<ReturnType<typeof createModelBody>>;

/**
 * An edit's body: only what differs from the model as stored. Empty when
 * nothing does - the dialog then closes without a request. A price retyped
 * to the same amount ("0.050" for $0.05) is no change; a model name is
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
  const price = readPriceDraft(draft.price);
  if (!price.ok || price.milli !== model.pricePerResumeMilli) body.pricePerResumeUsd = draft.price.trim();
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
