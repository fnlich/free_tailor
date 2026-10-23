'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import css from './resumePages.module.css';

/** A4 at 96 dpi: the page every template prints on (app/admin/templates/page.tsx says why). */
export const PAGE_WIDTH_PX = 794;
export const PAGE_HEIGHT_PX = 1123;

/**
 * One printed page, scaled down to the width of its box: the template
 * chooser's cards, its detail dialog, and the Profiles page's cards.
 *
 * The frame is laid out at the page's own size and scaled, never reflowed at
 * the box's width, so a thumbnail is the page as it prints. A template's page
 * comes from its gallery preview (`src`, the sample person); a resume's from
 * the server's render of it (`srcDoc`), framed with every sandbox flag off -
 * nothing in it runs, and nothing here measures it. Until there is a page to
 * show, `placeholder` stands on the white sheet instead.
 *
 * A new `src` is a new frame, never the loaded one sent to another address:
 * that would add an entry to the browser's history for each change, so the
 * details' Grouped / Plain switch left a Back press per click, and Back
 * turned the frame's page back - Grouped again under a switch still saying
 * Plain - while everything around it stayed put. A frame's first load adds
 * none. The box and its scale stay.
 */
export function PageThumb({
  src,
  srcDoc,
  title,
  lazy = true,
  placeholder,
  className = '',
}: {
  src?: string;
  srcDoc?: string;
  /** For the frame; the card around it carries the name a reader hears. */
  title: string;
  lazy?: boolean;
  placeholder?: ReactNode;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => setScale(element.clientWidth / PAGE_WIDTH_PX);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const hasPage = Boolean(src) || srcDoc !== undefined;
  return (
    <div ref={box} className={`${css.thumb} ${className}`}>
      {hasPage && scale > 0 ? (
        <iframe
          key={src ?? 'srcdoc'}
          src={src}
          srcDoc={srcDoc}
          title={title}
          aria-hidden="true"
          tabIndex={-1}
          scrolling="no"
          loading={lazy ? 'lazy' : 'eager'}
          {...(srcDoc !== undefined ? { sandbox: '' } : {})}
          style={{ width: PAGE_WIDTH_PX, height: PAGE_HEIGHT_PX, transform: `scale(${scale})` }}
        />
      ) : (
        placeholder
      )}
    </div>
  );
}

/** The shimmer on a white page while it is drawn. */
export function ThumbLoading() {
  return <span className={css.thumbLoading} aria-hidden="true" />;
}

/** A sentence on the white page, for a page that could not be drawn. */
export function ThumbState({ children }: { children: ReactNode }) {
  return <span className={css.thumbState}>{children}</span>;
}
