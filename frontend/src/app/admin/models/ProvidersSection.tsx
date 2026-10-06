'use client';

import { useCallback, useEffect, useState } from 'react';
import Dialog from '@/components/ui/Dialog';
import { ErrorNotice, Field, Notice, Pill, Section, StaticValue, Status } from '@/components/ui/kit';
import { adminApi, ApiResponseError, LOCK_ICON } from '@/lib/api';
import { providersApi, type ProviderMutation } from '@/lib/aiProviders';
import {
  addProviderBody,
  blankProviderDraft,
  canRemove,
  describeHomeDir,
  describeLane,
  describeMoved,
  draftFromProvider,
  editProviderBody,
  emptyMeans,
  PROVIDER_CONCURRENCY_MAX,
  PROVIDER_CONCURRENCY_MIN,
  PROVIDER_HOME_VARIABLES,
  PROVIDER_TYPE_NAMES,
  PROVIDER_TYPES,
  providerDraftProblems,
  providerStatus,
  refusalField,
  removeQuestion,
  signInCommand,
  sourceNote,
  type AdminAIProvider,
  type ProviderCard,
  type ProviderDraft,
  type ProviderField,
  type ProviderProblems,
} from '@/lib/providerDisplay';
import { messageWithDetail } from '@/lib/userMessage';

/**
 * Admin -> Models -> Providers (owner decisions P1-P4): every place a model
 * type runs. A provider is a CLI of one of the three types, signed in at a
 * folder of its own on this server - so it can be another account - with
 * optionally a binary of its own, and its own `concurrency_max_requests`,
 * which is also the width of its own queue lane. A model names a type, and its
 * resumes are spread over every provider of that type that is switched on,
 * signed in and not held.
 *
 * The first provider of each type is the BUILT-IN one: it reads `.env` until a
 * value is set here, it is marked, and it can be switched off but never
 * removed - every stored model names its type. Every row says where each value
 * in effect came from.
 *
 * The live state is the health route's - one card per provider, from a FRESH
 * check, which is also what lifts a sign-in hold once the CLI is signed back
 * in. It is read after the list, so a slow CLI never holds the table up.
 *
 * Administrators only, like the page: folders and binaries on the server are
 * nobody else's business, and the routes refuse everybody else.
 */
