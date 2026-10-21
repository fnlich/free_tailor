'use client';

import type { ReactNode } from 'react';

import { linkHost, safeWebLink } from '@/lib/jobLakeDisplay';

/**
 * Cells the lake's tables share - Admin -> Job Lake and Find Jobs.
 */

/** A table cell's text in its own colour. On an inner span: the unlayered td rule beats a utility on the td. */
export function Cell({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return <span className={muted ? 'text-subtle' : 'text-ink'}>{children}</span>;
}

/**
 * A job link from a sheet or the lake: an anchor in a new tab, showing the
 * link's host - or `children`, a job's title - only when it is a web address
 * (`safeWebLink`); else the text as it is. A title breaks inside a word only
 * when a word is wider than its column (`wrap-anywhere`), so no title widens
 * Find Jobs' table past its box.
 */
export function WebLink({ value, children }: { value: string; children?: ReactNode }) {
  const href = safeWebLink(value);
  const wrap = children ? 'wrap-anywhere' : 'break-all';
  if (!href) {
    if (children) return <span className={wrap}>{children}</span>;
    return value.trim() ? <span className={wrap}>{value}</span> : <span className="text-subtle">-</span>;
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={`tl-link ${wrap}`} title={href}>
      {children ?? linkHost(href)}
    </a>
  );
}
