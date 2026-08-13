import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const handler = require('../../handlers/intents/transacciones');

// ─── Supabase mock ──────────────────────────────────────────────────────────
// Cada llamada a from(tabla) devuelve un chain que es thenable (await-able)
// y donde todos los metodos de filtrado retornan this para permitir chaining.
// tableData = { 'tabla': [filas] } configura que devuelve cada tabla.

function makeChain(data = [], error = null) {
  const c = {};
  const METHODS = ['select','insert','update','delete','upsert',
                   'eq','ilike','gte','lte','is','neq','not','order','limit','single'];
  for (const m of METHODS) {
    c[m] = vi.fn().mockReturnValue(c);
  }
  c.then = (onFulfilled, onRejected) =>
    Promise.resolve({ data, error, count: Array.isArray(data) ? data.length : null })
      .then(onFulfilled, onRejected);
  c.catch = () => Promise.resolve({ data, error });
  c._resolvedData = data;
  return c;
}

function makeSupabaseMock(tableData = {}) {
  const chains = {};
  const sb = {
    from: vi.fn((table) => {
      if (!chains[table]) chains[table] = makeChain(tableData[table] || [], null);
      return chains[table];
    }),
    _chains: chains,
    _setData: (table, data) => { chains[table] = makeChain(data); },
    // Simula un fallo de postgrest: NO lanza, devuelve { data: null, error }.
    _setError: (table, error) => { chains[table] = makeChain(null, error); },
  };
  return sb;
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const TX_BASE = {
  id: 'tx-001',
  usuario_id: 'user-001',
  monto: 45.50,
  monto_pen: 45.50,
  moneda: 'PEN',
  comercio: 'Starbucks',
  categoria: 'Alimentacion',
  subcategoria: 'cafeteria',
  tipo: 'gasto',
  fecha: '2026-04-01',
  created_at: new Date().toISOString(),
  descripcion_original: null,
};

const USUARIO = { id: 'user-001', plan: 'free' };

// ─── Context builder ─────────────────────────────────────────────────────────

function buildCtx(sb, extras = {}) {
  return {
    supabase: sb,
    mesActual: 4,
    anioActual: 2026,
    netoPrompt: 'Test',
    historialConv: [],
    CATEGORIAS_VALIDAS: new Set(['Alimentacion','Transporte','Vivienda','Salud',
      'Entretenimiento','Compras','Educacion','Finanzas','Trabajo_Negocio','Suscripciones','Otros']),
    CATEGORIA_MAP: {},
    obtenerUltimaTransaccion: vi.fn().mockResolvedValue(TX_BASE),
    recategorizarTransaccion: vi.fn().mockResolvedValue({ ok: true, tx: TX_BASE }),
    // Desde B30 devuelve un resultado DISCRIMINADO: `{ok:true, destino}` o
    // `{ok:false, motivo}`. El default es el caso normal; cada motivo tiene su propio test,
    // porque el handler ya no puede ni anunciar "Regla creada" sobre una regla descartada ni
    // darle el mismo consejo a un rechazo por política que a un fallo de escritura.
    guardarReglaComercio: vi.fn().mockResolvedValue({ ok: true, destino: { categoria: 'Transporte', subcategoria: null } }),
    retroaplicarRegla: vi.fn().mockResolvedValue(0),
    corregirTransaccionEspecifica: vi.fn().mockResolvedValue({ ok: true, comercio: 'Starbucks', monto: 45.50, moneda: 'PEN' }),
    guardarTransaccion: vi.fn().mockResolvedValue({ id: 'tx-002', ...TX_BASE }),
    obtenerTipoCambio: vi.fn().mockResolvedValue({ venta: 3.75 }),
    verificarAlertaPresupuesto: vi.fn().mockResolvedValue(null),
    crearCategoriaLibreUsuario: vi.fn(),
    // Reemplazó al guard de canonicidad que estaba copiado en los tres call-sites (B26):
    // decide sola si la categoría es libre, canónica faltante, o nada. Devuelve promesa porque
    // el call-site encadena la subcategoría con `.then()` — un `vi.fn()` pelado da undefined y
    // el handler revienta.
    asegurarCategoriaUsuario: vi.fn().mockResolvedValue('creada'),
    crearSubcategoriaLibreUsuario: vi.fn(),
    detectarCategoriaIA: vi.fn().mockResolvedValue({ categoria: 'Alimentacion', subcategoria: 'cafeteria' }),
    parsearRegistroManual: vi.fn().mockResolvedValue({ ok: true, monto: 50, moneda: 'PEN', categoria: 'Alimentacion', subcategoria: 'cafeteria', tipo: 'gasto', fecha: '2026-04-05' }),
    parsearCorreccionesMultiples: vi.fn().mockResolvedValue([]),
    redactarConNETO: vi.fn().mockResolvedValue('Respuesta mock'),
    fechaHoyPeru: vi.fn().mockReturnValue('2026-04-05'),
    fechaAyerPeru: vi.fn().mockReturnValue('2026-04-04'),
    formatFecha: vi.fn((f) => f || ''),
    ...extras,
  };
}

function call(intencion, datos, msg = '') {
  const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
  const ctx = buildCtx(sb);
  return { sb, ctx, run: () => handler.handle({ intencion, msg, datos, usuario: USUARIO, from: '+51999', ctx }) };
}

// ─── registrar_manual ───────────────────────────────────────────────────────

describe('registrar_manual', () => {
  it('registra gasto valido y retorna confirmacion con monto', async () => {
    const sb = makeSupabaseMock({ transacciones: [] });
    const ctx = buildCtx(sb);
    const res = await handler.handle({ intencion: 'registrar_manual', msg: 'gaste 50 en cafe', datos: {}, usuario: USUARIO, from: '+51999', ctx });
    expect(res).toContain('S/50.00');
    expect(ctx.guardarTransaccion).toHaveBeenCalledOnce();
  });

  it('rechaza cuando monto no extraible', async () => {
    const sb = makeSupabaseMock();
    const ctx = buildCtx(sb, { parsearRegistroManual: vi.fn().mockResolvedValue({ ok: false, monto: 0 }) });
    const res = await handler.handle({ intencion: 'registrar_manual', msg: 'gaste algo', datos: {}, usuario: USUARIO, from: '+51999', ctx });
    expect(res).toContain('No pude extraer el monto');
    expect(ctx.guardarTransaccion).not.toHaveBeenCalled();
  });

  it('llama crearSubcategoriaLibreUsuario para subcategorias custom', async () => {
    const sb = makeSupabaseMock({ transacciones: [] });
    const ctx = buildCtx(sb, {
      parsearRegistroManual: vi.fn().mockResolvedValue({ ok: true, monto: 30, moneda: 'PEN', categoria: 'Comida_Casera', subcategoria: 'tupper', tipo: 'gasto', fecha: '2026-04-05' }),
      detectarCategoriaIA: vi.fn().mockResolvedValue({}),
    });
    await handler.handle({ intencion: 'registrar_manual', msg: 'gaste 30 en tupper', datos: {}, usuario: USUARIO, from: '+51999', ctx });
    expect(ctx.crearSubcategoriaLibreUsuario).toHaveBeenCalledWith('user-001', 'Comida_Casera', 'tupper');
  });

  /**
   * El centinela NO se le muestra al usuario, y el fixture es el que importa: la fila que
   * devuelve `guardarTransaccion` viene de un `.select()`, o sea DESPUÉS del trigger
   * `trg_normalize_subcategoria` (migración 070), que capitaliza. El código escribe
   * 'sin_categoria' y prod devuelve **'Sin_categoria'** — 499 filas al 12-ago-2026, cero en
   * minúscula. Con la comparación literal que había antes, la confirmación de todo gasto sin
   * clasificar decía `✅ S/50.00 en Otros > Sin_categoria`.
   *
   * Por eso el mock devuelve la grafía de la DB y no la del código: un fixture en minúscula
   * probaría una rama que producción no alcanza nunca.
   */
  it('un gasto sin clasificar NO muestra el centinela en la confirmación', async () => {
    const sb = makeSupabaseMock({ transacciones: [] });
    const ctx = buildCtx(sb, {
      parsearRegistroManual: vi.fn().mockResolvedValue({ ok: true, monto: 50, moneda: 'PEN', categoria: 'Otros', subcategoria: 'sin_categoria', tipo: 'gasto', fecha: '2026-04-05' }),
      detectarCategoriaIA: vi.fn().mockResolvedValue({}),
      guardarTransaccion: vi.fn().mockResolvedValue({ id: 'tx-003', categoria: 'Otros', subcategoria: 'Sin_categoria' }),
    });
    const res = await handler.handle({ intencion: 'registrar_manual', msg: 'gaste 50 en no se que', datos: {}, usuario: USUARIO, from: '+51999', ctx });

    expect(res.toLowerCase()).not.toContain('sin_categoria');
    expect(res).toContain('en Otros ·');   // la categoría sola, sin el ` > sub`
    expect(res).not.toContain('Otros >');
    // Y la sub tampoco nace como categoría libre en el árbol del usuario.
    expect(ctx.crearSubcategoriaLibreUsuario).not.toHaveBeenCalled();
  });

  it('una subcategoría REAL sí se muestra (el fix no se comió el caso normal)', async () => {
    const sb = makeSupabaseMock({ transacciones: [] });
    const ctx = buildCtx(sb, {
      guardarTransaccion: vi.fn().mockResolvedValue({ id: 'tx-004', categoria: 'Alimentacion', subcategoria: 'Cafeteria' }),
    });
    const res = await handler.handle({ intencion: 'registrar_manual', msg: 'gaste 50 en cafe', datos: {}, usuario: USUARIO, from: '+51999', ctx });

    expect(res).toContain('Alimentacion > Cafeteria');
  });
});

// ─── registrar_manual: las dos llamadas al LLM van en paralelo (P′2) ─────────
//
// Registrar un gasto disparaba TRES llamadas a gpt-4o-mini en serie: la clasificación del
// message-processor, después `parsearRegistroManual` y después `detectarCategoriaIA`. Las
// dos últimas reciben solo `msg` y no dependen entre sí.
//
// Lo que se fija no es un tiempo (eso no se puede afirmar con mocks) sino la FORMA: que la
// segunda esté disparada mientras la primera sigue en vuelo. Volver a la versión en serie
// mata el primer test, porque con el parser colgado el clasificador nunca llega a llamarse.

describe('registrar_manual — paralelismo de las dos llamadas al LLM', () => {
  it('dispara detectarCategoriaIA mientras el parser sigue sin resolver', async () => {
    let resolverParser;
    const parsearRegistroManual = vi.fn(() => new Promise((res) => {
      resolverParser = () => res({ ok: true, monto: 50, moneda: 'PEN', categoria: 'Alimentacion', subcategoria: 'cafeteria', tipo: 'gasto', fecha: '2026-04-05' });
    }));
    const detectarCategoriaIA = vi.fn().mockResolvedValue({ categoria: 'Alimentacion', subcategoria: 'cafeteria' });

    const sb = makeSupabaseMock({ transacciones: [] });
    const ctx = buildCtx(sb, { parsearRegistroManual, detectarCategoriaIA });
    const promesa = handler.handle({ intencion: 'registrar_manual', msg: 'gaste 50 en cafe', datos: {}, usuario: USUARIO, from: '+51999', ctx });

    // Dejar correr los microtasks pendientes SIN resolver el parser.
    await new Promise((r) => setTimeout(r, 0));

    expect(parsearRegistroManual).toHaveBeenCalledOnce();
    // ⚠️ Esto es lo que muere si alguien vuelve a poner el clasificador después del parser.
    expect(detectarCategoriaIA).toHaveBeenCalledOnce();
    expect(detectarCategoriaIA).toHaveBeenCalledWith('gaste 50 en cafe', 'user-001', expect.anything());

    resolverParser();
    const res = await promesa;
    expect(res).toContain('S/50.00');
    // Y el resultado del clasificador se sigue usando, no se descarta por llegar antes.
    expect(res).toContain('Alimentacion');
  });

  it('un fallo del clasificador sigue rompiendo el registro (no se traga en silencio)', async () => {
    // El `.catch` mudo que evita el unhandledRejection NO debe consumir el rechazo: awaitear
    // la promesa más abajo tiene que lanzar igual que cuando la llamada era secuencial.
    const detectarCategoriaIA = vi.fn().mockRejectedValue(new Error('supabase caido'));
    const sb = makeSupabaseMock({ transacciones: [] });
    const ctx = buildCtx(sb, { detectarCategoriaIA });
    const res = await handler.handle({ intencion: 'registrar_manual', msg: 'gaste 50 en cafe', datos: {}, usuario: USUARIO, from: '+51999', ctx });
    expect(res).toContain('No pude procesar eso');
    expect(ctx.guardarTransaccion).not.toHaveBeenCalled();
  });

  it('sale por el camino del parser sin monto sin dejar un rechazo sin dueño', async () => {
    // La ruta que hace falta el `.catch`: el parser no encuentra monto, el handler retorna, y
    // la promesa del clasificador —ya en vuelo— se rechaza sin que nadie la espere. Sin la
    // guarda eso es un `unhandledRejection`, que en Node mata el proceso del backend.
    const capturados = [];
    const onUnhandled = (err) => capturados.push(err);
    process.on('unhandledRejection', onUnhandled);
    try {
      const sb = makeSupabaseMock({ transacciones: [] });
      const ctx = buildCtx(sb, {
        parsearRegistroManual: vi.fn().mockResolvedValue({ ok: false, monto: 0 }),
        // ⚠️ Función PELADA, no `vi.fn()`: el spy de vitest le engancha handlers a la promesa
        // que devuelve (es como alimenta `mock.settledResults`), así que con un mock el
        // rechazo NUNCA queda huérfano y este test pasaría verde sin la guarda. Medido:
        // con `vi.fn().mockRejectedValue(...)` la mutación "quitar el .catch" no lo mata.
        detectarCategoriaIA: () => Promise.reject(new Error('supabase caido')),
      });
      const res = await handler.handle({ intencion: 'registrar_manual', msg: 'gaste algo raro', datos: {}, usuario: USUARIO, from: '+51999', ctx });
      expect(res).toContain('No pude extraer el monto');

      // Dos vueltas de macrotask: es cuando Node decide que un rechazo quedó sin dueño.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(capturados).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('cancela la llamada al clasificador cuando el parser no encuentra monto', async () => {
    // Disparar en paralelo hace que las rutas que salen temprano paguen una llamada a
    // gpt-4o-mini que nadie va a leer. Con `maxRetries: 3` y `timeout: 60000` (lib/ai.js) eso
    // puede ser hasta cuatro requests durante minutos, quemando presupuesto de rate-limit
    // justo en el escenario del 429 que ya se comió 163 registros.
    let señal;
    const detectarCategoriaIA = vi.fn((_msg, _uid, opts) => { señal = opts && opts.signal; return Promise.resolve({}); });
    const sb = makeSupabaseMock({ transacciones: [] });
    const ctx = buildCtx(sb, {
      parsearRegistroManual: vi.fn().mockResolvedValue({ ok: false, monto: 0 }),
      detectarCategoriaIA,
    });
    await handler.handle({ intencion: 'registrar_manual', msg: 'gaste algo raro', datos: {}, usuario: USUARIO, from: '+51999', ctx });

    expect(señal).toBeInstanceOf(AbortSignal);
    expect(señal.aborted).toBe(true);
  });

  it('cancela también cuando el parser LANZA, no solo cuando no encuentra monto', async () => {
    // Este caso no lo cubría el test de arriba y la mutación lo demostró: quitar el `abort()`
    // del catch dejaba los 5 tests en verde. Es la salida más cara — si el parser reventó por
    // un 429, el clasificador está reintentando contra la misma organización saturada.
    let señal;
    const detectarCategoriaIA = vi.fn((_msg, _uid, opts) => { señal = opts && opts.signal; return Promise.resolve({}); });
    const sb = makeSupabaseMock({ transacciones: [] });
    const ctx = buildCtx(sb, {
      parsearRegistroManual: vi.fn().mockRejectedValue(new Error('429 rate limit')),
      detectarCategoriaIA,
    });
    const res = await handler.handle({ intencion: 'registrar_manual', msg: 'gaste 50 en taxi', datos: {}, usuario: USUARIO, from: '+51999', ctx });

    expect(res).toContain('No pude procesar eso');
    expect(señal.aborted).toBe(true);
  });

  it('NO cancela en el camino feliz: el resultado del clasificador sí se usa', async () => {
    let señal;
    const detectarCategoriaIA = vi.fn((_msg, _uid, opts) => {
      señal = opts && opts.signal;
      return Promise.resolve({ categoria: 'Transporte', subcategoria: 'taxi' });
    });
    const sb = makeSupabaseMock({ transacciones: [] });
    const ctx = buildCtx(sb, { detectarCategoriaIA });
    const res = await handler.handle({ intencion: 'registrar_manual', msg: 'gaste 50 en taxi', datos: {}, usuario: USUARIO, from: '+51999', ctx });

    expect(señal.aborted).toBe(false);
    expect(ctx.guardarTransaccion).toHaveBeenCalledOnce();
    expect(ctx.guardarTransaccion.mock.calls[0][1]).toMatchObject({ categoria: 'Transporte', subcategoria: 'taxi' });
    expect(res).toContain('S/50.00');
  });
});

// ─── eliminar_transaccion ───────────────────────────────────────────────────

describe('eliminar_transaccion', () => {
  it('elimina cuando hay exactamente un match por monto', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'eliminar_transaccion', msg: 'borra el de 45.50',
      datos: { monto: 45.50 }, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).toContain('Starbucks');
    expect(res).toContain('45.50');
    expect(res).toContain('restaura');
  });

  it('lista opciones cuando hay multiples candidatos', async () => {
    const tx2 = { ...TX_BASE, id: 'tx-002', comercio: 'Starbucks Miraflores' };
    const sb = makeSupabaseMock({ transacciones: [TX_BASE, tx2] });
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'eliminar_transaccion', msg: 'borra el de starbucks',
      datos: { comercio: 'starbucks' }, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).toContain('Encontr');
    expect(res).toContain('monto o la fecha exacta');
  });

  it('responde amigablemente si no hay resultados', async () => {
    const sb = makeSupabaseMock({ transacciones: [] });
    const ctx = buildCtx(sb, { obtenerUltimaTransaccion: vi.fn().mockResolvedValue(null) });
    const res = await handler.handle({
      intencion: 'eliminar_transaccion', msg: 'borra Netflix de 19.90',
      datos: { comercio: 'Netflix', monto: 19.90 }, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).toContain('No encontr');
    expect(res).toContain('Netflix');
  });

  it('inserta el snapshot ANTES del delete de la transaccion', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb);
    await handler.handle({
      intencion: 'eliminar_transaccion', msg: 'borra el de 45.50',
      datos: { monto: 45.50 }, usuario: USUARIO, from: '+51999', ctx,
    });
    const insertOrder = sb._chains['transacciones_eliminadas'].insert.mock.invocationCallOrder[0];
    const deleteOrder = sb._chains['transacciones'].delete.mock.invocationCallOrder[0];
    expect(insertOrder).toBeDefined();
    expect(deleteOrder).toBeDefined();
    expect(insertOrder).toBeLessThan(deleteOrder);
  });

  it('no promete restaurar cuando el insert del snapshot devuelve error', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    sb._setError('transacciones_eliminadas', { message: 'insert failed' });
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'eliminar_transaccion', msg: 'borra el de 45.50',
      datos: { monto: 45.50 }, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).toContain('Starbucks');
    expect(res).not.toContain('escribe \"restaura\"');
    expect(res).toContain('no lo voy a poder restaurar');
  });
});

