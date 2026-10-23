'use client';

import { useEffect, useMemo, useState } from 'react';

import AiPreferenceFields from '@/components/AiPreferenceFields';
import CostLine, { type CreditShortfall } from '@/components/builder/CostLine';
import BuildModeChoice from '@/components/builder/BuildModeChoice';
import { placedOrderFrom, type PlacedOrder } from '@/components/orders/OrderReceipt';
import ProfileSelector from '@/components/ProfileSelector';
import { useSpendConfirm } from '@/components/SpendConfirm';
import Dialog from '@/components/ui/Dialog';
import { ErrorNotice, Spinner } from '@/components/ui/kit';
import { useAuth } from '@/contexts/AuthContext';
import {
  DEFAULT_USER_APP_SETTINGS,
  profilesApi,
  isInsufficientCredits,
  normalizeAiPreferences,
  resumesApi,
  resumeApi,
  type AiPreferences,
  type ProfileSummary,
  type Resume,
  type UserAppSettings,
} from '@/lib/api';
import { BUILD_MODE_PRICE_SETTINGS, BUILD_MODES, type BuildMode } from '@/lib/buildModes';
import { formatMoney } from '@/lib/format';
import { estimateRun, generationApi, type GenerationQuote, type SubmitBatchRequest } from '@/lib/generationQueue';
import type { FindJobsRow } from '@/lib/jobLake';
import { describeOrderSkipped, lakeOrderJobs, lakeOrderLabel } from '@/lib/jobLakeDisplay';
import { resumeLabel } from '@/lib/profileDashboard';
import { buildModeNote, defaultRunFormat, profileBlocker, startingBuildMode, startingProfileId } from '@/lib/runChoices';
import { userMessage } from '@/lib/userMessage';

/**
 * Order Immediately, from Find Jobs: an ORDER (`mode: 'order'`) of a resume
 * for every job picked, built on the server and collected on Orders - owner's
 * decision. The jobs go by their stored analyses, so nothing is analysed
 * again; a picked job with none is left out and the receipt says so.
 *
 * Like every run, an order builds exactly ONE profile (a person) in ONE build
 * mode - Choose Suitable Resume, Partial Tailor or Fully Tailor - on every
 * subscription, so nothing here is locked: `ProfileSelector` offers the
 * profiles that have an enabled resume and `BuildModeChoice` the three modes
 * with what each costs a resume. It starts where Build Resumes starts: the
 * administrator's default profile and default mode. The model is this order's
 * only (`AiPreferenceFields`), each resume's own model otherwise.
 *
 * Its price is the server's quote for exactly this order (CostLine) - or,
 * while who it is for cannot be built for yet, the reason, in the same place,
 * where a phone or a keyboard can read it too. Place order asks first, as
 * every Order does (components/SpendConfirm.tsx, kind `order`): what it takes
 * from the credit balance and what is left, with "Do not show again". Closed
 * while the price is worked out, the dialog places nothing (the confirm hook
 * starts nothing for a page that has gone). A refusal stays in the dialog -
 * 402 as the cost line's shortfall with Buy credits (only while the same
 * order is chosen - another profile, mode or model shows its own price),
 * anything else as an error notice.
 */
