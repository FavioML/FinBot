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

/** ¿Está corriendo su prueba ahora mismo? */
export function enTrial(trialEstado: string | null | undefined): boolean {
  return trialEstado === 'activo';
}

/**
 * Días que le quedan de prueba, en fecha Lima (0 = vence hoy, null si no está en trial).
 * Se calcula en zona Lima y no la del navegador, igual que `/api/pro/status`.
 */
export function diasRestantesTrial(
  trialEstado: string | null | undefined,
  trialVence: string | null | undefined,
): number | null {
  if (!enTrial(trialEstado) || !trialVence) return null;
  const vence = String(trialVence).slice(0, 10);
  const hoyLima = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
  if (vence < hoyLima) return 0;
  const ms =
    new Date(vence + 'T12:00:00-05:00').getTime() - new Date(hoyLima + 'T12:00:00-05:00').getTime();
  return Math.max(0, Math.round(ms / 86400000));
}

/** Get the display limit for a feature */
export function getLimit(
  plan: string | undefined,
  feature: keyof typeof FREE_LIMITS,
): number {
  if (plan === 'premium') return Infinity;
  return FREE_LIMITS[feature];
}
