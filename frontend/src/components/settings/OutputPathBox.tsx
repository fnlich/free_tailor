'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

import type { OutputPathPreview } from '@/lib/api';
import {
  createLatestGate,
  insertToken,
  OUTPUT_PATH_PREVIEW_DELAY_MS,
  type OutputPathTokenChip,
} from '@/lib/outputPath';
import { messageWithDetail } from '@/lib/userMessage';

/**
 * A box for half of where resumes are filed - the administrator's prefix or
 * an account's own folder path - with its tokens as chips that insert at the
 * caret, and a live preview drawn by the SERVER's function (the page never
 * renders a path): asked for once the typing has stopped, each new request
 * aborting the one before, and an answer shown only while it is for what the
 * box holds now. A value the server would refuse shows its sentences under
 * the box instead of a path, before anything is saved.
 */
export default function OutputPathBox({
  id,
  label,
  value,
  onChange,
  chips,
  preview,
  previewKey = '',
  placeholder,
  disabled = false,
  refusal,
  hint,
  source,
}: {
  id: string;
  label: ReactNode;
  value: string;
  onChange: (next: string) => void;
  chips: readonly OutputPathTokenChip[];
  /** The server's preview of what the box holds. */
  preview: (text: string, signal: AbortSignal) => Promise<OutputPathPreview>;
  /**
   * Anything else the preview is drawn with (the admin's output folder, as
   * its box holds it): a change asks again, as a change of the text does.
   */
  previewKey?: string;
  placeholder?: string;
  disabled?: boolean;
  /** A save's refusal, in the server's words, until the box is edited. */
  refusal?: string;
  hint?: ReactNode;
  /** The source line (components/ui/SettingSource), under the box. */
  source?: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const gate = useRef(createLatestGate());
  const pendingCaret = useRef<number | null>(null);
  /** The newest answer, and the question it answers: anything else is still being asked about. */
  const question = `${previewKey}\u0000${value}`;
  const [answered, setAnswered] = useState<{
    text: string;
    preview: OutputPathPreview | null;
    error: string;
  } | null>(null);
  // The latest `preview` without re-asking whenever a parent re-renders with a new function.
  const ask = useRef(preview);
  useEffect(() => {
    ask.current = preview;
  }, [preview]);

  useEffect(() => {
    const ticket = gate.current.begin();
    const controller = new AbortController();
    const timer = setTimeout(() => {
      ask.current(value, controller.signal).then(
        (answer) => {
          if (gate.current.isLatest(ticket)) setAnswered({ text: question, preview: answer, error: '' });
        },
        (error: unknown) => {
          if (controller.signal.aborted || !gate.current.isLatest(ticket)) return;
          setAnswered((current) => ({
            text: question,
            // The last path drawn stays up: a failed redraw says so beside it.
            preview: current?.preview ?? null,
            error: messageWithDetail(error, 'The preview could not be drawn'),
          }));
        }
      );
    }, OUTPUT_PATH_PREVIEW_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [value, question]);

  // Puts the caret after a chip once React has written the new value.
  useEffect(() => {
    if (pendingCaret.current === null || !input.current) return;
    const caret = pendingCaret.current;
    pendingCaret.current = null;
    input.current.focus();
    input.current.setSelectionRange(caret, caret);
  }, [value]);

  const insert = (token: string) => {
    const box = input.current;
    const next = insertToken(value, box?.selectionStart ?? null, box?.selectionEnd ?? null, token);
    pendingCaret.current = next.caret;
    onChange(next.text);
  };

  const shown = answered?.preview ?? null;
  const previewError = answered?.error ?? '';
  const asking = answered?.text !== question;
  const problems = asking ? [] : shown?.problems ?? [];
  const describedBy = `${id}-preview`;

  return (
    <div className="min-w-0">
      <label htmlFor={id} className="tl-label">
        {label}
      </label>
      <input
        ref={input}
        id={id}
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={Boolean(refusal) || problems.length > 0}
        aria-describedby={describedBy}
        className="tl-input mt-2 font-mono"
      />
      {source}
      <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Insert a token">
        {chips.map((entry) => (
          <button
            key={entry.token}
            type="button"
            className="tl-button-quiet font-mono"
            data-size="sm"
            title={entry.means}
            disabled={disabled}
            // Keeps the caret in the box: a mousedown on a button would take focus first.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => insert(entry.text)}
            data-token={entry.token}
          >
            {entry.text}
          </button>
        ))}
      </div>
      {hint && <p className="mt-2 text-sm text-subtle">{hint}</p>}
      <div id={describedBy} className="mt-3 text-sm" aria-live="polite">
        {refusal ? (
          <p className="tl-status" data-tone="error" role="alert">
            {refusal}
          </p>
        ) : problems.length > 0 ? (
          <ul className="tl-status space-y-1" data-tone="error" data-preview-problems>
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        ) : previewError && !asking ? (
          <p className="text-muted">{previewError}</p>
        ) : shown?.path ? (
          <p className="break-all text-muted">
            <span className="font-medium text-ink">Preview:</span>{' '}
            <code className="font-mono text-ink" data-preview-path>
              {shown.path}
            </code>
            {asking && <span className="ml-2 text-subtle">(updating...)</span>}
          </p>
        ) : (
          <p className="text-subtle">Drawing the preview...</p>
        )}
        {!refusal && !asking && problems.length === 0 && shown?.notes && shown.notes.length > 0 && (
          <ul className="mt-2 space-y-1 text-subtle" data-preview-notes>
            {shown.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
