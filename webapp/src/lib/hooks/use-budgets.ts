'use client';

import { useQuery } from '@tanstack/react-query';
import type { Presupuesto } from '@/lib/types';

export function useBudgets(usuarioId?: string, mes?: number, anio?: number) {
  return useQuery({
    queryKey: ['budgets', usuarioId, mes, anio],
    queryFn: async (): Promise<Presupuesto[]> => {
      if (!usuarioId || !mes || !anio) return [];

      const res = await fetch(`/api/budgets?mes=${mes}&anio=${anio}`);
      if (!res.ok) throw new Error('Failed to fetch budgets');
      return res.json();
    },
    enabled: !!usuarioId && !!mes && !!anio,
  });
}
