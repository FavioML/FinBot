'use client';

import { useQuery } from '@tanstack/react-query';
import type { AdminRenovacionesResponse } from '@/lib/types-admin';

export function useAdminRenovaciones() {
  return useQuery<AdminRenovacionesResponse>({
    queryKey: ['admin', 'renovaciones'],
    queryFn: async () => {
      const res = await fetch('/api/admin/payments/renewals', { cache: 'no-store' });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || 'No se pudieron leer las renovaciones');
      }
      return res.json();
    },
    staleTime: 1000 * 60 * 5,
    retry: 1,
  });
}
