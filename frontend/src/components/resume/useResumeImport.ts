'use client';

import { useCallback, useRef, useState } from 'react';
import {
  isProfileLimit,
  resumesApi,
  readResumeImportFile,
  type Resume,
  type ResumeImportResult,
} from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { pdfSizeRefusal } from '@/lib/upload';

/**
 * Opens the browser's file picker on its own, for a button: a hidden input
 * for this one choice, removed again once it has answered. Resolves to null
 * when the picker is dismissed (in a browser that says so; one that does not
 * simply never resolves, and nothing waits on it).
 */
export function chooseFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.hidden = true;
    const done = (file: File | null) => {
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => done(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => done(null), { once: true });
    document.body.append(input);
    input.click();
  });
}

export const PDF_ACCEPT = '.pdf,application/pdf';
export const JSON_ACCEPT = '.json,application/json';

/**
 * The two ways an existing resume comes in, shared by the template chooser's
 * "Import existing resume" and the editor's "Import your existing resume":
 * a resume PDF, which an AI call reads into a new resume (free, like every
 * resume upload), and a resume JSON file, which already is one or more
 * resumes. Both are the server's own routes; this keeps the checks the page
 * makes first, the account re-read after (the resume count on the shell),
 * and the one failure to show, in one place.
 *
 * `profileId` is the profile the resumes are filed under (`?profileId=`);
 * with none the server files each under its person's name.
 *
 * `busy` is which one is running, so a second press cannot send another.
 */
export function useResumeImport(profileId?: string | null) {
  const { refresh, uploadMaxMb, refreshUploadMaxMb } = useAuth();
  const [busy, setBusy] = useState<'pdf' | 'json' | null>(null);
  /** One of the page's sentences, or a caught failure for <ErrorNotice> to word. */
  const [error, setError] = useState<unknown>(null);
  const running = useRef(false);

  /** A resume PDF as a new, saved resume; null when it was refused, with the reason in `error`. */
  const importPdf = useCallback(
    async (file: File): Promise<Resume | null> => {
      if (running.current) return null;
      setError(null);
      if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
        setError('Please upload a PDF file.');
        return null;
      }
      running.current = true;
      setBusy('pdf');
      try {
        const tooLarge = await pdfSizeRefusal(file, uploadMaxMb, refreshUploadMaxMb);
        if (tooLarge) {
          setError(tooLarge);
          return null;
        }
        // `?profileId=`: a resume with no profile named is filed by the server under its person's name.
        const resume = await resumesApi.uploadPdf(file, profileId ? { profileId } : undefined);
        await refresh();
        return resume;
      } catch (err) {
        // The cap is only knowable server-side once the file is in; re-read it.
        if (isProfileLimit(err)) await refresh();
        setError(err ?? 'Failed to read a resume from that PDF.');
        return null;
      } finally {
        running.current = false;
        setBusy(null);
      }
    },
    [profileId, refresh, refreshUploadMaxMb, uploadMaxMb]
  );

  /**
   * A resume JSON file - one resume, a list, or { "resumes": [...] } - as
   * new resumes. No AI call: the file already is a resume, and the server
   * decides whether it really is one and says which entry is wrong if not.
   */
  const importJson = useCallback(
    async (file: File): Promise<ResumeImportResult | null> => {
      if (running.current) return null;
      setError(null);
      running.current = true;
      setBusy('json');
      try {
        // Not named `document`: that shadows the global inside this handler.
        const parsed = await readResumeImportFile(file);
        const result = await resumesApi.importJson(parsed, profileId ? { profileId } : undefined);
        await refresh();
        return result;
      } catch (err) {
        if (isProfileLimit(err)) await refresh();
        setError(err ?? 'Failed to import the resumes.');
        return null;
      } finally {
        running.current = false;
        setBusy(null);
      }
    },
    [profileId, refresh]
  );

  return { busy, error, setError, importPdf, importJson, uploadMaxMb };
}
