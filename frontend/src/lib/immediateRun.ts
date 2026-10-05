/**
 * The decisions behind a Generate Immediately run that need no browser: which
 * id this tab goes by, which finished resumes still have to be downloaded, the
 * request that stops a run when the page goes away, how the run ended, and
 * whether the confirm still shows.
 *
 * Kept apart from the page, and importing nothing at runtime, so the backend
 * suite can test it (backend/test/immediateRunHelpers.test.js) the way
 * frontendHelpers.test.js loads its modules. Every storage access goes through
 * `safe`, because storage can throw - a private window, blocked site data, a
 * sandboxed preview - and none of this may stop a resume being built. Without
 * storage a run still works; a reload just cannot find it again.
 */

/** The parts of `Storage` used here, so a test can pass a Map-backed stand-in. */
export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** sessionStorage: this tab's id. Survives a reload of the tab, never shared with another. */
export const TAB_ID_KEY = 'freeTailor.tabId';
/**
 * sessionStorage: set while a page of this tab holds the id, cleared on
 * `pagehide`. A duplicated tab copies sessionStorage, id and all, while the
 * original is still open - so it finds this set and mints its own id instead
 * of following (and downloading) the original's run.
 */
export const TAB_CLAIM_KEY = 'freeTailor.tabId.claimed';
/** sessionStorage: the run this tab started and the resumes it has downloaded. */
export const IMMEDIATE_RUN_KEY = 'freeTailor.immediateRun';
/** localStorage: "Don't show again" on the Generate Immediately confirm, for this browser. */
export const SKIP_IMMEDIATE_CONFIRM_KEY = 'freeTailor.immediateConfirm.skip';

/** What the server accepts as a tab id (routes/generation.ts `readTabId`). */
const TAB_ID = /^[A-Za-z0-9_-]{1,100}$/;

export function isTabId(value: unknown): value is string {
  return typeof value === 'string' && TAB_ID.test(value);
}

function safe<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/**
 * The id this tab goes by, claimed for this page.
 *
 * Reuses the id the tab already has - a reload is the same tab, and must be
 * able to find its run again - unless another page of the tab still holds it,
 * which is what a duplicated tab looks like. `mint` makes a fresh one (a UUID
 * in the browser). With no storage at all the id lasts for this page only.
 */
export function claimTabId(storage: StorageLike | null, mint: () => string): string {
  const existing = storage ? safe(() => storage.getItem(TAB_ID_KEY), null) : null;
  const claimed = storage ? safe(() => storage.getItem(TAB_CLAIM_KEY), null) === '1' : false;
  let id = isTabId(existing) && !claimed ? existing : mint();
  // A minted id the server would refuse would refuse every run; fall back to
  // one it accepts rather than sending junk.
  if (!isTabId(id)) id = `tab-${Date.now().toString(36)}`;
  if (storage) {
    safe(() => storage.setItem(TAB_ID_KEY, id), undefined);
    safe(() => storage.setItem(TAB_CLAIM_KEY, '1'), undefined);
  }
  return id;
}

/** `pagehide`: this page no longer holds the id, so the same tab's next page may take it back. */
export function releaseTabClaim(storage: StorageLike | null): void {
  if (storage) safe(() => storage.removeItem(TAB_CLAIM_KEY), undefined);
}

/** The run this tab started, as remembered across a reload. */
export type RememberedRun = {
  batchId: string;
  tabId: string;
  /**
   * The files handed to the browser - never again - one `downloadKey` each,
   * written the moment each is saved. A bare task id stands for every file of
   * that resume.
   */
  downloaded: string[];
};

/**
 * This tab's remembered run, or null.
 *
 * One remembered under another tab id is not this tab's: it was copied in by
 * a duplicated tab, and reading it would download the original's resumes a
 * second time.
 */
export function readRememberedRun(storage: StorageLike | null, tabId: string): RememberedRun | null {
  if (!storage) return null;
  const raw = safe(() => storage.getItem(IMMEDIATE_RUN_KEY), null);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const value = parsed as Record<string, unknown>;
  if (typeof value.batchId !== 'string' || !value.batchId || value.tabId !== tabId) return null;
  const downloaded = Array.isArray(value.downloaded)
    ? value.downloaded.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];
  return { batchId: value.batchId, tabId, downloaded };
}

export function rememberRun(storage: StorageLike | null, run: RememberedRun): void {
  if (storage) safe(() => storage.setItem(IMMEDIATE_RUN_KEY, JSON.stringify(run)), undefined);
}

