'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import {
  IconCheck,
  IconChevronRight,
  IconClose,
  IconDocument,
  IconUpload,
} from '@/components/icons';
import { useDialogLayer } from '@/components/ui/Dialog';
import { ErrorNotice } from '@/components/ui/kit';
import { getApiOrigin, type TechnicalSkillsLayout, type Template } from '@/lib/api';
import { ALL_SKILLS_LAYOUTS, LAYOUT_LABELS } from '@/lib/resumeDraft';
import { profilePageHref } from '@/lib/profileDashboard';
import {
  TEMPLATE_FILTER_LABELS,
  startWithoutTemplateHref,
  templateFeatures,
  templateFilters,
  templatePreviewPath,
  templatesForFilter,
  type TemplateFilter,
} from '@/lib/resumeGallery';
import { ActionMenu } from './ActionMenu';
import { PageThumb, ThumbLoading } from './PageThumb';
import { editorFont } from './editorFont';
import editorCss from './resumeEditor.module.css';
import css from './resumePages.module.css';

/** How many blank pages stand in the grid while the list is on its way. */
const LOADING_CARDS = 6;

/**
 * "Start building your resume": the first step of a new resume, after
 * FlowCV's template gallery. Filter pills (All Templates, then each category
 * a template is filed under), "Import existing resume" beside them, and a
 * grid of the templates as pages, each drawn Grouped; a page opens its
 * details, whose "Use this template" starts the editor on it in the Technical
 * Skills layout the details were showing (`onUse`). Any resume may use any
 * template, so Use this template is never off.
 *
 * The page names the profile the resume is for (`profile`, when `?profile=`
 * names one the viewer can read): the heading says "for {name}" and the back
 * link returns to that profile's page.
 */
