'use client';

// Eventos del funnel — nombres centralizados para evitar drift entre componentes.
export const EVENTS = {
  WEBAPP_LOGGED_IN: 'webapp_logged_in',
  TRANSACTION_CREATED: 'transaction_created',
  BUDGET_CREATED: 'budget_created',
  GOAL_CREATED: 'goal_created',
} as const;

type EventName = (typeof EVENTS)[keyof typeof EVENTS];

// posthog-js pesa ~170 KB. Se carga bajo demanda (dynamic import) para que NUNCA
// entre al First Load crítico: la primera llamada a track()/opt-* lo trae, y el
// PostHogProvider ya lo precarga tras la hidratación. Es un singleton, así que
// todas las rutas comparten la misma instancia inicializada en el provider.
let phPromise: Promise<typeof import('posthog-js')['default']> | null = null;
function getPosthog() {
  if (!phPromise) phPromise = import('posthog-js').then((m) => m.default);
  return phPromise;
}

// Captura segura: nunca rompe la UI por analytics.
// Nunca pasar montos ni PII en `properties` (la app es financiera).
export function track(event: EventName, properties?: Record<string, unknown>) {
  getPosthog()
    .then((posthog) => posthog.capture(event, properties))
    .catch(() => {
      /* noop — analytics jamás debe romper el flujo */
    });
}

// Opt-out ligero (consent). Respetar también DNT se configura en el init.
export function optOutTracking() {
  getPosthog().then((posthog) => posthog.opt_out_capturing()).catch(() => {});
}

export function optInTracking() {
  getPosthog().then((posthog) => posthog.opt_in_capturing()).catch(() => {});
}

export async function hasOptedOut(): Promise<boolean> {
  try {
    return (await getPosthog()).has_opted_out_capturing();
  } catch {
    return false;
  }
}
