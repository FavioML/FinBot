'use client';

import { useQuery } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import { IS_DEMO } from '@/lib/demo/is-demo';
import { DEMO_TRANSACTIONS } from '@/lib/demo/mock-data';

export interface CatPair {
  categoria: string;
  subcategoria: string | null;
}

// Catálogo all-time de categorías/subcategorías del usuario. A propósito NO usa la
// query pesada de transacciones (select * de cientos de filas) ni el periodo
// seleccionado: trae solo 2 columnas de TODA la historia, para que el formulario de
// editar transacción siempre ofrezca las subcategorías creadas en cualquier mes,
// sin depender de que la lista completa ya haya cargado (evita la carrera que hacía
// desaparecer subcategorías de otros meses).
export function useUserCategorias(usuarioId?: string) {
  return useQuery({
    queryKey: ['user-categorias', usuarioId],
    queryFn: async (): Promise<CatPair[]> => {
      if (IS_DEMO) {
        return DEMO_TRANSACTIONS.map((t) => ({
          categoria: t.categoria,
          subcategoria: t.subcategoria ?? null,
        }));
      }

      if (!usuarioId) return [];

      const supabase = createClient();
      const { data, error } = await supabase
        .from('transacciones')
        .select('categoria, subcategoria')
        .eq('usuario_id', usuarioId)
        .order('fecha', { ascending: false });

      if (error) throw error;
      return (data as CatPair[]) || [];
    },
    enabled: IS_DEMO || !!usuarioId,
    staleTime: 5 * 60 * 1000,
  });
}
