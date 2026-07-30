'use client';

import { useQuery } from '@tanstack/react-query';
import type { AdminPnlMonth } from '@/lib/types-admin';

export function useAdminPnl() {
  return useQuery<AdminPnlMonth[]>({
    queryKey: ['admin', 'pnl'],
    queryFn: async () => {
      const res = await fetch('/api/admin/pnl', { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to load P&L');
      const json = await res.json();
      return json.months || [];
    },
    staleTime: 1000 * 60 * 5,
    retry: 1,
  });
}
