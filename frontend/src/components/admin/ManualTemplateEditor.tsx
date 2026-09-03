'use client';

import { useState, useEffect } from 'react';
import { templatesApi, Template, ManualTemplateConfigStored } from '@/lib/api';

const SECTIONS = [
  { id: 'summary', label: 'Summary' },
  { id: 'experience', label: 'Experience' },
  { id: 'strengths', label: 'Strengths' },
  { id: 'hardSkills', label: 'Hard Skills' },
  { id: 'softSkills', label: 'Soft Skills' },
  { id: 'education', label: 'Education' },
] as const;

const DEFAULT_LEFT = ['summary', 'experience'];
const DEFAULT_RIGHT = ['strengths', 'hardSkills', 'softSkills', 'education'];

/** Elements to style per section (backend expects elementId -> { color, fontSizePt }) */
const SECTION_ELEMENTS: Record<string, string[]> = {
  summary: ['sectionTitle', 'paragraph'],
  experience: ['sectionTitle', 'jobTitle', 'companyLine', 'description', 'achievements'],
  strengths: ['sectionTitle', 'strengthTitle', 'strengthDescription'],
  hardSkills: ['sectionTitle', 'skillText'],
  softSkills: ['sectionTitle', 'skillText'],
  education: ['sectionTitle', 'degree', 'institution', 'date'],
};

const SECTION_LABELS: Record<string, string> = {
  summary: 'Summary',
  experience: 'Experience',
  strengths: 'Strengths',
  hardSkills: 'Hard Skills',
  softSkills: 'Soft Skills',
  education: 'Education',
};

const ELEMENT_LABELS: Record<string, string> = {
  sectionTitle: 'Section title',
  paragraph: 'Paragraph',
  jobTitle: 'Job title',
  companyLine: 'Company line',
  description: 'Description',
  achievements: 'Achievements',
  strengthTitle: 'Strength title',
  strengthDescription: 'Strength description',
  skillText: 'Skill text',
  degree: 'Degree',
  institution: 'Institution',
  date: 'Date',
};

const FONT_FAMILIES = [
  "Calibri, 'Segoe UI', Arial, sans-serif",
  'Arial, Helvetica, sans-serif',
  'Georgia, serif',
  "'Times New Roman', Times, serif",
  'Verdana, Geneva, sans-serif',
] as const;

interface ElementStyleState {
  color: string;
  fontSizePt: number;
  fontFamily: string;
  fontWeight: 'normal' | 'bold';
}

function toElementStyle(s: ManualTemplateConfigStored['nameStyle'] | undefined): ElementStyleState {
  return {
    color: s?.color ?? '#1e40af',
    fontSizePt: s?.fontSizePt ?? 24,
    fontFamily: (s?.fontFamily as string) ?? FONT_FAMILIES[0],
    fontWeight: (s?.fontWeight as 'normal' | 'bold') ?? 'bold',
  };
}

function toContactStyle(s: ManualTemplateConfigStored['contactStyle'] | undefined): ElementStyleState {
  return {
    color: s?.color ?? '#333333',
    fontSizePt: s?.fontSizePt ?? 8,
    fontFamily: (s?.fontFamily as string) ?? FONT_FAMILIES[0],
    fontWeight: (s?.fontWeight as 'normal' | 'bold') ?? 'normal',
  };
}

function parseSectionStyles(
  sectionStyles?: ManualTemplateConfigStored['sectionStyles']
): Record<string, Record<string, ElementStyleState>> {
  if (!sectionStyles || Object.keys(sectionStyles).length === 0) {
    return {};
  }

  const parsed: Record<string, Record<string, ElementStyleState>> = {};
  for (const [secId, els] of Object.entries(sectionStyles)) {
    parsed[secId] = {};
    for (const [elId, s] of Object.entries(els)) {
      const style = s as { color?: string; fontSizePt?: number; fontFamily?: string; fontWeight?: string };
      parsed[secId][elId] = {
        color: style.color ?? '#000000',
        fontSizePt: style.fontSizePt ?? 9,
        fontFamily: style.fontFamily ?? FONT_FAMILIES[0],
        fontWeight: (style.fontWeight as 'normal' | 'bold') ?? 'normal',
      };
    }
  }

  return parsed;
}

