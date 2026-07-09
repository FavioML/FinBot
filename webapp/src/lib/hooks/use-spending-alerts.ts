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
