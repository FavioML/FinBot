import { describe, it, expect } from 'vitest';
import { esNueva, contarNuevas, tandasDeIds, parsePedidoVistas, MAX_IDS_VISTAS } from './tx-nuevas';

describe('tandasDeIds', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);

  it('cada tanda es un cuerpo que el endpoint acepta, y entre todas están todos los ids', () => {
    const todos = ids(450);
    const tandas = tandasDeIds(todos);
    expect(tandas.map((t) => t.length)).toEqual([MAX_IDS_VISTAS, MAX_IDS_VISTAS, 50]);
    expect(tandas.every((t) => parsePedidoVistas({ ids: t }).ok)).toBe(true);
    expect(tandas.flat()).toEqual(todos);
  });

  it('sin ids no hay tandas (no se manda un cuerpo vacío)', () => expect(tandasDeIds([])).toEqual([]));
});

describe('esNueva', () => {
  it('null es nueva', () => expect(esNueva({ vista_at: null })).toBe(true));
  it('con fecha ya se vio', () => expect(esNueva({ vista_at: '2026-10-16T00:00:00Z' })).toBe(false));
  // Las filas demo no traen la columna: no se marcan por no saber.
  it('undefined NO es nueva', () => expect(esNueva({})).toBe(false));
});

describe('contarNuevas', () => {
  it('cuenta el total y las que vinieron del correo', () => {
    expect(
      contarNuevas([
        { vista_at: null, gmail_msg_id: 'abc' },
        { vista_at: null, gmail_msg_id: null },
        { vista_at: '2026-10-01T00:00:00Z', gmail_msg_id: 'def' },
        {},
      ]),
    ).toEqual({ total: 2, delCorreo: 1 });
  });
});
