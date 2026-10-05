'use client';

import type { ReactNode } from 'react';
import { Pill } from '@/components/ui/kit';
import styles from '@/components/builder.module.css';

interface ResumePreviewProps {
  html: string;
  onGenerate: () => void;
  onClose: () => void;
  isGenerating: boolean;
  isTailored: boolean;
  isOpen: boolean;
  generationStep?: string;
  sidebar?: ReactNode;
  /** What generating will cost, shown beside the button that does it. */
  costNote?: ReactNode;
  /** The generate button's label. */
  generateLabel?: string;
}

export default function ResumePreview({
  html,
  onGenerate,
  onClose,
  isGenerating,
  isTailored,
  isOpen,
  generationStep,
  sidebar,
  costNote,
  generateLabel = 'Generate Resume',
}: ResumePreviewProps) {
  if (!isOpen) return null;

  return (
    <div className="tl-backdrop">
      <div className={`tl-dialog ${styles.sheet}`}>
        <div className="tl-card-header">
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="text-lg font-semibold text-ink">Resume Preview</h3>
            {isTailored && (
              <Pill tone="green">
                ATS OPTIMIZATION
              </Pill>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {costNote}
            <button
              onClick={onGenerate}
              disabled={isGenerating}
              className={`tl-button ${styles.wrap}`}
            >
              {isGenerating ? (
                <span className="flex items-center">
                  <svg
                    className="animate-spin -ml-1 mr-2 h-4 w-4 shrink-0"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    ></circle>
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    ></path>
                  </svg>
                  {generationStep || 'Generating...'}
                </span>
              ) : (
                generateLabel
              )}
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={isGenerating}
              className="tl-button-quiet"
            >
              Close
            </button>
          </div>
        </div>

        {/*
          Two panes side by side from lg up, each scrolling on its own; below
          that, one column that scrolls as a whole - two half-width panes on a
          phone left the resume about 150px wide.
        */}
        <div
          className={
            sidebar
              ? 'min-h-0 flex-1 overflow-y-auto lg:grid lg:grid-cols-2 lg:overflow-hidden'
              : 'min-h-0 flex-1 overflow-y-auto bg-surface-muted p-4 sm:p-6'
          }
        >
          <div className={sidebar ? 'bg-surface-muted p-4 sm:p-6 lg:h-full lg:overflow-y-auto' : ''}>
            {html ? (
              <div className={`resume-paper-shell ${styles.paper} mx-auto max-w-[816px]`}>
                <iframe srcDoc={html} sandbox="" className="w-full h-[1056px] border-0" title="Resume Preview" />
              </div>
            ) : (
              <div className="flex items-center justify-center h-[600px] text-muted">
                <div className="text-center">
                  <svg
                    className="mx-auto h-16 w-16 text-subtle"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                    />
                  </svg>
                  <p className="mt-4 text-lg font-medium text-ink">No Preview Available</p>
                  <p className="mt-2 text-sm">
                    Select a profile and template, then click &quot;Generate Resume&quot;
                  </p>
                </div>
              </div>
            )}
          </div>
          {sidebar && (
            <div className="space-y-6 p-4 sm:p-6 lg:h-full lg:overflow-y-auto">{sidebar}</div>
          )}
        </div>
      </div>
    </div>
  );
}
