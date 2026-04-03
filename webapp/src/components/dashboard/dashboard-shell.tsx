'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Sidebar } from '@/components/dashboard/sidebar';
import { Topbar } from '@/components/dashboard/topbar';
import { BottomNav } from '@/components/dashboard/bottom-nav';
import { QuickAddButton } from '@/components/dashboard/quick-add-button';
import { OnboardingTour } from '@/components/dashboard/onboarding-tour';
import { WhatsAppButton } from '@/components/shared/whatsapp-button';
import { useUser } from '@/lib/hooks/use-user';
import { createClient } from '@/lib/supabase/client';
import { IS_DEMO } from '@/lib/demo/is-demo';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5,
      retry: 1,
    },
  },
});

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

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <QueryClientProvider client={queryClient}>
      <AuthRedirect />
      <div className="noise-bg flex h-screen overflow-hidden">
        <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
        <div className="flex flex-1 flex-col overflow-hidden">
          <Topbar onMenuClick={() => setSidebarOpen(true)} />
          <main className="flex-1 overflow-y-auto p-4 pb-20 md:p-6 md:pb-6 lg:p-8 lg:pb-8 transition-all duration-300">
            {children}
          </main>
          <BottomNav />
        </div>
        <QuickAddButton />
        <WhatsAppButton />
        <OnboardingTour />
      </div>
    </QueryClientProvider>
  );
}
