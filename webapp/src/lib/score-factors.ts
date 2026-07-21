/**
 * Factores del Neto Score que el webapp calcula on-demand cuando aún no hay un
 * score persistido (usuario nuevo antes del cron 6am, o ?refresh=true). Portados
 * 1:1 desde el backend `services/neto-score.js` (fuente de verdad que persiste
 * `neto_scores`) para que el valor del path fresh-calc NO diverja del que el cron
 * asienta luego. Consistency/budget/savings/visibility son aritméticos simples y
 * viven inline en las rutas; goals y debts tienen lógica (ritmo de ahorro,
 * penalidad por mora) que se centraliza aquí para no re-divergir entre
 * /api/score y /api/score/backfill.
 */

export interface GoalRow {
  monto_objetivo: number | string;
  monto_actual: number | string | null;
  fecha_limite: string | null;
  created_at?: string | null;
}

export interface DebtRow {
  estado: string;
  monto_pendiente: number | string;
  monto_original: number | string;
  fecha_vencimiento?: string | null;
}

/**
 * Espeja `calcularRitmoAhorro` del backend: solo lo que el factor necesita
 * (¿en ritmo? y % de progreso). enRitmo=null cuando la meta no tiene fecha límite.
 */
function ritmoMeta(meta: GoalRow): { enRitmo: boolean | null; pctProgreso: number } {
  const objetivo = parseFloat(String(meta.monto_objetivo));
  const actual = parseFloat(String(meta.monto_actual ?? 0));
  const pctProgreso = objetivo > 0 ? Math.round((actual / objetivo) * 100) : 0;

  if (!meta.fecha_limite) return { enRitmo: null, pctProgreso };

  const hoy = new Date();
  const limite = new Date(meta.fecha_limite + 'T23:59:59');
  const createdAt = meta.created_at ? new Date(meta.created_at) : hoy;
  const diasTotales = Math.max(1, Math.ceil((limite.getTime() - createdAt.getTime()) / 86400000));
  const diasTranscurridos = Math.max(1, Math.ceil((hoy.getTime() - createdAt.getTime()) / 86400000));
  const progresoEsperado = (diasTranscurridos / diasTotales) * objetivo;
  const enRitmo = actual >= progresoEsperado * 0.85; // 15% de margen (igual que backend)

  return { enRitmo, pctProgreso };
}

/** Factor 4 — Progreso en planes. Espeja `calcFactorGoals` del backend. */
export function goalsFactor(metasActivas: GoalRow[] | null | undefined): number {
  if (!metasActivas || metasActivas.length === 0) return 50; // neutral, sin metas
  let total = 0;
  let counted = 0;
  for (const meta of metasActivas) {
    const r = ritmoMeta(meta);
    if (r.enRitmo === null) {
      total += r.pctProgreso > 0 ? 70 : 40; // sin deadline: por progreso
    } else if (r.enRitmo) {
      total += 100;
    } else {
      const behindRatio = r.pctProgreso / Math.max(1, r.pctProgreso + 20);
      total += Math.max(20, Math.round(behindRatio * 80));
    }
    counted++;
  }
  return Math.round(total / counted);
}

/**
 * Fecha de hoy en Lima como `YYYY-MM-DD`.
 *
 * `fecha_vencimiento` es una columna DATE (sin hora), así que la comparación de
 * "vencida" tiene que ser a granularidad de día. Comparándola contra un `Date`
 * se colaba la hora: el backend usaba medianoche y el webapp la hora-pared, así
 * que una deuda que vencía HOY contaba como vencida en la web (−15 pts) y no en
 * WhatsApp. Con strings ISO la comparación lexicográfica es exacta y sin zona.
 */
export function limaToday(): string {
  const lima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  return `${lima.getFullYear()}-${String(lima.getMonth() + 1).padStart(2, '0')}-${String(lima.getDate()).padStart(2, '0')}`;
}

/**
 * Factor 5 — Gestión de deudas. Espeja `calcFactorDebts` del backend: promedio de
 * progreso de pago menos penalidad por mora (15/deuda vencida) más bonus por
 * deudas ya pagadas. `debts` debe traer todas las deudas tipo='debo' (activas +
 * pagadas). `hoyISO` es el día de referencia (`YYYY-MM-DD`, ver `limaToday`);
 * una deuda que vence HOY todavía NO está vencida.
 */
export function debtsFactor(debts: DebtRow[] | null | undefined, hoyISO: string): number {
  if (!debts || debts.length === 0) return 80; // sin deudas = bien
  const activas = debts.filter((d) => d.estado === 'activa');
  const pagadas = debts.filter((d) => d.estado === 'pagada');
  if (activas.length === 0) return 100; // todas pagadas

  let progressScore = 0;
  let overdueCount = 0;
  for (const d of activas) {
    const pendiente = parseFloat(String(d.monto_pendiente));
    const original = parseFloat(String(d.monto_original));
    const paidRatio = original > 0 ? 1 - pendiente / original : 0;
    progressScore += paidRatio * 100;
    if (d.fecha_vencimiento && String(d.fecha_vencimiento).slice(0, 10) < hoyISO) overdueCount++;
  }

  const avgProgress = progressScore / activas.length;
  const overduePenalty = overdueCount * 15;
  const paidBonus = pagadas.length > 0 ? 10 : 0;
  return Math.max(0, Math.min(100, Math.round(avgProgress + paidBonus - overduePenalty)));
}
