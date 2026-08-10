'use client';

import { useQuery } from '@tanstack/react-query';
import { IS_DEMO } from '@/lib/demo/is-demo';
import { DEMO_ALERTS } from '@/lib/demo/mock-data';
import { useBootstrapGate } from '@/lib/hooks/use-dashboard-bootstrap';

export interface SpendingAlert {
  id: string;
  type: 'spike' | 'ant' | 'recurring' | 'projection';
  category: string | null;
  amount: number;
  comparison_amount: number;
  message: string;
  action_taken: boolean;
  limit_set: number | null;
  created_at: string;
}

export interface AlertsData {
  alerts: SpendingAlert[];
  isPro: boolean;
}

export type VistaAlertas =
  /** Primera carga: skeleton. */
  | 'cargando'
  /** La lectura falló y no hay nada cacheado que mostrar. */
  | 'error'
  /** Hay datos (frescos o de cache): se pinta la lista, aunque el último refetch haya fallado. */
  | 'lista';

/**
 * Qué pinta /dashboard/alertas. Está separado del componente por la misma razón que
 * `decidirRedirectAuth`: es la pieza que decide si un fallo de red se le muestra al usuario
 * como un fallo o como una buena noticia, y eso no se ve mirando el happy path.
 *
 * El caso que importa es `isError`. La página lo descartaba y caía en el estado vacío, que acá
 * dice "Todo bien por ahora" con un escudo verde (F3, auditoría 10-ago-2026): una lectura caída
 * quedaba indistinguible de "revisamos y no encontramos fugas". El detector de fugas es
 * justamente la pantalla donde esa confusión cuesta más — el usuario se va tranquilo.
 *
 * `error` exige que NO haya data: con cache de React Query servida, un refetch fallido no tiene
 * por qué tapar alertas que sí se conocen. Es el mismo criterio que el dashboard.
 */
export function decidirVistaAlertas(estado: {
  isLoading: boolean;
  isError: boolean;
  data: AlertsData | undefined;
}): VistaAlertas {
  if (estado.isLoading) return 'cargando';
  if (estado.isError && !estado.data) return 'error';
  return 'lista';
}

export function useSpendingAlerts(limit = 20) {
  const gate = useBootstrapGate();
  return useQuery<AlertsData>({
    queryKey: ['spending-alerts', limit],
    enabled: IS_DEMO || gate,
    queryFn: async () => {
      if (IS_DEMO) return { ...DEMO_ALERTS, alerts: DEMO_ALERTS.alerts.slice(0, limit) };
      const res = await fetch(`/api/alerts?limit=${limit}`);
      if (!res.ok) throw new Error('Failed to fetch alerts');
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
}
