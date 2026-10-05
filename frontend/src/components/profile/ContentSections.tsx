'use client';

import { Field, Section } from '@/components/ui/kit';
import { SAMPLE_PLACEHOLDERS, type DraftContact, type ProfileDraft } from '@/lib/profileDraft';
import type { UpdateDraft } from './parts';

/*
 * Each placeholder is the sample resume's own text for that field: the
 * preview draws an empty field with exactly that, so the grey words in a
 * blank input and the ones on the page beside it are visibly the same thing
 * (lib/profileDraft.ts, SAMPLE_PLACEHOLDERS).
 */

/** Name, title and years: the header of the resume. */
export function BasicsSection({ draft, update }: { draft: ProfileDraft; update: UpdateDraft }) {
  return (
    <Section title="Basics" description="The name and title at the top of the resume.">
      <div className="grid grid-cols-1 gap-6 @lg:grid-cols-2">
        <Field label="Full name" htmlFor="profile-name">
          <input
            id="profile-name"
            type="text"
            value={draft.name}
            onChange={(event) => update((current) => ({ ...current, name: event.target.value }))}
            className="tl-input"
            placeholder={SAMPLE_PLACEHOLDERS.name}
            autoComplete="off"
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
      </div>
    </Section>
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
];

export function ContactSection({ draft, update }: { draft: ProfileDraft; update: UpdateDraft }) {
  return (
    <Section title="Contact">
      <div className="grid grid-cols-1 gap-6 @lg:grid-cols-2">
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
    </Section>
  );
}

export function SummarySection({ draft, update }: { draft: ProfileDraft; update: UpdateDraft }) {
  return (
    <Section title="Summary" description="Tailoring rewrites it for each job; this is where it starts.">
      <textarea
        id="profile-summary"
        rows={5}
        value={draft.summary}
        onChange={(event) => update((current) => ({ ...current, summary: event.target.value }))}
        className="tl-input"
        aria-label="Professional summary"
        placeholder={SAMPLE_PLACEHOLDERS.summary}
      />
    </Section>
  );
}
