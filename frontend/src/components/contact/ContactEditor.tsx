'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { ErrorNotice, Notice, Section, Status } from '@/components/ui/kit';
import { ApiResponseError } from '@/lib/api';
import { adminContactApi, type ContactChannel, type ContactChannelType, type ContactEditorPayload } from '@/lib/contact';
import {
  CONTACT_TYPE_LABELS,
  CONTACT_TYPES,
  CONTACT_VALUE_HINTS,
  DEFAULT_CONTACT_LABELS,
  moveDraft,
  pinContactErrors,
  readContactFieldErrors,
  sameChannels,
  toChannelDrafts,
  type ChannelDraft,
  type ChannelFieldErrors,
} from '@/lib/contactChannels';
import { messageWithDetail, userMessage } from '@/lib/userMessage';
import { ContactAdminLink } from './ContactAdminDialog';

/**
 * Settings -> General -> Contact: how people reach whoever runs this
 * installation, as a list of channels - email, Telegram, Discord, WhatsApp or
 * anything else - each with a label.
 *
 * Its own section with its own load and Save, apart from the settings form
 * above it, because it is its own setting on the server (`/api/admin/contact`,
 * not the app settings document): an installation whose AI seats cannot run
 * refuses every app-settings save, and must still be able to say how to reach
 * the person who can fix that.
 *
 * The server checks every channel and builds every link; this page sends what
 * was typed and shows the server's refusals where they belong - by ROW KEY, so
 * an error stays on its row when rows are moved or removed after the save.
 */
