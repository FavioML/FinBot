'use client';

import { useQuery } from '@tanstack/react-query';
import type { AdminUserFichaResponse } from '@/lib/types-admin';

// Ficha individual de un usuario (drill-down de admin/users, Ola 4 Fase 2). Solo dispara cuando
// hay un userId seleccionado; el cache de React Query evita refetch al reabrir la misma ficha.
export function useAdminUserFicha(userId: string | null) {
  return useQuery<AdminUserFichaResponse>({
    queryKey: ['admin', 'user-ficha', userId],
    enabled: !!userId,
    queryFn: async () => {
      const res = await fetch(`/api/admin/users/${userId}`, { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to load ficha');
      return res.json();
    },
  });
}
