'use client';

import { useEffect, useMemo, useState } from 'react';

import AiPreferenceFields from '@/components/AiPreferenceFields';
import CostLine, { type CreditShortfall } from '@/components/builder/CostLine';
import ProfileTargets from '@/components/builder/ProfileTargets';
import { placedOrderFrom, type PlacedOrder } from '@/components/orders/OrderReceipt';
import { useSpendConfirm } from '@/components/SpendConfirm';
import { useLockedFeature } from '@/components/subscription/LockedFeature';
import Dialog from '@/components/ui/Dialog';
import { ErrorNotice, Spinner } from '@/components/ui/kit';
import { useAuth } from '@/contexts/AuthContext';
import {
  DEFAULT_USER_APP_SETTINGS,
  groupsApi,
  isInsufficientCredits,
  isSubscriptionTooLow,
  normalizeAiPreferences,
  profilesApi,
  resumeApi,
  type AiPreferences,
  type Group,
  type Profile,
  type UserAppSettings,
} from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { estimateRun, generationApi, type GenerationQuote, type SubmitBatchRequest } from '@/lib/generationQueue';
import type { FindJobsRow } from '@/lib/jobLake';
import { describeOrderSkipped, lakeOrderJobs, lakeOrderLabel } from '@/lib/jobLakeDisplay';
import {
  defaultRunFormat,
  startingTarget,
  targetBlocker,
  targetInEffect,
  targetProfiles,
  type TargetChoice,
  type TargetKind,
} from '@/lib/runChoices';
import { canBuildForManyProfiles, describeLock, describeTooLowRefusal } from '@/lib/subscriptions';
import { userMessage } from '@/lib/userMessage';

