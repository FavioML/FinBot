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

/**
 * Qué pasarle a `prefetch` de los `<Link>` de la navegación del shell.
 *
 * Medido el 30-ago-2026 con `qa-e2e/diag-arranque.mjs` contra producción: el dashboard
 * dispara **24 peticiones RSC de prefetch por carga** (el menú lateral son 13 rutas, la
 * barra inferior 5, más banners), y arrancan al hidratar — o sea, en el mismo momento
 * que `/api/dashboard`, que es lo único que el usuario está esperando. La nota del ítem
 * 16 del backlog decía 5; eran 24.
 *
 * No se apagan, se CORREN DE LUGAR. El prefetch es lo que hace instantánea la
 * navegación entre pantallas y vale la pena; lo que no vale es pagarlo mientras la
 * primera pantalla todavía no tiene un dato. Con el gate cerrado va `false`, y cuando
 * el bootstrap resuelve vuelve al default de Next.
 *
 * `undefined` y no `true`: `true` fuerza el prefetch completo de la ruta, que es MÁS
 * de lo que hacía antes. Lo que se quiere es devolverle a Next su comportamiento por
 * defecto, no estrenar uno nuevo.
 *
 * Que esto de verdad mueva las peticiones —y no las mate— se comprueba con el mismo
 * harness: el conteo de `prefetch RSC` por carga tiene que seguir siendo ~24, y la
 * línea "peticiones que arrancan DESPUES del primer dato" tiene que subir.
 */
export function usePrefetchNav(): boolean | undefined {
  return useBootstrapGate() ? undefined : false;
}

interface DashboardPayload {
  user: { id: string } & Record<string, unknown>;
  transactions: unknown[];
  goals: unknown[];
  debts: unknown[];
  achievements: unknown[];
  notifications: { notifications: unknown[]; unreadCount: number; total: number | null; tipos: string[] | null };
  score: unknown | null;
  scoreHistory: { history: unknown[] };
  alerts: { alerts: unknown[]; isPro: boolean };
  gmail: { authErrorAt: string | null };
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
  // `?? null` y no `if (d.gmail)`: acá "no hay cuenta" y "la cuenta está sana" son los dos
  // authErrorAt=null, y omitir la siembra dejaría al hook cayendo a su fetch de fallback en el
  // caso más común. Un deploy viejo sin el campo también aterriza en null, que es lo correcto.
  queryClient.setQueryData(['gmail-estado'], { authErrorAt: d.gmail?.authErrorAt ?? null });
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
    // 402 = el usuario terminó su prueba y está en el muro. Es una respuesta
    // DEFINITIVA, no un fallo transitorio: reintentarla solo retrasa el paywall
    // (medido: el usuario en el muro se quedaba varios segundos mirando el
    // skeleton antes de que apareciera nada). Los demás errores sí se reintentan
    // una vez, que es el default de la app.
    retry: (intentos, err) => !/\b402\b/.test(String(err?.message)) && intentos < 1,
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