// ─── deshacer_ultimo ────────────────────────────────────────────────────────

describe('deshacer_ultimo', () => {
  it('guarda snapshot en transacciones_eliminadas antes de borrar', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'deshacer_ultimo', msg: 'deshacer',
      datos: {}, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).toContain('Starbucks');
    expect(sb.from).toHaveBeenCalledWith('transacciones_eliminadas');
    expect(res).toContain('restaura');
  });

  it('responde si no hay transacciones recientes', async () => {
    const sb = makeSupabaseMock();
    const ctx = buildCtx(sb, { obtenerUltimaTransaccion: vi.fn().mockResolvedValue(null) });
    const res = await handler.handle({
      intencion: 'deshacer_ultimo', msg: 'deshacer',
      datos: {}, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).toContain('No hay transacciones');
  });

  // El orden importa: si borramos primero y el snapshot falla, el gasto se pierde
  // y le prometimos al usuario que podia restaurarlo.
  it('inserta el snapshot ANTES del delete de la transaccion', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb);
    await handler.handle({
      intencion: 'deshacer_ultimo', msg: 'deshacer',
      datos: {}, usuario: USUARIO, from: '+51999', ctx,
    });
    const insertOrder = sb._chains['transacciones_eliminadas'].insert.mock.invocationCallOrder[0];
    const deleteOrder = sb._chains['transacciones'].delete.mock.invocationCallOrder[0];
    expect(insertOrder).toBeDefined();
    expect(deleteOrder).toBeDefined();
    expect(insertOrder).toBeLessThan(deleteOrder);
  });

  it('no promete restaurar cuando el insert del snapshot devuelve error', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    sb._setError('transacciones_eliminadas', { message: 'new row violates row-level security policy' });
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'deshacer_ultimo', msg: 'deshacer',
      datos: {}, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).toContain('Starbucks');
    expect(res).not.toContain('escribe \"restaura\"');
    expect(res).toContain('no lo voy a poder restaurar');
  });
});

