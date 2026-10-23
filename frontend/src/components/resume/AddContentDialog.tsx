'use client';

import { useState } from 'react';
import { ICONS } from '@/components/icons';
import Dialog from '@/components/ui/Dialog';
import {
  CUSTOM_SECTION_SPEC,
  MAX_RESUME_CUSTOM_SECTIONS,
  type SectionKind,
  type SectionKindDefinition,
} from '@/lib/sectionCatalogue';
import { editorFont } from './editorFont';
import css from './resumeEditor.module.css';

/**
 * "+ Add content": a tile for each section kind the resume does not show
 * yet, and a Custom section with a title box. A tile adds the card at the end
 * of the column, open, and closes the dialog; the card prints nothing until
 * it has an entry, and is kept with the resume either way.
 *
 * The dialog is portalled to <body>, out of the editor, so it brings the
 * editor's look with it: its tokens (`css.tokens`) and its typeface.
 */
export function AddContentDialog({
  open,
  onClose,
  available,
  customCount,
  onAddKind,
  onAddCustom,
}: {
  open: boolean;
  onClose: () => void;
  /** The kinds not on the page, canonical order. */
  available: readonly SectionKindDefinition[];
  /** How many custom sections the resume has; the server keeps at most ten. */
  customCount: number;
  onAddKind: (kind: SectionKind) => void;
  onAddCustom: (title: string) => void;
}) {
  const [title, setTitle] = useState('');
  const atCap = customCount >= MAX_RESUME_CUSTOM_SECTIONS;
  const CustomGlyph = ICONS[CUSTOM_SECTION_SPEC.icon];

  const close = () => {
    setTitle('');
    onClose();
  };
  const addCustom = () => {
    const name = title.trim();
    if (!name || atCap) return;
    setTitle('');
    onAddCustom(name);
  };

  return (
    <Dialog
      open={open}
      title="Add content"
      subtitle="A section prints once it has an entry; an empty one stays on the page and is saved with the resume."
      onClose={close}
      width="wide"
      className={`${css.addDialog} ${css.tokens} ${editorFont.variable}`}
    >
      {available.length > 0 ? (
        <div className={css.tiles}>
          {available.map((kind) => {
            const Glyph = ICONS[kind.icon];
            return (
              <button key={kind.id} type="button" className={css.tile} onClick={() => onAddKind(kind.id)}>
                <span className={css.tileIcon} aria-hidden="true">
                  <Glyph className="h-[20px] w-[20px]" strokeWidth={2} />
                </span>
                <span className="min-w-0">
                  <span className={css.tileTitle}>{kind.label}</span>
                  <span className={css.tileBlurb}>{kind.blurb}</span>
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-muted">Every kind of section is on the page already. A custom section can still be added.</p>
      )}
      <div className={css.customTile}>
        <div className="flex items-start gap-3">
          <span className={css.tileIcon} aria-hidden="true">
            <CustomGlyph className="h-[20px] w-[20px]" strokeWidth={2} />
          </span>
          <div className="min-w-0 flex-1">
            <p className={css.tileTitle}>{CUSTOM_SECTION_SPEC.label}</p>
            <p className={css.tileBlurb}>{CUSTOM_SECTION_SPEC.blurb}</p>
            <div className={`${css.addRow} mt-3`}>
              <input
                type="text"
                className="tl-input"
                aria-label="Custom section title"
                placeholder="Section title, e.g. Patents"
                maxLength={100}
                value={title}
                disabled={atCap}
                onChange={(event) => setTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return;
                  event.preventDefault();
                  addCustom();
                }}
              />
              <button type="button" className="tl-button" onClick={addCustom} disabled={atCap || !title.trim()}>
                Add
              </button>
            </div>
            {atCap && (
              <p className="mt-2 text-sm text-subtle">
                A resume can have at most {MAX_RESUME_CUSTOM_SECTIONS} custom sections.
              </p>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
