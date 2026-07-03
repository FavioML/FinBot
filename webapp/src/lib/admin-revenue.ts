import { PRO_PRICE_MONTHLY_PEN, PRO_PRICE_YEARLY_PEN } from '@/lib/constants';

/**
 * Cuentas internas (fundador + QA) que NO son negocio real. Se excluyen de las
 * métricas de ingreso (MRR / ARR / caja / conversión) para que el panel refleje
 * pagos de clientes de verdad. NO se excluyen de las de volumen (total usuarios,
 * DAU/WAU/MAU) porque ahí sí cuentan como registro/actividad.
 * Mantener sincronizado si aparecen más bots de prueba.
 */
export const EXCLUDED_REVENUE_WHATSAPP = new Set<string>([
  '51970398192', // Favio (fundador)
  '51999999997', // Andrea QA Pro (cuenta de prueba)
]);

export interface RevenueUserRow {
  id?: string;
  plan: string | null;
  tipo_plan: string | null;
  whatsapp?: string | null;
}

export interface PagoRow {
  monto: number | string | null;
  estado: string | null;
  aprobado_at?: string | null;
  created_at?: string | null;
  usuario_id?: string | null;
}

/** ¿Cuenta este usuario como negocio real para métricas de ingreso? */
export function isRevenueUser(u: { whatsapp?: string | null }): boolean {
  return !u.whatsapp || !EXCLUDED_REVENUE_WHATSAPP.has(u.whatsapp);
}

/** Valor mensual normalizado: anual = precio anual / 12, mensual = precio mensual. */
export function monthlyValuePen(u: RevenueUserRow): number {
  if (u.plan !== 'premium') return 0;
  return u.tipo_plan === 'anual'
    ? PRO_PRICE_YEARLY_PEN / 12
    : PRO_PRICE_MONTHLY_PEN;
}

export interface RevenueSummary {
  proCount: number; // Pro reales (excluye internos)
  proMonthly: number;
  proYearly: number;
  mrr: number; // normalizado
  arr: number;
}

/** MRR/ARR normalizado sobre usuarios reales (excluye cuentas internas). */
export function computeRevenue(users: RevenueUserRow[]): RevenueSummary {
  const real = users.filter(isRevenueUser);
  const pro = real.filter((u) => u.plan === 'premium');
  const proYearly = pro.filter((u) => u.tipo_plan === 'anual').length;
  const proMonthly = pro.length - proYearly;
  const mrr = round2(pro.reduce((sum, u) => sum + monthlyValuePen(u), 0));
  return { proCount: pro.length, proMonthly, proYearly, mrr, arr: round2(mrr * 12) };
}

/**
 * Caja real cobrada desde el inicio del mes: suma de pagos aprobados cuyo
 * aprobado_at (o created_at como fallback) cae en el mes, excluyendo pagos de
 * cuentas internas. Es dinero de verdad, distinto del MRR recurrente.
 */
export function cajaDelMes(
  pagos: PagoRow[],
  excludedUserIds: Set<string>,
  monthStartIso: string,
): number {
  const total = pagos.reduce((sum, p) => {
    if (p.estado !== 'aprobado') return sum;
    if (p.usuario_id && excludedUserIds.has(p.usuario_id)) return sum;
    const when = p.aprobado_at || p.created_at;
    if (!when || when < monthStartIso) return sum;
    const monto = typeof p.monto === 'string' ? parseFloat(p.monto) : p.monto;
    if (monto == null || isNaN(monto)) return sum;
    return sum + monto;
  }, 0);
  return round2(total);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
