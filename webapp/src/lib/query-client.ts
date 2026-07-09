import { QueryClient } from '@tanstack/react-query';
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
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

/** Sync-storage persister backed by localStorage in the browser; a no-op on the
 *  server (createSyncStoragePersister returns a noop persister for undefined
 *  storage), so this is safe to evaluate during static prerender of the shell. */
export const persister = createSyncStoragePersister({
  storage: typeof window !== 'undefined' ? window.localStorage : undefined,
  key: PERSIST_KEY,
});

/** Wipe both the in-memory cache and the persisted copy. Called on logout and
 *  whenever the authenticated identity no longer matches the cached one. */
export function clearPersistedCache(): void {
  try {
    queryClient.clear();
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
