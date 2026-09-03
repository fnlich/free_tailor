'use client';

import type { ReactNode } from 'react';

interface ResumePreviewProps {
  html: string;
  onGenerate: () => void;
  onClose: () => void;
  isGenerating: boolean;
  isTailored: boolean;
  isOpen: boolean;
  generationStep?: string;
  sidebar?: ReactNode;
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
}: ResumePreviewProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm">
      <div className="absolute inset-4 bg-white rounded-xl shadow-2xl flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b bg-gray-50">
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-semibold text-gray-900">Resume Preview</h3>
            {isTailored && (
              <span className="px-2 py-1 bg-green-100 text-green-700 text-xs rounded-full">
                ATS OPTIMIZATION
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onGenerate}
              disabled={isGenerating}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-not-allowed font-medium transition-colors"
            >
              {isGenerating ? (
                <span className="flex items-center">
                  <svg
                    className="animate-spin -ml-1 mr-2 h-4 w-4 text-white"
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
                'Generate Resume'
              )}
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={isGenerating}
              className="px-3 py-2 text-sm bg-white text-gray-700 border border-gray-200 rounded-md hover:bg-gray-50 disabled:text-gray-400"
            >
              Close
            </button>
          </div>
        </div>

        <div className={sidebar ? 'flex-1 grid grid-cols-2 overflow-hidden' : 'flex-1 overflow-y-auto bg-gray-100 p-6'}>
          <div className={sidebar ? 'h-full overflow-y-auto bg-gray-100 p-6' : ''}>
            {html ? (
              <div className="resume-paper-shell bg-white shadow-lg mx-auto max-w-[816px]">
                <iframe srcDoc={html} className="w-full h-[1056px] border-0" title="Resume Preview" />
              </div>
            ) : (
              <div className="flex items-center justify-center h-[600px] text-gray-500">
                <div className="text-center">
                  <svg
                    className="mx-auto h-16 w-16 text-gray-400"
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
                  <p className="mt-4 text-lg font-medium">No Preview Available</p>
                  <p className="mt-2 text-sm">
                    Select a profile and template, then click &quot;Generate Resume&quot;
                  </p>
                </div>
              </div>
            )}
          </div>
          {sidebar && <div className="h-full overflow-y-auto border-l p-6 space-y-6">{sidebar}</div>}
        </div>
      </div>
    </div>
  );
}
