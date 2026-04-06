import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const handler = require('../../handlers/intents/deudas');

// ─── Helpers ────────────────────────────────────────────────────────────────

const DEUDA_BASE = {
  id: 'deuda-001',
  usuario_id: 'user-001',
  tipo: 'debo',
  contraparte: 'Juan',
  monto_original: 200,
  monto_pendiente: 200,
  moneda: 'PEN',
  estado: 'activa',
  created_at: new Date().toISOString(),
};

function makeChain(data = [], error = null) {
  const c = {};
  for (const m of ['select','insert','update','delete','upsert',
                   'eq','ilike','gte','lte','is','neq','not','order','limit','single']) {
    c[m] = vi.fn().mockReturnValue(c);
  }
  c.then = (onFulfilled, onRejected) =>
    Promise.resolve({ data, error, count: Array.isArray(data) ? data.length : null })
      .then(onFulfilled, onRejected);
  c.catch = () => Promise.resolve({ data, error });
  return c;
}

function makeSupabaseMock(tableData = {}) {
  const chains = {};
  return {
    from: vi.fn((table) => {
      if (!chains[table]) chains[table] = makeChain(tableData[table] || []);
      return chains[table];
    }),
    _chains: chains,
  };
}

function buildCtx(supabaseMock, extras = {}) {
  return {
    supabase: supabaseMock,
    hoyPeru: vi.fn().mockReturnValue('2026-04-05'),
    registrarDeuda: vi.fn().mockResolvedValue(DEUDA_BASE),
    formatearResumenDeudas: vi.fn().mockResolvedValue('📊 Resumen de deudas'),
    abonarDeuda: vi.fn().mockResolvedValue({ deuda: { ...DEUDA_BASE, monto_pendiente: 150 }, completada: false }),
    marcarDeudaPagada: vi.fn().mockResolvedValue(DEUDA_BASE),
    consolidarDeudasPorContraparte: vi.fn().mockResolvedValue(null),
    saldarTodasDeudas: vi.fn().mockResolvedValue(1),
    ...extras,
  };
}

// ─── registrar_deuda ────────────────────────────────────────────────────────

