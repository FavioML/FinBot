// Proyección de egresos (caja saliente) para la página de costos admin. Puro y sin I/O: dados los
// costos activos y el día de hoy, calcula los cobros que caen en un horizonte (30/60/90 días),
// iterando la frecuencia. Es proyección de EGRESOS, distinto del P&L (que es caja realizada).

export interface ProjectionCost {
  label: string;
  amount_pen: number;
  currency: 'PEN' | 'USD';
  amount_original: number | null;
  frequency: 'monthly' | 'yearly' | 'one_time';
  next_due_date: string | null;
  active: boolean;
}

export interface Outflow {
  date: string; // YYYY-MM-DD
  label: string;
  amount_pen: number;
  currency: 'PEN' | 'USD';
  amount_original: number | null;
  overdue: boolean; // el cobro ya venció y sigue pendiente
}

/** Suma meses a una fecha ISO clampeando fin de mes (31 ene + 1 = 28 feb). */
function addMonthsIso(iso: string, months: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(y, m + months, day));
  if (target.getUTCDate() !== day) target.setUTCDate(0); // desbordó → último día del mes destino
  return target.toISOString().slice(0, 10);
}

/** Suma días a una fecha ISO. */
function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Proyecta los egresos de costos activos dentro de [hoy .. hoy+horizonDays].
 * Incluye ocurrencias vencidas que siguen pendientes (marcadas overdue) porque son plata que igual
 * debes pagar. Los recurrentes generan varias ocurrencias; one_time genera a lo más una.
 * @param costs costos (se ignoran inactivos y sin next_due_date)
 * @param todayIso 'YYYY-MM-DD'
 * @param horizonDays ventana en días (ej. 90)
 */
export function projectOutflows(
  costs: ProjectionCost[],
  todayIso: string,
  horizonDays: number,
): Outflow[] {
  const horizonEnd = addDaysIso(todayIso, horizonDays);
  const out: Outflow[] = [];

  for (const c of costs || []) {
    if (!c.active || !c.next_due_date) continue;
    let occ = c.next_due_date;
    let guard = 0;
    while (occ <= horizonEnd && guard < 500) {
      out.push({
        date: occ,
        label: c.label,
        amount_pen: Number(c.amount_pen) || 0,
        currency: c.currency,
        amount_original: c.amount_original != null ? Number(c.amount_original) : null,
        overdue: occ < todayIso,
      });
      if (c.frequency === 'monthly') occ = addMonthsIso(occ, 1);
      else if (c.frequency === 'yearly') occ = addMonthsIso(occ, 12);
      else break; // one_time
      guard++;
    }
  }

  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Suma en PEN de los egresos con fecha dentro de [hoy .. hoy+days]. */
export function sumWithinDays(outflows: Outflow[], todayIso: string, days: number): number {
  const end = addDaysIso(todayIso, days);
  const total = outflows.reduce((acc, o) => (o.date <= end ? acc + o.amount_pen : acc), 0);
  return Math.round(total * 100) / 100;
}
