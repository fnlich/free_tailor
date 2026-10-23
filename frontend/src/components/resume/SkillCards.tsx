'use client';

import { useState } from 'react';
import { ErrorNotice, Field } from '@/components/ui/kit';
import {
  MAX_SOFT_SKILL_LENGTH,
  MAX_SOFT_SKILLS,
  cleanSkillName,
  hasSkill,
  keptCount,
  keptNote,
  softSkillRefusal,
  type ResumeDraft,
} from '@/lib/resumeDraft';
import { SECTION_KIND_BY_ID } from '@/lib/sectionCatalogue';
import { AddInput, ChipList, KeptLine, SectionSwitch, SwitchCapabilityNote, type UpdateDraft } from './parts';
import { SectionCard, type CardFrame } from './SectionCard';
import chrome from '@/components/admin/resumeTemplateChrome.module.css';

/**
 * Technical skills: the skills themselves and - when Grouped - the heading
 * each one goes under. The layout they print in is chosen in the Layout card
 * on Customize; every template prints both.
 */
export function TechnicalSkillsCard({
  draft,
  update,
  headingOptions,
  libraryListId,
  ensureLibrarySkill,
  frame,
}: {
  draft: ResumeDraft;
  update: UpdateDraft;
  headingOptions: readonly string[];
  libraryListId: string;
  ensureLibrarySkill: (skill: string) => Promise<string>;
  frame: CardFrame;
}) {
  const spec = SECTION_KIND_BY_ID.skills;
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const grouped = draft.settings.technicalSkillsLayout === 'categorized';
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
      // not the resume still lists it up top.
    }));

  return (
    <SectionCard label={spec.label} icon={spec.icon} description={spec.description} frame={frame}>
      <Field
        label="Skills"
        htmlFor="resume-hard-skill-input"
        hint={
          grouped
            ? 'The headings an untailored resume prints. A skill left on "Work it out" is filed by the shared skill library; pick a heading when the library would put it somewhere else - it cannot know that your Vault is infrastructure rather than a library.'
            : hasHeadings
              ? 'Plain prints no headings. The ones you assigned are kept, and come back if you switch to Grouped.'
              : undefined
        }
      >
        <div className="space-y-3">
          <AddInput
            id="resume-hard-skill-input"
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
    </SectionCard>
  );
}

export function SoftSkillsCard({
  draft,
  update,
  templateSupports,
  templateName,
  frame,
}: {
  draft: ResumeDraft;
  update: UpdateDraft;
  /** Whether the chosen template has a Soft Skills section; null while templates load. */
  templateSupports: boolean | null;
  templateName: string;
  frame: CardFrame;
}) {
  const spec = SECTION_KIND_BY_ID.softSkills;
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
    <SectionCard label={spec.label} icon={spec.icon} frame={frame}>
      <SectionSwitch
        id="resume-include-soft-skills"
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
          ? 'A tailored resume prints the soft skills the job asks for in this section; an untailored one, and the preview here, print your own below.'
          : 'Off: no Soft Skills section is printed. A tailored resume prints the soft skills the job asks for as the last group of Technical Skills.'}
      </SectionSwitch>
      <SwitchCapabilityNote
        on={on}
        supported={templateSupports}
        section="Soft Skills"
        templateName={templateName}
        whenOff="a tailored resume's soft skills are the last group of its Technical Skills."
      />
      {!on ? (
        <KeptLine note={keptNote(keptCount(draft, 'softSkills'), 'softSkills')} />
      ) : (
        <div className="space-y-3">
          <AddInput
            id="resume-soft-skill-input"
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
    </SectionCard>
  );
}
