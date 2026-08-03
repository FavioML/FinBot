// Cómo se lee el monto de una transacción. Único sitio.
//
// `transacciones.monto_pen` es NULLABLE **a propósito** (ver la rama USD
// fuera de rango en `services/transactions.js`): cuando una conversión USD→PEN
// se sale del techo de `validarMonto`, el backend deja `null` en vez de
// fabricar un tipo de cambio. `monto` en cambio es NOT NULL en la DB, así que
// SIEMPRE hay un número real con su moneda detrás de ese null.
//
// El tipo en `types.ts` decía `monto_pen: number` — una mentira que TypeScript
// no podía atrapar. Por eso `formatCurrency(tx.monto_pen)` tiraba el dashboard
// entero al error boundary (`null.toLocaleString`) y los ~60 `reduce` sumaban
// null como 0 en silencio.
//
// Dos necesidades distintas, dos helpers:
//   - ARITMÉTICA (sumar soles): `montoPen()` colapsa a un número.
//   - DISPLAY (pintar una fila): `formatTxMonto()` NO colapsa — muestra el
//     monto original con su moneda, porque "S/ 0.00" para un gasto que existe
//     es peor que no mostrarlo.
//
// La convención de display, decidida el 2026-08-03 y válida en TODA la webapp:
//
//   - TOTALES y agregados: siempre soles. No se suman monedas distintas.
//   - FILAS individuales: primario = lo que la persona realmente pagó, en SU
//     moneda (`formatTxMonto`); secundario = el equivalente en soles
//     (`formatTxMontoPen`), y solo cuando `moneda != PEN`.
//
// El motivo: quien revisa un cargo lo compara contra su estado de cuenta, que
// dice "$20.00". Solo soles lo obliga a hacer la cuenta mental; solo USD le
// rompe la comparación visual de la columna. Como el secundario aparece únicamente
// fuera de PEN, el 94.84% de las filas (1947 de 2053 al 2026-08-03) no cambia.
//
// El render de las dos partes vive en `components/shared/tx-monto.tsx`. Estos
// helpers se quedan puros (strings) para que sigan siendo testeables sin jsdom.

import { formatCurrency } from './utils';

export interface TxMonto {
  monto: number;
  monto_pen: number | null;
  moneda?: string | null;
}

/**
 * Valor en soles para agregación. Espeja el `monto_pen || monto` que ya usan
 * TODOS los lectores del backend (neto-score.js, reports.js, summaries.js,
 * budget.js, recommendations.js, admin.js) y las rutas `api/score` y
 * `api/pro/muro`. Se mantiene igual a propósito: si la webapp usara `?? 0`,
 * el total del dashboard divergiría del que Neto responde por WhatsApp para
 * el mismo mes — que es exactamente el bug que cerró el commit 5a6691d.
 */
export function montoPen(tx: TxMonto): number {
  return tx.monto_pen ?? tx.monto;
}

/**
 * Monto PRIMARIO de una fila: lo que la persona pagó, con el símbolo de la
 * moneda en que lo pagó ("$ 15.49"). No mira `monto_pen` — ese es el
 * secundario, y para una fila en PEN no existe. Nunca inventa una conversión
 * ni pinta un cero: `monto` es NOT NULL en la DB, así que siempre hay número.
 */
export function formatTxMonto(tx: TxMonto): string {
  return formatCurrency(tx.monto, tx.moneda ?? 'PEN');
}

/**
 * Monto SECUNDARIO de una fila: el equivalente en soles, o `null` cuando no hay
 * nada que agregar. Devuelve null en dos casos, y los dos importan:
 *
 *   - `moneda` PEN (o ausente): el primario YA está en soles. Repetirlo sería
 *     ruido en el 94.84% de las filas.
 *   - `monto_pen` null: la rama USD fuera de rango del backend NO tiene una
 *     conversión honesta que mostrar. Se queda solo el monto original, que es
 *     exactamente lo que esta columna es nullable para poder decir.
 */
export function formatTxMontoPen(tx: TxMonto): string | null {
  if ((tx.moneda ?? 'PEN') === 'PEN') return null;
  if (tx.monto_pen == null) return null;
  return formatCurrency(tx.monto_pen);
}
