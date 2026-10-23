'use client';

import { useEffect, useId, useRef, useState, type PointerEventHandler, type ReactNode } from 'react';
import { ICONS, IconArrowDown, IconArrowUp, IconChevronRight, IconGrip, type IconName } from '@/components/icons';
import css from './resumeEditor.module.css';

/**
 * The handle a card is dragged by, as SectionSlot hands it out: the slot is
 * draggable only while the grip is pressed, so selecting text in a field
 * never starts a drag.
 */
export type GripProps = {
  onPointerDown: PointerEventHandler<HTMLElement>;
  onPointerUp: PointerEventHandler<HTMLElement>;
  onPointerCancel: PointerEventHandler<HTMLElement>;
};

/** Move up / Move down, for a keyboard and for a touch screen, where there is no drag. */
export type MoveProps = {
  up: () => void;
  down: () => void;
  canUp: boolean;
  canDown: boolean;
};

/** What the editor decides for every card: how it is moved, and what its head says beside the label. */
export type CardFrame = {
  grip?: GripProps;
  move?: MoveProps;
  /** "3 entries", "12 skills" - after the label in the head, part of the toggle's name. */
  meta?: string;
  /** Buttons in the head, right of the label: Remove section. */
  actions?: ReactNode;
  /** Focus the card's toggle when it mounts - for the card Add content just made. */
  focusOnMount?: boolean;
};

/**
 * One collapsible card of the editor's column, drawn as FlowCV draws its
 * sections: a white card with a chunky icon, the label in large bold type,
 * and a chevron - the whole head opens and closes the body. The grip, Move up
 * / Move down and whatever actions the card has (Remove section) appear when
 * the card is hovered or has focus, and always on a touch screen.
 *
 * The body is ALWAYS MOUNTED and hidden with the `hidden` attribute while the
 * card is closed, never unmounted: the inputs keep their text, a half-typed
 * skill stays where it was, and every pinned id (`#resume-include-strengths`)
 * is in the DOM for a script that clicks at DOM level whether or not the card
 * is open. `aria-expanded` on the toggle says which, and the toggle's
 * accessible name STARTS with the label (the icon is hidden from it, the
 * count follows), so "the button whose text starts with Strengths" finds the
 * right one.
 */
export function SectionCard({
  label,
  icon,
  description,
  defaultOpen,
  frame,
  children,
}: {
  label: string;
  icon: IconName;
  /** One line under the label, inside the body - so a closed card is its title. */
  description?: string;
  /**
   * Closed unless said otherwise, so the column reads as FlowCV's list of
   * sections - except the card Add content just made, which opens to be
   * filled in.
   */
  defaultOpen?: boolean;
  frame?: CardFrame;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? frame?.focusOnMount === true);
  const id = useId();
  const titleId = `${id}-title`;
  const bodyId = `${id}-body`;
  const toggle = useRef<HTMLButtonElement | null>(null);
  const Glyph = ICONS[icon];

  // The card Add content just made takes focus, so the keyboard carries on
  // from it; a card that mounts without the request is left alone.
  const focusOnMount = frame?.focusOnMount === true;
  useEffect(() => {
    if (focusOnMount) toggle.current?.focus();
  }, [focusOnMount]);

  return (
    <section className={css.section} aria-labelledby={titleId} data-open={open ? 'true' : 'false'}>
      <div className={css.sectionHead}>
        {frame?.grip && (
          <span className={css.grip} aria-hidden="true" title="Drag to reorder" {...frame.grip}>
            <IconGrip className="h-[18px] w-[18px]" strokeWidth={2.25} />
          </span>
        )}
        <h2 id={titleId} className={css.sectionTitle}>
          <button
            ref={toggle}
            type="button"
            className={css.sectionToggle}
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => setOpen((current) => !current)}
          >
            <span className={css.sectionIcon} aria-hidden="true">
              <Glyph className="h-[22px] w-[22px]" strokeWidth={2.1} />
            </span>
            <span className={css.sectionLabel}>{label}</span>
            {frame?.meta && <span className={css.sectionMeta}>{frame.meta}</span>}
          </button>
        </h2>
        <div className={css.sectionActions}>
          {frame?.actions}
          {frame?.move && (
            <>
              <button
                type="button"
                className={css.headButton}
                aria-label={`Move ${label} up`}
                title="Move up"
                disabled={!frame.move.canUp}
                onClick={frame.move.up}
              >
                <IconArrowUp className="h-[17px] w-[17px]" strokeWidth={2} />
              </button>
              <button
                type="button"
                className={css.headButton}
                aria-label={`Move ${label} down`}
                title="Move down"
                disabled={!frame.move.canDown}
                onClick={frame.move.down}
              >
                <IconArrowDown className="h-[17px] w-[17px]" strokeWidth={2} />
              </button>
            </>
          )}
        </div>
        <IconChevronRight className={css.chevron} data-open={open ? 'true' : 'false'} strokeWidth={2.25} />
      </div>
      <div id={bodyId} role="region" aria-labelledby={titleId} hidden={!open} className={css.sectionBody}>
        {description && <p className="text-sm text-muted">{description}</p>}
        {children}
      </div>
    </section>
  );
}
