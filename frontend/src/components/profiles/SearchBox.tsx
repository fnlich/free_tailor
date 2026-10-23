'use client';

import { useRef } from 'react';
import { IconSearch } from '@/components/icons';
import css from './profiles.module.css';

/**
 * The search over a tab's profiles or resumes: a `type="search"` input with its
 * icon, and a Clear button while something is typed. Clear hands focus back to
 * the input - the button unmounts with the text, and focus would otherwise fall
 * to the page.
 */
export function SearchBox({
  id,
  value,
  onChange,
  label,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  /** Its accessible name, and its placeholder: "Search profiles". */
  label: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className={css.searchRow}>
      <div className={css.searchBox}>
        <IconSearch className={`${css.searchIcon} h-[18px] w-[18px]`} />
        <input
          ref={input}
          id={id}
          type="search"
          className="tl-input"
          value={value}
          placeholder={label}
          aria-label={label}
          autoComplete="off"
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
      {value !== '' && (
        <button
          type="button"
          className={css.clearButton}
          onClick={() => {
            onChange('');
            input.current?.focus();
          }}
        >
          Clear
        </button>
      )}
    </div>
  );
}
