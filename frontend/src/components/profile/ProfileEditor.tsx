'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  DEFAULT_USER_APP_SETTINGS,
  HARD_SKILL_CATEGORIES,
  isProfileLimit,
  profilesApi,
  promptsApi,
  resumeApi,
  templatesApi,
  type AiPreferences,
  type Profile,
  type ProfilePreviewResult,
  type PromptSummary,
  type Template,
  type TechnicalSkillsLayout,
  type UserAppSettings,
} from '@/lib/api';
import { IconDocument, IconGrid, IconPalette, IconPlus } from '@/components/icons';
import { ErrorNotice, Notice } from '@/components/ui/kit';
import { useAuth } from '@/contexts/AuthContext';
import { savableModelChoice } from '@/lib/profileModel';
import {
  addCustomSection,
  addSectionKind,
  appendEntry,
  draftForNewProfile,
  draftFromProfile,
  draftToPayload,
  draftToPreviewProfile,
  effectiveTemplateId,
  emptyEntry,
  entriesOf,
  entryCount,
  findEntry,
  hasSkill,
  isBlankEntry,
  keptCount,
  keptNote,
  normalizeTechnicalSkillsLayout,
  removeEntry,
  removeSection,
  sampledNotice,
  templateOptions,
  templatePrintsSection,
  templatesUsedByOthers,
  type EntryKind,
  type EntryListRef,
  type EntryRef,
  type ProfileDraft,
} from '@/lib/profileDraft';
import {
  CUSTOM_SECTION_SPEC,
  DEFAULT_SECTION_KINDS,
  SECTION_KINDS,
  SECTION_KIND_BY_ID,
  customSectionRef,
  effectiveSectionOrder,
  insertRelative,
  moveSection,
  newCustomSectionKey,
  parseSectionRef,
  presenceOf,
  type DropEdge,
  type SectionKind,
  type SectionSpec,
} from '@/lib/profileSections';
import type { StartChoice } from '@/lib/profileGallery';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { AddContentDialog } from './AddContentDialog';
import { BasicsPanel, InterestsCard, SummaryCard } from './ContentCards';
import { EditorHeaderCard } from './EditorHeaderCard';
import { EntryEditor } from './EntryEditor';
import { EntrySection } from './EntrySection';
import { GenerationSettingsCard } from './GenerationSettingsCard';
import { ProfileLimitLink } from '@/components/subscription/LockedFeature';
import { ImportStartDialog } from './ImportStartDialog';
import { KeptLine, SectionSwitch, SwitchCapabilityNote, type UpdateDraft } from './parts';
import ProfilePreview, { type PreviewRequest } from './ProfilePreview';
import type { CardFrame, GripProps } from './SectionCard';
import { SectionSlot } from './SectionSlot';
import { SoftSkillsCard, TechnicalSkillsCard } from './SkillCards';
import { LayoutCard, TemplateCard } from './TemplateCard';
import { editorFont } from './editorFont';
import css from './profileEditor.module.css';

/** The shared <datalist> of the hard-skill library, rendered once for every skill input. */
const LIBRARY_LIST_ID = 'profile-hard-skill-library';

/** How long typing must pause before the preview is redrawn. */
const TYPING_DEBOUNCE_MS = 400;

/** Where the two columns stop fitting; the CSS module draws the same line. */
const NARROW_QUERY = '(max-width: 1099.98px)';

type Pane = 'form' | 'preview';

/** The bar's two tabs, as FlowCV's: what the resume says, and how it looks and is generated. */
type View = 'content' | 'customize';

const VIEWS: ReadonlyArray<{ value: View; label: string; Icon: typeof IconDocument }> = [
  { value: 'content', label: 'Content', Icon: IconDocument },
  { value: 'customize', label: 'Customize', Icon: IconPalette },
];

/** The form's id, for the Save button, which sits in the bar outside it. */
const FORM_ID = 'profile-editor-form';

/** What has taken the column's place: the Basics panel, or the Edit Entry panel for one row. */
type Editing = { panel: 'basics' } | ({ panel: 'entry' } & EntryRef);