export default function ContactEditor() {
  const nextKey = useRef(0);
  const makeKey = useCallback(() => `channel-${(nextKey.current += 1)}`, []);

  const [payload, setPayload] = useState<ContactEditorPayload | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [drafts, setDrafts] = useState<ChannelDraft[]>([]);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState('');
  const [rowErrors, setRowErrors] = useState<Record<string, ChannelFieldErrors>>({});
  const [listErrors, setListErrors] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    adminContactApi.get().then(
      (answer) => {
        if (!alive) return;
        setPayload(answer);
        setDrafts(toChannelDrafts(answer.channels, makeKey));
        setLoadError(null);
      },
      (error: unknown) => {
        if (alive) setLoadError(error);
      }
    );
    return () => {
      alive = false;
    };
  }, [makeKey, loadAttempt]);

  const limits = payload?.limits ?? { channels: 10, label: 60, value: 200 };
  const saved: ContactChannel[] = payload?.channels ?? [];
  const unchanged = sameChannels(drafts, saved);

  const edit = (key: string, field: 'type' | 'label' | 'value', value: string) => {
    setDrafts((current) =>
      current.map((draft) =>
        draft.key === key
          ? field === 'type'
            ? { ...draft, type: value as ContactChannelType }
            : { ...draft, [field]: value }
          : draft
      )
    );
    // The refusal was about what used to be there. A new type re-judges the value too.
    setRowErrors((current) => {
      if (!current[key]) return current;
      const fields = { ...current[key] };
      delete fields[field];
      if (field === 'type') delete fields.value;
      return { ...current, [key]: fields };
    });
    setNote('');
  };

  const save = async () => {
    const sent = drafts;
    setSaving(true);
    setNote('');
    setProblem('');
    setRowErrors({});
    setListErrors([]);
    try {
      const answer = await adminContactApi.save(
        sent.map((draft) => ({ type: draft.type, label: draft.label, value: draft.value }))
      );
      setPayload(answer);
      // What the server keeps is normalised - `@name`, `+digits`, a default
      // label - so the rows show that, rather than what was typed.
      setDrafts(toChannelDrafts(answer.channels, makeKey));
      setNote(
        answer.channels.length === 0
          ? 'Saved. No contact details are listed now.'
          : `Saved. Everybody now sees ${answer.channels.length === 1 ? 'this way' : `these ${answer.channels.length} ways`} to reach you.`
      );
    } catch (error) {
      if (error instanceof ApiResponseError && error.code === 'contact-invalid') {
        const pinned = pinContactErrors(sent, readContactFieldErrors(error.body));
        setRowErrors(pinned.byKey);
        setListErrors(pinned.list);
        setProblem(userMessage(error, 'Some contact details need fixing.'));
      } else {
        setProblem(messageWithDetail(error, 'Could not save the contact details.'));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section
      title="Contact"
      description="How people reach you. Shown to everybody - the sign-in screen included - in Contact admin, which the account menu and every message that says to contact your administrator open. The server builds each link from what you enter here."
    >
      {loadError ? (
        <ErrorNotice error={loadError} fallback="Could not load the contact details">
          <button type="button" onClick={() => setLoadAttempt((value) => value + 1)} className="tl-button-quiet mt-4">
            Try again
          </button>
        </ErrorNotice>
      ) : !payload ? (
        <p className="text-sm text-subtle">Loading…</p>
      ) : (
        <>
          {listErrors.length > 0 && (
            <Notice tone="error" role="alert">
              {listErrors.join(' ')}
            </Notice>
          )}

          {drafts.length === 0 ? (
            <p className="text-sm text-muted">
              No contact details yet. People who are told to contact you are shown an empty list until you add one.
            </p>
          ) : (
            <ol className="space-y-4" aria-label="Contact channels">
              {drafts.map((draft, index) => (
                <ChannelRow
                  key={draft.key}
                  draft={draft}
                  index={index}
                  count={drafts.length}
                  errors={rowErrors[draft.key] ?? {}}
                  limits={limits}
                  onEdit={(field, value) => edit(draft.key, field, value)}
                  onMove={(delta) => setDrafts((current) => moveDraft(current, index, delta))}
                  onRemove={() => {
                    setDrafts((current) => current.filter((entry) => entry.key !== draft.key));
                    setNote('');
                  }}
                />
              ))}
            </ol>
          )}

          <div>
            <button
              type="button"
              className="tl-button-quiet"
              disabled={drafts.length >= limits.channels}
              title={drafts.length >= limits.channels ? `At most ${limits.channels} channels` : undefined}
              onClick={() => {
                setDrafts((current) => [...current, { key: makeKey(), type: 'email', label: '', value: '' }]);
                setNote('');
              }}
            >
              Add a channel
            </button>
          </div>

          <div>
            <div className="flex flex-wrap items-center gap-4">
              <button type="button" onClick={() => void save()} disabled={saving || unchanged} className="tl-button">
                {saving ? 'Saving…' : 'Save contact details'}
              </button>
              {/* The dialog as everybody sees it - what was SAVED, read from the public endpoint. */}
              <ContactAdminLink label="Preview what people see" />
            </div>
            {problem && <Status tone="error">{problem}</Status>}
            {note && <Status tone="ok">{note}</Status>}
          </div>
        </>
      )}
    </Section>
  );
}

function ChannelRow({
  draft,
  index,
  count,
  errors,
  limits,
  onEdit,
  onMove,
  onRemove,
}: {
  draft: ChannelDraft;
  index: number;
  count: number;
  errors: ChannelFieldErrors;
  limits: ContactEditorPayload['limits'];
  onEdit: (field: 'type' | 'label' | 'value', value: string) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  const id = `contact-${draft.key}`;
  const hint = CONTACT_VALUE_HINTS[draft.type];
  return (
    <li className="tl-card p-4">
      <div className="grid gap-4 md:grid-cols-[10rem_minmax(0,1fr)_minmax(0,1.5fr)]">
        <div className="min-w-0">
          <label htmlFor={`${id}-type`} className="tl-label">
            Type
          </label>
          <select
            id={`${id}-type`}
            className="tl-input mt-2"
            value={draft.type}
            onChange={(event) => onEdit('type', event.target.value)}
            aria-invalid={Boolean(errors.type)}
          >
            {CONTACT_TYPES.map((type) => (
              <option key={type} value={type}>
                {CONTACT_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
          {errors.type && <Status tone="error">{errors.type}</Status>}
        </div>
        <div className="min-w-0">
          <label htmlFor={`${id}-label`} className="tl-label">
            Label
          </label>
          <input
            id={`${id}-label`}
            type="text"
            className="tl-input mt-2"
            value={draft.label}
            maxLength={limits.label}
            placeholder={DEFAULT_CONTACT_LABELS[draft.type]}
            onChange={(event) => onEdit('label', event.target.value)}
            aria-invalid={Boolean(errors.label)}
          />
          {errors.label && <Status tone="error">{errors.label}</Status>}
        </div>
        <div className="min-w-0">
          <label htmlFor={`${id}-value`} className="tl-label">
            {draft.type === 'email' ? 'Address' : draft.type === 'whatsapp' ? 'Number' : draft.type === 'other' ? 'Link or text' : 'Username'}
          </label>
          <input
            id={`${id}-value`}
            type="text"
            className="tl-input mt-2"
            value={draft.value}
            // An address may run to 254 characters; everything else to the server's limit.
            maxLength={draft.type === 'email' ? 254 : limits.value}
            placeholder={hint.placeholder}
            onChange={(event) => onEdit('value', event.target.value)}
            aria-invalid={Boolean(errors.value)}
            aria-describedby={`${id}-hint`}
          />
          <p id={`${id}-hint`} className="mt-2 text-xs text-subtle">
            {hint.hint}
          </p>
          {errors.value && <Status tone="error">{errors.value}</Status>}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          className="tl-button-quiet"
          data-size="sm"
          disabled={index === 0}
          onClick={() => onMove(-1)}
          aria-label={`Move channel ${index + 1} up`}
        >
          Move up
        </button>
        <button
          type="button"
          className="tl-button-quiet"
          data-size="sm"
          disabled={index === count - 1}
          onClick={() => onMove(1)}
          aria-label={`Move channel ${index + 1} down`}
        >
          Move down
        </button>
        <button type="button" className="tl-button-quiet" data-size="sm" data-tone="danger" onClick={onRemove}>
          Remove
        </button>
      </div>
    </li>
  );
}
