'use client';

import { useId, type ReactNode } from 'react';
import { IconCheck, IconChevronRight, IconPlus } from '@/components/icons';
import { Notice, type PillTone } from '@/components/ui/kit';
import type { ResumeDraft } from '@/lib/resumeDraft';
import css from './resumeEditor.module.css';

/**
 * Small pieces every card of the resume editor shares, so the cards read as
 * one form rather than a dozen that happen to sit together.
 */

export { removeRow, replaceRow } from '@/lib/resumeDraft';

/**
 * How a card changes the draft. `immediate` is for a discrete choice - a
 * template, a layout, a switch, a card moved - whose preview should not wait
 * out the typing debounce: nobody is in the middle of anything.
 */
export type UpdateDraft = (
  recipe: (draft: ResumeDraft) => ResumeDraft,
  options?: { immediate?: boolean }
) => void;

/** A row of removable chips. `renderExtra` puts a control inside each chip, before its ×. */
export function ChipList({
  items,
  tone,
  onRemove,
  renderExtra,
}: {
  items: readonly string[];
  tone: PillTone;
  onRemove: (item: string) => void;
  renderExtra?: (item: string) => ReactNode;
}) {
  if (items.length === 0) return null;
  return (
    <div className={css.chips}>
      {/* Index in the key: a stored list can hold the same name twice, and
          a chip has no state of its own to lose by being re-keyed. */}
      {items.map((item, index) => (
        <span key={`${index}:${item}`} className="tl-pill" data-tone={tone}>
          {item}
          {renderExtra?.(item)}
          <button
            type="button"
            onClick={() => onRemove(item)}
            aria-label={`Remove ${item}`}
            className={css.chipRemove}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}

/**
 * A text box with an Add button, adding on Enter as well.
 *
 * `onKeyDown`, not the deprecated `onKeyPress` the old form used: Enter is
 * caught before the browser can treat it as submitting the whole form.
 */
export function AddInput({
  id,
  value,
  onChange,
  onAdd,
  placeholder,
  label,
  list,
  maxLength,
  disabled,
  busy,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  onAdd: () => void;
  placeholder: string;
  label: string;
  list?: string;
  maxLength?: number;
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <div className={css.addRow}>
      <input
        id={id}
        type="text"
        list={list}
        value={value}
        maxLength={maxLength}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          onAdd();
        }}
        placeholder={placeholder}
        aria-label={label}
        className="tl-input"
      />
      <button
        type="button"
        onClick={onAdd}
        disabled={disabled || busy || !value.trim()}
        className="tl-button-quiet"
      >
        {busy ? 'Adding...' : 'Add'}
      </button>
    </div>
  );
}

/**
 * A section's on/off switch: whether the resume prints it.
 *
 * One row, its sentence on the left and the switch on the right, so what
 * turning it on does sits beside the thing being turned on. The switch is the
 * checkbox itself, drawn as one, so its id is the one a script clicks.
 */
export function SectionSwitch({
  id,
  checked,
  onChange,
  label,
  children,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  children?: ReactNode;
}) {
  return (
    <label htmlFor={id} className={css.switchRow} data-on={checked ? 'true' : 'false'}>
      <span className={css.switchText}>
        <span className={css.switchTitle}>{label}</span>
        {children && <span className={css.switchDesc}>{children}</span>}
      </span>
      <input
        id={id}
        type="checkbox"
        role="switch"
        className={css.switch}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

/** "+ Add ..." under a card's rows: dashed, full width, in the editor's pink. */
export function AddRowButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={css.addEntry}>
      <IconPlus className="h-[18px] w-[18px]" strokeWidth={2.25} />
      {children}
    </button>
  );
}

/**
 * What an unticked section shows in place of its list: one line saying how
 * many entries are kept. Nothing is deleted - they are saved with the resume
 * as they are and come back to edit when the box is ticked again.
 */
export function KeptLine({ note }: { note: string | null }) {
  if (!note) return null;
  return (
    <p className="text-sm text-muted" role="status">
      {note}
    </p>
  );
}

/**
 * The note under a section switch when the template has nowhere to print it:
 * the switch then counts as off for this template, whatever the box says
 * (`resumeForTemplate` on the server) - `whenOff` is what that means.
 */
export function SwitchCapabilityNote({
  on,
  supported,
  section,
  templateName,
  whenOff,
}: {
  on: boolean;
  /** Whether the chosen template has the section; null while templates load. */
  supported: boolean | null;
  section: string;
  templateName: string;
  whenOff: string;
}) {
  if (!on || supported !== false) return null;
  return (
    <Notice tone="warn" role="status">
      {templateName} has no {section} section, so it prints as if this were off: {whenOff} Another template prints it.
    </Notice>
  );
}

/**
 * The note on a card whose section the chosen template does not print (its
 * `printsSections`, read through `templatePrintsSection`): the entries are
 * still saved with the resume, and the DOCX and another template print them.
 * Nothing while the template prints it, while nothing is in it, or while
 * templates load (`prints` null).
 */
export function NotPrintedNote({
  prints,
  count,
  label,
  templateName,
}: {
  prints: boolean | null;
  count: number;
  label: string;
  templateName: string;
}) {
  if (prints !== false || count === 0) return null;
  return (
    <Notice tone="info" role="status">
      {templateName} has no {label} section, so {count === 1 ? 'this entry is' : 'these entries are'} not printed
      with it. {count === 1 ? 'It is' : 'They are'} saved with the resume, and another template prints{' '}
      {count === 1 ? 'it' : 'them'}.
    </Notice>
  );
}

/**
 * The panel that takes the column's place while one thing is edited - an
 * entry, or the name and contact details - drawn as FlowCV's Edit Entry:
 * Back, the section's name over a large title, the panel's own actions
 * (Delete) on the right, the fields, and the foot - Done - pinned to the
 * bottom of the window while the panel is longer than it.
 */
export function EditorPanel({
  title,
  eyebrow,
  onBack,
  actions,
  footer,
  children,
}: {
  title: string;
  /** The section the panel belongs to, small above the title. */
  eyebrow?: string;
  onBack: () => void;
  /** Icon buttons right of the title - Delete. */
  actions?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={css.panel} aria-label={title}>
      <div className={css.panelHead}>
        <button type="button" className={css.iconButton} onClick={onBack} aria-label="Back to the sections" title="Back">
          <IconChevronRight className="h-[18px] w-[18px] rotate-180" strokeWidth={2.25} />
        </button>
        <div className={css.panelHeading}>
          {eyebrow && <p className={css.panelEyebrow}>{eyebrow}</p>}
          <h2 className={css.panelTitle}>{title}</h2>
        </div>
        {actions && <div className={css.panelActions}>{actions}</div>}
      </div>
      <div className={css.panelBody}>{children}</div>
      {footer && <div className={css.panelFoot}>{footer}</div>}
    </section>
  );
}

/**
 * One card of the Customize tab, as FlowCV's Document Settings: a large
 * title, a line saying what the card decides, and its fields. Never
 * collapsed - a settings card is short, and its fields are the point.
 */
export function SettingsCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className={css.setCard} aria-labelledby={id}>
      <div className={css.setHead}>
        <h2 id={id} className={css.setTitle}>
          {title}
        </h2>
        {description && <p className={css.setDesc}>{description}</p>}
      </div>
      {children}
    </section>
  );
}

/** Done at the foot of a panel: FlowCV's gradient, wide and centred, with a tick. */
export function DoneButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className={css.doneButton} onClick={onClick}>
      <IconCheck className="h-[20px] w-[20px]" strokeWidth={2.4} />
      Done
    </button>
  );
}