/** A drag in progress: the card picked up, and the slot and edge the pointer is over. */
type DragState = { from: string; over: { ref: string; edge: DropEdge } | null };

/**
 * The profile editor, laid out as FlowCV's: a bar across the top - All
 * profiles, the Content and Customize tabs, whether anything is unsaved, and
 * Save - then the cards on the left and the resume they make on the right,
 * all on a warm desk (profileEditor.module.css says how it is drawn).
 * Content is the header card, a card per section and Add content; Customize
 * is the template, the layout and the generation settings. Both tabs stay
 * mounted, the hidden one under `hidden`, so every pinned id - the template
 * select, the layout radios, the section switches - is in the DOM whichever
 * tab is showing.
 *
 * Owns the draft. Each card gets the draft and an `update` that changes it;
 * nothing is saved until Save, and leaving with changes asks first. The
 * preview is sent the draft as it stands, so a template, a layout, a switch,
 * a card dragged or a word typed shows on the page - see ProfilePreview for
 * how often.
 *
 * The cards stand in the order the resume prints its sections in
 * (`effectiveSectionOrder`): the template's own order until the person
 * arranges them - by drag, by Move up / Move down, by adding or removing a
 * section - which turns `draft.sectionOrder` from null into the list as it
 * was shown and changes it from there. "Use the template's order" lets go of
 * it again. An entry is edited in a panel that takes the column's place; the
 * column stays mounted under `hidden` meanwhile, so nothing in it is lost.
 *
 * `accountProfiles` is the account's list, which the page already loaded for
 * its own reasons; the editor reads which templates the other profiles use
 * from it rather than fetching it again.
 *
 * A new profile arrives from the template chooser with `start`: the template
 * and layout chosen there are its draft's from the first frame, and - as
 * FlowCV asks when a new resume opens - "Import your existing resume" offers
 * the resume PDF upload before anything is typed (ImportStartDialog).
 */
