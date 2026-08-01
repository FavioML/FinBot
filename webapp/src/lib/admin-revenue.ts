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
  /**
   * Estado del trial de 14 días. Durante el trial `plan` vale `'premium'` (así el
   * usuario en prueba recibe Pro sin tocar los ~40 gates que miran esa columna), o sea
   * que **`plan === 'premium'` ya NO significa "paga"**. Este es el único lugar donde
   * ese truco cobra peaje, y por eso se paga acá y no en 40 sitios.
   */
  trial_estado?: string | null;
}

/**
 * ¿Este usuario PAGA? Es lo que cuenta para MRR, ARR y churn. Un trial es plan
 * `'premium'` con `trial_estado='activo'`: entrega Pro pero no factura, así que
 * contarlo inflaría el MRR con dinero que nadie transfirió.
 */
export function esProPagado(u: RevenueUserRow): boolean {
  return u.plan === 'premium' && u.trial_estado !== 'activo';
}

/** Fila con fechas de alta/baja Pro, para reconstrucción histórica de MRR. */
export interface HistoryUserRow extends RevenueUserRow {
  premium_desde?: string | null; // fecha (YYYY-MM-DD) de alta Pro
  premium_vence?: string | null; // fecha (YYYY-MM-DD) de vencimiento Pro
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
  if (!esProPagado(u)) return 0;
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
  const pro = real.filter(esProPagado);
  const proYearly = pro.filter((u) => u.tipo_plan === 'anual').length;
  const proMonthly = pro.length - proYearly;
  const mrr = round2(pro.reduce((sum, u) => sum + monthlyValuePen(u), 0));
  return { proCount: pro.length, proMonthly, proYearly, mrr, arr: round2(mrr * 12) };
}

/**
 * Caja real cobrada desde el inicio del mes: suma de pagos aprobados cuyo
 * aprobado_at (o created_at como fallback) cae en el mes, excluyendo pagos de
 * cuentas internas. Es dinero de verdad, distinto del MRR recurrente.
 * Compara como instante (Date), no como string, para no depender del formato
 * del timestamp (Z vs +00:00) en el borde del mes.
 */
export function cajaDelMes(
  pagos: PagoRow[],
  excludedUserIds: Set<string>,
  monthStartIso: string,
): number {
  const monthStartMs = new Date(monthStartIso).getTime();
  const total = pagos.reduce((sum, p) => {
    if (p.estado !== 'aprobado') return sum;
    if (p.usuario_id && excludedUserIds.has(p.usuario_id)) return sum;
    const when = p.aprobado_at || p.created_at;
    if (!when) return sum;
    const whenMs = new Date(when).getTime();
    if (isNaN(whenMs) || whenMs < monthStartMs) return sum;
    const monto = typeof p.monto === 'string' ? parseFloat(p.monto) : p.monto;
    if (monto == null || isNaN(monto)) return sum;
    return sum + monto;
  }, 0);
  return round2(total);
}

/**
 * Valor mensual normalizado para reconstrucción histórica. A diferencia de
 * monthlyValuePen (que devuelve 0 si el plan actual no es premium), asume que el
 * usuario YA fue clasificado como Pro en ese mes, así que valora por tipo_plan
 * aunque hoy sea free (churned). Anual = precio anual / 12.
 */
function historyMonthlyValue(u: HistoryUserRow): number {
  return u.tipo_plan === 'anual'
    ? PRO_PRICE_YEARLY_PEN / 12
    : PRO_PRICE_MONTHLY_PEN;
}

/**
 * ¿El usuario era Pro activo al cierre de `monthEnd`? Basado en premium_desde
 * (alta real) y premium_vence, NO en created_at (registro) ni en la heurística
 * vence−30d, que ubicaba a los anuales +11 meses en el futuro.
 */
export function wasProAtMonthEnd(u: HistoryUserRow, monthEnd: Date): boolean {
  if (!u.premium_desde) return esProPagado(u); // Pro pagado sin fecha de alta (los trials no tienen premium_desde)
  if (new Date(u.premium_desde) > monthEnd) return false; // aún no era Pro
  if (u.premium_vence) return new Date(u.premium_vence) >= monthEnd; // seguía vigente
  return esProPagado(u);
}

/**
 * MRR histórico normalizado al cierre de `monthEnd`, solo negocio real (excluye
 * cuentas internas). Suma el valor por tipo de plan de los Pro activos ese mes.
 */
export function mrrAtMonthEnd(users: HistoryUserRow[], monthEnd: Date): number {
  return round2(
    users
      .filter(isRevenueUser)
      .filter((u) => wasProAtMonthEnd(u, monthEnd))
      .reduce((s, u) => s + historyMonthlyValue(u), 0),
  );
}

/** Nuevos Pro reales cuya alta (premium_desde) cae en [monthStart, monthEnd]. */
export function newProInMonth(
  users: HistoryUserRow[],
  monthStart: Date,
  monthEnd: Date,
): number {
  return users.filter(isRevenueUser).filter((u) => {
    if (!u.premium_desde) return false;
    const desde = new Date(u.premium_desde);
    return desde >= monthStart && desde <= monthEnd;
  }).length;
}

/** Churn real cuyo vencimiento cae en [monthStart, monthEnd] y hoy ya es free. */
export function churnedInMonth(
  users: HistoryUserRow[],
  monthStart: Date,
  monthEnd: Date,
): number {
  return users.filter(isRevenueUser).filter((u) => {
    if (esProPagado(u) || !u.premium_vence) return false;
    const vence = new Date(u.premium_vence);
    return vence >= monthStart && vence <= monthEnd;
  }).length;
}

export interface ChurnSummary {
  churned: number; // Pro reales que vencieron en los últimos 30d y hoy son free
  rate: number; // churned / (churned + pro reales) * 100, redondeado a 1 decimal
}

/**
 * Churn 30d unificado (fuente única para stats y economics). Excluye internos
 * en numerador y base. Base = churned reales + Pro reales activos.
 */
export function computeChurn(users: HistoryUserRow[], now: Date): ChurnSummary {
  const real = users.filter(isRevenueUser);
  const thirtyAgo = new Date(now.getTime() - 30 * 86400000);
  const churned = real.filter((u) => {
    if (esProPagado(u) || !u.premium_vence) return false;
    const vence = new Date(u.premium_vence);
    return vence >= thirtyAgo && vence < now;
  }).length;
  const pro = real.filter(esProPagado).length;
  const base = churned + pro;
  const rate = base > 0 ? Math.round((churned / base) * 1000) / 10 : 0;
  return { churned, rate };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
