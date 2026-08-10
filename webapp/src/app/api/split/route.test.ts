import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Dos hallazgos de la auditoría del 10-ago-2026 sobre el mismo archivo.
 *
 * M13 — el GET usaba `requireNetoUser` y devolvía el ledger completo de gastos compartidos.
 * Estaba exento del muro bajo el rótulo "colaborativo (host paga)", cuya justificación escrita
 * es que el tier del DUEÑO del espacio manda sobre el del que pide. Acá el filtro es
 * `creador_id = userId`: el que pide ES el dueño, así que ese motivo no aplicaba y alguien en
 * el muro se llevaba su agregado gratis pegándole a la API.
 *
 * S′3 — `monto_total` se validaba completo (NaN, Infinity, signo, techo) y los `monto_debe` de
 * los participantes entraban con `parseFloat` crudo. No se quedaba acá: `split/join` copia esa
 * cifra a una fila de `deudas` de OTRA persona, y un NaN la deja envenenada de forma
 * permanente — además de anular la guarda de sobrepago del PUT, porque `montoAbono > NaN` es
 * siempre false.
 *
 * El GET es la única operación del archivo que exige lectura: crear, editar y liquidar son
 * ESCRITURAS y la regla es que escribir nunca se corta.
 */

const requireLectura = vi.fn();
const requireNetoUser = vi.fn();

vi.mock('@/lib/supabase/auth', () => ({
  requireLectura: (...args: unknown[]) => requireLectura(...args),
  requireNetoUser: (...args: unknown[]) => requireNetoUser(...args),
}));

vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: () => true }));
vi.mock('@/lib/dates', () => ({ hoyPeru: () => '2026-08-10' }));

/** Filas insertadas en cada tabla, en orden. */
const inserts: Record<string, unknown[]> = {};

function chain(tabla: string) {
  const c: Record<string, unknown> = {};
  c.insert = (filas: unknown) => {
    (inserts[tabla] ??= []).push(filas);
    return c;
  };
  for (const verbo of ['select', 'update', 'delete', 'eq', 'order']) {
    c[verbo] = () => c;
  }
  c.single = async () => ({ data: { id: 'gasto-1' }, error: null });
  c.maybeSingle = async () => ({ data: { id: 'gasto-1' }, error: null });
  c.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
    Promise.resolve({ data: [], error: null }).then(onF, onR);
  return c;
}

vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => ({ from: (tabla: string) => chain(tabla) }),
}));

const { GET, POST } = await import('./route');

beforeEach(() => {
  for (const k of Object.keys(inserts)) delete inserts[k];
  requireNetoUser.mockResolvedValue({ ok: true, user: { id: 'u1', plan: 'premium' }, authId: 'a1' });
  requireLectura.mockResolvedValue({ ok: true, user: { id: 'u1', plan: 'premium' }, authId: 'a1' });
});

const post = (body: unknown) =>
  POST(new Request('https://app.neto.pe/api/split', { method: 'POST', body: JSON.stringify(body) }));

/** Un gasto de 100 repartido entre dos, con el `monto_debe` del primero sustituible. */
const gastoCon = (montoDebe: unknown, segundo = 50) => ({
  descripcion: 'Cena',
  monto_total: 100,
  participantes: [
    { nombre: 'Ana', monto_debe: montoDebe },
    { nombre: 'Beto', monto_debe: segundo },
  ],
});

describe('GET /api/split — el muro (M13)', () => {
  it('pide derecho de lectura, no solo sesión', async () => {
    await GET();
    expect(requireLectura).toHaveBeenCalled();
    expect(requireNetoUser).not.toHaveBeenCalled();
  });

  it('devuelve el 402 del muro sin tocar la base', async () => {
    const muro = new Response(JSON.stringify({ error: 'trial_terminado' }), { status: 402 });
    requireLectura.mockResolvedValue({ ok: false, response: muro });
    const res = await GET();
    expect(res.status).toBe(402);
  });

  // Sin este control, un GET que negara SIEMPRE se vería idéntico al arreglado.
  it('el que tiene derecho de lectura sigue viendo su ledger', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
  });
});

describe('POST /api/split — montos de los participantes (S′3)', () => {
  it.each([
    ['NaN', 'abc'],
    ['Infinity', Infinity],
    ['negativo', -50],
    ['sobre el tope NUMERIC', 1_000_000],
    ['ausente', undefined],
    ['null', null],
  ])('rechaza el monto %s y no inserta nada', async (_caso, monto) => {
    const res = await post(gastoCon(monto));
    expect(res.status).toBe(400);
    expect(inserts.gastos_compartidos).toBeUndefined();
    expect(inserts.gasto_participantes).toBeUndefined();
  });

  it('rechaza partes que suman MÁS que el total', async () => {
    const res = await post(gastoCon(90, 90)); // 180 contra un total de 100
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: 'Las partes suman más que el monto total' });
    expect(inserts.gasto_participantes).toBeUndefined();
  });

  /**
   * El caso que casi rompo. Los participantes son los OTROS: la UI crea `num - 1` filas
   * porque el que registra el gasto ya lo pagó. Un split de S/100 entre dos personas manda UN
   * participante de 50, o sea que las partes suman la mitad del total y eso es lo normal.
   * Una reconciliación por igualdad —que es lo que pedía el hallazgo— habría devuelto 400 en
   * todos los splits que el producto sabe crear.
   */
  it('acepta el caso real: partes que suman MENOS que el total', async () => {
    const res = await post({
      descripcion: 'Cena',
      monto_total: 100,
      participantes: [{ nombre: 'Ana', monto_debe: 50 }],
    });
    expect(res.status).toBe(200);
    expect(inserts.gasto_participantes[0]).toEqual([
      { gasto_id: 'gasto-1', nombre: 'Ana', usuario_id: null, monto_debe: 50, pagado: false },
    ]);
  });

  it('rechaza participantes que no son una lista, con 400 y no con un 500', async () => {
    const res = await post({ descripcion: 'Cena', monto_total: 100, participantes: { ana: 50 } });
    expect(res.status).toBe(400);
    expect(inserts.gastos_compartidos).toBeUndefined();
  });

  it('rechaza una lista de participantes desmesurada', async () => {
    const muchos = Array.from({ length: 51 }, (_, i) => ({ nombre: `P${i}`, monto_debe: 100 / 51 }));
    const res = await post({ descripcion: 'Cena', monto_total: 100, participantes: muchos });
    expect(res.status).toBe(400);
    expect(inserts.gasto_participantes).toBeUndefined();
  });

  it('acepta el reparto válido y persiste los montos ya redondeados a 2 decimales', async () => {
    const res = await post(gastoCon(50));
    expect(res.status).toBe(200);
    expect(inserts.gasto_participantes[0]).toEqual([
      { gasto_id: 'gasto-1', nombre: 'Ana', usuario_id: null, monto_debe: 50, pagado: false },
      { gasto_id: 'gasto-1', nombre: 'Beto', usuario_id: null, monto_debe: 50, pagado: false },
    ]);
  });

  // Tres partes de 33.33 suman 99.99: la tolerancia es por participante, no absoluta, o el
  // redondeo legítimo de una división en N partes haría fallar el caso más común de todos.
  it('tolera el centavo que deja una división en tres', async () => {
    const res = await post({
      descripcion: 'Cena',
      monto_total: 100,
      participantes: [
        { nombre: 'Ana', monto_debe: 33.33 },
        { nombre: 'Beto', monto_debe: 33.33 },
        { nombre: 'Cami', monto_debe: 33.33 },
      ],
    });
    expect(res.status).toBe(200);
  });
});