// ─── restaurar_eliminado ────────────────────────────────────────────────────

describe('restaurar_eliminado', () => {
  it('restaura el ultimo gasto eliminado', async () => {
    const deletedRow = {
      id: 'del-001',
      usuario_id: 'user-001',
      deleted_at: new Date().toISOString(),
      restored_at: null,
      snapshot: { ...TX_BASE },
    };
    const sb = makeSupabaseMock({ transacciones_eliminadas: [deletedRow], transacciones: [TX_BASE] });
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'restaurar_eliminado', msg: 'restaura',
      datos: {}, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).toContain('Starbucks');
    expect(res).toMatch(/[Rr]estaur/);
  });

  it('responde si no hay nada eliminado', async () => {
    const sb = makeSupabaseMock({ transacciones_eliminadas: [] });
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'restaurar_eliminado', msg: 'restaura',
      datos: {}, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).toContain('No tengo');
  });
});

// ─── editar_monto ───────────────────────────────────────────────────────────

describe('editar_monto', () => {
  it('busca por comercio cuando datos.comercio esta disponible', async () => {
    const netflixTx = { ...TX_BASE, id: 'tx-netflix', comercio: 'Netflix', monto: 19.90, monto_pen: 19.90 };
    const sb = makeSupabaseMock({ transacciones: [netflixTx] });
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'editar_monto', msg: 'corrige Netflix a 25',
      datos: { monto_nuevo: 25, comercio: 'Netflix' }, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).toContain('Netflix');
    expect(res).toContain('25.00');
    expect(sb.from).toHaveBeenCalledWith('transacciones');
    const chain = sb._chains['transacciones'];
    expect(chain.ilike).toHaveBeenCalledWith('comercio', '%Netflix%');
  });

  it('cae al ultimo gasto si no hay comercio en datos', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'editar_monto', msg: 'el monto fue 80',
      datos: { monto_nuevo: 80 }, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(ctx.obtenerUltimaTransaccion).toHaveBeenCalled();
    expect(res).toContain('80.00');
  });

  it('rechaza monto invalido', async () => {
    const { run, ctx } = call('editar_monto', {});
    const res = await run();
    expect(res).toContain('Dime el monto correcto');
  });

  /**
   * B18 (auditoría 10-ago-2026): esta rama usaba `parseFloat` + `> 0`, sin techo ni
   * `isFinite`. Es el gemelo por WhatsApp del bug ya arreglado en la webapp, y acá la
   * escritura es DIRECTA: no hay formulario que frene nada antes.
   *
   * Los casos son los mismos que `validarMonto` cubre, escritos como los mandaría alguien
   * por chat. Con el chequeo suelto los cuatro primeros pasaban y terminaban en la DB.
   */
  it.each([
    ['Infinity', Infinity],
    ['string Infinity', 'Infinity'],
    ['sobre el techo de 999999.99', 1000000],
    ['15 dígitos', 999999999999999],
    ['negativo', -50],
    ['cero', 0],
    ['texto', 'mucho'],
    ['NaN', NaN],
  ])('rechaza %s', async (_nombre, monto_nuevo) => {
    const { run } = call('editar_monto', { monto_nuevo });
    const res = await run();
    expect(res).toContain('Dime el monto correcto');
  });

  it('redondea a dos decimales en vez de escribir la cola infinita', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'editar_monto', msg: 'el monto es 33.333333',
      datos: { monto_nuevo: 33.333333 }, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).toContain('33.33');
    expect(sb._chains['transacciones'].update).toHaveBeenCalledWith(
      expect.objectContaining({ monto: 33.33 }),
    );
  });
});