export default function ProvidersSection({
  providers,
  onProvidersChange,
}: {
  /** From the admin settings payload (`aiProviders`), and from every change's answer. */
  providers: AdminAIProvider[];
  onProvidersChange: (next: AdminAIProvider[]) => void;
}) {
  const [cards, setCards] = useState<Record<string, ProviderCard>>({});
  const [reading, setReading] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [readError, setReadError] = useState<unknown>(null);
  /** The row a change is being made to; every row's buttons wait for it. */
  const [busyId, setBusyId] = useState<string | null>(null);
  const [checking, setChecking] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [editor, setEditor] = useState<{ provider: AdminAIProvider | null } | null>(null);

  const readHealth = useCallback(async () => {
    try {
      const report = await adminApi.getAiHealth();
      setCards(Object.fromEntries(report.providers.map((card) => [card.id, card])));
      setReading('ready');
      setReadError(null);
    } catch (err) {
      setReading('failed');
      setReadError(err);
    }
  }, []);

  useEffect(() => {
    void readHealth();
  }, [readHealth]);

  const refreshAll = () => {
    setReading('loading');
    void readHealth();
  };

  const startChange = (id: string | null) => {
    setBusyId(id);
    setError('');
    setStatus('');
  };

  /** A change's answer: the list, a sentence, and the live state read again - work may have moved. */
  const applied = (result: ProviderMutation, said: string) => {
    onProvidersChange(result.providers);
    const type = result.provider?.type;
    const moved = type ? describeMoved(result.moved, type) : '';
    setStatus(moved ? `${said} ${moved}` : said);
    setReading('loading');
    void readHealth();
  };

  const handleToggle = async (provider: AdminAIProvider) => {
    startChange(provider.id);
    try {
      const result = await providersApi.update(provider.id, { enabled: !provider.enabled });
      applied(result, `${provider.label} switched ${provider.enabled ? 'off' : 'on'}.`);
    } catch (err) {
      setError(messageWithDetail(err, `Could not switch ${provider.label} ${provider.enabled ? 'off' : 'on'}`));
    } finally {
      setBusyId(null);
    }
  };

  const handleRemove = async (provider: AdminAIProvider) => {
    if (!window.confirm(removeQuestion(provider))) return;
    startChange(provider.id);
    try {
      const result = await providersApi.remove(provider.id);
      onProvidersChange(result.providers);
      const moved = describeMoved(result.moved, provider.type);
      setStatus(moved ? `${provider.label} removed. ${moved}` : `${provider.label} removed.`);
      setCards((current) => {
        const next = { ...current };
        delete next[provider.id];
        return next;
      });
      // Its waiting work moved to another provider: their lanes changed too.
      setReading('loading');
      void readHealth();
    } catch (err) {
      // A provider building something is refused with the server's own
      // sentence - switch it off, and remove it once that finishes.
      setError(messageWithDetail(err, `Could not remove ${provider.label}`));
    } finally {
      setBusyId(null);
    }
  };

  const handleCheck = async (provider: AdminAIProvider) => {
    setError('');
    setChecking((current) => new Set(current).add(provider.id));
    try {
      const card = await providersApi.check(provider.id);
      if (card) setCards((current) => ({ ...current, [card.id]: card }));
    } catch (err) {
      setError(messageWithDetail(err, `Could not check ${provider.label}`));
    } finally {
      setChecking((current) => {
        const next = new Set(current);
        next.delete(provider.id);
        return next;
      });
    }
  };

  const handleSaved = (result: ProviderMutation, added: boolean) => {
    setEditor(null);
    const label = result.provider?.label ?? 'The provider';
    applied(result, added ? `${label} added.` : `${label} saved.`);
  };

  return (
    <Section
      title="Providers"
      description={
        <>
          Where each type of model runs: a CLI signed in at a folder of its own on this server - so it can be
          another account - with its own <code className="font-mono">concurrency_max_requests</code> and its own
          queue. A model names a type, and its resumes are spread over every provider of that type that is
          switched on, signed in and not held. The built-in provider of each type reads{' '}
          <code className="font-mono">.env</code> until a value is set here.
        </>
      }
      actions={
        <>
          <button
            type="button"
            className="tl-button-quiet"
            onClick={refreshAll}
            disabled={reading === 'loading'}
          >
            {reading === 'loading' ? 'Checking...' : 'Check all'}
          </button>
          <button
            type="button"
            className="tl-button"
            onClick={() => {
              setError('');
              setStatus('');
              setEditor({ provider: null });
            }}
            disabled={busyId !== null}
          >
            Add provider
          </button>
        </>
      }
    >
      {(error || status) && (
        <div className="space-y-3">
          {error && (
            <Notice tone="error" role="alert">
              {error}
            </Notice>
          )}
          {status && (
            <Notice tone="success" role="status">
              {status}
            </Notice>
          )}
        </div>
      )}
      {reading === 'failed' && (
        <ErrorNotice error={readError} fallback="Could not read the providers' status">
          <button type="button" onClick={refreshAll} className="tl-button-quiet mt-4">
            Try again
          </button>
        </ErrorNotice>
      )}

      {/* `relative` holds the sr-only Actions heading inside the sideways scroll. */}
      <div className="tl-table-box relative">
        <table className="tl-table" aria-label="Providers">
          <thead>
            <tr>
              <th scope="col">Provider</th>
              <th scope="col">Sign-in folder</th>
              <th scope="col">Binary</th>
              <th scope="col">Limit</th>
              <th scope="col">Status</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {providers.map((provider) => (
              <ProviderRow
                key={provider.id}
                provider={provider}
                card={cards[provider.id] ?? null}
                reading={reading}
                checking={checking.has(provider.id)}
                busy={busyId !== null}
                onEdit={() => {
                  setError('');
                  setStatus('');
                  setEditor({ provider });
                }}
                onToggle={() => void handleToggle(provider)}
                onCheck={() => void handleCheck(provider)}
                onRemove={() => void handleRemove(provider)}
              />
            ))}
          </tbody>
        </table>
      </div>

      {editor && (
        <ProviderDialog
          provider={editor.provider}
          providers={providers}
          onClose={() => setEditor(null)}
          onSaved={(result) => handleSaved(result, editor.provider === null)}
        />
      )}
    </Section>
  );
}

/* ====================================================================== row */

function formatTime(iso: string | null): string {
  if (!iso) return '';
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleTimeString();
}

