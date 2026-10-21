'use client';

import { useState } from 'react';
import { Field } from '@/components/ui/kit';
import {
  SAMPLE_PLACEHOLDERS,
  MAX_INTERESTS,
  MAX_INTEREST_LENGTH,
  cleanSkillName,
  interestRefusal,
  type DraftContact,
  type ProfileDraft,
} from '@/lib/profileDraft';
import { SECTION_KIND_BY_ID } from '@/lib/profileSections';
import { AddInput, ChipList, DoneButton, EditorPanel, NotPrintedNote, type UpdateDraft } from './parts';
import { SectionCard, type CardFrame } from './SectionCard';

/*
 * Each placeholder is the sample resume's own text for that field: the
 * preview draws an empty field with exactly that, so the grey words in a
 * blank input and the ones on the page beside it are visibly the same thing
 * (lib/profileDraft.ts, SAMPLE_PLACEHOLDERS).
 */

/** The summary, typed straight into its card. */
export function SummaryCard({ draft, update, frame }: { draft: ProfileDraft; update: UpdateDraft; frame: CardFrame }) {
  const spec = SECTION_KIND_BY_ID.summary;
  return (
    <SectionCard label={spec.label} icon={spec.icon} description={spec.description} frame={frame}>
      <textarea
        id="profile-summary"
        rows={5}
        value={draft.summary}
        onChange={(event) => update((current) => ({ ...current, summary: event.target.value }))}
        className="tl-input"
        aria-label="Professional summary"
        placeholder={SAMPLE_PLACEHOLDERS.summary}
      />
    </SectionCard>
  );
}

/** The interests: a chip list with the soft skills' limits, printed on one line. */
export function InterestsCard({
  draft,
  update,
  templatePrints,
  templateName,
  frame,
}: {
  draft: ProfileDraft;
  update: UpdateDraft;
  /** Whether the chosen template prints them; null while templates load. */
  templatePrints: boolean | null;
  templateName: string;
  frame: CardFrame;
}) {
  const spec = SECTION_KIND_BY_ID.interests;
  const [input, setInput] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const full = draft.interests.length >= MAX_INTERESTS;

  const add = () => {
    const value = cleanSkillName(input);
    if (!value) return;
    const reason = interestRefusal(draft.interests, value);
    setRefusal(reason);
    if (reason) return;
    update((current) => ({ ...current, interests: [...current.interests, value] }));
    setInput('');
  };

  return (
    <SectionCard label={spec.label} icon={spec.icon} description={spec.description} frame={frame}>
      <NotPrintedNote prints={templatePrints} count={draft.interests.length} label={spec.heading} templateName={templateName} />
      <div className="space-y-3">
        <AddInput
          id="profile-interest-input"
          value={input}
          onChange={(value) => {
            setInput(value);
            setRefusal(null);
          }}
          onAdd={add}
          maxLength={MAX_INTEREST_LENGTH}
          disabled={full}
          placeholder={full ? `At most ${MAX_INTERESTS} interests` : 'Add an interest, e.g. Trail running'}
          label="Add an interest"
        />
        {refusal && (
          <p className="tl-status" data-tone="error" role="alert">
            {refusal}
          </p>
        )}
        <ChipList
          items={draft.interests}
          tone="violet"
          onRemove={(item) =>
            update((current) => ({ ...current, interests: current.interests.filter((entry) => entry !== item) }))
          }
        />
      </div>
    </SectionCard>
  );
}

const CONTACT_FIELDS: Array<{
  key: keyof DraftContact;
  label: string;
  type: string;
  inputMode?: 'url';
  placeholder?: string;
  autoComplete: string;
}> = [
  { key: 'email', label: 'Email', type: 'email', placeholder: SAMPLE_PLACEHOLDERS.email, autoComplete: 'email' },
  { key: 'phone', label: 'Phone', type: 'tel', placeholder: SAMPLE_PLACEHOLDERS.phone, autoComplete: 'tel' },
  { key: 'location', label: 'Location', type: 'text', placeholder: SAMPLE_PLACEHOLDERS.location, autoComplete: 'off' },
  {
    key: 'linkedin',
    label: 'LinkedIn URL',
    // Text, not `url`: the browser's url check refuses `linkedin.com/in/x`,
    // which is how most people write it and how imported profiles hold it,
    // and would block the whole save. The server adds https:// itself and
    // drops anything that is not an http(s) link (pdfGenerator's
    // normalizeExternalUrl). inputMode still brings up the URL keyboard.
    type: 'text',
    inputMode: 'url',
    placeholder: SAMPLE_PLACEHOLDERS.linkedin,
    autoComplete: 'url',
  },
  { key: 'github', label: 'GitHub URL', type: 'text', inputMode: 'url', placeholder: 'github.com/you', autoComplete: 'url' },
  {
    key: 'portfolio',
    label: 'Portfolio URL',
    type: 'text',
    inputMode: 'url',
    placeholder: 'yoursite.example.com',
    autoComplete: 'url',
  },
];

/**
 * The Basics panel: the name, title and years at the top of the resume, and
 * the contact line. Opened from the header card's pencil; Done closes it.
 */
export function BasicsPanel({ draft, update, onDone }: { draft: ProfileDraft; update: UpdateDraft; onDone: () => void }) {
  return (
    <EditorPanel
      title="Name and contact details"
      eyebrow="Personal details"
      onBack={onDone}
      footer={<DoneButton onClick={onDone} />}
    >
      <div className="grid grid-cols-1 gap-x-4 gap-y-5 @lg:grid-cols-2">
        <Field label="Full name" htmlFor="profile-name">
          <input
            id="profile-name"
            type="text"
            value={draft.name}
            onChange={(event) => update((current) => ({ ...current, name: event.target.value }))}
            className="tl-input"
            placeholder={SAMPLE_PLACEHOLDERS.name}
            autoComplete="off"
            autoFocus
          />
        </Field>
        <Field label="Professional title" htmlFor="profile-title">
          <input
            id="profile-title"
            type="text"
            value={draft.title}
            onChange={(event) => update((current) => ({ ...current, title: event.target.value }))}
            className="tl-input"
            placeholder={SAMPLE_PLACEHOLDERS.title}
          />
        </Field>
        <Field
          label="Total years of experience"
          htmlFor="profile-years"
          hint="Given to tailoring; not printed by itself."
        >
          <input
            id="profile-years"
            type="number"
            min="0"
            step="0.5"
            inputMode="decimal"
            value={draft.totalYearsExperience}
            onChange={(event) =>
              update((current) => ({ ...current, totalYearsExperience: event.target.value }))
            }
            className="tl-input"
            placeholder="e.g., 4"
          />
        </Field>
        {CONTACT_FIELDS.map((field) => (
          <Field key={field.key} label={field.label} htmlFor={`profile-contact-${field.key}`}>
            <input
              id={`profile-contact-${field.key}`}
              type={field.type}
              inputMode={field.inputMode}
              value={draft.contact[field.key]}
              onChange={(event) =>
                update((current) => ({
                  ...current,
                  contact: { ...current.contact, [field.key]: event.target.value },
                }))
              }
              className="tl-input"
              placeholder={field.placeholder}
              autoComplete={field.autoComplete}
            />
          </Field>
        ))}
      </div>
    </EditorPanel>
  );
}
