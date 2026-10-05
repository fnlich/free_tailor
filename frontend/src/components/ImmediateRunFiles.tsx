'use client';

import { FILE_KIND_LABELS } from '@/lib/orders';
import type { DownloadKind, PendingDownload } from '@/lib/immediateRun';

/**
 * Every finished resume of this tab's Generate Immediately run, each file a
 * button that downloads it again.
 *
 * The page downloads each resume by itself as it lands, but a browser that
 * holds back a page's second automatic download (Chrome's "This site is trying
 * to download multiple files") does it SILENTLY: the click the page made went
 * through, nothing arrived, and nothing told the page. This is the way to get
 * those files while the server still keeps them - IMMEDIATE_FILE_RETENTION_MS
 * after the run ends, ten minutes by default - after which a press answers
 * that the file was deleted.
 */
export default function ImmediateRunFiles({
  items,
  running,
  downloading,
  onDownload,
  onDismiss,
}: {
  items: readonly PendingDownload[];
  /** The run is still going: more rows will come, and it cannot be dismissed yet. */
  running: boolean;
  /** `<taskId>:<kind>` of the file being fetched now, or ''. */
  downloading: string;
  onDownload: (item: PendingDownload, kind: DownloadKind) => void;
  onDismiss: () => void;
}) {
  return (
    <section className="tl-card" aria-label="This run's files">
      <div className="tl-card-header">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink">This run&apos;s files</h2>
          <p className="mt-1 text-sm text-muted">
            Each resume downloads by itself as it is built. If your browser held any back, download it
            here - the server keeps them only a few minutes after the run ends.
          </p>
        </div>
        {!running && (
          <button type="button" onClick={onDismiss} className="tl-button-quiet shrink-0" data-size="sm">
            Hide
          </button>
        )}
      </div>
      <ul className="divide-y divide-[var(--line-subtle)]">
        {items.map((item) => (
          <li key={item.taskId} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 py-3">
            <span className="min-w-0 break-words text-sm text-ink">
              <span className="font-medium">{item.companyName || 'Resume'}</span>
              {item.profileName && <span className="text-muted"> · {item.profileName}</span>}
            </span>
            <span className="flex flex-wrap gap-2">
              {item.kinds.map((kind) => {
                const key = `${item.taskId}:${kind}`;
                return (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => onDownload(item, kind)}
                    disabled={downloading === key}
                    className="tl-button-quiet"
                    data-size="sm"
                  >
                    {downloading === key ? 'Downloading...' : FILE_KIND_LABELS[kind]}
                  </button>
                );
              })}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
