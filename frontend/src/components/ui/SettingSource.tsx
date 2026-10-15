'use client';

import type { ReactNode } from 'react';

/**
 * Where a setting's value in effect came from, under its box - "Set here",
 * "From .env (NAME)" or "Default" (lib/settingSources.ts `sourceLabel`) - and,
 * while it is "Set here", **Reset to default**, which removes the stored value
 * so `.env`, else the code, decides again. `gives` says what that would be,
 * so nobody presses it to find out.
 *
 * A Reset is a save of its own: the page sends the field as `null` at once
 * rather than folding it into the form's Save.
 */
export default function SettingSource({
  label,
  resettable,
  onReset,
  busy = false,
  gives,
  name,
}: {
  label: string;
  /** Only while the value is the administrator's: otherwise there is nothing stored to remove. */
  resettable: boolean;
  onReset?: () => void;
  busy?: boolean;
  /** What Reset to default would put in effect, in words. */
  gives?: ReactNode;
  /** What the setting is called, for the button's accessible name. */
  name?: string;
}) {
  return (
    <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle" data-setting-source>
      <span>
        <span className="font-medium text-muted">{label}</span>
        {resettable && gives ? <> &middot; Reset gives {gives}</> : null}
      </span>
      {resettable && onReset && (
        <button
          type="button"
          className="tl-link"
          onClick={onReset}
          disabled={busy}
          aria-label={name ? `Reset ${name} to default` : undefined}
        >
          {busy ? 'Resetting...' : 'Reset to default'}
        </button>
      )}
    </p>
  );
}
