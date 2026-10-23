'use client';

import { SettingsCard } from '@/components/resume/parts';
import type { ResumeKeywords } from '@/lib/api';
import { KeywordChips } from './KeywordChips';

/**
 * The editor's read-only Keywords card, on the Customize tab: the job titles
 * and the skills and technologies the server read from this resume. They are
 * worked out when the resume is saved, and they are what the matcher compares
 * a posting with when a run picks one of the profile's resumes; this card only
 * shows them.
 */
export function KeywordsCard({ keywords }: { keywords: ResumeKeywords | undefined }) {
  return (
    <SettingsCard
      title="Keywords"
      description="What this resume says it is for. Choose Suitable Resume and Partial Tailor compare them with each posting to pick the best-matching resume of the profile."
    >
      <KeywordChips keywords={keywords} />
    </SettingsCard>
  );
}
