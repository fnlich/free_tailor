'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
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
  TailoredContent,
  type AnalyzedJob,
} from '@/lib/api';
import { dropsHeldAnalysis, heldAnalysisFor, holdAnalysis, type HeldAnalysis } from '@/lib/jobAnalysis';
import AnalysisFacts from '@/components/AnalysisFacts';
import {
  browserStorage,
  currentTabId,
  generationApi,
  releaseRun,
  saveTaskFile,
  tabStorage,
  type BatchSnapshot,
  type GenerationQuote,
  type SubmitBatchRequest,
} from '@/lib/generationQueue';
import GenerationProgress, { type GenerationProgressState } from '@/components/GenerationProgress';
import ProfileSelector from '@/components/ProfileSelector';
import AiPreferenceFields from '@/components/AiPreferenceFields';
import ResumePreview from '@/components/ResumePreview';
import ImmediateRunConfirm from '@/components/ImmediateRunConfirm';
import ImmediateRunFiles from '@/components/ImmediateRunFiles';
import SheetsSourcePanel, {
  type ImportSheetSource,
  type SheetRunKind,
  type SheetRunSource,
} from '@/components/SheetsSourcePanel';
import { useAuth } from '@/contexts/AuthContext';
import { sheetApi, type AccountSheet } from '@/lib/sheet';
import type { SheetJob } from '@/lib/sheetRows';
import { applyTheme, getStoredTheme, setStoredDefaultTheme } from '@/lib/theme';
import { Card, ErrorNotice, Notice, Page, PageHeader, Pill, Spinner } from '@/components/ui/kit';
import { userMessage } from '@/lib/userMessage';
import { describeRunCost, formatMoney } from '@/lib/format';
import { keepUnbuiltPreviews, readyPreviewKey } from '@/lib/builderPreviews';
import { nextAttach, reattachTarget } from '@/lib/batchFollow';
import { canBuildForManyProfiles, startingResumeSelection } from '@/lib/subscriptions';
import {
  confirmsImmediate,
  describeRunEnd,
  downloadKey,
  forgetRun,
  leavesBuilder,
  pendingDownloads,
  readRememberedRun,
  rememberRun,
  savedFileCount,
  skipImmediateConfirm,
  withDownloaded,
  type DownloadKind,
  type PendingDownload,
  type RememberedRun,
} from '@/lib/immediateRun';
import {
  cancelOrderQuestion,
  describeCancelOutcome,
  isOrderLive,
  ordersApi,
  type CancelOutcome,
  type Order,
  type OrderState,
} from '@/lib/orders';
import { IconBuild, IconChevronRight, IconTemplates } from '@/components/icons';
import styles from '@/components/builder.module.css';

type GenerateMode = 'single' | 'multiple';
type BuilderMode = 'manual' | 'sheets' | null;
type SheetsTargetMode = 'single' | 'all' | 'group';

/** What a placed order reports back, before any of it has been built. */
type PlacedOrder = {
  id: string;
  number: string;
  total: number;
  jobCount: number;
  profileCount: number;
  skippedNote: string;
  /** Set once Cancel on the receipt went through: what it stopped. */
  cancelled?: CancelOutcome;
  /**
   * Set once the order is over by any other way - built, failed, or cancelled
   * from Orders - as the receipt's poll (or a Cancel the server answered 409)
   * found it: no Cancel is offered for it any more.
   */
  ended?: { state: OrderState; built?: number };
};

/** How often the receipt asks whether its order is still being built: as often as /orders does. */
const RECEIPT_POLL_MS = 5000;

/**
 * The Generate Immediately run this page is following: built while this tab
 * holds it, each resume downloaded as it lands. `tabId` is the tab it was
 * started from - the one whose stream keeps it alive and whose page may stop
 * it.
 */
type ActiveRun = { batchId: string; tabId: string };

/** Nothing downloaded: `pendingDownloads` against it lists every finished resume's files. */
const NONE_DOWNLOADED: ReadonlySet<string> = new Set();

/** What leaving Build Resumes inside the app asks while a run is going. */
const LEAVE_CONFIRM =
  'Leave Build Resumes? Your Generate Immediately run stops when you leave this page: resumes not started yet are refunded, and ones not finished are not downloaded.';

/** Where the multi-profile choices' Premium pill leads, and what it says on hover. */
const SUBSCRIPTION_PATH = '/settings/subscription';
const ONE_PROFILE_NOTE = 'Your subscription supports one profile';

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

function getAnalysisJobTitle(analysis?: AnalyzedJob): string {
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

/** Waits `ms`, or less when `signal` aborts first; never rejects. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

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
  const short = quote.costMilli > quote.balanceMilli;
  return (
    <span
      className={short ? 'tl-status tabular-nums' : 'text-sm tabular-nums text-muted'}
      data-tone={short ? 'error' : undefined}
    >
      {/* "7 resumes × $0.023 = $0.161": the price, so the total can be checked by eye. */}
      {label}: {describeRunCost(quote)} · balance {formatMoney(quote.balanceMilli)}
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

/**
 * The "Premium" pill on a choice the account's subscription does not include:
 * a link to the page that explains subscriptions, with the reason on hover.
 * The choice beside it is disabled; the server refuses the run anyway (403
 * `subscription-too-low`) - this only stops the page offering it.
 */
function PremiumLock() {
  return (
    <Link href={SUBSCRIPTION_PATH} title={ONE_PROFILE_NOTE} aria-label={`Premium: ${ONE_PROFILE_NOTE}`} className="ml-auto shrink-0">
      <Pill tone="violet">Premium</Pill>
    </Link>
  );
}

/**
 * A Generate Immediately run's progress, with the way to stop it - in either
 * mode, and inside the multi-profile preview, which covers the page.
 */
function RunProgress({
  progress,
  stopping,
  onStop,
  className = '',
}: {
  progress: GenerationProgressState;
  stopping: boolean;
  onStop: () => void;
  className?: string;
}) {
  return (
    <div className={`space-y-3 ${className}`}>
      <GenerationProgress progress={progress} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          Each resume downloads as soon as it is built. Keep this page open until the run finishes.
        </p>
        <button
          type="button"
          onClick={onStop}
          disabled={stopping}
          className="tl-button-quiet"
          data-tone="danger"
          data-size="sm"
        >
          {stopping ? 'Stopping...' : 'Stop'}
        </button>
      </div>
    </div>
  );
}

