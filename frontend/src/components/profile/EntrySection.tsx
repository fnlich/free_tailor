'use client';

import type { ReactNode } from 'react';
import { IconChevronRight, IconTrash } from '@/components/icons';
import type { DraftEntry } from '@/lib/profileDraft';
import { entrySummary, type SectionSpec } from '@/lib/profileSections';
import { AddRowButton, NotPrintedNote, type UpdateDraft } from './parts';
import { SectionCard, type CardFrame } from './SectionCard';
import css from './profileEditor.module.css';

/**
 * The card of every kind that is a list of entries - Experience, Education,
 * Certifications, Strengths, Projects, ..., and each custom section: one row
 * per entry (its title in bold, its dates and place under it), opened in the
 * Edit Entry panel, and the dashed "+ Add <entry>" under them. Nothing is
 * edited in the card itself except a custom section's title; Remove section
 * is a bin among the card's hover actions.
 *
 * `header` is what a card puts above its rows - Strengths its switch, with
 * the kept line and the template note - and `showRows` is false while that
 * switch is off: an unticked section shows what it keeps and nothing to add
 * to or edit, as before.
 */
export function EntrySection({
  label,
  spec,
  entries,
  onOpen,
  onAdd,
  onRemoveSection,
  templatePrints,
  templateName,
  header,
  showRows = true,
  customTitle,
  update,
  frame,
}: {
  /** The card's label: the kind's, or a custom section's title. */
  label: string;
  spec: SectionSpec;
  entries: readonly DraftEntry[];
  onOpen: (key: string) => void;
  onAdd: () => void;
  /** Only for a kind that is not a default card, and for a custom section. */
  onRemoveSection?: () => void;
  /** Whether the chosen template prints the section; null while templates load. */
  templatePrints: boolean | null;
  templateName: string;
  header?: ReactNode;
  showRows?: boolean;
  /** A custom section edits its title in the card; the key is the stored one. */
  customTitle?: { sectionKey: string; value: string };
  update: UpdateDraft;
  frame: CardFrame;
}) {
  const count = entries.length;
  const actions = onRemoveSection ? (
    <>
      {frame.actions}
      <button
        type="button"
        className={css.headButton}
        data-tone="danger"
        aria-label={`Remove section ${label}`}
        title="Remove section"
        onClick={onRemoveSection}
      >
        <IconTrash className="h-[18px] w-[18px]" />
      </button>
    </>
  ) : (
    frame.actions
  );

  return (
    <SectionCard label={label} icon={spec.icon} description={spec.description} frame={{ ...frame, actions }}>
      {customTitle && (
        <div>
          <label htmlFor={`section-custom-${customTitle.sectionKey}-title`} className="tl-label">
            Section title
          </label>
          <input
            id={`section-custom-${customTitle.sectionKey}-title`}
            type="text"
            className="tl-input mt-2"
            value={customTitle.value}
            maxLength={100}
            placeholder="e.g. Patents"
            onChange={(event) =>
              update((current) => ({
                ...current,
                customSections: current.customSections.map((section) =>
                  section.key === customTitle.sectionKey ? { ...section, title: event.target.value } : section
                ),
              }))
            }
          />
        </div>
      )}
      {header}
      {showRows && (
        <>
          <NotPrintedNote prints={templatePrints} count={count} label={label} templateName={templateName} />
          {count > 0 && (
            <ul className={css.entryRows}>
              {entries.map((row, index) => {
                const summary = entrySummary(spec, row, index);
                return (
                  <li key={row.key}>
                    <button
                      type="button"
                      className={css.entryRow}
                      onClick={() => onOpen(row.key)}
                      aria-label={`Edit ${summary.title}`}
                    >
                      <span className={css.entryRowText}>
                        <span className={css.entryRowTitle} data-untitled={summary.untitled ? 'true' : undefined}>
                          {summary.title}
                        </span>
                        {summary.meta && <span className={css.entryRowMeta}>{summary.meta}</span>}
                      </span>
                      <IconChevronRight className={css.entryRowChevron} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <AddRowButton onClick={onAdd}>Add {spec.entryNoun}</AddRowButton>
        </>
      )}
    </SectionCard>
  );
}
