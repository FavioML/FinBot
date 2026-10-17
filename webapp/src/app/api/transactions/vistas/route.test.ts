import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * El doble de Supabase APLICA los filtros sobre una tabla en memoria, en vez de devolver una
 * respuesta fija. Con un doble que ignora los filtros, olvidarse del `.eq('usuario_id')` —el bug
 * que hace IDOR a esta ruta— saldría verde.
 */

const requireNetoUser = vi.fn();

type Fila = { id: string; usuario_id: string; vista_at: string | null };
let tabla: Fila[] = [];
let fallar = false;

const U1 = 'u-1';
const U2 = 'u-2';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const VIEJA = '2026-10-01T00:00:00.000Z';

vi.mock('@/lib/supabase/auth', () => ({
  requireNetoUser: (...args: unknown[]) => requireNetoUser(...args),
}));

vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => ({
    from(nombre: string) {
      if (nombre !== 'transacciones') throw new Error('tabla inesperada: ' + nombre);
      const filtros: ((f: Fila) => boolean)[] = [];
      let valores: Partial<Fila> = {};
      const q = {
        update(v: Partial<Fila>) {
          valores = v;
          return q;
        },
        eq(col: keyof Fila, val: unknown) {
          filtros.push((f) => f[col] === val);
          return q;
        },
        is(col: keyof Fila, val: null) {
          filtros.push((f) => f[col] === val);
          return q;
        },
        in(col: keyof Fila, vals: unknown[]) {
          filtros.push((f) => vals.includes(f[col]));
          return q;
        },
        then(resolver: (r: unknown) => unknown) {
          if (fallar) return Promise.resolve({ data: null, count: null, error: { message: 'boom' } }).then(resolver);
          const afectadas = tabla.filter((f) => filtros.every((p) => p(f)));
          for (const f of afectadas) Object.assign(f, valores);
          return Promise.resolve({ data: null, count: afectadas.length, error: null }).then(resolver);
        },
      };
      return q;
    },
  }),
}));

const { POST } = await import('./route');

const pedir = (body: unknown) =>
  POST(new Request('http://x/api/transactions/vistas', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  fallar = false;
  requireNetoUser.mockResolvedValue({ ok: true, user: { id: U1 }, authId: 'auth-1' });
  tabla = [
    { id: id(1), usuario_id: U1, vista_at: null },
    { id: id(2), usuario_id: U1, vista_at: null },
    { id: id(3), usuario_id: U1, vista_at: VIEJA },
    { id: id(4), usuario_id: U2, vista_at: null },
  ];
});

const fila = (n: number) => tabla.find((f) => f.id === id(n))!;

describe('POST /api/transactions/vistas', () => {
  it('sin sesión devuelve la respuesta del chokepoint y no escribe', async () => {
    const SENTINEL = new Response(null, { status: 401 });
    requireNetoUser.mockResolvedValue({ ok: false, response: SENTINEL });
    expect(await pedir({ ids: [id(1)] })).toBe(SENTINEL);
    expect(tabla.every((f) => f.vista_at === null || f.vista_at === VIEJA)).toBe(true);
  });

  it('marca solo las filas pedidas', async () => {
    const res = await pedir({ ids: [id(1)] });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, vistas: 1 });
    expect(fila(1).vista_at).not.toBeNull();
    expect(fila(2).vista_at).toBeNull();
  });

  // El id de la sesión filtra el UPDATE: pedir la fila de otro no la toca.
  it('no toca filas de otro usuario aunque se pidan por id', async () => {
    const res = await pedir({ ids: [id(4)] });
    await expect(res.json()).resolves.toEqual({ ok: true, vistas: 0 });
    expect(fila(4).vista_at).toBeNull();
  });

  it('varias filas: marca las nuevas del usuario y nada más', async () => {
    const res = await pedir({ ids: [id(1), id(2), id(3), id(4)] });
    await expect(res.json()).resolves.toEqual({ ok: true, vistas: 2 });
    expect(fila(1).vista_at).not.toBeNull();
    expect(fila(2).vista_at).not.toBeNull();
    expect(fila(4).vista_at).toBeNull();
  });

  it('una fila ya vista conserva la hora en que se vio primero', async () => {
    await pedir({ ids: [id(3)] });
    expect(fila(3).vista_at).toBe(VIEJA);
  });

  it.each([
    [{}, 'sin ids'],
    // "Marcar todas" no existe a propósito: se llevaría lo que llegó después de cargar la página.
    [{ todos: true }, 'todos'],
    [{ ids: [] }, 'ids vacío'],
    [{ ids: ['1 or 1=1'] }, 'id que no es uuid'],
    [{ ids: Array.from({ length: 201 }, (_, i) => id(i)) }, 'más de 200'],
    [{ ids: 'x' }, 'ids que no es lista'],
  ] as [unknown, string][])('rechaza %j (%s) sin escribir', async (body) => {
    const res = await pedir(body);
    expect(res.status).toBe(400);
    expect(fila(1).vista_at).toBeNull();
  });

  it('si la base falla no responde ok', async () => {
    fallar = true;
    const res = await pedir({ ids: [id(1)] });
    expect(res.status).toBe(500);
  });
});
