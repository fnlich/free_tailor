'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import {
  profilesApi,
  groupsApi,
  resumeApi,
  DEFAULT_PUBLIC_APP_SETTINGS,
  PublicAppSettings,
  AiPreferences,
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
  type SubmitBatchRequest,
} from '@/lib/generationQueue';
import AppTopNav from '@/components/AppTopNav';
import GenerationProgress, { type GenerationProgressState } from '@/components/GenerationProgress';
import ProfileSelector from '@/components/ProfileSelector';
import AiPreferenceFields from '@/components/AiPreferenceFields';
import ResumePreview from '@/components/ResumePreview';
import SheetsImportModal, { ImportedSheetJob, type ImportSheetSource } from '@/components/SheetsImportModal';
import { useAuth } from '@/contexts/AuthContext';
import { sheetApi, type AccountSheet } from '@/lib/sheet';
import { applyTheme, getStoredTheme, setStoredDefaultTheme } from '@/lib/theme';

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

export default function Home() {
  const { account } = useAuth();
  const isAdmin = account?.role === 'admin';
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [builderMode, setBuilderMode] = useState<BuilderMode>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  /**
   * Model and effort for THIS run only.
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
  const [modelSettings, setModelSettings] = useState<PublicAppSettings>(DEFAULT_PUBLIC_APP_SETTINGS);
  const [jobAnalysis, setJobAnalysis] = useState<JobAnalysis | null>(null);
  const [previewHtml, setPreviewHtml] = useState('');
  const [previewTailored, setPreviewTailored] = useState(false);
  const [isSinglePreviewOpen, setIsSinglePreviewOpen] = useState(false);
  const [tailoredContent, setTailoredContent] = useState<TailoredContent | null>(null);
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
  /** The batch this page is watching, so a reload can pick it back up. */
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  /** The receipt for a sheet import, kept as data so it can carry a link. */
  const [placedOrder, setPlacedOrder] = useState<PlacedOrder | null>(null);

  useEffect(() => {
    loadInitialData();
  }, []);

  const resetTailoredEditor = useCallback(() => {
    setTailoredContent(null);
    setTailoredContentDraft('');
    setTailoredContentError('');
  }, []);

  const resetGenerationOutputs = useCallback(() => {
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

  useEffect(() => {
    resetGenerationOutputs();
  }, [builderMode, companyName, role, jobDescription, selectedProfileId, generateMode, resetGenerationOutputs]);

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
    modelSettings.aiModels.find((model) => model.id === profilePreferences.modelId) ??
    modelSettings.aiModels.find((model) => model.id === modelSettings.defaultModelId);
  const inheritedChoice = {
    modelLabel: inheritedModel?.name || 'the first enabled model',
    effort: profilePreferences.effort ?? modelSettings.aiPreferenceDefaults.effort,
  };

  const loadInitialData = async () => {
    try {
      const [profilesData, groupsData, modelData, ownSheet] = await Promise.all([
        profilesApi.getAll({ includeDisabled: true }),
        groupsApi.getAll().catch(() => []),
        resumeApi.getModels().catch(() => DEFAULT_PUBLIC_APP_SETTINGS),
        // Never fatal to this page: the import dialog is one feature of it, and
        // a Google outage must not stop the builder from loading.
        sheetApi.get().catch(() => null),
      ]);
      const enabledProfiles = profilesData.filter((p) => !p.disabled);
      setProfiles(enabledProfiles);
      setGroups(groupsData);
      setModelSettings(modelData);
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
      setError(err instanceof Error ? err.message : 'Failed to load data');
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

    return isAdmin ? [...own, ...modelSettings.googleSheetsSources] : own;
  }, [accountSheet, isAdmin, modelSettings.googleSheetsSources]);
  const hasImportableSheet = sheetImportSources.length > 0;
  /** Why there is nothing to import from, in the words that fit the reason. */
  const sheetImportNotice =
    accountSheet && !accountSheet.configured
      ? accountSheet.message ?? 'Google Sheets is not set up on this server yet.'
      : 'Your job sheet is not ready yet. Open the Account page and try again.';
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
   * them to browsers as they come free, so three browsers build three resumes at
   * once. The loop this replaced awaited each resume in turn, so however many
   * browsers were registered, two of every three sat idle.
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
      setGenerationStep(
        snapshot.running > 0
          ? `${describe.phase} - ${snapshot.running} running, ${finished}/${snapshot.total} done`
          : `${describe.phase} - ${finished}/${snapshot.total} done`
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
     * reconciliation. Bounded so a batch the server has genuinely forgotten
     * cannot spin here for ever.
     */
    const MAX_REATTACHES = 20;
    for (let attempt = 0; attempt <= MAX_REATTACHES; attempt += 1) {
      try {
        await generationApi.follow(batchId, show);
      } catch {
        // A dropped stream is not a failed batch - the work is the server's.
        // Fall through to the snapshot below, which is the authority.
      }

      last = (await generationApi.snapshot(batchId).catch(() => last)) ?? last;
      if (!last || last.state !== 'running') break;

      if (attempt === MAX_REATTACHES) break;
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
  }: {
    targetProfiles: Profile[];
    analysis: JobAnalysis;
    targetCompanyName: string;
    resolvedRole: string;
    tailoredContentByProfileId?: Map<string, TailoredContent | undefined>;
  }) => {
    updateGenerationProgress(
      targetProfiles.length,
      0,
      'Queueing resumes',
      undefined,
      targetCompanyName
    );

    const tailoredByProfileId: Record<string, unknown> = {};
    for (const profile of targetProfiles) {
      const tailored = tailoredContentByProfileId?.get(profile.id);
      if (tailored) tailoredByProfileId[profile.id] = tailored;
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
    setSuccessMessage('');
    setPlacedOrder(null);
    resetGenerationOutputs();

    try {
      /**
       * ONE request carrying every resume, not one request per resume.
       *
       * This was a nested loop - for each job, analyse it, then for each profile
       * await a generate - so thirty sheet rows were thirty analyses and thirty
       * builds, strictly one at a time. However many browsers were registered,
       * all but one sat idle for the whole run.
       *
       * Now the server queues the lot and hands them out as browsers come free,
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
      setError(err instanceof Error ? err.message : 'Could not place that order.');
    } finally {
      setIsGenerating(false);
      setGenerationStep('');
      clearGenerationProgress();
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
        const res = await resumeApi.previewAll({
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
      setError(err instanceof Error ? err.message : 'Failed to generate resume');
    } finally {
      setIsGenerating(false);
      setGenerationStep('');
      clearGenerationProgress();
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
      setError(err instanceof Error ? err.message : 'Failed to confirm skill');
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
      setError(err instanceof Error ? err.message : 'Failed to update preview');
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
      setError(err instanceof Error ? err.message : 'Failed to generate resume');
    } finally {
      setIsGenerating(false);
      setGenerationStep('');
      clearGenerationProgress();
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
      setError(err instanceof Error ? err.message : 'Failed to update preview');
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
        const total = profilesToGenerate.length;
        let completed = 0;

        updateGenerationProgress(total, 0, 'Preparing resume generation', undefined, companyName.trim());
        for (const profile of profilesToGenerate) {
          const preview = previewMap.get(profile.id);
          if (!preview?.tailoredContent) continue;
          const templateId = profile.preferredTemplate || 'default';
          setGenerationStep(`Generating ${completed + 1}/${total}: ${profile.name} x ${companyName.trim()}`);
          updateGenerationProgress(total, completed, 'Building resumes', profile.name, companyName.trim());
          await resumeApi.generate({
            ...aiRequestOverrides,
            profileId: profile.id,
            templateId,
            jobDescription,
            jobAnalysis: analysis,
            tailoredContent: preview.tailoredContent,
            companyName: companyName.trim(),
            role: shouldShowRoleInput ? role.trim() : (getAnalysisJobTitle(analysis) || ''),
            ...getDefaultGenerationOptions(),
          });
          completed += 1;
          updateGenerationProgress(total, completed, 'Building resumes', profile.name, companyName.trim());
        }
        setSuccessMessage(`Generated ${profilesToGenerate.length} resume(s) successfully.`);
        const aggregated = aggregateUnconfirmedFromPreviews(multiplePreviews);
        setUnconfirmedHardSkills(aggregated.hard);
        setUnconfirmedSoftSkills(aggregated.soft);
        setMultiplePreviews([]);
        setMultiplePreviewIndex(0);
        setMultiplePreviewTailored(false);
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
      setError(err instanceof Error ? err.message : 'Failed to generate resume');
    } finally {
      setIsGenerating(false);
      setGenerationStep('');
      clearGenerationProgress();
    }
  };

  const activeMultiplePreview = multiplePreviews[multiplePreviewIndex];

  const unconfirmedPanel = (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="text-sm font-medium text-gray-700">Unregistered Skills</div>
      {unconfirmedHardSkills.length === 0 && unconfirmedSoftSkills.length === 0 && (
        <div className="text-xs text-gray-500">No unregistered skills found.</div>
      )}
      {unconfirmedHardSkills.length > 0 && (
        <div className="space-y-3">
          <div className="text-xs font-semibold text-gray-600">Tech Skills</div>
          <div className="grid grid-cols-2 gap-2">
            {unconfirmedHardSkills.map((skill) => (
              <div key={`uh-${skill.original}`} className="flex items-center gap-2">
                <input
                  type="text"
                  value={skill.value}
                  onChange={(e) =>
                    handleUnconfirmedSkillEdit('hard', skill.original, e.target.value)
                  }
                  disabled={isGenerating}
                  className="flex-1 px-2 py-1 border border-gray-300 rounded-md text-sm"
                />
                <button
                  type="button"
                  onClick={() => handleConfirmSkill('hard', skill)}
                  disabled={isGenerating}
                  className="px-2 py-1 text-xs bg-gray-800 text-white rounded-md hover:bg-gray-900 disabled:bg-gray-400"
                >
                  Add
                </button>
                <button
                  type="button"
                  onClick={() => handleRemoveUnconfirmedSkill('hard', skill)}
                  disabled={isGenerating}
                  className="px-2 py-1 text-xs border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 disabled:text-gray-400"
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
          <div className="text-xs font-semibold text-gray-600">Soft Skills</div>
          <div className="grid grid-cols-2 gap-2">
            {unconfirmedSoftSkills.map((skill) => (
              <div key={`us-${skill.original}`} className="flex items-center gap-2">
                <input
                  type="text"
                  value={skill.value}
                  onChange={(e) =>
                    handleUnconfirmedSkillEdit('soft', skill.original, e.target.value)
                  }
                  disabled={isGenerating}
                  className="flex-1 px-2 py-1 border border-gray-300 rounded-md text-sm"
                />
                <button
                  type="button"
                  onClick={() => handleConfirmSkill('soft', skill)}
                  disabled={isGenerating}
                  className="px-2 py-1 text-xs bg-gray-800 text-white rounded-md hover:bg-gray-900 disabled:bg-gray-400"
                >
                  Add
                </button>
                <button
                  type="button"
                  onClick={() => handleRemoveUnconfirmedSkill('soft', skill)}
                  disabled={isGenerating}
                  className="px-2 py-1 text-xs border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 disabled:text-gray-400"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  if (isLoadingData) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <AppTopNav />

      {/* Main Content */}
      <main className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">Generate Resumes</h1>

        {error && (
          <div className="mb-6 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg flex justify-between items-center">
            <span>{error}</span>
            <button onClick={() => setError('')} className="text-red-700 hover:text-red-900 font-bold">
              ×
            </button>
          </div>
        )}

        {placedOrder && (
          <div className="mb-6 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-green-800">
            <p className="font-semibold">
              You ordered successfully: Order number -{' '}
              <span className="font-mono">{placedOrder.number}</span>
            </p>
            <p className="mt-1 text-sm">
              {placedOrder.total} resume(s) from {placedOrder.jobCount} imported job(s) across{' '}
              {placedOrder.profileCount} profile(s) are being built. You can close this page - they
              are waiting for you under{' '}
              <Link href={`/orders/${placedOrder.id}`} className="font-semibold underline">
                Order status &amp; built resumes
              </Link>
              .{placedOrder.skippedNote}
            </p>
          </div>
        )}

        {successMessage && (
          <div className="mb-6 bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg">
            {successMessage}
          </div>
        )}

        {builderMode === 'sheets' && isGenerating && generationProgress && (
          <GenerationProgress progress={generationProgress} className="mb-6" />
        )}

        {builderMode === null && (
          <div className="mb-6 grid gap-4 md:grid-cols-2">
          <button
            type="button"
            onClick={() => setBuilderMode('manual')}
            disabled={isGenerating}
            className={`rounded-xl border px-6 py-6 text-left transition ${
              builderMode === 'manual'
                ? 'border-blue-300 bg-blue-50 shadow-sm'
                : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50'
            }`}
          >
            <div className="text-lg font-semibold text-gray-900">Building Manually</div>
            <div className="mt-2 text-sm text-gray-600">
              Original builder flow. Enter company, role, and job description manually, then preview or generate.
            </div>
          </button>

          <button
            type="button"
            onClick={() => setBuilderMode('sheets')}
            disabled={isGenerating}
            className={`rounded-xl border px-6 py-6 text-left transition ${
              builderMode === 'sheets'
                ? 'border-blue-300 bg-blue-50 shadow-sm'
                : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50'
            }`}
          >
            <div className="text-lg font-semibold text-gray-900">Building Automatically from Google Sheet</div>
            <div className="mt-2 text-sm text-gray-600">
              Import jobs from Google Sheets, map columns once, then generate every selected profile against every imported row.
            </div>
          </button>
          </div>
        )}

        {builderMode !== null && (builderMode === 'manual' ? (
          <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => {
                  setBuilderMode(null);
                  setIsSheetsImportOpen(false);
                }}
                disabled={isGenerating}
                className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
              >
                Back
              </button>
            </div>
            <button
              onClick={handleGenerate}
              disabled={isGenerating}
              className="w-full py-3 px-4 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {isGenerating ? (
                <>
                  <span className="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent"></span>
                  {generationStep || 'Generating...'}
                </>
              ) : (
                generateMode === 'single'
                  ? autoGenerate
                    ? 'Generate Resume'
                    : 'Analyze & Preview'
                  : autoGenerate
                    ? `Generate All (${profiles.length} profiles)`
                    : 'Analyze & Preview'
              )}
            </button>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-3">
                Generate mode
              </label>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="generateMode"
                    value="single"
                    checked={generateMode === 'single'}
                    onChange={() => setGenerateMode('single')}
                    disabled={isGenerating}
                    className="w-4 h-4 text-blue-600"
                  />
                  <span>Single (one profile)</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="generateMode"
                    value="multiple"
                    checked={generateMode === 'multiple'}
                    onChange={() => setGenerateMode('multiple')}
                    disabled={isGenerating}
                    className="w-4 h-4 text-blue-600"
                  />
                  <span>Multiple (all profiles)</span>
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

            <details className="rounded-lg border border-gray-200 dark:border-gray-700 p-4">
              <summary className="cursor-pointer text-sm font-medium text-gray-700 dark:text-gray-200">
                Model and effort
                {hasAiOverrides && (
                  <span className="ml-2 rounded bg-blue-100 px-2 py-0.5 text-xs text-blue-800 dark:bg-blue-900 dark:text-blue-200">
                    overridden for this run
                  </span>
                )}
              </summary>
              <div className="mt-4 space-y-3">
                <AiPreferenceFields
                  idPrefix="builder-ai"
                  value={aiOverrides}
                  onChange={setAiOverrides}
                  models={modelSettings.aiModels}
                  providerLocks={modelSettings.providerLocks}
                  providerTuning={modelSettings.providerTuning}
                  effortLevels={modelSettings.aiPreferenceDefaults.effortLevels}
                  inheritedFrom={inheritsFromProfile ? "profile's setting" : 'app default'}
                  inherited={inheritedChoice}
                  disabled={isGenerating}
                />
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {inheritsFromProfile
                      ? `Defaults come from ${selectedProfile?.name}. Anything set here applies to this run only.`
                      : 'Each profile uses its own default; anything set here applies to this run only.'}
                  </p>
                  {hasAiOverrides && (
                    <button
                      type="button"
                      onClick={() => setAiOverrides({})}
                      disabled={isGenerating}
                      className="shrink-0 text-xs text-blue-600 hover:underline disabled:text-gray-400"
                    >
                      Reset
                    </button>
                  )}
                </div>
              </div>
            </details>

            {generateMode === 'multiple' && (
              <div className="space-y-4 border border-gray-200 rounded-lg p-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Target</label>
                  <div className="flex gap-4">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="multipleTarget"
                        value="all"
                        checked={multipleTarget === 'all'}
                        onChange={() => setMultipleTarget('all')}
                        disabled={isGenerating}
                        className="w-4 h-4 text-blue-600"
                      />
                      <span>All profiles</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="multipleTarget"
                        value="group"
                        checked={multipleTarget === 'group'}
                        onChange={() => setMultipleTarget('group')}
                        disabled={isGenerating}
                        className="w-4 h-4 text-blue-600"
                      />
                      <span>Specific group</span>
                    </label>
                  </div>
                </div>

                {multipleTarget === 'group' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Select Group</label>
                    <select
                      value={selectedGroupId}
                      onChange={(e) => setSelectedGroupId(e.target.value)}
                      disabled={isGenerating}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
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

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Company Name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                disabled={isGenerating}
                placeholder="Enter company name"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {shouldShowRoleInput && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Role <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  disabled={isGenerating}
                  placeholder="Enter job role/title"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Job Description <span className="text-red-500">*</span>
              </label>
              <textarea
                value={jobDescription}
                onChange={(e) => setJobDescription(e.target.value)}
                disabled={isGenerating}
                placeholder="Paste the job description (min 50 characters)"
                rows={4}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              />
              <p className="text-sm text-gray-500 mt-1">{jobDescription.length} characters</p>
            </div>

            <div
              className={`flex items-center justify-between border rounded-lg p-4 transition-colors ${
                autoGenerate ? 'border-blue-200 bg-blue-50' : 'border-red-200 bg-red-50'
              }`}
            >
              <div>
                <div className="text-sm font-semibold text-gray-800">
                  {autoGenerate ? 'Auto-generate (On)' : 'Preview mode (On)'}
                </div>
                <div className="text-xs text-gray-600">
                  {autoGenerate
                    ? 'Analyze + generate in one step.'
                    : 'Analyze + preview first. Generate manually.'}
                </div>
              </div>
              <label className="inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoGenerate}
                  onChange={(e) => setAutoGenerate(e.target.checked)}
                  disabled={isGenerating}
                  className="sr-only"
                />
                <span
                  className={`relative w-11 h-6 rounded-full peer-focus:outline-none transition-colors ${
                    autoGenerate ? 'bg-blue-600' : 'bg-red-500'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 h-5 w-5 bg-white rounded-full transition-transform ${
                      autoGenerate ? 'translate-x-5' : ''
                    }`}
                  />
                </span>
              </label>
            </div>
          </div>
        ) : (
          <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => {
                  setBuilderMode(null);
                  setIsSheetsImportOpen(false);
                }}
                disabled={isGenerating}
                className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
              >
                Back
              </button>
            </div>
            <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
              Import a Google Sheet range where each row is one job. After column mapping, the builder will generate every selected profile against every imported row.
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-3">
                Build target
              </label>
              <div className="flex flex-wrap gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="sheetsTargetMode"
                    value="single"
                    checked={sheetsTargetMode === 'single'}
                    onChange={() => setSheetsTargetMode('single')}
                    disabled={isGenerating}
                    className="w-4 h-4 text-blue-600"
                  />
                  <span>Single profile</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="sheetsTargetMode"
                    value="all"
                    checked={sheetsTargetMode === 'all'}
                    onChange={() => setSheetsTargetMode('all')}
                    disabled={isGenerating}
                    className="w-4 h-4 text-blue-600"
                  />
                  <span>All profiles</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="sheetsTargetMode"
                    value="group"
                    checked={sheetsTargetMode === 'group'}
                    onChange={() => setSheetsTargetMode('group')}
                    disabled={isGenerating}
                    className="w-4 h-4 text-blue-600"
                  />
                  <span>Specific group</span>
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
                <label className="block text-sm font-medium text-gray-700 mb-2">Select Group</label>
                <select
                  value={selectedSheetsGroupId}
                  onChange={(e) => setSelectedSheetsGroupId(e.target.value)}
                  disabled={isGenerating}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
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
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Fallback Role
                </label>
                <input
                  type="text"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  disabled={isGenerating}
                  placeholder="Optional fallback if a sheet row has no mapped job title"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <p className="mt-1 text-sm text-gray-500">
                  Leave this blank if your imported rows already include a mapped job title column.
                </p>
              </div>
            )}

            {!hasImportableSheet && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                {sheetImportNotice}
              </div>
            )}

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
              className="w-full rounded-lg bg-blue-600 px-4 py-3 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-400"
            >
              {isGenerating ? generationStep || 'Generating...' : 'Import from Google Sheet'}
            </button>
          </div>
        ))}

        {builderMode === 'manual' && generateMode === 'multiple' && autoGenerate && unconfirmedPanel && (
          <div className="mt-6">{unconfirmedPanel}</div>
        )}

        {builderMode === 'manual' && generateMode === 'multiple' && !autoGenerate && multiplePreviews.length > 0 && activeMultiplePreview && (
          <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm">
            <div className="absolute inset-4 bg-white rounded-xl shadow-2xl flex flex-col">
              <div className="flex items-center justify-between px-6 py-4 border-b">
                <div className="flex items-center gap-3">
                  <h3 className="text-lg font-semibold text-gray-900">Resume Preview</h3>
                  <span className="px-2 py-1 bg-gray-100 text-gray-700 text-xs rounded-full">
                    {multiplePreviewIndex + 1} / {multiplePreviews.length}
                  </span>
                  {multiplePreviewTailored && (
                    <span className="px-2 py-1 bg-green-100 text-green-700 text-xs rounded-full">
                      ATS OPTIMIZATION
                    </span>
                  )}
                  <span className="text-sm text-gray-600">{activeMultiplePreview.profileName}</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setMultiplePreviewIndex((i) => Math.max(0, i - 1))}
                    disabled={multiplePreviewIndex === 0 || isGenerating}
                    className="px-3 py-2 text-sm bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 disabled:bg-gray-100 disabled:text-gray-400"
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    onClick={() => setMultiplePreviewIndex((i) => Math.min(multiplePreviews.length - 1, i + 1))}
                    disabled={multiplePreviewIndex >= multiplePreviews.length - 1 || isGenerating}
                    className="px-3 py-2 text-sm bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 disabled:bg-gray-100 disabled:text-gray-400"
                  >
                    Next
                  </button>
                  <button
                    onClick={handleFinalizeGenerateMultiple}
                    disabled={isGenerating}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-not-allowed font-medium transition-colors"
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
                    className="px-3 py-2 text-sm bg-white text-gray-600 border border-gray-200 rounded-md hover:bg-gray-50"
                  >
                    Close
                  </button>
                </div>
              </div>
              <div className="flex-1 grid grid-cols-2 overflow-hidden">
                <div className="h-full overflow-y-auto bg-gray-100 p-6">
                  {isGenerating && generationProgress && (
                    <GenerationProgress progress={generationProgress} className="mb-4" />
                  )}
                  <div className="resume-paper-shell bg-white shadow-lg mx-auto max-w-[816px]">
                    <iframe
                      srcDoc={activeMultiplePreview.html}
                      className="w-full h-[1056px] border-0"
                      title={`Resume Preview - ${activeMultiplePreview.profileName}`}
                    />
                  </div>
                </div>
                <div className="h-full overflow-y-auto border-l p-6 space-y-6">
                  {unconfirmedPanel}

                  <div className="bg-gray-50 rounded-lg border border-gray-200 p-4">
                    <div className="text-sm font-medium text-gray-700 mb-2">Manual Edits (JSON)</div>
                    <textarea
                      value={activeMultiplePreview.draft}
                      onChange={(e) => handleMultipleDraftChange(activeMultiplePreview.profileId, e.target.value)}
                      rows={8}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder="Edit tailored content JSON here."
                    />
                    {activeMultiplePreview.error && (
                      <p className="text-sm text-red-600 mt-2">{activeMultiplePreview.error}</p>
                    )}
                    <div className="mt-3 flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => handleUpdateMultiplePreview(activeMultiplePreview.profileId)}
                        disabled={isGenerating || !!activeMultiplePreview.error}
                        className="px-3 py-2 text-sm bg-gray-800 text-white rounded-md hover:bg-gray-900 disabled:bg-gray-400"
                      >
                        Update Preview
                      </button>
                      <span className="text-xs text-gray-500">
                        Apply edits to preview before final generate.
                      </span>
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
            sidebar={
              <>
                {unconfirmedPanel}
                <div className="bg-gray-50 rounded-lg border border-gray-200 p-4">
                  <div className="text-sm font-medium text-gray-700 mb-2">Manual Edits (JSON)</div>
                  <textarea
                    value={tailoredContentDraft}
                    onChange={(e) => handleTailoredContentChange(e.target.value)}
                    rows={8}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="Edit tailored content JSON here."
                  />
                  {tailoredContentError && (
                    <p className="text-sm text-red-600 mt-2">{tailoredContentError}</p>
                  )}
                  <div className="mt-3 flex items-center gap-3">
                    <button
                      type="button"
                      onClick={handleUpdatePreview}
                      disabled={isGenerating || !!tailoredContentError}
                      className="px-3 py-2 text-sm bg-gray-800 text-white rounded-md hover:bg-gray-900 disabled:bg-gray-400"
                    >
                      Update Preview
                    </button>
                    <span className="text-xs text-gray-500">
                      Apply edits to preview before final generate.
                    </span>
                  </div>
                </div>
              </>
            }
          />
        )}

        {builderMode === 'manual' && generateMode === 'single' && previewHtml && !isSinglePreviewOpen && (
          <div className="mt-4">
            <button
              type="button"
              onClick={() => setIsSinglePreviewOpen(true)}
              className="px-3 py-2 text-sm bg-white text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50"
            >
              Open Preview
            </button>
          </div>
        )}
      </main>

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
      <footer className="mt-auto py-6 text-center text-sm text-gray-500">
        <p>Tailored Resume Builder - Powered by your Claude subscription, with OpenAI, Anthropic and DeepSeek as options</p>
      </footer>
    </div>
  );
}
