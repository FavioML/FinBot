'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { QueryClientProvider } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { Sidebar } from '@/components/dashboard/sidebar';
import { Topbar } from '@/components/dashboard/topbar';
import { BottomNav } from '@/components/dashboard/bottom-nav';
import { QuickAddButton } from '@/components/dashboard/quick-add-button';
import { OnboardingTour } from '@/components/dashboard/onboarding-tour';
import { WhatsAppButton } from '@/components/shared/whatsapp-button';
import { useUser } from '@/lib/hooks/use-user';
import { createClient } from '@/lib/supabase/client';
import {
  queryClient,
  persister,
  clearPersistedCache,
  PERSIST_MAX_AGE,
} from '@/lib/query-client';
import { getAuthUserIdSync } from '@/lib/supabase/session';
import { IS_DEMO } from '@/lib/demo/is-demo';
import type { Usuario } from '@/lib/types';

/** Redirects authenticated users without a `usuarios` record to onboarding */
function AuthRedirect() {
  const router = useRouter();
  const { data: user, isLoading } = useUser();

  useEffect(() => {
    if (IS_DEMO) return;
    if (isLoading) return;
    if (user) return; // has usuarios record — all good

    // Check if authenticated via Supabase Auth but missing usuarios record
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user: authUser } }) => {
      if (authUser) {
        router.replace('/onboarding');
      } else {
        router.replace('/login');
      }
    });
  }, [user, isLoading, router]);

  return null;
}

/**
 * Identity backstop for the persisted cache. The `buster` already prevents a
 * cache from restoring for a different user, but if the sync cookie read ever
 * fails (buster ''), two different users could share the empty buster. So once
 * we confirm the real authenticated identity, we compare it against the cached
 * user and wipe the cache on any drift. Runs after first paint (non-blocking),
 * so it never delays the instant restore in the common (same-user) case.
 */
function CacheIdentityGuard() {
  useEffect(() => {
    if (IS_DEMO) return;
    let cancelled = false;

    (async () => {
      const supabase = createClient();
      const { data: { user: authUser } } = await supabase.auth.getUser();
      if (cancelled) return;

      const authId = authUser?.id ?? null;
      const cached = queryClient.getQueryData<Usuario | null>(['user']);
      if (!cached) return; // nothing persisted to leak

      const cachedAuthId = cached.supabase_auth_id ?? null;
      const drift = !authId || cachedAuthId !== authId;
      if (drift) {
        clearPersistedCache();
        queryClient.invalidateQueries();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}

function ShellChrome({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <>
      <AuthRedirect />
      <CacheIdentityGuard />
      <div className="noise-bg flex h-screen overflow-hidden">
        <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
        <div className="flex flex-1 flex-col overflow-hidden">
          <Topbar onMenuClick={() => setSidebarOpen(true)} />
          <main className="flex-1 overflow-y-auto p-4 pb-44 md:p-6 md:pb-28 lg:p-8 lg:pb-28">
            <div className="mx-auto max-w-7xl">
              {children}
            </div>
          </main>
          <BottomNav />
        </div>
        <QuickAddButton />
        <WhatsAppButton />
        <OnboardingTour />
      </div>
    </>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  // Bust the persisted cache per authenticated user: a cache is only restored
  // when it was written by the same user currently logged in on this device.
  // Read once on mount (stable across re-renders); '' on the server / when the
  // session can't be read, which — with CacheIdentityGuard — errs toward
  // discarding rather than leaking.
  const [buster] = useState(() => getAuthUserIdSync() ?? '');

  const persistOptions = useMemo(
    () => ({ persister, maxAge: PERSIST_MAX_AGE, buster }),
    [buster],
  );

  // Demo mode never persists financial data to localStorage.
  if (IS_DEMO) {
    return (
      <QueryClientProvider client={queryClient}>
        <ShellChrome>{children}</ShellChrome>
      </QueryClientProvider>
    );
  }

  return (
    <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>
      <ShellChrome>{children}</ShellChrome>
    </PersistQueryClientProvider>
  );
}