export default function OrderJobsDialog({
  rows,
  onClose,
  onPlaced,
}: {
  /** The jobs picked, in the order they were picked. */
  rows: readonly FindJobsRow[];
  onClose: () => void;
  /** Placed: the receipt, or null when the server filed no order number (said on the page). */
  onPlaced: (order: PlacedOrder | null, total: number) => void;
}) {
  const { account, refresh } = useAuth();
  const spend = useSpendConfirm();

  // The profiles with an enabled resume, newest edit first, and the enabled resumes behind them.
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [resumes, setResumes] = useState<Resume[]>([]);
  const [settings, setSettings] = useState<UserAppSettings>(DEFAULT_USER_APP_SETTINGS);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [buildMode, setBuildMode] = useState<BuildMode>('partial');
  const [aiOverrides, setAiOverrides] = useState<AiPreferences>({});
  const [quoted, setQuoted] = useState<{ key: string; quote: GenerationQuote | null } | null>(null);
  const [placing, setPlacing] = useState(false);
  // A 402's shortfall, for the order it refused: another target or model is another price.
  const [refusal, setRefusal] = useState<{ key: string; shortfall: CreditShortfall } | null>(null);
  const [error, setError] = useState<unknown>(null);

  // What the dialog chooses from, on every subscription: the profiles that
  // have an enabled resume, those resumes (the default one names the model
  // and the label a Fully Tailor order builds), and the models with the
  // administrator's defaults and the three prices per resume.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [allProfiles, all, loadedSettings] = await Promise.all([
          profilesApi.getAll(),
          resumesApi.getAll().catch(() => [] as Resume[]),
          resumeApi.getModels().catch(() => null),
        ]);
        if (!alive) return;
        const offered = allProfiles
          .filter((profile) => profile.enabledResumeCount > 0)
          .sort((a, b) => (a.lastEditedAt < b.lastEditedAt ? 1 : a.lastEditedAt > b.lastEditedAt ? -1 : a.id < b.id ? -1 : 1));
        const defaults = loadedSettings ?? DEFAULT_USER_APP_SETTINGS;
        setProfiles(offered);
        setResumes(all.filter((resume) => !resume.disabled));
        setSettings(defaults);
        setModelsLoaded(loadedSettings !== null);
        setProfileId(startingProfileId(defaults, offered));
        setBuildMode(startingBuildMode(defaults));
      } catch (caught) {
        if (alive) setLoadError(caught ?? new Error('Could not load your profiles.'));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const profile = useMemo(() => profiles.find((candidate) => candidate.id === profileId) ?? null, [profiles, profileId]);
  const { jobs, skipped } = useMemo(() => lakeOrderJobs(rows), [rows]);
  const modelId = aiOverrides.modelId;
  // The three prices per resume, from the settings; null until they are known.
  const prices = useMemo<Record<BuildMode, number> | null>(
    () =>
      modelsLoaded
        ? (Object.fromEntries(BUILD_MODES.map((mode) => [mode, settings[BUILD_MODE_PRICE_SETTINGS[mode]]])) as Record<
            BuildMode,
            number
          >)
        : null,
    [modelsLoaded, settings]
  );

  /** The order as it would be sent - and, without its label and files, what the quote and the confirm price. */
  const request = useMemo<SubmitBatchRequest | null>(() => {
    if (!profile || jobs.length === 0) return null;
    return { ...(modelId ? { model: modelId } : {}), buildMode, profileId: profile.id, jobs };
  }, [buildMode, jobs, modelId, profile]);
  const quoteKey = request ? `${request.profileId}|${jobs.length}|${modelId ?? ''}|${buildMode}` : '';

  // The price of this order, asked again whenever who it is for, the mode or the model changes.
  useEffect(() => {
    if (!request) return;
    let cancelled = false;
    generationApi.quote(request).then(
      (quote) => {
        if (!cancelled) setQuoted({ key: quoteKey, quote });
      },
      () => {
        if (!cancelled) setQuoted({ key: quoteKey, quote: null });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [quoteKey, request]);
  const quote = quoted && quoted.key === quoteKey ? quoted.quote : null;
  const shortfall = refusal && refusal.key === quoteKey ? refusal.shortfall : null;

  // What the model select falls back to: where one resume is certain to be
  // built - Fully Tailor builds the profile's default resume - that resume's
  // own model, else the app default; and only one that can still run.
  const defaultResume =
    profile && profile.defaultResumeId ? (resumes.find((resume) => resume.id === profile.defaultResumeId) ?? null) : null;
  const single = buildMode === 'full' ? defaultResume : null;
  const resumeModelId = normalizeAiPreferences(single?.resumeSettings?.ai).modelId;
  const inheritedModel =
    settings.models.find((model) => model.id === resumeModelId) ??
    settings.models.find((model) => model.id === settings.defaultModelId);

  const place = async (body: SubmitBatchRequest) => {
    setPlacing(true);
    setError(null);
    setRefusal(null);
    const refusedKey = quoteKey;
    try {
      const submitted = await generationApi.submit({
        ...body,
        label: lakeOrderLabel(jobs.length),
        mode: 'order',
        ...defaultRunFormat(settings),
      });
      onPlaced(placedOrderFrom(submitted, describeOrderSkipped(skipped), profile?.name ?? ''), submitted.total);
    } catch (caught) {
      if (isInsufficientCredits(caught)) {
        const needed = caught.number('neededMilli');
        const balance = caught.number('balanceMilli');
        setRefusal({
          key: refusedKey,
          shortfall: {
            message:
              needed !== undefined && balance !== undefined
                ? `This order needs ${formatMoney(needed)}, and your balance is ${formatMoney(balance)}.`
                : userMessage(caught),
          },
        });
        // The balance the server judged by, for the top bar and the next quote.
        void refresh();
      } else {
        setError(caught ?? new Error('Could not place that order.'));
      }
      setPlacing(false);
    }
  };

  const profileProblem = profileBlocker(profileId, profiles);
  const blocker = loading
    ? 'Loading your profiles...'
    : jobs.length === 0
      ? 'None of the selected jobs has a stored analysis to build from.'
      : profileProblem;
  // Said in the footer, where the cost line stands once there is an order to
  // price - the rest of the blockers the body says already.
  const footerReason = !loading && !loadError && profiles.length > 0 && jobs.length > 0 ? profileProblem : null;

  /** Place order: asked first, as every Order is, priced by the server's quote of this very order. */
  const placeOrder = () => {
    if (!request || blocker) {
      setError(blocker ?? 'Please select a profile.');
      return;
    }
    const body = request;
    const fallback = { balanceMilli: account?.balanceMilli ?? null, exempt: account?.role === 'admin' };
    void spend.ask({ kind: 'order', title: 'Order', price: () => estimateRun(body, fallback) }, () => void place(body));
  };

  const busy = placing || spend.pending;
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

  return (
    <Dialog
      open
      title="Order Immediately"
      subtitle={`A resume for each of the ${count(rows.length, 'job')} you picked, built on the server and collected on Orders`}
      width="wide"
      onClose={() => {
        if (!placing) onClose();
      }}
      footer={
        <>
          <span className="mr-auto min-w-0">
            <span className="text-sm text-muted" aria-live="polite" data-order-blocker>
              {footerReason ?? ''}
            </span>
            {!footerReason && <CostLine quote={quote} shortfall={shortfall} label="This order" pricing={spend.pending} />}
          </span>
          <button type="button" className="tl-button-quiet" disabled={placing} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="tl-button"
            disabled={busy || Boolean(blocker)}
            title={blocker || undefined}
            onClick={placeOrder}
            data-order-place
          >
            {placing ? 'Placing...' : spend.pending ? 'Checking the price...' : 'Place order'}
          </button>
        </>
      }
    >
      {loading ? (
        <Spinner compact />
      ) : loadError ? (
        <ErrorNotice error={loadError} fallback="Your profiles could not be loaded" />
      ) : (
        <div className="space-y-6">
          {skipped > 0 && (
            <p className="text-sm text-muted">
              {jobs.length === 0
                ? 'None of the selected jobs can be built: the lake has no stored analysis for them.'
                : `${count(jobs.length, 'job')} will be built.${describeOrderSkipped(skipped)}`}
            </p>
          )}
          {profiles.length === 0 ? (
            <p className="text-sm text-muted">You have no profile with an enabled resume. Add one under Profiles first.</p>
          ) : (
            <>
              <ProfileSelector
                id="order-profile"
                profiles={profiles}
                selectedId={profileId}
                onChange={setProfileId}
                disabled={busy}
              />
              <div>
                <BuildModeChoice
                  name="orderBuildMode"
                  value={buildMode}
                  onChange={setBuildMode}
                  prices={prices}
                  disabled={busy}
                />
                <p className="mt-2 text-sm text-subtle" data-build-mode-note>
                  {buildModeNote(buildMode, profile, defaultResume ? resumeLabel(defaultResume) : null)}
                </p>
              </div>
            </>
          )}
          <div>
            <AiPreferenceFields
              idPrefix="order-ai"
              value={aiOverrides}
              onChange={setAiOverrides}
              models={settings.models}
              modelsLoaded={modelsLoaded}
              inheritedFrom={single ? "resume's setting" : 'app default'}
              inherited={{ modelLabel: inheritedModel?.name || 'the first enabled model' }}
              disabled={busy}
            />
            <p className="mt-2 text-sm text-subtle">
              {single
                ? `Defaults come from ${resumeLabel(single)}, the profile's default resume. A model chosen here applies to this order only.`
                : 'Each resume uses its own model; one chosen here applies to this order only.'}
            </p>
          </div>
          <ErrorNotice error={error} fallback="The order could not be placed" onDismiss={() => setError(null)} />
        </div>
      )}
      {spend.dialog}
    </Dialog>
  );
}