// ─── dividir_gasto ──────────────────────────────────────────────────────────

describe('dividir_gasto', () => {
  it('divide el gasto y escribe la parte del usuario', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'dividir_gasto', msg: 'divide entre 2',
      datos: { partes: 2 }, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).toContain('22.75'); // 45.50 / 2
    expect(sb._chains['transacciones'].update).toHaveBeenCalledWith(
      expect.objectContaining({ monto: 22.75 }),
    );
  });

  // B18: el monto viene de la DB y esta rama lo vuelve a ESCRIBIR. Si ya estaba envenenado,
  // `parseFloat` lo dividía y lo propagaba sin mirarlo.
  it('no propaga un monto envenenado que ya estaba guardado', async () => {
    const podrido = { ...TX_BASE, monto: 'Infinity' };
    const sb = makeSupabaseMock({ transacciones: [podrido] });
    const ctx = buildCtx(sb, { obtenerUltimaTransaccion: vi.fn().mockResolvedValue(podrido) });
    const res = await handler.handle({
      intencion: 'dividir_gasto', msg: 'divide entre 2',
      datos: { partes: 2 }, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).toContain('no puedo dividir');
    // Ni siquiera abre la tabla: corta antes de tocar la DB.
    expect(sb.from).not.toHaveBeenCalledWith('transacciones');
  });

  // El resultado también se valida: dividir bajo el centavo escribía un gasto de 0.00, que
  // no es un gasto — y encima rompe el promedio de cualquier cosa que lo mire después.
  it('no escribe un gasto de cero cuando la división cae bajo el centavo', async () => {
    // 0.04 / 20 = 0.002 → toFixed(2) = "0.00". (0.10/20 redondea a 0.01 y sí es válido.)
    const centavos = { ...TX_BASE, monto: 0.04, monto_pen: 0.04 };
    const sb = makeSupabaseMock({ transacciones: [centavos] });
    const ctx = buildCtx(sb, { obtenerUltimaTransaccion: vi.fn().mockResolvedValue(centavos) });
    const res = await handler.handle({
      intencion: 'dividir_gasto', msg: 'divide entre 20',
      datos: { partes: 20 }, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).toContain('menos de un centavo');
    expect(sb.from).not.toHaveBeenCalledWith('transacciones');
  });
});

