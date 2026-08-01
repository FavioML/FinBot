/**
 * Plan validation utilities for Neto freemium/pro feature gating.
 * See webapp/PRICING-PLAN.md for the full approved plan.
 */

export type PlanType = 'free' | 'premium';

export type PlanFeature =
  | 'reports_pdf'
  | 'calendar'
  | 'heatmap'
  | 'export'
  | 'excel_upload'
  | 'score_breakdown'
  | 'daily_summary'
  | 'daily_reminder'
  | 'advice_daily'
  | 'gmail_reading'
  // v2 — Score
  | 'score_tips'
  | 'score_history'
  // v2 — Fugas
  | 'fugas_weekly_alerts'
  | 'fugas_projections'
  | 'fugas_limits'
  // v2 — Planes de compra
  | 'metas_dynamic_adjust'
  | 'metas_checkins'
  | 'metas_viability'
  | 'metas_cuts'
  // v2 — Espacios
  | 'espacios_custom_split'
  | 'espacios_shared_budget'
  | 'espacios_full_history';

/** Features only available on Pro plan */
const PRO_ONLY_FEATURES: PlanFeature[] = [
  'reports_pdf',
  'calendar',
  'heatmap',
  'export',
  'excel_upload',
  'score_breakdown',
  'daily_summary',
  'daily_reminder',
  'advice_daily',
  'gmail_reading',
  // v2
  'score_tips',
  'score_history',
  'fugas_weekly_alerts',
  'fugas_projections',
  'fugas_limits',
  'metas_dynamic_adjust',
  'metas_checkins',
  'metas_viability',
  'metas_cuts',
  'espacios_custom_split',
  'espacios_shared_budget',
  'espacios_full_history',
];

/** Free plan limits for counted features */
export const FREE_LIMITS = {
  budgets: Infinity,
  goals: 1,
  ocr_per_month: Infinity,
  gmail_accounts: 0,
  advice_per_week: 0,
} as const;

/** Check if a feature is Pro-only */
export function isProOnly(feature: PlanFeature): boolean {
  return PRO_ONLY_FEATURES.includes(feature);
}

/** Check if user can access a specific feature */
export function canAccess(plan: string | undefined, feature: PlanFeature): boolean {
  if (plan === 'premium') return true;
  return !isProOnly(feature);
}

/** Check if user has reached the free limit for a counted feature */
export function hasReachedLimit(
  plan: string | undefined,
  feature: keyof typeof FREE_LIMITS,
  currentCount: number,
): boolean {
  if (plan === 'premium') return false;
  return currentCount >= FREE_LIMITS[feature];
}

/**
 * ¿El usuario está en el MURO? Es decir: terminó su prueba de 14 días sin pagar.
 *
 * Espejo exacto de `estaEnMuro` en el backend (`lib/trial.js`), y complemento del
 * entitlement Pro a propósito: una sola condición, imposible de desincronizar.
 *
 * La regla que aplica: **escribir nunca se corta; lo que se cobra es leer.** Registrar
 * un gasto sigue siendo gratis para siempre; el dashboard, el historial y los reportes no.
 */
export function estaEnMuro(plan: string | undefined): boolean {
  return plan !== 'premium';
}

/**
 * ¿Está corriendo su prueba ahora mismo?
 *
 * Exige las DOS columnas a propósito, igual que `enTrial` en el backend (`lib/trial.js`).
 * `trial_estado='activo'` solo dice que el reloj comercial corre; `plan='premium'` es lo
 * que de verdad le entrega Pro. Cuando se desincronizan — le pasó a un usuario real, a
 * quien `checkPremiumExpiry` le bajó el plan dejándole el estado en 'activo' — mirar una
 * sola columna produce una pantalla que se contradice: el banner decía "estás en Neto Pro,
 * quedan 30 días" justo arriba del paywall que decía "tu prueba terminó". Con las dos,
 * esa pantalla es imposible de construir.
 */
export function enTrial(
  plan: string | undefined,
  trialEstado: string | null | undefined,
): boolean {
  return plan === 'premium' && trialEstado === 'activo';
}

/**
 * ¿Es Pro **pagado**? Durante el trial `plan` vale 'premium', así que `plan === 'premium'`
 * responde "tiene Pro", no "paga". Esta es la otra pregunta, la comercial: la usan el
 * descuento de referido (no se le ofrece a quien ya paga, pero sí a quien está probando)
 * y las métricas de MRR. Espejo de `esProPagado` en `services/referrals.js`.
 */
export function esProPagado(
  plan: string | undefined,
  trialEstado: string | null | undefined,
): boolean {
  return plan === 'premium' && trialEstado !== 'activo';
}

/**
 * Días que le quedan de prueba, en fecha Lima (0 = vence hoy, null si no está en trial).
 * Se calcula en zona Lima y no la del navegador, igual que `/api/pro/status`.
 */
export function diasRestantesTrial(
  plan: string | undefined,
  trialEstado: string | null | undefined,
  trialVence: string | null | undefined,
): number | null {
  if (!enTrial(plan, trialEstado) || !trialVence) return null;
  const vence = String(trialVence).slice(0, 10);
  const hoyLima = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
  if (vence < hoyLima) return 0;
  const ms =
    new Date(vence + 'T12:00:00-05:00').getTime() - new Date(hoyLima + 'T12:00:00-05:00').getTime();
  return Math.max(0, Math.round(ms / 86400000));
}

/**
 * Qué pantalla le toca a alguien en `/dashboard/pro`. Vive acá y no dentro del componente
 * porque la webapp corre vitest sin jsdom: si la decisión no sale del render, no se puede
 * probar, y esta decisión ya salió mal una vez.
 *
 * El bug que cierra: la página ramificaba con `isPremium` a secas, que durante el trial es
 * `true`. O sea que TODO CTA del trial — el banner los 14 días, los avisos del día 11 y 14,
 * la notificación in-app — aterrizaba en una pantalla que decía "Eres Neto Pro ⭐", sin
 * fecha (`premium_vence` es NULL en trial) y sin precio, con el pago escondido detrás de un
 * botón que decía "Renovar", palabra que no significa nada para quien nunca pagó.
 *
 *   'pendiente' — mandó su comprobante y espera aprobación (gana sobre todo lo demás)
 *   'trial'     — está probando: se le muestra cuándo termina Y el formulario de pago
 *   'pagado'    — Pro pagado: gestión de la cuenta, con la renovación colapsada
 *   'pago'      — muro o nunca tuvo Pro: el formulario, y nada más
 */
export type PantallaPro = 'pendiente' | 'trial' | 'pagado' | 'pago';

export function pantallaPro(opts: {
  plan?: string;
  trialEstado?: string | null;
  pagoPendiente?: boolean;
}): PantallaPro {
  if (opts.pagoPendiente) return 'pendiente';
  if (enTrial(opts.plan, opts.trialEstado)) return 'trial';
  if (esProPagado(opts.plan, opts.trialEstado)) return 'pagado';
  return 'pago';
}

/** Get the display limit for a feature */
export function getLimit(
  plan: string | undefined,
  feature: keyof typeof FREE_LIMITS,
): number {
  if (plan === 'premium') return Infinity;
  return FREE_LIMITS[feature];
}
