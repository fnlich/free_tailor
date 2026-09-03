'use client';

import { Template } from '@/lib/api';

interface TemplateSelectorProps {
  templates: Template[];
  selectedId: string | null;
  onChange: (id: string) => void;
  isLoading?: boolean;
  disabled?: boolean;
}

export default function TemplateSelector({
  templates,
  selectedId,
  onChange,
  isLoading,
  disabled = false,
}: TemplateSelectorProps) {
  const selectedTemplate = templates.find((t) => t.id === selectedId);

  if (disabled) {
    return (
      <div>
        <label className="block text-sm font-medium text-black mb-2">
          Template
        </label>
        <div className="w-full px-4 py-3 border border-gray-300 rounded-lg bg-gray-50 text-gray-700">
          {selectedTemplate ? selectedTemplate.name : selectedId || '—'}
        </div>
        <p className="mt-1 text-xs text-gray-500">Using profile&apos;s default template</p>
      </div>
    );
  }

  return (
    <div>
      <label className="block text-sm font-medium text-black mb-2">
        Select Template
      </label>
      <select
        value={selectedId || ''}
        onChange={(e) => onChange(e.target.value)}
        disabled={isLoading}
        className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white disabled:bg-gray-100 disabled:cursor-not-allowed"
      >
        <option value="">Choose a template...</option>
        {templates.map((template) => (
          <option key={template.id} value={template.id}>
            {template.name}
            {template.id === 'default' ? ' (Default)' : ''}
            {template.id.startsWith('m/') ? ' (m)' : ''}
          </option>
        ))}
      </select>
    </div>
  );
}