// ─── corregir_categoria ─────────────────────────────────────────────────────

describe('corregir_categoria', () => {
  it('recategoriza por comercio especifico', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'corregir_categoria', msg: 'mueve Rappi a Entretenimiento',
      datos: { categoria_nueva: 'Entretenimiento', comercio: 'Rappi' }, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).toContain('Entretenimiento');
    expect(ctx.recategorizarTransaccion).toHaveBeenCalledWith('user-001', 'Rappi', 'Entretenimiento', null);
  });

  it('usa el ultimo gasto si no viene comercio', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'corregir_categoria', msg: 'muevelo a Transporte',
      datos: { categoria_nueva: 'Transporte' }, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(ctx.obtenerUltimaTransaccion).toHaveBeenCalled();
    expect(res).toContain('Transporte');
  });

  // B30 — la resolución vive ACÁ ARRIBA y no en cada consumidor, porque de este único nombre
  // salen cinco escrituras/lecturas que tienen que coincidir: la fila recategorizada, el árbol,
  // la regla, la retroaplicación de las filas VIEJAS y el texto que lee el usuario.
  //
  // Si se resolviera sólo dentro de `guardarReglaComercio`, la regla guardaría 'Alimentación'
  // mientras `retroaplicarRegla` escribe 'Alimentacion' en el histórico: el pasado y el futuro
  // del mismo comercio partidos en dos categorías, que es el bug medido dado vuelta.
  it('resuelve el alias ortográfico y TODOS los consumidores reciben el mismo nombre (B30)', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'corregir_categoria', msg: 'mueve Berny a alimentacion',
      datos: { categoria_nueva: 'alimentacion', comercio: 'Berny' }, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(ctx.recategorizarTransaccion).toHaveBeenCalledWith('user-001', 'Berny', 'Alimentación', null);
    expect(ctx.guardarReglaComercio).toHaveBeenCalledWith('user-001', 'Starbucks', 'Alimentación', null);
    expect(ctx.retroaplicarRegla).toHaveBeenCalledWith('user-001', 'Starbucks', 'Alimentación', null);
    expect(ctx.asegurarCategoriaUsuario).toHaveBeenCalledWith('user-001', 'Alimentación');
    expect(res).toContain('Alimentación');
    expect(res).not.toContain('alimentacion');
  });

  // La otra mitad del hallazgo: 77 reglas de 13 usuarios llevan categorías libres legítimas.
  // Si esto se pone rojo, el fix está mandando esas categorías a 'Otros' — que es el bug que
  // B28 cerró, reintroducido por la puerta que B30 viene a tapar.
  it('deja intacta la categoría libre que el mapa canónico no resuelve', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'corregir_categoria', msg: 'mueve eso a Gastos Hormiga',
      datos: { categoria_nueva: 'Gastos Hormiga', comercio: 'Starbucks' }, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(ctx.recategorizarTransaccion).toHaveBeenCalledWith('user-001', 'Starbucks', 'Gastos Hormiga', null);
    expect(ctx.guardarReglaComercio).toHaveBeenCalledWith('user-001', 'Starbucks', 'Gastos Hormiga', null);
    expect(res).toContain('Gastos Hormiga');
  });

  // `normalizarDestinoRegla` recorta la categoría de la REGLA y nada recortaba la que va a
  // `transacciones`, así que "Ahorro " dejaba la fila CON el espacio y la regla SIN él: dos
  // categorías distintas para todo lo que agrupe por nombre. Hay cuatro nombres con espacio
  // final en las reglas de prod ('PAGOS PENDIENTES ', 'Ahorro ', 'Sueldo ', 'PAREJA ').
  it('recorta los espacios ANTES de repartir, para que la fila y la regla no diverjan', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb);
    await handler.handle({
      intencion: 'corregir_categoria', msg: 'mueve eso a Ahorro',
      datos: { categoria_nueva: 'Ahorro ', comercio: 'Starbucks' }, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(ctx.recategorizarTransaccion).toHaveBeenCalledWith('user-001', 'Starbucks', 'Ahorro', null);
    expect(ctx.guardarReglaComercio).toHaveBeenCalledWith('user-001', 'Starbucks', 'Ahorro', null);
    expect(ctx.retroaplicarRegla).toHaveBeenCalledWith('user-001', 'Starbucks', 'Ahorro', null);
  });
});

