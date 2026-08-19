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

/**
 * La ventana del mes Lima que está `haceMeses` antes del mes de `date`, con su etiqueta.
 *
 * Existe porque las dos rutas admin armaban sus seis meses con
 * `new Date(y, m + 1, 0, 23, 59, 59)`, que es hora **LOCAL DEL SERVIDOR**. En Vercel el
 * proceso corre en UTC, así que ese "fin de mes" son las **18:59:59 de Lima**: cinco horas
 * del último día caían en el mes siguiente. No importaba mientras las comparaciones fueran
 * contra `premium_desde`/`premium_vence`, que son DATE y se parsean a medianoche UTC — pero
 * `cuenta_borrada_at` es un timestamptz, así que desde que la baja decide, la hora decide.
 * Y no se reproduce en la máquina de Favio, que corre en TZ Lima y da otro resultado.
 *
 * La etiqueta se formatea desde el día 15 en UTC y no desde el instante de `start`: en
 * `/economics` se formateaba el inicio de mes con `timeZone: 'America/Lima'`, que lo corre a
 * las 19:00 del último día del mes ANTERIOR, así que el bucket con el MRR vivo salía
 * rotulado con el mes pasado mientras `/stats` —que formateaba sin `timeZone`— lo rotulaba
 * bien. Las dos pantallas mostraban el mismo MRR bajo nombres de mes distintos.
 */
export function monthWindowLima(
  date: Date,
  haceMeses: number,
): { start: Date; end: Date; label: string } {
  const d = new Date(date.getTime() - LIMA_OFFSET_MS);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() - haceMeses;
  const start = new Date(Date.UTC(y, m, 1, 5, 0, 0));
  // Fin = un milisegundo antes del inicio del mes siguiente. `Date.UTC` normaliza el
  // desborde de mes y de año solo, así que diciembre no necesita caso aparte.
  const end = new Date(Date.UTC(y, m + 1, 1, 5, 0, 0) - 1);
  const label = new Date(Date.UTC(y, m, 15)).toLocaleDateString('es-PE', {
    month: 'short',
    year: '2-digit',
    timeZone: 'UTC',
  });
  return { start, end, label };
}

/**
 * El instante en que empieza, EN LIMA, el día que nombra una columna DATE.
 *
 * Existe porque `monthWindowLima` movió los bordes del mes de `00:00Z` a `05:00Z` y eso
 * desalineó a las columnas que sí andaban. `premium_desde` y `premium_vence` son DATE, y
 * `new Date('2026-08-01')` da `2026-08-01T00:00:00Z` — cinco horas ANTES del nuevo inicio
 * de agosto —, así que toda fecha del día 1 se caía al mes anterior: un alta se reportaba un
 * mes antes y `wasProAtMonthEnd` la contaba como Pro al cierre de un mes en que todavía no
 * lo era. Medido contra producción el 18-ago: 1 usuario con `premium_desde` en día 1 y 2 con
 * `premium_vence` en día 1, y crece ~1 de cada 30 altas.
 *
 * Los dos tipos tienen que vivir en la MISMA línea de tiempo. `cuenta_borrada_at` es un
 * instante real y ya está en la de Lima; una DATE nombra un día calendario peruano, así que
 * su instante es la medianoche de Lima de ese día. Una sola ventana para los dos tipos, sin
 * esta normalización, sólo elige a cuál de los dos romper.
 */
export function msDeFechaLima(valor: string | null | undefined): number {
  if (!valor) return NaN;
  // Se matchea la cadena ENTERA, no sus diez primeros caracteres. Con el `slice(0, 10)` que
  // tenía antes, un timestamp completo (`2026-08-01T09:30:00Z`) pasaba por DATE y perdía la
  // hora: quedaba anclado a medianoche de Lima. Lo atrapó su propio test.
  const m = String(valor).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  // Si no tiene forma de DATE es un timestamp completo: ese ya trae su zona.
  if (!m) return new Date(valor).getTime();
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 5, 0, 0);
}

/** Fecha Lima de `date` en formato YYYY-MM-DD. */
export function todayIsoLima(date: Date = new Date()): string {
  const d = new Date(date.getTime() - LIMA_OFFSET_MS);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
