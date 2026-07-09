'use client';

import { createContext, useContext } from 'react';
import { useQuery } from '@tanstack/react-query';
import { queryClient } from '@/lib/query-client';
import { IS_DEMO } from '@/lib/demo/is-demo';

/**
 * Arranque consolidado del dashboard. Un único fetch a /api/dashboard siembra
 * React Query para cada query key que el overview necesita, matando el fan-out
 * de ~8 API routes en frío (cada una un cold start serverless + su propia
 * re-autenticación).
 *
 * El gate: hasta que este bootstrap siembra (o falla), los hooks participantes
 * (useUser, useNetoScore, useSpendingAlerts, useNetoScoreHistory, useIsAdmin)
 * no auto-fetchean. Así evitamos la race donde useUser (2 round-trips directos,
 * sin cold start) resuelve ANTES que /api/dashboard (1 round-trip pero con cold
 * start), activa userId y dispara los hooks gated por su cuenta — que traería el
 * fan-out DE VUELTA además del bootstrap. Sembrar solo no basta: staleTime
 * protege cuando ya hay data, no en la cache fría.
 *
 * Default sin provider = true (self-fetch normal) → los usos de estos hooks
 * fuera del dashboard-shell no se ven afectados.
 */
const BootstrapGateContext = createContext<boolean>(true);

/** true cuando los hooks participantes pueden auto-fetchear (bootstrap resuelto o ausente). */
export function useBootstrapGate(): boolean {
  return useContext(BootstrapGateContext);
}

interface DashboardPayload {
  user: { id: string } & Record<string, unknown>;
  transactions: unknown[];
  goals: unknown[];
  debts: unknown[];
  achievements: unknown[];
  notifications: { notifications: unknown[]; unreadCount: number };
  score: unknown | null;
  scoreHistory: { history: unknown[] };
  alerts: { alerts: unknown[]; isPro: boolean };
  isAdmin: boolean;
}

/** Siembra cada key EXACTO que consumen los hooks. Ver los queryKeys en src/lib/hooks/*. */
function seed(d: DashboardPayload) {
  const uid = d.user.id;
  queryClient.setQueryData(['user'], d.user);
  // useTransactions({ usuarioId }) en el overview → sin mes/anio ni otros filtros.
  queryClient.setQueryData(['transactions', { usuarioId: uid }], d.transactions);
  queryClient.setQueryData(['goals', uid], d.goals);
  queryClient.setQueryData(['debts', uid], d.debts);
  queryClient.setQueryData(['achievements', uid], d.achievements);
  queryClient.setQueryData(['notifications-inbox', uid], d.notifications);
  // Score/alerts se omiten si no hay data → el hook (ya des-gateado) cae a su fetch.
  if (d.score) queryClient.setQueryData(['neto-score'], d.score);
  if (d.scoreHistory?.history?.length) queryClient.setQueryData(['neto-score-history', 4], d.scoreHistory);
  queryClient.setQueryData(['spending-alerts', 10], d.alerts);
  queryClient.setQueryData(['is-admin'], d.isAdmin);
}

interface Bootstrap {
  /** true cuando el gate debe permitir a los hooks auto-fetchear. */
  settled: boolean;
  /** true mientras el fetch inicial está en vuelo en frío (para bloquear el contenido). */
  blocking: boolean;
}

/**
 * Corre el fetch consolidado y siembra la cache. La query en sí guarda solo un
 * token mínimo ({ ok: true }) — la data real vive en los keys individuales, así
 * no se duplica en localStorage (W4). En caliente, ['dashboard'] restaura fresco
 * y no re-fetchea (los keys individuales ya están persistidos).
 */
export function useDashboardBootstrap(): Bootstrap {
  const q = useQuery({
    queryKey: ['dashboard'],
    enabled: !IS_DEMO,
    staleTime: 1000 * 60 * 5,
    queryFn: async () => {
      const res = await fetch('/api/dashboard');
      if (!res.ok) throw new Error(`dashboard bootstrap failed: ${res.status}`);
      const data = (await res.json()) as DashboardPayload;
      seed(data);
      return { ok: true };
    },
  });

  if (IS_DEMO) return { settled: true, blocking: false };
  return { settled: q.isSuccess || q.isError, blocking: q.isPending };
}

export function BootstrapGateProvider({
  value,
  children,
}: {
  value: boolean;
  children: React.ReactNode;
}) {
  return <BootstrapGateContext.Provider value={value}>{children}</BootstrapGateContext.Provider>;
}
