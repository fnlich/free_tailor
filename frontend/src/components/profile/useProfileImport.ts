'use client';

import { useCallback, useRef, useState } from 'react';
import {
  isProfileLimit,
  profilesApi,
  readProfileImportFile,
  type Profile,
  type ProfileImportResult,
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
 * a resume PDF, which an AI call reads into a new profile (free, like every
 * profile upload), and a profile JSON file, which already is one or more
 * profiles. Both are the server's own routes; this keeps the checks the page
 * makes first, the account re-read after (the profile count on the shell),
 * and the one failure to show, in one place.
 *
 * `busy` is which one is running, so a second press cannot send another.
 */
export function useProfileImport() {
  const { refresh, uploadMaxMb, refreshUploadMaxMb } = useAuth();
  const [busy, setBusy] = useState<'pdf' | 'json' | null>(null);
  /** One of the page's sentences, or a caught failure for <ErrorNotice> to word. */
  const [error, setError] = useState<unknown>(null);
  const running = useRef(false);

  /** A resume PDF as a new, saved profile; null when it was refused, with the reason in `error`. */
  const importPdf = useCallback(
    async (file: File): Promise<Profile | null> => {
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
        const profile = await profilesApi.uploadResume(file);
        await refresh();
        return profile;
      } catch (err) {
        // The cap is only knowable server-side once the file is in; re-read it.
        if (isProfileLimit(err)) await refresh();
        setError(err ?? 'Failed to read a profile from that PDF.');
        return null;
      } finally {
        running.current = false;
        setBusy(null);
      }
    },
    [refresh, refreshUploadMaxMb, uploadMaxMb]
  );

  /**
   * A profile JSON file - one profile, a list, or { "profiles": [...] } - as
   * new profiles. No AI call: the file already is a profile, and the server
   * decides whether it really is one and says which entry is wrong if not.
   */
  const importJson = useCallback(
    async (file: File): Promise<ProfileImportResult | null> => {
      if (running.current) return null;
      setError(null);
      running.current = true;
      setBusy('json');
      try {
        // Not named `document`: that shadows the global inside this handler.
        const parsed = await readProfileImportFile(file);
        const result = await profilesApi.importJson(parsed);
        await refresh();
        return result;
      } catch (err) {
        if (isProfileLimit(err)) await refresh();
        setError(err ?? 'Failed to import the profiles.');
        return null;
      } finally {
        running.current = false;
        setBusy(null);
      }
    },
    [refresh]
  );

  return { busy, error, setError, importPdf, importJson, uploadMaxMb };
}
