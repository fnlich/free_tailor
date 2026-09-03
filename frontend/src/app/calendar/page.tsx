'use client';

import AppTopNav from '@/components/AppTopNav';
import CalendarWorkspace from '@/components/CalendarWorkspace';

export default function CalendarPage() {
  return (
    <div className="min-h-screen bg-transparent">
      <AppTopNav />
      <main className="w-full px-4 py-6 sm:px-5 lg:px-6">
        <CalendarWorkspace />
      </main>
    </div>
  );
}
