/**
 * Utilidades de fecha en zona horaria de Lima (UTC-5, sin DST).
 *
 * Neto es un producto peruano: "hoy", "esta semana" y "este mes" deben medirse
 * en día Lima, no en UTC crudo. Antes stats usaba UTC y economics usaba Lima, así
 * que los dos paneles podían discrepar. Fuente única para ambas rutas admin.
 *
 * Nota de convención: las columnas `created_at` de `usuarios`/`transacciones` son
 * `timestamp WITHOUT time zone` que almacenan el instante en UTC. Un `Date` de Lima
 * medianoche equivale al instante UTC de las 05:00, así que `.toISOString()` de estos
 * helpers ("...T05:00:00.000Z") filtra correctamente contra ese almacenamiento.
 */

const LIMA_OFFSET_MS = 5 * 3600 * 1000; // UTC-5

/** Medianoche Lima del día de `date`, como instante UTC (Lima 00:00 = UTC 05:00). */
export function startOfDayLima(date: Date): Date {
  const d = new Date(date.getTime() - LIMA_OFFSET_MS);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 5, 0, 0));
}

/** Primer día del mes Lima de `date`, como instante UTC. */
export function startOfMonthLima(date: Date): Date {
  const d = new Date(date.getTime() - LIMA_OFFSET_MS);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 5, 0, 0));
}

/** Fecha Lima de `date` en formato YYYY-MM-DD. */
export function todayIsoLima(date: Date = new Date()): string {
  const d = new Date(date.getTime() - LIMA_OFFSET_MS);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
