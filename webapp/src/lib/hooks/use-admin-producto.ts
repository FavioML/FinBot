'use client';

import { useQuery } from '@tanstack/react-query';
import type { AdminProducto } from '@/lib/types-admin';

export function useAdminProducto() {
  return useQuery<AdminProducto>({
    queryKey: ['admin', 'producto'],
    queryFn: async () => {
      const res = await fetch('/api/admin/producto', { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to load product metrics');
      return res.json();
    },
    staleTime: 1000 * 60 * 5,
    retry: 1,
  });
}