describe('registrar_deuda', () => {
  it('registra deuda tipo debo correctamente', async () => {
    const sb = makeSupabaseMock();
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'registrar_deuda',
      msg: 'debo S/200 a Juan',
      datos: { tipo: 'debo', contraparte: 'Juan', monto: 200, moneda: 'PEN' },
      usuario: { id: 'user-001' }, from: '+51999', ctx,
    });
    expect(res).toContain('Juan');
    expect(res).toContain('200.00');
    expect(ctx.registrarDeuda).toHaveBeenCalled();
  });

  it('registra deuda tipo me_deben correctamente', async () => {
    const sb = makeSupabaseMock();
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'registrar_deuda',
      msg: 'Pedro me debe S/150',
      datos: { tipo: 'me_deben', contraparte: 'Pedro', monto: 150, moneda: 'PEN' },
      usuario: { id: 'user-001' }, from: '+51999', ctx,
    });
    expect(res).toContain('Pedro');
    expect(res).toContain('150.00');
    expect(res).toContain('te debe');
  });

  it('pide más datos si falta contraparte o monto', async () => {
    const sb = makeSupabaseMock();
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'registrar_deuda',
      msg: 'debo plata',
      datos: { tipo: 'debo' },
      usuario: { id: 'user-001' }, from: '+51999', ctx,
    });
    expect(res).toContain('no pillé bien');
    expect(ctx.registrarDeuda).not.toHaveBeenCalled();
  });

  it('detecta contraparte desde el mensaje con regex fallback', async () => {
    const sb = makeSupabaseMock();
    const ctx = buildCtx(sb);
    await handler.handle({
      intencion: 'registrar_deuda',
      msg: 'María me debe S/80 por la cena',
      datos: { tipo: 'me_deben', monto: 80, moneda: 'PEN' },  // contraparte vacía — debe extraerla del msg
      usuario: { id: 'user-001' }, from: '+51999', ctx,
    });
    // Verifica que registrarDeuda fue llamado con 'María' como contraparte
    expect(ctx.registrarDeuda).toHaveBeenCalledWith('user-001', 'me_deben', 'María', 80, 'PEN', null, null);
  });

  it('extrae fecha de vencimiento "en 3 dias"', async () => {
    const sb = makeSupabaseMock();
    const ctx = buildCtx(sb);
    await handler.handle({
      intencion: 'registrar_deuda',
      msg: 'le presté S/100 a Carlos, me paga en 3 días',
      datos: { tipo: 'debo', contraparte: 'Carlos', monto: 100, moneda: 'PEN' },
      usuario: { id: 'user-001' }, from: '+51999', ctx,
    });
    const [, , , , , , fechaVenc] = ctx.registrarDeuda.mock.calls[0];
    expect(fechaVenc).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ─── abonar_deuda ───────────────────────────────────────────────────────────

describe('abonar_deuda', () => {
  it('registra abono parcial y muestra porcentaje', async () => {
    const deudaActualizada = { ...DEUDA_BASE, monto_pendiente: 100 };
    const sb = makeSupabaseMock();
    const ctx = buildCtx(sb, {
      abonarDeuda: vi.fn().mockResolvedValue({ deuda: deudaActualizada, completada: false }),
    });
    const res = await handler.handle({
      intencion: 'abonar_deuda',
      msg: 'le pagué 100 a Juan',
      datos: { contraparte: 'Juan', monto: 100 },
      usuario: { id: 'user-001' }, from: '+51999', ctx,
    });
    expect(res).toContain('Juan');
    expect(res).toContain('%');
  });

  it('muestra símbolo correcto en overpayment para deuda PEN', async () => {
    const sb = makeSupabaseMock();
    const ctx = buildCtx(sb, {
      abonarDeuda: vi.fn().mockResolvedValue({ error: 'overpayment', monto_pendiente: 50, moneda: 'PEN' }),
    });
    const res = await handler.handle({
      intencion: 'abonar_deuda',
      msg: 'le pagué 300 a Juan',
      datos: { contraparte: 'Juan', monto: 300 },
      usuario: { id: 'user-001' }, from: '+51999', ctx,
    });
    expect(res).toContain('S/ 300.00');
    expect(res).toContain('S/ 50.00');
    expect(res).not.toContain('S/300');  // con espacio después del símbolo
  });

  it('muestra símbolo $ en overpayment para deuda USD', async () => {
    const sb = makeSupabaseMock();
    const ctx = buildCtx(sb, {
      abonarDeuda: vi.fn().mockResolvedValue({ error: 'overpayment', monto_pendiente: 20, moneda: 'USD' }),
    });
    const res = await handler.handle({
      intencion: 'abonar_deuda',
      msg: 'le pagué $100 a Mike',
      datos: { contraparte: 'Mike', monto: 100 },
      usuario: { id: 'user-001' }, from: '+51999', ctx,
    });
    expect(res).toContain('$');
    expect(res).not.toContain('S/');
  });

  it('completa deuda cuando el abono la liquida', async () => {
    const sb = makeSupabaseMock();
    const ctx = buildCtx(sb, {
      abonarDeuda: vi.fn().mockResolvedValue({ deuda: { ...DEUDA_BASE, contraparte: 'Juan' }, completada: true }),
    });
    const res = await handler.handle({
      intencion: 'abonar_deuda',
      msg: 'pagué todo a Juan',
      datos: { contraparte: 'Juan', monto: 200 },
      usuario: { id: 'user-001' }, from: '+51999', ctx,
    });
    expect(res).toContain('saldada');
    expect(res).toContain('🎉');
  });

  it('pide datos si falta contraparte o monto', async () => {
    const sb = makeSupabaseMock();
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'abonar_deuda',
      msg: 'pagué algo',
      datos: {},
      usuario: { id: 'user-001' }, from: '+51999', ctx,
    });
    expect(res).toContain('¿A quién y cuánto?');
    expect(ctx.abonarDeuda).not.toHaveBeenCalled();
  });
});

// ─── marcar_deuda_pagada ────────────────────────────────────────────────────

describe('marcar_deuda_pagada', () => {
  it('marca deuda como pagada con confirmación', async () => {
    const sb = makeSupabaseMock();
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'marcar_deuda_pagada',
      msg: 'ya le pagué a Juan',
      datos: { contraparte: 'Juan' },
      usuario: { id: 'user-001' }, from: '+51999', ctx,
    });
    expect(res).toContain('Juan');
    expect(res).toContain('saldada');
  });

  it('pide contraparte si no se especificó', async () => {
    const sb = makeSupabaseMock();
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'marcar_deuda_pagada',
      msg: 'pagué la deuda',
      datos: {},
      usuario: { id: 'user-001' }, from: '+51999', ctx,
    });
    expect(res).toContain('¿Con quién');
    expect(ctx.marcarDeudaPagada).not.toHaveBeenCalled();
  });

  it('informa si no encuentra deuda activa con esa contraparte', async () => {
    const sb = makeSupabaseMock();
    const ctx = buildCtx(sb, { marcarDeudaPagada: vi.fn().mockResolvedValue(null) });
    const res = await handler.handle({
      intencion: 'marcar_deuda_pagada',
      msg: 'ya pagué a Carlos',
      datos: { contraparte: 'Carlos' },
      usuario: { id: 'user-001' }, from: '+51999', ctx,
    });
    expect(res).toContain('No encontré deuda activa');
    expect(res).toContain('Carlos');
  });
});

// ─── ver_deudas ─────────────────────────────────────────────────────────────

describe('ver_deudas', () => {
  it('retorna resumen de deudas del usuario', async () => {
    const sb = makeSupabaseMock();
    const ctx = buildCtx(sb);
    const res = await handler.handle({
      intencion: 'ver_deudas',
      msg: 'mis deudas',
      datos: {},
      usuario: { id: 'user-001' }, from: '+51999', ctx,
    });
    expect(res).toContain('Resumen');
    expect(ctx.formatearResumenDeudas).toHaveBeenCalledWith('user-001');
  });
});
