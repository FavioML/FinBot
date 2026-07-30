// Clasificación de salud de usuarios para la página admin/users (Ola 4 Fase 1).
// Motor PURO (sin fetch, sin DOM) para que sea testeable y una sola fuente de verdad de las
// reglas de segmento. Los umbrales salen del plan aprobado (2026-07-30):
//
//   Power      = activo (≥1 tx en 14d) y ≥30 tx totales
//   Activo     = ≥1 tx en 14d (y no llega a power)
//   En riesgo  = sin tx en 14d pero con actividad en la ventana de 30d (se está enfriando)
//   Dormido    = 0 tx nunca, o sin tx en >30d
//
// "Pro por vencer" NO es un segmento mutuamente excluyente: es una alerta transversal
// (un usuario Activo puede además estar por vencer). Se calcula aparte.

export type UserSegment = 'power' | 'activo' | 'en_riesgo' | 'dormido';

export const SEGMENT_ORDER: UserSegment[] = ['power', 'activo', 'en_riesgo', 'dormido'];

export const SEGMENT_LABEL: Record<UserSegment, string> = {
  power: 'Power users',
  activo: 'Activos',
  en_riesgo: 'En riesgo',
  dormido: 'Dormidos',
};

export const POWER_TX_THRESHOLD = 30;

export interface SegmentableUser {
  transacciones: number;
  tx_14d?: number;
  tx_30d?: number;
}

export function classifyUser(u: SegmentableUser): UserSegment {
  const t14 = u.tx_14d ?? 0;
  const t30 = u.tx_30d ?? 0;
  const total = u.transacciones ?? 0;
  if (t14 >= 1) return total >= POWER_TX_THRESHOLD ? 'power' : 'activo';
  if (t30 >= 1) return 'en_riesgo';
  return 'dormido';
}

export interface ProExpiryUser {
  plan: string;
  premium_vence?: string | null;
}

// Días hasta el vencimiento del Pro (negativo = ya venció). null si no aplica (no es premium o
// no tiene fecha). now se inyecta para poder testear sin depender del reloj.
export function daysUntilProExpiry(u: ProExpiryUser, now: number): number | null {
  if (u.plan !== 'premium' || !u.premium_vence) return null;
  const vence = new Date(u.premium_vence).getTime();
  if (Number.isNaN(vence)) return null;
  return Math.ceil((vence - now) / 86400000);
}

// Pro que requiere acción: vence dentro de los próximos `withinDays` días, o ya venció pero el
// usuario sigue marcado premium (esos son justo los que hay que atender).
export function isProExpiringSoon(u: ProExpiryUser, now: number, withinDays = 7): boolean {
  const d = daysUntilProExpiry(u, now);
  return d !== null && d <= withinDays;
}

export function countBySegment<T extends SegmentableUser>(
  users: T[],
): Record<UserSegment, number> {
  const counts: Record<UserSegment, number> = { power: 0, activo: 0, en_riesgo: 0, dormido: 0 };
  for (const u of users) counts[classifyUser(u)] += 1;
  return counts;
}
