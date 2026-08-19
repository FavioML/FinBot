import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `cargarPagosConPlata` no tenía un solo test, y es la función de la que depende que un
 * cliente que volvió a pagar siga contando como cliente. Sus tres decisiones —trocear,
 * fallar cerrado y no aceptar una respuesta que pueda venir truncada— vivían solo como
 * comentarios: las tres mutaciones que las revierten dejaban la suite en verde.
 *
 * El cliente de Supabase va mockeado porque lo que se prueba acá es la POLÍTICA, no la red.
 */
const consultas: string[][] = [];
let respuesta: () => { data: unknown[] | null; error: { message: string } | null };

vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          gt: () => ({
            in: (_col: string, ids: string[]) => {
              consultas.push(ids);
              return Promise.resolve(respuesta());
            },
          }),
        }),
      }),
    }),
  }),
}));

const { cargarPagosConPlata } = await import('./admin-revenue-db');

const pago = (usuario_id: string, aprobado_at: string) => ({
  usuario_id, monto: '10.00', estado: 'aprobado', aprobado_at, created_at: aprobado_at,
});

beforeEach(() => {
  consultas.length = 0;
  respuesta = () => ({ data: [], error: null });
});

describe('cargarPagosConPlata', () => {
  it('con la lista vacía no toca la red', async () => {
    const idx = await cargarPagosConPlata([]);
    expect(consultas).toEqual([]);
    expect(idx.size).toBe(0);
  });

  it('deduplica los ids que le pasan las dos fuentes', async () => {
    // La ruta de economics le pasa las bajas Y los Pro pagados, que se solapan.
    await cargarPagosConPlata(['a', 'b', 'a', '']);
    expect(consultas).toEqual([['a', 'b']]);
  });

  it('indexa por usuario lo que devuelve', async () => {
    respuesta = () => ({
      data: [pago('a', '2026-08-05T00:00:00Z'), pago('a', '2026-08-09T00:00:00Z')],
      error: null,
    });
    const idx = await cargarPagosConPlata(['a']);
    expect(idx.get('a')).toHaveLength(2);
  });

  // La lista de ids crece MONÓTONAMENTE (`cuenta_borrada_at` no se limpia nunca). Un `.in()`
  // con cientos de UUIDs pasa el largo de URL de PostgREST y su proxy, y como acá el fallo es
  // cerrado, eso no degrada: deja el panel en 500 PERMANENTE.
  it('trocea la lista larga en lotes en vez de mandar un .in() gigante', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `u${i}`);
    await cargarPagosConPlata(ids);
    expect(consultas.map((c) => c.length)).toEqual([25, 25, 10]);
    expect(consultas.flat()).toEqual(ids); // sin perder ni repetir a nadie
  });

  // supabase-js no lanza. Sin este chequeo, un hipo de red devuelve `data: null`, el índice
  // sale vacío y el panel muestra como baja a TODO el que alguna vez pidió borrar su cuenta,
  // incluido el que volvió y está pagando. Un MRR más bajo se lee como caída del negocio.
  it('lanza si la lectura falla, en vez de devolver un índice vacío', async () => {
    respuesta = () => ({ data: null, error: { message: 'timeout' } });
    await expect(cargarPagosConPlata(['a'])).rejects.toThrow(/timeout/);
  });

  it('lanza también si falla un lote del medio', async () => {
    let n = 0;
    respuesta = () => {
      n++;
      return n === 2 ? { data: null, error: { message: 'boom' } } : { data: [], error: null };
    };
    await expect(
      cargarPagosConPlata(Array.from({ length: 60 }, (_, i) => `u${i}`)),
    ).rejects.toThrow(/boom/);
  });

  // PostgREST corta en 1000 filas SIN error. Un truncado acá se equivoca del lado caro:
  // falta el pago del que volvió, así que un cliente al día sale del MRR y entra al churn.
  it('lanza si la respuesta llegó al techo de PostgREST', async () => {
    respuesta = () => ({
      data: Array.from({ length: 1000 }, (_, i) => pago(`u${i}`, '2026-08-05T00:00:00Z')),
      error: null,
    });
    await expect(cargarPagosConPlata(['a'])).rejects.toThrow(/truncada|techo/i);
  });

  it('999 filas todavía no es truncado', async () => {
    respuesta = () => ({
      data: Array.from({ length: 999 }, (_, i) => pago(`u${i}`, '2026-08-05T00:00:00Z')),
      error: null,
    });
    await expect(cargarPagosConPlata(['a'])).resolves.toBeDefined();
  });
});