// ─── corregir_multiple ───────────────────────────────────────────────────────
// El tercer call-site de regla, y no tenía cobertura. Recorre un `for`, así que acá la
// resolución tiene que pasar por CADA corrección, no por la primera.

describe('corregir_multiple — resuelve la categoría de cada corrección (B30)', () => {
  it('cada corrección del lote llega resuelta a la fila, a la regla y a la retroaplicación', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb, {
      parsearCorreccionesMultiples: vi.fn().mockResolvedValue([
        { comercio: 'Berny', categoria_nueva: 'alimentacion' },
        { comercio: 'Uber', categoria_nueva: 'auto' },
        { comercio: 'Cliente X', categoria_nueva: 'Freelance' },
      ]),
    });
    const res = await handler.handle({
      intencion: 'corregir_multiple', msg: 'Berny es alimentacion, Uber es auto, Cliente X es Freelance',
      datos: {}, usuario: USUARIO, from: '+51999', ctx,
    });
    const catsCorregidas = ctx.corregirTransaccionEspecifica.mock.calls.map((c) => c[4]);
    // 'auto' es un colapso con pérdida decidido en B26 (→ Transporte) y 'Freelance' una
    // categoría libre legítima de las 77 medidas: una se resuelve, la otra no se toca.
    expect(catsCorregidas).toEqual(['Alimentación', 'Transporte', 'Freelance']);
    expect(ctx.retroaplicarRegla.mock.calls.map((c) => c[2])).toEqual(['Alimentación', 'Transporte', 'Freelance']);
    expect(ctx.guardarReglaComercio.mock.calls.map((c) => c[2])).toEqual(['Alimentación', 'Transporte', 'Freelance']);
    expect(res).toContain('Alimentación');
    expect(res).toContain('Transporte');
  });
});

