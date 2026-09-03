'use client';

import GoogleSheetsRangeImporter from '@/components/admin/GoogleSheetsRangeImporter';

export default function AdminGoogleSheetsPage() {
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
