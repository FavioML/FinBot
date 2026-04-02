'use client';

import { useQuery } from '@tanstack/react-query';

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
  return useQuery<NetoScoreData>({
    queryKey: ['neto-score'],
    queryFn: async () => {
      const res = await fetch('/api/score');
      if (!res.ok) throw new Error('Failed to fetch score');
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
}

export function useNetoScoreHistory(months = 6) {
  return useQuery<NetoScoreData>({
    queryKey: ['neto-score-history', months],
    queryFn: async () => {
      const res = await fetch(`/api/score?history=true&months=${months}`);
      if (!res.ok) throw new Error('Failed to fetch score history');
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
}
