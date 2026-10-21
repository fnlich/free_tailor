'use client';

import { useCallback, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { IconCheck, IconChevronRight, IconClose } from '@/components/icons';
import {
  activeAfterChoice,
  addTypedValue,
  describeChange,
  fullSentence,
  matchingOptions,
  nextActiveIndex,
  revealOffset,
  toggleValue,
  valueLabel,
  type MultiSelectOption,
} from '@/lib/multiSelect';
import { useDismissable } from '@/lib/useDismissable';

export type { MultiSelectOption } from '@/lib/multiSelect';

/**
 * A box that takes several values, chosen from a list or typed: the chosen
 * ones as chips, each with its own Remove, then a text input that is the
 * combobox (role=combobox, aria-expanded, aria-controls, the active option
 * as aria-activedescendant) over a listbox that may hold several
 * (aria-multiselectable). The lake's filter form draws its list filters with
 * it - Job field, Job type, Industry, Company, Requested by, Full text.
 *
 * The keyboard, on the input:
 *  - ArrowDown opens the list, or moves down; ArrowUp moves up; Alt+ArrowUp
 *    closes it;
 *  - Enter chooses (or un-chooses) the active option and keeps the list open,
 *    or - `creatable`, no option active - adds what was typed, split where
 *    `splitTyped` says; with nothing typed, Enter is the form's: Search;
 *  - Escape closes the list, else clears what was typed, else goes on to
 *    whatever is around the box - and never closes a dialog the list was open
 *    in;
 *  - Backspace in an empty input removes the last chip; Tab closes the list.
 *
 * Focus stays in the input, so the browser never scrolls the list to the
 * active option by itself: the box does, whenever the keyboard (or a choice
 * that redrew the list) moved it - and keeps the option just chosen from a
 * filtered list the active one where the whole list shows it.
 *
 * What is typed is the PARENT's (`inputValue`), so a form can still take it
 * on submit (lib/jobLakeDisplay.ts `draftFilters`). The decisions with no
 * React in them are lib/multiSelect.ts's. The look is the `.tl-multiselect*`
 * rules in globals.css: tokens only, and a dark input rule that out-ranks the
 * shim's, so the input stays the box's own colour.
 */
export default function MultiSelect({
  id,
  label,
  values,
  onChange,
  options,
  inputValue,
  onInputChange,
  creatable = false,
  splitTyped,
  maxValues,
  fullText,
  filterOptions = true,
  placeholder,
  emptyText = 'Nothing matches.',
  loading = false,
  disabled = false,
  inline = false,
  describedBy,
}: {
  /** The input's id: what a <label htmlFor> names, and the prefix of the list's and options' ids. */
  id: string;
  /** What the box is, for the chips' list and the live region ("Job field"). */
  label: string;
  values: readonly string[];
  onChange: (values: string[]) => void;
  options: readonly MultiSelectOption[];
  inputValue: string;
  onInputChange: (text: string) => void;
  /** Whether what is typed can be a value of its own (a company, a keyword), not only a filter of the list. */
  creatable?: boolean;
  /** Where typed text splits into several values (Full text's commas). Unset: never. */
  splitTyped?: RegExp;
  maxValues?: number;
  /** What is said when the box is full; the server's own sentence where it has one. */
  fullText?: string;
  /** False when the options are already the matches (asked of the server for what was typed). */
  filterOptions?: boolean;
  placeholder?: string;
  emptyText?: string;
  loading?: boolean;
  disabled?: boolean;
  /** The list in the flow of the page rather than over it - inside a dialog that scrolls, where it would be clipped. */
  inline?: boolean;
  describedBy?: string;
}) {
  const root = useRef<HTMLDivElement | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const list = useRef<HTMLUListElement | null>(null);
  // Set where the keyboard or the typing moves the active option: the list
  // then scrolls to show it. Never where the pointer moved it - that option
  // is under the pointer, and scrolling would pull the list from under it.
  const reveal = useRef(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [announcement, setAnnouncement] = useState('');

  const shown = useMemo(
    () => (filterOptions ? matchingOptions(options, inputValue) : [...options]),
    [filterOptions, inputValue, options]
  );
  // Every option a chip may name, the chosen ones the list no longer shows included.
  const known = useMemo(() => [...options], [options]);
  const full = maxValues !== undefined && values.length >= maxValues;
  const fullLine = fullText ?? (maxValues !== undefined ? fullSentence(maxValues) : '');
  const typed = inputValue.trim();
  const listId = `${id}-listbox`;
  const optionId = (index: number) => `${id}-option-${index}`;

  const close = useCallback(() => {
    setOpen(false);
    setActive(-1);
  }, []);
  useDismissable(open, close, root);

  // The active option into the list's view: the list's own scrollTop, never
  // `scrollIntoView`, which would move the page too. Moving up into a group,
  // its heading comes into view with its first option.
  useLayoutEffect(() => {
    if (!reveal.current) return;
    reveal.current = false;
    const box = list.current;
    const option = active >= 0 ? document.getElementById(`${id}-option-${active}`) : null;
    if (!box || !option || !box.contains(option)) return;
    const heading = option.previousElementSibling?.classList.contains('tl-multiselect-group') ? option.previousElementSibling : null;
    const top = box.getBoundingClientRect().top + box.clientTop;
    const offset = revealOffset(
      { top, bottom: top + box.clientHeight },
      { top: (heading ?? option).getBoundingClientRect().top, bottom: option.getBoundingClientRect().bottom }
    );
    if (offset !== 0) box.scrollTop += offset;
  }, [active, id, open, shown]);

  const commit = (next: string[], refused = false) => {
    if (refused) {
      setAnnouncement(fullLine);
      return;
    }
    setAnnouncement(describeChange(label, values, next, known));
    onChange(next);
  };

  const toggle = (option: MultiSelectOption) => {
    const result = toggleValue(values, option.id, maxValues);
    commit(result.values, result.refused);
    onInputChange('');
    // What was typed filtered the list, and goes: the list is drawn whole, and the active option is still this one.
    setActive((current) => activeAfterChoice(options, option.id, current, inputValue, filterOptions));
    if (typed) reveal.current = true;
  };

  const addTyped = () => {
    const result = addTypedValue(values, inputValue, { split: splitTyped, max: maxValues });
    if (result.added.length > 0) commit(result.values);
    if (result.full) setAnnouncement(fullLine);
    onInputChange('');
  };

  const remove = (value: string) => {
    commit(values.filter((chosen) => chosen !== value));
    input.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        reveal.current = true;
        if (!open) {
          setOpen(true);
          setActive(shown.length > 0 ? 0 : -1);
        } else {
          setActive((current) => nextActiveIndex(current, shown.length, 1));
        }
        return;
      }
      case 'ArrowUp': {
        if (!open) return;
        event.preventDefault();
        if (event.altKey) {
          close();
        } else {
          reveal.current = true;
          setActive((current) => nextActiveIndex(current, shown.length, -1));
        }
        return;
      }
      case 'Enter': {
        const option = open && active >= 0 ? shown[active] : undefined;
        if (option) {
          event.preventDefault();
          toggle(option);
          return;
        }
        if (typed) {
          event.preventDefault();
          if (creatable) addTyped();
          return;
        }
        // Nothing typed and nothing active: the form's, as Search.
        close();
        return;
      }
      case 'Escape': {
        if (!open && !inputValue) return;
        event.preventDefault();
        event.stopPropagation();
        // A dialog around the box listens on the document too, where the
        // page's own listener already is: stopped there, it stays open.
        event.nativeEvent.stopImmediatePropagation();
        if (open) close();
        else onInputChange('');
        return;
      }
      case 'Backspace': {
        if (inputValue === '' && values.length > 0) {
          event.preventDefault();
          commit(values.slice(0, -1));
        }
        return;
      }
      case 'Tab': {
        if (open) close();
        return;
      }
      default:
    }
  };

  // The options under their group headings, each group once, in the order they come.
  const rows: ReactNode[] = [];
  let lastGroup: string | undefined;
  shown.forEach((option, index) => {
    if (option.group && option.group !== lastGroup) {
      rows.push(
        <li key={`group-${option.group}-${index}`} role="presentation" className="tl-multiselect-group">
          {option.group}
        </li>
      );
    }
    lastGroup = option.group;
    const selected = values.includes(option.id);
    const blocked = !selected && full;
    rows.push(
      <li
        key={option.id}
        id={optionId(index)}
        role="option"
        aria-selected={selected}
        aria-disabled={blocked || undefined}
        data-value={option.id}
        data-active={index === active || undefined}
        className="tl-multiselect-option"
        // Pressed with the mouse, focus stays in the input.
        onMouseDown={(event) => event.preventDefault()}
        onMouseEnter={() => {
          reveal.current = false;
          setActive(index);
        }}
        onClick={() => {
          if (blocked) setAnnouncement(fullLine);
          else toggle(option);
          input.current?.focus();
        }}
      >
        <span data-option-label className="min-w-0 flex-1 break-words">
          {option.label}
        </span>
        {option.hint && <span className="tl-multiselect-hint">{option.hint}</span>}
        <IconCheck className="tl-multiselect-check" />
      </li>
    );
  });

  return (
    <div
      ref={root}
      className="tl-multiselect"
      data-multiselect
      data-open={open || undefined}
      data-disabled={disabled || undefined}
      data-inline={inline || undefined}
      // Focus gone to anything outside the box - the next field, by Tab or
      // otherwise - closes its list, so two lists are never open at once.
      onBlur={(event) => {
        if (open && !root.current?.contains(event.relatedTarget as Node | null)) close();
      }}
    >
      <div
        className="tl-multiselect-box"
        onMouseDown={(event) => {
          // A press on the box around the chips is a press on the input.
          if (event.target === event.currentTarget) {
            event.preventDefault();
            input.current?.focus();
            if (!disabled) setOpen(true);
          }
        }}
      >
        {values.length > 0 && (
          <ul className="tl-multiselect-chips" aria-label={`${label}: chosen`}>
            {values.map((value) => {
              const text = valueLabel(known, value);
              return (
                <li key={value} className="tl-multiselect-chip">
                  <span className="min-w-0 break-words">{text}</span>
                  <button type="button" aria-label={`Remove ${text}`} disabled={disabled} onClick={() => remove(value)}>
                    <IconClose className="h-3 w-3" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <input
          ref={input}
          id={id}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && active >= 0 && active < shown.length ? optionId(active) : undefined}
          aria-describedby={describedBy}
          autoComplete="off"
          className="tl-multiselect-input"
          value={inputValue}
          placeholder={values.length === 0 ? placeholder : undefined}
          disabled={disabled}
          onChange={(event) => {
            onInputChange(event.target.value);
            setOpen(true);
            // Typing a value of its own leaves nothing active: Enter adds what was typed.
            setActive(creatable ? -1 : 0);
            reveal.current = true;
          }}
          onClick={() => {
            if (!disabled) setOpen(true);
          }}
          onKeyDown={onKeyDown}
        />
        <span className="tl-multiselect-chevron" aria-hidden>
          <IconChevronRight className="h-4 w-4" />
        </span>
      </div>
      {open && !disabled && (
        <ul ref={list} id={listId} role="listbox" aria-multiselectable="true" aria-label={label} className="tl-multiselect-list">
          {rows}
          {shown.length === 0 && !(creatable && typed) && (
            <li role="presentation" className="tl-multiselect-empty">
              {loading ? 'Looking...' : emptyText}
            </li>
          )}
          {creatable && typed && (
            <li role="presentation" className="tl-multiselect-empty">
              {full ? fullLine : `Press Enter to add "${typed}".`}
            </li>
          )}
        </ul>
      )}
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}
