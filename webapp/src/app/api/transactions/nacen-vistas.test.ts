import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Lo que la persona crea o toca EN la webapp no puede quedar marcado "Nuevo" (migración 091).
 * La columna nace NULL para todo insert que no la nombre, así que el olvido no da error: da una
 * pantalla llena de marcas sobre movimientos que la persona acaba de escribir o importar.
 *
 * Cubre las cuatro escrituras de la webapp sobre `transacciones`: crear (POST), editar (PUT),
 * editar en lote (PATCH) e importar.
 */

const requireNetoUser = vi.fn();
let escrito: { op: 'insert' | 'update'; valores: unknown }[] = [];

vi.mock('@/lib/supabase/auth', () => ({
  requireNetoUser: (...args: unknown[]) => requireNetoUser(...args),
}));
vi.mock('next/server', async (original) => ({
  ...(await original<typeof import('next/server')>()),
  after: vi.fn(),
}));
vi.mock('@/lib/exchange-rate', () => ({ getExchangeRate: async () => 3.7 }));
vi.mock('@/lib/trial-backend', () => ({ iniciarTrialBackend: async () => {} }));

vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => ({
    from() {
      const q = {
        insert(valores: unknown) {
          escrito.push({ op: 'insert', valores });
          return q;
        },
        update(valores: unknown) {
          escrito.push({ op: 'update', valores });
          return q;
        },
        select: () => q,
        eq: () => q,
        in: () => q,
        single: async () => ({ data: { id: 'tx-1' }, error: null }),
        then: (r: (v: unknown) => unknown) =>
          Promise.resolve({ data: [{ id: 'tx-1' }], count: 1, error: null }).then(r),
      };
      return q;
    },
  }),
}));

const { POST, PUT, PATCH } = await import('./route');
const { POST: IMPORT } = await import('./import/route');

const json = (body: unknown) => new Request('http://x', { method: 'POST', body: JSON.stringify(body) });
const ultimo = () => escrito.at(-1)!.valores as Record<string, unknown>;
const esFecha = (v: unknown) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

beforeEach(() => {
  escrito = [];
  requireNetoUser.mockResolvedValue({ ok: true, user: { id: 'u-1', plan: 'premium' }, authId: 'a-1' });
});

describe('lo que se escribe desde la webapp nace visto', () => {
  it('crear', async () => {
    await POST(json({ monto: 20, fecha: '2026-10-16', categoria: 'Comida', tipo: 'gasto' }));
    expect(escrito[0].op).toBe('insert');
    expect(esFecha(ultimo().vista_at)).toBe(true);
  });

  it('editar', async () => {
    await PUT(json({ id: 'tx-1', monto: 20, fecha: '2026-10-16', categoria: 'Comida', tipo: 'gasto' }));
    expect(esFecha(ultimo().vista_at)).toBe(true);
  });

  // Cada campo por separado: la revisión del 16-oct dejó este caso verde con un
  // `if (cleanUpdates.categoria)` alrededor de la marca, porque solo se probaba `categoria`.
  it.each(['categoria', 'subcategoria', 'metodo_pago', 'banco'])('editar en lote solo %s', async (campo) => {
    await PATCH(json({ ids: ['tx-1'], updates: { [campo]: 'X' } }));
    expect(escrito).toHaveLength(1);
    expect(esFecha(ultimo().vista_at)).toBe(true);
  });

  // `vista_at` no es un campo que la persona elija: no puede volver válido un lote vacío.
  it('editar en lote sin campos sigue siendo 400', async () => {
    const res = await PATCH(json({ ids: ['tx-1'], updates: {} }));
    expect(res.status).toBe(400);
    expect(escrito).toHaveLength(0);
  });

  it('importar', async () => {
    // Usuario propio: el límite de ritmo es un Map en memoria por usuario, y la importación tiene
    // tope de 5/min. Con los casos de arriba, el mismo usuario ya lo habría pasado (429).
    requireNetoUser.mockResolvedValue({ ok: true, user: { id: 'u-import', plan: 'premium' }, authId: 'a-2' });
    const form = new FormData();
    form.append('file', new File(['fecha,monto,descripcion\n16/10/2026,25.50,Tambo\n'], 'x.csv', { type: 'text/csv' }));
    const res = await IMPORT(new Request('http://x', { method: 'POST', body: form }));
    expect(res.status).toBe(200);
    const filas = ultimo() as unknown as Record<string, unknown>[];
    expect(filas.length).toBeGreaterThan(0);
    expect(filas.every((f) => esFecha(f.vista_at))).toBe(true);
  });
});
