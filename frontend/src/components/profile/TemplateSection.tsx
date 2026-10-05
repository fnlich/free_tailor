'use client';

import { Field, Notice, Pill, Section } from '@/components/ui/kit';
import type { Template, TechnicalSkillsLayout } from '@/lib/api';
import {
  LAYOUT_LABELS,
  templateOffersLayout,
  templateSkillsLayouts,
  type TemplateOption,
} from '@/lib/profileDraft';

/**
 * The template picker.
 *
 * It lists only the templates that offer the profile's Technical Skills
 * layout - a category grid has nothing sensible to do with a plain list - and
 * says how many it is leaving out and why. A template another profile already
 * uses is listed but cannot be picked, with that profile's name on it, so a
 * short list never looks short for no reason.
 */
export function TemplateSection({
  options,
  templates,
  loaded,
  selectedId,
  layout,
  onSelect,
}: {
  /** The templates offering `layout`, each marked pickable or not. */
  options: readonly TemplateOption[];
  /** Every template this account can see, for the ones the filter leaves out. */
  templates: readonly Template[];
  loaded: boolean;
  /** The template the draft renders with. */
  selectedId: string;
  layout: TechnicalSkillsLayout;
  onSelect: (templateId: string) => void;
}) {
  const label = LAYOUT_LABELS[layout];
  const selected = templates.find((template) => template.id === selectedId) ?? null;
  // Nothing at all came back: the list failed to load, which says nothing
  // about whether this profile's template still exists.
  const listFailed = loaded && templates.length === 0;
  const listed = listFailed || options.some((option) => option.template.id === selectedId);
  const leftOut = templates.length - options.length;
  const offersBoth = selected ? templateSkillsLayouts(selected).length > 1 : false;

  return (
    <Section title="Template" description="How the resume looks. The preview redraws as soon as you pick one.">
      <Field
        label="Choose a template"
        htmlFor="profile-template"
        hint={
          loaded && !listFailed
            ? `${options.length} template${options.length === 1 ? '' : 's'} offer${options.length === 1 ? 's' : ''} the ${label} layout${
                leftOut > 0 ? `; ${leftOut} more offer${leftOut === 1 ? 's' : ''} only the other one` : ''
              }. The layout is chosen under Technical skills.`
            : undefined
        }
      >
        <select
          id="profile-template"
          value={selectedId}
          disabled={!loaded || listFailed}
          onChange={(event) => onSelect(event.target.value)}
          className="tl-input"
        >
          {!loaded && <option value={selectedId}>Loading templates...</option>}
          {listFailed && <option value={selectedId}>{selectedId}</option>}
          {loaded && !listed && (
            <option value={selectedId} disabled>
              {selected
                ? `${selected.name} (no ${label} layout)`
                : `${selectedId} (no longer available)`}
            </option>
          )}
          {loaded &&
            options.map((option) => (
              <option key={option.template.id} value={option.template.id} disabled={!option.selectable}>
                {option.template.name}
                {option.usedBy ? ` (used by ${option.usedBy})` : ''}
              </option>
            ))}
        </select>
      </Field>

      {listFailed && (
        <Notice tone="warn" role="status">
          The template list could not be loaded, so another one cannot be picked right now. The preview
          still draws with this profile&apos;s template; reload the page to try again.
        </Notice>
      )}

      {loaded && !listed && (
        <Notice tone="warn" role="status">
          {selected
            ? `${selected.name} cannot print the ${label} layout, so resumes for this profile are drawn with another template - the preview says which. Pick one here to choose it yourself.`
            : 'The template this profile used is no longer offered, so resumes for it are drawn with another one - the preview says which. Pick one here to choose it yourself.'}
        </Notice>
      )}

      {selected && (
        <div className="space-y-2">
          {selected.description && <p className="text-sm text-muted">{selected.description}</p>}
          <div className="flex flex-wrap gap-2">
            <Pill tone="sky">{offersBoth ? 'Grouped and Plain' : `${LAYOUT_LABELS[templateSkillsLayouts(selected)[0]]} only`}</Pill>
            <Pill tone={selected.supportsStrengths === false ? 'grey' : 'green'}>
              {selected.supportsStrengths === false ? 'No Strengths section' : 'Strengths section'}
            </Pill>
            <Pill tone={selected.supportsSoftSkills === false ? 'grey' : 'green'}>
              {selected.supportsSoftSkills === false ? 'No Soft Skills section' : 'Soft Skills section'}
            </Pill>
            {!templateOffersLayout(selected, layout) && <Pill tone="amber">Not for {label}</Pill>}
          </div>
        </div>
      )}
    </Section>
  );
}