export default function ProfileEditor({
  profile,
  accountProfiles,
  start,
}: {
  /** The stored profile, or null for a new one. */
  profile: Profile | null;
  accountProfiles: Profile[];
  /** A new profile's template ('' for none) and layout, from the chooser; `offerImport` opens the import question. */
  start?: StartChoice & { offerImport?: boolean };
}) {
  const router = useRouter();
  const { refresh } = useAuth();

  const [initial] = useState(() => (!profile && start ? draftForNewProfile(start) : draftFromProfile(profile)));
  const [draft, setDraft] = useState<ProfileDraft>(initial);
  const [offeringImport, setOfferingImport] = useState(() => !profile && start?.offerImport === true);
  const baseline = useMemo(() => JSON.stringify(initial), [initial]);
  /** Whether the last change was a discrete choice, which the preview should not debounce. */
  const [quickPreview, setQuickPreview] = useState(true);
  const [pane, setPane] = useState<Pane>('form');
  const [view, setView] = useState<View>('content');
  const narrow = useMediaQuery(NARROW_QUERY);

  const [templates, setTemplates] = useState<Template[]>([]);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);
  const [prompts, setPrompts] = useState<PromptSummary[]>([]);
  const [library, setLibrary] = useState<string[]>([]);
  const [appSettings, setAppSettings] = useState<UserAppSettings>(DEFAULT_USER_APP_SETTINGS);
  /**
   * Whether the model list really arrived. An empty list from a failed request
   * must not be read as "nothing is available": that would drop a perfectly
   * good saved choice on the next save.
   */
  const [modelsLoaded, setModelsLoaded] = useState(false);

  const [saving, setSaving] = useState(false);
  /** A caught failure, which <ErrorNotice> words for the reader. */
  const [saveError, setSaveError] = useState<unknown>(null);

  const [editing, setEditing] = useState<Editing | null>(null);
  const [adding, setAdding] = useState(false);
  const [drag, setDrag] = useState<DragState | null>(null);
  /** For the screen reader, after Move up / Move down. */
  const [announce, setAnnounce] = useState('');
  /** The card Add content just made, which takes focus when it mounts. */
  const [justAdded, setJustAdded] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    // Only the enabled templates, whoever is asking: a resume is never drawn
    // with a disabled one, so the picker must not offer one either.
    templatesApi
      .getAll()
      .then((list) => live && setTemplates(list))
      .catch(() => undefined)
      .finally(() => live && setTemplatesLoaded(true));
    promptsApi
      .getAll()
      .then((list) => live && setPrompts(list))
      .catch(() => undefined);
    resumeApi
      .listSkills('hard')
      .then((answer) => live && setLibrary(answer.skills))
      .catch(() => undefined);
    // The model list and the app's own default, so the inherit option can say
    // what inheriting actually gets you.
    resumeApi
      .getModels()
      .then((settings) => {
        if (!live) return;
        setAppSettings(settings);
        setModelsLoaded(true);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const update: UpdateDraft = useCallback((recipe, options) => {
    setDraft((current) => recipe(current));
    setQuickPreview(options?.immediate === true);
  }, []);

  const dirty = JSON.stringify(draft) !== baseline;

  // Closing the tab or reloading with changes asks first. Leaving through the
  // page's own buttons asks too (see `leave`); a click on the rail does not,
  // because the App Router offers no way to hold a navigation.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const layout = normalizeTechnicalSkillsLayout(draft.settings.technicalSkillsLayout);
  const selectedId = effectiveTemplateId(draft);
  const selectedTemplate = templates.find((template) => template.id === selectedId) ?? null;
  const usedByOthers = useMemo(
    () => templatesUsedByOthers(accountProfiles, profile?.id),
    [accountProfiles, profile?.id]
  );
  const storedTemplateId = profile?.preferredTemplate || undefined;
  const options = templateOptions(templates, {
    usedByOthers,
    ownTemplateIds: [storedTemplateId ?? '', selectedId],
  });

  const templateName = useCallback(
    (id: string) => templates.find((template) => template.id === id)?.name ?? id,
    [templates]
  );

  const selectTemplate = (templateId: string) => {
    update((current) => ({ ...current, preferredTemplate: templateId }), { immediate: true });
  };

  /** Every template prints both layouts, so a layout changes only how Technical Skills is drawn. */
  const changeLayout = (next: TechnicalSkillsLayout) => {
    if (next === layout) return;
    update((current) => ({ ...current, settings: { ...current.settings, technicalSkillsLayout: next } }), {
      immediate: true,
    });
  };

  /**
   * The library's spelling of a skill, adding it to the shared library first
   * when the library does not know it.
   *
   * Through `confirmSkill`, not the library's own add: that one belongs to the
   * administrator's Skill Library page, needs a category and a priority this
   * form never asks for (so it refused every new skill here), and is
   * admin-only. Confirm infers both from the skill's name. Throws, for the
   * card that asked to show.
   */
  const ensureLibrarySkill = useCallback(
    async (value: string) => {
      const known = library.find((skill) => skill.toLowerCase() === value.toLowerCase());
      if (known) return known;
      const answer = await resumeApi.confirmSkill({ type: 'hard', skill: value });
      const skill = answer.skill || value;
      setLibrary((current) =>
        hasSkill(current, skill) ? current : [...current, skill].sort((a, b) => a.localeCompare(b))
      );
      return skill;
    },
    [library]
  );

  // The library's headings, plus any this profile already uses. A profile
  // imported from a file may carry headings this build has never heard of, and
  // dropping them from the menu would silently reassign them on the next save.
  const headingOptions = useMemo(
    () =>
      [
        ...HARD_SKILL_CATEGORIES,
        ...Object.values(draft.skillCategoryBySkill).map((heading) => heading.trim()),
      ].filter((heading, index, all) => heading && all.indexOf(heading) === index),
    [draft.skillCategoryBySkill]
  );

  const previewRequest = useMemo<PreviewRequest>(
    () => ({
      profile: draftToPreviewProfile(draft, HARD_SKILL_CATEGORIES),
      ...(profile ? { profileId: profile.id } : {}),
    }),
    [draft, profile]
  );

  const previewNotes = (shown: ProfilePreviewResult, request: PreviewRequest) => {
    // What the page filled in for the fields left empty: said, so nobody
    // takes the sample person's phone number for their own.
    const sample = sampledNotice(shown.sampled);
    const sampleNote = sample ? (
      <p className={css.sampleNote} role="status">
        {sample} It fills what is empty, here only: it is never saved, printed or sent to tailoring.
      </p>
    ) : null;

    // The server draws a profile with another template only when its own is
    // not offered any more (disabled or deleted): every template prints both
    // Technical Skills layouts.
    const wanted = request.profile.preferredTemplate || 'default';
    if (!templatesLoaded || shown.templateId === wanted) return sampleNote;
    return (
      <>
        <Notice tone="info" role="status">
          Drawn with {templateName(shown.templateId)}: the template this profile names is not offered any more. A
          generated resume falls back the same way.
        </Notice>
        {sampleNote}
      </>
    );
  };

  const leave = () => {
    if (dirty && !window.confirm('Leave without saving? The changes you made to this profile will be lost.')) {
      return;
    }
    router.push('/admin/profiles');
  };

  /** A tab of the bar. The other tab's cards start at the top, not wherever the last tab was scrolled to. */
  const chooseView = (next: View) => {
    if (next === view) return;
    setView(next);
    if (window.scrollY > 0) window.scrollTo({ top: 0 });
  };

  /** Left and Right move between the two tabs, as a tab list's arrow keys do. */
  const onViewKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const index = VIEWS.findIndex((item) => item.value === view);
    const next = VIEWS[(index + (event.key === 'ArrowRight' ? 1 : VIEWS.length - 1)) % VIEWS.length];
    chooseView(next.value);
    document.getElementById(`editor-tab-${next.value}`)?.focus();
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaveError(null);
    setSaving(true);
    try {
      const ai: AiPreferences = savableModelChoice(draft.settings.ai, {
        modelsLoaded,
        offeredIds: appSettings.models.map((model) => model.id),
        storedModelId: profile?.profileSettings?.ai?.modelId,
      });
      const payload = draftToPayload(draft, ai, HARD_SKILL_CATEGORIES);
      if (profile) {
        await profilesApi.update(profile.id, payload);
      } else {
        await profilesApi.create(payload);
        // The account's own count feeds the subscription line on the list, which would
        // otherwise read one behind until the next sign-in check.
        await refresh();
      }
      // Still "saving" while the list loads, so a second press cannot send it twice.
      router.push('/admin/profiles');
    } catch (err) {
      // Two tabs at the subscription's limit: one wins, and the other should find the
      // limit re-read rather than keep trying.
      if (isProfileLimit(err)) await refresh();
      setSaveError(err ?? 'Failed to save the profile.');
      setSaving(false);
    }
  };

  /** Whether the chosen template has the Strengths / Soft Skills section; null while templates load. */
  const templateSupports = (field: 'supportsStrengths' | 'supportsSoftSkills') =>
    templatesLoaded && selectedTemplate ? selectedTemplate[field] : null;
  const selectedName = selectedTemplate?.name ?? 'This template';
  /** Whether the chosen template prints a section; null while templates load. */
  const printsFor = (ref: string) =>
    templatesLoaded && selectedTemplate ? templatePrintsSection(selectedTemplate, ref) : null;

  // ---------------------------------------------------------- the order

  // The cards as shown: the stored order completed, or the template's own
  // (the default kinds before any template has loaded). This is what the
  // first touch stores, so the resume keeps the order it had when it was
  // touched rather than jumping to a canonical one.
  const native = selectedTemplate?.nativeSectionOrder ?? DEFAULT_SECTION_KINDS;
  const displayed = effectiveSectionOrder(draft.sectionOrder ?? [], native, presenceOf(draft));
  const ownOrder = draft.sectionOrder !== null;

  const sectionLabel = (ref: string): string => {
    const parsed = parseSectionRef(ref);
    if (!parsed) return ref;
    if (parsed.kind === 'custom') {
      return draft.customSections.find((section) => section.key === parsed.key)?.title.trim() || CUSTOM_SECTION_SPEC.label;
    }
    return SECTION_KIND_BY_ID[parsed.kind].label;
  };

  /** "3 entries", "12 skills" - the head's count, after the label; nothing for an empty section or the summary. */
  const sectionMeta = (ref: string): string | undefined => {
    const parsed = parseSectionRef(ref);
    if (!parsed || parsed.kind === 'summary') return undefined;
    const count = entryCount(draft, ref);
    if (count === 0) return undefined;
    const noun =
      parsed.kind === 'skills'
        ? count === 1 ? 'skill' : 'skills'
        : parsed.kind === 'softSkills'
          ? count === 1 ? 'soft skill' : 'soft skills'
          : parsed.kind === 'interests'
            ? count === 1 ? 'interest' : 'interests'
            : count === 1 ? 'entry' : 'entries';
    return `${count} ${noun}`;
  };

  const setOrder = (order: string[]) => update((current) => ({ ...current, sectionOrder: order }), { immediate: true });

  const move = (ref: string, delta: number) => {
    const next = moveSection(displayed, ref, delta);
    if (next.join('\n') === displayed.join('\n')) return;
    setOrder(next);
    setAnnounce(`${sectionLabel(ref)} moved ${delta < 0 ? 'up' : 'down'}, now ${next.indexOf(ref) + 1} of ${next.length}.`);
  };

  const onDragStart = (ref: string) => setDrag({ from: ref, over: null });
  // Bails out when nothing changed: dragover fires on every pointer move.
  const onDragOver = (ref: string, edge: DropEdge) =>
    setDrag((current) =>
      current && (current.over?.ref !== ref || current.over.edge !== edge) ? { ...current, over: { ref, edge } } : current
    );
  const onDrop = () => {
    if (drag?.over) {
      const next = insertRelative(displayed, drag.from, drag.over.ref, drag.over.edge);
      if (next.join('\n') !== displayed.join('\n')) setOrder(next);
    }
    setDrag(null);
  };
  const onDragEnd = () => setDrag(null);

  const useTemplateOrder = () => update((current) => ({ ...current, sectionOrder: null }), { immediate: true });

  // ---------------------------------------------------- adding, removing

  const availableKinds = SECTION_KINDS.filter(
    (kind) => !DEFAULT_SECTION_KINDS.includes(kind.id) && !displayed.includes(kind.id)
  );

  const addKind = (kind: SectionKind) => {
    update((current) => addSectionKind(current, kind, displayed), { immediate: true });
    setJustAdded(kind);
    setAdding(false);
  };

  const addCustom = (title: string) => {
    const key = newCustomSectionKey(draft.customSections.map((section) => section.key));
    update((current) => addCustomSection(current, key, title, displayed), { immediate: true });
    setJustAdded(customSectionRef(key));
    setAdding(false);
  };

  const removeSectionRef = (ref: string) => {
    const count = entryCount(draft, ref);
    if (
      count > 0 &&
      !window.confirm(
        `Remove ${sectionLabel(ref)} and its ${count} ${count === 1 ? 'entry' : 'entries'}? ${count === 1 ? 'It is' : 'They are'} deleted when you save.`
      )
    ) {
      return;
    }
    update((current) => removeSection(current, ref, displayed), { immediate: true });
  };

  // ------------------------------------------------------- the panels

  // Derived, not stored: a row deleted from under the panel - by Delete, or
  // by Remove section - closes it, with no effect to run.
  const panel = useMemo(() => {
    if (!editing) return null;
    if (editing.panel === 'basics') return { panel: 'basics' as const };
    const row = findEntry(draft, editing);
    return row ? { panel: 'entry' as const, ref: editing as EntryRef, row } : null;
  }, [editing, draft]);

  const openEntry = (list: EntryListRef, key: string) => setEditing({ panel: 'entry', ...list, key });

  const addEntry = (list: EntryListRef) => {
    const entry = emptyEntry(list.kind === 'custom' ? 'custom' : list.kind);
    update((current) => appendEntry(current, list, entry));
    openEntry(list, entry.key);
  };

  const specOf = (ref: EntryRef): SectionSpec =>
    ref.kind === 'custom' ? CUSTOM_SECTION_SPEC : SECTION_KIND_BY_ID[ref.kind];

  /** Done: close the panel, and drop the row if nothing was typed into it. */
  const doneEditing = () => {
    if (panel?.panel === 'entry' && isBlankEntry(panel.row)) {
      const ref = panel.ref;
      update((current) => removeEntry(current, ref));
    }
    setEditing(null);
  };

  const deleteEntry = () => {
    if (panel?.panel !== 'entry') return;
    const noun = specOf(panel.ref).entryNoun;
    if (!isBlankEntry(panel.row) && !window.confirm(`Delete this ${noun}? It is removed when you save the profile.`)) {
      return;
    }
    const ref = panel.ref;
    update((current) => removeEntry(current, ref), { immediate: true });
    setEditing(null);
  };

  // ------------------------------------------------------- the cards

  const frameFor = (ref: string, grip: GripProps): CardFrame => {
    const index = displayed.indexOf(ref);
    return {
      grip,
      move: {
        up: () => move(ref, -1),
        down: () => move(ref, 1),
        canUp: index > 0,
        canDown: index >= 0 && index < displayed.length - 1,
      },
      meta: sectionMeta(ref),
      focusOnMount: justAdded === ref,
    };
  };

  const renderCard = (ref: string, grip: GripProps) => {
    const parsed = parseSectionRef(ref);
    if (!parsed) return null;
    const frame = frameFor(ref, grip);

    if (parsed.kind === 'custom') {
      const section = draft.customSections.find((item) => item.key === parsed.key);
      if (!section) return null;
      const list: EntryListRef = { kind: 'custom', sectionKey: parsed.key };
      return (
        <EntrySection
          label={section.title.trim() || CUSTOM_SECTION_SPEC.label}
          spec={CUSTOM_SECTION_SPEC}
          entries={section.entries}
          onOpen={(key) => openEntry(list, key)}
          onAdd={() => addEntry(list)}
          onRemoveSection={() => removeSectionRef(ref)}
          templatePrints={printsFor(ref)}
          templateName={selectedName}
          customTitle={{ sectionKey: parsed.key, value: section.title }}
          update={update}
          frame={frame}
        />
      );
    }

    const kind = parsed.kind;
    const spec = SECTION_KIND_BY_ID[kind];
    switch (spec.editor) {
      case 'summary':
        return <SummaryCard draft={draft} update={update} frame={frame} />;
      case 'skills':
        return (
          <TechnicalSkillsCard
            draft={draft}
            update={update}
            headingOptions={headingOptions}
            libraryListId={LIBRARY_LIST_ID}
            ensureLibrarySkill={ensureLibrarySkill}
            frame={frame}
          />
        );
      case 'softSkills':
        return (
          <SoftSkillsCard
            draft={draft}
            update={update}
            templateSupports={templateSupports('supportsSoftSkills')}
            templateName={selectedName}
            frame={frame}
          />
        );
      case 'chips':
        return (
          <InterestsCard
            draft={draft}
            update={update}
            templatePrints={printsFor(ref)}
            templateName={selectedName}
            frame={frame}
          />
        );
      case 'entries': {
        const list: EntryListRef = { kind: kind as EntryKind };
        const isDefault = DEFAULT_SECTION_KINDS.includes(kind);
        if (kind === 'strengths') {
          const on = draft.settings.includeStrengths;
          return (
            <EntrySection
              label={spec.label}
              spec={spec}
              entries={entriesOf(draft, list)}
              onOpen={(key) => openEntry(list, key)}
              onAdd={() => addEntry(list)}
              templatePrints={null}
              templateName={selectedName}
              showRows={on}
              header={
                <>
                  <SectionSwitch
                    id="profile-include-strengths"
                    checked={on}
                    onChange={(checked) =>
                      update(
                        (current) => ({ ...current, settings: { ...current.settings, includeStrengths: checked } }),
                        { immediate: true }
                      )
                    }
                    label="Print a Strengths section"
                  >
                    {on
                      ? 'Your strengths print as you write them here, tailored or not. Tailoring reads them, and never rewrites them.'
                      : 'Off: no Strengths section is printed, and tailoring is not given them.'}
                  </SectionSwitch>
                  <SwitchCapabilityNote
                    on={on}
                    supported={templateSupports('supportsStrengths')}
                    section="Strengths"
                    templateName={selectedName}
                    whenOff="no Strengths section is printed."
                  />
                  {!on && <KeptLine note={keptNote(keptCount(draft, 'strengths'), 'strengths')} />}
                </>
              }
              update={update}
              frame={frame}
            />
          );
        }
        return (
          <EntrySection
            label={spec.label}
            spec={spec}
            entries={entriesOf(draft, list)}
            onOpen={(key) => openEntry(list, key)}
            onAdd={() => addEntry(list)}
            onRemoveSection={isDefault ? undefined : () => removeSectionRef(ref)}
            templatePrints={printsFor(ref)}
            templateName={selectedName}
            update={update}
            frame={frame}
          />
        );
      }
    }
  };

  return (
    <div className={`${css.editor} ${editorFont.variable}`}>
      <div className={css.desk}>
        <h1 className="sr-only">{profile ? 'Edit Profile' : 'New Profile'}</h1>

        <div className={css.bar}>
          <button type="button" onClick={leave} className={css.barBack} title="All profiles">
            <IconGrid className="h-[18px] w-[18px]" strokeWidth={2.75} />
            <span className={css.barLabel}>Profiles</span>
          </button>

          <div className={css.barTabs} role="tablist" aria-label="Editor views" onKeyDown={onViewKey}>
            {VIEWS.map(({ value, label, Icon }) => (
              <button
                key={value}
                id={`editor-tab-${value}`}
                type="button"
                role="tab"
                aria-selected={view === value}
                aria-controls={`editor-panel-${value}`}
                tabIndex={view === value ? 0 : -1}
                className={css.barTab}
                onClick={() => chooseView(value)}
              >
                <Icon className={`${css.barTabIcon} h-[19px] w-[19px]`} strokeWidth={2} />
                {label}
              </button>
            ))}
          </div>

          <div className={css.barEnd}>
            <span className={css.saveState} data-state={dirty ? 'dirty' : 'clean'} aria-live="polite">
              {dirty ? 'Unsaved changes' : profile ? 'No changes yet' : 'Nothing entered yet'}
            </span>
            <button type="submit" form={FORM_ID} disabled={saving} className={css.saveButton}>
              {saving ? (
                'Saving...'
              ) : (
                // One run of text, so the button's flex gap never lands inside it. "Save" alone on a
                // phone keeps the bar to one row; a screen reader still hears the whole.
                <span>
                  {profile ? 'Save' : 'Create'}
                  <span className={css.barLabel}> Profile</span>
                </span>
              )}
            </button>
          </div>

          {/* The two columns do not fit: one at a time, chosen here. */}
          <div className={css.segment} role="tablist" aria-label="Editor">
            {(['form', 'preview'] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={pane === value}
                className={css.segmentTab}
                onClick={() => setPane(value)}
              >
                {value === 'form' ? 'Form' : 'Preview'}
              </button>
            ))}
          </div>

          {saveError !== null && (
            <div className={css.saveError}>
              <ErrorNotice error={saveError} onDismiss={() => setSaveError(null)}>
                <ProfileLimitLink error={saveError} />
              </ErrorNotice>
            </div>
          )}
        </div>

        <div className={css.workspace} data-pane={pane}>
          <form id={FORM_ID} className={css.formPane} onSubmit={handleSubmit}>
            <datalist id={LIBRARY_LIST_ID}>
              {library.map((skill) => (
                <option key={skill} value={skill} />
              ))}
            </datalist>
            <p className="sr-only" aria-live="polite">
              {announce}
            </p>

            <div
              id="editor-panel-content"
              role="tabpanel"
              aria-labelledby="editor-tab-content"
              hidden={view !== 'content'}
            >
              {panel?.panel === 'basics' && <BasicsPanel draft={draft} update={update} onDone={() => setEditing(null)} />}
              {panel?.panel === 'entry' && (
                <EntryEditor
                  key={panel.row.key}
                  spec={specOf(panel.ref)}
                  entryRef={panel.ref}
                  row={panel.row}
                  draft={draft}
                  update={update}
                  sectionLabel={sectionLabel(
                    panel.ref.kind === 'custom' ? customSectionRef(panel.ref.sectionKey) : panel.ref.kind
                  )}
                  libraryListId={LIBRARY_LIST_ID}
                  ensureLibrarySkill={ensureLibrarySkill}
                  onDone={doneEditing}
                  onBack={() => setEditing(null)}
                  onDelete={deleteEntry}
                />
              )}

              {/* Mounted whether or not a panel is up, so a collapsed card, a
                  half-typed skill and every pinned id are still here when the
                  panel closes. */}
              <div className={css.column} hidden={panel !== null}>
                <EditorHeaderCard draft={draft} onEdit={() => setEditing({ panel: 'basics' })} />
                <div className={css.stack}>
                  {displayed.map((ref) => (
                    <SectionSlot
                      key={ref}
                      sectionRef={ref}
                      dragActive={drag !== null}
                      dragging={drag?.from === ref}
                      dropEdge={drag?.over && drag.over.ref === ref && drag.from !== ref ? drag.over.edge : null}
                      onDragStart={onDragStart}
                      onDragOver={onDragOver}
                      onDrop={onDrop}
                      onDragEnd={onDragEnd}
                    >
                      {(grip) => renderCard(ref, grip)}
                    </SectionSlot>
                  ))}
                </div>
                <button type="button" className={css.addContent} onClick={() => setAdding(true)}>
                  <IconPlus className="h-[20px] w-[20px]" strokeWidth={2.4} />
                  Add content
                </button>
              </div>
            </div>

            <div
              id="editor-panel-customize"
              role="tabpanel"
              aria-labelledby="editor-tab-customize"
              hidden={view !== 'customize'}
            >
              <div className={css.column}>
                <TemplateCard
                  options={options}
                  templates={templates}
                  loaded={templatesLoaded}
                  selectedId={selectedId}
                  onSelect={selectTemplate}
                />
                <LayoutCard
                  layout={layout}
                  onLayoutChange={changeLayout}
                  ownOrder={ownOrder}
                  onUseTemplateOrder={useTemplateOrder}
                />
                <GenerationSettingsCard
                  draft={draft}
                  update={update}
                  appSettings={appSettings}
                  modelsLoaded={modelsLoaded}
                  prompts={prompts}
                />
              </div>
            </div>
          </form>

          <aside className={css.previewPane} aria-label="Resume preview">
            <ProfilePreview
              request={previewRequest}
              active={!narrow || pane === 'preview'}
              debounceMs={quickPreview ? 0 : TYPING_DEBOUNCE_MS}
              templateName={templateName}
              notes={previewNotes}
            />
          </aside>
        </div>
      </div>

      <AddContentDialog
        open={adding}
        onClose={() => setAdding(false)}
        available={availableKinds}
        customCount={draft.customSections.length}
        onAddKind={addKind}
        onAddCustom={addCustom}
      />

      {!profile && start && (
        <ImportStartDialog
          open={offeringImport}
          templateId={start.templateId}
          layout={start.layout}
          templateName={selectedTemplate?.name ?? 'the template you chose'}
          onStartBlank={() => setOfferingImport(false)}
        />
      )}
    </div>
  );
}
