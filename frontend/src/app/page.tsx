'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import {
  adminApi,
  ApiResponseError,
  profilesApi,
  groupsApi,
  resumeApi,
  DEFAULT_USER_APP_SETTINGS,
  UserAppSettings,
  AiPreferences,
  GoogleSheetSource,
  isInsufficientCredits,
  normalizeAiPreferences,
  toAiRequestOverrides,
  Profile,
  Group,
  JobAnalysis,
  TailoredContent,
} from '@/lib/api';
import {
  forgetBatch,
  generationApi,
  rememberBatch,
  rememberedBatch,
  type BatchSnapshot,
  type GenerationQuote,
  type SubmitBatchRequest,
} from '@/lib/generationQueue';
import GenerationProgress, { type GenerationProgressState } from '@/components/GenerationProgress';
import ProfileSelector from '@/components/ProfileSelector';
import AiPreferenceFields from '@/components/AiPreferenceFields';
import ResumePreview from '@/components/ResumePreview';
import SheetsImportModal, { ImportedSheetJob, type ImportSheetSource } from '@/components/SheetsImportModal';
import { useAuth } from '@/contexts/AuthContext';
import { sheetApi, type AccountSheet } from '@/lib/sheet';
import { applyTheme, getStoredTheme, setStoredDefaultTheme } from '@/lib/theme';
import { Card, ErrorNotice, Notice, Page, PageHeader, Pill, Spinner } from '@/components/ui/kit';
import { userMessage } from '@/lib/userMessage';
import { keepUnbuiltPreviews, readyPreviewKey } from '@/lib/builderPreviews';
import { nextAttach } from '@/lib/batchFollow';
import { IconBuild, IconChevronRight, IconTemplates } from '@/components/icons';
import styles from '@/components/builder.module.css';

type GenerateMode = 'single' | 'multiple';
type BuilderMode = 'manual' | 'sheets' | null;
type SheetsTargetMode = 'single' | 'all' | 'group';

/** What a placed sheet import reports back, before any of it has been built. */
type PlacedOrder = {
  id: string;
  number: string;
  total: number;
  jobCount: number;
  profileCount: number;
  skippedNote: string;
};

/**
 * The id standing for "this account's own job sheet".
 *
 * Not the spreadsheet id: that arrives asynchronously and changes the first
 * time a sheet is allocated, and a selection keyed on it would be dropped the
 * moment it did.
 */
const OWN_SHEET_SOURCE_ID = 'own';

type UnconfirmedSkill = { original: string; value: string };

type MultiplePreview = {
  profileId: string;
  profileName: string;
  html: string;
  tailoredContent?: TailoredContent;
  /**
   * The server's word for which model wrote `tailoredContent`. Sent back when
   * finalising, so the resume is charged at the model that did the work rather
   * than whatever the menu says by then. Kept through manual edits and
   * re-renders: they are still that model's work.
   */
  previewToken?: string;
  draft: string;
  error: string;
};

type GenerationFailure = {
  profileId: string;
  profileName: string;
  companyName: string;
  error: string;
};

function formatCompanySummary(companyNames: string[]): string {
  const uniqueCompanies = [...new Set(companyNames.map((name) => name.trim()).filter(Boolean))];
  if (uniqueCompanies.length === 0) return '';
  if (uniqueCompanies.length <= 3) return uniqueCompanies.join(', ');
  return `${uniqueCompanies.slice(0, 3).join(', ')}, ...`;
}

function getAnalysisJobTitle(analysis?: JobAnalysis): string {
  return analysis?.jobMeta?.title?.trim() ?? '';
}

/**
 * The job a quote is priced against.
 *
 * A placeholder, because what a resume costs depends on the profile and the
 * model it resolves to and never on the job - and the quote is wanted before
 * anybody has typed a company name. The server still validates a quote's jobs
 * the way it validates a real submission's, so this one is complete.
 */
const QUOTE_JOBS: SubmitBatchRequest['jobs'] = [{ companyName: 'Quote', role: 'Quote' }];

/** A 402 from a run, as the sentence the page shows for it. */
type CreditShortfall = { message: string };

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * What a run will cost, beside the button that starts it.
 *
 * A refused run's shortfall takes its place, with the way to fix it - inside
 * the preview dialogs too, which cover the page's own error area.
 */
function CostLine({
  quote,
  shortfall = null,
  label = 'This run',
}: {
  quote: GenerationQuote | null;
  /** Passed only where the page's own notice is hidden: inside a dialog. */
  shortfall?: CreditShortfall | null;
  /** What is being priced: "This run", or one sheet row when the row count is not known yet. */
  label?: string;
}) {
  if (shortfall) {
    return (
      <span className="tl-status" data-tone="error" role="alert">
        {shortfall.message}{' '}
        <Link href="/credits" className="tl-link">
          Buy credits
        </Link>
      </span>
    );
  }
  if (!quote) return null;
  if (quote.exempt) return <span className="text-sm text-muted">Administrators are not charged</span>;
  const short = quote.credits > quote.balance;
  return (
    <span className={short ? 'tl-status' : 'text-sm text-muted'} data-tone={short ? 'error' : undefined}>
      {label}: {plural(quote.resumes, 'resume')} ·{' '}
      {plural(quote.credits, 'credit')} · balance {quote.balance}
      {short && (
        <>
          {' '}
          ·{' '}
          <Link href="/credits" className="tl-link">
            Buy credits
          </Link>
        </>
      )}
    </span>
  );
}