export function TemplateChooser({
  templates,
  loaded,
  loadError,
  profile,
  profileId: addressProfileId,
  onUse,
  onImportPdf,
  onImportJson,
  importBusy,
  uploadMaxMb,
  notices,
}: {
  /** The enabled templates, in the server's order. */
  templates: Template[];
  loaded: boolean;
  loadError: unknown;
  /** The profile the new resume is for, once read; null while it loads, or when none is named. */
  profile?: { id: string; name: string } | null;
  /**
   * The profile the address names (`?profile=`), which the page carries on to the editor whether or
   * not its read has come back yet - so "Start without a template" keeps it exactly as `onUse` does.
   */
  profileId?: string | null;
  /** Use this template, in the layout the details were showing. */
  onUse: (template: Template, layout: TechnicalSkillsLayout) => void;
  onImportPdf: () => void;
  onImportJson: () => void;
  importBusy: 'pdf' | 'json' | null;
  uploadMaxMb: number;
  /** The import's progress and failures, under the heading. */
  notices?: ReactNode;
}) {
  const [filter, setFilter] = useState<TemplateFilter>('all');
  const [openId, setOpenId] = useState<string | null>(null);

  const filters = templateFilters(templates);
  const shownFilter = filters.includes(filter) ? filter : 'all';
  const shown = templatesForFilter(templates, shownFilter);
  // Derived, so a template that leaves the list closes its details.
  const open = openId ? (shown.find((template) => template.id === openId) ?? null) : null;
  const profileId = addressProfileId !== undefined ? addressProfileId : (profile?.id ?? null);

  const closeDetails = useCallback(() => {
    const id = openId;
    setOpenId(null);
    // Back to the page that was open, which may not be the one clicked: the
    // details step through the list.
    if (id) {
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>(`[data-template-card="${CSS.escape(id)}"]`)?.focus()
      );
    }
  }, [openId]);

  return (
    <div className={css.page}>
      <Link href={profile ? profilePageHref(profile.id) : '/admin/profiles'} className={css.back}>
        <IconChevronRight className="h-4 w-4 rotate-180" strokeWidth={2.4} />
        {profile ? profile.name : 'My Profiles'}
      </Link>
      <h1 className={css.title}>{profile ? `Start building a resume for ${profile.name}` : 'Start building a resume'}</h1>
      <p className={css.subtitle}>Choose a design you like. You can customize or switch it later.</p>

      <div className={css.toolbar}>
        <div className={css.filters} role="group" aria-label="Show templates">
          {filters.map((value) => (
            <button
              key={value}
              type="button"
              className={css.filter}
              aria-pressed={shownFilter === value}
              onClick={() => setFilter(value)}
            >
              {TEMPLATE_FILTER_LABELS[value]}
            </button>
          ))}
        </div>
        <ActionMenu
          triggerClassName={css.importButton}
          disabled={importBusy !== null}
          triggerContent={
            <>
              {importBusy ? <span className="tl-spinner" aria-hidden /> : <IconUpload className="h-[18px] w-[18px]" strokeWidth={2.2} />}
              {importBusy === 'pdf' ? 'Reading your resume...' : importBusy === 'json' ? 'Importing...' : 'Import existing resume'}
            </>
          }
          items={[
            {
              key: 'pdf',
              label: 'Resume PDF',
              hint: `An AI reads it into a new resume. Up to ${uploadMaxMb} MB.`,
              icon: IconUpload,
              onSelect: onImportPdf,
            },
            {
              key: 'json',
              label: 'Resume JSON file',
              hint: 'A resume downloaded from this app, or several.',
              icon: IconDocument,
              onSelect: onImportJson,
            },
          ]}
        />
      </div>

      {notices && <div className={css.notices}>{notices}</div>}

      {loaded && templates.length === 0 ? (
        <div className={css.emptyGrid}>
          {loadError ? (
            <ErrorNotice error={loadError} fallback="Could not load the templates" />
          ) : (
            <p>No template is offered on this installation yet.</p>
          )}
          <p className="mt-3">
            <Link href={startWithoutTemplateHref(profileId)} className="tl-link font-semibold">
              Start without a template
            </Link>{' '}
            - resumes are drawn with the default one until a template is chosen.
          </p>
        </div>
      ) : (
        <ul className={css.templateGrid} aria-busy={!loaded}>
          {!loaded
            ? Array.from({ length: LOADING_CARDS }, (_, index) => (
                <li key={index} aria-hidden="true">
                  <div className={css.templateCard}>
                    <PageThumb title="" placeholder={<ThumbLoading />} />
                  </div>
                </li>
              ))
            : shown.map((template) => (
                <li key={template.id}>
                  {/* The page under a button the size of it: a frame may not sit inside a button. */}
                  <div className={css.templateCard}>
                    <PageThumb
                      src={`${getApiOrigin()}${templatePreviewPath(template.id)}`}
                      title={`${template.name} preview`}
                      placeholder={<ThumbLoading />}
                    />
                    <button
                      type="button"
                      data-template-card={template.id}
                      className={css.cover}
                      onClick={() => setOpenId(template.id)}
                      aria-label={`${template.name}: see the template`}
                    >
                      <span className={css.templateHover} aria-hidden="true">
                        <span>Preview</span>
                      </span>
                    </button>
                  </div>
                  <p className={css.templateName}>{template.name}</p>
                </li>
              ))}
        </ul>
      )}

      {open && (
        <TemplateDetails
          template={open}
          list={shown}
          onStep={(id) => setOpenId(id)}
          onClose={closeDetails}
          onUse={onUse}
        />
      )}
    </div>
  );
}

/**
 * A template's details, FlowCV's modal: the page large on the left, and on
 * the right its name, its description, a Grouped / Plain switch that redraws
 * the page in either Technical Skills layout (every template prints both),
 * what it does (lib/resumeGallery.ts `templateFeatures`) and "Use this
 * template", which starts the resume in the layout shown. Previous / Next and
 * the arrow keys step through the templates the grid is showing, keeping the
 * layout; the details open on Grouped, every resume's default. The arrows do
 * nothing on the switch itself: a step moves focus to the next template's Use
 * this template, so Right then Space - a segmented control's way to Plain -
 * started a resume on a template nobody had looked at.
 *
 * Its own chrome rather than the kit Dialog, whose title row spans the panel;
 * it joins the same stack (`useDialogLayer`), so Escape and the scroll lock
 * behave as every other dialog's. Portalled to <body>, so it brings the
 * editor's tokens and typeface with it.
 */