export function forgetRun(storage: StorageLike | null): void {
  if (storage) safe(() => storage.removeItem(IMMEDIATE_RUN_KEY), undefined);
}

/** The file kinds a finished resume can have, in the order they are downloaded. */
export const DOWNLOAD_KIND_ORDER = ['resume-pdf', 'resume-docx', 'cover-letter-pdf', 'cover-letter-docx'] as const;

export type DownloadKind = (typeof DOWNLOAD_KIND_ORDER)[number];

/** What a snapshot's task says about itself that the download needs. */
export type DownloadableTask = {
  id: string;
  state: string;
  profileName?: string;
  companyName?: string;
  files?: readonly string[];
};

export type PendingDownload = {
  taskId: string;
  profileName: string;
  companyName: string;
  kinds: DownloadKind[];
};

/** How one saved file is remembered: its resume's task id and its kind. */
export function downloadKey(taskId: string, kind: DownloadKind): string {
  return `${taskId}:${kind}`;
}

/**
 * How many files a remembered list says were saved - the run's files that
 * reached this browser, on this page or one before a reload. A bare task id
 * is not counted: which files it stood for is not known.
 */
export function savedFileCount(downloaded: readonly string[]): number {
  return downloaded.filter((entry) => entry.includes(':')).length;
}

/**
 * The finished resumes of a snapshot that have not been downloaded yet, in the
 * order they were queued, each with the files still to save in a fixed order.
 *
 * `done` is the persisted set plus anything already started on this page:
 * the stream sends a full snapshot per settled task, so the same finished
 * resume is in every later line, and a download still in flight must not be
 * started again by the next one. It holds task ids (every file of that
 * resume, or one in flight here) and `downloadKey`s (that file alone, saved
 * before a reload): a page that went away between a resume's first file and
 * its last saves only the rest when it comes back. A finished task with no
 * files left (none were kept, or all are saved) is skipped - there is nothing
 * to fetch - and so is a kind this page does not know.
 */
export function pendingDownloads(
  tasks: readonly DownloadableTask[],
  done: ReadonlySet<string>
): PendingDownload[] {
  const pending: PendingDownload[] = [];
  for (const task of tasks) {
    if (task.state !== 'done' || done.has(task.id)) continue;
    const offered = new Set(task.files ?? []);
    const kinds = DOWNLOAD_KIND_ORDER.filter((kind) => offered.has(kind) && !done.has(downloadKey(task.id, kind)));
    if (kinds.length === 0) continue;
    pending.push({
      taskId: task.id,
      profileName: task.profileName ?? '',
      companyName: task.companyName ?? '',
      kinds,
    });
  }
  return pending;
}

/** The remembered run with these files (`downloadKey`s) added to what was downloaded, each once. */
export function withDownloaded(run: RememberedRun, keys: readonly string[]): RememberedRun {
  const downloaded = [...run.downloaded];
  for (const key of keys) if (!downloaded.includes(key)) downloaded.push(key);
  return { ...run, downloaded };
}

const KIND_FILE_LABELS: Record<DownloadKind, string> = {
  'resume-pdf': 'Resume',
  'resume-docx': 'Resume',
  'cover-letter-pdf': 'Cover letter',
  'cover-letter-docx': 'Cover letter',
};

/**
 * A name for a downloaded file, when the server's own cannot be read.
 *
 * The server names it `<company>_<file name>` in Content-Disposition, but a
 * page on another origin than the API cannot read that header (the API does
 * not expose it), so it is rebuilt here from what the snapshot says: company,
 * profile, and which file it is. Characters a file system refuses are
 * replaced, and the stem is capped so a long company name cannot make a name
 * the download is refused for.
 */
export function downloadName(companyName: string, profileName: string, kind: DownloadKind): string {
  const extension = kind.endsWith('-docx') ? 'docx' : 'pdf';
  const parts = [companyName, profileName, KIND_FILE_LABELS[kind]]
    .map((part) =>
      part
        .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter(Boolean);
  const stem = (parts.join(' - ') || 'Resume').slice(0, 120).trim();
  return `${stem}.${extension}`;
}

/**
 * The file name a Content-Disposition header gives, or null.
 *
 * Reads `filename*=UTF-8''...` first (what Express writes for a non-ASCII
 * name), then a plain `filename="..."`. Anything with a path separator is
 * refused rather than trusted.
 */
export function contentDispositionName(header: string | null | undefined): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  let name: string | null = null;
  if (star) {
    try {
      name = decodeURIComponent(star[1].trim());
    } catch {
      name = null;
    }
  }
  if (!name) {
    const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/.exec(header);
    name = plain ? (plain[1] ?? plain[2] ?? '').trim() : null;
  }
  if (!name || /[\\/]/.test(name)) return null;
  return name;
}

