'use client';

import { useQuery } from '@tanstack/react-query';
import { IS_DEMO } from '@/lib/demo/is-demo';
import { useBootstrapGate } from '@/lib/hooks/use-dashboard-bootstrap';

export function useIsAdmin() {
  const gate = useBootstrapGate();
  return useQuery({
    queryKey: ['is-admin'],
    enabled: IS_DEMO || gate,
    queryFn: async (): Promise<boolean> => {
      if (IS_DEMO) return false;
      const res = await fetch('/api/admin/check', { cache: 'no-store' });
      if (!res.ok) return false;
      const data = await res.json();
      return Boolean(data.isAdmin);
    },
    staleTime: 1000 * 60 * 15,
    retry: 0,
  });
}