function TemplateDetails({
  template,
  list,
  onStep,
  onClose,
  onUse,
}: {
  template: Template;
  list: readonly Template[];
  onStep: (id: string) => void;
  onClose: () => void;
  onUse: (template: Template, layout: TechnicalSkillsLayout) => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const useButton = useRef<HTMLButtonElement>(null);
  const layoutSwitch = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<TechnicalSkillsLayout>('categorized');
  useDialogLayer(true, onClose);

  useEffect(() => {
    // The action, which is always open: any resume may use any template. Never
    // scrolled to: on a phone the button is below the fold, and the details
    // should open at their top.
    if (useButton.current) useButton.current.focus({ preventScroll: true });
    else panel.current?.focus({ preventScroll: true });
  }, [template.id]);

  const index = list.findIndex((item) => item.id === template.id);
  const previous = index > 0 ? list[index - 1] : null;
  const next = index >= 0 && index < list.length - 1 ? list[index + 1] : null;
  const headingId = `template-details-${template.id}`;

  const onKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (layoutSwitch.current?.contains(event.target as Node)) return;
    if (event.key === 'ArrowLeft' && previous) {
      event.preventDefault();
      onStep(previous.id);
    } else if (event.key === 'ArrowRight' && next) {
      event.preventDefault();
      onStep(next.id);
    }
  };

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      className={`tl-backdrop ${editorCss.tokens} ${editorFont.variable}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        className={css.detail}
        onKeyDown={onKey}
      >
        <div className={css.detailPreview}>
          <div className={css.detailPage}>
            <PageThumb
              src={`${getApiOrigin()}${templatePreviewPath(template.id, layout)}`}
              title={`${template.name} preview, Technical Skills ${LAYOUT_LABELS[layout]}`}
              lazy={false}
              placeholder={<ThumbLoading />}
            />
          </div>
        </div>

        <div className={css.detailBody}>
          <h2 id={headingId} className={css.detailName}>
            {template.name}
          </h2>
          {template.description && <p className={css.detailDescription}>{template.description}</p>}
          <div className={css.detailLayout}>
            {/* The group carries the same words as its name; read once. */}
            <p className={css.detailLabel} aria-hidden="true">
              Technical skills
            </p>
            <div ref={layoutSwitch} className={css.filters} role="group" aria-label="Technical skills">
              {ALL_SKILLS_LAYOUTS.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={css.filter}
                  aria-pressed={layout === value}
                  onClick={() => setLayout(value)}
                >
                  {LAYOUT_LABELS[value]}
                </button>
              ))}
            </div>
          </div>
          <ul className={css.features}>
            {templateFeatures(template).map((feature) => (
              <li key={feature}>
                <span className={css.featureIcon} aria-hidden="true">
                  <IconCheck className="h-3.5 w-3.5" strokeWidth={3} />
                </span>
                {feature}
              </li>
            ))}
          </ul>
          <button
            ref={useButton}
            type="button"
            className={css.useButton}
            onClick={() => onUse(template, layout)}
          >
            Use this template
          </button>

          {(previous || next) && (
            <div className={css.detailSteps}>
              {previous && (
                <button type="button" className={css.detailStep} onClick={() => onStep(previous.id)}>
                  <IconChevronRight className="h-4 w-4 rotate-180" strokeWidth={2.4} />
                  {previous.name}
                </button>
              )}
              {next && (
                <button type="button" className={`${css.detailStep} ml-auto`} onClick={() => onStep(next.id)}>
                  {next.name}
                  <IconChevronRight className="h-4 w-4" strokeWidth={2.4} />
                </button>
              )}
            </div>
          )}
        </div>

        <button type="button" className={css.detailClose} aria-label="Close" onClick={onClose}>
          <IconClose className="h-[18px] w-[18px]" />
        </button>
      </div>
    </div>,
    document.body
  );
}
