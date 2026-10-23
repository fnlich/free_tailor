/*
 * Where focus goes when a card leaves the page (a resume deleted or moved out
 * of a profile, a profile deleted): the card after it, else the one before it,
 * else the page's New tile. Without this the focused card unmounts and focus
 * falls to the document, and a keyboard starts again from the top.
 */

export type CardKind = 'profile' | 'resume';

/**
 * The id to focus once `removed` have gone from `order` (the ids as displayed):
 * the first remaining one after the first removed, else the last remaining one
 * before it, else null.
 */
export function neighbourOf(order: readonly string[], removed: readonly string[]): string | null {
  const gone = new Set(removed);
  const at = order.findIndex((id) => gone.has(id));
  if (at < 0) return null;
  for (let index = at + 1; index < order.length; index += 1) {
    if (!gone.has(order[index])) return order[index];
  }
  for (let index = at - 1; index >= 0; index -= 1) {
    if (!gone.has(order[index])) return order[index];
  }
  return null;
}

/**
 * Focuses the card (or list row) of `id`, else the New tile of the kind, else
 * (List view, which has no tile) the page's `[data-new-fallback]` button.
 * Call it after the lists have been read again: it waits two frames for the
 * page to draw them.
 */
export function focusCard(kind: CardKind, id: string | null): void {
  if (typeof window === 'undefined') return;
  const draw = window.requestAnimationFrame.bind(window);
  draw(() =>
    draw(() => {
      const escaped = id === null ? null : id.replace(/["\\]/g, '\\$&');
      const target =
        (escaped !== null
          ? document.querySelector<HTMLElement>(
              `[data-${kind}-card="${escaped}"] a[href], [data-${kind}-row="${escaped}"] a[href]`
            )
          : null) ??
        document.querySelector<HTMLElement>(`[data-new-tile="${kind}"]`) ??
        // List view draws no tile: the page's own New button of the kind (the header's Create New,
        // which is there in either view) takes focus instead.
        document.querySelector<HTMLElement>(`[data-new-fallback="${kind}"]`);
      target?.focus();
    })
  );
}
