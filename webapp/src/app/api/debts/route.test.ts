import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `DELETE /api/debts?id=` ejecutaba DOS escrituras con service-role antes de la única que
 * filtraba por dueño:
 *
 *   deuda_abonos.delete().eq('deuda_id', id)                        ← sin usuario_id
 *   deudas.update({deuda_vinculada_id:null}).eq('deuda_vinculada_id', id)  ← sin usuario_id
 *   deudas.delete().eq('id', id).eq('usuario_id', netoUser.id)      ← recién acá
 *
 * El tercero matcheaba 0 filas, no devolvía error, y la ruta respondía `{success:true}`. O sea
 * que cualquiera podía borrar el historial de abonos de una deuda ajena y recibir un OK.
 *
 * Y el uuid no había que adivinarlo: al aceptar una deuda compartida, `debts/join` escribe
 * `deuda_vinculada_id` con el id de la deuda del ACREEDOR en la fila espejo del deudor, y el
 * GET de esta ruta hace `select('*')`. El flujo normal del producto se lo entregaba.
 *
 * Como `monto_pendiente` se recalcula sobre `deuda_abonos`, el siguiente abono de la víctima
 * recalculaba sobre cero y su deuda volvía al monto original. Silencioso para ella.
 *
 * Lo que se asierta es la ESCRITURA, no el status: una versión que devolviera 404 después de
 * haber borrado los abonos se vería igual de bien desde afuera.
 */

const requireLectura = vi.fn();

vi.mock('@/lib/supabase/auth', () => ({
  requireLectura: (...args: unknown[]) => requireLectura(...args),
  requireNetoUser: vi.fn(),
}));

vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: () => true }));

/** Toda operación que la ruta le pide a Supabase, en orden. */
type Op = { tabla: string; verbo: string; filtros: Record<string, unknown> };
const ops: Op[] = [];

/** Filas que devuelve el `select(...).maybeSingle()` de verificación de propiedad. */
let filaPropia: { id: string } | null = null;

function chain(tabla: string) {
  const op: Op = { tabla, verbo: '', filtros: {} };
  const c: Record<string, unknown> = {};
  for (const verbo of ['select', 'delete', 'update', 'insert']) {
    c[verbo] = (...args: unknown[]) => {
      op.verbo = verbo;
      if (verbo !== 'select') ops.push(op);
      if (verbo === 'update') op.filtros.__payload = args[0];
      return c;
    };
  }
  c.eq = (col: string, val: unknown) => {
    op.filtros[col] = val;
    return c;
  };
  c.maybeSingle = async () => ({ data: filaPropia, error: null });
  c.single = async () => ({ data: filaPropia, error: null });
  // Las escrituras se esperan sin `.single()`: el await cae sobre el thenable.
  c.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
    Promise.resolve({ data: null, error: null }).then(onF, onR);
  return c;
}

vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => ({ from: (tabla: string) => chain(tabla) }),
}));

const { DELETE } = await import('./route');

beforeEach(() => {
  ops.length = 0;
  filaPropia = null;
  requireLectura.mockResolvedValue({ ok: true, user: { id: 'alicia', plan: 'premium' }, authId: 'a1' });
});

const del = (id: string) =>
  DELETE(new Request(`https://app.neto.pe/api/debts?id=${id}`, { method: 'DELETE' }));

/** Las escrituras (no las lecturas de verificación) que la ruta llegó a ejecutar. */
const escrituras = () => ops.filter((o) => o.verbo !== 'select');

describe('DELETE /api/debts — deuda ajena', () => {
  beforeEach(() => {
    filaPropia = null; // la deuda existe, pero no es de quien pide
  });

  it('no borra los abonos de la deuda ajena', async () => {
    await del('deuda-de-bob');
    expect(escrituras().filter((o) => o.tabla === 'deuda_abonos')).toEqual([]);
  });

  it('no desvincula deudas que apunten a la deuda ajena', async () => {
    await del('deuda-de-bob');
    expect(escrituras().filter((o) => o.verbo === 'update')).toEqual([]);
  });

  it('no ejecuta NINGUNA escritura', async () => {
    await del('deuda-de-bob');
    expect(escrituras()).toEqual([]);
  });

  it('responde 404 en vez de un success mentiroso', async () => {
    const res = await del('deuda-de-bob');
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.not.toMatchObject({ success: true });
  });
});

describe('DELETE /api/debts — deuda propia (control)', () => {
  // Sin este bloque, una ruta que rechazara SIEMPRE se vería idéntica a la arreglada.
  beforeEach(() => {
    filaPropia = { id: 'deuda-de-alicia' };
  });

  it('borra abonos, desvincula y borra la deuda', async () => {
    const res = await del('deuda-de-alicia');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ success: true });

    const w = escrituras();
    expect(w.map((o) => `${o.verbo} ${o.tabla}`)).toEqual([
      'delete deuda_abonos',
      'update deudas',
      'delete deudas',
    ]);
  });

  it('el DELETE final sigue filtrando por usuario_id (la defensa en profundidad no se va)', async () => {
    await del('deuda-de-alicia');
    const final = escrituras().at(-1)!;
    expect(final.filtros).toMatchObject({ id: 'deuda-de-alicia', usuario_id: 'alicia' });
  });
});
