'use client';

import { useState } from 'react';
import Dialog from '@/components/ui/Dialog';

/**
 * What a Generate Immediately click asks first (owner decision B4).
 *
 * The run is tied to the tab: the resumes download into this browser as they
 * are built, and closing the tab or leaving Build Resumes stops what has not
 * started (and refunds it). That is the right trade for a handful of resumes
 * and a surprise for anybody who expected to walk away - hence the question,
 * once, with a way to stop being asked in this browser.
 *
 * Mount it only while it is open, so "Don't show again" starts unticked each
 * time.
 */
export default function ImmediateRunConfirm({
  onCancel,
  onProceed,
}: {
  onCancel: () => void;
  /** `dontShowAgain`: remember, for this browser, not to ask again. */
  onProceed: (dontShowAgain: boolean) => void;
}) {
  const [dontShowAgain, setDontShowAgain] = useState(false);

  return (
    <Dialog
      open
      title="Generate Immediately"
      onClose={onCancel}
      footer={
        <>
          <button type="button" onClick={onCancel} className="tl-button-quiet">
            Cancel
          </button>
          <button type="button" onClick={() => onProceed(dontShowAgain)} className="tl-button">
            Proceed
          </button>
        </>
      }
    >
      <p className="text-base text-ink">
        If you close the tab or the network drops, the run can be stopped. Would you like to proceed?
      </p>
      <p className="mt-3 text-sm text-muted">
        Each resume downloads to this browser as soon as it is built, so keep this page open until the
        run finishes. Resumes that had not started when it stopped are refunded.
      </p>
      <label className="mt-5 flex cursor-pointer items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          checked={dontShowAgain}
          onChange={(event) => setDontShowAgain(event.target.checked)}
          className="tl-check"
        />
        Don&apos;t show again
      </label>
    </Dialog>
  );
}