// ─── duplicar_gasto ─────────────────────────────────────────────────────────

describe('duplicar_gasto', () => {
  it('duplica el ultimo gasto con descripcion_original=duplicado:ID', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'duplicar_gasto', msg: 'duplica el ultimo',
      datos: {}, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).toContain('Starbucks');
    expect(ctx.guardarTransaccion).toHaveBeenCalledOnce();
    const payload = ctx.guardarTransaccion.mock.calls[0][1];
    expect(payload.descripcion_original).toMatch(/^duplicado:/);
  });
});

// ─── editar_fecha ────────────────────────────────────────────────────────────

describe('editar_fecha', () => {
  it('corrige fecha al dia especificado', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'editar_fecha', msg: 'fue ayer',
      datos: { fecha_nueva: 'ayer' }, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).toContain('Starbucks');
    expect(res).toContain('2026-04-04');
  });

  it('rechaza si no hay fecha nueva', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'editar_fecha', msg: 'cambia la fecha',
      datos: {}, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).toContain('Dime la fecha correcta');
  });
});

// ─── editar_categoria_comercio (defensa anti-gasto-mal-clasificado) ───────────
// Un gasto verboso ("registro un gasto de diez soles en taxi") que el clasificador
// confunde con set_category_rule llega con un "comercio" que es en realidad una
// frase (con monto o >4 palabras). El handler NO debe crear una regla basura.

describe('editar_categoria_comercio — defensa contra gasto mal clasificado', () => {
  it('NO crea regla si el comercio trae un monto (dígitos) y guía al usuario', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'editar_categoria_comercio', msg: 'registra un gasto de diez soles en taxi',
      datos: { comercio: 'gasto de diez soles en taxi', categoria: 'Transporte', subcategoria: 'Taxi' },
      usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).not.toMatch(/Regla creada/i);
    expect(res).toMatch(/registrar un gasto/i);
    expect(ctx.guardarReglaComercio).not.toHaveBeenCalled();
    expect(ctx.retroaplicarRegla).not.toHaveBeenCalled();
  });

  it('NO crea regla si el "comercio" es una frase de más de 4 palabras', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'editar_categoria_comercio', msg: 'anota que gasté algo en el mercado del centro',
      datos: { comercio: 'gasto en el mercado del centro', categoria: 'Alimentacion' },
      usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).not.toMatch(/Regla creada/i);
    expect(res).toMatch(/registrar un gasto/i);
    expect(ctx.guardarReglaComercio).not.toHaveBeenCalled();
  });
});

