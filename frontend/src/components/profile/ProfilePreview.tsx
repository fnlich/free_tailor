'use client';

import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { profilesApi, type CreateProfileDTO, type ProfilePreviewResult } from '@/lib/api';
import chrome from '@/components/admin/profileTemplateChrome.module.css';
import { ErrorNotice } from '@/components/ui/kit';
import css from './profileEditor.module.css';

/**
 * The live preview: the editor's draft, drawn by the server through the same
 * pipeline as a generated resume, framed at its printed width and scaled to
 * the pane.
 *
 * Three things it is careful about:
 *
 *  - **Requests.** Typing is debounced (`debounceMs`), a discrete change - a
 *    template, a layout, a switch - goes at once, a request whose answer is no
 *    longer wanted is aborted, and a sequence number drops any answer that
 *    still arrives late. Nothing is sent while the pane is out of sight or
 *    while the draft is the one already on screen.
 *  - **The last good page stays up.** Two frames take turns: a new document
 *    loads in the hidden one and is swapped in only once it has loaded and been
 *    measured, so typing never blanks or jumps the page. A failure leaves the
 *    last page up under the error.
 *  - **The frame is inert.** `sandbox` without `allow-scripts`, so nothing in a
 *    template can run, and the server's CSP meta forbids every fetch as a
 *    second lock. `allow-same-origin` is there only so this page can read the
 *    document's height - with scripts off, the document itself cannot use it.
 */

export type PreviewRequest = { profile: CreateProfileDTO; profileId?: string };

type Measured = { height: number; padTop: number; padBottom: number };

/** One answer: the request it answered (as JSON), what came back, and its size once loaded. */
type Doc = { id: number; key: string; result: ProfilePreviewResult; measured: Measured | null };

type State = {
  slots: [Doc | null, Doc | null];
  /** The slot on screen; null until the first document has loaded. */
  front: 0 | 1 | null;
  /** The request the newest document answered. */
  renderedKey: string | null;
  error: unknown;
};

type Action =
  | { type: 'start' }
  | { type: 'arrived'; id: number; key: string; result: ProfilePreviewResult }
  | { type: 'loaded'; slot: 0 | 1; id: number; measured: Measured | null }
  | { type: 'failed'; error: unknown };

const INITIAL: State = { slots: [null, null], front: null, renderedKey: null, error: null };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'start':
      return state.error ? { ...state, error: null } : state;
    case 'arrived': {
      // Into whichever slot is NOT on screen, replacing a document still
      // loading there - the newer one is the one wanted.
      const back: 0 | 1 = state.front === 0 ? 1 : 0;
      const slots: State['slots'] = [...state.slots];
      slots[back] = { id: action.id, key: action.key, result: action.result, measured: null };
      return { ...state, slots, renderedKey: action.key, error: null };
    }
    case 'loaded': {
      const doc = state.slots[action.slot];
      if (!doc || doc.id !== action.id) return state;
      const slots: State['slots'] = [...state.slots];
      slots[action.slot] = { ...doc, measured: action.measured };
      return { ...state, slots, front: action.slot };
    }
    case 'failed':
      return { ...state, error: action.error };
  }
}

/** The loaded document's height and its page margins, or null if it cannot be read. */
function measure(frame: HTMLIFrameElement): Measured | null {
  try {
    const root = frame.contentDocument?.documentElement;
    if (!root) return null;
    const view = root.ownerDocument.defaultView ?? window;
    const style = view.getComputedStyle(root);
    return {
      height: root.scrollHeight,
      padTop: parseFloat(style.paddingTop) || 0,
      padBottom: parseFloat(style.paddingBottom) || 0,
    };
  } catch {
    return null;
  }
}

/**
 * Where the printed pages would break, in document px.
 *
 * Approximate on purpose: print repeats the page margins on every page and a
 * continuous document does not, so this is "about here", which is what the
 * dashed line says.
 */
function pageBreaks(
  measured: Measured | null,
  page: ProfilePreviewResult['page'] | undefined
): number[] {
  const contentHeightPx = page?.contentHeightPx;
  if (!measured || !page || !contentHeightPx || contentHeightPx < 100) return [];
  // A document no taller than the page is one page, whatever the arithmetic
  // says: a Letter template shrunk onto A4 has a content box shorter than the
  // sheet it sits on, and would otherwise grow a "Page 2" line in its margin.
  if (measured.height <= page.heightPx + 2) return [];
  const breaks: number[] = [];
  const end = measured.height - measured.padBottom;
  for (let y = measured.padTop + contentHeightPx; y < end - 8 && breaks.length < 20; y += contentHeightPx) {
    breaks.push(y);
  }
  return breaks;
}

