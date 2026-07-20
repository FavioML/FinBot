'use client';

import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IS_DEMO } from '@/lib/demo/is-demo';
import { DEMO_SCORE } from '@/lib/demo/mock-data';
import { useBootstrapGate } from '@/lib/hooks/use-dashboard-bootstrap';

export interface NetoScoreFactors {
  consistency: number;
  budget: number;
  savings: number;
  goals: number;
  debts: number;
  visibility: number;
}

export interface NetoScoreHistoryEntry {
  score: number;
  period: string;
  factor_consistency?: number;
  factor_budget?: number;
  factor_savings?: number;
  factor_goals?: number;
  factor_debts?: number;
  factor_visibility?: number;
}

export interface NetoScoreData {
  score: number | null;
  period: string;
  factors?: NetoScoreFactors;
  history?: NetoScoreHistoryEntry[];
}

export function useNetoScore() {
  const gate = useBootstrapGate();
  return useQuery<NetoScoreData>({
    queryKey: ['neto-score'],
    enabled: IS_DEMO || gate,
    queryFn: async () => {
      if (IS_DEMO) return DEMO_SCORE;
      const res = await fetch('/api/score');
      if (!res.ok) throw new Error('Failed to fetch score');
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
}

export function useNetoScoreHistory(months = 6) {
  const queryClient = useQueryClient();
  const gate = useBootstrapGate();

  const query = useQuery<NetoScoreData>({
    queryKey: ['neto-score-history', months],
    enabled: IS_DEMO || gate,
    queryFn: async () => {
      if (IS_DEMO) return DEMO_SCORE;
      const res = await fetch(`/api/score?history=true&months=${months}`);
      if (!res.ok) throw new Error('Failed to fetch score history');
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  // Auto-backfill: if history is empty or sparse, calculate past months once.
  // Guarded con un ref para intentarlo UNA sola vez por montaje: en Free la API
  // capa el history a 1 mes, así que historyCount < months se cumple siempre y sin
  // el guard se dispararía un POST (5 queries) en cada render/refetch aunque no haya
  // nada nuevo que backfillear. Si el POST falla, se libera el guard para reintentar.
  const backfillTried = useRef(false);
  useEffect(() => {
    if (IS_DEMO) return;
    if (backfillTried.current) return;
    const historyCount = query.data?.history?.length ?? 0;
    if (query.isSuccess && historyCount < months) {
      backfillTried.current = true;
      fetch('/api/score/backfill', { method: 'POST' })
        .then(r => r.json())
        .then(({ backfilled }) => {
          if (backfilled > 0) {
            queryClient.invalidateQueries({ queryKey: ['neto-score-history'] });
          }
        })
        .catch(() => { backfillTried.current = false; });
    }
  }, [query.isSuccess, query.data, months, queryClient]);

  return query;
}
