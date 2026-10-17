/**
 * Movimientos nuevos: los que entraron por WhatsApp o por el barrido de Gmail y la persona
 * todavía no vio en la webapp (migración 091, `transacciones.vista_at`).
 *
 * "Nuevo" es `vista_at === null` ESTRICTO. Las filas demo y cualquier lectura que no traiga la
 * columna llegan con `undefined`, y esas no se marcan: marcar todo por no saber sería peor que
 * no marcar nada.
 */
import type { Transaccion } from './types';

export function esNueva(tx: Pick<Transaccion, 'vista_at'>): boolean {
  return tx.vista_at === null;
}

export function vinoDelCorreo(tx: Pick<Transaccion, 'gmail_msg_id'>): boolean {
  return !!tx.gmail_msg_id;
}

export function contarNuevas(txs: Pick<Transaccion, 'vista_at' | 'gmail_msg_id'>[]): {
  total: number;
  delCorreo: number;
} {
  let total = 0;
  let delCorreo = 0;
  for (const t of txs) {
    if (!esNueva(t)) continue;
    total++;
    if (vinoDelCorreo(t)) delCorreo++;
  }
  return { total, delCorreo };
}

export const MAX_IDS_VISTAS = 200;

/** Parte los ids en tandas que el endpoint acepta. "Ya los vi" puede llevar cientos. */
export function tandasDeIds(ids: string[]): string[][] {
  const tandas: string[][] = [];
  for (let i = 0; i < ids.length; i += MAX_IDS_VISTAS) tandas.push(ids.slice(i, i + MAX_IDS_VISTAS));
  return tandas;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PedidoVistas = { ok: true; ids: string[] } | { ok: false; error: string };

/**
 * El cuerpo de `POST /api/transactions/vistas`: `{ ids: [...] }`, siempre por id. No hay un
 * "marcar todas las NULL": un movimiento que el barrido de Gmail escribió después de que la
 * pantalla cargó no se vio, y "Ya los vi" no puede llevárselo (hallazgo de la revisión del 16-oct).
 */
export function parsePedidoVistas(body: unknown): PedidoVistas {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Cuerpo inválido' };
  const { ids } = body as { ids?: unknown };
  if (!Array.isArray(ids) || ids.length === 0) return { ok: false, error: 'IDs requeridos' };
  if (ids.length > MAX_IDS_VISTAS) return { ok: false, error: `Máximo ${MAX_IDS_VISTAS} por lote` };
  if (!ids.every((id) => typeof id === 'string' && UUID.test(id))) return { ok: false, error: 'ID inválido' };
  return { ok: true, ids: ids as string[] };
}