/**
 * Order Immediately, from Find Jobs: an ORDER (`mode: 'order'`) of a resume
 * for every job picked, for the profiles chosen here, built on the server and
 * collected on Orders - owner's decision. The jobs go by their stored
 * analyses, so nothing is analysed again; a picked job with none is left out
 * and the receipt says so.
 *
 * Who it builds for is Build Resumes' own choice (components/builder/
 * ProfileTargets.tsx) and one more: Single profile, Several profiles (chosen
 * in a box of the enabled ones), All profiles or Specific group, all but the
 * first LOCKED below Premium - drawn, never hidden, each opening the lock -
 * and the kind in effect derived as Single for such an account
 * (lib/runChoices.ts `targetInEffect`). It starts where Build Resumes starts:
 * the administrator's default target, profile and group. The model is this
 * order's only (`AiPreferenceFields`), each profile's own model otherwise.
 *
 * Its price is the server's quote for exactly this order (CostLine) - or,
 * while who it is for cannot be built for yet, the reason, in the same place,
 * where a phone or a keyboard can read it too. Place order asks first, as
 * every Order does (components/SpendConfirm.tsx, kind `order`): what it takes
 * from the credit balance and what is left, with "Do not show again". Closed
 * while the price is worked out, the dialog places nothing (the confirm hook
 * starts nothing for a page that has gone). A refusal stays in the dialog -
 * 402 as the cost line's shortfall with Buy credits (only while the same
 * order is chosen - another target or model shows its own price), 403
 * `subscription-too-low` as the lock, worded from the refusal, anything else
 * as an error notice.
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
  const manyProfiles = canBuildForManyProfiles(account);
  const manyLock = describeLock('many-profiles', account);
  const locked = useLockedFeature();
  const spend = useSpendConfirm();

  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [settings, setSettings] = useState<UserAppSettings>(DEFAULT_USER_APP_SETTINGS);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [choice, setChoice] = useState<TargetChoice>({ kind: 'single', profileId: null, profileIds: [], groupId: '' });
  const [aiOverrides, setAiOverrides] = useState<AiPreferences>({});
  const [quoted, setQuoted] = useState<{ key: string; quote: GenerationQuote | null } | null>(null);
  const [placing, setPlacing] = useState(false);
  // A 402's shortfall, for the order it refused: another target or model is another price.
  const [refusal, setRefusal] = useState<{ key: string; shortfall: CreditShortfall } | null>(null);
  const [error, setError] = useState<unknown>(null);

  // What the dialog chooses from: the enabled profiles, the groups (Premium
  // and up - a Default account is refused them, and draws Specific group
  // locked anyway), and the models with the administrator's defaults.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [all, loadedGroups, loadedSettings] = await Promise.all([
          profilesApi.getAll({ includeDisabled: true }),
          manyProfiles ? groupsApi.getAll().catch(() => [] as Group[]) : Promise.resolve([] as Group[]),
          resumeApi.getModels().catch(() => null),
        ]);
        if (!alive) return;
        const enabled = all.filter((profile) => !profile.disabled);
        const defaults = loadedSettings ?? DEFAULT_USER_APP_SETTINGS;
        setProfiles(enabled);
        setGroups(loadedGroups);
        setSettings(defaults);
        setModelsLoaded(loadedSettings !== null);
        setChoice({ ...startingTarget(defaults, enabled, loadedGroups, manyProfiles), profileIds: [] });
      } catch (caught) {
        if (alive) setLoadError(caught ?? new Error('Could not load your profiles.'));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // Again when the subscription changes under the dialog (a refused order re-reads the account).
  }, [manyProfiles]);

  const target = useMemo<TargetChoice>(
    () => ({ ...choice, kind: targetInEffect(choice.kind, manyProfiles) }),
    [choice, manyProfiles]
  );
  const runProfiles = useMemo(() => targetProfiles(target, profiles, groups), [groups, profiles, target]);
  const { jobs, skipped } = useMemo(() => lakeOrderJobs(rows), [rows]);
  const modelId = aiOverrides.modelId;

  /** The order as it would be sent - and, without its label and files, what the quote and the confirm price. */
  const request = useMemo<SubmitBatchRequest | null>(() => {
    if (runProfiles.length === 0 || jobs.length === 0) return null;
    return { ...(modelId ? { model: modelId } : {}), profileIds: runProfiles.map((profile) => profile.id), jobs };
  }, [jobs, modelId, runProfiles]);
  const quoteKey = request ? `${request.profileIds?.join(',')}|${jobs.length}|${modelId ?? ''}` : '';

  // The price of this order, asked again whenever who it is for or the model changes.
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

  // What the model select falls back to: the chosen profile's own model on a
  // single target, else the app default - and only one that can still run.
  const single = target.kind === 'single' ? (profiles.find((profile) => profile.id === target.profileId) ?? null) : null;
  const profileModelId = normalizeAiPreferences(single?.profileSettings?.ai).modelId;
  const inheritedModel =
    settings.models.find((model) => model.id === profileModelId) ??
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
      onPlaced(placedOrderFrom(submitted, describeOrderSkipped(skipped)), submitted.total);
    } catch (caught) {
      if (isSubscriptionTooLow(caught)) {
        // The subscription changed under this page: the lock, in the refusal's words, and the account read again.
        locked.open(describeTooLowRefusal());
        void refresh();
      } else if (isInsufficientCredits(caught)) {
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

  const targetProblem = targetBlocker(target, profiles, groups);
  const blocker = loading
    ? 'Loading your profiles...'
    : jobs.length === 0
      ? 'None of the selected jobs has a stored analysis to build from.'
      : targetProblem;
  // Said in the footer, where the cost line stands once there is an order to
  // price - the rest of the blockers the body says already.
  const footerReason = !loading && !loadError && profiles.length > 0 && jobs.length > 0 ? targetProblem : null;

  /** Place order: asked first, as every Order is, priced by the server's quote of this very order. */
  const placeOrder = () => {
    if (!request || blocker) {
      setError(blocker ?? 'Choose who to build for.');
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
            <p className="text-sm text-muted">You have no enabled profile to build for. Add one under Profiles first.</p>
          ) : (
            <ProfileTargets
              name="orderTargetMode"
              idPrefix="order"
              value={target.kind}
              onChange={(kind: TargetKind) => setChoice((current) => ({ ...current, kind }))}
              manyProfiles={manyProfiles}
              lock={manyLock}
              onLocked={locked.open}
              profiles={profiles}
              selectedProfileId={target.profileId}
              onProfileChange={(profileId) => setChoice((current) => ({ ...current, profileId }))}
              selectedProfileIds={target.profileIds ?? []}
              onProfileIdsChange={(profileIds) => setChoice((current) => ({ ...current, profileIds }))}
              groups={groups}
              selectedGroupId={target.groupId}
              onGroupChange={(groupId) => setChoice((current) => ({ ...current, groupId }))}
              disabled={busy}
            />
          )}
          <div>
            <AiPreferenceFields
              idPrefix="order-ai"
              value={aiOverrides}
              onChange={setAiOverrides}
              models={settings.models}
              modelsLoaded={modelsLoaded}
              inheritedFrom={single ? "profile's setting" : 'app default'}
              inherited={{ modelLabel: inheritedModel?.name || 'the first enabled model' }}
              disabled={busy}
            />
            <p className="mt-2 text-sm text-subtle">
              {single
                ? `Defaults come from ${single.name}. A model chosen here applies to this order only.`
                : 'Each profile uses its own model; one chosen here applies to this order only.'}
            </p>
          </div>
          <ErrorNotice error={error} fallback="The order could not be placed" onDismiss={() => setError(null)} />
        </div>
      )}
      {spend.dialog}
      {locked.dialog}
    </Dialog>
  );
}
