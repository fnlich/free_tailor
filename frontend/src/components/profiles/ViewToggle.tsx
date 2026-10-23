'use client';

import { useCallback, useState } from 'react';
import { IconGrid, IconList } from '@/components/icons';
import { readViewMode, writeViewMode, type ViewMode } from '@/lib/profileDashboard';
import css from './profiles.module.css';

/** localStorage, or null where the browser refuses it (a private window, blocked site data). */
function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The remembered view of the Profiles pages: read once, in the state's lazy
 * initialiser (never in an effect - AuthGate mounts the pages on the client
 * only, so there is no first paint to disagree with), and written on every
 * change.
 */
export function useViewMode(): [ViewMode, (mode: ViewMode) => void] {
  const [view, setView] = useState<ViewMode>(() => readViewMode(browserStorage()));
  const choose = useCallback((mode: ViewMode) => {
    setView(mode);
    writeViewMode(browserStorage(), mode);
  }, []);
  return [view, choose];
}

/**
 * "View: Grid | List", the dashboard's and a profile's page: two icon buttons
 * side by side (an ARIA toolbar of toggle buttons), the pressed one filled. The choice is the page's to keep
 * (lib/profileDashboard's VIEW_MODE_KEY).
 */
export function ViewToggle({ value, onChange }: { value: ViewMode; onChange: (mode: ViewMode) => void }) {
  return (
    <div className={css.viewToggle}>
      <span className={css.viewLabel} aria-hidden="true">
        View:
      </span>
      <div role="group" aria-label="View" className={css.viewButtons}>
        <button
          type="button"
          className={css.viewButton}
          aria-pressed={value === 'grid'}
          aria-label="Grid"
          title="Grid"
          onClick={() => onChange('grid')}
        >
          <IconGrid className="h-[18px] w-[18px]" />
        </button>
        <button
          type="button"
          className={css.viewButton}
          aria-pressed={value === 'list'}
          aria-label="List"
          title="List"
          onClick={() => onChange('list')}
        >
          <IconList className="h-[18px] w-[18px]" />
        </button>
      </div>
    </div>
  );
}
