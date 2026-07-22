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
    guardarReglaComercio: vi.fn().mockResolvedValue(null),
    retroaplicarRegla: vi.fn().mockResolvedValue(0),
    corregirTransaccionEspecifica: vi.fn().mockResolvedValue({ ok: true, comercio: 'Starbucks', monto: 45.50, moneda: 'PEN' }),
    guardarTransaccion: vi.fn().mockResolvedValue({ id: 'tx-002', ...TX_BASE }),
    obtenerTipoCambio: vi.fn().mockResolvedValue({ venta: 3.75 }),
    verificarAlertaPresupuesto: vi.fn().mockResolvedValue(null),
    crearCategoriaLibreUsuario: vi.fn(),
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
