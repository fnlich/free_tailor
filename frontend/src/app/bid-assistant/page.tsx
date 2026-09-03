'use client';

import AppTopNav from '@/components/AppTopNav';
import BidAssistantApp from '@/bid-assistant/App.jsx';
import '@/bid-assistant/styles.css';

export default function BidAssistantPage() {
  return (
    <>
      <AppTopNav />
      <main className="bid-assistant-page">
        <BidAssistantApp />
      </main>
    </>
  );
}
