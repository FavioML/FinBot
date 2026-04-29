'use client';

import { useQuery } from '@tanstack/react-query';
import { IS_DEMO } from '@/lib/demo/is-demo';

export function useIsAdmin() {
  return useQuery({
    queryKey: ['is-admin'],
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
