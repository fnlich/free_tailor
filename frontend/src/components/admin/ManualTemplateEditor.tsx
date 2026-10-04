'use client';

import { useState, useEffect } from 'react';
import { templatesApi, Template, ManualTemplateConfigStored } from '@/lib/api';
import chrome from '@/components/admin/profileTemplateChrome.module.css';
import { IconClose } from '@/components/icons';
import { Card, Field, Notice } from '@/components/ui/kit';
import { messageWithDetail } from '@/lib/userMessage';

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

/** One control in an open style panel: a short caption, then the control. */
const STYLE_ROW = 'flex items-center gap-3';
const STYLE_CAPTION = 'w-16 shrink-0 text-sm text-muted';
/**
 * The box a short select sits in. `.tl-input` is `width: 100%` and unlayered,
 * so a width utility on the select itself would lose; its parent sets it.
 */
const STYLE_NARROW = 'w-32';

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
        <ul className={chrome.dragList}>
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
                className={`flex cursor-grab items-center gap-3 bg-surface px-3 py-2.5 text-sm text-ink hover:bg-surface-muted active:cursor-grabbing ${draggedIndex === index ? 'opacity-50' : ''}`}
              >
                <span className="select-none text-subtle" aria-hidden>⋮⋮</span>
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
        className={chrome.dragList}
        data-over={isOver}
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
              className={`flex cursor-grab items-center gap-3 bg-surface px-3 py-2.5 text-sm text-ink hover:bg-surface-muted active:cursor-grabbing ${
                draggedIndex === index && draggedColumn === col ? 'opacity-50' : ''
              } ${dragOverIndex === index && draggedColumn !== col ? 'ring-2 ring-inset ring-accent' : ''}`}
            >
              <span className="select-none text-subtle" aria-hidden>⋮⋮</span>
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
      setError(messageWithDetail(err, 'Failed to create template'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="tl-backdrop">
      <div
        className="tl-dialog max-w-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="manual-template-title"
      >
        <div className={chrome.dialogHead}>
          <h2 id="manual-template-title" className="text-xl font-bold tracking-tight text-ink">
            {initialTemplate ? 'Edit Manual Template' : 'Add Manual Template'}
          </h2>
          <button
            type="button"
            onClick={onCancel}
            className="tl-icon-button"
            aria-label="Close"
          >
            <IconClose className="h-5 w-5" />
          </button>
        </div>

        <div className="p-6">
          <p className="text-sm text-muted">
            Create a template with custom colors, font sizes, and section order. Header (name, title, contact) is fixed at the top.
          </p>

          {error && (
            <Notice tone="error" role="alert" className="mt-4">
              {error}
            </Notice>
          )}

          <form onSubmit={handleSubmit} className="mt-6 space-y-6">
            <Field label="Template Name *" htmlFor="manual-template-name">
              <input
                id="manual-template-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., My Custom Template"
                className="tl-input"
              />
            </Field>

            <Field label="Description" htmlFor="manual-template-description">
              <input
                id="manual-template-description"
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional description"
                className="tl-input"
              />
            </Field>

            <Field label="Layout" htmlFor="manual-template-layout">
              <select
                id="manual-template-layout"
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
                className="tl-input"
              >
                <option value={1}>One column</option>
                <option value={2}>Two columns (Left: Summary+Experience | Right: Strengths+Skills+Education)</option>
              </select>
            </Field>

            <Card title="Style per element" description="Click an item to edit its color and font style">
              <div className="space-y-2">
                {(['name', 'title', 'contact'] as const).map((item) => (
                  <div key={item}>
                    <button
                      type="button"
                      onClick={() => setSelectedStyleItem(selectedStyleItem === item ? null : item)}
                      className={chrome.styleRow}
                      data-open={selectedStyleItem === item}
                    >
                      <span>
                        {item === 'name' ? 'Name' : item === 'title' ? 'Title' : 'Contact info'}
                      </span>
                      <span className="text-xs text-subtle">{selectedStyleItem === item ? '▲' : '▼'}</span>
                    </button>
                    {selectedStyleItem === item && (
                      <div className={`${chrome.stylePanel} space-y-3`}>
                        {item === 'name' && (
                          <>
                            <div className={STYLE_ROW}>
                              <span className={STYLE_CAPTION}>Color</span>
                              <input type="color" value={nameStyle.color} onChange={(e) => setNameStyle({ ...nameStyle, color: e.target.value })} className={chrome.swatch} />
                              <div className="min-w-0 flex-1">
                                <input type="text" value={nameStyle.color} onChange={(e) => setNameStyle({ ...nameStyle, color: e.target.value })} className="tl-input font-mono" />
                              </div>
                            </div>
                            <div className={STYLE_ROW}>
                              <span className={STYLE_CAPTION}>Size</span>
                              <div className={STYLE_NARROW}>
                                <select value={nameStyle.fontSizePt} onChange={(e) => setNameStyle({ ...nameStyle, fontSizePt: Number(e.target.value) })} className="tl-input">
                                  {[18, 20, 24, 28].map((n) => <option key={n} value={n}>{n}pt</option>)}
                                </select>
                              </div>
                            </div>
                            <div className={STYLE_ROW}>
                              <span className={STYLE_CAPTION}>Font</span>
                              <div className="min-w-0 flex-1">
                                <select value={nameStyle.fontFamily} onChange={(e) => setNameStyle({ ...nameStyle, fontFamily: e.target.value })} className="tl-input">
                                  {FONT_FAMILIES.map((f) => <option key={f} value={f}>{f.split(',')[0].trim()}</option>)}
                                </select>
                              </div>
                            </div>
                            <div className={STYLE_ROW}>
                              <span className={STYLE_CAPTION}>Weight</span>
                              <div className={STYLE_NARROW}>
                                <select value={nameStyle.fontWeight} onChange={(e) => setNameStyle({ ...nameStyle, fontWeight: e.target.value as 'normal' | 'bold' })} className="tl-input">
                                  <option value="normal">Normal</option>
                                  <option value="bold">Bold</option>
                                </select>
                              </div>
                            </div>
                          </>
                        )}
                        {item === 'title' && (
                          <>
                            <div className={STYLE_ROW}>
                              <span className={STYLE_CAPTION}>Color</span>
                              <input type="color" value={headerTitleStyle.color} onChange={(e) => setHeaderTitleStyle({ ...headerTitleStyle, color: e.target.value })} className={chrome.swatch} />
                              <div className="min-w-0 flex-1">
                                <input type="text" value={headerTitleStyle.color} onChange={(e) => setHeaderTitleStyle({ ...headerTitleStyle, color: e.target.value })} className="tl-input font-mono" />
                              </div>
                            </div>
                            <div className={STYLE_ROW}>
                              <span className={STYLE_CAPTION}>Size</span>
                              <div className={STYLE_NARROW}>
                                <select value={headerTitleStyle.fontSizePt} onChange={(e) => setHeaderTitleStyle({ ...headerTitleStyle, fontSizePt: Number(e.target.value) })} className="tl-input">
                                  {[9, 10, 11, 12].map((n) => <option key={n} value={n}>{n}pt</option>)}
                                </select>
                              </div>
                            </div>
                            <div className={STYLE_ROW}>
                              <span className={STYLE_CAPTION}>Font</span>
                              <div className="min-w-0 flex-1">
                                <select value={headerTitleStyle.fontFamily} onChange={(e) => setHeaderTitleStyle({ ...headerTitleStyle, fontFamily: e.target.value })} className="tl-input">
                                  {FONT_FAMILIES.map((f) => <option key={f} value={f}>{f.split(',')[0].trim()}</option>)}
                                </select>
                              </div>
                            </div>
                            <div className={STYLE_ROW}>
                              <span className={STYLE_CAPTION}>Weight</span>
                              <div className={STYLE_NARROW}>
                                <select value={headerTitleStyle.fontWeight} onChange={(e) => setHeaderTitleStyle({ ...headerTitleStyle, fontWeight: e.target.value as 'normal' | 'bold' })} className="tl-input">
                                  <option value="normal">Normal</option>
                                  <option value="bold">Bold</option>
                                </select>
                              </div>
                            </div>
                          </>
                        )}
                        {item === 'contact' && (
                          <>
                            <div className={STYLE_ROW}>
                              <span className={STYLE_CAPTION}>Color</span>
                              <input type="color" value={contactStyle.color} onChange={(e) => setContactStyle({ ...contactStyle, color: e.target.value })} className={chrome.swatch} />
                              <div className="min-w-0 flex-1">
                                <input type="text" value={contactStyle.color} onChange={(e) => setContactStyle({ ...contactStyle, color: e.target.value })} className="tl-input font-mono" />
                              </div>
                            </div>
                            <div className={STYLE_ROW}>
                              <span className={STYLE_CAPTION}>Size</span>
                              <div className={STYLE_NARROW}>
                                <select value={contactStyle.fontSizePt} onChange={(e) => setContactStyle({ ...contactStyle, fontSizePt: Number(e.target.value) })} className="tl-input">
                                  {[7, 8, 9, 10].map((n) => <option key={n} value={n}>{n}pt</option>)}
                                </select>
                              </div>
                            </div>
                            <div className={STYLE_ROW}>
                              <span className={STYLE_CAPTION}>Font</span>
                              <div className="min-w-0 flex-1">
                                <select value={contactStyle.fontFamily} onChange={(e) => setContactStyle({ ...contactStyle, fontFamily: e.target.value })} className="tl-input">
                                  {FONT_FAMILIES.map((f) => <option key={f} value={f}>{f.split(',')[0].trim()}</option>)}
                                </select>
                              </div>
                            </div>
                            <div className={STYLE_ROW}>
                              <span className={STYLE_CAPTION}>Weight</span>
                              <div className={STYLE_NARROW}>
                                <select value={contactStyle.fontWeight} onChange={(e) => setContactStyle({ ...contactStyle, fontWeight: e.target.value as 'normal' | 'bold' })} className="tl-input">
                                  <option value="normal">Normal</option>
                                  <option value="bold">Bold</option>
                                </select>
                              </div>
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
                        className={chrome.styleRow}
                        data-open={isExpanded ? 'section' : 'false'}
                      >
                        <span>{SECTION_LABELS[sectionId]}</span>
                        <span className="text-xs text-subtle">{isExpanded ? '▲' : '▼'}</span>
                      </button>
                      {isExpanded && (
                        <div className={`${chrome.styleBranch} space-y-1`}>
                          {elements.map((elementId) => {
                            const key = `${sectionId}.${elementId}`;
                            const style = getSectionElementStyle(sectionId, elementId);
                            const isSelected = selectedStyleItem === key;
                            return (
                              <div key={key}>
                                <button
                                  type="button"
                                  onClick={() => setSelectedStyleItem(isSelected ? null : key)}
                                  className={`${chrome.styleRow} ${chrome.styleRowChild}`}
                                  data-open={isSelected}
                                >
                                  <span>{ELEMENT_LABELS[elementId] ?? elementId}</span>
                                  <span className="text-xs text-subtle">{isSelected ? '▲' : '▼'}</span>
                                </button>
                                {isSelected && (
                                  <div className={`${chrome.stylePanel} space-y-3`}>
                                    <div className={STYLE_ROW}>
                                      <span className={STYLE_CAPTION}>Color</span>
                                      <input type="color" value={style.color} onChange={(e) => setSectionElementStyle(sectionId, elementId, { color: e.target.value })} className={chrome.swatch} />
                                      <div className="min-w-0 flex-1">
                                        <input type="text" value={style.color} onChange={(e) => setSectionElementStyle(sectionId, elementId, { color: e.target.value })} className="tl-input font-mono" />
                                      </div>
                                    </div>
                                    <div className={STYLE_ROW}>
                                      <span className={STYLE_CAPTION}>Size</span>
                                      <div className={STYLE_NARROW}>
                                        <select value={style.fontSizePt} onChange={(e) => setSectionElementStyle(sectionId, elementId, { fontSizePt: Number(e.target.value) })} className="tl-input">
                                          {[8, 9, 10, 11].map((n) => <option key={n} value={n}>{n}pt</option>)}
                                        </select>
                                      </div>
                                    </div>
                                    <div className={STYLE_ROW}>
                                      <span className={STYLE_CAPTION}>Font</span>
                                      <div className="min-w-0 flex-1">
                                        <select value={style.fontFamily} onChange={(e) => setSectionElementStyle(sectionId, elementId, { fontFamily: e.target.value })} className="tl-input">
                                          {FONT_FAMILIES.map((f) => <option key={f} value={f}>{f.split(',')[0].trim()}</option>)}
                                        </select>
                                      </div>
                                    </div>
                                    <div className={STYLE_ROW}>
                                      <span className={STYLE_CAPTION}>Weight</span>
                                      <div className={STYLE_NARROW}>
                                        <select value={style.fontWeight} onChange={(e) => setSectionElementStyle(sectionId, elementId, { fontWeight: e.target.value as 'normal' | 'bold' })} className="tl-input">
                                          <option value="normal">Normal</option>
                                          <option value="bold">Bold</option>
                                        </select>
                                      </div>
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
            </Card>

            <div>
              <p className="tl-label">
                Section Order (drag to reorder)
              </p>
              <div className="mt-2">
                {columns === 1 ? (
                  renderDraggableList(sectionOrder, setSectionOrder, 'single')
                ) : (
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div>
                      <p className="mb-1.5 text-xs font-medium text-muted">Left column (drag between columns)</p>
                      {renderDraggableList(leftSectionOrder, setLeftSectionOrder, 'left')}
                    </div>
                    <div>
                      <p className="mb-1.5 text-xs font-medium text-muted">Right column</p>
                      {renderDraggableList(rightSectionOrder, setRightSectionOrder, 'right')}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className={chrome.dialogFoot}>
              <button
                type="button"
                onClick={onCancel}
                className="tl-button-quiet"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="tl-button"
              >
                {isSubmitting ? 'Creating...' : 'Create Template'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
