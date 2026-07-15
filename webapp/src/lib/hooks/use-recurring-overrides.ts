'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import type { RecurringOverride } from '@/lib/types';
import { IS_DEMO } from '@/lib/demo/is-demo';

type Dominio = 'recurrente' | 'suscripcion';

// Store en memoria para modo demo (sin backend): mantiene los overrides interactivos
// durante la sesión para poder demostrar unir/renombrar/ocultar.
const demoStore: RecurringOverride[] = [];

/** Campos que una acción puede enviar (parcial, el API hace merge). */
export interface OverridePatch {
  clave_variante: string;
  id_canonico?: string | null;
  label_canonico?: string | null;
  oculto?: boolean;
  es_recurrente_manual?: boolean | null;
  catalog_id?: string | null;
  plan_nombre?: string | null;
}

export function useRecurringOverrides(dominio: Dominio) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['recurring-overrides', dominio],
    queryFn: async (): Promise<RecurringOverride[]> => {
      if (IS_DEMO) return demoStore.filter((o) => o.dominio === dominio);
      const supabase = createClient();
      const { data, error } = await supabase
        .from('recurrentes_overrides')
        .select('*')
        .eq('dominio', dominio);
      if (error) throw error;
      return (data || []) as RecurringOverride[];
    },
    staleTime: 5 * 60 * 1000,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['recurring-overrides', dominio] });
    queryClient.invalidateQueries({ queryKey: ['recurring'] });
    queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
  };

  const upsert = useMutation({
    mutationFn: async (patch: OverridePatch): Promise<void> => {
      if (IS_DEMO) {
        const idx = demoStore.findIndex(
          (o) => o.dominio === dominio && o.clave_variante === patch.clave_variante
        );
        if (idx >= 0) demoStore[idx] = { ...demoStore[idx], ...patch };
        else demoStore.push({ dominio, ...patch });
        return;
      }
      const res = await fetch('/api/recurring/override', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dominio, ...patch }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || 'Error');
    },
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: async (claveVariante: string): Promise<void> => {
      if (IS_DEMO) {
        const idx = demoStore.findIndex(
          (o) => o.dominio === dominio && o.clave_variante === claveVariante
        );
        if (idx >= 0) demoStore.splice(idx, 1);
        return;
      }
      const params = new URLSearchParams({ dominio, clave_variante: claveVariante });
      const res = await fetch(`/api/recurring/override?${params}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || 'Error');
    },
    onSuccess: invalidate,
  });

  return {
    overrides: query.data ?? [],
    isLoading: query.isLoading,
    upsert,
    remove,
  };
}
