'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import ResumeEditor from '@/components/resume/ResumeEditor';
import { ErrorNotice, Spinner } from '@/components/ui/kit';
import { resumesApi, type Resume } from '@/lib/api';

/**
 * Editing one resume, with its live preview.
 *
 * A route of its own rather than the dialog it used to be, so the editor has
 * the width for a form and a page side by side, and a resume can be linked to
 * and survives a reload. No <main>: app/admin/layout.tsx draws it - bare, for
 * this route, so the editor can lay out its own full-width desk; the loading
 * and error states pad themselves (`PADDED`).
 */

const PADDED = 'mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8';
export default function EditResumePage() {
  const params = useParams<{ id: string }>();
  const resumeId = typeof params?.id === 'string' ? params.id : '';

  const [loaded, setLoaded] = useState<{
    id: string;
    resume: Resume | null;
    error: unknown;
  } | null>(null);

  useEffect(() => {
    if (!resumeId) return;
    let live = true;
    // The resume alone: any resume may use any template, so the account's other
    // resumes are not needed, and the editor reads the resume's profile itself.
    resumesApi.getById(resumeId).then(
      (resume) => {
        if (live) setLoaded({ id: resumeId, resume, error: null });
      },
      (error) => {
        if (live) setLoaded({ id: resumeId, resume: null, error: error ?? 'Failed to load the resume.' });
      }
    );
    return () => {
      live = false;
    };
  }, [resumeId]);

  if (!loaded || loaded.id !== resumeId) {
    return (
      <div className={PADDED}>
        <Spinner label="Loading the resume..." />
      </div>
    );
  }

  if (!loaded.resume) {
    return (
      <div className={`${PADDED} space-y-4`}>
        <ErrorNotice error={loaded.error} fallback="Could not load this resume" />
        <Link href="/admin/profiles" className="tl-button-quiet">
          Back to profiles
        </Link>
      </div>
    );
  }

  return <ResumeEditor key={loaded.resume.id} resume={loaded.resume} />;
}
