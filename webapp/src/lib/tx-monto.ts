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
 * Monto de una fila para mostrar. Con `monto_pen` presente pinta soles como
 * siempre; sin él cae al monto original CON su símbolo ("$ 300,000.00"), que
 * es el dato honesto: sabemos cuánto se gastó, no sabemos su equivalente en
 * soles. Nunca inventa una conversión ni pinta un cero.
 */
export function formatTxMonto(tx: TxMonto): string {
  if (tx.monto_pen != null) return formatCurrency(tx.monto_pen);
  return formatCurrency(tx.monto, tx.moneda ?? 'PEN');
}
