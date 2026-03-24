'use client';

import { useQuery } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import type { Transaccion } from '@/lib/types';

interface UseTransactionsOptions {
  usuarioId?: string;
  mes?: number;
  anio?: number;
  tipo?: 'gasto' | 'ingreso';
  categoria?: string;
  limit?: number;
}

export function useTransactions(options: UseTransactionsOptions) {
  const supabase = createClient();

  return useQuery({
    queryKey: ['transactions', options],
    queryFn: async (): Promise<Transaccion[]> => {
      if (!options.usuarioId) return [];

      let query = supabase
        .from('transacciones')
        .select('*')
        .eq('usuario_id', options.usuarioId)
        .order('fecha', { ascending: false });

      if (options.mes && options.anio) {
        const startDate = `${options.anio}-${String(options.mes).padStart(2, '0')}-01`;
        const endDate = options.mes === 12
          ? `${options.anio + 1}-01-01`
          : `${options.anio}-${String(options.mes + 1).padStart(2, '0')}-01`;
        query = query.gte('fecha', startDate).lt('fecha', endDate);
      }

      if (options.tipo) query = query.eq('tipo', options.tipo);
      if (options.categoria) query = query.eq('categoria', options.categoria);
      if (options.limit) query = query.limit(options.limit);

      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    },
    enabled: !!options.usuarioId,
  });
}
