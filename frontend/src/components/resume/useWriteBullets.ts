'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { resumesApi, type WriteBulletsRequest, type WriteBulletsTask } from '@/lib/api';
import { readBullets } from '@/lib/resumeDraft';

/**
 * One Write with AI / Improve with AI call for the entry on the panel.
 *
 *   idle     nothing asked, or the last answer undone or dismissed
 *   running  a request in flight; the box is disabled meanwhile
 *   failed   the server's sentence (a 400 about the entry, the 409 while
 *            another runs, the 503 with no model), for <ErrorNotice>
 *   done     the box holds the answer; `previousText` is what Undo puts back,
 *            `replacedWith` what the status line shows for as long as the box
 *            still equals it
 *
 * One AbortController at a time: a second press aborts the first, and the
 * panel's unmount aborts whatever is running, so an answer never lands in a
 * box that is gone. `apply` is the panel's: it puts text into the draft.
 */
export type WriteBulletsState =
  | { status: 'idle' }
  | { status: 'running'; task: WriteBulletsTask }
  | { status: 'failed'; error: unknown }
  | { status: 'done'; task: WriteBulletsTask; previousText: string; replacedWith: string };

export function useWriteBullets(apply: (text: string) => void) {
  const [state, setState] = useState<WriteBulletsState>({ status: 'idle' });
  const controller = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      controller.current?.abort();
    },
    []
  );

  const run = useCallback(
    async (body: WriteBulletsRequest, currentText: string) => {
      controller.current?.abort();
      const own = new AbortController();
      controller.current = own;
      setState({ status: 'running', task: body.task });
      try {
        const answer = await resumesApi.writeBullets(body, own.signal);
        if (own.signal.aborted) return;
        const bullets = readBullets(answer);
        if (bullets.length === 0) throw new Error('The answer held no bullets. Try again.');
        const replacedWith = bullets.join('\n');
        apply(replacedWith);
        setState({ status: 'done', task: body.task, previousText: currentText, replacedWith });
      } catch (error) {
        if (own.signal.aborted) return;
        setState({ status: 'failed', error: error ?? 'Failed to write the bullets.' });
      } finally {
        if (controller.current === own) controller.current = null;
      }
    },
    [apply]
  );

  const undo = useCallback(() => {
    if (state.status !== 'done') return;
    apply(state.previousText);
    setState({ status: 'idle' });
  }, [apply, state]);

  const reset = useCallback(() => setState({ status: 'idle' }), []);

  return { state, run, undo, reset };
}
