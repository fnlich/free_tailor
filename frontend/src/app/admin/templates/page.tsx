'use client';

import { useState, useEffect, useRef } from 'react';
import { templatesApi, Template, getApiOrigin } from '@/lib/api';
import ManualTemplateEditor from '@/components/admin/ManualTemplateEditor';
import chrome from '@/components/admin/profileTemplateChrome.module.css';
import { IconClose } from '@/components/icons';
import { EmptyState, Field, Notice, PageHeader, Pill, Spinner } from '@/components/ui/kit';
import { useAuth } from '@/contexts/AuthContext';
import { pdfTooLargeMessage } from '@/lib/upload';

/**
 * The preview document's own size, in CSS pixels: A4 at 96 DPI, the page
 * `page.pdf()` is always asked for.
 *
 * The backend builds each preview at the page box that template will really be
 * printed into - it reads the template's own `@page` rule, because Chrome obeys
 * that and ignores the margin passed to `page.pdf()` - and scales anything that
 * asks for a different paper size to fit this one, exactly as printing does. So
 * the frame is A4-shaped whatever the template declares. Get these wrong and the
 * frame reflows the content at some other width, which is the whole reason the
 * old preview did not resemble the PDF it was previewing. The height is fixed
 * rather than stretched for the same reason: it is what `vh` resolves against.
 */
const PREVIEW_DOCUMENT_WIDTH_PX = 794; // A4 width at 96 DPI
const PREVIEW_DOCUMENT_HEIGHT_PX = 1123; // A4 height at 96 DPI
const PREVIEW_THUMBNAIL_SCALE = 0.44;

