'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ProfileLimitLink } from '@/components/subscription/LockedFeature';
import Dialog from '@/components/ui/Dialog';
import { ErrorNotice } from '@/components/ui/kit';
import { resumesApi, type TechnicalSkillsLayout } from '@/lib/api';
import { editorFont } from './editorFont';
import editorCss from './resumeEditor.module.css';
import css from './resumePages.module.css';
import { PDF_ACCEPT, chooseFile, useResumeImport } from './useResumeImport';

/**
 * "Import your existing resume", FlowCV's question when a new resume opens
 * on the template just chosen: Import resume, or Start from blank.
 *
 * Import resume is the resume PDF upload - an AI reads it into a new resume,
 * which the server saves at once - and the template and layout chosen a step
 * ago are then put on that resume, so it opens in its own editor exactly as
 * chosen. Start from blank, Close, Escape and the backdrop all leave the
 * empty editor as it is. While a file is being read nothing closes the
 * dialog: the resume it makes is about to open.
 */
export function ImportStartDialog({
  open,
  templateId,
  layout,
  templateName,
  profileId,
  onStartBlank,
}: {
  open: boolean;
  /** '' when the resume was started without one. */
  templateId: string;
  layout: TechnicalSkillsLayout;
  templateName: string;
  /** The profile the new resume is for (`?profile=`); the imported resume is filed under it. */
  profileId?: string | null;
  onStartBlank: () => void;
}) {
  const router = useRouter();
  const { busy, error, importPdf, uploadMaxMb } = useResumeImport(profileId);
  const [opening, setOpening] = useState(false);
  const working = busy !== null || opening;

  const importResume = async () => {
    const file = await chooseFile(PDF_ACCEPT);
    if (!file) return;
    const resume = await importPdf(file);
    if (!resume) return;
    setOpening(true);
    if (templateId) {
      try {
        await resumesApi.update(resume.id, {
          preferredTemplate: templateId,
          resumeSettings: { technicalSkillsLayout: layout },
        });
      } catch {
        // The resume is saved either way; its editor offers the template again.
      }
    }
    router.replace(`/admin/resumes/${encodeURIComponent(resume.id)}`);
  };

  return (
    <Dialog
      open={open}
      title="Import your existing resume"
      subtitle="Start faster by prefilling your resume content."
      onClose={() => {
        if (!working) onStartBlank();
      }}
      className={`${css.importDialog} ${editorCss.tokens} ${editorFont.variable}`}
    >
      <div className={css.importChoices}>
        <button type="button" className={css.importPrimary} onClick={importResume} disabled={working}>
          <span aria-hidden="true">🚀</span>
          Import resume
        </button>
        <button type="button" className={css.importSecondary} onClick={onStartBlank} disabled={working}>
          <span aria-hidden="true">✍️</span>
          Start from blank
        </button>
      </div>
      {working ? (
        <p className={css.importBusy} role="status">
          <span className="tl-spinner" aria-hidden />
          {opening ? 'Opening your new resume...' : 'Reading your resume. This can take a minute.'}
        </p>
      ) : (
        <p className={css.importNote}>
          A resume PDF under {uploadMaxMb} MB. An AI reads it into a new resume on {templateName}, saved as soon
          as it is read, and the editor opens on it for you to look over.
        </p>
      )}
      {error !== null && (
        <div className={css.importError}>
          <ErrorNotice error={error}>
            <ProfileLimitLink error={error} />
          </ErrorNotice>
        </div>
      )}
    </Dialog>
  );
}
