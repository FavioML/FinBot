'use client';

import { useQuery } from '@tanstack/react-query';

export interface AdviceContext {
  totalGastos: number;
  totalIngresos: number;
  topCategorias: string;
  scoreFinanciero: number;
  subscriptionTotal?: number;
}

/** La key ES el prompt: `/api/advice` no cachea nada del lado del servidor, así
 *  que dos contextos idénticos producen el mismo consejo y no hay razón para
 *  pagar otra llamada a OpenAI. Derivarla del contenido —y no del montaje— es lo
 *  que hace que alternar Mensual/Anual o volver al dashboard reuse el cache.
 *  Medido el 17-ago-2026 ANTES de este hook: 4 llamadas a GPT-4o-mini en 30s de
 *  uso normal (carga + tab Anual + tab Mensual + volver), porque el componente
 *  fetcheaba en un `useEffect([])` y hay TRES `InsightCard` en el árbol (grid
 *  desktop, móvil y vista anual): cada cambio de vista desmonta uno y monta otro. */
export function adviceQueryKey(ctx: AdviceContext) {
  return [
    'advice',
    Math.round(ctx.totalGastos),
    Math.round(ctx.totalIngresos),
    Math.round(ctx.scoreFinanciero),
    ctx.topCategorias,
    Math.round(ctx.subscriptionTotal || 0),
  ] as const;
}

/** Un consejo del mes no cambia entre dos vistas del mismo dashboard. Se
 *  refresca por contenido (key nueva) o porque el usuario pide otro
 *  explícitamente con `refetch()`, que ignora el staleTime. */
export const ADVICE_STALE_TIME = 1000 * 60 * 30;

export function useAdvice(ctx: AdviceContext | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ctx ? adviceQueryKey(ctx) : ['advice', 'sin-contexto'],
    queryFn: async (): Promise<string> => {
      const res = await fetch('/api/advice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ctx),
      });
      if (!res.ok) throw new Error(`advice ${res.status}`);
      const data = await res.json();
      if (!data.advice) throw new Error('advice vacío');
      return data.advice as string;
    },
    // `totalGastos === 0` es el mes sin data: el insight rule-based local ya dice
    // lo correcto y la llamada no tendría nada que analizar.
    enabled: enabled && !!ctx && ctx.totalGastos > 0,
    staleTime: ADVICE_STALE_TIME,
    // El consejo es un extra: si OpenAI se cae, la tarjeta se queda con el
    // insight local en vez de reintentar y dejar el spinner girando.
    retry: false,
    refetchOnWindowFocus: false,
  });
}
