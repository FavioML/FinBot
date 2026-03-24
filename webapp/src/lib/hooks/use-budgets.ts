'use client';

import { useQuery } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import type { Presupuesto } from '@/lib/types';

export function useBudgets(usuarioId?: string, mes?: number, anio?: number) {
  const supabase = createClient();

  return useQuery({
    queryKey: ['budgets', usuarioId, mes, anio],
    queryFn: async (): Promise<Presupuesto[]> => {
      if (!usuarioId) return [];

      let query = supabase
        .from('presupuestos')
        .select('*')
        .eq('usuario_id', usuarioId);

      if (mes) query = query.eq('mes', mes);
      if (anio) query = query.eq('anio', anio);

      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    },
    enabled: !!usuarioId,
  });
}