export type PreviewStatus = 'waiting' | 'updating' | 'current' | 'error';

export default function ProfilePreview({
  request,
  active,
  debounceMs,
  templateName,
  notes,
}: {
  /** What to draw. Its JSON is the key: an unchanged draft is never re-sent. */
  request: PreviewRequest;
  /** False while the pane is hidden behind the Form tab. */
  active: boolean;
  debounceMs: number;
  /** The template the server drew with, by its display name. */
  templateName: (templateId: string) => string;
  /**
   * One-line notes from the editor - a fallback template, say - about the page
   * on screen. Given the request that page answered, not the draft as it is
   * now: between a change and its answer the two differ, and a note comparing
   * the newest draft with the older page would describe neither.
   */
  notes?: (shown: ProfilePreviewResult, request: PreviewRequest) => ReactNode;
}) {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const [retryCount, setRetryCount] = useState(0);
  const [paneWidth, setPaneWidth] = useState(0);
  const [viewerOpen, setViewerOpen] = useState(false);
  const sequence = useRef(0);
  const wellRef = useRef<HTMLDivElement>(null);

  const requestKey = JSON.stringify(request);
  // The very first page goes at once; after a failure typing is debounced
  // again, so a server that is down is not asked once per keystroke.
  const firstRender = state.renderedKey === null && !state.error;

  useEffect(() => {
    if (!active || requestKey === state.renderedKey) return;
    const controller = new AbortController();
    const id = ++sequence.current;
    const timer = window.setTimeout(
      () => {
        dispatch({ type: 'start' });
        profilesApi.preview(JSON.parse(requestKey) as PreviewRequest, controller.signal).then(
          (result) => {
            if (id === sequence.current) dispatch({ type: 'arrived', id, key: requestKey, result });
          },
          (error) => {
            if (controller.signal.aborted || id !== sequence.current) return;
            dispatch({ type: 'failed', error });
          }
        );
      },
      firstRender ? 0 : debounceMs
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // `retryCount` re-runs it for the same draft after a failure.
  }, [active, requestKey, state.renderedKey, debounceMs, firstRender, retryCount]);

  // The page is scaled to the well, so the well's width is state.
  useEffect(() => {
    const well = wellRef.current;
    if (!well || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) setPaneWidth(box.width);
    });
    observer.observe(well);
    return () => observer.disconnect();
  }, []);

  const onFrameLoad = useCallback((slot: 0 | 1, id: number, frame: HTMLIFrameElement) => {
    dispatch({ type: 'loaded', slot, id, measured: measure(frame) });
  }, []);

  const frontDoc = state.front === null ? null : state.slots[state.front];
  const shown = frontDoc?.result ?? null;
  const pageWidth = shown?.page.widthPx || 794;
  const pageHeight = shown?.page.heightPx || 1123;
  const docHeight = Math.max(frontDoc?.measured?.height ?? pageHeight, pageHeight);
  const scale = paneWidth > 0 ? Math.min(1, paneWidth / pageWidth) : 0;
  const breaks = pageBreaks(frontDoc?.measured ?? null, shown?.page);

  // Current only once the newest answer is the page on screen: between its
  // arrival and its frame loading, the page shown is still the older one.
  const newestId = Math.max(0, ...state.slots.map((doc) => doc?.id ?? 0));
  const status: PreviewStatus = state.error
    ? 'error'
    : !shown
      ? 'waiting'
      : requestKey === state.renderedKey && frontDoc?.id === newestId
        ? 'current'
        : 'updating';

  // Any slot holding a document gets a frame; the one not on screen is hidden.
  const frames = ([0, 1] as const).flatMap((slot) => {
    const doc = state.slots[slot];
    if (!doc) return [];
    const isFront = state.front === slot;
    return [
      <iframe
        key={doc.id}
        title={isFront ? 'Resume preview' : 'Resume preview (loading)'}
        srcDoc={doc.result.html}
        sandbox="allow-same-origin"
        // Sized to the document it holds, inside a well that does the
        // scrolling: a frame's own scrollbar is only ever a strip painted over
        // the page (a Letter template lays out wider than its A4 frame).
        scrolling="no"
        tabIndex={-1}
        aria-hidden={!isFront}
        data-front={isFront ? 'true' : 'false'}
        className={css.frame}
        onLoad={(event) => onFrameLoad(slot, doc.id, event.currentTarget)}
        style={{
          width: doc.result.page.widthPx,
          height: isFront ? Math.max(doc.measured?.height ?? 0, doc.result.page.heightPx) : doc.result.page.heightPx,
          transform: `scale(${scale})`,
        }}
      />,
    ];
  });

  return (
    <>
      <div className={css.previewHead}>
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-ink">Preview</h2>
          <p className="truncate text-xs text-muted">
            {shown ? templateName(shown.templateId) : 'Drawing the first page...'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className={css.previewStatus} role="status">
            <span className={css.statusDot} data-state={status} aria-hidden />
            {status === 'current'
              ? 'Up to date'
              : status === 'error'
                ? 'Not updated'
                : 'Updating...'}
          </span>
          <button
            type="button"
            className="tl-button-quiet"
            data-size="sm"
            disabled={!shown}
            onClick={() => setViewerOpen(true)}
          >
            Full size
          </button>
        </div>
      </div>

      <div className={css.previewNotes}>
        {state.error ? (
          <ErrorNotice error={state.error} fallback="Could not draw the preview">
            <p className="mt-2 text-xs opacity-90">
              {shown ? 'The page below is the last one that rendered. ' : ''}
              <button
                type="button"
                className="font-semibold underline underline-offset-2"
                onClick={() => setRetryCount((count) => count + 1)}
              >
                Try again
              </button>
            </p>
          </ErrorNotice>
        ) : null}
        {shown && frontDoc && notes?.(shown, JSON.parse(frontDoc.key) as PreviewRequest)}
      </div>

      <div ref={wellRef} className={css.previewScroll}>
        {state.slots.some(Boolean) ? (
          <div
            className={css.sheet}
            style={{ width: pageWidth * scale, height: docHeight * scale }}
          >
            {frames}
            {breaks.map((y, index) => (
              <div key={y} className={css.pageBreak} style={{ top: y * scale }} aria-hidden>
                <span>Page {index + 2}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className={css.placeholder}>
            {state.error ? 'Nothing to show yet.' : (
              <span className="flex items-center gap-3">
                <span className="tl-spinner" aria-hidden />
                Drawing the preview...
              </span>
            )}
          </div>
        )}
      </div>

      {viewerOpen && shown && (
        <PreviewViewer
          html={shown.html}
          widthPx={pageWidth}
          heightPx={docHeight}
          title={templateName(shown.templateId)}
          onClose={() => setViewerOpen(false)}
        />
      )}
    </>
  );
}

/** The preview at printed size, scrolled rather than scaled - for reading it, or pinching it on a phone. */
function PreviewViewer({
  html,
  widthPx,
  heightPx,
  title,
  onClose,
}: {
  html: string;
  widthPx: number;
  heightPx: number;
  title: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    // The page behind must not scroll while the viewer is open.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  // Into <body>: the pane it is opened from is sticky, which makes it a
  // stacking context, and a fixed overlay inside one is drawn under the app's
  // top bar and the form's save bar however high its own z-index.
  return createPortal(
    <div
      className="fixed inset-0 z-[var(--layer-app-modal)] flex flex-col bg-black/70"
      role="dialog"
      aria-modal="true"
      aria-label="Resume preview at full size"
      onClick={onClose}
    >
      <div className={chrome.viewerBar} onClick={(event) => event.stopPropagation()}>
        <div className="min-w-0">
          <div className="truncate font-semibold text-ink">Resume preview</div>
          <div className="truncate text-xs text-muted">{title} - at the size it prints</div>
        </div>
        <button type="button" onClick={onClose} className="tl-button-quiet" data-size="sm">
          Close
        </button>
      </div>
      <div className={css.viewerScroll}>
        <iframe
          srcDoc={html}
          sandbox="allow-same-origin"
          // As in the pane: .viewerScroll scrolls, the frame never does.
          scrolling="no"
          title="Resume preview at full size"
          className={css.viewerFrame}
          style={{ width: widthPx, height: heightPx }}
        />
      </div>
    </div>,
    document.body
  );
}
