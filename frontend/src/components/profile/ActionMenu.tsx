'use client';

import { useCallback, useEffect, useId, useRef, useState, type ComponentType, type ReactNode } from 'react';
import type { IconProps } from '@/components/icons';
import { useDismissable } from '@/lib/useDismissable';
import css from './profilePages.module.css';

export interface ActionMenuItem {
  key: string;
  label: string;
  /** A second line under the label. */
  hint?: string;
  icon?: ComponentType<IconProps>;
  tone?: 'danger';
  disabled?: boolean;
  /** Why it is disabled, as a tooltip. */
  title?: string;
  /** A hairline above it, to set it apart (Delete). */
  ruleBefore?: boolean;
  onSelect: () => void;
}

/**
 * A button that opens a short list of actions under it: a profile card's ⋮
 * (Edit, Duplicate, Download, Disable, Delete - FlowCV's card menu) and the
 * chooser's "Import existing resume". A menu in the ARIA sense: it opens on
 * the first action, the arrow keys, Home and End move through them, Escape
 * closes it and hands focus back to the button, and a press outside or Tab
 * closes it too (lib/useDismissable).
 */
export function ActionMenu({
  items,
  triggerClassName,
  triggerContent,
  triggerLabel,
  triggerTitle,
  disabled = false,
}: {
  items: readonly ActionMenuItem[];
  triggerClassName: string;
  triggerContent: ReactNode;
  /** The button's name when its content is an icon alone. */
  triggerLabel?: string;
  triggerTitle?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  /** Above the button when the window has no room for the list below it (a card in the last row). */
  const [placement, setPlacement] = useState<'below' | 'above'>('below');
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const close = useCallback(() => setOpen(false), []);
  useDismissable(open, close, button, menu);

  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [open]);

  const enabledItems = () =>
    Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);

  const onMenuKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const list = enabledItems();
    if (list.length === 0) return;
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    const focus = (next: number) => list[(next + list.length) % list.length]?.focus();
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focus(index + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focus(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        focus(0);
        break;
      case 'End':
        event.preventDefault();
        focus(list.length - 1);
        break;
      case 'Escape':
        event.preventDefault();
        close();
        button.current?.focus();
        break;
      case 'Tab':
        close();
        break;
    }
  };

  return (
    <div className={css.menuWrap}>
      <button
        ref={button}
        type="button"
        className={triggerClassName}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={triggerLabel}
        title={triggerTitle ?? triggerLabel}
        disabled={disabled}
        onClick={() => {
          if (!open && button.current) {
            // Measured as it opens, from the items' known heights, so nothing has to be drawn twice.
            const rect = button.current.getBoundingClientRect();
            const height = items.reduce((sum, item) => sum + (item.hint ? 62 : 42) + (item.ruleBefore ? 13 : 0), 12);
            const below = window.innerHeight - rect.bottom;
            setPlacement(below < height + 8 && rect.top > below ? 'above' : 'below');
          }
          setOpen((current) => !current);
        }}
      >
        {triggerContent}
      </button>
      {open && (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label={triggerLabel}
          className={css.menu}
          data-placement={placement}
          onKeyDown={onMenuKey}
        >
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <div key={item.key} role="none">
                {item.ruleBefore && <div className={css.menuRule} role="separator" />}
                <button
                  type="button"
                  role="menuitem"
                  className={css.menuItem}
                  data-tone={item.tone}
                  disabled={item.disabled}
                  title={item.title}
                  onClick={() => {
                    close();
                    item.onSelect();
                  }}
                >
                  {Icon && <Icon className={`${css.menuItemIcon} h-[18px] w-[18px]`} strokeWidth={2} />}
                  <span className={css.menuText}>
                    <span>{item.label}</span>
                    {item.hint && <span className={css.menuHint}>{item.hint}</span>}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
