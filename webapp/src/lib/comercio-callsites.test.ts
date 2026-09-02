import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * LA WEBAPP TAMBIÉN CANONIZA EL COMERCIO, Y ESTO LO PRUEBA EJECUTANDO LA RUTA.
 *
 * `comercio.ts` y su test de paridad prueban que la FUNCIÓN hace lo correcto. No prueban que
 * alguien la llame. Una revisión adversarial midió la diferencia: borrando las dos llamadas de
 * `api/transactions/route.ts` —con un comentario perfectamente razonable, "no le pises al
 * usuario lo que tipeó"— las dos suites quedaban en 3066 y 557, exactamente los números del
 * baseline, y la webapp volvía a insertar "IZI*BARBANEGRA" mientras el backend insertaba
 * "BARBANEGRA". El defecto entero reabierto sin un solo test en rojo.
 *
 * Por eso esto invoca los handlers REALES y mira la fila que sale, en vez de buscar la cadena
 * `canonizarComercio` en el archivo: un guard que busca un nombre lo satisface cualquiera que
 * escriba ese nombre, y lo evade cualquiera que consiga el mismo efecto de otra forma.
 */

const capturado: { tabla: string | null; filas: unknown[]; upserts: unknown[]; updates: unknown[] } = {
  tabla: null, filas: [], upserts: [], updates: [],
};

function chain(tabla: string) {
  const self: Record<string, unknown> = {};
  const dev = () => self;
  Object.assign(self, {
    select: dev, eq: dev, gte: dev, lte: dev, order: dev, limit: dev, in: dev, not: dev,
    single: () => Promise.resolve({ data: { id: 'tx-1' }, error: null }),
    maybeSingle: () => Promise.resolve({ data: { id: 'tx-1' }, error: null }),
    insert: (fila: unknown) => {
      capturado.tabla = tabla;
      capturado.filas.push(...(Array.isArray(fila) ? fila : [fila]));
      return self;
    },
    upsert: (filas: unknown) => {
      capturado.upserts.push(...(Array.isArray(filas) ? filas : [filas]));
      return Promise.resolve({ data: null, error: null });
    },
    update: (fila: unknown) => { capturado.tabla = tabla; capturado.updates.push(fila); return self; },
    delete: dev,
    then: (res: (v: unknown) => unknown) => res({ data: [{ id: 'tx-1' }], error: null }),
  });
  return self;
}

vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => ({ from: (t: string) => chain(t) }) }));
vi.mock('@/lib/supabase/auth', () => ({
  requireNetoUser: async () => ({ ok: true, user: { id: 'u-1', plan: 'premium' }, authId: 'a-1' }),
}));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: () => true }));
vi.mock('@/lib/exchange-rate', () => ({ getExchangeRate: async () => 3.5 }));
vi.mock('@/lib/trial-backend', () => ({ iniciarTrialBackend: async () => ({ iniciado: false }) }));
vi.mock('next/server', async (original) => {
  const real = await original<typeof import('next/server')>();
  return { ...real, after: (fn: () => unknown) => fn() };
});

const pedido = (body: Record<string, unknown>) =>
  ({ json: async () => body, headers: new Headers(), url: 'http://x/api/transactions' }) as unknown as Request;

describe('las rutas de la webapp escriben el comercio ya canónico', () => {
  beforeEach(() => { capturado.tabla = null; capturado.filas = []; capturado.upserts = []; capturado.updates = []; });

  it('POST /api/transactions inserta sin el prefijo de pasarela', async () => {
    const { POST } = await import('@/app/api/transactions/route');
    await POST(pedido({
      tipo: 'gasto', monto: 97, moneda: 'PEN', comercio: 'IZI*BARBANEGRA',
      categoria: 'Alimentación', subcategoria: 'snacks', fecha: '2026-08-23',
    }));
    const fila = capturado.filas[0] as { comercio: string };
    expect(fila.comercio).toBe('BARBANEGRA');
  });

  it('POST calcula el dedup_hash sobre el nombre canónico, igual que el backend', async () => {
    // `generarDedupHash` promete "matching backend format" y el backend hashea el canónico.
    // Sin canonizar antes del hash, la misma transacción da hashes distintos según el canal.
    const crypto = await import('crypto');
    const esperado = crypto.createHash('md5')
      .update('u-1|2026-08-23|97|BARBANEGRA|gasto').digest('hex');
    const { POST } = await import('@/app/api/transactions/route');
    await POST(pedido({
      tipo: 'gasto', monto: 97, moneda: 'PEN', comercio: 'IZI*BARBANEGRA',
      categoria: 'Alimentación', subcategoria: 'snacks', fecha: '2026-08-23',
    }));
    const fila = capturado.filas[0] as { dedup_hash: string };
    expect(fila.dedup_hash).toBe(esperado);
  });

  it('la regla que aprende la webapp usa el patrón canónico', async () => {
    // Si acá quedara "izi*barbanegra", esa regla no matchearía ninguna transacción futura:
    // el runtime ya no escribe esa forma. El arreglo fabricaría reglas muertas.
    const { POST } = await import('@/app/api/transactions/route');
    await POST(pedido({
      tipo: 'gasto', monto: 97, moneda: 'PEN', comercio: 'IZI*BARBANEGRA',
      categoria: 'Alimentación', subcategoria: 'snacks', fecha: '2026-08-23',
    }));
    const patrones = (capturado.upserts as { comercio_pattern: string }[]).map((u) => u.comercio_pattern);
    expect(patrones).toContain('barbanegra');
    expect(patrones).not.toContain('izi*barbanegra');
  });

  it('un comercio sin pasarela pasa intacto', async () => {
    const { POST } = await import('@/app/api/transactions/route');
    await POST(pedido({
      tipo: 'gasto', monto: 45.5, moneda: 'PEN', comercio: 'NIUBIZ PERU',
      categoria: 'Trabajo_Negocio', subcategoria: 'herramientas', fecha: '2026-08-23',
    }));
    const fila = capturado.filas[0] as { comercio: string };
    expect(fila.comercio).toBe('NIUBIZ PERU');
  });

  it('PUT /api/transactions actualiza con el nombre canónico', async () => {
    // Los cuatro `it` originales llamaban todos a POST. Una revisión adversarial borró la
    // canonización del PUT con un comentario razonable ("la persona está editando, ése es el
    // nombre que quiere ver") y las dos suites quedaron en los números exactos del baseline.
    const { PUT } = await import('@/app/api/transactions/route');
    await PUT(pedido({
      id: 'tx-1', tipo: 'gasto', monto: 97, moneda: 'PEN', comercio: 'IZI*BARBANEGRA',
      categoria: 'Alimentación', subcategoria: 'snacks', fecha: '2026-08-23',
    }));
    const fila = capturado.updates[0] as { comercio: string };
    expect(fila.comercio).toBe('BARBANEGRA');
  });

  it('el import de Excel/CSV por la web también inserta canónico', async () => {
    const { POST: IMPORT } = await import('@/app/api/transactions/import/route');
    const csv = 'fecha,monto,comercio,categoria,tipo\n2026-08-23,97,IZI*BARBANEGRA,Alimentación,gasto\n';
    const form = new FormData();
    form.append('file', new File([csv], 'gastos.csv', { type: 'text/csv' }));
    const req = { formData: async () => form, headers: new Headers(), url: 'http://x/api/transactions/import' } as unknown as Request;
    await IMPORT(req);
    const filas = capturado.filas as { comercio: string }[];
    expect(filas.length).toBeGreaterThan(0);
    expect(filas[0].comercio).toBe('BARBANEGRA');
  });
});