function ProviderRow({
  provider,
  card,
  reading,
  checking,
  busy,
  onEdit,
  onToggle,
  onCheck,
  onRemove,
}: {
  provider: AdminAIProvider;
  card: ProviderCard | null;
  reading: 'loading' | 'ready' | 'failed';
  checking: boolean;
  busy: boolean;
  onEdit: () => void;
  onToggle: () => void;
  onCheck: () => void;
  onRemove: () => void;
}) {
  const state = providerStatus(provider, card, {
    loading: reading === 'loading' || checking,
    failed: reading === 'failed',
  });
  const lane = describeLane(card?.queue ?? null);
  const until = formatTime(state.until);
  const checkedAt = card && provider.enabled ? formatTime(card.checkedAt) : '';

  return (
    // Colours on inner elements: `.tl-table td` is unlayered and would beat a
    // utility on the cell itself.
    <tr data-provider-id={provider.id}>
      <td className="min-w-[13rem] align-top">
        <p className="font-semibold text-ink">{provider.label}</p>
        <div className="mt-1 flex flex-wrap gap-1.5">
          <Pill tone="grey">{PROVIDER_TYPE_NAMES[provider.type]}</Pill>
          {provider.builtIn && <Pill tone="sky">Built-in</Pill>}
          {provider.locked && (
            <span title={provider.lockReason}>
              <Pill tone="amber">{LOCK_ICON} Locked</Pill>
            </span>
          )}
        </div>
        {/* The id the log names it by: "[queue] ... is running on prv-...". */}
        <p className="mt-1 break-all font-mono text-xs text-subtle">{provider.id}</p>
      </td>
      <td className="min-w-[14rem] align-top">
        <p className={`break-all text-xs text-ink ${provider.homeDir ? 'font-mono' : ''}`}>
          {describeHomeDir(provider)}
        </p>
        <p className="mt-1 text-xs text-muted">
          <span className="font-mono">{provider.homeVariable}</span> - {sourceNote(provider, 'homeDir')}
        </p>
      </td>
      <td className="min-w-[10rem] align-top">
        <p className="break-all font-mono text-xs text-ink">{provider.binaryPath}</p>
        <p className="mt-1 text-xs text-muted">{sourceNote(provider, 'binaryPath')}</p>
      </td>
      <td className="whitespace-nowrap align-top">
        <p className="tabular-nums text-ink">{provider.concurrency_max_requests} at once</p>
        <p className="mt-1 text-xs text-muted">{sourceNote(provider, 'concurrency_max_requests')}</p>
        {lane && <p className="mt-1 text-xs text-ink">{lane}</p>}
      </td>
      <td className="min-w-[14rem] align-top">
        <Pill tone={state.tone}>{state.label}</Pill>
        {state.detail && <p className="mt-1 break-words text-xs text-muted">{state.detail}</p>}
        {until && <p className="mt-1 text-xs text-muted">Until {until}.</p>}
        {checkedAt && <p className="mt-1 text-xs text-subtle">Checked {checkedAt}</p>}
      </td>
      <td className="align-top">
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onEdit} disabled={busy} className="tl-button-quiet" data-size="sm">
            Edit
          </button>
          <button type="button" onClick={onToggle} disabled={busy} className="tl-button-quiet" data-size="sm">
            {provider.enabled ? 'Switch off' : 'Switch on'}
          </button>
          <button
            type="button"
            onClick={onCheck}
            disabled={busy || checking}
            className="tl-button-quiet"
            data-size="sm"
          >
            {checking ? 'Checking...' : 'Check now'}
          </button>
          {canRemove(provider) && (
            <button
              type="button"
              onClick={onRemove}
              disabled={busy}
              className="tl-button-quiet"
              data-size="sm"
              data-tone="danger"
            >
              Remove
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

/* =================================================================== dialog */

/** The boxes the form shows, so a refusal about any other field is shown above them instead. */
function shownFields(adding: boolean): ReadonlySet<ProviderField> {
  return new Set<ProviderField>(
    adding
      ? ['type', 'label', 'homeDir', 'binaryPath', 'concurrency_max_requests', 'enabled']
      : ['label', 'homeDir', 'binaryPath', 'concurrency_max_requests']
  );
}

/**
 * Add provider, or Edit one. Every box is text, checked as typed with the
 * server's own rules and sentences (lib/providerDisplay.ts); what only the
 * server can see - the folder exists, is a directory, is outside the app, is
 * not another provider's; the binary is executable - comes back as a refusal
 * naming its box, and is shown under that box.
 */
function ProviderDialog({
  provider,
  providers,
  onClose,
  onSaved,
}: {
  /** Null to add one. */
  provider: AdminAIProvider | null;
  providers: AdminAIProvider[];
  onClose: () => void;
  onSaved: (result: ProviderMutation) => void;
}) {
  const adding = provider === null;
  const [draft, setDraft] = useState<ProviderDraft>(() =>
    provider ? draftFromProvider(provider) : blankProviderDraft()
  );
  const [attempted, setAttempted] = useState(false);
  /** The server's refusals, by box, until that box is edited. */
  const [refused, setRefused] = useState<ProviderProblems>({});
  const [formError, setFormError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);

  const builtInOfType = providers.find((entry) => entry.type === draft.type && entry.builtIn) ?? null;
  const local = providerDraftProblems(draft, provider, providers);
  const problems: ProviderProblems = { ...(attempted ? local : {}), ...refused };
  const typeLocked = builtInOfType?.locked === true;

  const edit = <K extends keyof ProviderDraft>(field: K, value: ProviderDraft[K]) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setRefused((current) => {
      if (!(field in current)) return current;
      const next = { ...current };
      delete next[field as ProviderField];
      return next;
    });
  };

  const save = async () => {
    setAttempted(true);
    setFormError(null);
    if (Object.keys(local).length > 0) return;
    const body = provider ? editProviderBody(provider, draft) : addProviderBody(draft);
    if (provider && Object.keys(body).length === 0) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      const result = provider ? await providersApi.update(provider.id, body) : await providersApi.create(body);
      onSaved(result);
    } catch (err) {
      const field = err instanceof ApiResponseError ? refusalField(err.body) : null;
      if (field && shownFields(adding).has(field)) {
        setRefused((current) => ({ ...current, [field]: messageWithDetail(err, 'That value was refused') }));
      } else {
        setFormError(err);
      }
    } finally {
      setSaving(false);
    }
  };

  const typeName = PROVIDER_TYPE_NAMES[draft.type];
  const homeVariable = PROVIDER_HOME_VARIABLES[draft.type];
  const homeHint = provider?.builtIn ? (
    emptyMeans(provider, 'homeDir', builtInOfType)
  ) : (
    <>
      Passed to the CLI as {homeVariable}. Sign the CLI in there first, as the server&apos;s user:{' '}
      <code className="break-all font-mono text-ink">{signInCommand(draft.type, draft.homeDir)}</code>
    </>
  );
  const binaryHint = emptyMeans(provider, 'binaryPath', builtInOfType);
  const limitHint =
    `How many resumes it builds at once, ${PROVIDER_CONCURRENCY_MIN} to ${PROVIDER_CONCURRENCY_MAX}; also the width of its queue. ` +
    emptyMeans(provider, 'concurrency_max_requests', builtInOfType);

  const footer = (
    <>
      <button type="button" className="tl-button-quiet" onClick={onClose} disabled={saving}>
        Cancel
      </button>
      <button
        type="button"
        className="tl-button"
        onClick={() => void save()}
        disabled={saving || (attempted && Object.keys(local).length > 0)}
      >
        {saving ? 'Saving...' : adding ? 'Add provider' : 'Save provider'}
      </button>
    </>
  );

  return (
    <Dialog
      open
      title={provider ? `Edit ${provider.label}` : 'Add provider'}
      subtitle={
        !provider
          ? 'A CLI signed in at a folder of its own on this server, with its own limit and queue.'
          : provider.builtIn
            ? `The built-in ${typeName} provider. An empty box uses .env.`
            : `A ${typeName} provider added here.`
      }
      width="wide"
      onClose={onClose}
      footer={footer}
    >
      <div className="space-y-5">
        {Boolean(formError) && <ErrorNotice error={formError} fallback="Could not save the provider" />}

        <div className="grid gap-5 md:grid-cols-2">
          <Field label="Type" htmlFor={adding ? 'provider-type' : undefined}>
            {adding ? (
              <>
                <select
                  id="provider-type"
                  className="tl-input"
                  value={draft.type}
                  onChange={(event) => {
                    const type = PROVIDER_TYPES.find((entry) => entry === event.target.value);
                    if (type) edit('type', type);
                  }}
                  disabled={saving}
                  aria-invalid={Boolean(problems.type)}
                >
                  {PROVIDER_TYPES.map((type) => {
                    const locked = providers.some((entry) => entry.type === type && entry.builtIn && entry.locked);
                    return (
                      <option key={type} value={type}>
                        {locked ? `${LOCK_ICON} ${PROVIDER_TYPE_NAMES[type]} (locked)` : PROVIDER_TYPE_NAMES[type]}
                      </option>
                    );
                  })}
                </select>
                {problems.type && <Status tone="error">{problems.type}</Status>}
                {typeLocked && (
                  <p className="mt-2 text-sm text-muted">{builtInOfType?.lockReason}</p>
                )}
              </>
            ) : (
              <StaticValue>{typeName}</StaticValue>
            )}
          </Field>

          <Field label="Name" htmlFor="provider-label">
            <input
              id="provider-label"
              type="text"
              className="tl-input"
              value={draft.label}
              placeholder={provider?.builtIn ? provider.typeLabel : `${typeName} - team B`}
              onChange={(event) => edit('label', event.target.value)}
              disabled={saving}
              aria-invalid={Boolean(problems.label)}
            />
            {problems.label && <Status tone="error">{problems.label}</Status>}
          </Field>
        </div>

        <div>
          <label htmlFor="provider-home" className="tl-label">
            Sign-in folder{adding ? '' : provider?.builtIn ? ' (optional)' : ''}
          </label>
          <input
            id="provider-home"
            type="text"
            className="tl-input mt-2 font-mono"
            value={draft.homeDir}
            placeholder={
              provider?.builtIn ? provider.envDefaults?.homeDir ?? "The CLI's own default" : `/srv/${draft.type.replace('-cli', '')}-team-b`
            }
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => edit('homeDir', event.target.value)}
            disabled={saving}
            aria-invalid={Boolean(problems.homeDir)}
            aria-describedby="provider-home-hint"
          />
          <p id="provider-home-hint" className="mt-2 break-words text-sm text-subtle">
            {homeHint}
          </p>
          {problems.homeDir && <Status tone="error">{problems.homeDir}</Status>}
        </div>

        <div className="grid gap-5 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div className="min-w-0">
            <label htmlFor="provider-binary" className="tl-label">
              CLI binary (optional)
            </label>
            <input
              id="provider-binary"
              type="text"
              className="tl-input mt-2 font-mono"
              value={draft.binaryPath}
              placeholder={builtInOfType?.binaryPath ?? ''}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => edit('binaryPath', event.target.value)}
              disabled={saving}
              aria-invalid={Boolean(problems.binaryPath)}
              aria-describedby="provider-binary-hint"
            />
            <p id="provider-binary-hint" className="mt-2 break-words text-sm text-subtle">
              An absolute path, executable by the server&apos;s user. {binaryHint}
            </p>
            {problems.binaryPath && <Status tone="error">{problems.binaryPath}</Status>}
          </div>

          <div className="min-w-0">
            <label htmlFor="provider-limit" className="tl-label">
              concurrency_max_requests
            </label>
            <input
              id="provider-limit"
              // Text, like every other number box an administrator types into:
              // what reaches the check is what was typed, not what the browser
              // made of it.
              type="text"
              inputMode="numeric"
              autoComplete="off"
              className="tl-input mt-2 tabular-nums"
              value={draft.concurrency_max_requests}
              placeholder={
                provider?.builtIn
                  ? String(provider.envDefaults?.concurrency_max_requests ?? '')
                  : String(builtInOfType?.envDefaults?.concurrency_max_requests ?? '')
              }
              onChange={(event) => edit('concurrency_max_requests', event.target.value)}
              disabled={saving}
              aria-invalid={Boolean(problems.concurrency_max_requests)}
              aria-describedby="provider-limit-hint"
            />
            <p id="provider-limit-hint" className="mt-2 text-sm text-subtle">
              {limitHint}
            </p>
            {problems.concurrency_max_requests && <Status tone="error">{problems.concurrency_max_requests}</Status>}
          </div>
        </div>

        {adding && (
          <div>
            <label className="flex items-center gap-3 text-sm text-ink">
              <input
                type="checkbox"
                className="tl-check"
                checked={draft.enabled}
                onChange={(event) => edit('enabled', event.target.checked)}
                disabled={saving}
              />
              Switch it on now - it starts taking work once it is signed in
            </label>
            {problems.enabled && <Status tone="error">{problems.enabled}</Status>}
          </div>
        )}
      </div>
    </Dialog>
  );
}
