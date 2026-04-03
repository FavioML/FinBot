'use client';

import { useQuery } from '@tanstack/react-query';
import type { Presupuesto } from '@/lib/types';
import { IS_DEMO } from '@/lib/demo/is-demo';
import { DEMO_BUDGETS } from '@/lib/demo/mock-data';

export function useBudgets(usuarioId?: string, mes?: number, anio?: number) {
  return useQuery({
    queryKey: ['budgets', usuarioId, mes, anio],
    queryFn: async (): Promise<Presupuesto[]> => {
      if (IS_DEMO) {
        if (!mes || !anio) return DEMO_BUDGETS;
        return DEMO_BUDGETS.filter(b => b.mes === mes && b.anio === anio);
      }

      if (!usuarioId || !mes || !anio) return [];

      const res = await fetch(`/api/budgets?mes=${mes}&anio=${anio}`);
      if (!res.ok) throw new Error('Failed to fetch budgets');
      return res.json();
    },
    enabled: IS_DEMO || (!!usuarioId && !!mes && !!anio),
  });
}