// ─── editar_categoria_comercio — el destino EFECTIVO manda (B30) ──────────────
// Este era el único de los tres caminos de regla que no tocaba el árbol del usuario y que
// anunciaba "Regla creada" sin mirar si `guardarReglaComercio` la había guardado.

describe('editar_categoria_comercio — destino efectivo y árbol (B30)', () => {
  it('imprime, retroaplica y crea en el árbol el nombre con el que quedó la regla, no el que pidió el usuario', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb, {
      guardarReglaComercio: vi.fn().mockResolvedValue({ ok: true, destino: { categoria: 'Alimentación', subcategoria: 'Delivery' } }),
      retroaplicarRegla: vi.fn().mockResolvedValue(3),
    });
    const res = await handler.handle({
      intencion: 'editar_categoria_comercio', msg: 'todo lo de Rappi va en alimentacion',
      // OJO: `datos.subcategoria` es hoy INALCANZABLE por este intent — la tool
      // `manage_transaction.set_category_rule` sólo remapea `nueva_categoria → categoria`
      // (`handlers/neto-tools.js:961`) y no expone subcategoría. O sea que en producción la
      // rama del `> sub` no corre. Se ejercita igual porque `subRegla` ya estaba en el handler
      // desde antes y la rama tiene que ser correcta el día que la tool la exponga; lo que NO
      // hay que hacer es leer este test como evidencia de que el camino existe.
      datos: { comercio: 'Rappi', categoria: 'alimentacion', subcategoria: 'Delivery' },
      usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).toMatch(/Regla creada/i);
    expect(res).toContain('Alimentación > Delivery');
    expect(ctx.retroaplicarRegla).toHaveBeenCalledWith('user-001', 'Rappi', 'Alimentación', 'Delivery');
    expect(ctx.asegurarCategoriaUsuario).toHaveBeenCalledWith('user-001', 'Alimentación');
    expect(res).toContain('3 transacciones');
  });

  // Este camino era el ÚNICO que pasaba `datos.categoria` crudo, sin capitalizar ni recortar,
  // mientras los otros tres sí. Resultado: la misma categoría libre nacía con dos grafías según
  // por dónde la pidieras, que es el split que este trabajo existe para cerrar.
  it('normaliza la grafía igual que los otros caminos: capitaliza y recorta', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb);
    await handler.handle({
      intencion: 'editar_categoria_comercio', msg: 'todo lo de Wong va en gastos hormiga',
      datos: { comercio: 'Wong', categoria: '  gastos hormiga ' }, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(ctx.guardarReglaComercio).toHaveBeenCalledWith('user-001', 'Wong', 'Gastos hormiga', null);
  });

  // Antes decía "✅ Regla creada" igual. Pasa con "todo lo de X va en Otros" sin subcategoría
  // y, desde B30, con cualquier categoría que colapse a 'Otros' (`Viajes`, `Transferencia`).
  it('cuando la regla se descarta por política NO anuncia que la creó, y no retroaplica nada', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb, { guardarReglaComercio: vi.fn().mockResolvedValue({ ok: false, motivo: 'no-clasifica' }) });
    const res = await handler.handle({
      intencion: 'editar_categoria_comercio', msg: 'todo lo de Latam va en Viajes',
      datos: { comercio: 'Latam', categoria: 'Viajes' }, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).not.toMatch(/Regla creada/i);
    expect(res).toMatch(/no clasificar[íi]a nada/i);
    expect(ctx.retroaplicarRegla).not.toHaveBeenCalled();
    expect(ctx.asegurarCategoriaUsuario).not.toHaveBeenCalled();
  });

  // El consejo es el OPUESTO al de arriba: acá hay que reintentar lo mismo, no cambiar la
  // categoría. Con un solo mensaje para los dos motivos, un rechazo de la DB mandaba al usuario
  // a probar categorías distintas contra un problema que no era suyo.
  it('cuando la escritura FALLA le pide reintentar, no que cambie de categoría', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb, { guardarReglaComercio: vi.fn().mockResolvedValue({ ok: false, motivo: 'error' }) });
    const res = await handler.handle({
      intencion: 'editar_categoria_comercio', msg: 'todo lo de Rappi va en Delivery',
      datos: { comercio: 'Rappi', categoria: 'Delivery' }, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).not.toMatch(/Regla creada/i);
    expect(res).not.toMatch(/no clasificar[íi]a nada/i);
    expect(res).toMatch(/intentarlo/i);
    expect(ctx.retroaplicarRegla).not.toHaveBeenCalled();
  });

  it('un comercio de puros espacios culpa al comercio, no a la categoría', async () => {
    const sb = makeSupabaseMock({ transacciones: [TX_BASE] });
    const ctx = buildCtx(sb, { guardarReglaComercio: vi.fn().mockResolvedValue({ ok: false, motivo: 'sin-comercio' }) });
    const res = await handler.handle({
      intencion: 'editar_categoria_comercio', msg: 'todo lo de va en Delivery',
      datos: { comercio: '   ', categoria: 'Delivery' }, usuario: USUARIO, from: '+51999', ctx,
    });
    expect(res).toMatch(/de qu[ée] comercio/i);
    expect(res).not.toMatch(/no clasificar[íi]a nada/i);
  });
});
