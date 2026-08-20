'use client';

// Eventos del funnel — nombres centralizados para evitar drift entre componentes.
export const EVENTS = {
  WEBAPP_LOGGED_IN: 'webapp_logged_in',
  TRANSACTION_CREATED: 'transaction_created',
  BUDGET_CREATED: 'budget_created',
  GOAL_CREATED: 'goal_created',
  // La campana. Existen porque `notificaciones.leida` solo se escribe al hacer CLIC, así que
  // hasta el 20-ago-2026 no había forma de distinguir "no lo vio" de "lo vio y no le importó",
  // y esa distinción decide qué se arregla. Medido antes de instrumentar: 668 notificaciones a
  // 55 usuarios en 30 días, y **4 usuarios** hicieron clic en alguna; entre los 18 activos de
  // verdad, 3 de 17. Si abren y no clickean, el problema es RUIDO (~23 avisos/mes por usuario
  // activo) y la respuesta es podar tipos. Si no abren, el problema es el CANAL.
  NOTIFICATIONS_OPENED: 'notifications_opened',
  NOTIFICATION_CLICKED: 'notification_clicked',
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
