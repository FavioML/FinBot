'use client';

import posthog from 'posthog-js';

// Eventos del funnel — nombres centralizados para evitar drift entre componentes.
export const EVENTS = {
  WEBAPP_LOGGED_IN: 'webapp_logged_in',
  TRANSACTION_CREATED: 'transaction_created',
  BUDGET_CREATED: 'budget_created',
  GOAL_CREATED: 'goal_created',
} as const;

type EventName = (typeof EVENTS)[keyof typeof EVENTS];

// Captura segura: nunca rompe la UI por analytics.
// Nunca pasar montos ni PII en `properties` (la app es financiera).
export function track(event: EventName, properties?: Record<string, unknown>) {
  try {
    posthog.capture(event, properties);
  } catch {
    /* noop — analytics jamás debe romper el flujo */
  }
}

// Opt-out ligero (consent). Respetar también DNT se configura en el init.
export function optOutTracking() {
  try {
    posthog.opt_out_capturing();
  } catch {
    /* noop */
  }
}

export function optInTracking() {
  try {
    posthog.opt_in_capturing();
  } catch {
    /* noop */
  }
}

export function hasOptedOut(): boolean {
  try {
    return posthog.has_opted_out_capturing();
  } catch {
    return false;
  }
}
