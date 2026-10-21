import { getUserById } from '../../database/userRepository';

/**
 * Who a lake row names as having reported it (or whose build produced it),
 * as the administrators' pages show them - Admin -> Job Lake, and an
 * administrator's Find Jobs. Never sent to anybody else.
 */
export type Requester = { id: string; email: string; name: string } | null;

/** The accounts a list names, looked up once each, `null` for one deleted since. */
export function requesterLookup(): (id: string | null) => Requester {
  const cache = new Map<string, Requester>();
  return (id) => {
    if (!id) return null;
    if (!cache.has(id)) {
      const account = getUserById(id);
      cache.set(id, account ? { id: account.id, email: account.email, name: account.name } : null);
    }
    return cache.get(id) ?? null;
  };
}
