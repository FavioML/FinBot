'use client';

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import type { Transaccion } from '@/lib/types';
import { IS_DEMO } from '@/lib/demo/is-demo';
import { DEMO_TRANSACTIONS } from '@/lib/demo/mock-data';
import { todasLasFilas } from '@/lib/supabase/todas-las-filas';

interface UseTransactionsOptions {
  usuarioId?: string;
  mes?: number;
  anio?: number;
  /** Rango libre sobre `fecha` (DATE): `desde` inclusivo, `hasta` exclusivo. Le gana a mes/anio. */
  desde?: string;
  hasta?: string;
  tipo?: 'gasto' | 'ingreso';
  categoria?: string;
  limit?: number;
}

/**
 * `mantenerAnterior` va aparte de `options` a propósito: `options` ES la key de la caché, y meterlo
 * ahí partiría la entrada que comparten Reportes, Transacciones y el overview. Con él, al cambiar
 * de periodo la pantalla sigue mostrando la lista anterior (`isPlaceholderData`) hasta que llega
 * la nueva, en vez de volver al skeleton entero.
 */
export function useTransactions(options: UseTransactionsOptions, { mantenerAnterior = false } = {}) {
  return useQuery({
    placeholderData: mantenerAnterior ? keepPreviousData : undefined,
    queryKey: ['transactions', options],
    queryFn: async (): Promise<Transaccion[]> => {
      if (IS_DEMO) {
        let txs = [...DEMO_TRANSACTIONS];
        if (options.desde && options.hasta) {
          const { desde, hasta } = options;
          txs = txs.filter(t => t.fecha >= desde && t.fecha < hasta);
        } else if (options.mes && options.anio) {
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
      const usuarioId = options.usuarioId;
      // Se arma de nuevo en cada página (ver `todasLasFilas`). `created_at` deja los movimientos
      // de un mismo día en orden de registro, y el `id` al final es lo que hace estable la
      // paginación (es único; `created_at` puede empatar en una importación).
      const armar = (conteo: boolean) => {
        let query = supabase
          .from('transacciones')
          .select('*', conteo ? { count: 'exact' } : undefined)
          .eq('usuario_id', usuarioId)
          .order('fecha', { ascending: false })
          .order('created_at', { ascending: false })
          .order('id', { ascending: false });

        if (options.desde && options.hasta) {
          query = query.gte('fecha', options.desde).lt('fecha', options.hasta);
        } else if (options.mes && options.anio) {
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
        return query;
      };

      // Con `limit` el llamador pidió las N primeras a propósito. Sin él espera TODAS, y PostgREST
      // corta en 1000 sin avisar: la vista Anual y el historial completo salían cortos.
      if (options.limit) {
        const { data, error } = await armar(false).limit(options.limit);
        if (error) throw error;
        return data || [];
      }
      const { data, error } = await todasLasFilas<Transaccion>(
        (desde, hasta, primera) => armar(primera).range(desde, hasta),
        (t) => t.id,
      );
      if (error) throw error;
      return data;
    },
    enabled: IS_DEMO || !!options.usuarioId,
  });
}