export default function Home() {
  // `refresh` re-reads the account after a run, so the balance in the top bar
  // moves when credits are spent or refunded rather than on the next reload.
  const { account, refresh: refreshAccount } = useAuth();
  const isAdmin = account?.role === 'admin';
  /**
   * Whether this account may build for more than one profile at once:
   * Premium and up, or an administrator (owner decisions B1, B3). Below that,
   * Multiple, All profiles, Specific group and Select Group are shown locked,
   * and the target in effect is always the single profile - derived rather
   * than corrected in an effect, so a subscription that changes under an open
   * page cannot leave a locked choice selected.
   */
  const manyProfiles = canBuildForManyProfiles(account);
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
  const [generateModeChoice, setGenerateMode] = useState<GenerateMode>('single');
  const generateMode: GenerateMode = manyProfiles ? generateModeChoice : 'single';
  const [multipleTarget, setMultipleTarget] = useState<'all' | 'group'>('group');
  const [selectedGroupId, setSelectedGroupId] = useState<string>('');
  const [sheetsTargetChoice, setSheetsTargetMode] = useState<SheetsTargetMode>('single');
  const sheetsTargetMode: SheetsTargetMode = manyProfiles ? sheetsTargetChoice : 'single';
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
  /**
   * The posting's one analysis, held with the description it was made for
   * (lib/jobAnalysis.ts). Not reset with the other outputs: the company, the
   * role, the profile and the model are not the posting, and a change of any
   * of them builds on the same analysis - sent by its `analysisId`, never
   * asked for again. Editing the description is another posting, which
   * `heldAnalysisFor` sees for itself.
   */
  const [heldAnalysis, setHeldAnalysis] = useState<HeldAnalysis<AnalyzedJob> | null>(null);
  const currentAnalysis = heldAnalysisFor(heldAnalysis, jobDescription);
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
  /** How many jobs the sheet panel's loaded rows hold; null until rows are loaded. */
  const [sheetJobCount, setSheetJobCount] = useState<number | null>(null);
  /** The Generate Immediately run being followed, for what the page draws. `activeRunRef` is the same, for handlers. */
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null);
  const activeRunRef = useRef<ActiveRun | null>(null);
  const [stopping, setStopping] = useState(false);
  /** A Generate Immediately waiting on its confirm: the run to start on Proceed. */
  const [pendingImmediate, setPendingImmediate] = useState<(() => void) | null>(null);
  /** Aborted when the page goes: stops following and downloading, never the server's work by itself. */
  const pageAbortRef = useRef<AbortController | null>(null);
  /**
   * Set the moment this page releases its run because it is going - a
   * confirmed in-app link, `pagehide` - before the unmount aborts anything.
   * The release ends the run at once, and the stream can say so before the
   * navigation has unmounted the page; without this, that ending read as an
   * ordinary one and forgot the run, so coming back could neither say how it
   * ended nor download what it had finished.
   */
  const leavingRef = useRef(false);
  /**
   * The run's download bookkeeping. `downloadStartedRef` holds every task
   * whose files were asked for on THIS page - a snapshot repeats every finished
   * task, and one still downloading must not be started twice - plus the files
   * a page before a reload saved; `rememberedRef` is what survives a reload of
   * the tab (lib/immediateRun.ts), written file by file as each is saved.
   * `downloadChainRef` runs the downloads one at a time, in the order the
   * resumes finished. `savedFilesRef` counts the run's files that reached this
   * browser, starting from what the remembered list says was saved before.
   */
  const downloadStartedRef = useRef<Set<string>>(new Set());
  const rememberedRef = useRef<RememberedRun | null>(null);
  const downloadChainRef = useRef<Promise<void>>(Promise.resolve());
  const savedFilesRef = useRef(0);

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
  /**
   * How this tab's Generate Immediately run ended. Its own state, not
   * `successMessage`: the reset that clears the outputs whenever an input
   * changes also runs when the first load picks the profile - and a run
   * picked back up on that load said how it ended just before, and was wiped.
   * Replaced by the next run; cleared when a new build starts.
   */
  const [runNotice, setRunNotice] = useState('');
  /** The receipt for a placed order, kept as data so it can carry a link and a Cancel. */
  const [placedOrder, setPlacedOrder] = useState<PlacedOrder | null>(null);
  const [cancellingOrder, setCancellingOrder] = useState(false);
  /** A resume of the run that could not be downloaded, apart from the run's own failures. */
  const [downloadIssue, setDownloadIssue] = useState('');
  /**
   * Every finished resume of this tab's latest run, with its files - offered
   * again under the progress (components/ImmediateRunFiles), because a browser
   * that holds back a page's second automatic download does it silently.
   */
  const [runFiles, setRunFiles] = useState<{ batchId: string; items: PendingDownload[] } | null>(null);
  /** `<taskId>:<kind>` of the file a "download again" is fetching, or ''. */
  const [redownloading, setRedownloading] = useState('');
  /** The notices and progress under the header - brought into view when a run starts or fails below them. */
  const noticesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadInitialData();
    // Once, on mount. It reads `manyProfiles` to pick the starting target, and
    // that is settled by then: AuthGate renders this page only once the
    // account has loaded. A subscription that changes later is covered by
    // `generateMode` and `sheetsTargetMode` being derived from it, without
    // reloading every list on the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

      // An account that supports one profile starts on Single, whatever the
      // administrator's default target says.
      const startingSelection = startingResumeSelection(modelData.defaultResumeSelection, manyProfiles);
      if (startingSelection === 'single') {
        setGenerateMode('single');
        setMultipleTarget('group');
        setSelectedGroupId('');
        setSheetsTargetMode('single');
        setSelectedSheetsGroupId('');
      } else if (startingSelection === 'all') {
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
              todayTab: accountSheet.todayTab,
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
    let jobs = QUOTE_JOBS;
    if (builderMode === 'sheets') {
      target = sheetsRunProfiles;
      // Once rows are loaded the price is the run's: every loaded job for
      // every profile. Before, it is what one row costs.
      if (sheetJobCount) jobs = Array.from({ length: sheetJobCount }, () => QUOTE_JOBS[0]);
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
      jobs,
    };
    return { key: `${profileIds.join(',')}|${jobs.length}|${aiOverrides.modelId ?? ''}|${runRevision}`, body };
  }, [
    aiOverrides.modelId,
    autoGenerate,
    builderMode,
    generateMode,
    hasPreviews,
    manualRunProfiles,
    readyPreviewIds,
    runRevision,
    sheetJobCount,
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
      const needed = err.number('neededMilli');
      const balance = err.number('balanceMilli');
      setShortfall({
        message:
          needed !== undefined && balance !== undefined
            ? `This run needs ${formatMoney(needed)}, and your balance is ${formatMoney(balance)}.`
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

  // Keep a sheet selected: the account's own unless the administrator has
  // deliberately chosen a saved source that is still in the list.
  useEffect(() => {
    setSelectedSheetsSourceId((current) =>
      current && sheetImportSources.some((source) => source.id === current)
        ? current
        : sheetImportSources[0]?.id ?? ''
    );
  }, [sheetImportSources]);

  /**
   * The page's lifetime, and what it hands back when it ends.
   *
   * On mount: picks up this TAB's own Generate Immediately run after a reload.
   * Only one the server lists as running from this tab (`?active=1&tab=`,
   * `reattachTarget`) - never an order, another tab's run or another
   * account's: following those locked the page, held a lease from the wrong
   * tab, and downloaded somebody's resumes twice. Its stream from this tab
   * holds the run's lease again, and only the resumes this tab has not
   * downloaded yet are downloaded (the remembered set, lib/immediateRun.ts).
   *
   * A run this tab remembers that is no longer running ended while the page
   * was away - stopped when it was left or reloaded, or finished. Whatever it
   * built and this tab never downloaded is downloaded now, while the server
   * still keeps it, and the page says how it ended.
   *
   * On unmount - leaving Build Resumes inside the app, by any route - the
   * following stops and the run is released: Generate Immediately stops when
   * its page is left (owner decision B4). A link click asks first (below);
   * this is what makes the back button and every other way out stop it too.
   */
  useEffect(() => {
    const controller = new AbortController();
    pageAbortRef.current = controller;
    const { signal } = controller;

    const reattach = async () => {
      const tabId = currentTabId();
      const remembered = readRememberedRun(tabStorage(), tabId);
      const listed = await generationApi
        .listActive(tabId)
        .then((answer) => (Array.isArray(answer?.batches) ? answer.batches : []))
        .catch(() => null);
      if (signal.aborted) return;
      const { batchId } = reattachTarget(listed, remembered?.batchId ?? null);

      if (batchId) {
        setIsGenerating(true);
        try {
          const snapshot = await followRun(
            { batchId, tabId },
            { phase: 'Building resumes' },
            remembered?.batchId === batchId ? remembered.downloaded : []
          );
          if (signal.aborted) return;
          setRunNotice(`The run this tab started earlier: ${describeRunEnd(snapshot, savedFilesRef.current)}`);
        } finally {
          if (!signal.aborted) {
            setIsGenerating(false);
            setGenerationStep('');
            clearGenerationProgress();
            // Its failed and stopped resumes were refunded as it ran.
            afterRun();
          }
        }
        return;
      }

      // Not running any more - stopped when the page was left or reloaded, or
      // finished: what did it leave this tab to download?
      if (listed !== null && remembered) {
        const snapshot = await generationApi.snapshot(remembered.batchId, signal).catch(() => null);
        if (signal.aborted) return;
        if (snapshot && snapshot.state !== 'running') {
          trackDownloads(remembered);
          downloadFinished(remembered.batchId, snapshot);
          await downloadChainRef.current;
          if (signal.aborted) return;
          setRunNotice(
            `Your last run ended while this page was away (it stops when the page is left): ${describeRunEnd(snapshot, savedFilesRef.current)}`
          );
          afterRun();
        }
        // Only if it is still the one remembered: a run started while these
        // downloads went is the tab's run now, and a reload must find it.
        if (readRememberedRun(tabStorage(), tabId)?.batchId === remembered.batchId) forgetRun(tabStorage());
        if (rememberedRef.current?.batchId === remembered.batchId) rememberedRef.current = null;
      }
    };

    void reattach();
    return () => {
      controller.abort();
      const run = activeRunRef.current;
      if (run) {
        activeRunRef.current = null;
        releaseRun(run.batchId, run.tabId);
      }
    };
    // Deliberately once, on mount. Re-running this on every render would attach
    // a second reader to the same stream - and release the run on the way.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
   * While a run is going, leaving asks first and stops it.
   *
   * - Closing the tab, reloading, or going to another site: the browser's own
   *   leave prompt (`beforeunload`), then `pagehide` releases the run at once
   *   with a keepalive request that outlives the page. Without the release
   *   the server's grace timer stops it a little later; with it, nothing more
   *   is started for a page that is gone.
   * - A link to another page of the app: asked here, in the capture phase on
   *   `window` so it runs before Next's router sees the click. "Cancel" keeps
   *   the person, and the run, on this page; "OK" releases it and lets the
   *   navigation happen. (Any other way out - the back button - is the
   *   unmount above.)
   */
  useEffect(() => {
    if (!activeRun) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older browsers show the prompt only for a returnValue.
      event.returnValue = '';
    };
    const onPageHide = () => {
      const run = activeRunRef.current;
      if (!run) return;
      leavingRef.current = true;
      activeRunRef.current = null;
      releaseRun(run.batchId, run.tabId);
    };
    const onClick = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const leaving = leavesBuilder(
        { href: anchor.href, target: anchor.getAttribute('target'), download: anchor.hasAttribute('download') },
        event,
        { origin: window.location.origin, pathname: window.location.pathname }
      );
      if (!leaving || !activeRunRef.current) return;
      if (!window.confirm(LEAVE_CONFIRM)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      const run = activeRunRef.current;
      leavingRef.current = true;
      activeRunRef.current = null;
      releaseRun(run.batchId, run.tabId);
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('click', onClick, true);
    };
  }, [activeRun]);

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
   * The request for the manual form's job: one posting, for these profiles,
   * on the analysis the page already has - named by its `analysisId`, which
   * every profile's resume is built on - and, when finalising previews, each
   * profile's previewed content with the token naming the model that wrote it,
   * so it is charged at that model.
   *
   * No template: the server draws each resume with its profile's own
   * (services/templateChoice.ts). A role left empty is the posting's title.
   */
  const manualRunRequest = ({
    targetProfiles,
    analysis,
    tailoredContentByProfileId,
    previewTokenByProfileId,
  }: {
    targetProfiles: Profile[];
    analysis: HeldAnalysis<AnalyzedJob>;
    tailoredContentByProfileId?: Map<string, TailoredContent | undefined>;
    previewTokenByProfileId?: Map<string, string | undefined>;
  }): SubmitBatchRequest => {
    const tailoredByProfileId: Record<string, unknown> = {};
    const tokensByProfileId: Record<string, string> = {};
    for (const profile of targetProfiles) {
      const tailored = tailoredContentByProfileId?.get(profile.id);
      if (tailored) tailoredByProfileId[profile.id] = tailored;
      const token = previewTokenByProfileId?.get(profile.id);
      if (tailored && token) tokensByProfileId[profile.id] = token;
    }
    const targetCompanyName = companyName.trim();

    return {
      ...aiRequestOverrides,
      label: targetCompanyName,
      profileIds: targetProfiles.map((profile) => profile.id),
      jobs: [
        {
          companyName: targetCompanyName,
          role: (shouldShowRoleInput && role.trim()) || getAnalysisJobTitle(analysis.analysis),
          jobDescription,
          analysisId: analysis.analysisId,
        },
      ],
      ...(Object.keys(tailoredByProfileId).length > 0 ? { tailoredContentByProfileId: tailoredByProfileId } : {}),
      ...(Object.keys(tokensByProfileId).length > 0 ? { previewTokenByProfileId: tokensByProfileId } : {}),
      ...getDefaultGenerationOptions(),
    };
  };

  /**
   * This tab now follows `run`: what the leave guards, the Stop button and the
   * downloads all key on. `downloaded` is what a reload of the tab had already
   * saved, so it is not saved again.
   */
  const beginRun = (run: ActiveRun, downloaded: string[] = []) => {
    leavingRef.current = false;
    activeRunRef.current = run;
    setActiveRun(run);
    setRunNotice('');
    setStopping(false);
    setDownloadIssue('');
    setRunFiles(null);
    trackDownloads({ batchId: run.batchId, tabId: run.tabId, downloaded });
    revealNotices();
  };

  /**
   * Scrolls the notices under the header into view, if they are not: a sheet
   * run is started from the foot of a long panel, and its progress, Stop and
   * any refusal are drawn up here.
   */
  const revealNotices = () => {
    window.requestAnimationFrame(() => noticesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
  };

  /** Starts the download bookkeeping for a run, remembered in the tab so a reload can carry on. */
  const trackDownloads = (remembered: RememberedRun) => {
    rememberedRef.current = remembered;
    rememberRun(tabStorage(), remembered);
    downloadStartedRef.current = new Set(remembered.downloaded);
    downloadChainRef.current = Promise.resolve();
    // The files a page before a reload saved count too: "8 files" for a run
    // whose twelve all arrived read as four missing.
    savedFilesRef.current = savedFileCount(remembered.downloaded);
  };

  /**
   * The run is over for this page. Forgotten - unless the page itself is
   * going (unmounted, or released on its way out): then the remembered entry
   * is what lets this tab download what it missed, and say how the run ended,
   * when it comes back to Build Resumes.
   */
  const endRun = () => {
    activeRunRef.current = null;
    setActiveRun(null);
    setStopping(false);
    if (pageAbortRef.current?.signal.aborted || leavingRef.current) return;
    forgetRun(tabStorage());
    rememberedRef.current = null;
  };

  /**
   * Downloads every resume of the snapshot that has finished and was not
   * downloaded yet - each exactly once, one after another, in the order they
   * finished. Called with every snapshot of the run; `pendingDownloads` sees
   * through the repeats.
   */
  const downloadFinished = (batchId: string, snapshot: BatchSnapshot) => {
    setRunFiles({ batchId, items: pendingDownloads(snapshot.tasks ?? [], NONE_DOWNLOADED) });
    for (const item of pendingDownloads(snapshot.tasks ?? [], downloadStartedRef.current)) {
      downloadStartedRef.current.add(item.taskId);
      downloadChainRef.current = downloadChainRef.current.then(() => saveResume(batchId, item));
    }
  };

  const saveResume = async (batchId: string, item: PendingDownload) => {
    const signal = pageAbortRef.current?.signal;
    if (signal?.aborted) return;
    try {
      for (const kind of item.kinds) {
        await saveTaskFile(batchId, item, kind, signal);
        savedFilesRef.current += 1;
        // Remembered file by file, the moment each is handed over: a page that
        // goes away between a resume's first file and its last then saves only
        // the rest when it comes back - never one twice, never one skipped.
        const remembered = rememberedRef.current;
        if (remembered && remembered.batchId === batchId) {
          rememberedRef.current = withDownloaded(remembered, [downloadKey(item.taskId, kind)]);
          rememberRun(tabStorage(), rememberedRef.current);
        }
      }
    } catch (err) {
      if (signal?.aborted) return;
      setDownloadIssue(
        `Could not download the resume for ${item.companyName || 'this job'}` +
          `${item.profileName ? ` (${item.profileName})` : ''}: ${userMessage(err)}`
      );
    }
  };

  /** A file from the list under the progress, downloaded again on request. */
  const downloadAgain = async (batchId: string, item: PendingDownload, kind: DownloadKind) => {
    const key = `${item.taskId}:${kind}`;
    const signal = pageAbortRef.current?.signal;
    setRedownloading(key);
    setDownloadIssue('');
    try {
      await saveTaskFile(batchId, item, kind, signal);
    } catch (err) {
      if (signal?.aborted) return;
      setDownloadIssue(
        `Could not download the resume for ${item.companyName || 'this job'}` +
          `${item.profileName ? ` (${item.profileName})` : ''}: ${userMessage(err)}`
      );
    } finally {
      setRedownloading((current) => (current === key ? '' : current));
    }
  };

  /**
   * Generate Immediately: queues the run for THIS tab and follows it here,
   * downloading each resume as it lands.
   *
   * One request for every resume - the server queues them and hands them out
   * as seats come free, ahead of any orders on the same seat. The run is
   * leased to this tab (`tabId`, sent with the stream too): if the page goes,
   * or its stream drops for longer than the server's grace, whatever has not
   * started is stopped and refunded. Resolves with the last snapshot once the
   * last download has been handed to the browser.
   */
  const runImmediate = async (
    request: SubmitBatchRequest,
    describe: { phase: string; jobCount?: number }
  ): Promise<BatchSnapshot | null> => {
    const tabId = currentTabId();
    const submitted = await generationApi.submit({ ...request, mode: 'immediate', tabId });
    // Left while the submit was on its way: nothing here will follow the run,
    // so stop it now rather than leaving it to the server's grace.
    if (pageAbortRef.current?.signal.aborted) {
      releaseRun(submitted.batchId, tabId);
      return null;
    }
    return followRun({ batchId: submitted.batchId, tabId }, describe);
  };

  /** Follows this tab's run to its end, downloading as it goes. */
  const followRun = async (
    run: ActiveRun,
    describe: { phase: string; jobCount?: number },
    downloaded: string[] = []
  ): Promise<BatchSnapshot | null> => {
    beginRun(run, downloaded);
    try {
      const snapshot = await followBatch(run.batchId, describe, run.tabId);
      // The last resumes' files, before saying how it went.
      await downloadChainRef.current;
      return snapshot;
    } finally {
      endRun();
    }
  };

  /**
   * Order: places the run on the server and answers with an order number at
   * once. It is built whether or not anybody watches, and its files are
   * collected on the Orders page - for a sheet of three hundred rows, or
   * anybody who wants to close the tab.
   */
  const placeOrder = async (request: SubmitBatchRequest, skippedNote = '') => {
    const submitted = await generationApi.submit({ ...request, mode: 'order' });
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
      // A server that did not file it as an order. The work is queued either
      // way, so say so rather than leaving the click looking like it failed.
      setSuccessMessage(`Queued ${plural(submitted.total, 'resume')}.${skippedNote}`);
    }
  };

  /** Stop, beside the progress: what is queued is dropped and refunded, what is building is stopped. */
  const stopRun = async () => {
    const run = activeRunRef.current;
    if (!run) return;
    setStopping(true);
    try {
      await generationApi.cancel(run.batchId);
      // The stream's last line says it ended; following stops there.
    } catch (err) {
      setStopping(false);
      setError(err ?? 'Could not stop the run.');
    }
  };

  /** The receipt's order is over: it says how, and offers no Cancel. */
  const markReceiptEnded = (order: Order) => {
    setPlacedOrder((current) =>
      current && current.id === order.id && !current.cancelled
        ? { ...current, ended: { state: order.state, built: order.counts.done } }
        : current
    );
  };

  /** Cancel on the order receipt: what is left of it, refunded. */
  const cancelPlacedOrder = async () => {
    const order = placedOrder;
    if (!order || !window.confirm(cancelOrderQuestion(order.number))) return;
    setCancellingOrder(true);
    try {
      const outcome = await ordersApi.cancel(order.id);
      setPlacedOrder((current) => (current && current.id === order.id ? { ...current, cancelled: outcome } : current));
      afterRun();
    } catch (err) {
      // 409: there was nothing left to cancel - it finished between the poll
      // and the press. Not a failure to report: the receipt says how it ended.
      if (err instanceof ApiResponseError && err.status === 409) {
        const latest = await ordersApi.get(order.id).catch(() => null);
        if (latest) markReceiptEnded(latest);
        else
          setPlacedOrder((current) =>
            current && current.id === order.id && !current.cancelled ? { ...current, ended: { state: 'done' } } : current
          );
      } else {
        setError(err ?? 'Could not cancel that order.');
      }
    } finally {
      setCancellingOrder(false);
    }
  };

  /*
   * The receipt follows its order until it ends, reading it every few seconds
   * as /orders does - so it stops offering Cancel, and saying "being built",
   * for an order that has finished. It stops asking once the order is over,
   * cancelled from here, or the receipt is cleared.
   */
  const followedReceipt = placedOrder && !placedOrder.cancelled && !placedOrder.ended ? placedOrder.id : '';
  useEffect(() => {
    if (!followedReceipt) return;
    let stopped = false;
    const check = async () => {
      try {
        const order = await ordersApi.get(followedReceipt);
        if (!stopped && !isOrderLive(order)) markReceiptEnded(order);
      } catch {
        // Offline, or a restart in progress: the next tick asks again.
      }
    };
    const timer = window.setInterval(() => void check(), RECEIPT_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [followedReceipt]);

  /**
   * Generate Immediately asks first - unless "Don't show again" was ticked in
   * this browser - because closing the tab stops it (owner decision B4).
   */
  const withImmediateConfirm = (start: () => void) => {
    if (!confirmsImmediate(browserStorage())) {
      start();
      return;
    }
    setPendingImmediate(() => start);
  };

  /**
   * Watches a batch until it ends, driving the progress bar from its snapshots
   * - and, for this tab's run, downloading each resume as it finishes.
   *
   * `tabId` goes with the stream for this tab's own run: that open stream is
   * what holds the run's lease. Aborted with the page (`pageAbortRef`), which
   * stops the following and the downloads; stopping the RUN is the release.
   */
  const followBatch = async (
    batchId: string,
    describe: { phase: string; jobCount?: number },
    tabId?: string
  ): Promise<BatchSnapshot | null> => {
    const signal = pageAbortRef.current?.signal;
    let last: BatchSnapshot | null = null;
    const ownRun = () => activeRunRef.current?.batchId === batchId;

    const show = (snapshot: BatchSnapshot) => {
      last = snapshot;
      if (ownRun()) downloadFinished(batchId, snapshot);
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
     * reconciliation. Never given up on while the server can still be building
     * it (lib/batchFollow `nextAttach`): this tab's run always ends on the
     * server - finished, stopped, or cancelled by its lease once this tab's
     * stream has been gone for the grace - so the snapshot says so as soon as
     * the server is reachable again. Attaches that bring nothing only slow
     * down. A 404 - restarted or expired - stops it at once: asking again
     * cannot help.
     */
    let idleInARow = 0;
    for (;;) {
      if (signal?.aborted) break;
      let delivered = 0;
      try {
        await generationApi.follow(
          batchId,
          (snapshot) => {
            delivered += 1;
            show(snapshot);
          },
          signal,
          tabId
        );
      } catch {
        // A dropped stream is not a failed batch - the work is the server's.
        // Fall through to the snapshot below, which is the authority.
      }
      if (signal?.aborted) break;

      let gone = false;
      try {
        const snapshot: BatchSnapshot = await generationApi.snapshot(batchId, signal);
        last = snapshot;
        // A stream that dropped before its last lines still leaves finished
        // resumes to download.
        if (ownRun()) downloadFinished(batchId, snapshot);
      } catch (error) {
        // Anything but a 404 (offline, a restart in progress) keeps the last
        // snapshot and tries again.
        gone = error instanceof ApiResponseError && error.status === 404;
      }
      if (!last || (last as BatchSnapshot).state !== 'running') break;

      const next = nextAttach(idleInARow, { delivered, gone });
      if (next.stop) break;
      idleInARow = next.idleInARow;
      // A pause, so a server that is refusing the stream outright does not turn
      // this into a tight loop - cut short when the page goes.
      await pause(next.delayMs, signal);
    }

    return last;
  };

  /**
   * A finished run, in the shape the page reports: what was built, and the
   * resumes that FAILED. A resume the run stopped before it was built is not a
   * failure to report - it was refunded - but it is still one the previews
   * keep (`unbuiltProfileIds`), so finalising again builds only those.
   */
  const summarizeBatch = (snapshot: BatchSnapshot | null, fallbackCompany: string) => {
    const tasks = snapshot?.tasks ?? [];
    const failures: GenerationFailure[] = tasks
      .filter((task) => task.state === 'failed')
      .map((task) => ({
        profileId: task.profileId,
        profileName: task.profileName,
        companyName: task.companyName || fallbackCompany,
        error: task.error || 'This resume could not be built.',
      }));
    return {
      generated: snapshot?.completed ?? 0,
      failed: failures.length,
      failures,
      unbuiltProfileIds: tasks.filter((task) => task.state !== 'done').map((task) => task.profileId),
      failedCompanies: [...new Set(failures.map((failure) => failure.companyName))],
      unconfirmedHardSkills: snapshot?.unconfirmedHardSkills ?? [],
      unconfirmedSoftSkills: snapshot?.unconfirmedSoftSkills ?? [],
    };
  };

  /** How a Generate Immediately run ended, as the page's notices say it. */
  const reportImmediateEnd = (snapshot: BatchSnapshot | null, fallbackCompany: string, extra = '') => {
    const res = summarizeBatch(snapshot, fallbackCompany);
    setRunNotice(`${describeRunEnd(snapshot, savedFilesRef.current)}${extra}`);
    if (res.failed > 0) {
      setError(
        `Skipped ${res.failed} build(s). Failed companies: ${formatCompanySummary(res.failedCompanies) || fallbackCompany}. ${res.failures
          .slice(0, 3)
          .map((failure) => `${failure.profileName}: ${failure.error}`)
          .join(' | ')}${res.failures.length > 3 ? ' | ...' : ''}`
      );
    }
    return res;
  };

  /** What the manual form must have before anything runs, as the sentence to show; null when ready. */
  const manualFormProblem = (): string | null => {
    if (!companyName.trim()) return 'Please enter a company name';
    if (jobDescription.trim().length < 50) return 'Please provide a job description (minimum 50 characters)';
    if (generateMode === 'single' && !selectedProfileId) return 'Please select a profile';
    if (generateMode === 'multiple' && profiles.length === 0) return 'No profiles available';
    if (generateMode === 'multiple' && multipleTarget === 'group') {
      const selectedGroup = groups.find((group) => group.id === selectedGroupId);
      if (!selectedGroup) return 'Please select a group';
      if (!selectedGroup.profileIds.length) return 'Selected group has no members';
    }
    return null;
  };

  /**
   * The posting's analysis: the one this page holds, when it is for the
   * description on the page now - else asked for, and held. The server
   * analyses a posting once, ever, so asking again would cost no model call;
   * not asking is still the rule, because the page already knows the answer.
   */
  const ensureAnalysis = async (): Promise<HeldAnalysis<AnalyzedJob>> => {
    const held = heldAnalysisFor(heldAnalysis, jobDescription);
    if (held) return held;
    setGenerationStep('Analyzing job description...');
    const next = holdAnalysis(await resumeApi.analyze(jobDescription), jobDescription);
    setHeldAnalysis(next);
    return next;
  };

  /**
   * What a preview or generate request says about the posting: its stored
   * analysis by id when the page holds it, and the description either way -
   * without the id, the server finds the posting's analysis by its text.
   */
  const postingFields = (): { jobDescription: string; analysisId?: string } => {
    const held = heldAnalysisFor(heldAnalysis, jobDescription);
    return held ? { jobDescription, analysisId: held.analysisId } : { jobDescription };
  };

  /**
   * A request that named the held analysis failed with a 400 - which is what
   * an `analysisId` the server has no row for gets. Let it go, so the next
   * press asks /resume/analyze again (a stored posting is found by its text,
   * without a model).
   */
  const forgetAnalysisOn = (err: unknown) => {
    if (dropsHeldAnalysis(err)) setHeldAnalysis(null);
  };

  /** Everything a new manual run starts without: the previews, notices and receipt of the last. */
  const clearForManualRun = () => {
    setError('');
    setShortfall(null);
    setSuccessMessage('');
    setRunNotice('');
    setPlacedOrder(null);
    setDownloadIssue('');
    setPreviewHtml('');
    setPreviewTailored(false);
    setIsSinglePreviewOpen(false);
    resetTailoredEditor();
    setMultiplePreviews([]);
    setMultiplePreviewTailored(false);
    setMultiplePreviewIndex(0);
  };

  /**
   * Builds the manual form's job straight away (Auto-generate on): analysed,
   * then one run for the target profiles - Generate Immediately, followed and
   * downloaded here, or an Order (Multiple only), collected on Orders.
   */
  const runManual = async (kind: SheetRunKind) => {
    setIsGenerating(true);
    clearForManualRun();
    const targetCompanyName = companyName.trim();

    try {
      clearGenerationProgress();
      const analysis = await ensureAnalysis();

      const targetProfiles =
        generateMode === 'single'
          ? profiles.filter((profile) => profile.id === selectedProfileId)
          : getSelectedProfilesForManualBuilder();
      if (targetProfiles.length === 0) throw new Error('Please select a profile');
      const request = manualRunRequest({ targetProfiles, analysis });

      if (kind === 'order') {
        await placeOrder(request);
        return;
      }

      updateGenerationProgress(targetProfiles.length, 0, 'Queueing resumes', undefined, targetCompanyName);
      const snapshot = await runImmediate(request, { phase: 'Building resumes' });
      const res = reportImmediateEnd(snapshot, targetCompanyName);
      setUnconfirmedHardSkills(toUnconfirmedItems(res.unconfirmedHardSkills));
      setUnconfirmedSoftSkills(toUnconfirmedItems(res.unconfirmedSoftSkills));
    } catch (err) {
      forgetAnalysisOn(err);
      reportRunFailure(err, kind === 'order' ? 'Could not place that order.' : 'Failed to generate resume');
    } finally {
      setIsGenerating(false);
      setGenerationStep('');
      clearGenerationProgress();
      afterRun();
    }
  };

  /**
   * A sheet's loaded rows, built for the Build target: as an Order, or - once
   * confirmed - Generate Immediately in this tab.
   *
   * ONE request carrying every resume, not one per resume: the server queues
   * the lot and hands them out as seats come free. It names the sheet and tab
   * the rows came from, so the server reads their Analysis cells itself - a
   * row that holds its analysis is built on it and never analysed - and each
   * other posting is analysed once, by its first task, for every profile that
   * needs it. No analysis goes from this page. A row without a Job Title goes
   * without one - the server names the role from the posting's analysis
   * rather than from a guess typed on this page.
   */
  const handleSheetRun = (
    kind: SheetRunKind,
    jobs: SheetJob[],
    meta: { skippedRows: number; sheet: SheetRunSource }
  ) => {
    let selectedProfiles: Profile[];
    try {
      selectedProfiles = getSelectedProfilesForSheetsBuilder();
    } catch (err) {
      setError(err ?? 'Please choose who to build for.');
      return;
    }
    const request: SubmitBatchRequest = {
      ...aiRequestOverrides,
      label: `Google Sheet (${plural(jobs.length, 'job')})`,
      profileIds: selectedProfiles.map((profile) => profile.id),
      jobs: jobs.map((job) => ({
        companyName: job.companyName,
        role: job.jobTitle,
        jobDescription: job.jobDescription,
        ...(job.jobLink ? { jobLink: job.jobLink } : {}),
        sourceRowNumber: job.sourceRowNumber,
      })),
      sheet: meta.sheet,
      ...getDefaultGenerationOptions(),
    };
    const skippedNote = meta.skippedRows
      ? ` Skipped ${plural(meta.skippedRows, 'row')} with no company or no job description.`
      : '';
    const start = () => void runSheet(kind, request, skippedNote, jobs.length);
    if (kind === 'immediate') withImmediateConfirm(start);
    else start();
  };

  const runSheet = async (kind: SheetRunKind, request: SubmitBatchRequest, skippedNote: string, jobCount: number) => {
    setIsGenerating(true);
    setError('');
    setShortfall(null);
    setSuccessMessage('');
    setRunNotice('');
    setDownloadIssue('');
    resetGenerationOutputs();

    try {
      if (kind === 'order') {
        await placeOrder(request, skippedNote);
        return;
      }
      updateGenerationProgress((request.profileIds?.length ?? 0) * jobCount, 0, 'Queueing resumes', undefined, undefined, undefined, undefined, jobCount);
      const snapshot = await runImmediate(request, { phase: 'Building resumes', jobCount });
      reportImmediateEnd(snapshot, '', skippedNote);
    } catch (err) {
      reportRunFailure(err, kind === 'order' ? 'Could not place that order.' : 'Could not build from the sheet.');
    } finally {
      // The receipt, the refusal or how the run ended - all drawn up top.
      revealNotices();
      setIsGenerating(false);
      setGenerationStep('');
      clearGenerationProgress();
      afterRun();
    }
  };

  /** The manual header's primary: Analyze & Preview, or - Auto-generate on - Generate Immediately. */
  const handleGenerate = async () => {
    const problem = manualFormProblem();
    if (problem) {
      setError(problem);
      return;
    }
    if (autoGenerate) {
      withImmediateConfirm(() => void runManual('immediate'));
      return;
    }

    setIsGenerating(true);
    clearForManualRun();

    try {
      clearGenerationProgress();
      const analysis = await ensureAnalysis();

      if (generateMode === 'single') {
        setGenerationStep('Building preview...');
        const profile = profiles.find((p) => p.id === selectedProfileId);
        const templateId = profile?.preferredTemplate || 'default';
        const preview = await resumeApi.preview({
          ...aiRequestOverrides,
          profileId: selectedProfileId!,
          templateId,
          jobDescription,
          analysisId: analysis.analysisId,
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
        setSuccessMessage('Preview generated. Review, edit manually if needed, then click Generate Immediately to build it.');
        return;
      }

      const profileIds =
        multipleTarget === 'group' ? groups.find((group) => group.id === selectedGroupId)?.profileIds : undefined;
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
        analysisId: analysis.analysisId,
        profileIds,
      });
      const previewsWithDrafts = res.previews.map((preview) => ({
        ...preview,
        draft: preview.tailoredContent ? JSON.stringify(preview.tailoredContent, null, 2) : '',
        error: '',
      }));
      setMultiplePreviews(previewsWithDrafts);
      setMultiplePreviewTailored(res.tailored);
      setMultiplePreviewIndex(0);
      const aggregated = aggregateUnconfirmedFromPreviews(previewsWithDrafts);
      setUnconfirmedHardSkills(aggregated.hard);
      setUnconfirmedSoftSkills(aggregated.soft);
      setSuccessMessage(
        `Preview generated for ${res.previews.length} profile(s). Review, then Generate Immediately or Order to build them.`
      );
    } catch (err) {
      forgetAnalysisOn(err);
      reportRunFailure(err, 'Failed to build the preview');
    } finally {
      setIsGenerating(false);
      setGenerationStep('');
      clearGenerationProgress();
    }
  };

  /** Order beside Generate Immediately, on manual Multiple with Auto-generate on. */
  const handleOrderManual = () => {
    const problem = manualFormProblem();
    if (problem) {
      setError(problem);
      return;
    }
    void runManual('order');
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
            ...postingFields(),
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
                ...postingFields(),
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
      // Not `forgetAnalysisOn`: a 400 here is as likely the skill's own refusal,
      // which says nothing about the analysis the page holds.
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
        ...postingFields(),
        tailoredContent,
      });
      setPreviewHtml(preview.html);
      setPreviewTailored(preview.tailored);
      setIsSinglePreviewOpen(true);
      setUnconfirmedHardSkills(toUnconfirmedItems(preview.tailoredContent?.unconfirmedHardSkills));
      setUnconfirmedSoftSkills(toUnconfirmedItems(preview.tailoredContent?.unconfirmedSoftSkills));
      setSuccessMessage('Preview updated.');
    } catch (err) {
      forgetAnalysisOn(err);
      setError(err ?? 'Failed to update preview.');
    } finally {
      setIsGenerating(false);
      setGenerationStep('');
    }
  };

  /**
   * The single preview's Generate Immediately: the previewed content, built as
   * a one-resume run in this tab - queued like any other, so it downloads,
   * stops and refunds the way every Generate Immediately does - and charged at
   * the model that wrote it (its preview token).
   */
  const handleFinalizeGenerate = () => {
    if (!companyName.trim() || jobDescription.trim().length < 50 || !selectedProfileId) {
      setError('Please complete the required fields before generating.');
      return;
    }
    if (tailoredContentError) {
      setError('Fix manual edits before generating.');
      return;
    }
    withImmediateConfirm(() => void finalizeSingle());
  };

  const finalizeSingle = async () => {
    setIsGenerating(true);
    setError('');
    setShortfall(null);
    setSuccessMessage('');
    setRunNotice('');
    setPlacedOrder(null);

    const targetCompanyName = companyName.trim();
    try {
      const analysis = await ensureAnalysis();
      const profile = profiles.find((p) => p.id === selectedProfileId);
      if (!profile) throw new Error('Please select a profile');
      // The progress and its Stop are on the page, under the dialog: close it.
      // "Open Preview" brings it back if the run is stopped.
      setIsSinglePreviewOpen(false);
      updateGenerationProgress(1, 0, 'Building resume', profile.name, targetCompanyName);
      const snapshot = await runImmediate(
        manualRunRequest({
          targetProfiles: [profile],
          analysis,
          tailoredContentByProfileId: new Map([[profile.id, tailoredContent ?? undefined]]),
          previewTokenByProfileId: new Map([[profile.id, previewToken ?? undefined]]),
        }),
        { phase: 'Building resume' }
      );
      const res = reportImmediateEnd(snapshot, targetCompanyName);
      setUnconfirmedHardSkills(toUnconfirmedItems(res.unconfirmedHardSkills));
      setUnconfirmedSoftSkills(toUnconfirmedItems(res.unconfirmedSoftSkills));
    } catch (err) {
      forgetAnalysisOn(err);
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
        ...postingFields(),
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
      forgetAnalysisOn(err);
      setError(err ?? 'Failed to update preview.');
    } finally {
      setIsGenerating(false);
      setGenerationStep('');
    }
  };

  /**
   * The multi-profile preview's two ways to build: Generate Immediately in
   * this tab (asked first), or Order.
   */
  const handleFinalizeGenerateMultiple = (kind: SheetRunKind) => {
    if (!companyName.trim() || jobDescription.trim().length < 50) {
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
    const start = () => void finalizeMultiple(kind);
    if (kind === 'immediate') withImmediateConfirm(start);
    else start();
  };

  const finalizeMultiple = async (kind: SheetRunKind) => {
    setIsGenerating(true);
    setError('');
    setShortfall(null);
    setSuccessMessage('');
    setRunNotice('');
    setPlacedOrder(null);

    const targetCompanyName = companyName.trim();
    try {
      const analysis = await ensureAnalysis();

      const previewMap = new Map(multiplePreviews.map((p) => [p.profileId, p]));
      const profilesToGenerate = manualRunProfiles.filter((profile) => previewMap.get(profile.id)?.tailoredContent);
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
      const request = manualRunRequest({
        targetProfiles: profilesToGenerate,
        analysis,
        tailoredContentByProfileId: new Map(
          profilesToGenerate.map((profile) => [profile.id, previewMap.get(profile.id)?.tailoredContent])
        ),
        previewTokenByProfileId: new Map(
          profilesToGenerate.map((profile) => [profile.id, previewMap.get(profile.id)?.previewToken])
        ),
      });

      if (kind === 'order') {
        await placeOrder(request);
        // Placed: every previewed resume is on its way, so none is left to finalise.
        setMultiplePreviews([]);
        setMultiplePreviewIndex(0);
        setMultiplePreviewTailored(false);
        return;
      }

      updateGenerationProgress(profilesToGenerate.length, 0, 'Queueing resumes', undefined, targetCompanyName);
      const snapshot = await runImmediate(request, { phase: 'Building resumes' });
      const res = reportImmediateEnd(snapshot, targetCompanyName);
      // Only the previews that did NOT become a resume stay, so finalising
      // again builds - and charges for - just those.
      const remaining = keepUnbuiltPreviews(multiplePreviews, res.unbuiltProfileIds);
      const aggregated = aggregateUnconfirmedFromPreviews(multiplePreviews);
      setUnconfirmedHardSkills(aggregated.hard);
      setUnconfirmedSoftSkills(aggregated.soft);
      setMultiplePreviews(remaining);
      setMultiplePreviewIndex(0);
      if (remaining.length === 0) setMultiplePreviewTailored(false);
    } catch (err) {
      reportRunFailure(err, kind === 'order' ? 'Could not place that order.' : 'Failed to generate resume');
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
          The page's primary action lives in the title row, where it always was
          in spirit - it sat above the fields, not under them - when building by
          hand: Analyze & Preview, or Generate Immediately (and, for several
          profiles, Order beside it). A sheet's two actions sit under the rows
          they build, in the sheet panel. Back, Open Preview once a preview has
          been closed, and Stop while a run goes, are the quiet ones beside it.
        */}
        <PageHeader
          title="Build Resumes"
          description="Tailor a resume to a job description, for one profile, a group, or every row of a Google Sheet."
          actions={
            builderMode !== null && (
              <>
                {/* No shortfall here: the notice under the header carries it. */}
                {builderMode === 'manual' && (
                  <CostLine
                    quote={quote}
                    label={
                      autoGenerate
                        ? 'This run'
                        : // The button previews, which is free; generating is what costs.
                          'Generating'
                    }
                  />
                )}
                <button
                  type="button"
                  onClick={() => setBuilderMode(null)}
                  disabled={isGenerating}
                  className={`tl-button-quiet ${styles.pill}`}
                >
                  Back
                </button>
                {builderMode === 'manual' && generateMode === 'single' && previewHtml && !isSinglePreviewOpen && (
                  <button
                    type="button"
                    onClick={() => setIsSinglePreviewOpen(true)}
                    disabled={isGenerating}
                    className={`tl-button-quiet ${styles.pill}`}
                  >
                    Open Preview
                  </button>
                )}
                {builderMode === 'manual' && generateMode === 'multiple' && autoGenerate && !isGenerating && (
                  <button
                    type="button"
                    onClick={handleOrderManual}
                    className={`tl-button-quiet ${styles.pill}`}
                    title="Built on the server whether or not this page stays open; collect the files on Orders"
                  >
                    Order ({plural(manualRunProfiles.length, 'profile')})
                  </button>
                )}
                {builderMode === 'manual' && (
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
                    ) : !autoGenerate ? (
                      'Analyze & Preview'
                    ) : generateMode === 'single' ? (
                      'Generate Immediately'
                    ) : (
                      `Generate Immediately (${plural(manualRunProfiles.length, 'profile')})`
                    )}
                  </button>
                )}
              </>
            )
          }
        />

        <div ref={noticesRef} className="mb-6 scroll-mt-20 space-y-3 empty:hidden">
          <ErrorNotice error={error} onDismiss={() => setError('')} />
          <ErrorNotice error={downloadIssue} onDismiss={() => setDownloadIssue('')} />

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
            <Notice tone="success" className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
              <div className="min-w-0">
                <p className="font-semibold">
                  You ordered successfully: Order number -{' '}
                  <span className="font-mono">{placedOrder.number}</span>
                </p>
                {placedOrder.cancelled ? (
                  <p className="mt-1">
                    Cancelled: {describeCancelOutcome(placedOrder.cancelled)} Anything already built is under{' '}
                    <Link href={`/orders/${placedOrder.id}`} className="font-semibold underline underline-offset-2">
                      Order status &amp; built resumes
                    </Link>
                    .
                  </p>
                ) : placedOrder.ended ? (
                  <p className="mt-1">
                    {placedOrder.ended.state === 'cancelled' ? 'This order was cancelled' : 'This order has finished'}
                    {placedOrder.ended.built !== undefined
                      ? `: ${placedOrder.ended.built} of ${plural(placedOrder.total, 'resume')} built`
                      : ''}{' '}
                    - see{' '}
                    <Link href={`/orders/${placedOrder.id}`} className="font-semibold underline underline-offset-2">
                      Order status &amp; built resumes
                    </Link>
                    .
                  </p>
                ) : (
                  <p className="mt-1">
                    {plural(placedOrder.total, 'resume')} for {plural(placedOrder.jobCount, 'job')} across{' '}
                    {plural(placedOrder.profileCount, 'profile')} {placedOrder.total === 1 ? 'is' : 'are'} being
                    built. You can close this page - they are waiting for you under{' '}
                    <Link href={`/orders/${placedOrder.id}`} className="font-semibold underline underline-offset-2">
                      Order status &amp; built resumes
                    </Link>
                    .{placedOrder.skippedNote}
                  </p>
                )}
              </div>
              {!placedOrder.cancelled && !placedOrder.ended && (
                <button
                  type="button"
                  onClick={() => void cancelPlacedOrder()}
                  disabled={cancellingOrder}
                  className="tl-button-quiet shrink-0"
                  data-tone="danger"
                  data-size="sm"
                >
                  {cancellingOrder ? 'Cancelling...' : 'Cancel order'}
                </button>
              )}
            </Notice>
          )}

          {successMessage && <Notice tone="success">{successMessage}</Notice>}
          {runNotice && <Notice tone="success">{runNotice}</Notice>}

          {activeRun && generationProgress && (
            <RunProgress progress={generationProgress} stopping={stopping} onStop={() => void stopRun()} />
          )}

          {runFiles && runFiles.items.length > 0 && (
            <ImmediateRunFiles
              items={runFiles.items}
              running={activeRun?.batchId === runFiles.batchId}
              downloading={redownloading}
              onDownload={(item, kind) => void downloadAgain(runFiles.batchId, item, kind)}
              onDismiss={() => setRunFiles(null)}
            />
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
                Pick a tab and rows of your Google Sheet, then build every selected profile against every row - right away, or as an order.
              </span>
            </span>
          </button>
          </div>
        )}

        {builderMode !== null && (builderMode === 'manual' ? (
          <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
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

                {/*
                  Optional now: every queued build is filed under the order
                  tree, which names no job title, and a role left empty is the
                  one the posting's analysis reads (the server's own rule).
                */}
                {shouldShowRoleInput && (
                  <div>
                    <label className="tl-label">Role</label>
                    <input
                      type="text"
                      value={role}
                      onChange={(e) => setRole(e.target.value)}
                      disabled={isGenerating}
                      placeholder="Taken from the job description when left empty"
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
                  {/*
                    What the posting's one analysis read, once there is one:
                    every profile and model built on this description uses it,
                    and editing the text makes it another posting.
                  */}
                  {currentAnalysis && (
                    <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                      <span className="text-subtle">Analysed as</span>
                      <AnalysisFacts analysis={currentAnalysis.analysis} withTitle />
                    </div>
                  )}
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
                      <label
                        className="tl-choice"
                        data-on={generateMode === 'multiple'}
                        title={manyProfiles ? undefined : ONE_PROFILE_NOTE}
                      >
                        <input
                          type="radio"
                          name="generateMode"
                          value="multiple"
                          checked={generateMode === 'multiple'}
                          onChange={() => setGenerateMode('multiple')}
                          disabled={isGenerating || !manyProfiles}
                        />
                        <span className="text-sm font-medium text-ink">Multiple (all profiles)</span>
                        {!manyProfiles && <PremiumLock />}
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
                    <p className="text-sm text-subtle">
                      It tailors each resume and writes its cover letter. The job description itself is
                      analysed once, the same way for every profile and every model.
                    </p>
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
          /*
            `grid-cols-1` is `minmax(0, 1fr)`: without an explicit track the one
            column below xl sizes to its content, and the loaded rows' table
            widened the whole page on a phone instead of scrolling in its box.
          */
          <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
            {/*
              First in the source so a phone reads what this mode does - and
              why it cannot run yet - before the fields; beside them from xl up.
            */}
            <div className="space-y-3 xl:col-start-2 xl:row-start-1">
              <Notice tone="info">
                Each row of the tab is one job. Load the rows to check them, then build every selected
                profile against every row: <strong>Generate Immediately</strong> builds them while this
                page stays open and downloads each resume as it is ready; <strong>Order</strong> builds
                them on the server, to collect on the Orders page.
              </Notice>

              {!hasImportableSheet && (
                <Notice tone="warn">
                  {sheetImportNotice}
                </Notice>
              )}
            </div>

            <div className="space-y-6 xl:col-start-1 xl:row-start-1">
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
                      <label
                        className="tl-choice"
                        data-on={sheetsTargetMode === 'all'}
                        title={manyProfiles ? undefined : ONE_PROFILE_NOTE}
                      >
                        <input
                          type="radio"
                          name="sheetsTargetMode"
                          value="all"
                          checked={sheetsTargetMode === 'all'}
                          onChange={() => setSheetsTargetMode('all')}
                          disabled={isGenerating || !manyProfiles}
                        />
                        <span className="text-sm font-medium text-ink">All profiles</span>
                        {!manyProfiles && <PremiumLock />}
                      </label>
                      <label
                        className="tl-choice"
                        data-on={sheetsTargetMode === 'group'}
                        title={manyProfiles ? undefined : ONE_PROFILE_NOTE}
                      >
                        <input
                          type="radio"
                          name="sheetsTargetMode"
                          value="group"
                          checked={sheetsTargetMode === 'group'}
                          onChange={() => setSheetsTargetMode('group')}
                          disabled={isGenerating || !manyProfiles}
                        />
                        <span className="text-sm font-medium text-ink">Specific group</span>
                        {!manyProfiles && <PremiumLock />}
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

                  {/*
                    Shown locked rather than left out, like the two targets
                    above it: the page says what a Premium subscription adds,
                    instead of a Default account never learning groups exist.
                  */}
                  {!manyProfiles && (
                    <div title={ONE_PROFILE_NOTE}>
                      <div className="flex items-center gap-2">
                        <label htmlFor="sheets-group-locked" className="tl-label">
                          Select Group
                        </label>
                        <PremiumLock />
                      </div>
                      <select id="sheets-group-locked" value="" disabled className="tl-input mt-2">
                        <option value="">Building for a group needs Premium</option>
                      </select>
                    </div>
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

                </div>
              </Card>

              <SheetsSourcePanel
                sources={sheetImportSources}
                selectedSourceId={selectedSheetsSourceId}
                onSelectSource={setSelectedSheetsSourceId}
                busy={isGenerating}
                onRowsChange={setSheetJobCount}
                onRun={handleSheetRun}
                costLine={<CostLine quote={quote} label={sheetJobCount ? 'This run' : 'Each sheet row'} />}
              />
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
                  <AnalysisFacts analysis={currentAnalysis?.analysis} />
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
                    type="button"
                    onClick={() => handleFinalizeGenerateMultiple('order')}
                    disabled={isGenerating}
                    className="tl-button-quiet"
                    title="Built on the server whether or not this page stays open; collect the files on Orders"
                  >
                    Order
                  </button>
                  <button
                    onClick={() => handleFinalizeGenerateMultiple('immediate')}
                    disabled={isGenerating}
                    className={`tl-button ${styles.wrap}`}
                  >
                    {isGenerating ? generationStep || 'Generating...' : 'Generate Immediately'}
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
                    activeRun ? (
                      <RunProgress
                        progress={generationProgress}
                        stopping={stopping}
                        onStop={() => void stopRun()}
                        className="mb-4"
                      />
                    ) : (
                      <GenerationProgress progress={generationProgress} className="mb-4" />
                    )
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
            generateLabel="Generate Immediately"
            isGenerating={isGenerating}
            isTailored={previewTailored}
            isOpen={isSinglePreviewOpen}
            onClose={() => setIsSinglePreviewOpen(false)}
            generationStep={generationStep}
            costNote={<CostLine quote={quote} shortfall={shortfall} />}
            titleNote={<AnalysisFacts analysis={currentAnalysis?.analysis} />}
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

      {pendingImmediate && (
        <ImmediateRunConfirm
          onCancel={() => setPendingImmediate(null)}
          onProceed={(dontShowAgain) => {
            if (dontShowAgain) skipImmediateConfirm(browserStorage());
            const start = pendingImmediate;
            setPendingImmediate(null);
            start();
          }}
        />
      )}

      {/* Footer */}
      <footer className="mt-auto py-6 text-center text-sm text-subtle">
        <p>Tailor</p>
      </footer>
    </>
  );
}