/** Full-size preview: the resume at the size it will actually print. */
function TemplateViewModal({
  template,
  onClose,
}: {
  template: Template;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    // The page behind must not scroll while the sheet is open.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  const previewUrl = `${getApiOrigin()}/api/templates/${encodeURIComponent(template.id)}/preview`;

  return (
    <div
      className="fixed inset-0 z-[var(--layer-app-modal)] flex flex-col bg-black/70"
      role="dialog"
      aria-modal="true"
      aria-label={`${template.name} preview`}
      onClick={onClose}
    >
      <div className={chrome.viewerBar}>
        <div className="min-w-0">
          <div className="truncate font-semibold text-ink">{template.name}</div>
          <div className="truncate text-xs text-muted">
            {template.description || 'Rendered with sample data at printed page size'}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <a
            href={previewUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => event.stopPropagation()}
            className="tl-button-quiet"
            data-size="sm"
          >
            Open in new tab
          </a>
          <button
            type="button"
            onClick={onClose}
            className="tl-button-quiet"
            data-size="sm"
          >
            Close
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4" onClick={onClose}>
        <iframe
          src={previewUrl}
          title={`${template.name} full preview`}
          onClick={(event) => event.stopPropagation()}
          className={chrome.paper}
          style={{ width: PREVIEW_DOCUMENT_WIDTH_PX, height: PREVIEW_DOCUMENT_HEIGHT_PX }}
        />
      </div>
    </div>
  );
}

function TemplateBasicEditModal({
  template,
  onSave,
  onCancel,
}: {
  template: Template;
  onSave: (name: string, description: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(template.name);
  const [description, setDescription] = useState(template.description ?? '');
  const [isSaving, setIsSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setIsSaving(true);
    try {
      await onSave(name.trim(), description.trim());
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="tl-backdrop">
      <div
        className="tl-dialog max-w-md"
        role="dialog"
        aria-modal="true"
        aria-labelledby="template-basic-edit-title"
      >
        <div className={chrome.dialogHead}>
          <h2 id="template-basic-edit-title" className="text-xl font-bold tracking-tight text-ink">
            Edit Template
          </h2>
        </div>
        <form onSubmit={handleSubmit} className="space-y-6 p-6">
          <Field label="Name" htmlFor="template-basic-name">
            <input
              id="template-basic-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="tl-input"
            />
          </Field>
          <Field label="Description" htmlFor="template-basic-description">
            <input
              id="template-basic-description"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="tl-input"
            />
          </Field>
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onCancel} className="tl-button-quiet">
              Cancel
            </button>
            <button type="submit" disabled={isSaving || !name.trim()} className="tl-button">
              {isSaving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** The spinner inside a solid button: white, so it shows on the accent. */
function ButtonSpinner() {
  return (
    <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden>
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}

function TemplatesPageBody() {
  // uploadMaxMb is the server's UPLOAD_MAX_MB, served on /auth/me - see lib/upload.ts.
  const { isAdmin, uploadMaxMb } = useAuth();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState('');
  const [uploadError, setUploadError] = useState('');
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showJsonUploadModal, setShowJsonUploadModal] = useState(false);
  const [showManualModal, setShowManualModal] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<Template | null>(null);
  const [editingBasicTemplate, setEditingBasicTemplate] = useState<Template | null>(null);
  const [viewingTemplate, setViewingTemplate] = useState<Template | null>(null);
  const [templateName, setTemplateName] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [selectedJsonFile, setSelectedJsonFile] = useState<File | null>(null);
  const [jsonUploadError, setJsonUploadError] = useState('');
  const [isJsonUploading, setIsJsonUploading] = useState(false);
  const [jsonUploadNotice, setJsonUploadNotice] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const jsonFileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadTemplates();
    // isAdmin decides whether disabled templates are asked for at all, so a
    // reload is needed when it settles - it is false while the account is
    // still loading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  const loadTemplates = async () => {
    try {
      // Disabled ones exist only as an administrator's staging state; to
      // everybody else they are simply not templates. The server takes the
      // same view, so this is a courtesy rather than the enforcement.
      const data = await templatesApi.getAll({ includeDisabled: isAdmin });
      setTemplates(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load templates');
    } finally {
      setIsLoading(false);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.type !== 'application/pdf') {
        setUploadError('Please select a PDF file');
        return;
      }
      const tooLarge = pdfTooLargeMessage(file, uploadMaxMb);
      if (tooLarge) {
        setUploadError(tooLarge);
        return;
      }
      setSelectedFile(file);
      setUploadError('');
      if (!templateName) {
        // Auto-fill template name from filename
        const name = file.name.replace('.pdf', '').replace(/[-_]/g, ' ');
        setTemplateName(name);
      }
    }
  };

  const handleUpload = async () => {
    if (!selectedFile) {
      setUploadError('Please select a file');
      return;
    }
    if (!templateName.trim()) {
      setUploadError('Please enter a template name');
      return;
    }

    setIsUploading(true);
    setUploadError('');

    try {
      await templatesApi.upload(selectedFile, templateName.trim());
      await loadTemplates();
      setShowUploadModal(false);
      setTemplateName('');
      setSelectedFile(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    } catch (err) {
      setUploadError(
        err instanceof Error ? err.message : 'Failed to upload template'
      );
    } finally {
      setIsUploading(false);
    }
  };

  const handleToggleDisabled = async (template: Template) => {
    try {
      await templatesApi.update(template.id, { disabled: !template.disabled });
      await loadTemplates();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update template status');
    }
  };

  const handleBasicEditSave = async (name: string, description: string) => {
    if (!editingBasicTemplate) return;
    try {
      await templatesApi.update(editingBasicTemplate.id, { name, description });
      await loadTemplates();
      setEditingBasicTemplate(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update template');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this template?')) return;
    try {
      await templatesApi.delete(id);
      await loadTemplates();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete template');
    }
  };

  const closeModal = () => {
    setShowUploadModal(false);
    setTemplateName('');
    setSelectedFile(null);
    setUploadError('');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleJsonFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (!file.name.toLowerCase().endsWith('.json')) {
        setJsonUploadError('Please select a JSON file');
        return;
      }
      setSelectedJsonFile(file);
      setJsonUploadError('');
    }
  };

  const handleJsonUpload = async () => {
    if (!selectedJsonFile) {
      setJsonUploadError('Please select a JSON file');
      return;
    }
    setIsJsonUploading(true);
    setJsonUploadError('');
    setJsonUploadNotice('');
    try {
      const result = await templatesApi.uploadJson(selectedJsonFile);
      await loadTemplates();
      setShowJsonUploadModal(false);
      setSelectedJsonFile(null);
      // Said out loud, because a file may hold several and the list is sorted
      // by date rather than grouped - so "did all six arrive?" is not a
      // question the page itself answers.
      const renamed = result.imported - result.keptIds;
      setJsonUploadNotice(
        `Imported ${result.imported} template${result.imported === 1 ? '' : 's'}` +
          (renamed > 0
            ? `. ${renamed} had an id already in use here and ${renamed === 1 ? 'was' : 'were'} given a new one.`
            : '.')
      );
      if (jsonFileInputRef.current) jsonFileInputRef.current.value = '';
    } catch (err) {
      setJsonUploadError(err instanceof Error ? err.message : 'Failed to upload template');
    } finally {
      setIsJsonUploading(false);
    }
  };

  const closeJsonModal = () => {
    setShowJsonUploadModal(false);
    setSelectedJsonFile(null);
    setJsonUploadError('');
    if (jsonFileInputRef.current) jsonFileInputRef.current.value = '';
  };

  if (isLoading) {
    return <Spinner label="Loading templates..." />;
  }

  /*
   * The three ways to add one, in the header and again in the empty state:
   * building one by hand is the main action, the two imports sit beside it.
   */
  const addActions = (
    <>
      <button
        onClick={() => setShowUploadModal(true)}
        className="tl-button-quiet"
      >
        Upload PDF Template
      </button>
      <button
        onClick={() => setShowJsonUploadModal(true)}
        className="tl-button-quiet"
      >
        Upload JSON Template
      </button>
      <button
        onClick={() => setShowManualModal(true)}
        className="tl-button"
        data-shape="pill"
      >
        Add Manual Template
      </button>
    </>
  );

  /*
   * No <main> here: app/admin/layout.tsx already wraps every /admin/* route
   * in one, with the gutters and the width.
   */
  return (
    <div>
      <PageHeader
        title="Templates"
        description={
          isAdmin
            ? 'Every template on this installation, with a full preview of each.'
            : 'Every template on this installation, with a full preview of each. They are shared by everybody here, so only an administrator can add or change one - you pick the one you want on your profile, or for a single run.'
        }
        actions={isAdmin ? addActions : undefined}
      />

      <div className="mb-6 space-y-3 empty:hidden">
        {jsonUploadNotice && (
          <Notice tone="success" role="status" className="flex items-start justify-between gap-4">
            <span>{jsonUploadNotice}</span>
            <button
              onClick={() => setJsonUploadNotice('')}
              className="-my-0.5 shrink-0 text-lg leading-none opacity-70 hover:opacity-100"
              aria-label="Dismiss"
            >
              &times;
            </button>
          </Notice>
        )}

        {error && (
          <Notice tone="error" role="alert">
            {error}
          </Notice>
        )}
      </div>

      {(showManualModal || editingTemplate) && (
        <ManualTemplateEditor
          initialTemplate={editingTemplate ?? undefined}
          onSuccess={() => {
            setShowManualModal(false);
            setEditingTemplate(null);
            loadTemplates();
          }}
          onCancel={() => {
            setShowManualModal(false);
            setEditingTemplate(null);
          }}
        />
      )}

      {/* Simple edit modal for non-manual templates */}
      {editingBasicTemplate && (
        <TemplateBasicEditModal
          template={editingBasicTemplate}
          onSave={handleBasicEditSave}
          onCancel={() => setEditingBasicTemplate(null)}
        />
      )}

      {/* Upload JSON Template Modal */}
      {showJsonUploadModal && (
        <div className="tl-backdrop">
          <div
            className="tl-dialog max-w-md"
            role="dialog"
            aria-modal="true"
            aria-labelledby="template-json-upload-title"
          >
            <div className={chrome.dialogHead}>
              <h2 id="template-json-upload-title" className="text-xl font-bold tracking-tight text-ink">
                Upload JSON Template
              </h2>
              <button
                onClick={closeJsonModal}
                className="tl-icon-button"
                aria-label="Close"
              >
                <IconClose className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-5 p-6">
              <p className="text-sm text-muted">
                A template needs <code className={chrome.code}>name</code> and{' '}
                <code className={chrome.code}>htmlContent</code>;{' '}
                <code className={chrome.code}>sections</code>,{' '}
                <code className={chrome.code}>description</code> and{' '}
                <code className={chrome.code}>cssContent</code> are optional.
                The file may hold one template, a list of them, or{' '}
                <code className={chrome.code}>{'{ "templates": [ ... ] }'}</code> —
                so an exported set goes straight back in.
              </p>

              {jsonUploadError && (
                <Notice tone="error" role="alert">
                  {jsonUploadError}
                </Notice>
              )}

              <div>
                <input
                  ref={jsonFileInputRef}
                  type="file"
                  accept=".json,application/json"
                  onChange={handleJsonFileSelect}
                  className="hidden"
                  id="json-upload"
                />
                <label htmlFor="json-upload" className={chrome.dropzone}>
                  <svg className="mx-auto h-10 w-10 text-subtle" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24" aria-hidden>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  <p className="mt-2 text-sm text-muted">
                    {selectedJsonFile ? (
                      <span className="font-medium text-accent-ink">{selectedJsonFile.name}</span>
                    ) : (
                      <>
                        <span className="font-medium text-accent-ink">Click to upload</span> or drag and drop
                      </>
                    )}
                  </p>
                  <p className="mt-1 text-xs text-subtle">JSON only, max 2MB</p>
                </label>
              </div>

              <div className="flex justify-end gap-3">
                <button
                  type="button"
                  onClick={closeJsonModal}
                  className="tl-button-quiet"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleJsonUpload}
                  disabled={isJsonUploading || !selectedJsonFile}
                  className="tl-button"
                >
                  {isJsonUploading ? (
                    <>
                      <ButtonSpinner />
                      Uploading...
                    </>
                  ) : (
                    'Upload'
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showUploadModal && (
        <div className="tl-backdrop">
          <div
            className="tl-dialog max-w-md"
            role="dialog"
            aria-modal="true"
            aria-labelledby="template-pdf-upload-title"
          >
            <div className={chrome.dialogHead}>
              <h2 id="template-pdf-upload-title" className="text-xl font-bold tracking-tight text-ink">
                Upload PDF Template
              </h2>
              <button
                onClick={closeModal}
                className="tl-icon-button"
                aria-label="Close"
              >
                <IconClose className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-5 p-6">
              <p className="text-sm text-muted">
                Upload an existing resume PDF and we&apos;ll automatically extract its
                design as a reusable template.
              </p>

              {uploadError && (
                <Notice tone="error" role="alert">
                  {uploadError}
                </Notice>
              )}

              <Field label="Template Name" htmlFor="pdf-template-name">
                <input
                  id="pdf-template-name"
                  type="text"
                  value={templateName}
                  onChange={(e) => setTemplateName(e.target.value)}
                  placeholder="e.g., Modern Professional"
                  className="tl-input"
                />
              </Field>

              <Field label="PDF File">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf"
                  onChange={handleFileSelect}
                  className="hidden"
                  id="pdf-upload"
                />
                <label htmlFor="pdf-upload" className={chrome.dropzone}>
                  <svg className="mx-auto h-10 w-10 text-subtle" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24" aria-hidden>
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                    />
                  </svg>
                  <p className="mt-2 text-sm text-muted">
                    {selectedFile ? (
                      <span className="font-medium text-accent-ink">{selectedFile.name}</span>
                    ) : (
                      <>
                        <span className="font-medium text-accent-ink">
                          Click to upload
                        </span>{' '}
                        or drag and drop
                      </>
                    )}
                  </p>
                  <p className="mt-1 text-xs text-subtle">PDF only, max {uploadMaxMb}MB</p>
                </label>
              </Field>

              <div className="flex justify-end gap-3">
                <button
                  onClick={closeModal}
                  className="tl-button-quiet"
                >
                  Cancel
                </button>
                <button
                  onClick={handleUpload}
                  disabled={isUploading || !selectedFile}
                  className="tl-button"
                >
                  {isUploading ? (
                    <>
                      <ButtonSpinner />
                      Extracting...
                    </>
                  ) : (
                    'Upload & Extract'
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Templates Grid */}
      {templates.length === 0 ? (
        <EmptyState
          title="No templates"
          action={
            isAdmin ? <div className="flex flex-wrap justify-center gap-3">{addActions}</div> : undefined
          }
        >
          {isAdmin
            ? 'Upload a PDF resume to extract its design as a template.'
            : 'None are set up on this installation yet. Ask an administrator here to add one.'}
        </EmptyState>
      ) : (
        <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
          {templates.map((template) => (
            <div
              key={template.id}
              className="tl-card flex flex-col overflow-hidden"
            >
              <div className="p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-base font-semibold text-ink">
                    {template.name}
                  </h3>
                  {template.disabled && <Pill tone="grey">Disabled</Pill>}
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-muted">
                  {template.description}
                </p>
              </div>

              <button
                type="button"
                onClick={() => setViewingTemplate(template)}
                title={`View ${template.name} at full size`}
                className={`group relative block w-full cursor-zoom-in overflow-hidden ${chrome.preview}`}
                style={{ height: 320 }}
              >
                <iframe
                  src={`${getApiOrigin()}/api/templates/${encodeURIComponent(template.id)}/preview`}
                  title={`Preview of ${template.name}`}
                  scrolling="no"
                  // Every card holds a real render of the resume, so without
                  // this the whole grid fetches at once and the last cards are
                  // still blank seconds after the page settles.
                  loading="lazy"
                  className="pointer-events-none absolute top-0 border-0"
                  style={{
                    transform: `scale(${PREVIEW_THUMBNAIL_SCALE})`,
                    transformOrigin: 'top left',
                    width: PREVIEW_DOCUMENT_WIDTH_PX,
                    height: PREVIEW_DOCUMENT_HEIGHT_PX,
                    // Scaling from the top-left leaves the page hugging the
                    // left edge of the card. The rendered width is known, so
                    // half of it is exactly the offset that centres it.
                    left: '50%',
                    marginLeft: -(PREVIEW_DOCUMENT_WIDTH_PX * PREVIEW_THUMBNAIL_SCALE) / 2,
                  }}
                />
                <span
                  className={`absolute inset-0 flex items-end justify-center pb-3 opacity-0 transition group-hover:opacity-100 ${chrome.zoomScrim}`}
                >
                  <span className={chrome.zoomHint}>
                    View full size
                  </span>
                </span>
              </button>

              <div className="mt-auto flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                <span className="text-xs text-subtle">
                  Created: {new Date(template.createdAt).toLocaleDateString()}
                </span>

                <div className="flex flex-wrap justify-end gap-2">
                  <button
                    onClick={() => setViewingTemplate(template)}
                    className="tl-button-quiet"
                    data-size="sm"
                  >
                    View
                  </button>
                  {isAdmin && (
                    <>
                      <button
                        onClick={() =>
                          template.id.startsWith('m-')
                            ? setEditingTemplate(template)
                            : setEditingBasicTemplate(template)
                        }
                        className="tl-button-quiet"
                        data-size="sm"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleToggleDisabled(template)}
                        className="tl-button-quiet"
                        data-size="sm"
                      >
                        {template.disabled ? 'Enable' : 'Disable'}
                      </button>
                      {!template.isBuiltIn && (
                        <button
                          onClick={() => handleDelete(template.id)}
                          className="tl-button-quiet"
                          data-size="sm"
                          data-tone="danger"
                        >
                          Delete
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {viewingTemplate && (
        <TemplateViewModal
          template={viewingTemplate}
          onClose={() => setViewingTemplate(null)}
        />
      )}
    </div>
  );
}

/**
 * Open to read, administrator-only to change.
 *
 * Templates are shared by the whole installation: one person editing a layout
 * changes what every other account's resumes come out looking like, so every
 * write stays with the administrators. Looking at them is a different matter -
 * somebody choosing a template for their profile needs to see what the choice
 * actually produces, and a name in a dropdown does not tell them.
 *
 * The API already draws exactly this line (routes/templates.ts: `requireUser`
 * on the router, `requireAdmin` on each write), so hiding the buttons here is
 * the courtesy and the middleware is the enforcement.
 */
export default function TemplatesPage() {
  return <TemplatesPageBody />;
}
