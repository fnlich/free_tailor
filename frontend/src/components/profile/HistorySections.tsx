'use client';

import { useState } from 'react';
import { Card, ErrorNotice, Field, Section } from '@/components/ui/kit';
import {
  cleanSkillName,
  emptyCertification,
  emptyEducation,
  emptyExperience,
  hasSkill,
  type DraftCertification,
  type DraftEducation,
  type DraftExperience,
  type ProfileDraft,
} from '@/lib/profileDraft';
import {
  AddInput,
  AddRowButton,
  ChipList,
  RemoveRowButton,
  removeRow,
  replaceRow,
  type UpdateDraft,
} from './parts';

/** Experience: one card per role, its skills, and its achievements as typed. */
export function ExperienceSection({
  draft,
  update,
  libraryListId,
  ensureLibrarySkill,
}: {
  draft: ProfileDraft;
  update: UpdateDraft;
  /** The shared <datalist> of the hard-skill library. */
  libraryListId: string;
  /** The library's spelling of a skill, adding it first when the library lacks it. */
  ensureLibrarySkill: (skill: string) => Promise<string>;
}) {
  // Keyed by the row's own key, so a half-typed skill stays with its role
  // when another role is removed above it.
  const [pending, setPending] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const patch = (key: string, change: Partial<DraftExperience>) =>
    update((current) => ({ ...current, experience: replaceRow(current.experience, key, change) }));

  const addSkill = async (row: DraftExperience) => {
    const value = cleanSkillName(pending[row.key] ?? '');
    if (!value) return;
    const clear = () => setPending((current) => ({ ...current, [row.key]: '' }));
    if (hasSkill(row.skills, value)) {
      clear();
      return;
    }
    setBusyKey(row.key);
    setError(null);
    try {
      const skill = await ensureLibrarySkill(value);
      // A skill used in a role is a skill the profile claims, so it joins the
      // Technical Skills list too - as the old form did.
      update((current) => ({
        ...current,
        experience: current.experience.map((item) =>
          item.key === row.key && !hasSkill(item.skills, skill) ? { ...item, skills: [...item.skills, skill] } : item
        ),
        skills: hasSkill(current.skills, skill) ? current.skills : [...current.skills, skill],
      }));
      clear();
    } catch (err) {
      setError(err ?? 'Failed to add the skill.');
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <Section
      title="Experience"
      description="A role, company and dates are enough to start: tailoring writes a missing description and achievements from the job it is tailored to."
      actions={
        <AddRowButton
          onClick={() => update((current) => ({ ...current, experience: [...current.experience, emptyExperience()] }))}
        >
          + Add experience
        </AddRowButton>
      }
    >
      <ErrorNotice error={error} onDismiss={() => setError(null)} />
      {draft.experience.map((row, index) => (
        <Card
          key={row.key}
          title={row.title || row.company ? [row.title, row.company].filter(Boolean).join(' at ') : `Experience ${index + 1}`}
          actions={
            <RemoveRowButton
              label={`Remove experience ${index + 1}`}
              onClick={() => update((current) => ({ ...current, experience: removeRow(current.experience, row.key) }))}
            />
          }
        >
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 @lg:grid-cols-2">
              <input
                type="text"
                aria-label="Job title"
                placeholder="Job title"
                value={row.title}
                onChange={(event) => patch(row.key, { title: event.target.value })}
                className="tl-input"
              />
              <input
                type="text"
                aria-label="Company"
                placeholder="Company"
                value={row.company}
                onChange={(event) => patch(row.key, { company: event.target.value })}
                className="tl-input"
              />
              <input
                type="text"
                aria-label="Start date"
                placeholder="Start date (MM/YYYY)"
                value={row.startDate}
                onChange={(event) => patch(row.key, { startDate: event.target.value })}
                className="tl-input"
              />
              <input
                type="text"
                aria-label="End date"
                placeholder="End date (MM/YYYY or Present)"
                value={row.endDate}
                onChange={(event) => patch(row.key, { endDate: event.target.value })}
                className="tl-input"
              />
              <div className="@lg:col-span-2">
                <input
                  type="text"
                  aria-label="Location"
                  placeholder="Location"
                  value={row.location}
                  onChange={(event) => patch(row.key, { location: event.target.value })}
                  className="tl-input"
                />
              </div>
            </div>
            <textarea
              aria-label="Role description"
              placeholder="Brief description of the role"
              value={row.description}
              onChange={(event) => patch(row.key, { description: event.target.value })}
              className="tl-input"
              rows={2}
            />
            <Field label="Skills used" htmlFor={`experience-skill-${row.key}`}>
              <div className="space-y-3">
                <AddInput
                  id={`experience-skill-${row.key}`}
                  list={libraryListId}
                  value={pending[row.key] ?? ''}
                  onChange={(value) => setPending((current) => ({ ...current, [row.key]: value }))}
                  onAdd={() => addSkill(row)}
                  busy={busyKey === row.key}
                  placeholder="Select or add a hard skill"
                  label={`Add a skill to experience ${index + 1}`}
                />
                <ChipList
                  items={row.skills}
                  tone="sky"
                  onRemove={(skill) => patch(row.key, { skills: row.skills.filter((item) => item !== skill) })}
                />
              </div>
            </Field>
            <Field label="Achievements, one per line" htmlFor={`experience-achievements-${row.key}`}>
              <textarea
                id={`experience-achievements-${row.key}`}
                placeholder={'Led a team of 5 engineers...\nImproved performance by 50%...'}
                value={row.achievementsText}
                onChange={(event) => patch(row.key, { achievementsText: event.target.value })}
                className="tl-input"
                rows={4}
              />
            </Field>
          </div>
        </Card>
      ))}
    </Section>
  );
}

export function EducationSection({ draft, update }: { draft: ProfileDraft; update: UpdateDraft }) {
  const patch = (key: string, change: Partial<DraftEducation>) =>
    update((current) => ({ ...current, education: replaceRow(current.education, key, change) }));

  return (
    <Section
      title="Education"
      actions={
        <AddRowButton
          onClick={() => update((current) => ({ ...current, education: [...current.education, emptyEducation()] }))}
        >
          + Add education
        </AddRowButton>
      }
    >
      {draft.education.map((row, index) => (
        <Card
          key={row.key}
          title={row.degree || row.institution || `Education ${index + 1}`}
          actions={
            <RemoveRowButton
              label={`Remove education ${index + 1}`}
              onClick={() => update((current) => ({ ...current, education: removeRow(current.education, row.key) }))}
            />
          }
        >
          <div className="grid grid-cols-1 gap-4 @lg:grid-cols-2">
            <input
              type="text"
              aria-label="Degree"
              placeholder="Degree (e.g., Bachelor's in Computer Science)"
              value={row.degree}
              onChange={(event) => patch(row.key, { degree: event.target.value })}
              className="tl-input"
            />
            <input
              type="text"
              aria-label="Institution"
              placeholder="Institution"
              value={row.institution}
              onChange={(event) => patch(row.key, { institution: event.target.value })}
              className="tl-input"
            />
            <input
              type="text"
              aria-label="Start date"
              placeholder="Start date (MM/YYYY)"
              value={row.startDate}
              onChange={(event) => patch(row.key, { startDate: event.target.value })}
              className="tl-input"
            />
            <input
              type="text"
              aria-label="End date"
              placeholder="End date (MM/YYYY)"
              value={row.endDate}
              onChange={(event) => patch(row.key, { endDate: event.target.value })}
              className="tl-input"
            />
            <div className="@lg:col-span-2">
              <input
                type="text"
                aria-label="Location"
                placeholder="Location"
                value={row.location}
                onChange={(event) => patch(row.key, { location: event.target.value })}
                className="tl-input"
              />
            </div>
          </div>
        </Card>
      ))}
    </Section>
  );
}

export function CertificationsSection({
  draft,
  update,
  templatePrintsThem,
  templateName,
}: {
  draft: ProfileDraft;
  update: UpdateDraft;
  /** Whether the chosen template has a place for them; null while templates load. */
  templatePrintsThem: boolean | null;
  templateName: string;
}) {
  const patch = (key: string, change: Partial<DraftCertification>) =>
    update((current) => ({ ...current, certifications: replaceRow(current.certifications, key, change) }));

  return (
    <Section
      title="Certifications"
      description={
        templatePrintsThem === false && draft.certifications.length > 0
          ? `${templateName} has no Certifications section, so they are not printed with it. Tailoring still reads them.`
          : 'Tailoring reads them, and a template with a Certifications section prints them.'
      }
      actions={
        <AddRowButton
          onClick={() =>
            update((current) => ({ ...current, certifications: [...current.certifications, emptyCertification()] }))
          }
        >
          + Add certification
        </AddRowButton>
      }
    >
      {draft.certifications.map((row, index) => (
        <Card
          key={row.key}
          title={row.name || `Certification ${index + 1}`}
          actions={
            <RemoveRowButton
              label={`Remove certification ${index + 1}`}
              onClick={() =>
                update((current) => ({ ...current, certifications: removeRow(current.certifications, row.key) }))
              }
            />
          }
        >
          <div className="grid grid-cols-1 gap-4 @lg:grid-cols-2">
            <div className="@lg:col-span-2">
              <input
                type="text"
                aria-label="Certification name"
                placeholder="Certification (e.g., AWS Certified Solutions Architect)"
                value={row.name}
                onChange={(event) => patch(row.key, { name: event.target.value })}
                className="tl-input"
              />
            </div>
            <input
              type="text"
              aria-label="Issuer"
              placeholder="Issuer"
              value={row.issuer}
              onChange={(event) => patch(row.key, { issuer: event.target.value })}
              className="tl-input"
            />
            <input
              type="text"
              aria-label="Date"
              placeholder="Date (MM/YYYY)"
              value={row.date}
              onChange={(event) => patch(row.key, { date: event.target.value })}
              className="tl-input"
            />
          </div>
        </Card>
      ))}
    </Section>
  );
}
