'use client';

import type { ReactNode } from 'react';
import type { PillTone } from '@/components/ui/kit';
import type { ProfileDraft } from '@/lib/profileDraft';
import css from './profileEditor.module.css';

/**
 * Small pieces every section of the profile editor shares, so the sections
 * read as one form rather than six that happen to sit together.
 */

/**
 * How a section changes the draft. `immediate` is for a discrete choice - a
 * template, a layout, a switch - whose preview should not wait out the typing
 * debounce: nobody is in the middle of anything.
 */
export type UpdateDraft = (
  recipe: (draft: ProfileDraft) => ProfileDraft,
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
 * Drawn as the kit's choice box, so the sentence saying what ticking it does
 * sits inside the thing being ticked.
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
    <label htmlFor={id} className="tl-choice" data-on={checked ? 'true' : 'false'}>
      <input id={id} type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-ink">{label}</span>
        {children && <span className="mt-1 block text-sm text-muted">{children}</span>}
      </span>
    </label>
  );
}

/** "Remove" on a row's card. */
export function RemoveRowButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="tl-button-quiet"
      data-size="sm"
      data-tone="danger"
      aria-label={label}
    >
      Remove
    </button>
  );
}

/** "+ Add ..." in a section's header. */
export function AddRowButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="tl-button-quiet" data-size="sm">
      {children}
    </button>
  );
}

/** Replaces one row of a keyed list. */
export function replaceRow<T extends { key: string }>(rows: readonly T[], key: string, patch: Partial<T>): T[] {
  return rows.map((row) => (row.key === key ? { ...row, ...patch } : row));
}

/** Drops one row of a keyed list. */
export function removeRow<T extends { key: string }>(rows: readonly T[], key: string): T[] {
  return rows.filter((row) => row.key !== key);
}