/**
 * The request that stops this tab's run as the page goes away.
 *
 * `keepalive`, so it outlives the page; no body and no Content-Type, so it is
 * a CORS "simple" request with no preflight to lose while the page unloads -
 * the backend reads nothing but the session (POST
 * /generation/batches/:id/release, cookie or bearer). The Authorization header
 * goes along only when the API is on the page's own origin, where there is no
 * preflight to trigger; across origins the session cookie (`ft_session`,
 * SameSite=Lax, so it travels to the API on the same site) is what
 * authenticates it. If even that is missing, the server's grace timer stops
 * the run a little later instead.
 */
export function releaseRequest(
  apiBase: string,
  batchId: string,
  tabId: string,
  pageOrigin: string,
  token: string | null
): { url: string; init: RequestInit } {
  const url = `${apiBase}/generation/batches/${encodeURIComponent(batchId)}/release?tab=${encodeURIComponent(tabId)}`;
  let sameOrigin = false;
  try {
    sameOrigin = new URL(url, pageOrigin).origin === pageOrigin;
  } catch {
    sameOrigin = false;
  }
  return {
    url,
    init: {
      method: 'POST',
      keepalive: true,
      credentials: 'include',
      ...(sameOrigin && token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    },
  };
}

/**
 * Whether following this link takes the person off Build Resumes inside the
 * app - the case that asks to confirm, and then stops the run.
 *
 * Only a plain left click on a link to another page of this origin, opened in
 * this tab. A modified click or `target="_blank"` opens elsewhere and leaves
 * this page running; another origin is a full navigation, which the browser's
 * own leave-site prompt (`beforeunload`) covers; a link to this same page
 * (a `#hash`, or `/` itself) leaves nothing.
 */
export function leavesBuilder(
  link: { href: string; target?: string | null; download?: boolean },
  click: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean },
  here: { origin: string; pathname: string }
): boolean {
  if (click.button !== 0 || click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return false;
  if (link.download) return false;
  if (link.target && link.target !== '_self') return false;
  let next: URL;
  try {
    next = new URL(link.href, here.origin);
  } catch {
    return false;
  }
  if (next.origin !== here.origin) return false;
  return next.pathname !== here.pathname;
}

/** What a run's last snapshot says about how it ended. */
export type RunEndCounts = { state: string; total: number; completed: number; cancelled: number };

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}

/**
 * How a Generate Immediately run ended, in one sentence: what it built, what a
 * Stop (or a page that was left) refunded, and how many files reached this
 * browser - all of the run's, the ones a page before a reload saved included
 * (`savedFileCount`). `snapshot` is the run's last; null when the page never
 * got one.
 */
export function describeRunEnd(snapshot: RunEndCounts | null, savedFiles: number): string {
  const files = savedFiles > 0 ? ` ${count(savedFiles, 'file')} downloaded to this browser.` : '';
  if (!snapshot) {
    return `Lost track of the run before it finished.${files} Check your downloads before building it again.`;
  }
  if (snapshot.state === 'running') {
    return `Still building: ${snapshot.completed} of ${count(snapshot.total, 'resume')} done so far.${files}`;
  }
  if (snapshot.state === 'cancelled' || snapshot.cancelled > 0) {
    return (
      `Stopped after building ${snapshot.completed} of ${count(snapshot.total, 'resume')}; ` +
      `the ${snapshot.cancelled} not built ${snapshot.cancelled === 1 ? 'was' : 'were'} refunded.${files}`
    );
  }
  return `Built ${snapshot.completed} of ${count(snapshot.total, 'resume')}.${files}`;
}

/** Whether the Generate Immediately confirm still shows in this browser. */
export function confirmsImmediate(storage: StorageLike | null): boolean {
  if (!storage) return true;
  return safe(() => storage.getItem(SKIP_IMMEDIATE_CONFIRM_KEY), null) !== '1';
}

/** "Don't show again", for this browser. */
export function skipImmediateConfirm(storage: StorageLike | null): void {
  if (storage) safe(() => storage.setItem(SKIP_IMMEDIATE_CONFIRM_KEY, '1'), undefined);
}
