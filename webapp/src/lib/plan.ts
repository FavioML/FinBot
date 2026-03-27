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
  | 'custom_categories';

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
  'custom_categories',
];

/** Free plan limits for counted features */
export const FREE_LIMITS = {
  budgets: 3,
  goals: 1,
  ocr_per_month: 5,
  gmail_accounts: 0,
  advice_per_week: 1,
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
