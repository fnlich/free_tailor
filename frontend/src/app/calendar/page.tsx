'use client';

import CalendarWorkspace from '@/components/CalendarWorkspace';

/*
 * A workspace, so no page title and no width cap: the calendar takes the whole
 * content region, and its own gutters and height live in the workspace's
 * stylesheet, where the height is measured from the shell's bar.
 */
export default function CalendarPage() {
  return (
    <main className="w-full">
      <CalendarWorkspace />
    </main>
  );
}
