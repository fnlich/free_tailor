import type { AIProvider, ProviderHealthReport } from './api';

/** One hold a seat has put on itself: on every model ('*') or on one. */
export type SeatHold = { scope: string; reason: string; expiresAt: string };

/**
 * The holds the admin Settings card shows for one seat.
 *
 * Per seat, from `outagesByProvider`: Claude and Gemini both hold themselves
 * off after a sign-in failure or a spent quota, and a Gemini seat held for 30
 * minutes with nothing on its card looked healthy while every call was turned
 * away. `subscription.outages` is the Claude seat's alone, so it stands in only
 * for Claude, and only when a server too old to send the map answered. Codex
 * keeps no holds, so its list is empty.
 *
 * Imports nothing at runtime, so the backend suite can load it.
 */
export function seatHolds(
  health: Pick<ProviderHealthReport, 'subscription' | 'outagesByProvider'> | null | undefined,
  provider: AIProvider
): SeatHold[] {
  if (!health) return [];
  const own = health.outagesByProvider?.[provider];
  if (own) return own;
  return provider === 'claude-cli' ? health.subscription?.outages ?? [] : [];
}
