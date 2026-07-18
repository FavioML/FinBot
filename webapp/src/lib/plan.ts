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

/** Get the display limit for a feature */
export function getLimit(
  plan: string | undefined,
  feature: keyof typeof FREE_LIMITS,
): number {
  if (plan === 'premium') return Infinity;
  return FREE_LIMITS[feature];
}
