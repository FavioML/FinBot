'use client';

import { useQuery } from '@tanstack/react-query';

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

export function useSpendingAlerts(limit = 20) {
  return useQuery<AlertsData>({
    queryKey: ['spending-alerts', limit],
    queryFn: async () => {
      const res = await fetch(`/api/alerts?limit=${limit}`);
      if (!res.ok) throw new Error('Failed to fetch alerts');
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
}
