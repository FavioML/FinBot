'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { QueryClientProvider, useIsRestoring } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { Sidebar } from '@/components/dashboard/sidebar';
import { Topbar } from '@/components/dashboard/topbar';
import { BottomNav } from '@/components/dashboard/bottom-nav';
import { QuickAddButton } from '@/components/dashboard/quick-add-button';
import { OnboardingTour } from '@/components/dashboard/onboarding-tour';
import { ConnectWhatsappBanner } from '@/components/dashboard/connect-whatsapp-banner';
import { ReferralDiscountBanner } from '@/components/dashboard/referral-discount-banner';
import { WhatsAppButton } from '@/components/shared/whatsapp-button';
import { OverviewSkeleton } from '@/components/dashboard/skeletons';
import { useUser, decidirRedirectAuth } from '@/lib/hooks/use-user';
import {
  useDashboardBootstrap,
  BootstrapGateProvider,
} from '@/lib/hooks/use-dashboard-bootstrap';
import { createClient } from '@/lib/supabase/client';
import {
  queryClient,
  persister,
  clearPersistedCache,
  resumePersist,
  PERSIST_MAX_AGE,
} from '@/lib/query-client';
import { getAuthUserIdSync } from '@/lib/supabase/session';
import { IS_DEMO } from '@/lib/demo/is-demo';
import type { Usuario } from '@/lib/types';

/** Redirects authenticated users without a `usuarios` record to onboarding */
function AuthRedirect() {
  const router = useRouter();
  const { data: user, isPending, isError } = useUser();
  const isRestoring = useIsRestoring();

  useEffect(() => {
    if (IS_DEMO) return;
    // La decision vive en `decidirRedirectAuth` (probada en use-user.test.ts):
    // hay que esperar mientras la cache restaura, mientras la query esta en
    // vuelo, Y si la lectura se cayo — ese ultimo caso es el que expulsaba a
    // /onboarding a un usuario existente por un hipo de Supabase.
    if (decidirRedirectAuth({ isRestoring, isPending, isError, user }) !== 'revisar-sesion') return;

    // Autenticado en Supabase Auth pero sin fila en `usuarios`: falta vincular.
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user: authUser } }) => {
      if (authUser) {
        router.replace('/onboarding');
      } else {
        router.replace('/login');
      }
    });
  }, [user, isPending, isError, isRestoring, router]);

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
        // Re-enable persistence so the correct user's refetched data is cached.
        resumePersist();
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
  const pathname = usePathname();
  // The static chrome (sidebar/topbar) paints instantly from the CDN. Hold back
  // only the page content while (a) the persisted cache restores (a few ms, once,
  // on first load) or (b) the consolidated bootstrap (/api/dashboard) is still in
  // flight on a cold load. During either window queries are paused/gated, so
  // rendering the page now would flash its "no user" empty state before the
  // seed lands. On the overview we show its skeleton; on sub-routes we hold to
  // null (same as the restore window) — their own hooks stay gated so they never
  // self-fetch, they just wait for the seed.
  const isRestoring = useIsRestoring();
  const { settled, blocking } = useDashboardBootstrap();
  const gateContent = isRestoring || blocking;
  const fallback = pathname === '/dashboard' ? <OverviewSkeleton /> : null;

  return (
    <BootstrapGateProvider value={settled}>
      <AuthRedirect />
      <CacheIdentityGuard />
      <div className="noise-bg flex h-screen overflow-hidden">
        <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
        <div className="flex flex-1 flex-col overflow-hidden">
          <Topbar onMenuClick={() => setSidebarOpen(true)} />
          <main className="flex-1 overflow-y-auto p-4 pb-44 md:p-6 md:pb-28 lg:p-8 lg:pb-28">
            <div className="mx-auto max-w-7xl">
              {!gateContent && <ConnectWhatsappBanner />}
              {/* En /dashboard/pro el PaymentForm ya muestra el detalle del descuento; evitar duplicar. */}
              {!gateContent && pathname !== '/dashboard/pro' && <ReferralDiscountBanner />}
              {gateContent ? fallback : children}
            </div>
          </main>
          <BottomNav />
        </div>
        <QuickAddButton />
        <WhatsAppButton />
        <OnboardingTour />
      </div>
    </BootstrapGateProvider>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  // Bust the persisted cache per authenticated user: a cache is only restored
  // when it was written by the same user currently logged in on this device.
  // Read once on mount (stable across re-renders); '' on the server / when the
  // session can't be read, which — with CacheIdentityGuard — errs toward
  // discarding rather than leaking.
  const [buster] = useState(() => getAuthUserIdSync() ?? '');

  // A previous logout pauses persistence (to keep the cache wiped); re-enable it
  // now that a dashboard is mounting again (i.e. a fresh authenticated session).
  useEffect(() => {
    resumePersist();
  }, []);

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
