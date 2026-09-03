'use client';

import { useState, useEffect, useRef } from 'react';
import { templatesApi, Template, getApiOrigin } from '@/lib/api';
import ManualTemplateEditor from '@/components/admin/ManualTemplateEditor';

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
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl max-w-md w-full p-6">
        <h2 className="text-xl font-bold mb-4">Edit Template</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="flex justify-end gap-2 pt-4">
            <button type="button" onClick={onCancel} className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50">
              Cancel
            </button>
            <button type="submit" disabled={isSaving || !name.trim()} className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50">
              {isSaving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function TemplatesPage() {
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
  const [templateName, setTemplateName] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [selectedJsonFile, setSelectedJsonFile] = useState<File | null>(null);
  const [jsonUploadError, setJsonUploadError] = useState('');
  const [isJsonUploading, setIsJsonUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const jsonFileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadTemplates();
  }, []);

  const loadTemplates = async () => {
    try {
      const data = await templatesApi.getAll({ includeDisabled: true });
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
    try {
      await templatesApi.uploadJson(selectedJsonFile);
      await loadTemplates();
      setShowJsonUploadModal(false);
      setSelectedJsonFile(null);
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
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Resume Templates</h1>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setShowManualModal(true)}
            className="px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 font-medium"
          >
            Add Manual Template
          </button>
          <button
            onClick={() => setShowJsonUploadModal(true)}
            className="px-4 py-2 bg-violet-600 text-white rounded-lg hover:bg-violet-700 font-medium"
          >
            Upload JSON Template
          </button>
          <button
            onClick={() => setShowUploadModal(true)}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium"
          >
            Upload PDF Template
          </button>
        </div>
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

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-md mb-4">
          {error}
        </div>
      )}

      {/* Upload Modal */}
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
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl max-w-md w-full p-6">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-bold">Upload JSON Template</h2>
              <button
                onClick={closeJsonModal}
                className="text-gray-500 hover:text-gray-700 p-1"
                aria-label="Close"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <p className="text-sm text-gray-600 mb-4">
              Upload a template JSON file with <code className="text-xs bg-gray-100 px-1 rounded">name</code>, <code className="text-xs bg-gray-100 px-1 rounded">htmlContent</code>, <code className="text-xs bg-gray-100 px-1 rounded">sections</code>, and optional <code className="text-xs bg-gray-100 px-1 rounded">description</code>, <code className="text-xs bg-gray-100 px-1 rounded">cssContent</code>.
            </p>

            {jsonUploadError && (
              <div className="mb-4 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-md text-sm">
                {jsonUploadError}
              </div>
            )}

            <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center hover:border-violet-500 transition-colors mb-4">
              <input
                ref={jsonFileInputRef}
                type="file"
                accept=".json,application/json"
                onChange={handleJsonFileSelect}
                className="hidden"
                id="json-upload"
              />
              <label htmlFor="json-upload" className="cursor-pointer">
                <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <p className="mt-2 text-sm text-gray-600">
                  {selectedJsonFile ? (
                    <span className="text-violet-600 font-medium">{selectedJsonFile.name}</span>
                  ) : (
                    <>
                      <span className="text-violet-600 hover:text-violet-700">Click to upload</span> or drag and drop
                    </>
                  )}
                </p>
                <p className="mt-1 text-xs text-gray-500">JSON only, max 2MB</p>
              </label>
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={closeJsonModal}
                className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleJsonUpload}
                disabled={isJsonUploading || !selectedJsonFile}
                className="px-4 py-2 bg-violet-600 text-white rounded-md hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isJsonUploading ? (
                  <span className="flex items-center">
                    <svg className="animate-spin -ml-1 mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Uploading...
                  </span>
                ) : (
                  'Upload'
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {showUploadModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl max-w-md w-full p-6">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-bold">Upload PDF Template</h2>
              <button
                onClick={closeModal}
                className="text-gray-500 hover:text-gray-700"
              >
                <svg
                  className="w-6 h-6"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>

            <p className="text-sm text-gray-600 mb-4">
              Upload an existing resume PDF and we&apos;ll automatically extract its
              design as a reusable template.
            </p>

            {uploadError && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-md mb-4 text-sm">
                {uploadError}
              </div>
            )}

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Template Name
                </label>
                <input
                  type="text"
                  value={templateName}
                  onChange={(e) => setTemplateName(e.target.value)}
                  placeholder="e.g., Modern Professional"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  PDF File
                </label>
                <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center hover:border-blue-500 transition-colors">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pdf"
                    onChange={handleFileSelect}
                    className="hidden"
                    id="pdf-upload"
                  />
                  <label htmlFor="pdf-upload" className="cursor-pointer">
                    <svg
                      className="mx-auto h-12 w-12 text-gray-400"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                      />
                    </svg>
                    <p className="mt-2 text-sm text-gray-600">
                      {selectedFile ? (
                        <span className="text-blue-600">{selectedFile.name}</span>
                      ) : (
                        <>
                          <span className="text-blue-600 hover:text-blue-700">
                            Click to upload
                          </span>{' '}
                          or drag and drop
                        </>
                      )}
                    </p>
                    <p className="mt-1 text-xs text-gray-500">PDF only, max 10MB</p>
                  </label>
                </div>
              </div>
            </div>

            <div className="flex justify-end space-x-3 mt-6">
              <button
                onClick={closeModal}
                className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleUpload}
                disabled={isUploading || !selectedFile}
                className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isUploading ? (
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
                    Extracting...
                  </span>
                ) : (
                  'Upload & Extract'
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Templates Grid */}
      {templates.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-lg shadow">
          <svg
            className="mx-auto h-12 w-12 text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            />
          </svg>
          <h3 className="mt-2 text-sm font-medium text-gray-900">No templates</h3>
          <p className="mt-1 text-sm text-gray-500">
            Upload a PDF resume to extract its design as a template.
          </p>
          <div className="mt-6 flex flex-wrap gap-2 justify-center">
            <button
              onClick={() => setShowManualModal(true)}
              className="px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700"
            >
              Add Manual Template
            </button>
            <button
              onClick={() => setShowJsonUploadModal(true)}
              className="px-4 py-2 bg-violet-600 text-white rounded-lg hover:bg-violet-700"
            >
              Upload JSON Template
            </button>
            <button
              onClick={() => setShowUploadModal(true)}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              Upload PDF Template
            </button>
          </div>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {templates.map((template) => (
            <div
              key={template.id}
              className="bg-white rounded-lg shadow-md overflow-hidden hover:shadow-lg transition-shadow"
            >
              <div className="p-4 border-b">
                <div className="flex justify-between items-start">
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900">
                      {template.name}
                    </h3>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {template.disabled && (
                        <span className="inline-block px-2 py-0.5 bg-gray-200 text-gray-700 text-xs rounded">
                          Disabled
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <p className="text-sm text-gray-600 mt-1 line-clamp-2">
                  {template.description}
                </p>
              </div>

              <div className="relative bg-gray-100 overflow-auto" style={{ height: 320 }}>
                <iframe
                  src={`${getApiOrigin()}/api/templates/${encodeURIComponent(template.id)}/preview`}
                  title={`Preview of ${template.name}`}
                  className="absolute top-0 left-0 border-0 pointer-events-none"
                  style={{
                    transform: 'scale(0.28)',
                    transformOrigin: 'top left',
                    width: 794,
                    height: 1123,
                  }}
                />
              </div>

              <div className="p-4">
                <div className="text-xs text-gray-400 mb-4">
                  Created: {new Date(template.createdAt).toLocaleDateString()}
                </div>

                <div className="flex justify-end gap-2 pt-4 border-t">
                  <button
                    onClick={() =>
                      template.id.startsWith('m-')
                        ? setEditingTemplate(template)
                        : setEditingBasicTemplate(template)
                    }
                    className="px-3 py-1 text-sm text-blue-600 hover:bg-blue-50 rounded"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleToggleDisabled(template)}
                    className="px-3 py-1 text-sm text-amber-700 hover:bg-amber-50 rounded"
                  >
                    {template.disabled ? 'Enable' : 'Disable'}
                  </button>
                  <button
                    onClick={() => handleDelete(template.id)}
                    className="px-3 py-1 text-sm text-red-600 hover:bg-red-50 rounded"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
