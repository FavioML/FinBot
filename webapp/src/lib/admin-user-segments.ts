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

import { enTrial, esProPagado, diasRestantesTrial } from '@/lib/plan';

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

// ─── Estado comercial ────────────────────────────────────────────────────────
//
// El panel pintaba `plan === 'premium' ? 'Pro' : 'Free'`, que bajo el modelo de trial
// (migración 052) miente en las dos direcciones: durante la prueba `plan` vale 'premium'
// a propósito, así que los usuarios en prueba se veían idénticos a los que pagan, y
// "Free" colapsaba tres poblaciones con acciones comerciales OPUESTAS — al que nunca
// estrenó su prueba hay que activarlo, al que la terminó hay que cobrarle, y al
// ex-pagador hay que recuperarlo.
//
// Los predicados no se reimplementan: salen de `@/lib/plan`, que a su vez es espejo del
// backend `lib/trial.js`. Acá solo se COMPONEN y se le pone nombre a cada rama, para que
// una futura desincronización tenga que romper `plan.ts` y no pueda entrar por el panel.

export type EstadoComercial =
  | 'pago_pendiente'
  | 'pro_pagado'
  | 'trial'
  | 'muro_vencido'
  | 'muro_ex_pagador'
  | 'sin_estrenar';

export const ESTADO_ORDER: EstadoComercial[] = [
  'pro_pagado',
  'pago_pendiente',
  'trial',
  'muro_vencido',
  'muro_ex_pagador',
  'sin_estrenar',
];

export const ESTADO_LABEL: Record<EstadoComercial, string> = {
  pro_pagado: 'Pro pagado',
  pago_pendiente: 'Pago por aprobar',
  trial: 'En prueba',
  muro_vencido: 'Muro (prueba vencida)',
  muro_ex_pagador: 'Muro (ex pagador)',
  sin_estrenar: 'Sin estrenar prueba',
};

/** Explica qué es cada estado, para el tooltip del panel. */
export const ESTADO_HINT: Record<EstadoComercial, string> = {
  pro_pagado: 'Paga. Es MRR.',
  pago_pendiente: 'Mandó comprobante y espera aprobación. Va en Operación.',
  trial: 'Corriendo sus 14 días de Pro. Todavía no pagó nada.',
  muro_vencido: 'Se le acabó la prueba sin pagar. Escribe, pero no puede leer.',
  muro_ex_pagador: 'Pagó alguna vez y churneó. No le corresponde otra prueba.',
  sin_estrenar: 'Nunca registró un gasto, así que su prueba jamás arrancó.',
};

export interface EstadoComercialUser {
  plan: string;
  trial_estado?: string | null;
  pago_pendiente?: boolean | null;
}

export function estadoComercial(u: EstadoComercialUser): EstadoComercial {
  // Mismo orden de precedencia que `pantallaPro` en `@/lib/plan`: el comprobante en revisión
  // gana sobre todo lo demás, porque es lo único que exige una acción tuya HOY.
  if (u.pago_pendiente) return 'pago_pendiente';
  if (enTrial(u.plan, u.trial_estado)) return 'trial';
  if (esProPagado(u.plan, u.trial_estado)) return 'pro_pagado';
  // A partir de acá está en el muro. Cuál de los tres muros es lo dice `trial_estado`, y por
  // eso la ruta /api/admin/users tiene que devolverlo: lo leía de la base y lo tiraba.
  if (u.trial_estado === 'vencido') return 'muro_vencido';
  if (u.trial_estado === 'convertido') return 'muro_ex_pagador';
  return 'sin_estrenar';
}

export function countByEstado<T extends EstadoComercialUser>(
  users: T[],
): Record<EstadoComercial, number> {
  const counts: Record<EstadoComercial, number> = {
    pro_pagado: 0, pago_pendiente: 0, trial: 0,
    muro_vencido: 0, muro_ex_pagador: 0, sin_estrenar: 0,
  };
  for (const u of users) counts[estadoComercial(u)] += 1;
  return counts;
}

export interface TrialExpiryUser extends EstadoComercialUser {
  trial_vence?: string | null;
}

/**
 * Días hasta que se le acabe la prueba (0 = vence hoy). null si no está en prueba.
 *
 * Existe aparte de `daysUntilProExpiry` porque miden cosas distintas y NO son
 * intercambiables: aquel filtra por `premium_vence`, que durante el trial queda NULL a
 * propósito (para que `checkPremiumExpiry` no barra a los que están probando). Ese NULL es
 * lo que dejaba a las pruebas por vencer fuera de toda alerta del panel — el 27-ago-2026
 * había 16 pruebas venciendo en 4 días y la única lista de vencimientos estaba vacía.
 */
export function diasHastaFinTrial(u: TrialExpiryUser, hoyLima?: string): number | null {
  return diasRestantesTrial(u.plan, u.trial_estado, u.trial_vence, hoyLima);
}

/**
 * Prueba que se acaba dentro de `withinDays` días. Son los que hay que convertir ya.
 * `hoyLima` (formato YYYY-MM-DD) se inyecta solo desde los tests; en la página va sin él.
 */
export function isTrialExpiringSoon(
  u: TrialExpiryUser,
  withinDays = 5,
  hoyLima?: string,
): boolean {
  const d = diasHastaFinTrial(u, hoyLima);
  return d !== null && d <= withinDays;
}
