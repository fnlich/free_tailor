'use client';

import { Field, Notice, Pill } from '@/components/ui/kit';
import type { Template, TechnicalSkillsLayout } from '@/lib/api';
import { LAYOUT_LABELS } from '@/lib/resumeDraft';
import { SettingsCard } from './parts';
import css from './resumeEditor.module.css';

const LAYOUT_CHOICES: Array<{ value: TechnicalSkillsLayout; description: string }> = [
  {
    value: 'categorized',
    description: 'Skills under headings. A tailored resume prints the groups written for the job, as written.',
  },
  {
    value: 'flat',
    description: 'One list of skill names with no headings over it - a tailored resume\'s groups run together, repeats removed.',
  },
];

/**
 * The one sentence on how the Content tab's cards relate to the page: their
 * order is the resume's, inside whatever column the template gives each
 * section.
 */
export const SECTION_ORDER_HINT =
  'Sections print in the order of the cards on the Content tab, within the column the template puts each one in - a sidebar template keeps Skills in its sidebar wherever its card sits.';

/**
 * The Customize tab's Template card: the picker, what the chosen template
 * prints, and what to do when it cannot be drawn as asked.
 *
 * The picker lists every enabled template - each prints Technical Skills
 * both ways, so the layout leaves none out - and any resume may use any
 * template, whoever else uses it.
 */
export function TemplateCard({
  templates,
  loaded,
  selectedId,
  onSelect,
}: {
  /** Every template on offer to this account. */
  templates: readonly Template[];
  loaded: boolean;
  /** The template the draft renders with. */
  selectedId: string;
  onSelect: (templateId: string) => void;
}) {
  const selected = templates.find((template) => template.id === selectedId) ?? null;
  // Nothing at all came back: the list failed to load, which says nothing
  // about whether this resume's template still exists.
  const listFailed = loaded && templates.length === 0;
  const listed = listFailed || selected !== null;

  return (
    <SettingsCard title="Template" description="How the resume looks. The preview redraws as soon as you pick one.">
      <Field
        label="Design template"
        htmlFor="resume-template"
        hint="Every template prints Technical Skills both ways - Grouped or Plain, as the Layout card below says."
      >
        <select
          id="resume-template"
          value={selectedId}
          disabled={!loaded || listFailed}
          onChange={(event) => onSelect(event.target.value)}
          className="tl-input"
        >
          {!loaded && <option value={selectedId}>Loading templates...</option>}
          {listFailed && <option value={selectedId}>{selectedId}</option>}
          {loaded && !listed && (
            <option value={selectedId} disabled>
              {`${selectedId} (no longer available)`}
            </option>
          )}
          {loaded &&
            templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
        </select>
      </Field>

      {listFailed && (
        <Notice tone="warn" role="status">
          The template list could not be loaded, so another one cannot be picked right now. The preview
          still draws with this resume&apos;s template; reload the page to try again.
        </Notice>
      )}

      {loaded && !listed && (
        <Notice tone="warn" role="status">
          The template this resume used is no longer offered, so resumes for it are drawn with another one - the
          preview says which. Pick one here to choose it yourself.
        </Notice>
      )}

      {selected && (
        <div className="space-y-3">
          {selected.description && <p className="text-sm text-muted">{selected.description}</p>}
          <div className="flex flex-wrap gap-2">
            <Pill tone={selected.supportsStrengths ? 'green' : 'grey'}>
              {selected.supportsStrengths ? 'Strengths section' : 'No Strengths section'}
            </Pill>
            <Pill tone={selected.supportsSoftSkills ? 'green' : 'grey'}>
              {selected.supportsSoftSkills ? 'Soft Skills section' : 'No Soft Skills section'}
            </Pill>
          </div>
        </div>
      )}
    </SettingsCard>
  );
}

/**
 * The Customize tab's Layout card: the Technical Skills layout and the
 * section order. Every template prints both layouts, so a change here changes
 * how Technical Skills is drawn and nothing else - the template stays.
 * "Use the template's order" is here because the template is what the Content
 * tab's cards follow once the person's own order is let go.
 */
export function LayoutCard({
  layout,
  onLayoutChange,
  ownOrder,
  onUseTemplateOrder,
}: {
  layout: TechnicalSkillsLayout;
  onLayoutChange: (layout: TechnicalSkillsLayout) => void;
  /** Whether the cards stand in an order of the person's own rather than the template's. */
  ownOrder: boolean;
  onUseTemplateOrder: () => void;
}) {
  return (
    <SettingsCard title="Layout" description="How Technical Skills is laid out, and the order the sections print in.">
      <fieldset>
        <legend className="tl-label">Technical skills layout</legend>
        <div className={`${css.choices} mt-3`}>
          {LAYOUT_CHOICES.map((choice) => (
            <label
              key={choice.value}
              htmlFor={`resume-layout-${choice.value}`}
              className="tl-choice"
              data-on={layout === choice.value ? 'true' : 'false'}
            >
              <input
                id={`resume-layout-${choice.value}`}
                type="radio"
                name="resume-technical-skills-layout"
                value={choice.value}
                checked={layout === choice.value}
                onChange={() => onLayoutChange(choice.value)}
              />
              <span className="min-w-0">
                <span className="block font-semibold text-ink">{LAYOUT_LABELS[choice.value]}</span>
                <span className="mt-1 block text-sm text-muted">{choice.description}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className={css.orderHint}>
        <p className="text-sm text-muted">{SECTION_ORDER_HINT}</p>
        {ownOrder && (
          <button type="button" className="tl-button-quiet" data-size="sm" onClick={onUseTemplateOrder}>
            Use the template&apos;s order
          </button>
        )}
      </div>
    </SettingsCard>
  );
}
