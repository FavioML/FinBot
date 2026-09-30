'use client';

import { useQuery } from '@tanstack/react-query';
import type { AdminPagosResponse } from '@/lib/types-admin';

/** Pagos recibidos del mes `mes` ('YYYY-MM'; null = el mes en curso, que resuelve la ruta). */
export function useAdminPagos(mes: string | null) {
  return useQuery<AdminPagosResponse>({
    queryKey: ['admin', 'pagos', mes],
    queryFn: async () => {
      const qs = mes ? `?mes=${encodeURIComponent(mes)}` : '';
      const res = await fetch(`/api/admin/payments/history${qs}`, { cache: 'no-store' });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || 'No se pudieron leer los pagos');
      }
      return res.json();
    },
    staleTime: 1000 * 60 * 5,
    retry: 1,
  });
}
