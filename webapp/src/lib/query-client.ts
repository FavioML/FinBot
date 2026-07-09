import { QueryClient } from '@tanstack/react-query';
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
import type { Persister } from '@tanstack/react-query-persist-client';
import { createClient } from '@/lib/supabase/client';

/** localStorage key holding the persisted React Query cache. */
export const PERSIST_KEY = 'neto-rq';

/** How long a persisted cache stays valid. Financial data shouldn't linger in
 *  localStorage beyond a day. gcTime is set to match so restored queries aren't
 *  garbage-collected before maxAge. */
export const PERSIST_MAX_AGE = 1000 * 60 * 60 * 24; // 24h

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5,
      gcTime: PERSIST_MAX_AGE,
      retry: 1,
    },
  },
});

const storage = typeof window !== 'undefined' ? window.localStorage : undefined;
const basePersister = createSyncStoragePersister({ storage, key: PERSIST_KEY });

// When true, writes are suppressed. On logout we clear the cache, but
// queryClient.clear() emits a cache-change event that the persist subscriber
// would immediately re-save (an empty cache still leaves the key — with the old
// user's buster — in localStorage). Pausing writes first makes the removal on
// logout deterministic; the next dashboard mount resumes persistence.
let persistPaused = false;

/** Persister wrapper that honors the logout pause. */
export const persister: Persister = {
  persistClient(client) {
    if (persistPaused) return;
    return basePersister.persistClient(client);
  },
  restoreClient() {
    return basePersister.restoreClient();
  },
  removeClient() {
    return basePersister.removeClient();
  },
};

/** Re-enable persistence. Called on dashboard mount so a fresh login after a
 *  logout persists normally again. */
export function resumePersist(): void {
  persistPaused = false;
}

/** Wipe both the in-memory cache and the persisted copy, and keep it wiped
 *  (writes paused) until the next dashboard mount. Called on logout and whenever
 *  the authenticated identity no longer matches the cached one. */
export function clearPersistedCache(): void {
  persistPaused = true;
  try {
    queryClient.clear();
  } catch {
    /* noop */
  }
  try {
    if (typeof window !== 'undefined') window.localStorage.removeItem(PERSIST_KEY);
  } catch {
    /* noop */
  }
}

/** Sign the user out and guarantee no financial data survives in localStorage.
 *  Callers handle their own post-logout redirect. */
export async function signOutAndClear(): Promise<void> {
  clearPersistedCache();
  await createClient().auth.signOut();
}
