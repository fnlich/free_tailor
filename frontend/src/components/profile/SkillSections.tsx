'use client';

import { useState } from 'react';
import { Card, ErrorNotice, Field, Notice, Section } from '@/components/ui/kit';
import type { TechnicalSkillsLayout } from '@/lib/api';
import {
  LAYOUT_LABELS,
  MAX_SOFT_SKILL_LENGTH,
  MAX_SOFT_SKILLS,
  cleanSkillName,
  emptyStrength,
  hasSkill,
  keptCount,
  keptNote,
  softSkillRefusal,
  type DraftStrength,
  type ProfileDraft,
} from '@/lib/profileDraft';
import {
  AddInput,
  AddRowButton,
  ChipList,
  RemoveRowButton,
  SectionSwitch,
  removeRow,
  replaceRow,
  type UpdateDraft,
} from './parts';
import chrome from '@/components/admin/profileTemplateChrome.module.css';
import css from './profileEditor.module.css';

const LAYOUT_CHOICES: Array<{ value: TechnicalSkillsLayout; description: string }> = [
  {
    value: 'categorized',
    description: 'Skills under headings - Languages, Cloud and Infrastructure, and so on.',
  },
  {
    value: 'flat',
    description: 'One list of skill names, with no headings over it.',
  },
];

/**
 * Technical skills: the layout they print in, the skills themselves, and -
 * when Grouped - the heading each one goes under.
 */
