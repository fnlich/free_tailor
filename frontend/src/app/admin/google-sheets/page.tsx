'use client';

import GoogleSheetsRangeImporter from '@/components/admin/GoogleSheetsRangeImporter';
import { AdminOnly } from '@/components/auth/AuthGate';

function AdminGoogleSheetsPageBody() {
  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Google Sheets</h1>
        <p className="mt-2 text-sm text-gray-600">
          Import a specific range from a Google Sheet by spreadsheet ID, tab name, numeric row bounds, and letter-based column bounds.
        </p>
      </div>

      <div className="rounded-lg bg-white p-6 shadow">
        <GoogleSheetsRangeImporter />
      </div>
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
