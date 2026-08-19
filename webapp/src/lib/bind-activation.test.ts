import { describe, it, expect } from 'vitest';
import { bindActivacion } from './bind-activation';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Una LÁPIDA no puede adoptar una sesión.
 *
 * El caso lo encontró la revisión del arreglo del MRR, corrigiéndose a sí misma: había
 * cerrado que la fila borrada era inalcanzable porque el wipe deja `whatsapp`, `email`,
 * `supabase_auth_id` y `bsuid` en NULL. Falso — `bindActivacion` no busca por identidad,
 * busca por **PK**, y `usuarios.id` es lo único que el wipe no puede tocar. Y el wipe pone
 * `supabase_auth_id = NULL`, que era justo la condición que hacía al token de un solo uso:
 * borrar la cuenta REARMA el link de activación por lo que le quede de sus 7 días.
 */

interface FilaFalsa {
  id: string;
  supabase_auth_id: string | null;
  nombre: string | null;
  email: string | null;
  cuenta_borrada_at: string | null;
}

/**
 * Cliente mínimo: registra los updates y responde el select por `id` o por `auth_id`.
 *
 * **Proyecta la fila según las columnas del `select`, y esa línea no es decorativa.** La
 * primera versión devolvía el objeto entero pase lo que pase, así que la mutación "sacar
 * `cuenta_borrada_at` del select" dejaba el test en VERDE — el fixture era más benévolo que
 * PostgREST, que devuelve `undefined` para lo que no se pidió. Es el mismo modo de falla que
 * ya costó caro en `meta_aportes` (ver docs/DEFECTOS.md): un doble que no reproduce la forma
 * real convierte al guard en decoración.
 */
function clienteFalso(fila: FilaFalsa | null) {
  const updates: Record<string, unknown>[] = [];
  const rpcs: string[] = [];
  const proyectar = (f: FilaFalsa | null, cols: string) => {
    if (!f) return null;
    const pedidas = cols.split(/\s*,\s*/).map((c) => c.trim());
    return Object.fromEntries(
      Object.entries(f).filter(([k]) => pedidas.includes(k)),
    ) as Partial<FilaFalsa>;
  };
  const svc = {
    from: () => {
      const chain = {
        select: (cols: string) => {
          chain._cols = cols;
          return chain;
        },
        eq: (col: string, val: string) => {
          chain._col = col;
          chain._val = val;
          return chain;
        },
        maybeSingle: () => {
          if (chain._col === 'id') {
            const encontrada = fila && fila.id === chain._val ? fila : null;
            return Promise.resolve({ data: proyectar(encontrada, chain._cols), error: null });
          }
          // búsqueda por supabase_auth_id: nunca encuentra nada en estos casos
          return Promise.resolve({ data: null, error: null });
        },
        update: (v: Record<string, unknown>) => {
          updates.push(v);
          return { eq: () => Promise.resolve({ error: null }) };
        },
        _col: '',
        _val: '',
        _cols: '',
      };
      return chain;
    },
    rpc: (nombre: string) => {
      rpcs.push(nombre);
      return Promise.resolve({ data: 'linked', error: null });
    },
  } as unknown as SupabaseClient;
  return { svc, updates, rpcs };
}

const LAPIDA: FilaFalsa = {
  id: 'u-borrado',
  supabase_auth_id: null, // el wipe lo puso en NULL: el token volvió a estar vivo
  nombre: null,
  email: null,
  cuenta_borrada_at: '2026-08-09T00:42:06Z',
};

describe('bindActivacion contra una cuenta ya borrada', () => {
  it('no la adopta: el link viejo deja de funcionar', async () => {
    const { svc, updates, rpcs } = clienteFalso(LAPIDA);
    const r = await bindActivacion(svc, 'u-borrado', 'auth-nuevo', 'x@y.com', 'X');
    expect(r.estado).toBe('cuenta_borrada');
    // Y sobre todo: NO escribió nada. Sin este corte la lápida quedaba viva con la marca de
    // baja puesta, o sea fuera del MRR para siempre siendo un usuario que usa el producto —
    // y sin poder volver a pedir la baja, porque `borrar_cuenta_total` corta en `ya_borrada`.
    expect(updates).toEqual([]);
    expect(rpcs).toEqual([]);
  });

  it('una fila viva SÍ se adopta (el corte no rompe el camino normal)', async () => {
    const viva: FilaFalsa = { id: 'u-vivo', supabase_auth_id: null, nombre: null, email: null,
      cuenta_borrada_at: null };
    const { svc, updates } = clienteFalso(viva);
    const r = await bindActivacion(svc, 'u-vivo', 'auth-nuevo', 'x@y.com', 'X');
    expect(r.estado).toBe('adoptada');
    expect(updates[0]).toMatchObject({ supabase_auth_id: 'auth-nuevo', onboarding_completado: true });
  });

  // El corte va ANTES del chequeo de `supabase_auth_id` a propósito: si alguien alcanzó a
  // adoptar la lápida antes de este arreglo, el link tampoco puede volver a operar sobre ella.
  it('tampoco pasa si la lápida ya tenía una sesión pegada', async () => {
    const { svc, updates } = clienteFalso({ ...LAPIDA, supabase_auth_id: 'auth-nuevo' });
    const r = await bindActivacion(svc, 'u-borrado', 'auth-nuevo', null, null);
    expect(r.estado).toBe('cuenta_borrada');
    expect(updates).toEqual([]);
  });

  it('el token que no encuentra fila sigue dando sin_fila', async () => {
    const { svc } = clienteFalso(null);
    expect((await bindActivacion(svc, 'u-x', 'auth', null, null)).estado).toBe('sin_fila');
  });
});