export default function Home() {
  // `refresh` re-reads the account after a run, so the balance in the top bar
  // moves when credits are spent or refunded rather than on the next reload.
  const { account, refresh: refreshAccount } = useAuth();
  const isAdmin = account?.role === 'admin';
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [builderMode, setBuilderMode] = useState<BuilderMode>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  /**
   * The model for THIS run only.
   *
   * Empty means every field falls through to the selected profile's own
   * setting, and then to the app default - nothing here is persisted.
   */
  const [aiOverrides, setAiOverrides] = useState<AiPreferences>({});
  const [generateMode, setGenerateMode] = useState<GenerateMode>('single');
  const [multipleTarget, setMultipleTarget] = useState<'all' | 'group'>('group');
  const [selectedGroupId, setSelectedGroupId] = useState<string>('');
  const [sheetsTargetMode, setSheetsTargetMode] = useState<SheetsTargetMode>('single');
  const [selectedSheetsProfileId, setSelectedSheetsProfileId] = useState<string | null>(null);
  const [selectedSheetsGroupId, setSelectedSheetsGroupId] = useState<string>('');
  const [selectedSheetsSourceId, setSelectedSheetsSourceId] = useState<string>('');
  const [accountSheet, setAccountSheet] = useState<AccountSheet | null>(null);
  const [companyName, setCompanyName] = useState('');
  const [role, setRole] = useState('');
  const [jobDescription, setJobDescription] = useState('');
  const [modelSettings, setModelSettings] = useState<UserAppSettings>(DEFAULT_USER_APP_SETTINGS);
  /** Whether `modelSettings` is the server's answer, rather than the empty stand-in. */
  const [modelsLoaded, setModelsLoaded] = useState(false);
  /** The administrator's saved sheets, loaded only for an administrator. */
  const [sharedSheetSources, setSharedSheetSources] = useState<GoogleSheetSource[]>([]);
  /**
   * The quote for the run the page is set up for, tagged with the request it
   * answers so a slow answer to an earlier selection is never shown as the
   * price of the current one.
   */
  const [quoteResult, setQuoteResult] = useState<{ key: string; quote: GenerationQuote | null } | null>(null);
  /** Bumped after every run, so the balances on the page are re-read. */
  const [runRevision, setRunRevision] = useState(0);
  const [shortfall, setShortfall] = useState<CreditShortfall | null>(null);
  const [jobAnalysis, setJobAnalysis] = useState<JobAnalysis | null>(null);
  const [previewHtml, setPreviewHtml] = useState('');
  const [previewTailored, setPreviewTailored] = useState(false);
  const [isSinglePreviewOpen, setIsSinglePreviewOpen] = useState(false);
  const [tailoredContent, setTailoredContent] = useState<TailoredContent | null>(null);
  /** The single preview's token - see MultiplePreview.previewToken. */
  const [previewToken, setPreviewToken] = useState<string | null>(null);
  const [tailoredContentDraft, setTailoredContentDraft] = useState('');
  const [tailoredContentError, setTailoredContentError] = useState('');
  const [unconfirmedHardSkills, setUnconfirmedHardSkills] = useState<UnconfirmedSkill[]>([]);
  const [unconfirmedSoftSkills, setUnconfirmedSoftSkills] = useState<UnconfirmedSkill[]>([]);
  const [multiplePreviews, setMultiplePreviews] = useState<MultiplePreview[]>([]);
  const [multiplePreviewTailored, setMultiplePreviewTailored] = useState(false);
  const [multiplePreviewIndex, setMultiplePreviewIndex] = useState(0);
  const [autoGenerate, setAutoGenerate] = useState(false);
  const [isSheetsImportOpen, setIsSheetsImportOpen] = useState(false);

  const [isLoadingData, setIsLoadingData] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationStep, setGenerationStep] = useState('');
  const [generationProgress, setGenerationProgress] = useState<GenerationProgressState | null>(null);
  /**
   * What went wrong: one of the page's own sentences ("Please select a
   * profile"), or the failure itself, which <ErrorNotice> words for the reader
   * and - for an administrator - follows with the server's detail.
   */
  const [error, setError] = useState<unknown>('');
  const [successMessage, setSuccessMessage] = useState('');
  /** The receipt for a sheet import, kept as data so it can carry a link. */
  const [placedOrder, setPlacedOrder] = useState<PlacedOrder | null>(null);

  useEffect(() => {
    loadInitialData();
  }, []);

  const resetTailoredEditor = useCallback(() => {
    setTailoredContent(null);
    setPreviewToken(null);
    setTailoredContentDraft('');
    setTailoredContentError('');
  }, []);

  const resetGenerationOutputs = useCallback(() => {
    // The order receipt is one of these outputs. Without this it sat on the
    // Builder over every later manual build, still congratulating somebody on
    // an import they made twenty minutes ago.
    setPlacedOrder(null);
    setPreviewHtml('');
    setPreviewTailored(false);
    setIsSinglePreviewOpen(false);
    resetTailoredEditor();
    setJobAnalysis(null);
    setSuccessMessage('');
    setUnconfirmedHardSkills([]);
    setUnconfirmedSoftSkills([]);
    setMultiplePreviews([]);
    setMultiplePreviewTailored(false);
    setMultiplePreviewIndex(0);
  }, [resetTailoredEditor]);

  // The model too: a preview is that model's work, and the cost line, the
  // picker and the finalise must all be about the same one. Leaving a preview
  // up across a change of model priced it at the new one.
  useEffect(() => {
    resetGenerationOutputs();
  }, [builderMode, companyName, role, jobDescription, selectedProfileId, generateMode, aiOverrides.modelId, resetGenerationOutputs]);

  const selectedProfile = profiles.find((profile) => profile.id === selectedProfileId) ?? null;
  const aiRequestOverrides = toAiRequestOverrides(aiOverrides);
  const hasAiOverrides = Object.keys(aiRequestOverrides).length > 0;
  /**
   * What the override selects fall back to.
   *
   * In single mode that is the chosen profile's own setting, which is the
   * layer directly beneath this one; with no profile in scope - multiple mode,
   * or nothing selected yet - it is the app default.
   */
  const profilePreferences = normalizeAiPreferences(selectedProfile?.profileSettings?.ai);
  const inheritsFromProfile = generateMode === 'single' && Boolean(selectedProfile);
  // The profile's own model, but only while it is one that can still run: a
  // profile pointing at a model this installation has since locked falls back
  // to the app default, and this label has to name what will really be used.
  const inheritedModel =
    modelSettings.models.find((model) => model.id === profilePreferences.modelId) ??
    modelSettings.models.find((model) => model.id === modelSettings.defaultModelId);
  const inheritedChoice = {
    modelLabel: inheritedModel?.name || 'the first enabled model',
  };

  const loadInitialData = async () => {
    try {
      const [profilesData, groupsData, loadedModels, ownSheet] = await Promise.all([
        profilesApi.getAll({ includeDisabled: true }),
        groupsApi.getAll().catch(() => []),
        resumeApi.getModels().catch(() => null),
        // Never fatal to this page: the import dialog is one feature of it, and
        // a Google outage must not stop the builder from loading.
        sheetApi.get().catch(() => null),
      ]);
      const enabledProfiles = profilesData.filter((p) => !p.disabled);
      // A failed models request is not "no models": the picker must not tell
      // the reader AI generation is unavailable because one request dropped.
      const modelData = loadedModels ?? DEFAULT_USER_APP_SETTINGS;
      setProfiles(enabledProfiles);
      setGroups(groupsData);
      setModelSettings(modelData);
      setModelsLoaded(loadedModels !== null);
      setAccountSheet(ownSheet);
      setAutoGenerate(modelData.defaultMode === 'generate');
      setStoredDefaultTheme(modelData.defaultTheme);

      if (!getStoredTheme()) {
        applyTheme(modelData.defaultTheme);
      }

      if (enabledProfiles.length > 0) {
        const defaultProfileExists = enabledProfiles.some((profile) => profile.id === modelData.defaultProfileId);
        const initialProfileId = defaultProfileExists ? modelData.defaultProfileId : enabledProfiles[0].id;
        setSelectedProfileId(initialProfileId);
        setSelectedSheetsProfileId(initialProfileId);
      }

      if (modelData.defaultResumeSelection === 'single') {
        setGenerateMode('single');
        setMultipleTarget('group');
        setSelectedGroupId('');
        setSheetsTargetMode('single');
        setSelectedSheetsGroupId('');
      } else if (modelData.defaultResumeSelection === 'all') {
        setGenerateMode('multiple');
        setMultipleTarget('all');
        setSelectedGroupId('');
        setSheetsTargetMode('all');
        setSelectedSheetsGroupId('');
      } else {
        const defaultGroupExists = groupsData.some((group) => group.id === modelData.defaultGroupId);
        setGenerateMode('multiple');
        setMultipleTarget('group');
        const initialGroupId = defaultGroupExists ? modelData.defaultGroupId : '';
        setSelectedGroupId(initialGroupId);
        setSheetsTargetMode('group');
        setSelectedSheetsGroupId(initialGroupId);
      }
    } catch (err) {
      setError(err ?? 'Failed to load data.');
    } finally {
      setIsLoadingData(false);
    }
  };

  const toUnconfirmedItems = (skills?: string[]) =>
    (skills ?? []).map((skill) => ({ original: skill, value: skill }));

  const getDefaultGenerationOptions = () => ({
    format: (modelSettings.defaultResumeDocxEnabled ? 'both' : 'pdf') as 'both' | 'pdf',
    includeCoverLetterDocx: modelSettings.defaultCoverLetterDocxEnabled,
  });
  const shouldShowRoleInput = modelSettings.outputPathUsesJobTitle;
  /**
   * Which spreadsheets this account may import from.
   *
   * Its own, first and by default - that is the one every account has, and the
   * only one an ordinary account is allowed to address. The saved sources
   * belong to the administrator who configured them, so offering them to
   * everybody sent a user at a spreadsheet the backend would rightly refuse:
   * "That spreadsheet was not found." They stay, for the administrator, behind
   * the account's own sheet.
   */
  const sheetImportSources = useMemo<ImportSheetSource[]>(() => {
    const own: ImportSheetSource[] =
      accountSheet?.configured && accountSheet.spreadsheetId
        ? [
            {
              id: OWN_SHEET_SOURCE_ID,
              name: 'My job sheet',
              sheetId: accountSheet.spreadsheetId,
              isOwnSheet: true,
              preferredTab: accountSheet.todayTab,
            },
          ]
        : [];

    return isAdmin ? [...own, ...sharedSheetSources] : own;
  }, [accountSheet, isAdmin, sharedSheetSources]);

  /*
   * The saved sources live in the administrator's settings, which nobody else
   * may read - so only an administrator's builder asks for them. Never fatal:
   * the account's own sheet is the import every account has.
   */
  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    adminApi
      .getSettings()
      .then((settings) => {
        if (!cancelled) setSharedSheetSources(settings.googleSheetsSources);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  /**
   * The profiles a manual run will build for, exactly as the run picks them:
   * the selected one, every enabled profile, or the chosen group's enabled
   * members. What the "Generate All" count and the quote both read, so neither
   * counts a profile the run would skip.
   */
  const manualRunProfiles = useMemo<Profile[]>(() => {
    if (generateMode === 'single') return profiles.filter((profile) => profile.id === selectedProfileId);
    if (multipleTarget === 'all') return profiles;
    const group = groups.find((entry) => entry.id === selectedGroupId);
    return group ? profiles.filter((profile) => group.profileIds.includes(profile.id)) : [];
  }, [generateMode, groups, multipleTarget, profiles, selectedGroupId, selectedProfileId]);

  /** The same for a sheet import's target. */
  const sheetsRunProfiles = useMemo<Profile[]>(() => {
    if (sheetsTargetMode === 'single') return profiles.filter((profile) => profile.id === selectedSheetsProfileId);
    if (sheetsTargetMode === 'all') return profiles;
    const group = groups.find((entry) => entry.id === selectedSheetsGroupId);
    return group ? profiles.filter((profile) => group.profileIds.includes(profile.id)) : [];
  }, [groups, profiles, selectedSheetsGroupId, selectedSheetsProfileId, sheetsTargetMode]);

  // The ready set as a string, so editing a preview's JSON or resetting the
  // form - each a new array - does not re-ask for the same price.
  const readyPreviewIds = useMemo(() => readyPreviewKey(multiplePreviews), [multiplePreviews]);
  const hasPreviews = multiplePreviews.length > 0;
  /**
   * What to price: the run the page is set up for, as the request that would
   * start it. Finalising multiple previews builds only the profiles that have
   * preview content, so those are what it prices.
   */
  const quoteRequest = useMemo(() => {
    let target: Profile[] = [];
    if (builderMode === 'sheets') {
      target = sheetsRunProfiles;
    } else if (builderMode === 'manual') {
      target = manualRunProfiles;
      if (generateMode === 'multiple' && !autoGenerate && hasPreviews) {
        const ready = new Set(readyPreviewIds.split(','));
        target = target.filter((profile) => ready.has(profile.id));
      }
    }
    if (target.length === 0) return null;
    const profileIds = target.map((profile) => profile.id);
    const body: SubmitBatchRequest = {
      ...(aiOverrides.modelId ? { model: aiOverrides.modelId } : {}),
      profileIds,
      jobs: QUOTE_JOBS,
    };
    return { key: `${profileIds.join(',')}|${aiOverrides.modelId ?? ''}|${runRevision}`, body };
  }, [
    aiOverrides.modelId,
    autoGenerate,
    builderMode,
    generateMode,
    hasPreviews,
    manualRunProfiles,
    readyPreviewIds,
    runRevision,
    sheetsRunProfiles,
  ]);

  useEffect(() => {
    if (!quoteRequest) return;
    let cancelled = false;
    // No line rather than a wrong one: a quote that fails (a model that is no
    // longer on offer, a server from before quotes) leaves the run to say so.
    generationApi.quote(quoteRequest.body).then(
      (quote) => {
        if (!cancelled) setQuoteResult({ key: quoteRequest.key, quote });
      },
      () => {
        if (!cancelled) setQuoteResult({ key: quoteRequest.key, quote: null });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [quoteRequest]);

  const quote = quoteRequest && quoteResult?.key === quoteRequest.key ? quoteResult.quote : null;

  // The top bar's balance, after a run. Not on mount: the shell has just read it.
  useEffect(() => {
    if (runRevision === 0) return;
    void refreshAccount();
  }, [refreshAccount, runRevision]);

  /**
   * A failed run, as the page reports it. A 402 is the one failure with a
   * remedy the person can take themselves, so it gets the numbers and a way to
   * buy credits rather than a bare sentence.
   */
  const reportRunFailure = (err: unknown, fallback: string) => {
    if (isInsufficientCredits(err)) {
      const needed = err.number('needed');
      const balance = err.number('balance');
      setShortfall({
        message:
          needed !== undefined && balance !== undefined
            ? `This run needs ${plural(needed, 'credit')}, and your balance is ${balance}.`
            : userMessage(err),
      });
      return;
    }
    setError(err ?? fallback);
  };

  const hasImportableSheet = sheetImportSources.length > 0;
  /** Why there is nothing to import from, in the words that fit the reason. */
  const sheetImportNotice =
    accountSheet && !accountSheet.configured
      ? accountSheet.message ?? 'Google Sheets is not set up on this server yet.'
      : 'Your job sheet is not ready yet. Open Settings > Job Sheet and try again.';
  const selectedSheetsProfileName = sheetsTargetMode === 'single'
    ? profiles.find((profile) => profile.id === selectedSheetsProfileId)?.name ?? ''
    : '';

  // Keep a sheet selected: the account's own unless the administrator has
  // deliberately chosen a saved source that is still in the list.
  useEffect(() => {
    setSelectedSheetsSourceId((current) =>
      current && sheetImportSources.some((source) => source.id === current)
        ? current
        : sheetImportSources[0]?.id ?? ''
    );
  }, [sheetImportSources]);

  useEffect(() => {
    if (hasImportableSheet || !isSheetsImportOpen) return;
    setIsSheetsImportOpen(false);
  }, [hasImportableSheet, isSheetsImportOpen]);

  /**
   * Picks a running batch back up after a reload.
   *
   * The work belongs to the server's queue, so closing this page never stopped
   * it - but until this, reopening the page showed nothing and the resumes
   * appeared on disk with no explanation. Tried in two ways because each covers
   * what the other cannot: the remembered id survives a reload of THIS browser,
   * and asking the server covers a different browser, cleared storage, or a
   * second tab.
   */
  useEffect(() => {
    let cancelled = false;

    const reattach = async () => {
      const remembered = rememberedBatch();
      let batchId: string | null = null;

      if (remembered) {
        const snapshot = await generationApi.snapshot(remembered).catch(() => null);
        // Gone means the server restarted or the batch aged out. Forget it
        // rather than asking again for ever.
        if (!snapshot) forgetBatch();
        else if (snapshot.state === 'running') batchId = remembered;
        else forgetBatch();
      }

      if (!batchId) {
        const active = await generationApi.listActive().catch(() => ({ batches: [] }));
        batchId = active.batches[0]?.batchId ?? null;
      }

      if (!batchId || cancelled) return;
      setIsGenerating(true);
      const snapshot = await followBatch(batchId, { phase: 'Building resumes' });
      if (cancelled) return;
      setIsGenerating(false);
      setGenerationStep('');
      clearGenerationProgress();
      // Its failed resumes were refunded as it ran.
      afterRun();
      if (snapshot) {
        setSuccessMessage(
          `Finished ${snapshot.completed} of ${snapshot.total} resume(s) from a run started earlier.`
        );
      }
    };

    void reattach();
    return () => {
      cancelled = true;
    };
    // Deliberately once, on mount. Re-running this on every render would attach
    // a second reader to the same stream.
  }, []);

  const getSelectedProfilesForSheetsBuilder = () => {
    if (sheetsTargetMode === 'single') {
      if (!selectedSheetsProfileId) {
        throw new Error('Please select a profile before importing from Sheets.');
      }
      const profile = profiles.find((item) => item.id === selectedSheetsProfileId);
      if (!profile) {
        throw new Error('Selected profile could not be found.');
      }
      return [profile];
    }

    if (sheetsTargetMode === 'all') {
      if (!profiles.length) {
        throw new Error('No profiles available for multi-profile generation.');
      }
      return profiles;
    }

    const selectedGroup = groups.find((group) => group.id === selectedSheetsGroupId);
    if (!selectedGroup) {
      throw new Error('Please select a group before importing from Sheets.');
    }

    const selectedProfiles = profiles.filter((profile) => selectedGroup.profileIds.includes(profile.id));
    if (!selectedProfiles.length) {
      throw new Error('Selected group has no enabled profiles.');
    }

    return selectedProfiles;
  };

  const aggregateUnconfirmedFromPreviews = (previews: MultiplePreview[]) => {
    const hardMap = new Map<string, string>();
    const softMap = new Map<string, string>();
    for (const preview of previews) {
      const content = preview.tailoredContent;
      for (const skill of content?.unconfirmedHardSkills ?? []) {
        const key = skill.trim().toLowerCase();
        if (key && !hardMap.has(key)) hardMap.set(key, skill.trim());
      }
      for (const skill of content?.unconfirmedSoftSkills ?? []) {
        const key = skill.trim().toLowerCase();
        if (key && !softMap.has(key)) softMap.set(key, skill.trim());
      }
    }
    return {
      hard: toUnconfirmedItems(Array.from(hardMap.values())),
      soft: toUnconfirmedItems(Array.from(softMap.values())),
    };
  };

  const clearGenerationProgress = () => {
    setGenerationProgress(null);
  };

  /**
   * After anything that spends or returns credits: the top bar's balance, and
   * the cost line's, are re-read rather than left at what they said before.
   * Only the counter moves here; the re-reads hang off it.
   */
  const afterRun = () => {
    setRunRevision((revision) => revision + 1);
  };

  const updateGenerationProgress = (
    total: number,
    completed: number,
    phase: string,
    currentProfileName?: string,
    currentCompanyName?: string,
    currentJobTitle?: string,
    currentJobNumber?: number,
    importedJobCount?: number
  ) => {
    setGenerationProgress({
      total,
      completed,
      phase,
      currentProfileName,
      currentCompanyName,
      currentJobTitle,
      currentJobNumber,
      importedJobCount,
    });
  };

  const getSelectedProfilesForManualBuilder = (): Profile[] => {
    if (multipleTarget === 'all') {
      return profiles;
    }

    const selectedGroup = groups.find((group) => group.id === selectedGroupId);
    if (!selectedGroup) {
      throw new Error('Please select a group');
    }

    const selectedProfiles = profiles.filter((profile) => selectedGroup.profileIds.includes(profile.id));
    if (!selectedProfiles.length) {
      throw new Error('Selected group has no enabled profiles.');
    }

    return selectedProfiles;
  };

  /**
   * Runs a batch on the server and follows it to the end.
   *
   * One request carrying every resume, rather than one request per resume. That
   * is the whole difference: the backend puts the tasks in a queue and hands
   * them out as a seat's slots come free, so a seat that can build several
   * resumes at once does. The loop this replaced awaited each resume in turn, so
   * however many builds a seat could run, all but one of its slots sat idle.
   *
   * Progress comes back down the stream. Every line is a COMPLETE snapshot, so
   * this can replace its state each time instead of applying deltas in order -
   * which is also what makes it safe to reattach to a batch already in flight.
   */
  const runBatch = async (
    request: SubmitBatchRequest,
    describe: { phase: string; jobCount?: number }
  ): Promise<BatchSnapshot | null> => {
    const submitted = await generationApi.submit(request);
    rememberBatch(submitted.batchId);
    return followBatch(submitted.batchId, describe);
  };

  /**
   * Watches a batch until it ends, driving the progress bar from its snapshots.
   *
   * Separate from submitting, because this is also how the page picks a batch
   * back up after a reload - the work did not stop, so neither should the view
   * of it.
   */
  const followBatch = async (
    batchId: string,
    describe: { phase: string; jobCount?: number }
  ): Promise<BatchSnapshot | null> => {
    let last: BatchSnapshot | null = null;

    const show = (snapshot: BatchSnapshot) => {
      last = snapshot;
      const finished = snapshot.completed + snapshot.failed + snapshot.cancelled;
      // Named from the OLDEST running task rather than the newest, so the label
      // is steady instead of flickering between however many run at once.
      const current = snapshot.tasks.find((task) => task.state === 'running');
      /*
       * Retries, said out loud.
       *
       * A build that failed goes back on the queue for another go, which moves
       * the running and queued counts BACKWARDS while `done` stands still. With
       * nothing naming it, that reads as the run going wrong or hanging - so the
       * count of tasks on a second-or-later attempt is reported, with the
       * server's own ceiling rather than a number hard-coded here.
       */
      const retrying = snapshot.tasks.filter(
        (task) => (task.attempts ?? 1) > 1 && (task.state === 'queued' || task.state === 'running')
      ).length;
      const retryNote = retrying
        ? `, ${retrying} retrying${snapshot.maxAttempts ? ` (up to ${snapshot.maxAttempts} tries each)` : ''}`
        : '';
      setGenerationStep(
        snapshot.running > 0
          ? `${describe.phase} - ${snapshot.running} running, ${finished}/${snapshot.total} done${retryNote}`
          : `${describe.phase} - ${finished}/${snapshot.total} done${retryNote}`
      );
      setGenerationProgress({
        total: snapshot.total,
        completed: finished,
        running: snapshot.running,
        queued: snapshot.queued,
        phase: snapshot.running > 0 ? 'Building resumes' : describe.phase,
        currentProfileName: current?.profileName,
        currentCompanyName: current?.companyName,
        currentJobTitle: current?.role,
        ...(describe.jobCount !== undefined ? { importedJobCount: describe.jobCount } : {}),
      });
    };

    /**
     * Reattaches until the BATCH says it is finished, not until the stream ends.
     *
     * A stream can end without the work being over: a proxy or a laptop lid
     * closes an idle connection, and `follow` then resolves perfectly normally.
     * Treating that as the end reported "Finished 4 of 30" while the server
     * carried on building the other twenty-six - the page describing its own
     * connection rather than the run.
     *
     * Every line is a complete snapshot, so rejoining costs nothing and needs no
     * reconciliation. Bounded by attaches that brought NOTHING, in a row
     * (lib/batchFollow): every attach that connects opens with a snapshot, so a
     * long batch behind a proxy that cuts it every minute follows to the end,
     * while a server refusing the stream outright stops it after twenty. A 404
     * - restarted or expired - stops it at once: asking again cannot help.
     */
    let idleInARow = 0;
    for (;;) {
      let delivered = 0;
      try {
        await generationApi.follow(batchId, (snapshot) => {
          delivered += 1;
          show(snapshot);
        });
      } catch {
        // A dropped stream is not a failed batch - the work is the server's.
        // Fall through to the snapshot below, which is the authority.
      }

      let gone = false;
      try {
        last = await generationApi.snapshot(batchId);
      } catch (error) {
        // Anything but a 404 (offline, a restart in progress) keeps the last
        // snapshot and tries again.
        gone = error instanceof ApiResponseError && error.status === 404;
      }
      if (!last || last.state !== 'running') break;

      const next = nextAttach(idleInARow, { delivered, gone });
      if (next.stop) break;
      idleInARow = next.idleInARow;
      // A short pause, so a server that is refusing the stream outright does
      // not turn this into a tight loop.
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    forgetBatch();
    return last;
  };

  /** Turns a finished batch into the shape the page reports after a generation. */
  const summarizeBatch = (snapshot: BatchSnapshot | null, fallbackCompany: string) => {
    const failures: GenerationFailure[] = (snapshot?.failures ?? []).map((failure) => ({
      profileId: failure.profileId,
      profileName: failure.profileName,
      companyName: failure.companyName || fallbackCompany,
      error: failure.error,
    }));
    return {
      generated: snapshot?.completed ?? 0,
      failed: failures.length,
      failures,
      failedCompanies: snapshot?.failedCompanies ?? [],
      unconfirmedHardSkills: snapshot?.unconfirmedHardSkills ?? [],
      unconfirmedSoftSkills: snapshot?.unconfirmedSoftSkills ?? [],
    };
  };

  const generateSequentialResumes = async ({
    targetProfiles,
    analysis,
    targetCompanyName,
    resolvedRole,
    tailoredContentByProfileId,
    previewTokenByProfileId,
  }: {
    targetProfiles: Profile[];
    analysis: JobAnalysis;
    targetCompanyName: string;
    resolvedRole: string;
    tailoredContentByProfileId?: Map<string, TailoredContent | undefined>;
    previewTokenByProfileId?: Map<string, string | undefined>;
  }) => {
    updateGenerationProgress(
      targetProfiles.length,
      0,
      'Queueing resumes',
      undefined,
      targetCompanyName
    );

    const tailoredByProfileId: Record<string, unknown> = {};
    const tokensByProfileId: Record<string, string> = {};
    for (const profile of targetProfiles) {
      const tailored = tailoredContentByProfileId?.get(profile.id);
      if (tailored) tailoredByProfileId[profile.id] = tailored;
      const token = previewTokenByProfileId?.get(profile.id);
      if (tailored && token) tokensByProfileId[profile.id] = token;
    }

    const snapshot = await runBatch(
      {
        ...aiRequestOverrides,
        label: `${targetCompanyName}`,
        profileIds: targetProfiles.map((profile) => profile.id),
        jobs: [
          {
            companyName: targetCompanyName,
            role: resolvedRole,
            jobDescription,
            jobAnalysis: analysis,
          },
        ],
        ...(Object.keys(tailoredByProfileId).length > 0
          ? { tailoredContentByProfileId: tailoredByProfileId }
          : {}),
        ...(Object.keys(tokensByProfileId).length > 0 ? { previewTokenByProfileId: tokensByProfileId } : {}),
        ...getDefaultGenerationOptions(),
      },
      { phase: 'Building resumes' }
    );

    return summarizeBatch(snapshot, targetCompanyName);
  };

  /**
   * A sheet import is placed as an ORDER, not waited for.
   *
   * It used to hold the page open until the last resume was rendered - which on
   * three hundred rows is an hour of a browser tab that cannot be closed, and a
   * reload part way through left the files on the server with nothing offering
   * them. Now the server records what was asked for, answers with an order
   * number, and the Orders page collects the files as they land.
   */
  const handleImportJobsFromSheets = async (
    importedJobs: ImportedSheetJob[],
    meta: { skippedRows: number }
  ) => {
    const selectedProfiles = getSelectedProfilesForSheetsBuilder();
    const fallbackRole = shouldShowRoleInput ? role.trim() : '';
    const normalizedJobs = importedJobs.map((job) => ({
      ...job,
      jobTitle: job.jobTitle.trim() || fallbackRole,
    }));

    setIsGenerating(true);
    setError('');
    setShortfall(null);
    setSuccessMessage('');
    setPlacedOrder(null);
    resetGenerationOutputs();

    try {
      /**
       * ONE request carrying every resume, not one request per resume.
       *
       * This was a nested loop - for each job, analyse it, then for each profile
       * await a generate - so thirty sheet rows were thirty analyses and thirty
       * builds, strictly one at a time. However many builds the seats could run
       * at once, all but one slot sat idle for the whole run.
       *
       * Now the server queues the lot and hands them out as slots come free,
       * and the analysis happens inside the task, shared between the profiles
       * that need the same job.
       */
      const submitted = await generationApi.submit({
        ...aiRequestOverrides,
        asOrder: true,
        label: `Sheets import (${normalizedJobs.length} job${normalizedJobs.length === 1 ? '' : 's'})`,
        profileIds: selectedProfiles.map((profile) => profile.id),
        jobs: normalizedJobs.map((job) => ({
          companyName: job.companyName.trim(),
          role: job.jobTitle.trim(),
          jobDescription: job.jobDescription.trim(),
          sourceRowNumber: job.sourceRowNumber,
        })),
        ...getDefaultGenerationOptions(),
      });

      const skippedNote = meta.skippedRows
        ? ` Skipped ${meta.skippedRows} imported row(s) with missing required values.`
        : '';

      if (submitted.orderId && submitted.orderNumber) {
        setPlacedOrder({
          id: submitted.orderId,
          number: submitted.orderNumber,
          total: submitted.total,
          jobCount: submitted.jobCount,
          profileCount: submitted.profileCount,
          skippedNote,
        });
      } else {
        // An older server that does not place orders. The work is queued either
        // way, so say so rather than leaving the click looking like it failed.
        setSuccessMessage(
          `Queued ${submitted.total} build(s) from ${submitted.jobCount} imported job(s).${skippedNote}`
        );
      }
    } catch (err) {
      reportRunFailure(err, 'Could not place that order.');
    } finally {
      setIsGenerating(false);
      setGenerationStep('');
      clearGenerationProgress();
      afterRun();
    }
  };

  const handleGenerate = async () => {
    if (!companyName.trim()) {
      setError('Please enter a company name');
      return;
    }
    if (shouldShowRoleInput && !role.trim()) {
      setError('Please enter a role');
      return;
    }
    if (jobDescription.trim().length < 50) {
      setError('Please provide a job description (minimum 50 characters)');
      return;
    }
    if (generateMode === 'single' && !selectedProfileId) {
      setError('Please select a profile');
      return;
    }
    if (generateMode === 'multiple' && profiles.length === 0) {
      setError('No profiles available');
      return;
    }
    if (generateMode === 'multiple' && multipleTarget === 'group') {
      const selectedGroup = groups.find((group) => group.id === selectedGroupId);
      if (!selectedGroup) {
        setError('Please select a group');
        return;
      }
      if (!selectedGroup.profileIds.length) {
        setError('Selected group has no members');
        return;
      }
    }

    setIsGenerating(true);
    setError('');
    setShortfall(null);
    setSuccessMessage('');
    setPreviewHtml('');
    setPreviewTailored(false);
    setIsSinglePreviewOpen(false);
    resetTailoredEditor();
    setJobAnalysis(null);
    setMultiplePreviews([]);
    setMultiplePreviewTailored(false);
    setMultiplePreviewIndex(0);

    try {
      setGenerationStep('Analyzing job description...');
      clearGenerationProgress();
      const analysis = await resumeApi.analyze(jobDescription, aiRequestOverrides);
      setJobAnalysis(analysis);

      if (generateMode === 'single' && !autoGenerate) {
        setGenerationStep('Building preview...');
        const profile = profiles.find((p) => p.id === selectedProfileId);
        const templateId = profile?.preferredTemplate || 'default';
        const preview = await resumeApi.preview({
          ...aiRequestOverrides,
          profileId: selectedProfileId!,
          templateId,
          jobDescription,
          jobAnalysis: analysis,
        });
        setPreviewHtml(preview.html);
        setPreviewTailored(preview.tailored);
        setIsSinglePreviewOpen(true);
        setPreviewToken(preview.previewToken ?? null);
        if (preview.tailoredContent) {
          setTailoredContent(preview.tailoredContent);
          setTailoredContentDraft(JSON.stringify(preview.tailoredContent, null, 2));
          setTailoredContentError('');
          setUnconfirmedHardSkills(toUnconfirmedItems(preview.tailoredContent.unconfirmedHardSkills));
          setUnconfirmedSoftSkills(toUnconfirmedItems(preview.tailoredContent.unconfirmedSoftSkills));
        }
        setSuccessMessage('Preview generated. Review, edit manually if needed, then click Generate Resume to finalize.');
        return;
      }

      if (generateMode === 'multiple' && !autoGenerate) {
        const profileIds =
          multipleTarget === 'group'
            ? groups.find((group) => group.id === selectedGroupId)?.profileIds
            : undefined;
        if (multipleTarget === 'group' && !profileIds) {
          setError('Please select a group');
          return;
        }

        setGenerationStep('Building previews...');
        // The model the run names, as the finalise and its quote will:
        // previewing on each profile's own while charging the menu's was
        // the mismatch this used to have.
        const res = await resumeApi.previewAll({
          ...aiRequestOverrides,
          jobDescription,
          jobAnalysis: analysis,
          profileIds,
        });
        const previewsWithDrafts = res.previews.map((preview) => ({
          ...preview,
          draft: preview.tailoredContent
            ? JSON.stringify(preview.tailoredContent, null, 2)
            : '',
          error: '',
        }));
        setMultiplePreviews(previewsWithDrafts);
        setMultiplePreviewTailored(res.tailored);
        setMultiplePreviewIndex(0);
        const aggregated = aggregateUnconfirmedFromPreviews(previewsWithDrafts);
        setUnconfirmedHardSkills(aggregated.hard);
        setUnconfirmedSoftSkills(aggregated.soft);
        setSuccessMessage(`Preview generated for ${res.previews.length} profile(s). Review, then click Generate All to finalize.`);
        return;
      }

      if (generateMode === 'single') {
        const profile = profiles.find((p) => p.id === selectedProfileId);
        const templateId = profile?.preferredTemplate || 'default';
        updateGenerationProgress(1, 0, 'Building resume', profile?.name, companyName.trim());
        setGenerationStep(`Generating 1/1: ${profile?.name ?? 'Selected profile'} x ${companyName.trim()}`);
        const result = await resumeApi.generate({
          ...aiRequestOverrides,
          profileId: selectedProfileId!,
          templateId,
          jobDescription,
          jobAnalysis: analysis,
          companyName: companyName.trim(),
          role: shouldShowRoleInput ? role.trim() : (getAnalysisJobTitle(analysis) || ''),
          ...getDefaultGenerationOptions(),
        });
        updateGenerationProgress(1, 1, 'Building resume', profile?.name, companyName.trim());
        setSuccessMessage('Resume generated successfully.');
        setIsSinglePreviewOpen(false);
        setUnconfirmedHardSkills(toUnconfirmedItems(result.unconfirmedHardSkills));
        setUnconfirmedSoftSkills(toUnconfirmedItems(result.unconfirmedSoftSkills));
      } else {
        const targetProfiles = getSelectedProfilesForManualBuilder();
        const res = await generateSequentialResumes({
          targetProfiles,
          analysis,
          targetCompanyName: companyName.trim(),
          resolvedRole: shouldShowRoleInput ? role.trim() : (getAnalysisJobTitle(analysis) || ''),
        });
        if (multipleTarget === 'group') {
          const selectedGroup = groups.find((group) => group.id === selectedGroupId)!;
          setSuccessMessage(`Generated ${res.generated} resume(s) for group "${selectedGroup.name}".`);
        } else {
          setSuccessMessage(`Generated ${res.generated} resume(s) successfully.`);
        }
        if (res.failed > 0) {
          setError(
            `Skipped ${res.failed} build(s). Failed companies: ${formatCompanySummary(res.failedCompanies) || companyName.trim()}. ${res.failures.slice(0, 3).map((failure) => `${failure.profileName}: ${failure.error}`).join(' | ')}${res.failures.length > 3 ? ' | ...' : ''}`
          );
        }
        setUnconfirmedHardSkills(toUnconfirmedItems(res.unconfirmedHardSkills));
        setUnconfirmedSoftSkills(toUnconfirmedItems(res.unconfirmedSoftSkills));
      }
    } catch (err) {
      reportRunFailure(err, 'Failed to generate resume');
    } finally {
      setIsGenerating(false);
      setGenerationStep('');
      clearGenerationProgress();
      afterRun();
    }
  };

  const handleTailoredContentChange = (value: string) => {
    setTailoredContentDraft(value);
    if (!value.trim()) {
      setTailoredContent(null);
      setTailoredContentError('');
      return;
    }
    try {
      const parsed = JSON.parse(value) as TailoredContent;
      setTailoredContent(parsed);
      setTailoredContentError('');
    } catch {
      setTailoredContentError('Invalid JSON. Fix errors before generating.');
    }
  };

  const handleUnconfirmedSkillEdit = (
    type: 'hard' | 'soft',
    original: string,
    value: string
  ) => {
    const update = (items: UnconfirmedSkill[]) =>
      items.map((item) => (item.original === original ? { ...item, value } : item));
    if (type === 'hard') {
      setUnconfirmedHardSkills(update);
    } else {
      setUnconfirmedSoftSkills(update);
    }
  };

  const handleRemoveUnconfirmedSkill = (type: 'hard' | 'soft', skill: UnconfirmedSkill) => {
    const remove = (items: UnconfirmedSkill[]) =>
      items.filter((item) => item.original !== skill.original);
    if (type === 'hard') {
      setUnconfirmedHardSkills(remove);
    } else {
      setUnconfirmedSoftSkills(remove);
    }

    if (tailoredContent) {
      const normalizedOriginal = skill.original.trim().toLowerCase();
      const nextTailored: TailoredContent = {
        ...tailoredContent,
        unconfirmedHardSkills:
          type === 'hard'
            ? (tailoredContent.unconfirmedHardSkills ?? []).filter(
                (item) => item.trim().toLowerCase() !== normalizedOriginal
              )
            : tailoredContent.unconfirmedHardSkills,
        unconfirmedSoftSkills:
          type === 'soft'
            ? (tailoredContent.unconfirmedSoftSkills ?? []).filter(
                (item) => item.trim().toLowerCase() !== normalizedOriginal
              )
            : tailoredContent.unconfirmedSoftSkills,
      };
      setTailoredContent(nextTailored);
      const currentDraft = tailoredContentDraft.trim();
      if (currentDraft && currentDraft === JSON.stringify(tailoredContent, null, 2)) {
        setTailoredContentDraft(JSON.stringify(nextTailored, null, 2));
      }
    } else if (multiplePreviews.length > 0) {
      const normalizedOriginal = skill.original.trim().toLowerCase();
      const nextPreviews = multiplePreviews.map((item) => {
        if (!item.tailoredContent) return item;
        const nextTailored: TailoredContent = {
          ...item.tailoredContent,
          unconfirmedHardSkills:
            type === 'hard'
              ? (item.tailoredContent.unconfirmedHardSkills ?? []).filter(
                  (value) => value.trim().toLowerCase() !== normalizedOriginal
                )
              : item.tailoredContent.unconfirmedHardSkills,
          unconfirmedSoftSkills:
            type === 'soft'
              ? (item.tailoredContent.unconfirmedSoftSkills ?? []).filter(
                  (value) => value.trim().toLowerCase() !== normalizedOriginal
                )
              : item.tailoredContent.unconfirmedSoftSkills,
        };
        return {
          ...item,
          tailoredContent: nextTailored,
          draft: JSON.stringify(nextTailored, null, 2),
        };
      });
      setMultiplePreviews(nextPreviews);
      const aggregated = aggregateUnconfirmedFromPreviews(nextPreviews);
      setUnconfirmedHardSkills(aggregated.hard);
      setUnconfirmedSoftSkills(aggregated.soft);
    }
  };

  const handleConfirmSkill = async (type: 'hard' | 'soft', skill: UnconfirmedSkill) => {
    const cleaned = skill.value.trim();
    if (!cleaned) {
      setError('Skill cannot be empty');
      return;
    }

    try {
      setIsGenerating(true);
      setError('');
      await resumeApi.confirmSkill({ type, skill: cleaned });

      const remove = (items: UnconfirmedSkill[]) =>
        items.filter((item) => item.original !== skill.original);

      if (type === 'hard') {
        setUnconfirmedHardSkills(remove);
      } else {
        setUnconfirmedSoftSkills(remove);
      }

      if (tailoredContent) {
        const normalizedOriginal = skill.original.trim().toLowerCase();
        const currentHard = tailoredContent.hardSkills ?? [];
        const currentSoft = tailoredContent.softSkills ?? [];
        const nextHard =
          type === 'hard'
            ? Array.from(
                new Set([
                  ...currentHard,
                  cleaned,
                ].map((item) => item.trim()).filter(Boolean))
              )
            : currentHard;
        const nextSoft =
          type === 'soft'
            ? Array.from(
                new Set([
                  ...currentSoft,
                  cleaned,
                ].map((item) => item.trim()).filter(Boolean))
              )
            : currentSoft;

        const nextTailored: TailoredContent = {
          ...tailoredContent,
          hardSkills: nextHard,
          softSkills: nextSoft,
          unconfirmedHardSkills:
            type === 'hard'
              ? (tailoredContent.unconfirmedHardSkills ?? []).filter(
                  (item) => item.trim().toLowerCase() !== normalizedOriginal
                )
              : tailoredContent.unconfirmedHardSkills,
          unconfirmedSoftSkills:
            type === 'soft'
              ? (tailoredContent.unconfirmedSoftSkills ?? []).filter(
                  (item) => item.trim().toLowerCase() !== normalizedOriginal
                )
              : tailoredContent.unconfirmedSoftSkills,
        };
        setTailoredContent(nextTailored);
        const currentDraft = tailoredContentDraft.trim();
        if (currentDraft && currentDraft === JSON.stringify(tailoredContent, null, 2)) {
          setTailoredContentDraft(JSON.stringify(nextTailored, null, 2));
        }
        if (selectedProfileId) {
          const profile = profiles.find((p) => p.id === selectedProfileId);
          const templateId = profile?.preferredTemplate || 'default';
          const refreshed = await resumeApi.preview({
            ...aiRequestOverrides,
            profileId: selectedProfileId!,
            templateId,
            jobDescription,
            jobAnalysis: jobAnalysis || undefined,
            tailoredContent: nextTailored,
          });
          setPreviewHtml(refreshed.html);
          setPreviewTailored(refreshed.tailored);
          setIsSinglePreviewOpen(true);
        }
      }

      if (!tailoredContent && multiplePreviews.length > 0) {
        const normalizedOriginal = skill.original.trim().toLowerCase();
        const updatedProfiles: Array<{ profileId: string; nextTailored: TailoredContent }> = [];
        let nextPreviews = multiplePreviews.map((item) => {
          if (!item.tailoredContent) return item;
          const unconfirmedHard = item.tailoredContent.unconfirmedHardSkills ?? [];
          const unconfirmedSoft = item.tailoredContent.unconfirmedSoftSkills ?? [];
          const hasMatch =
            (type === 'hard' && unconfirmedHard.some((value) => value.trim().toLowerCase() === normalizedOriginal)) ||
            (type === 'soft' && unconfirmedSoft.some((value) => value.trim().toLowerCase() === normalizedOriginal));
          if (!hasMatch) return item;

          const currentHard = item.tailoredContent.hardSkills ?? [];
          const currentSoft = item.tailoredContent.softSkills ?? [];
          const nextHard =
            type === 'hard'
              ? Array.from(
                  new Set(
                    [...currentHard, cleaned].map((value) => value.trim()).filter(Boolean)
                  )
                )
              : currentHard;
          const nextSoft =
            type === 'soft'
              ? Array.from(
                  new Set(
                    [...currentSoft, cleaned].map((value) => value.trim()).filter(Boolean)
                  )
                )
              : currentSoft;

          const nextTailored: TailoredContent = {
            ...item.tailoredContent,
            hardSkills: nextHard,
            softSkills: nextSoft,
            unconfirmedHardSkills:
              type === 'hard'
                ? unconfirmedHard.filter(
                    (value) => value.trim().toLowerCase() !== normalizedOriginal
                  )
                : unconfirmedHard,
            unconfirmedSoftSkills:
              type === 'soft'
                ? unconfirmedSoft.filter(
                    (value) => value.trim().toLowerCase() !== normalizedOriginal
                  )
                : unconfirmedSoft,
          };

          updatedProfiles.push({ profileId: item.profileId, nextTailored });

          return {
            ...item,
            tailoredContent: nextTailored,
            draft: JSON.stringify(nextTailored, null, 2),
            error: item.error,
          };
        });

        if (updatedProfiles.length > 0) {
          const refreshedList = await Promise.all(
            updatedProfiles.map(async ({ profileId, nextTailored }) => {
              const profile = profiles.find((p) => p.id === profileId);
              const templateId = profile?.preferredTemplate || 'default';
              const refreshed = await resumeApi.preview({
                ...aiRequestOverrides,
                profileId,
                templateId,
                jobDescription,
                jobAnalysis: jobAnalysis || undefined,
                tailoredContent: nextTailored,
              });
              return {
                profileId,
                html: refreshed.html,
                tailored: refreshed.tailored,
                tailoredContent: refreshed.tailoredContent ?? nextTailored,
              };
            })
          );
          if (refreshedList.some((item) => item.tailored)) {
            setMultiplePreviewTailored(true);
          }
          const refreshedMap = new Map(refreshedList.map((item) => [item.profileId, item]));
          nextPreviews = nextPreviews.map((item) => {
            const refreshed = refreshedMap.get(item.profileId);
            if (!refreshed) return item;
            return {
              ...item,
              html: refreshed.html,
              tailoredContent: refreshed.tailoredContent,
              draft: JSON.stringify(refreshed.tailoredContent, null, 2),
            };
          });
        }

        setMultiplePreviews(nextPreviews);
        const aggregated = aggregateUnconfirmedFromPreviews(nextPreviews);
        setUnconfirmedHardSkills(aggregated.hard);
        setUnconfirmedSoftSkills(aggregated.soft);
      }
      setSuccessMessage(`Added "${cleaned}" to ${type === 'hard' ? 'tech' : 'soft'} skills.`);
    } catch (err) {
      setError(err ?? 'Failed to confirm skill.');
    } finally {
      setIsGenerating(false);
      setGenerationStep('');
    }
  };

  const handleUpdatePreview = async () => {
    if (!selectedProfileId) {
      setError('Please select a profile');
      return;
    }
    if (tailoredContentError) {
      setError('Fix manual edits before updating preview.');
      return;
    }
    if (!tailoredContent) {
      setError('No tailored content to preview.');
      return;
    }

    setIsGenerating(true);
    setError('');
    setSuccessMessage('');

    try {
      setGenerationStep('Updating preview...');
      const profile = profiles.find((p) => p.id === selectedProfileId);
      const templateId = profile?.preferredTemplate || 'default';
      const preview = await resumeApi.preview({
        ...aiRequestOverrides,
        profileId: selectedProfileId!,
        templateId,
        jobDescription,
        jobAnalysis: jobAnalysis || undefined,
        tailoredContent,
      });
      setPreviewHtml(preview.html);
      setPreviewTailored(preview.tailored);
      setIsSinglePreviewOpen(true);
      setUnconfirmedHardSkills(toUnconfirmedItems(preview.tailoredContent?.unconfirmedHardSkills));
      setUnconfirmedSoftSkills(toUnconfirmedItems(preview.tailoredContent?.unconfirmedSoftSkills));
      setSuccessMessage('Preview updated.');
    } catch (err) {
      setError(err ?? 'Failed to update preview.');
    } finally {
      setIsGenerating(false);
      setGenerationStep('');
    }
  };

  const handleFinalizeGenerate = async () => {
    if (!companyName.trim() || (shouldShowRoleInput && !role.trim()) || jobDescription.trim().length < 50 || !selectedProfileId) {
      setError('Please complete the required fields before generating.');
      return;
    }
    if (tailoredContentError) {
      setError('Fix manual edits before generating.');
      return;
    }

    setIsGenerating(true);
    setError('');
    setShortfall(null);
    setSuccessMessage('');

    try {
      const analysis = jobAnalysis || (await resumeApi.analyze(jobDescription, aiRequestOverrides));
      if (!jobAnalysis) {
        setJobAnalysis(analysis);
      }
      const profile = profiles.find((p) => p.id === selectedProfileId);
      const templateId = profile?.preferredTemplate || 'default';
      updateGenerationProgress(1, 0, 'Building resume', profile?.name, companyName.trim());
      setGenerationStep(`Generating 1/1: ${profile?.name ?? 'Selected profile'} x ${companyName.trim()}`);
      const result = await resumeApi.generate({
        ...aiRequestOverrides,
        profileId: selectedProfileId!,
        templateId,
        jobDescription,
        jobAnalysis: analysis,
        tailoredContent: tailoredContent || undefined,
        ...(tailoredContent && previewToken ? { previewToken } : {}),
        companyName: companyName.trim(),
        role: shouldShowRoleInput ? role.trim() : (getAnalysisJobTitle(analysis) || ''),
        ...getDefaultGenerationOptions(),
      });
      updateGenerationProgress(1, 1, 'Building resume', profile?.name, companyName.trim());
      setSuccessMessage('Resume generated successfully.');
      setIsSinglePreviewOpen(false);
      setUnconfirmedHardSkills(toUnconfirmedItems(result.unconfirmedHardSkills));
      setUnconfirmedSoftSkills(toUnconfirmedItems(result.unconfirmedSoftSkills));
    } catch (err) {
      reportRunFailure(err, 'Failed to generate resume');
    } finally {
      setIsGenerating(false);
      setGenerationStep('');
      clearGenerationProgress();
      afterRun();
    }
  };

  const handleMultipleDraftChange = (profileId: string, value: string) => {
    setMultiplePreviews((prev) =>
      prev.map((preview) => {
        if (preview.profileId != profileId) return preview;
        let nextError = '';
        let nextTailored = preview.tailoredContent;
        if (!value.trim()) {
          nextTailored = undefined;
        } else {
          try {
            nextTailored = JSON.parse(value) as TailoredContent;
          } catch {
            nextError = 'Invalid JSON. Fix errors before updating preview.';
          }
        }
        return {
          ...preview,
          draft: value,
          error: nextError,
          tailoredContent: nextTailored,
        };
      })
    );
  };

  const handleUpdateMultiplePreview = async (profileId: string) => {
    const preview = multiplePreviews.find((item) => item.profileId === profileId);
    if (!preview) return;
    if (preview.error) {
      setError('Fix manual edits before updating preview.');
      return;
    }
    if (!preview.tailoredContent) {
      setError('No tailored content to preview.');
      return;
    }

    setIsGenerating(true);
    setError('');
    setSuccessMessage('');

    try {
      setGenerationStep(`Updating preview for ${preview.profileName}...`);
      const profile = profiles.find((p) => p.id === profileId);
      const templateId = profile?.preferredTemplate || 'default';
      const updated = await resumeApi.preview({
        ...aiRequestOverrides,
        profileId,
        templateId,
        jobDescription,
        jobAnalysis: jobAnalysis || undefined,
        tailoredContent: preview.tailoredContent,
      });
      const nextPreviews = multiplePreviews.map((item) => {
        if (item.profileId !== profileId) return item;
        const nextTailored = updated.tailoredContent;
        return {
          ...item,
          html: updated.html,
          tailoredContent: nextTailored,
          draft: nextTailored ? JSON.stringify(nextTailored, null, 2) : '',
          error: '',
        };
      });
      setMultiplePreviews(nextPreviews);
      const aggregated = aggregateUnconfirmedFromPreviews(nextPreviews);
      setUnconfirmedHardSkills(aggregated.hard);
      setUnconfirmedSoftSkills(aggregated.soft);
      setSuccessMessage(`Preview updated for ${preview.profileName}.`);
    } catch (err) {
      setError(err ?? 'Failed to update preview.');
    } finally {
      setIsGenerating(false);
      setGenerationStep('');
    }
  };

  const handleFinalizeGenerateMultiple = async () => {
    if (!companyName.trim() || (shouldShowRoleInput && !role.trim()) || jobDescription.trim().length < 50) {
      setError('Please complete the required fields before generating.');
      return;
    }

    if (multipleTarget === 'group') {
      const selectedGroup = groups.find((group) => group.id === selectedGroupId);
      if (!selectedGroup) {
        setError('Please select a group');
        return;
      }
      if (!selectedGroup.profileIds.length) {
        setError('Selected group has no members');
        return;
      }
    }

    setIsGenerating(true);
    setError('');
    setShortfall(null);
    setSuccessMessage('');

    try {
      const analysis = jobAnalysis || (await resumeApi.analyze(jobDescription, aiRequestOverrides));
      if (!jobAnalysis) {
        setJobAnalysis(analysis);
      }

      if (!autoGenerate && multiplePreviews.length > 0) {
        const previewMap = new Map(multiplePreviews.map((p) => [p.profileId, p]));
        const targetProfiles =
          multipleTarget === 'group'
            ? profiles.filter((p) => p.id &&
                groups.find((g) => g.id === selectedGroupId)?.profileIds.includes(p.id))
            : profiles;
        const profilesToGenerate = targetProfiles.filter((profile) => previewMap.get(profile.id)?.tailoredContent);
        if (!profilesToGenerate.length) {
          throw new Error('No preview content available to generate.');
        }

        /*
         * ONE batch for every previewed profile, not one /generate each.
         *
         * The loop charged each resume as its own request, so a balance that
         * ran out part way built and charged the first few, reported one
         * resume's price as what "this run" needed, and left those first few
         * in the list for a retry to build - and charge - again. As a batch
         * the whole run is reserved at once, priced as the quote line says, and
         * a 402 names that total before anything is built.
         */
        const res = await generateSequentialResumes({
          targetProfiles: profilesToGenerate,
          analysis,
          targetCompanyName: companyName.trim(),
          resolvedRole: shouldShowRoleInput ? role.trim() : (getAnalysisJobTitle(analysis) || ''),
          tailoredContentByProfileId: new Map(
            profilesToGenerate.map((profile) => [profile.id, previewMap.get(profile.id)?.tailoredContent])
          ),
          previewTokenByProfileId: new Map(
            profilesToGenerate.map((profile) => [profile.id, previewMap.get(profile.id)?.previewToken])
          ),
        });
        setSuccessMessage(`Generated ${res.generated} resume(s) successfully.`);
        if (res.failed > 0) {
          setError(
            `Skipped ${res.failed} build(s). Failed companies: ${formatCompanySummary(res.failedCompanies) || companyName.trim()}. ${res.failures.slice(0, 3).map((failure) => `${failure.profileName}: ${failure.error}`).join(' | ')}${res.failures.length > 3 ? ' | ...' : ''}`
          );
        }
        // Only the previews that did NOT become a resume stay, so finalising
        // again builds - and charges for - just those.
        const remaining = keepUnbuiltPreviews(multiplePreviews, res.failures.map((failure) => failure.profileId));
        const aggregated = aggregateUnconfirmedFromPreviews(multiplePreviews);
        setUnconfirmedHardSkills(aggregated.hard);
        setUnconfirmedSoftSkills(aggregated.soft);
        setMultiplePreviews(remaining);
        setMultiplePreviewIndex(0);
        if (remaining.length === 0) setMultiplePreviewTailored(false);
        return;
      }

      const targetProfiles = getSelectedProfilesForManualBuilder();
      const res = await generateSequentialResumes({
        targetProfiles,
        analysis,
        targetCompanyName: companyName.trim(),
        resolvedRole: shouldShowRoleInput ? role.trim() : (getAnalysisJobTitle(analysis) || ''),
      });
      if (multipleTarget === 'group') {
        const selectedGroup = groups.find((group) => group.id === selectedGroupId)!;
        setSuccessMessage(`Generated ${res.generated} resume(s) for group "${selectedGroup.name}".`);
      } else {
        setSuccessMessage(`Generated ${res.generated} resume(s) successfully.`);
      }
      if (res.failed > 0) {
        setError(
          `Skipped ${res.failed} build(s). Failed companies: ${formatCompanySummary(res.failedCompanies) || companyName.trim()}. ${res.failures.slice(0, 3).map((failure) => `${failure.profileName}: ${failure.error}`).join(' | ')}${res.failures.length > 3 ? ' | ...' : ''}`
        );
      }
      setUnconfirmedHardSkills(toUnconfirmedItems(res.unconfirmedHardSkills));
      setUnconfirmedSoftSkills(toUnconfirmedItems(res.unconfirmedSoftSkills));
    } catch (err) {
      reportRunFailure(err, 'Failed to generate resume');
    } finally {
      setIsGenerating(false);
      setGenerationStep('');
      clearGenerationProgress();
      afterRun();
    }
  };

  const activeMultiplePreview = multiplePreviews[multiplePreviewIndex];

  const unconfirmedPanel = (
    <div className="tl-card">
      <div className="tl-card-header">
        <div className="text-sm font-semibold text-ink">Unregistered Skills</div>
      </div>
      <div className="space-y-5 p-4">
        {unconfirmedHardSkills.length === 0 && unconfirmedSoftSkills.length === 0 && (
          <div className="text-sm text-subtle">No unregistered skills found.</div>
        )}
        {unconfirmedHardSkills.length > 0 && (
          <div className="space-y-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-subtle">Tech Skills</div>
            <div className="grid gap-2 xl:grid-cols-2">
              {unconfirmedHardSkills.map((skill) => (
                <div key={`uh-${skill.original}`} className="flex min-w-0 items-center gap-2">
                  <input
                    type="text"
                    value={skill.value}
                    onChange={(e) =>
                      handleUnconfirmedSkillEdit('hard', skill.original, e.target.value)
                    }
                    disabled={isGenerating}
                    className={`tl-input ${styles.compact} min-w-0 flex-1`}
                  />
                  <button
                    type="button"
                    onClick={() => handleConfirmSkill('hard', skill)}
                    disabled={isGenerating}
                    className="tl-button-quiet"
                    data-size="sm"
                  >
                    Add
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRemoveUnconfirmedSkill('hard', skill)}
                    disabled={isGenerating}
                    className="tl-button-quiet"
                    data-size="sm"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
        {unconfirmedSoftSkills.length > 0 && (
          <div className="space-y-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-subtle">Soft Skills</div>
            <div className="grid gap-2 xl:grid-cols-2">
              {unconfirmedSoftSkills.map((skill) => (
                <div key={`us-${skill.original}`} className="flex min-w-0 items-center gap-2">
                  <input
                    type="text"
                    value={skill.value}
                    onChange={(e) =>
                      handleUnconfirmedSkillEdit('soft', skill.original, e.target.value)
                    }
                    disabled={isGenerating}
                    className={`tl-input ${styles.compact} min-w-0 flex-1`}
                  />
                  <button
                    type="button"
                    onClick={() => handleConfirmSkill('soft', skill)}
                    disabled={isGenerating}
                    className="tl-button-quiet"
                    data-size="sm"
                  >
                    Add
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRemoveUnconfirmedSkill('soft', skill)}
                    disabled={isGenerating}
                    className="tl-button-quiet"
                    data-size="sm"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );

  if (isLoadingData) {
    return (
      <div className="tl-fill flex items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <>
      {/* Main Content */}
      <Page>
        {/*
          The page's one primary action lives in the title row, where it always
          was in spirit - it sat above the fields, not under them. Which action
          that is depends on the way in: generate (or preview) when building by
          hand, open the import dialog when building from a sheet. Back, and
          Open Preview once a preview has been closed, are the quiet ones
          beside it, shaped to match.
        */}
        <PageHeader
          title="Build Resumes"
          description="Tailor a resume to a job description, for one profile, a group, or every row of a Google Sheet."
          actions={
            builderMode !== null && (
              <>
                {/* No shortfall here: the notice under the header carries it. */}
                <CostLine
                  quote={quote}
                  label={
                    builderMode === 'sheets'
                      ? 'Each sheet row'
                      : autoGenerate
                        ? 'This run'
                        : // The button previews, which is free; generating is what costs.
                          'Generating'
                  }
                />
                <button
                  type="button"
                  onClick={() => {
                    setBuilderMode(null);
                    setIsSheetsImportOpen(false);
                  }}
                  disabled={isGenerating}
                  className={`tl-button-quiet ${styles.pill}`}
                >
                  Back
                </button>
                {builderMode === 'manual' && generateMode === 'single' && previewHtml && !isSinglePreviewOpen && (
                  <button
                    type="button"
                    onClick={() => setIsSinglePreviewOpen(true)}
                    className={`tl-button-quiet ${styles.pill}`}
                  >
                    Open Preview
                  </button>
                )}
                {builderMode === 'manual' ? (
                  <button
                    onClick={handleGenerate}
                    disabled={isGenerating}
                    className={`tl-button ${styles.wrap}`}
                    data-shape="pill"
                  >
                    {isGenerating ? (
                      <>
                        <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"></span>
                        {generationStep || 'Generating...'}
                      </>
                    ) : (
                      generateMode === 'single'
                        ? autoGenerate
                          ? 'Generate Resume'
                          : 'Analyze & Preview'
                        : autoGenerate
                          ? `Generate All (${plural(manualRunProfiles.length, 'profile')})`
                          : 'Analyze & Preview'
                    )}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      if (!hasImportableSheet) {
                        setError(sheetImportNotice);
                        return;
                      }
                      setError('');
                      setIsSheetsImportOpen(true);
                    }}
                    disabled={isGenerating}
                    className={`tl-button ${styles.wrap}`}
                    data-shape="pill"
                  >
                    {isGenerating ? generationStep || 'Generating...' : 'Import from Google Sheet'}
                  </button>
                )}
              </>
            )
          }
        />

        <div className="mb-6 space-y-3 empty:hidden">
          <ErrorNotice error={error} onDismiss={() => setError('')} />

          {shortfall && (
            <Notice tone="error" className="flex items-start justify-between gap-4">
              <span className="min-w-0 break-words">
                {shortfall.message} Buy more on the{' '}
                <Link href="/credits" className="font-semibold underline underline-offset-2">
                  Credits page
                </Link>
                , or choose a model that costs less.
              </span>
              <button
                onClick={() => setShortfall(null)}
                className="-my-1 shrink-0 px-1 text-lg font-bold leading-none"
                aria-label="Dismiss"
              >
                ×
              </button>
            </Notice>
          )}

          {placedOrder && (
            <Notice tone="success">
              <p className="font-semibold">
                You ordered successfully: Order number -{' '}
                <span className="font-mono">{placedOrder.number}</span>
              </p>
              <p className="mt-1">
                {placedOrder.total} resume(s) from {placedOrder.jobCount} imported job(s) across{' '}
                {placedOrder.profileCount} profile(s) are being built. You can close this page - they
                are waiting for you under{' '}
                <Link href={`/orders/${placedOrder.id}`} className="font-semibold underline underline-offset-2">
                  Order status &amp; built resumes
                </Link>
                .{placedOrder.skippedNote}
              </p>
            </Notice>
          )}

          {successMessage && <Notice tone="success">{successMessage}</Notice>}

          {builderMode === 'sheets' && isGenerating && generationProgress && (
            <GenerationProgress progress={generationProgress} />
          )}
        </div>

        {builderMode === null && (
          <div className="grid gap-4 md:grid-cols-2">
          <button
            type="button"
            onClick={() => setBuilderMode('manual')}
            disabled={isGenerating}
            className={`tl-card ${styles.entry}`}
            data-on={builderMode === 'manual'}
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-ink">
              <IconBuild className="h-5 w-5" />
            </span>
            <span className="min-w-0">
              <span className="block text-lg font-semibold text-ink">Building Manually</span>
              <span className="mt-2 block text-sm text-muted">
                Original builder flow. Enter company, role, and job description manually, then preview or generate.
              </span>
            </span>
          </button>

          <button
            type="button"
            onClick={() => setBuilderMode('sheets')}
            disabled={isGenerating}
            className={`tl-card ${styles.entry}`}
            data-on={builderMode === 'sheets'}
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-ink">
              <IconTemplates className="h-5 w-5" />
            </span>
            <span className="min-w-0">
              <span className="block text-lg font-semibold text-ink">Building Automatically from Google Sheet</span>
              <span className="mt-2 block text-sm text-muted">
                Import jobs from Google Sheets, map columns once, then generate every selected profile against every imported row.
              </span>
            </span>
          </button>
          </div>
        )}

        {builderMode !== null && (builderMode === 'manual' ? (
          <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
            <Card title="Job">
              <div className="space-y-6">
                <div>
                  <label className="tl-label">
                    Company Name <span className={styles.required}>*</span>
                  </label>
                  <input
                    type="text"
                    value={companyName}
                    onChange={(e) => setCompanyName(e.target.value)}
                    disabled={isGenerating}
                    placeholder="Enter company name"
                    className="tl-input mt-2"
                  />
                </div>

                {shouldShowRoleInput && (
                  <div>
                    <label className="tl-label">
                      Role <span className={styles.required}>*</span>
                    </label>
                    <input
                      type="text"
                      value={role}
                      onChange={(e) => setRole(e.target.value)}
                      disabled={isGenerating}
                      placeholder="Enter job role/title"
                      className="tl-input mt-2"
                    />
                  </div>
                )}

                <div>
                  <label className="tl-label">
                    Job Description <span className={styles.required}>*</span>
                  </label>
                  <textarea
                    value={jobDescription}
                    onChange={(e) => setJobDescription(e.target.value)}
                    disabled={isGenerating}
                    placeholder="Paste the job description (min 50 characters)"
                    rows={4}
                    className="tl-input mt-2 h-72 resize-y"
                  />
                  <p className="mt-2 text-sm text-subtle">{jobDescription.length} characters</p>
                </div>
              </div>
            </Card>

            <Card title="Build options" padded={false}>
              <div className="divide-y divide-[var(--line-subtle)]">
                <div className="space-y-5 p-5">
                  <div>
                    <label className="tl-label">
                      Generate mode
                    </label>
                    <div className="mt-2 grid gap-2">
                      <label className="tl-choice" data-on={generateMode === 'single'}>
                        <input
                          type="radio"
                          name="generateMode"
                          value="single"
                          checked={generateMode === 'single'}
                          onChange={() => setGenerateMode('single')}
                          disabled={isGenerating}
                        />
                        <span className="text-sm font-medium text-ink">Single (one profile)</span>
                      </label>
                      <label className="tl-choice" data-on={generateMode === 'multiple'}>
                        <input
                          type="radio"
                          name="generateMode"
                          value="multiple"
                          checked={generateMode === 'multiple'}
                          onChange={() => setGenerateMode('multiple')}
                          disabled={isGenerating}
                        />
                        <span className="text-sm font-medium text-ink">Multiple (all profiles)</span>
                      </label>
                    </div>
                  </div>

                  {generateMode === 'single' && (
                    <ProfileSelector
                      profiles={profiles}
                      selectedId={selectedProfileId}
                      onChange={setSelectedProfileId}
                      isLoading={false}
                    />
                  )}

                  {generateMode === 'multiple' && (
                    <div className="space-y-5">
                      <div>
                        <label className="tl-label">Target</label>
                        <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2">
                          <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
                            <input
                              type="radio"
                              name="multipleTarget"
                              value="all"
                              checked={multipleTarget === 'all'}
                              onChange={() => setMultipleTarget('all')}
                              disabled={isGenerating}
                              className="tl-check"
                            />
                            <span>All profiles</span>
                          </label>
                          <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
                            <input
                              type="radio"
                              name="multipleTarget"
                              value="group"
                              checked={multipleTarget === 'group'}
                              onChange={() => setMultipleTarget('group')}
                              disabled={isGenerating}
                              className="tl-check"
                            />
                            <span>Specific group</span>
                          </label>
                        </div>
                      </div>

                      {multipleTarget === 'group' && (
                        <div>
                          <label className="tl-label">Select Group</label>
                          <select
                            value={selectedGroupId}
                            onChange={(e) => setSelectedGroupId(e.target.value)}
                            disabled={isGenerating}
                            className="tl-input mt-2"
                          >
                            <option value="">Choose a group...</option>
                            {groups.map((group) => (
                              <option key={group.id} value={group.id}>
                                {group.name} ({group.profileIds.length})
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <details className={`${styles.disclosure} p-5`}>
                  <summary className="text-sm font-medium text-ink">
                    <IconChevronRight className={`h-4 w-4 ${styles.chevron}`} />
                    Model
                    {hasAiOverrides && (
                      <Pill tone="sky">
                        overridden for this run
                      </Pill>
                    )}
                  </summary>
                  <div className="mt-4 space-y-3">
                    <AiPreferenceFields
                      idPrefix="builder-ai"
                      value={aiOverrides}
                      onChange={setAiOverrides}
                      models={modelSettings.models}
                      modelsLoaded={modelsLoaded}
                      inheritedFrom={inheritsFromProfile ? "profile's setting" : 'app default'}
                      inherited={inheritedChoice}
                      disabled={isGenerating}
                    />
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm text-subtle">
                        {inheritsFromProfile
                          ? `Defaults come from ${selectedProfile?.name}. Anything set here applies to this run only.`
                          : 'Each profile uses its own default; anything set here applies to this run only.'}
                      </p>
                      {hasAiOverrides && (
                        <button
                          type="button"
                          onClick={() => setAiOverrides({})}
                          disabled={isGenerating}
                          className="tl-button-quiet shrink-0"
                          data-size="sm"
                        >
                          Reset
                        </button>
                      )}
                    </div>
                  </div>
                </details>

                <div className="flex items-center justify-between gap-4 p-5">
                  <div>
                    <div className="text-sm font-semibold text-ink">
                      {autoGenerate ? 'Auto-generate (On)' : 'Preview mode (On)'}
                    </div>
                    <div className="mt-0.5 text-xs text-muted">
                      {autoGenerate
                        ? 'Analyze + generate in one step.'
                        : 'Analyze + preview first. Generate manually.'}
                    </div>
                  </div>
                  <label className={styles.switch}>
                    <input
                      type="checkbox"
                      checked={autoGenerate}
                      onChange={(e) => setAutoGenerate(e.target.checked)}
                      disabled={isGenerating}
                      className="sr-only"
                    />
                    <span className={`${styles.track} ${autoGenerate ? styles.trackOn : ''}`}>
                      <span className={`${styles.knob} ${autoGenerate ? styles.knobOn : ''}`} />
                    </span>
                  </label>
                </div>
              </div>
            </Card>
          </div>
        ) : (
          <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
            {/*
              First in the source so a phone reads what this mode does - and
              why it cannot run yet - before the fields; beside them from xl up.
            */}
            <div className="space-y-3 xl:col-start-2 xl:row-start-1">
              <Notice tone="info">
                Import a Google Sheet range where each row is one job. After column mapping, the builder will generate every selected profile against every imported row.
              </Notice>

              {!hasImportableSheet && (
                <Notice tone="warn">
                  {sheetImportNotice}
                </Notice>
              )}
            </div>

            <div className="xl:col-start-1 xl:row-start-1">
              <Card title="Build target">
                <div className="space-y-6">
                  <div>
                    <label className="tl-label sr-only">
                      Build target
                    </label>
                    <div className="grid gap-2 sm:grid-cols-3">
                      <label className="tl-choice" data-on={sheetsTargetMode === 'single'}>
                        <input
                          type="radio"
                          name="sheetsTargetMode"
                          value="single"
                          checked={sheetsTargetMode === 'single'}
                          onChange={() => setSheetsTargetMode('single')}
                          disabled={isGenerating}
                        />
                        <span className="text-sm font-medium text-ink">Single profile</span>
                      </label>
                      <label className="tl-choice" data-on={sheetsTargetMode === 'all'}>
                        <input
                          type="radio"
                          name="sheetsTargetMode"
                          value="all"
                          checked={sheetsTargetMode === 'all'}
                          onChange={() => setSheetsTargetMode('all')}
                          disabled={isGenerating}
                        />
                        <span className="text-sm font-medium text-ink">All profiles</span>
                      </label>
                      <label className="tl-choice" data-on={sheetsTargetMode === 'group'}>
                        <input
                          type="radio"
                          name="sheetsTargetMode"
                          value="group"
                          checked={sheetsTargetMode === 'group'}
                          onChange={() => setSheetsTargetMode('group')}
                          disabled={isGenerating}
                        />
                        <span className="text-sm font-medium text-ink">Specific group</span>
                      </label>
                    </div>
                  </div>

                  {sheetsTargetMode === 'single' && (
                    <ProfileSelector
                      profiles={profiles}
                      selectedId={selectedSheetsProfileId}
                      onChange={setSelectedSheetsProfileId}
                      isLoading={false}
                    />
                  )}

                  {sheetsTargetMode === 'group' && (
                    <div>
                      <label className="tl-label">Select Group</label>
                      <select
                        value={selectedSheetsGroupId}
                        onChange={(e) => setSelectedSheetsGroupId(e.target.value)}
                        disabled={isGenerating}
                        className="tl-input mt-2"
                      >
                        <option value="">Choose a group...</option>
                        {groups.map((group) => (
                          <option key={group.id} value={group.id}>
                            {group.name} ({group.profileIds.length})
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {shouldShowRoleInput && (
                    <div>
                      <label className="tl-label">
                        Fallback Role
                      </label>
                      <input
                        type="text"
                        value={role}
                        onChange={(e) => setRole(e.target.value)}
                        disabled={isGenerating}
                        placeholder="Optional fallback if a sheet row has no mapped job title"
                        className="tl-input mt-2"
                      />
                      <p className="mt-2 text-sm text-subtle">
                        Leave this blank if your imported rows already include a mapped job title column.
                      </p>
                    </div>
                  )}
                </div>
              </Card>
            </div>
          </div>
        ))}

        {builderMode === 'manual' && generateMode === 'multiple' && autoGenerate && unconfirmedPanel && (
          <div className="mt-6">{unconfirmedPanel}</div>
        )}

        {builderMode === 'manual' && generateMode === 'multiple' && !autoGenerate && multiplePreviews.length > 0 && activeMultiplePreview && (
          <div className="tl-backdrop">
            <div className={`tl-dialog ${styles.sheet}`}>
              <div className="tl-card-header">
                <div className="flex min-w-0 flex-wrap items-center gap-3">
                  <h3 className="text-lg font-semibold text-ink">Resume Preview</h3>
                  <Pill>
                    {multiplePreviewIndex + 1} / {multiplePreviews.length}
                  </Pill>
                  {multiplePreviewTailored && (
                    <Pill tone="green">
                      ATS OPTIMIZATION
                    </Pill>
                  )}
                  <span className="min-w-0 truncate text-sm text-muted">{activeMultiplePreview.profileName}</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setMultiplePreviewIndex((i) => Math.max(0, i - 1))}
                    disabled={multiplePreviewIndex === 0 || isGenerating}
                    className="tl-button-quiet"
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    onClick={() => setMultiplePreviewIndex((i) => Math.min(multiplePreviews.length - 1, i + 1))}
                    disabled={multiplePreviewIndex >= multiplePreviews.length - 1 || isGenerating}
                    className="tl-button-quiet"
                  >
                    Next
                  </button>
                  <CostLine quote={quote} shortfall={shortfall} />
                  <button
                    onClick={handleFinalizeGenerateMultiple}
                    disabled={isGenerating}
                    className={`tl-button ${styles.wrap}`}
                  >
                    {isGenerating ? generationStep || 'Generating...' : 'Generate All'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMultiplePreviews([]);
                      setMultiplePreviewIndex(0);
                    }}
                    disabled={isGenerating}
                    className="tl-button-quiet"
                  >
                    Close
                  </button>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto lg:grid lg:grid-cols-2 lg:overflow-hidden">
                <div className="bg-surface-muted p-4 sm:p-6 lg:h-full lg:overflow-y-auto">
                  {isGenerating && generationProgress && (
                    <GenerationProgress progress={generationProgress} className="mb-4" />
                  )}
                  <div className={`resume-paper-shell ${styles.paper} mx-auto max-w-[816px]`}>
                    <iframe
                      srcDoc={activeMultiplePreview.html}
                      sandbox=""
                      className="w-full h-[1056px] border-0"
                      title={`Resume Preview - ${activeMultiplePreview.profileName}`}
                    />
                  </div>
                </div>
                <div className="space-y-6 p-4 sm:p-6 lg:h-full lg:overflow-y-auto">
                  {unconfirmedPanel}

                  <div className="tl-card">
                    <div className="tl-card-header">
                      <div className="text-sm font-semibold text-ink">Manual Edits (JSON)</div>
                    </div>
                    <div className="p-4">
                      <textarea
                        value={activeMultiplePreview.draft}
                        onChange={(e) => handleMultipleDraftChange(activeMultiplePreview.profileId, e.target.value)}
                        rows={8}
                        className={`tl-input ${styles.code}`}
                        placeholder="Edit tailored content JSON here."
                      />
                      {activeMultiplePreview.error && (
                        <p className="tl-status mt-2" data-tone="error">{activeMultiplePreview.error}</p>
                      )}
                      <div className="mt-3 flex flex-wrap items-center gap-3">
                        <button
                          type="button"
                          onClick={() => handleUpdateMultiplePreview(activeMultiplePreview.profileId)}
                          disabled={isGenerating || !!activeMultiplePreview.error}
                          className="tl-button-quiet"
                          data-size="sm"
                        >
                          Update Preview
                        </button>
                        <span className="text-xs text-subtle">
                          Apply edits to preview before final generate.
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {builderMode === 'manual' && generateMode === 'single' && previewHtml && (
          <ResumePreview
            html={previewHtml}
            onGenerate={handleFinalizeGenerate}
            isGenerating={isGenerating}
            isTailored={previewTailored}
            isOpen={isSinglePreviewOpen}
            onClose={() => setIsSinglePreviewOpen(false)}
            generationStep={generationStep}
            costNote={<CostLine quote={quote} shortfall={shortfall} />}
            sidebar={
              <>
                {unconfirmedPanel}
                <div className="tl-card">
                  <div className="tl-card-header">
                    <div className="text-sm font-semibold text-ink">Manual Edits (JSON)</div>
                  </div>
                  <div className="p-4">
                    <textarea
                      value={tailoredContentDraft}
                      onChange={(e) => handleTailoredContentChange(e.target.value)}
                      rows={8}
                      className={`tl-input ${styles.code}`}
                      placeholder="Edit tailored content JSON here."
                    />
                    {tailoredContentError && (
                      <p className="tl-status mt-2" data-tone="error">{tailoredContentError}</p>
                    )}
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        onClick={handleUpdatePreview}
                        disabled={isGenerating || !!tailoredContentError}
                        className="tl-button-quiet"
                        data-size="sm"
                      >
                        Update Preview
                      </button>
                      <span className="text-xs text-subtle">
                        Apply edits to preview before final generate.
                      </span>
                    </div>
                  </div>
                </div>
              </>
            }
          />
        )}

      </Page>

      <SheetsImportModal
        isOpen={isSheetsImportOpen}
        isSubmitting={isGenerating}
        showJobTitleMapping={shouldShowRoleInput}
        sources={sheetImportSources}
        selectedSourceId={selectedSheetsSourceId}
        selectedProfileName={selectedSheetsProfileName}
        generationProgress={generationProgress}
        onSelectSource={setSelectedSheetsSourceId}
        onClose={() => setIsSheetsImportOpen(false)}
        onConfirm={handleImportJobsFromSheets}
      />

      {/* Footer */}
      <footer className="mt-auto py-6 text-center text-sm text-subtle">
        <p>Tailor</p>
      </footer>
    </>
  );
}
