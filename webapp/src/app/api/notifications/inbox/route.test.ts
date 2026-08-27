import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Lo que esta ruta no sabia representar: **cuantos avisos hay de verdad**.
 *
 * El panel lista con `.limit(20)` porque el dropdown no pagina, y la telemetria de la campana
 * (`notifications_opened`) derivaba `total` y `tipos` de esa lista. `unreadCount`, en cambio,
 * contaba exacto sobre todas las filas. El resultado son aperturas REALES en PostHog con
 * `total: 20, no_leidas: 22` — un imposible aritmetico que nadie miro porque 20 es plausible.
 *
 * El sesgo no es parejo: satura arriba, o sea exactamente en el usuario con volumen, que es el
 * unico sobre el que la pregunta "¿es ruido?" tiene sentido. Medido en produccion el 27-ago-2026:
 * 8 de 77 usuarios pasan el cap, el mayor con 786 filas, y **6 de esos 8 pierden ademas al menos
 * un TIPO** en la vista capada (`deuda_vence` desaparecia en los dos mas grandes).
 *
 * Los tres casos de abajo son los tres que se pueden romper despues sin que nadie mire.
 */

const requireNetoUser = vi.fn();

/** Todas las filas del usuario en la base (el listado devuelve solo las primeras 20). */
let filas: { id: string; tipo: string; leida: boolean }[] = [];
/** Que devuelve la funcion de resumen. `null` simula que fallo. */
let resumen: { total: number; tipos: string[] } | null = null;
/** Que argumentos recibio la funcion de resumen. */
let rpcArgs: { nombre: string; params: Record<string, unknown> } | null = null;

vi.mock('@/lib/supabase/auth', () => ({
  requireNetoUser: (...args: unknown[]) => requireNetoUser(...args),
}));

vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => ({
    from() {
      const estado = { head: false, soloNoLeidas: false, limite: Infinity };
      const q = {
        select(_cols: string, opts?: { count?: string; head?: boolean }) {
          estado.head = !!opts?.head;
          return q;
        },
        eq(col: string, val: unknown) {
          if (col === 'leida' && val === false) estado.soloNoLeidas = true;
          return q;
        },
        order: () => q,
        limit(n: number) {
          estado.limite = n;
          return q;
        },
        // El listado se espera directo (sin `.single()`), asi que la query es thenable.
        then(resolver: (r: unknown) => unknown) {
          if (estado.head) {
            const universo = estado.soloNoLeidas ? filas.filter((f) => !f.leida) : filas;
            return Promise.resolve({ data: null, count: universo.length, error: null }).then(resolver);
          }
          return Promise.resolve({ data: filas.slice(0, estado.limite), error: null }).then(resolver);
        },
      };
      return q;
    },
    rpc(nombre: string, params: Record<string, unknown>) {
      rpcArgs = { nombre, params };
      return {
        maybeSingle: async () =>
          resumen
            ? { data: resumen, error: null }
            : { data: null, error: { message: 'boom' } },
      };
    },
  }),
}));

const { GET } = await import('./route');

/** 41 filas, cinco tipos, y el quinto vive SOLO fuera de las 20 mas nuevas. */
function sembrar41() {
  filas = [
    ...Array.from({ length: 25 }, (_, i) => ({ id: `n${i}`, tipo: 'sistema', leida: false })),
    ...Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, tipo: 'recordatorio', leida: true })),
    ...Array.from({ length: 5 }, (_, i) => ({ id: `f${i}`, tipo: 'alerta_fugas', leida: true })),
    ...Array.from({ length: 5 }, (_, i) => ({ id: `d${i}`, tipo: 'deuda_vence', leida: true })),
    { id: 'p0', tipo: 'pro', leida: true },
  ];
  resumen = { total: 41, tipos: ['alerta_fugas', 'deuda_vence', 'pro', 'recordatorio', 'sistema'] };
}

beforeEach(() => {
  vi.clearAllMocks();
  filas = [];
  resumen = null;
  rpcArgs = null;
  requireNetoUser.mockResolvedValue({ ok: true, authId: 'a1', user: { id: 'u1' } });
});

describe('GET /api/notifications/inbox', () => {
  it('el listado sigue capado en 20 (des-capar no era el arreglo)', async () => {
    sembrar41();
    const body = await (await GET()).json();
    // 786 filas en el usuario mas grande de produccion, sin poda y creciendo: mandarlas a un
    // dropdown de 400px cada 60s cambia un sesgo de medicion por un problema de peso.
    expect(body.notifications).toHaveLength(20);
  });

  it('`total` es el exacto y NO el largo del listado', async () => {
    sembrar41();
    const body = await (await GET()).json();
    expect(body.total).toBe(41);
    expect(body.total).not.toBe(body.notifications.length);
  });

  it('`tipos` trae los que solo viven fuera del cap', async () => {
    sembrar41();
    const body = await (await GET()).json();
    // `pro` es la fila mas vieja: derivar el inventario del listado la borraba. En produccion
    // el que desaparecia asi era `deuda_vence`, que es el tipo sobre el que se decide el canal.
    expect(body.tipos).toContain('pro');
    const tiposDelListado = [...new Set(body.notifications.map((n: { tipo: string }) => n.tipo))];
    expect(tiposDelListado).not.toContain('pro');
  });

  it('`unreadCount` sigue siendo exacto y puede superar al listado', async () => {
    sembrar41();
    const body = await (await GET()).json();
    // Esta es la mitad que YA contaba bien, y por eso el bug era visible desde el dato:
    // `total: 20, no_leidas: 25` no puede pasar si los dos miran lo mismo.
    expect(body.unreadCount).toBe(25);
    expect(body.unreadCount).toBeGreaterThan(body.notifications.length);
  });

  it('si el resumen falla manda `null`, no cero', async () => {
    sembrar41();
    resumen = null; // la funcion devuelve error
    const body = await (await GET()).json();
    // Cero es un valor legitimo (usuario sin avisos). Confundirlo con "no se midio" es el
    // mismo defecto de nuevo, sesgado hacia abajo y sin ninguna senal.
    expect(body.total).toBeNull();
    expect(body.tipos).toBeNull();
    // Y el resto de la campana no se cae con el: la insignia sigue contando.
    expect(body.unreadCount).toBe(25);
    expect(body.notifications).toHaveLength(20);
  });

  it('el usuario sin avisos da 0 y lista vacia (0 no es null)', async () => {
    filas = [];
    resumen = { total: 0, tipos: [] };
    const body = await (await GET()).json();
    expect(body.total).toBe(0);
    expect(body.tipos).toEqual([]);
    expect(body.unreadCount).toBe(0);
  });

  it('el resumen se pide para el usuario de la sesion, no para uno de la request', async () => {
    sembrar41();
    await GET();
    // La funcion esta revocada de anon/authenticated justamente porque el scope lo pone el
    // servidor. Si el `p_usuario_id` saliera de otro lado, esto seria un IDOR.
    expect(rpcArgs).toEqual({ nombre: 'notificaciones_resumen', params: { p_usuario_id: 'u1' } });
  });
});
