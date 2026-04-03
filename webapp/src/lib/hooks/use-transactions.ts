'use client';

import { useQuery } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import type { Transaccion } from '@/lib/types';
import { IS_DEMO } from '@/lib/demo/is-demo';
import { DEMO_TRANSACTIONS } from '@/lib/demo/mock-data';

interface UseTransactionsOptions {
  usuarioId?: string;
  mes?: number;
  anio?: number;
  tipo?: 'gasto' | 'ingreso';
  categoria?: string;
  limit?: number;
}

export function useTransactions(options: UseTransactionsOptions) {
  return useQuery({
    queryKey: ['transactions', options],
    queryFn: async (): Promise<Transaccion[]> => {
      if (IS_DEMO) {
        let txs = [...DEMO_TRANSACTIONS];
        if (options.mes && options.anio) {
          const startDate = `${options.anio}-${String(options.mes).padStart(2, '0')}-01`;
          const endDate = options.mes === 12
            ? `${options.anio + 1}-01-01`
            : `${options.anio}-${String(options.mes + 1).padStart(2, '0')}-01`;
          txs = txs.filter(t => t.fecha >= startDate && t.fecha < endDate);
        } else if (options.anio && !options.mes) {
          const anio = options.anio;
          txs = txs.filter(t => t.fecha >= `${anio}-01-01` && t.fecha < `${anio + 1}-01-01`);
        }
        if (options.tipo) txs = txs.filter(t => t.tipo === options.tipo);
        if (options.categoria) txs = txs.filter(t => t.categoria === options.categoria);
        if (options.limit) txs = txs.slice(0, options.limit);
        return txs;
      }

      if (!options.usuarioId) return [];

      const supabase = createClient();
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
      } else if (options.anio && !options.mes) {
        const startDate = `${options.anio}-01-01`;
        const endDate = `${options.anio + 1}-01-01`;
        query = query.gte('fecha', startDate).lt('fecha', endDate);
      }

      if (options.tipo) query = query.eq('tipo', options.tipo);
      if (options.categoria) query = query.eq('categoria', options.categoria);
      if (options.limit) query = query.limit(options.limit);

      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    },
    enabled: IS_DEMO || !!options.usuarioId,
  });
}