export default function ManualTemplateEditor({
  onSuccess,
  onCancel,
  initialTemplate,
}: {
  onSuccess: () => void;
  onCancel: () => void;
  initialTemplate?: Template;
}) {
  const c = initialTemplate?.manualConfig;
  const [name, setName] = useState(c?.name ?? initialTemplate?.name ?? '');
  const [description, setDescription] = useState(c?.description ?? initialTemplate?.description ?? '');
  const [columns, setColumns] = useState<1 | 2>(c?.columns ?? 1);
  const [nameStyle, setNameStyle] = useState<ElementStyleState>(() => toElementStyle(c?.nameStyle));
  const [headerTitleStyle, setHeaderTitleStyle] = useState<ElementStyleState>(() => ({
    color: c?.headerTitleStyle?.color ?? '#1e40af',
    fontSizePt: c?.headerTitleStyle?.fontSizePt ?? 10,
    fontFamily: (c?.headerTitleStyle?.fontFamily as string) ?? FONT_FAMILIES[0],
    fontWeight: (c?.headerTitleStyle?.fontWeight as 'normal' | 'bold') ?? 'bold',
  }));
  const [contactStyle, setContactStyle] = useState<ElementStyleState>(() => toContactStyle(c?.contactStyle));
  const [sectionOrder, setSectionOrder] = useState<string[]>(() =>
    c?.sectionOrder?.length ? c.sectionOrder! : SECTIONS.map((s) => s.id)
  );
  const [leftSectionOrder, setLeftSectionOrder] = useState<string[]>(() =>
    c?.leftSectionOrder?.length ? c.leftSectionOrder! : [...DEFAULT_LEFT]
  );
  const [rightSectionOrder, setRightSectionOrder] = useState<string[]>(() =>
    c?.rightSectionOrder?.length ? c.rightSectionOrder! : [...DEFAULT_RIGHT]
  );

  useEffect(() => {
    if (!initialTemplate) return;

    const cfg = initialTemplate.manualConfig;
    setName(cfg?.name ?? initialTemplate.name);
    setDescription(cfg?.description ?? initialTemplate.description ?? '');
    setColumns(cfg?.columns ?? 1);
    setNameStyle(toElementStyle(cfg?.nameStyle));
    setHeaderTitleStyle({
      color: cfg?.headerTitleStyle?.color ?? '#1e40af',
      fontSizePt: cfg?.headerTitleStyle?.fontSizePt ?? 10,
      fontFamily: (cfg?.headerTitleStyle?.fontFamily as string) ?? FONT_FAMILIES[0],
      fontWeight: (cfg?.headerTitleStyle?.fontWeight as 'normal' | 'bold') ?? 'bold',
    });
    setContactStyle(toContactStyle(cfg?.contactStyle));
    setSectionOrder(cfg?.sectionOrder?.length ? cfg.sectionOrder : SECTIONS.map((s) => s.id));
    setLeftSectionOrder(cfg?.leftSectionOrder?.length ? cfg.leftSectionOrder : [...DEFAULT_LEFT]);
    setRightSectionOrder(cfg?.rightSectionOrder?.length ? cfg.rightSectionOrder : [...DEFAULT_RIGHT]);
    setSectionStyles(parseSectionStyles(cfg?.sectionStyles));
  }, [initialTemplate]);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<'left' | 'right' | null>(null);
  const [draggedColumn, setDraggedColumn] = useState<'left' | 'right' | 'single' | null>(null);
  const [selectedStyleItem, setSelectedStyleItem] = useState<'name' | 'title' | 'contact' | string | null>(null);
  const [expandedSection, setExpandedSection] = useState<string | null>(null);
  const [sectionStyles, setSectionStyles] = useState<Record<string, Record<string, ElementStyleState>>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  const defaultElementStyle: ElementStyleState = { color: '#000000', fontSizePt: 9, fontFamily: FONT_FAMILIES[0], fontWeight: 'normal' };
  const getSectionElementStyle = (sectionId: string, elementId: string) =>
    sectionStyles[sectionId]?.[elementId] ?? defaultElementStyle;
  const setSectionElementStyle = (sectionId: string, elementId: string, style: Partial<ElementStyleState>) =>
    setSectionStyles((prev) => ({
      ...prev,
      [sectionId]: {
        ...(prev[sectionId] ?? {}),
        [elementId]: { ...getSectionElementStyle(sectionId, elementId), ...style },
      },
    }));

  const buildSectionStylesPayload = () => {
    const payload: Record<string, Record<string, { color: string; fontSizePt: number; fontFamily?: string; fontWeight?: string }>> = {};
    for (const [sectionId, elements] of Object.entries(sectionStyles)) {
      if (!elements || Object.keys(elements).length === 0) continue;
      payload[sectionId] = {};
      for (const [elementId, style] of Object.entries(elements)) {
        payload[sectionId][elementId] = {
          color: style.color,
          fontSizePt: style.fontSizePt,
          fontFamily: style.fontFamily,
          fontWeight: style.fontWeight,
        };
      }
    }
    return Object.keys(payload).length > 0 ? payload : undefined;
  };

  const handleDragStart = (index: number, col: 'left' | 'right' | 'single') => {
    setDraggedIndex(index);
    setDraggedColumn(col);
  };

  const handleDragOver = (e: React.DragEvent, index: number, col: 'left' | 'right') => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverIndex(index);
    setDragOverColumn(col);
  };

  const handleColumnDragOver = (e: React.DragEvent, col: 'left' | 'right') => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverColumn(col);
    setDragOverIndex(-1);
  };

  const handleDragLeave = () => {
    setDragOverIndex(null);
    setDragOverColumn(null);
  };

  const handleDrop = (
    e: React.DragEvent,
    dropIndex: number,
    targetCol: 'left' | 'right',
    targetOrder: string[],
    setTarget: (o: string[]) => void,
    sourceOrder: string[],
    setSource: (o: string[]) => void
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverIndex(null);
    setDragOverColumn(null);
    if (draggedIndex === null || draggedColumn === null) return;

    const isCrossColumn = draggedColumn !== targetCol;

    if (isCrossColumn) {
      const newSource = sourceOrder.filter((_, i) => i !== draggedIndex);
      const [moved] = sourceOrder.filter((_, i) => i === draggedIndex);
      setSource(newSource);
      const newTarget = [...targetOrder];
      newTarget.splice(Math.min(dropIndex, newTarget.length), 0, moved);
      setTarget(newTarget);
    } else {
      if (draggedIndex === dropIndex) {
        setDraggedIndex(null);
        setDraggedColumn(null);
        return;
      }
      const newOrder = [...targetOrder];
      const [removed] = newOrder.splice(draggedIndex, 1);
      newOrder.splice(dropIndex, 0, removed);
      setTarget(newOrder);
    }
    setDraggedIndex(null);
    setDraggedColumn(null);
  };

  const handleColumnDrop = (e: React.DragEvent, targetCol: 'left' | 'right') => {
    e.preventDefault();
    if (draggedIndex === null || draggedColumn === null || draggedColumn === targetCol) return;
    const sourceOrder = draggedColumn === 'left' ? leftSectionOrder : rightSectionOrder;
    const targetOrder = targetCol === 'left' ? leftSectionOrder : rightSectionOrder;
    const moved = sourceOrder[draggedIndex];
    if (!moved) return;

    const nextSource = sourceOrder.filter((_, index) => index !== draggedIndex);
    const nextTarget = [...targetOrder, moved];

    if (draggedColumn === 'left') {
      setLeftSectionOrder(nextSource);
      setRightSectionOrder(nextTarget);
    } else {
      setRightSectionOrder(nextSource);
      setLeftSectionOrder(nextTarget);
    }
    setDraggedIndex(null);
    setDraggedColumn(null);
    setDragOverColumn(null);
  };

  const handleDragEnd = () => {
    setDraggedIndex(null);
    setDragOverIndex(null);
    setDragOverColumn(null);
    setDraggedColumn(null);
  };

  const renderDraggableList = (
    order: string[],
    setOrder: (o: string[]) => void,
    col: 'left' | 'right' | 'single'
  ) => {
    if (col === 'single') {
      return (
        <ul className="border border-gray-300 rounded-md divide-y divide-gray-200 min-h-[80px]">
          {order.map((sectionId, index) => {
            const section = SECTIONS.find((s) => s.id === sectionId);
            if (!section) return null;
            return (
              <li
                key={sectionId}
                draggable
                onDragStart={() => handleDragStart(index, 'single')}
                onDragOver={(e) => { e.preventDefault(); setDragOverIndex(index); }}
                onDragLeave={handleDragLeave}
                onDrop={(e) => {
                  e.preventDefault();
                  if (draggedIndex === null) return;
                  const newOrder = [...order];
                  const [removed] = newOrder.splice(draggedIndex, 1);
                  newOrder.splice(index, 0, removed);
                  setOrder(newOrder);
                  setDraggedIndex(null);
                }}
                onDragEnd={handleDragEnd}
                className={`flex items-center gap-2 px-3 py-2 bg-white hover:bg-gray-50 cursor-grab active:cursor-grabbing ${draggedIndex === index ? 'opacity-50' : ''}`}
              >
                <span className="text-gray-400 select-none" aria-hidden>⋮⋮</span>
                <span className="flex-1">{section.label}</span>
              </li>
            );
          })}
        </ul>
      );
    }
    const isOver = dragOverColumn === col;
    return (
      <ul
        className={`border rounded-md divide-y divide-gray-200 min-h-[80px] transition-colors ${
          isOver ? 'border-blue-400 bg-blue-50/50' : 'border-gray-300'
        }`}
        onDragOver={(e) => handleColumnDragOver(e, col)}
        onDragLeave={handleDragLeave}
        onDrop={(e) => handleColumnDrop(e, col)}
      >
        {order.map((sectionId, index) => {
          const section = SECTIONS.find((s) => s.id === sectionId);
          if (!section) return null;
          return (
            <li
              key={`${col}-${sectionId}-${index}`}
              draggable
              onDragStart={() => handleDragStart(index, col)}
              onDragOver={(e) => handleDragOver(e, index, col)}
              onDrop={(e) => {
                e.stopPropagation();
                handleDrop(
                  e,
                  index,
                  col,
                  order,
                  setOrder,
                  col === 'left' ? rightSectionOrder : leftSectionOrder,
                  col === 'left' ? setRightSectionOrder : setLeftSectionOrder
                );
              }}
              onDragEnd={handleDragEnd}
              className={`flex items-center gap-2 px-3 py-2 bg-white hover:bg-gray-50 cursor-grab active:cursor-grabbing ${
                draggedIndex === index && draggedColumn === col ? 'opacity-50' : ''
              } ${dragOverIndex === index && draggedColumn !== col ? 'ring-2 ring-blue-400' : ''}`}
            >
              <span className="text-gray-400 select-none" aria-hidden>⋮⋮</span>
              <span className="flex-1">{section.label}</span>
            </li>
          );
        })}
      </ul>
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!name.trim()) {
      setError('Template name is required');
      return;
    }
    setIsSubmitting(true);
    const payload = {
      name: name.trim(),
      description: description.trim() || undefined,
      columns,
      accentColor: '#1e40af',
      bodyColor: '#000000',
      bodyFontSizePt: 9,
      titleFontSizePt: 24,
      sectionOrder: columns === 1 ? sectionOrder : undefined,
      leftSectionOrder: columns === 2 ? leftSectionOrder : undefined,
      rightSectionOrder: columns === 2 ? rightSectionOrder : undefined,
      nameStyle,
      headerTitleStyle,
      contactStyle,
      sectionStyles: buildSectionStylesPayload(),
    };
    try {
      if (initialTemplate?.id) {
        await templatesApi.updateManual(initialTemplate.id, payload);
      } else {
        await templatesApi.createManual(payload);
      }
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create template');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-white rounded-xl max-w-2xl w-full p-6 my-8 max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold">{initialTemplate ? 'Edit Manual Template' : 'Add Manual Template'}</h2>
          <button
            type="button"
            onClick={onCancel}
            className="text-gray-500 hover:text-gray-700 p-1"
            aria-label="Close"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <p className="text-sm text-gray-600 mb-4">
          Create a template with custom colors, font sizes, and section order. Header (name, title, contact) is fixed at the top.
        </p>

        {error && (
          <div className="mb-4 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-md text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Template Name *</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., My Custom Template"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Layout</label>
            <select
              value={columns}
              onChange={(e) => {
                const val = Number(e.target.value) as 1 | 2;
                if (val === 2) {
                  setLeftSectionOrder(sectionOrder.filter((s) => DEFAULT_LEFT.includes(s)));
                  setRightSectionOrder(sectionOrder.filter((s) => DEFAULT_RIGHT.includes(s)));
                } else {
                  setSectionOrder([...leftSectionOrder, ...rightSectionOrder]);
                }
                setColumns(val);
              }}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value={1}>One column</option>
              <option value={2}>Two columns (Left: Summary+Experience | Right: Strengths+Skills+Education)</option>
            </select>
          </div>

          <div className="border border-gray-200 rounded-lg p-4 bg-gray-50">
            <h4 className="font-medium text-gray-900 mb-3">Style per element</h4>
            <p className="text-xs text-gray-500 mb-3">Click an item to edit its color and font style</p>
            <div className="space-y-2">
              {(['name', 'title', 'contact'] as const).map((item) => (
                <div key={item}>
                  <button
                    type="button"
                    onClick={() => setSelectedStyleItem(selectedStyleItem === item ? null : item)}
                    className={`w-full flex items-center justify-between px-3 py-2 rounded-md text-left text-sm font-medium transition-colors ${
                      selectedStyleItem === item ? 'bg-blue-100 text-blue-800 ring-1 ring-blue-300' : 'bg-white hover:bg-gray-100 text-gray-700'
                    }`}
                  >
                    <span>
                      {item === 'name' ? 'Name' : item === 'title' ? 'Title' : 'Contact info'}
                    </span>
                    <span className="text-gray-400">{selectedStyleItem === item ? '▲' : '▼'}</span>
                  </button>
                  {selectedStyleItem === item && (
                    <div className="mt-2 p-3 bg-white rounded-md border border-gray-200 space-y-3">
                      {item === 'name' && (
                        <>
                          <div className="flex gap-2 items-center">
                            <span className="text-xs w-16">Color</span>
                            <input type="color" value={nameStyle.color} onChange={(e) => setNameStyle({ ...nameStyle, color: e.target.value })} className="w-8 h-8 rounded border cursor-pointer" />
                            <input type="text" value={nameStyle.color} onChange={(e) => setNameStyle({ ...nameStyle, color: e.target.value })} className="flex-1 px-2 py-1 text-sm font-mono" />
                          </div>
                          <div className="flex gap-2 items-center">
                            <span className="text-xs w-16">Size</span>
                            <select value={nameStyle.fontSizePt} onChange={(e) => setNameStyle({ ...nameStyle, fontSizePt: Number(e.target.value) })} className="px-2 py-1 border rounded">
                              {[18, 20, 24, 28].map((n) => <option key={n} value={n}>{n}pt</option>)}
                            </select>
                          </div>
                          <div className="flex gap-2 items-center">
                            <span className="text-xs w-16">Font</span>
                            <select value={nameStyle.fontFamily} onChange={(e) => setNameStyle({ ...nameStyle, fontFamily: e.target.value })} className="flex-1 px-2 py-1 border rounded">
                              {FONT_FAMILIES.map((f) => <option key={f} value={f}>{f.split(',')[0].trim()}</option>)}
                            </select>
                          </div>
                          <div className="flex gap-2 items-center">
                            <span className="text-xs w-16">Weight</span>
                            <select value={nameStyle.fontWeight} onChange={(e) => setNameStyle({ ...nameStyle, fontWeight: e.target.value as 'normal' | 'bold' })} className="px-2 py-1 border rounded">
                              <option value="normal">Normal</option>
                              <option value="bold">Bold</option>
                            </select>
                          </div>
                        </>
                      )}
                      {item === 'title' && (
                        <>
                          <div className="flex gap-2 items-center">
                            <span className="text-xs w-16">Color</span>
                            <input type="color" value={headerTitleStyle.color} onChange={(e) => setHeaderTitleStyle({ ...headerTitleStyle, color: e.target.value })} className="w-8 h-8 rounded border cursor-pointer" />
                            <input type="text" value={headerTitleStyle.color} onChange={(e) => setHeaderTitleStyle({ ...headerTitleStyle, color: e.target.value })} className="flex-1 px-2 py-1 text-sm font-mono" />
                          </div>
                          <div className="flex gap-2 items-center">
                            <span className="text-xs w-16">Size</span>
                            <select value={headerTitleStyle.fontSizePt} onChange={(e) => setHeaderTitleStyle({ ...headerTitleStyle, fontSizePt: Number(e.target.value) })} className="px-2 py-1 border rounded">
                              {[9, 10, 11, 12].map((n) => <option key={n} value={n}>{n}pt</option>)}
                            </select>
                          </div>
                          <div className="flex gap-2 items-center">
                            <span className="text-xs w-16">Font</span>
                            <select value={headerTitleStyle.fontFamily} onChange={(e) => setHeaderTitleStyle({ ...headerTitleStyle, fontFamily: e.target.value })} className="flex-1 px-2 py-1 border rounded">
                              {FONT_FAMILIES.map((f) => <option key={f} value={f}>{f.split(',')[0].trim()}</option>)}
                            </select>
                          </div>
                          <div className="flex gap-2 items-center">
                            <span className="text-xs w-16">Weight</span>
                            <select value={headerTitleStyle.fontWeight} onChange={(e) => setHeaderTitleStyle({ ...headerTitleStyle, fontWeight: e.target.value as 'normal' | 'bold' })} className="px-2 py-1 border rounded">
                              <option value="normal">Normal</option>
                              <option value="bold">Bold</option>
                            </select>
                          </div>
                        </>
                      )}
                      {item === 'contact' && (
                        <>
                          <div className="flex gap-2 items-center">
                            <span className="text-xs w-16">Color</span>
                            <input type="color" value={contactStyle.color} onChange={(e) => setContactStyle({ ...contactStyle, color: e.target.value })} className="w-8 h-8 rounded border cursor-pointer" />
                            <input type="text" value={contactStyle.color} onChange={(e) => setContactStyle({ ...contactStyle, color: e.target.value })} className="flex-1 px-2 py-1 text-sm font-mono" />
                          </div>
                          <div className="flex gap-2 items-center">
                            <span className="text-xs w-16">Size</span>
                            <select value={contactStyle.fontSizePt} onChange={(e) => setContactStyle({ ...contactStyle, fontSizePt: Number(e.target.value) })} className="px-2 py-1 border rounded">
                              {[7, 8, 9, 10].map((n) => <option key={n} value={n}>{n}pt</option>)}
                            </select>
                          </div>
                          <div className="flex gap-2 items-center">
                            <span className="text-xs w-16">Font</span>
                            <select value={contactStyle.fontFamily} onChange={(e) => setContactStyle({ ...contactStyle, fontFamily: e.target.value })} className="flex-1 px-2 py-1 border rounded">
                              {FONT_FAMILIES.map((f) => <option key={f} value={f}>{f.split(',')[0].trim()}</option>)}
                            </select>
                          </div>
                          <div className="flex gap-2 items-center">
                            <span className="text-xs w-16">Weight</span>
                            <select value={contactStyle.fontWeight} onChange={(e) => setContactStyle({ ...contactStyle, fontWeight: e.target.value as 'normal' | 'bold' })} className="px-2 py-1 border rounded">
                              <option value="normal">Normal</option>
                              <option value="bold">Bold</option>
                            </select>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              ))}
              {Object.keys(SECTION_LABELS).map((sectionId) => {
                const elements = SECTION_ELEMENTS[sectionId] ?? [];
                const isExpanded = expandedSection === sectionId;
                return (
                  <div key={sectionId}>
                    <button
                      type="button"
                      onClick={() => setExpandedSection(isExpanded ? null : sectionId)}
                      className={`w-full flex items-center justify-between px-3 py-2 rounded-md text-left text-sm font-medium transition-colors ${
                        isExpanded ? 'bg-gray-100 text-gray-800' : 'bg-white hover:bg-gray-100 text-gray-700'
                      }`}
                    >
                      <span>{SECTION_LABELS[sectionId]}</span>
                      <span className="text-gray-400">{isExpanded ? '▲' : '▼'}</span>
                    </button>
                    {isExpanded && (
                      <div className="mt-1 ml-3 space-y-1 border-l-2 border-gray-200 pl-3">
                        {elements.map((elementId) => {
                          const key = `${sectionId}.${elementId}`;
                          const style = getSectionElementStyle(sectionId, elementId);
                          const isSelected = selectedStyleItem === key;
                          return (
                            <div key={key}>
                              <button
                                type="button"
                                onClick={() => setSelectedStyleItem(isSelected ? null : key)}
                                className={`w-full flex items-center justify-between px-3 py-1.5 rounded-md text-left text-sm transition-colors ${
                                  isSelected ? 'bg-blue-100 text-blue-800 ring-1 ring-blue-300' : 'bg-white hover:bg-gray-50 text-gray-600'
                                }`}
                              >
                                <span>{ELEMENT_LABELS[elementId] ?? elementId}</span>
                                <span className="text-gray-400">{isSelected ? '▲' : '▼'}</span>
                              </button>
                              {isSelected && (
                                <div className="mt-2 p-3 bg-white rounded-md border border-gray-200 space-y-3">
                                  <div className="flex gap-2 items-center">
                                    <span className="text-xs w-16">Color</span>
                                    <input type="color" value={style.color} onChange={(e) => setSectionElementStyle(sectionId, elementId, { color: e.target.value })} className="w-8 h-8 rounded border cursor-pointer" />
                                    <input type="text" value={style.color} onChange={(e) => setSectionElementStyle(sectionId, elementId, { color: e.target.value })} className="flex-1 px-2 py-1 text-sm font-mono" />
                                  </div>
                                  <div className="flex gap-2 items-center">
                                    <span className="text-xs w-16">Size</span>
                                    <select value={style.fontSizePt} onChange={(e) => setSectionElementStyle(sectionId, elementId, { fontSizePt: Number(e.target.value) })} className="px-2 py-1 border rounded">
                                      {[8, 9, 10, 11].map((n) => <option key={n} value={n}>{n}pt</option>)}
                                    </select>
                                  </div>
                                  <div className="flex gap-2 items-center">
                                    <span className="text-xs w-16">Font</span>
                                    <select value={style.fontFamily} onChange={(e) => setSectionElementStyle(sectionId, elementId, { fontFamily: e.target.value })} className="flex-1 px-2 py-1 border rounded">
                                      {FONT_FAMILIES.map((f) => <option key={f} value={f}>{f.split(',')[0].trim()}</option>)}
                                    </select>
                                  </div>
                                  <div className="flex gap-2 items-center">
                                    <span className="text-xs w-16">Weight</span>
                                    <select value={style.fontWeight} onChange={(e) => setSectionElementStyle(sectionId, elementId, { fontWeight: e.target.value as 'normal' | 'bold' })} className="px-2 py-1 border rounded">
                                      <option value="normal">Normal</option>
                                      <option value="bold">Bold</option>
                                    </select>
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Section Order (drag to reorder)
            </label>
            {columns === 1 ? (
              renderDraggableList(sectionOrder, setSectionOrder, 'single')
            ) : (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Left column (drag between columns)</label>
                  {renderDraggableList(leftSectionOrder, setLeftSectionOrder, 'left')}
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Right column</label>
                  {renderDraggableList(rightSectionOrder, setRightSectionOrder, 'right')}
                </div>
              </div>
            )}
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? 'Creating...' : 'Create Template'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
