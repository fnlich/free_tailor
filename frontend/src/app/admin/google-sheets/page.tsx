'use client';

import GoogleSheetsRangeImporter from '@/components/admin/GoogleSheetsRangeImporter';
import { AdminOnly } from '@/components/auth/AuthGate';

function AdminGoogleSheetsPageBody() {
  return (
    <div>
      {/* The shell already says "Settings" above the tabs, so this is the
          page's own name at the smaller size. */}
      <header>
        <h2 className="text-2xl font-bold tracking-tight text-ink">Google Sheets</h2>
        <p className="mt-1 text-sm text-muted">
          Import a range of your own job sheet by tab name, numeric row bounds and letter-based column bounds, and save your edits back.
        </p>
      </header>

      <GoogleSheetsRangeImporter />
    </div>
  );
}

/**
 * Administrator-only.
 *
 * This page changes things shared by everybody on the installation - the AI
 * providers, the prompts every account's resumes are built from, the shared
 * skill library - so it is not a per-user setting despite living behind a
 * "Settings" menu. `AdminOnly` explains that rather than rendering nothing: a
 * blank page reads as broken.
 */
export default function AdminGoogleSheetsPage() {
  return (
    <AdminOnly>
      <AdminGoogleSheetsPageBody />
    </AdminOnly>
  );
}