export function TechnicalSkillsSection({
  draft,
  update,
  onLayoutChange,
  layoutNotice,
  templateCounts,
  headingOptions,
  libraryListId,
  ensureLibrarySkill,
}: {
  draft: ProfileDraft;
  update: UpdateDraft;
  /** The editor's, because a layout change can move the profile to another template. */
  onLayoutChange: (layout: TechnicalSkillsLayout) => void;
  /** Said once after a layout change moved the template. */
  layoutNotice: string | null;
  /** How many templates offer each layout; null while they load. */
  templateCounts: Record<TechnicalSkillsLayout, number> | null;
  headingOptions: readonly string[];
  libraryListId: string;
  ensureLibrarySkill: (skill: string) => Promise<string>;
}) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const layout = draft.settings.technicalSkillsLayout;
  const grouped = layout === 'categorized';
  const hasHeadings = Object.values(draft.skillCategoryBySkill).some((heading) => heading.trim());

  const addSkill = async () => {
    const value = cleanSkillName(input);
    if (!value) return;
    if (hasSkill(draft.skills, value)) {
      setInput('');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const skill = await ensureLibrarySkill(value);
      update((current) => ({
        ...current,
        skills: hasSkill(current.skills, skill) ? current.skills : [...current.skills, skill],
      }));
      setInput('');
    } catch (err) {
      setError(err ?? 'Failed to add the skill.');
    } finally {
      setBusy(false);
    }
  };

  const removeSkill = (skill: string) =>
    update((current) => ({
      ...current,
      skills: current.skills.filter((item) => item !== skill),
      // Each experience keeps its own list: a role used a skill whether or
      // not the profile still lists it up top.
    }));

  return (
    <Section
      title="Technical skills"
      description="The skills the profile claims. Tailoring picks the ones each job asks for."
    >
      <fieldset>
        <legend className="tl-label">Layout</legend>
        <div className={`${css.choices} mt-2`}>
          {LAYOUT_CHOICES.map((choice) => {
            const count = templateCounts?.[choice.value];
            return (
              <label
                key={choice.value}
                htmlFor={`profile-layout-${choice.value}`}
                className="tl-choice"
                data-on={layout === choice.value ? 'true' : 'false'}
              >
                <input
                  id={`profile-layout-${choice.value}`}
                  type="radio"
                  name="profile-technical-skills-layout"
                  value={choice.value}
                  checked={layout === choice.value}
                  onChange={() => onLayoutChange(choice.value)}
                />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-ink">{LAYOUT_LABELS[choice.value]}</span>
                  <span className="mt-1 block text-sm text-muted">{choice.description}</span>
                  {typeof count === 'number' && (
                    <span className="mt-1 block text-xs text-subtle">
                      {count} template{count === 1 ? '' : 's'} offer{count === 1 ? 's' : ''} it
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {layoutNotice && (
        <Notice tone="info" role="status">
          {layoutNotice}
        </Notice>
      )}

      <Field
        label="Skills"
        htmlFor="profile-hard-skill-input"
        hint={
          grouped
            ? 'A skill left on "Work it out" is filed by the shared skill library. Pick a heading when the library would put it somewhere else - it cannot know that your Vault is infrastructure rather than a library.'
            : hasHeadings
              ? 'Plain prints no headings. The ones you assigned are kept, and come back if you switch to Grouped.'
              : undefined
        }
      >
        <div className="space-y-3">
          <AddInput
            id="profile-hard-skill-input"
            list={libraryListId}
            value={input}
            onChange={setInput}
            onAdd={addSkill}
            busy={busy}
            placeholder="Add a hard skill"
            label="Add a hard skill"
          />
          <ErrorNotice error={error} onDismiss={() => setError(null)} />
          <ChipList
            items={draft.skills}
            tone="sky"
            onRemove={removeSkill}
            renderExtra={
              grouped
                ? (skill) => (
                    <select
                      value={draft.skillCategoryBySkill[skill] ?? ''}
                      onChange={(event) =>
                        update((current) => ({
                          ...current,
                          skillCategoryBySkill: { ...current.skillCategoryBySkill, [skill]: event.target.value },
                        }))
                      }
                      aria-label={`Heading for ${skill}`}
                      className={chrome.chipSelect}
                    >
                      <option value="">Work it out</option>
                      {headingOptions.map((heading) => (
                        <option key={heading} value={heading}>
                          {heading}
                        </option>
                      ))}
                    </select>
                  )
                : undefined
            }
          />
        </div>
      </Field>
    </Section>
  );
}

/**
 * What an unticked section shows in place of its list: one line saying how
 * many entries are kept. Nothing is deleted - they are saved with the profile
 * as they are and come back to edit when the box is ticked again.
 */
function KeptLine({ note }: { note: string | null }) {
  if (!note) return null;
  return (
    <p className="text-sm text-muted" role="status">
      {note}
    </p>
  );
}

/** The note under a section switch when the template has nowhere to print it. */
function capabilityNote(on: boolean, supported: boolean | null, section: string, templateName: string) {
  if (!on || supported !== false) return null;
  return (
    <Notice tone="warn" role="status">
      {templateName} has no {section} section; ticking it changes nothing here. Another template prints it.
    </Notice>
  );
}

export function SoftSkillsSection({
  draft,
  update,
  templateSupports,
  templateName,
}: {
  draft: ProfileDraft;
  update: UpdateDraft;
  /** Whether the chosen template has a Soft Skills section; null while templates load. */
  templateSupports: boolean | null;
  templateName: string;
}) {
  const [input, setInput] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const on = draft.settings.includeSoftSkills;

  const add = () => {
    const value = cleanSkillName(input);
    if (!value) return;
    const reason = softSkillRefusal(draft.softSkills, value);
    setRefusal(reason);
    if (reason) return;
    update((current) => ({ ...current, softSkills: [...current.softSkills, value] }));
    setInput('');
  };

  return (
    <Section title="Soft skills">
      <SectionSwitch
        id="profile-include-soft-skills"
        checked={on}
        onChange={(checked) =>
          update(
            (current) => ({ ...current, settings: { ...current.settings, includeSoftSkills: checked } }),
            { immediate: true }
          )
        }
        label="Print a Soft Skills section"
      >
        {on
          ? 'Your soft skills print first, and tailoring adds the ones a job asks for.'
          : 'Off: no Soft Skills section is printed, and tailoring works the soft skills a job asks for into the summary instead.'}
      </SectionSwitch>
      {capabilityNote(on, templateSupports, 'Soft Skills', templateName)}
      {!on ? (
        <KeptLine note={keptNote(keptCount(draft, 'softSkills'), 'softSkills')} />
      ) : (
        <div className="space-y-3">
          <AddInput
            id="profile-soft-skill-input"
            value={input}
            onChange={(value) => {
              setInput(value);
              setRefusal(null);
            }}
            onAdd={add}
            maxLength={MAX_SOFT_SKILL_LENGTH}
            disabled={draft.softSkills.length >= MAX_SOFT_SKILLS}
            placeholder={
              draft.softSkills.length >= MAX_SOFT_SKILLS
                ? `At most ${MAX_SOFT_SKILLS} soft skills`
                : 'Add a soft skill, e.g. Stakeholder communication'
            }
            label="Add a soft skill"
          />
          {refusal && (
            <p className="tl-status" data-tone="error" role="alert">
              {refusal}
            </p>
          )}
          <ChipList
            items={draft.softSkills}
            tone="green"
            onRemove={(skill) =>
              update((current) => ({ ...current, softSkills: current.softSkills.filter((item) => item !== skill) }))
            }
          />
        </div>
      )}
    </Section>
  );
}

export function StrengthsSection({
  draft,
  update,
  templateSupports,
  templateName,
}: {
  draft: ProfileDraft;
  update: UpdateDraft;
  /** Whether the chosen template has a Strengths section; null while templates load. */
  templateSupports: boolean | null;
  templateName: string;
}) {
  const on = draft.settings.includeStrengths;
  const patch = (key: string, change: Partial<DraftStrength>) =>
    update((current) => ({ ...current, strengths: replaceRow(current.strengths, key, change) }));

  return (
    <Section
      title="Strengths"
      actions={
        // Only while the section is on: an unticked one shows its switch and
        // what it keeps, and nothing to add to or edit.
        on ? (
          <AddRowButton
            onClick={() => update((current) => ({ ...current, strengths: [...current.strengths, emptyStrength()] }))}
          >
            + Add strength
          </AddRowButton>
        ) : undefined
      }
    >
      <SectionSwitch
        id="profile-include-strengths"
        checked={on}
        onChange={(checked) =>
          update(
            (current) => ({ ...current, settings: { ...current.settings, includeStrengths: checked } }),
            { immediate: true }
          )
        }
        label="Print a Strengths section"
      >
        {on
          ? 'Tailoring writes two to four strengths for each job, starting from yours.'
          : 'Off: no Strengths section is printed or written, and tailoring is not given them.'}
      </SectionSwitch>
      {capabilityNote(on, templateSupports, 'Strengths', templateName)}
      {!on && <KeptLine note={keptNote(keptCount(draft, 'strengths'), 'strengths')} />}
      {on && draft.strengths.map((row, index) => (
        <Card
          key={row.key}
          title={row.title || `Strength ${index + 1}`}
          actions={
            <RemoveRowButton
              label={`Remove strength ${index + 1}`}
              onClick={() => update((current) => ({ ...current, strengths: removeRow(current.strengths, row.key) }))}
            />
          }
        >
          <div className="space-y-4">
            <input
              type="text"
              aria-label="Strength title"
              placeholder="Title (e.g., Customer-Centric)"
              value={row.title}
              onChange={(event) => patch(row.key, { title: event.target.value })}
              className="tl-input"
            />
            <textarea
              aria-label="Strength description"
              placeholder="One or two sentences, with a number if there is one"
              value={row.description}
              onChange={(event) => patch(row.key, { description: event.target.value })}
              className="tl-input"
              rows={2}
            />
          </div>
        </Card>
      ))}
    </Section>
  );
}
