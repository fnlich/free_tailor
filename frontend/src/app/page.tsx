'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import Link from 'next/link';
import {
  ApiResponseError,
  resumesApi,
  profilesApi,
  resumeApi,
  DEFAULT_USER_APP_SETTINGS,
  UserAppSettings,
  AiPreferences,
  isInsufficientCredits,
  normalizeAiPreferences,
  toAiRequestOverrides,
  Resume,
  type AnalyzedJob,
  type HeldTailoredContent,
  type ProfileSummary,
  type TaskMatch,
} from '@/lib/api';
import { dropsHeldAnalysis, heldAnalysisFor, holdAnalysis, type HeldAnalysis } from '@/lib/jobAnalysis';
import { readTailoredDraft, TAILORED_DRAFT_NOTE, tailoredDraftOf } from '@/lib/tailoredDraft';
import AnalysisFacts from '@/components/AnalysisFacts';
import {
  currentTabId,
  estimateRun,
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
import ImmediateRunFiles from '@/components/ImmediateRunFiles';
import SheetsSourcePanel, { type SheetRunKind, type SheetRunSource } from '@/components/SheetsSourcePanel';
import CostLine, { type CreditShortfall } from '@/components/builder/CostLine';
import BuildModeChoice from '@/components/builder/BuildModeChoice';
import OrderReceipt, { placedOrderFrom, type PlacedOrder } from '@/components/orders/OrderReceipt';
import { useSpendConfirm } from '@/components/SpendConfirm';
import { useAuth } from '@/contexts/AuthContext';
import { sheetApi, type AccountSheet } from '@/lib/sheet';
import type { SheetJob } from '@/lib/sheetRows';
import { applyTheme, getStoredTheme, setStoredDefaultTheme } from '@/lib/theme';
import { Card, ErrorNotice, Notice, Page, PageHeader, Pill, Spinner } from '@/components/ui/kit';
import { userMessage } from '@/lib/userMessage';
import { formatMoney } from '@/lib/format';
import { nextAttach, reattachTarget } from '@/lib/batchFollow';
import { BUILD_MODE_PRICE_SETTINGS, type BuildMode } from '@/lib/buildModes';
import { describeChoice } from '@/lib/orders';
import { resumeLabel } from '@/lib/profileDashboard';
import {
  buildModeNote,
  defaultRunFormat,
  profileBlocker,
  startingBuildMode,
  startingProfileId,
} from '@/lib/runChoices';
import {
  describeRunEnd,
  downloadKey,
  forgetRun,
  leavesBuilder,
  pendingDownloads,
  readRememberedRun,
  rememberRun,
  savedFileCount,
  withDownloaded,
  type DownloadKind,
  type PendingDownload,
  type RememberedRun,
} from '@/lib/immediateRun';
import { IconBuild, IconChevronRight, IconTemplates } from '@/components/icons';
import styles from '@/components/builder.module.css';

type BuilderMode = 'manual' | 'sheets' | null;

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

/**
 * Which resume the preview on screen drew, and why: the server's answer to
 * the preview request. `resumeId` is what finalising sends back as
 * `previewedResumeId` (the run checks it would build that very resume), and
 * what Update Preview names; `match` is the matcher's explanation, kept
 * through re-renders of edited content (the server answers none for those).
 */
type PreviewChoice = {
  resumeId: string;
  resumeLabel: string;
  match: TaskMatch | null;
  mode: BuildMode;
};

type GenerationFailure = {
  resumeId: string;
  resumeName: string;
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
 * A placeholder, because what a resume costs is the price of its build mode
 * and never depends on the job - and the quote is wanted before
 * anybody has typed a company name. The server still validates a quote's jobs
 * the way it validates a real submission's, so this one is complete.
 */
const QUOTE_JOBS: SubmitBatchRequest['jobs'] = [{ companyName: 'Quote', role: 'Quote' }];

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

/** What the resume a preview drew was, by the mode that chose it: the success notice's "the ... for this job". */
function previewChoiceWords(mode: BuildMode): string {
  if (mode === 'suitable') return 'suitable resume';
  if (mode === 'full') return 'default resume';
  return 'resume Partial Tailor chose';
}

/**
 * What a quote is asked about before a run spends credit: the profile it
 * builds for, the build mode (a resume costs the price of its mode, whatever
 * model runs it), as many placeholder jobs as it has postings, the model
 * chosen for this run, and - when finalising a preview - what the submission
 * will carry of it: the previewed content, and the token naming the mode that
 * wrote it. Both, because the server prices them together: content whose token
 * is valid for this resume and mode is charged that mode's price, while
 * content whose token has expired (a day on) or was never given is charged at
 * least the dearer tailoring mode. Quoted with the tokens alone, such a run
 * showed the cheaper price and was charged more than the alert said.
 */
function quoteBody(
  overrides: Pick<SubmitBatchRequest, 'model'>,
  profileId: string,
  buildMode: BuildMode,
  jobCount = 1,
  previews: Pick<SubmitBatchRequest, 'tailoredContentByResumeId' | 'previewTokenByResumeId'> = {}
): SubmitBatchRequest {
  const { tailoredContentByResumeId = {}, previewTokenByResumeId = {} } = previews;
  return {
    ...overrides,
    profileId,
    buildMode,
    jobs: Array.from({ length: Math.max(1, jobCount) }, () => QUOTE_JOBS[0]),
    ...(Object.keys(tailoredContentByResumeId).length > 0 ? { tailoredContentByResumeId } : {}),
    ...(Object.keys(previewTokenByResumeId).length > 0 ? { previewTokenByResumeId } : {}),
  };
}

/**
 * A Generate Immediately run's progress, with the way to stop it - in either
 * builder mode.
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
  /** What is asked before a run spends credit (Generate Immediately always, Order when it costs). */
  const spend = useSpendConfirm();
  /** The resumes the account can build (enabled ones): the default resume's label and model come from here. */
  const [resumes, setResumes] = useState<Resume[]>([]);
  /** The profiles a run can build for: those with an enabled resume, newest edit first. */
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [builderMode, setBuilderMode] = useState<BuilderMode>(null);
  /** The ONE profile a run builds (a person, every tier), for both ways of building. */
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  /** How the run builds it: the mode is the run's, and so is its price. */
  const [buildModeChoice, setBuildModeChoice] = useState<BuildMode>('partial');
  /**
   * The model for THIS run only.
   *
   * Empty means every field falls through to the chosen resume's own
   * setting, and then to the app default - nothing here is persisted.
   */
  const [aiOverrides, setAiOverrides] = useState<AiPreferences>({});
  const [accountSheet, setAccountSheet] = useState<AccountSheet | null>(null);
  const [companyName, setCompanyName] = useState('');
  const [role, setRole] = useState('');
  const [jobDescription, setJobDescription] = useState('');
  const [modelSettings, setModelSettings] = useState<UserAppSettings>(DEFAULT_USER_APP_SETTINGS);
  /** Whether `modelSettings` is the server's answer, rather than the empty stand-in. */
  const [modelsLoaded, setModelsLoaded] = useState(false);
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
   * role, the resume and the model are not the posting, and a change of any
   * of them builds on the same analysis - sent by its `analysisId`, never
   * asked for again. Editing the description is another posting, which
   * `heldAnalysisFor` sees for itself.
   */
  const [heldAnalysis, setHeldAnalysis] = useState<HeldAnalysis<AnalyzedJob> | null>(null);
  const currentAnalysis = heldAnalysisFor(heldAnalysis, jobDescription);
  const [previewHtml, setPreviewHtml] = useState('');
  const [previewTailored, setPreviewTailored] = useState(false);
  const [isSinglePreviewOpen, setIsSinglePreviewOpen] = useState(false);
  /** The preview's content: the server's answer, or - after an edit in Manual Edits - the person's edit of it (lib/tailoredDraft.ts). */
  const [tailoredContent, setTailoredContent] = useState<HeldTailoredContent | null>(null);
  /**
   * The server's word for which mode wrote `tailoredContent`. Sent back when
   * finalising, so the resume is charged at the mode that did the work rather
   * than whatever the cards say by then. Kept through manual edits and
   * re-renders: they are still that mode's work.
   */
  const [previewToken, setPreviewToken] = useState<string | null>(null);
  /** The resume the preview drew and why it was chosen; null with no preview open. */
  const [previewChoice, setPreviewChoice] = useState<PreviewChoice | null>(null);
  const [tailoredContentDraft, setTailoredContentDraft] = useState('');
  const [tailoredContentError, setTailoredContentError] = useState('');
  const [autoGenerate, setAutoGenerate] = useState(false);
  /** How many jobs the sheet panel's loaded rows hold; null until rows are loaded. */
  const [sheetJobCount, setSheetJobCount] = useState<number | null>(null);
  /** The Generate Immediately run being followed, for what the page draws. `activeRunRef` is the same, for handlers. */
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null);
  const activeRunRef = useRef<ActiveRun | null>(null);
  const [stopping, setStopping] = useState(false);
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
  /**
   * The run buttons wait from a press until the run starts or is declined:
   * between the two, the confirm is pricing the run (POST /generation/quote),
   * nothing is open yet and another press is ignored - so the button that
   * builds says what is happening rather than looking dead.
   */
  const runBusy = isGenerating || spend.pending;
  const runStep = spend.pending ? 'Checking the price...' : generationStep;
  const [generationProgress, setGenerationProgress] = useState<GenerationProgressState | null>(null);
  /**
   * What went wrong: one of the page's own sentences ("Please select a
   * resume"), or the failure itself, which <ErrorNotice> words for the reader
   * and - for an administrator - follows with the server's detail.
   */
  const [error, setError] = useState<unknown>('');
  const [successMessage, setSuccessMessage] = useState('');
  /**
   * How this tab's Generate Immediately run ended. Its own state, not
   * `successMessage`: the reset that clears the outputs whenever an input
   * changes also runs when the first load picks the resume - and a run
   * picked back up on that load said how it ended just before, and was wiped.
   * Replaced by the next run; cleared when a new build starts.
   */
  const [runNotice, setRunNotice] = useState('');
  /** The receipt for a placed order, kept as data so it can carry a link and a Cancel (components/orders/OrderReceipt). */
  const [placedOrder, setPlacedOrder] = useState<PlacedOrder | null>(null);
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
    // Once, on mount: the profiles, resumes, models and sheet are read here,
    // and a run re-reads only what it moves (the balance).
  }, []);

  const resetTailoredEditor = useCallback(() => {
    setTailoredContent(null);
    setPreviewToken(null);
    setPreviewChoice(null);
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
    // A refusal for want of credit was about THAT run (its profile, mode and model): the figure in it
    // is not the next one's.
    setShortfall(null);
  }, [resetTailoredEditor]);

  // The mode and the model too: a preview is that mode's work, written by that
  // model, and the cost line, the cards and the finalise must all be about the
  // same one. Leaving a preview up across a change of either priced it at the
  // new one.
  useEffect(() => {
    resetGenerationOutputs();
  }, [builderMode, companyName, role, jobDescription, selectedProfileId, buildModeChoice, aiOverrides.modelId, resetGenerationOutputs]);

  const selectedProfile = profiles.find((profile) => profile.id === selectedProfileId) ?? null;
  /** The chosen profile's default resume: what Fully Tailor builds, and where its model and label come from. */
  const defaultResume = resumes.find((resume) => resume.id === selectedProfile?.defaultResumeId) ?? null;
  const defaultResumeLabel = defaultResume ? resumeLabel(defaultResume) : null;
  const aiRequestOverrides = toAiRequestOverrides(aiOverrides);
  const hasAiOverrides = Object.keys(aiRequestOverrides).length > 0;
  /**
   * What a resume costs in each mode, once the models answer (the prices come
   * with them): the cards say it, and say nothing before then.
   */
  const modePrices = useMemo<Record<BuildMode, number> | null>(
    () =>
      modelsLoaded
        ? {
            suitable: modelSettings[BUILD_MODE_PRICE_SETTINGS.suitable],
            partial: modelSettings[BUILD_MODE_PRICE_SETTINGS.partial],
            full: modelSettings[BUILD_MODE_PRICE_SETTINGS.full],
          }
        : null,
    [modelSettings, modelsLoaded]
  );
  /**
   * What the override selects fall back to.
   *
   * Fully Tailor builds the profile's default resume, so the layer directly
   * beneath this one is that resume's own setting. The other modes choose a
   * resume per job and each runs on its own model, so what is left to name is
   * the app default.
   */
  const inheritsFromResume = buildModeChoice === 'full' && Boolean(defaultResume);
  const resumePreferences = normalizeAiPreferences(inheritsFromResume ? defaultResume?.resumeSettings?.ai : undefined);
  // The resume's own model, but only while it is one that can still run: a
  // resume pointing at a model this installation has since locked falls back
  // to the app default, and this label has to name what will really be used.
  const inheritedModel =
    modelSettings.models.find((model) => model.id === resumePreferences.modelId) ??
    modelSettings.models.find((model) => model.id === modelSettings.defaultModelId);
  const inheritedChoice = {
    modelLabel: inheritedModel?.name || 'the first enabled model',
  };

  const loadInitialData = async () => {
    try {
      const [resumesData, profilesData, loadedModels, ownSheet] = await Promise.all([
        resumesApi.getAll({ includeDisabled: true }),
        // Open to every builder on every subscription: a failure is a failure to load.
        profilesApi.getAll(),
        resumeApi.getModels().catch(() => null),
        // Never fatal to this page: the import dialog is one feature of it, and
        // a Google outage must not stop the builder from loading.
        sheetApi.get().catch(() => null),
      ]);
      const enabledResumes = resumesData.filter((resume) => !resume.disabled);
      // Only a profile with an enabled resume can be built (the run refuses
      // one without), in the order the server lists them: newest edit first.
      const buildableProfiles = profilesData.filter((profile) => profile.enabledResumeCount > 0);
      // A failed models request is not "no models": the picker must not tell
      // the reader AI generation is unavailable because one request dropped.
      const modelData = loadedModels ?? DEFAULT_USER_APP_SETTINGS;
      setResumes(enabledResumes);
      setProfiles(buildableProfiles);
      setModelSettings(modelData);
      setModelsLoaded(loadedModels !== null);
      setAccountSheet(ownSheet);
      setAutoGenerate(modelData.defaultMode === 'generate');
      setStoredDefaultTheme(modelData.defaultTheme);

      if (!getStoredTheme()) {
        applyTheme(modelData.defaultTheme);
      }

      // The administrator's default profile (the first one while it is not
      // one of this account's) and default build mode (lib/runChoices.ts).
      const startProfileId = startingProfileId(modelData, buildableProfiles);
      if (startProfileId) setSelectedProfileId(startProfileId);
      setBuildModeChoice(startingBuildMode(modelData));
    } catch (err) {
      setError(err ?? 'Failed to load data.');
    } finally {
      setIsLoadingData(false);
    }
  };

  const shouldShowRoleInput = modelSettings.outputPathUsesJobTitle;
  /**
   * The spreadsheet a sheet run reads: the account's own, and only that
   * (owner decision S1) - every account has one, and the saved "shared"
   * sheets an administrator could once pick are gone. Null while there is
   * none to read (no Google on the server, or not allocated yet).
   */
  const ownSpreadsheetId = accountSheet?.configured && accountSheet.spreadsheetId ? accountSheet.spreadsheetId : null;

  /**
   * What to price: the run the page is set up for, as the request that would
   * start it - the chosen profile in the chosen mode, as exact as the charge
   * (jobs x the mode's price), so the line never says "up to". Once a sheet's
   * rows are loaded the price is the run's, every loaded job; before, it is
   * what one row costs.
   */
  const quoteRequest = useMemo(() => {
    if (builderMode === null || !selectedProfile) return null;
    let jobs = QUOTE_JOBS;
    if (builderMode === 'sheets' && sheetJobCount) {
      jobs = Array.from({ length: sheetJobCount }, () => QUOTE_JOBS[0]);
    }
    const body: SubmitBatchRequest = {
      ...(aiOverrides.modelId ? { model: aiOverrides.modelId } : {}),
      profileId: selectedProfile.id,
      buildMode: buildModeChoice,
      jobs,
    };
    return {
      key: `${selectedProfile.id}|${buildModeChoice}|${jobs.length}|${aiOverrides.modelId ?? ''}|${runRevision}`,
      body,
    };
  }, [aiOverrides.modelId, buildModeChoice, builderMode, runRevision, selectedProfile, sheetJobCount]);

  useEffect(() => {
    if (!quoteRequest) return;
    let cancelled = false;
    // No line rather than a wrong one: a quote that fails (a model that is no
    // longer on offer) leaves the run to say so.
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
   * A failed run, as the page reports it. A 402 is the failure with a remedy
   * the person can take themselves: it gets the numbers and a way to buy
   * credits. A 409 `preview-changed` says, in the server's sentence, that the
   * profile's resumes (or the posting's analysis) changed since the preview
   * was drawn, so the run would build a resume the person did not see: the
   * preview is dropped, and the next one is built afresh.
   */
  const reportRunFailure = (err: unknown, fallback: string) => {
    if (err instanceof ApiResponseError && err.code === 'preview-changed') {
      setPreviewHtml('');
      setPreviewTailored(false);
      setIsSinglePreviewOpen(false);
      resetTailoredEditor();
      setError(err);
      return;
    }
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

  const hasImportableSheet = ownSpreadsheetId !== null;
  /** Why there is nothing to import from, in the words that fit the reason. */
  const sheetImportNotice =
    accountSheet && !accountSheet.configured
      ? accountSheet.message ?? 'Google Sheets is not set up on this server yet.'
      : 'Your job sheet is not ready yet. Open Settings > Job Sheet and try again.';

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
    currentResumeName?: string,
    currentCompanyName?: string,
    currentJobTitle?: string,
    currentJobNumber?: number,
    importedJobCount?: number
  ) => {
    setGenerationProgress({
      total,
      completed,
      phase,
      currentResumeName,
      currentCompanyName,
      currentJobTitle,
      currentJobNumber,
      importedJobCount,
    });
  };

  /**
   * The request for the manual form's job: one posting, for the chosen
   * profile in the chosen mode, on the analysis the page already has - named
   * by its `analysisId`. Finalising a preview adds `previewedResumeId` (the
   * resume the preview drew, which the run must build too, else 409
   * `preview-changed`) and - Partial and Fully only - its content, keyed by
   * that resume's id, with the token naming the mode that wrote it, so it is
   * charged at that mode. Choose Suitable Resume sends no content at all (the
   * server refuses it): the resume is built as written.
   *
   * No template: the server draws the chosen resume with the template it names
   * (services/templateChoice.ts). A role left empty is the posting's title.
   */
  const manualRunRequest = ({
    profileId,
    analysis,
    previewedResumeId,
    previewedContent,
    previewedToken,
  }: {
    profileId: string;
    analysis: HeldAnalysis<AnalyzedJob>;
    previewedResumeId?: string;
    previewedContent?: HeldTailoredContent | null;
    previewedToken?: string | null;
  }): SubmitBatchRequest => {
    const holdsContent = buildModeChoice !== 'suitable' && Boolean(previewedResumeId) && Boolean(previewedContent);
    const targetCompanyName = companyName.trim();

    return {
      ...aiRequestOverrides,
      label: targetCompanyName,
      buildMode: buildModeChoice,
      profileId,
      ...(previewedResumeId ? { previewedResumeId } : {}),
      jobs: [
        {
          companyName: targetCompanyName,
          role: (shouldShowRoleInput && role.trim()) || getAnalysisJobTitle(analysis.analysis),
          jobDescription,
          analysisId: analysis.analysisId,
        },
      ],
      ...(holdsContent ? { tailoredContentByResumeId: { [previewedResumeId!]: previewedContent } } : {}),
      ...(holdsContent && previewedToken ? { previewTokenByResumeId: { [previewedResumeId!]: previewedToken } } : {}),
      ...defaultRunFormat(modelSettings),
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
          `${item.resumeName ? ` (${item.resumeName}${item.resumeLabel ? ` · ${item.resumeLabel}` : ''})` : ''}: ${userMessage(err)}`
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
          `${item.resumeName ? ` (${item.resumeName}${item.resumeLabel ? ` · ${item.resumeLabel}` : ''})` : ''}: ${userMessage(err)}`
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
    const receipt = placedOrderFrom(submitted, skippedNote, selectedProfile?.name);
    if (receipt) {
      setPlacedOrder(receipt);
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

  /**
   * Every run asks before it spends credit (components/SpendConfirm): what it
   * takes, from the server's quote for these resumes, and the balance after.
   * Generate Immediately asks always - closing the tab stops it (owner
   * decision B4) - and an Order only when it costs something; each until "Do
   * not show again" for that kind in this browser. `body` is what the quote
   * prices (`quoteBody`).
   */
  const confirmSpend = (kind: SheetRunKind, body: SubmitBatchRequest, start: () => void) => {
    const fallback = { balanceMilli: account?.balanceMilli ?? null, exempt: account?.role === 'admin' };
    void spend.ask(
      { kind, title: kind === 'order' ? 'Order' : 'Generate Immediately', price: () => estimateRun(body, fallback) },
      start
    );
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
        currentResumeName: current ? `${current.resumeName}${current.resumeLabel ? ` · ${current.resumeLabel}` : ''}` : undefined,
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
   * failure to report - it was refunded.
   */
  const summarizeBatch = (snapshot: BatchSnapshot | null, fallbackCompany: string) => {
    const tasks = snapshot?.tasks ?? [];
    const failures: GenerationFailure[] = tasks
      .filter((task) => task.state === 'failed')
      .map((task) => ({
        resumeId: task.resumeId,
        resumeName: task.resumeName,
        companyName: task.companyName || fallbackCompany,
        error: task.error || 'This resume could not be built.',
      }));
    return {
      generated: snapshot?.completed ?? 0,
      failed: failures.length,
      failures,
      failedCompanies: [...new Set(failures.map((failure) => failure.companyName))],
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
          .map((failure) => `${failure.resumeName}: ${failure.error}`)
          .join(' | ')}${res.failures.length > 3 ? ' | ...' : ''}`
      );
    }
    return res;
  };

  /** What the manual form must have before anything runs, as the sentence to show; null when ready. */
  const manualFormProblem = (): string | null => {
    if (!companyName.trim()) return 'Please enter a company name';
    if (jobDescription.trim().length < 50) return 'Please provide a job description (minimum 50 characters)';
    return profileBlocker(selectedProfileId, profiles);
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
  };

  /**
   * Builds the manual form's job straight away (Auto-generate on): analysed,
   * then one run for the chosen profile in the chosen mode - Generate
   * Immediately, followed and downloaded here, or an Order, collected on
   * Orders.
   */
  const runManual = async (kind: SheetRunKind) => {
    setIsGenerating(true);
    clearForManualRun();
    const targetCompanyName = companyName.trim();

    try {
      clearGenerationProgress();
      const analysis = await ensureAnalysis();

      if (!selectedProfileId) throw new Error('Please select a profile');
      const request = manualRunRequest({ profileId: selectedProfileId, analysis });

      if (kind === 'order') {
        await placeOrder(request);
        return;
      }

      updateGenerationProgress(1, 0, 'Queueing resumes', undefined, targetCompanyName);
      const snapshot = await runImmediate(request, { phase: 'Building resumes' });
      reportImmediateEnd(snapshot, targetCompanyName);
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
   * A sheet's loaded rows, built for the Build target (one profile, one mode):
   * as an Order, or - once confirmed - Generate Immediately in this tab.
   *
   * ONE request carrying every row: the server chooses a resume per job (the
   * mode's rule), queues the lot and hands them out as seats come free. It names the sheet and tab
   * the rows came from, so the server reads their Analysis cells itself - a
   * row that holds its analysis is built on it and never analysed - and each
   * other posting is analysed once, by its first task, for every resume that
   * needs it. No analysis goes from this page. A row without a Job Title goes
   * without one - the server names the role from the posting's analysis
   * rather than from a guess typed on this page.
   */
  const handleSheetRun = (
    kind: SheetRunKind,
    jobs: SheetJob[],
    meta: { skippedRows: number; sheet: SheetRunSource }
  ) => {
    const blocker = profileBlocker(selectedProfileId, profiles);
    if (blocker || !selectedProfileId) {
      setError(blocker ?? 'Please choose who to build for.');
      return;
    }
    const request: SubmitBatchRequest = {
      ...aiRequestOverrides,
      label: `Google Sheet (${plural(jobs.length, 'job')})`,
      buildMode: buildModeChoice,
      profileId: selectedProfileId,
      jobs: jobs.map((job) => ({
        companyName: job.companyName,
        role: job.jobTitle,
        jobDescription: job.jobDescription,
        ...(job.jobLink ? { jobLink: job.jobLink } : {}),
        sourceRowNumber: job.sourceRowNumber,
      })),
      sheet: meta.sheet,
      ...defaultRunFormat(modelSettings),
    };
    const skippedNote = meta.skippedRows
      ? ` Skipped ${plural(meta.skippedRows, 'row')} with no company or no job description.`
      : '';
    confirmSpend(
      kind,
      quoteBody(aiRequestOverrides, selectedProfileId, buildModeChoice, jobs.length),
      () => void runSheet(kind, request, skippedNote, jobs.length)
    );
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
      updateGenerationProgress(jobCount, 0, 'Queueing resumes', undefined, undefined, undefined, undefined, jobCount);
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
    if (problem || !selectedProfileId) {
      setError(problem ?? 'Please select a profile.');
      return;
    }
    if (autoGenerate) {
      confirmSpend(
        'immediate',
        quoteBody(aiRequestOverrides, selectedProfileId, buildModeChoice),
        () => void runManual('immediate')
      );
      return;
    }

    setIsGenerating(true);
    clearForManualRun();

    try {
      clearGenerationProgress();
      const analysis = await ensureAnalysis();

      setGenerationStep('Building preview...');
      // The server chooses the resume as a run would for this posting (the
      // matcher's pick, or - Fully Tailor - the profile's default) and draws it
      // with its own template; Choose Suitable Resume draws it as written, with
      // no model call, and the other two tailor it. The company and role help
      // the matcher read the posting's title.
      const targetRole = (shouldShowRoleInput && role.trim()) || getAnalysisJobTitle(analysis.analysis);
      const preview = await resumeApi.preview({
        ...aiRequestOverrides,
        profileId: selectedProfileId,
        buildMode: buildModeChoice,
        jobDescription,
        analysisId: analysis.analysisId,
        companyName: companyName.trim(),
        ...(targetRole ? { role: targetRole } : {}),
      });
      setPreviewHtml(preview.html);
      setPreviewTailored(preview.tailored);
      setIsSinglePreviewOpen(true);
      setPreviewToken(preview.previewToken ?? null);
      setPreviewChoice({
        resumeId: preview.resumeId,
        resumeLabel: preview.resumeLabel,
        match: preview.match,
        mode: preview.buildMode,
      });
      if (preview.tailoredContent) {
        setTailoredContent(preview.tailoredContent);
        setTailoredContentDraft(tailoredDraftOf(preview.tailoredContent));
        setTailoredContentError('');
      }
      setSuccessMessage(
        `Preview built with ${preview.resumeLabel}, the ${previewChoiceWords(preview.buildMode)} for this job. Review, then click Generate Immediately to build it.`
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

  /** Order beside Generate Immediately, on manual with Auto-generate on. */
  const handleOrderManual = () => {
    const problem = manualFormProblem();
    if (problem || !selectedProfileId) {
      setError(problem ?? 'Please select a profile.');
      return;
    }
    confirmSpend(
      'order',
      quoteBody(aiRequestOverrides, selectedProfileId, buildModeChoice),
      () => void runManual('order')
    );
  };

  /**
   * The single preview's Manual Edits: what an edit sends back is the box's
   * editable part (lib/tailoredDraft.ts), which the server finishes against
   * the resume. A blank box sends nothing, and the server tailors afresh.
   */
  const handleTailoredContentChange = (value: string) => {
    setTailoredContentDraft(value);
    const read = readTailoredDraft(value);
    setTailoredContentError(read.error);
    if (!read.error) setTailoredContent(read.content);
  };

  const handleUpdatePreview = async () => {
    if (!previewChoice) {
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
      // The resume the preview drew, not whatever the matcher would choose
      // now: the edits are to that resume's tailoring. No model call, no token.
      const preview = await resumeApi.preview({
        ...aiRequestOverrides,
        resumeId: previewChoice.resumeId,
        ...postingFields(),
        tailoredContent,
      });
      setPreviewHtml(preview.html);
      setPreviewTailored(preview.tailored);
      setIsSinglePreviewOpen(true);
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
   * The preview's Generate Immediately: the previewed resume, built as a
   * one-resume run in this tab - queued like any other, so it downloads, stops
   * and refunds the way every Generate Immediately does. Partial and Fully
   * Tailor send the previewed content and are charged at the mode that wrote
   * it (its preview token); Choose Suitable Resume sends the resume's id alone
   * (the run builds it as written).
   */
  const handleFinalizeGenerate = () => {
    if (!companyName.trim() || jobDescription.trim().length < 50 || !selectedProfileId || !previewChoice) {
      setError('Please complete the required fields before generating.');
      return;
    }
    if (tailoredContentError) {
      setError('Fix manual edits before generating.');
      return;
    }
    // Priced as the run will be charged: the previewed content, at the mode that wrote it (its token).
    const previews =
      buildModeChoice !== 'suitable' && tailoredContent
        ? {
            tailoredContentByResumeId: { [previewChoice.resumeId]: tailoredContent },
            previewTokenByResumeId: previewToken ? { [previewChoice.resumeId]: previewToken } : {},
          }
        : {};
    confirmSpend(
      'immediate',
      quoteBody(aiRequestOverrides, selectedProfileId, buildModeChoice, 1, previews),
      () => void finalizeSingle()
    );
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
      if (!selectedProfileId || !previewChoice) throw new Error('Please select a profile');
      // The progress and its Stop are on the page, under the dialog: close it.
      // "Open Preview" brings it back if the run is stopped.
      setIsSinglePreviewOpen(false);
      updateGenerationProgress(1, 0, 'Building resume', previewChoice.resumeLabel, targetCompanyName);
      const snapshot = await runImmediate(
        manualRunRequest({
          profileId: selectedProfileId,
          analysis,
          previewedResumeId: previewChoice.resumeId,
          previewedContent: tailoredContent,
          previewedToken: previewToken,
        }),
        { phase: 'Building resume' }
      );
      reportImmediateEnd(snapshot, targetCompanyName);
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
          hand: Analyze & Preview, or Generate Immediately (and Order beside it
          once Auto-generate is on). A sheet's two actions sit under the rows
          they build, in the sheet panel. Back, Open Preview once a preview has
          been closed, and Stop while a run goes, are the quiet ones beside it.
        */}
        <PageHeader
          title="Build Resumes"
          description="Build a resume for a job description from one profile, or for every row of a Google Sheet."
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
                  disabled={runBusy}
                  className={`tl-button-quiet ${styles.pill}`}
                >
                  Back
                </button>
                {builderMode === 'manual' && previewHtml && !isSinglePreviewOpen && (
                  <button
                    type="button"
                    onClick={() => setIsSinglePreviewOpen(true)}
                    disabled={isGenerating}
                    className={`tl-button-quiet ${styles.pill}`}
                  >
                    Open Preview
                  </button>
                )}
                {builderMode === 'manual' && autoGenerate && !isGenerating && (
                  <button
                    type="button"
                    onClick={handleOrderManual}
                    disabled={spend.pending}
                    className={`tl-button-quiet ${styles.pill}`}
                    title="Built on the server whether or not this page stays open; collect the files on Orders"
                  >
                    Order
                  </button>
                )}
                {builderMode === 'manual' && (
                  <button
                    onClick={handleGenerate}
                    disabled={runBusy}
                    className={`tl-button ${styles.wrap}`}
                    data-shape="pill"
                  >
                    {runBusy ? (
                      <>
                        <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"></span>
                        {runStep || 'Generating...'}
                      </>
                    ) : !autoGenerate ? (
                      'Analyze & Preview'
                    ) : (
                      'Generate Immediately'
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
                .
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
            <OrderReceipt order={placedOrder} onChange={setPlacedOrder} onCancelled={afterRun} onError={setError} />
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
                Pick a tab and rows of your Google Sheet, then build resumes for one of your profiles from every row - right away, or as an order.
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
                    every resume and model built on this description uses it,
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
                  <ProfileSelector
                    id="manual-profile"
                    profiles={profiles}
                    selectedId={selectedProfileId}
                    onChange={setSelectedProfileId}
                    isLoading={false}
                    disabled={isGenerating}
                  />

                  <div>
                    <div>
                      <BuildModeChoice
                        name="manualBuildMode"
                        value={buildModeChoice}
                        onChange={setBuildModeChoice}
                        prices={modePrices}
                        disabled={isGenerating}
                      />
                    </div>
                    <p className="mt-2 text-sm text-subtle" data-build-mode-note>
                      {buildModeNote(buildModeChoice, selectedProfile, defaultResumeLabel)}
                    </p>
                  </div>
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
                      inheritedFrom={inheritsFromResume ? "resume's setting" : 'app default'}
                      inherited={inheritedChoice}
                      disabled={isGenerating}
                    />
                    <p className="text-sm text-subtle">
                      It tailors the resume (not in Choose Suitable Resume) and writes its cover letter. The job
                      description itself is analysed once, the same way for every profile and every model.
                    </p>
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm text-subtle">
                        {inheritsFromResume
                          ? `Defaults come from ${defaultResumeLabel}, the profile's default resume.`
                          : 'Each resume uses its own model; one chosen here applies to this run only.'}
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
                Each row of the tab is one job. Load the rows to check them, then build resumes for the
                chosen profile from every row: <strong>Generate Immediately</strong> builds them while this
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
                <div className="space-y-5">
                  <ProfileSelector
                    id="sheets-profile"
                    profiles={profiles}
                    selectedId={selectedProfileId}
                    onChange={setSelectedProfileId}
                    isLoading={false}
                    disabled={isGenerating}
                  />
                  <div>
                    <div>
                      <BuildModeChoice
                        name="sheetsBuildMode"
                        value={buildModeChoice}
                        onChange={setBuildModeChoice}
                        prices={modePrices}
                        disabled={isGenerating}
                      />
                    </div>
                    <p className="mt-2 text-sm text-subtle" data-build-mode-note>
                      {buildModeNote(buildModeChoice, selectedProfile, defaultResumeLabel)}
                    </p>
                  </div>
                </div>
              </Card>

              <SheetsSourcePanel
                spreadsheetId={ownSpreadsheetId}
                busy={runBusy}
                onRowsChange={setSheetJobCount}
                onRun={handleSheetRun}
                costLine={
                  <CostLine
                    quote={quote}
                    label={sheetJobCount ? 'This run' : 'Each sheet row'}
                    pricing={spend.pending}
                  />
                }
                unavailableNotice={<p className="text-sm text-muted">There is no job sheet to read rows from yet.</p>}
              />
            </div>
          </div>
        ))}

        {builderMode === 'manual' && previewHtml && (
          <ResumePreview
            html={previewHtml}
            onGenerate={handleFinalizeGenerate}
            generateLabel="Generate Immediately"
            isGenerating={runBusy}
            isTailored={previewTailored}
            isOpen={isSinglePreviewOpen}
            onClose={() => setIsSinglePreviewOpen(false)}
            generationStep={runStep}
            costNote={<CostLine quote={quote} shortfall={shortfall} />}
            titleNote={
              <>
                <AnalysisFacts analysis={currentAnalysis?.analysis} />
                {previewChoice && (
                  <span className="min-w-0 text-sm text-muted" data-preview-choice>
                    {previewChoice.resumeLabel}
                    {describeChoice(previewChoice.match) ? ` · ${describeChoice(previewChoice.match)}` : ''}
                  </span>
                )}
              </>
            }
            /*
              Only a TAILORED preview has anything to edit: Choose Suitable Resume
              shows the resume as written, with no ATS pill and no Manual Edits.
            */
            sidebar={
              !previewTailored ? undefined : (
              <>
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
                    <p className="mt-2 text-xs text-subtle">{TAILORED_DRAFT_NOTE}</p>
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
              )
            }
          />
        )}

      </Page>

      {spend.dialog}

      {/* Footer */}
      <footer className="mt-auto py-6 text-center text-sm text-subtle">
        <p>Tailor</p>
      </footer>
    </>
  );
}
