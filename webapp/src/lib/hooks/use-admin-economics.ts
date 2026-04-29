'use client';

import { useQuery } from '@tanstack/react-query';
import type { AdminEconomics } from '@/lib/types-admin';

export function useAdminEconomics() {
  return useQuery<AdminEconomics>({
    queryKey: ['admin', 'economics'],
    queryFn: async () => {
      const res = await fetch('/api/admin/economics', { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to load economics');
      return res.json();
    },
    staleTime: 1000 * 60 * 5,
    retry: 1,
  });
}
