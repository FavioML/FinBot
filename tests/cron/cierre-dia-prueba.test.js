import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

/**
 * `checkCierreDiaPrueba`: a quién le sale el cierre del día a las 9pm (plan día 0→1, paso 2).
 *
 * La población son cinco filtros juntos, y cada uno tiene su fixture fuera, con un control que
 * entra por la misma puerta. El que más importa es "escribió HOY por WhatsApp": es lo único que
 * garantiza la ventana de 24h de Meta sin plantillas pagas. Un cierre fuera de ventana muere en
 * 131047 y no llega a nadie.
 *
 * El mock filtra de verdad (`eq`, `is`, `gte`, conteos): con la cadena en no-op, un cron que
 * mandara a todos pasaría. Y el fixture con `is_test_user: null` es a propósito — en SQL
 * `.neq('is_test_user', true)` deja fuera esa fila, y es un usuario real.
 */

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'), '../..');

let tablas = {};
let errores = {};
let lecturas = [];

function makeChain(tabla) {
  const filtros = [];
  let conteo = false;
  let tope = null;
  const c = {};
  c.select = (_cols, opts) => { if (opts && opts.head) conteo = true; return c; };
  c.eq = (col, v) => { filtros.push((f) => f[col] === v); return c; };
  c.is = (col, v) => { filtros.push((f) => (v === null ? f[col] == null : f[col] === v)); return c; };
  c.gte = (col, v) => { filtros.push((f) => f[col] != null && f[col] >= v); return c; };
  c.limit = (n) => { tope = n; return c; };
  const resolver = () => {
    lecturas.push(tabla);
    if (errores[tabla]) return { data: null, count: null, error: { message: errores[tabla] } };
    let rows = (tablas[tabla] || []).filter((f) => filtros.every((p) => p(f)));
    if (conteo) return { data: null, count: rows.length, error: null };
    if (tope != null) rows = rows.slice(0, tope);
    return { data: rows, error: null };
  };
  c.then = (ok, ko) => Promise.resolve(resolver()).then(ok, ko);
  return c;
}

const dbMock = { supabase: { from: vi.fn((t) => makeChain(t)) } };
const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };
logMock.child = () => logMock;
const notificar = vi.fn().mockResolvedValue({ wa: { ok: true }, inApp: true, email: { ok: false, skipped: 'no_declarado' } });
const notifyMock = { notificarUsuario: notificar, CANALES: { AMBOS: 'ambos', SOLO_WHATSAPP: 'solo_whatsapp', SOLO_IN_APP: 'solo_in_app' } };
const generarResumenDiario = vi.fn();
const summariesMock = {
  generarResumenSemanal: vi.fn(), generarResumenMensual: vi.fn(), generarResumenDiario,
};
const analyticsMock = { capture: vi.fn() };

for (const [rel, exports] of [
  ['lib/db.js', dbMock],
  ['lib/logger.js', logMock],
  ['lib/notify-user.js', notifyMock],
  ['services/summaries.js', summariesMock],
  ['lib/analytics.js', analyticsMock],
]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

process.env.ACTIVATION_TOKEN_SECRET = 'secreto-de-test';
const checks = require('../../cron/checks');

vi.useFakeTimers({ toFake: ['Date'] });
afterAll(() => { vi.useRealTimers(); });

// 14-sep-2026. 21:05 Lima = 02:05 UTC del 15.
const LAS_21_05 = '2026-09-15T02:05:00Z';
const HOY_TURNO = '2026-09-14T20:00:00.000Z';   // 15:00 Lima del 14
const AYER_TURNO = '2026-09-14T04:00:00.000Z';  // 23:00 Lima del 13

const prueba = (id, trial_inicio, extra = {}) => ({
  id, whatsapp: '5190000' + id.replace(/\D/g, '').padStart(4, '0'), nombre: 'Persona ' + id,
  plan: 'premium', trial_estado: 'activo', trial_inicio,
  supabase_auth_id: 'auth-' + id, recordatorios_activos: true, manos_libres: false,
  activacion_nudge_at: null, is_test_user: false, cuenta_borrada_at: null, ...extra,
});

function sembrar() {
  const usuarios = [
    prueba('a0', '2026-09-14T14:00:00.000Z', { supabase_auth_id: null, is_test_user: null }), // día 0, sin web, marca NULL
    prueba('b1', '2026-09-13T15:00:00.000Z'),                                                 // día 1
    prueba('c2', '2026-09-12T15:00:00.000Z'),                                                 // día 2
    prueba('e2', '2026-09-12T05:30:00.000Z'),                                                 // día 2, 00:30 Lima del 12
    prueba('d3', '2026-09-12T04:30:00.000Z'),                                                 // día 3, 23:30 Lima del 11
    prueba('d4', '2026-09-11T15:00:00.000Z'),                                                 // día 3
    prueba('f0', '2026-09-14T14:00:00.000Z'),                                                 // escribió AYER, no hoy
    prueba('o0', '2026-09-14T14:00:00.000Z'),                                                 // anotó desde la web: sin turno
    prueba('g1', '2026-09-13T15:00:00.000Z', { manos_libres: true }),
    prueba('h1', '2026-09-13T15:00:00.000Z', { recordatorios_activos: false }),
    prueba('i1', '2026-09-13T15:00:00.000Z', { cuenta_borrada_at: '2026-09-14T10:00:00Z' }),
    prueba('j1', '2026-09-13T15:00:00.000Z', { is_test_user: true }),
    prueba('l1', '2026-09-13T15:00:00.000Z', { plan: 'free', trial_estado: 'vencido' }),
    prueba('m1', '2026-09-13T15:00:00.000Z', { trial_estado: 'convertido' }),
    prueba('n1', '2026-09-13T15:00:00.000Z', { whatsapp: null, supabase_auth_id: null }),    // solo BSUID
    // El empujón de activación del día 2 salió HOY a las 20:00 Lima, que en UTC ya es el 15: una
    // comparación por fecha UTC lo leería como "no fue hoy" y repetiría el link.
    prueba('p1', '2026-09-13T15:00:00.000Z', { supabase_auth_id: null, activacion_nudge_at: '2026-09-15T01:00:00.000Z' }),
    // Y el espejo: salió AYER a las 23:00 Lima, que en UTC ya es el 14. El link de hoy SÍ va.
    prueba('p2', '2026-09-13T15:00:00.000Z', { supabase_auth_id: null, activacion_nudge_at: '2026-09-14T04:00:00.000Z' }),
    prueba('q1', '2026-09-13T15:00:00.000Z'),                                                 // escribió, sin gastos de hoy
  ];
  const turno = (usuario_id, created_at = HOY_TURNO, rol = 'usuario') => ({ usuario_id, rol, created_at });
  tablas = {
    usuarios,
    conversaciones: [
      ...['a0', 'b1', 'c2', 'e2', 'd3', 'd4', 'g1', 'h1', 'i1', 'j1', 'l1', 'm1', 'n1', 'p1', 'p2', 'q1'].map((id) => turno(id)),
      turno('f0', AYER_TURNO),
      turno('o0', HOY_TURNO, 'neto'), // una respuesta de Neto no es un mensaje entrante
    ],
    notificaciones: [],
  };
}

const notificados = () => notificar.mock.calls.map((c) => c[0].usuarioId).sort();
const llamadaDe = (id) => notificar.mock.calls.map((c) => c[0]).find((a) => a.usuarioId === id);

beforeEach(() => {
  sembrar();
  errores = {};
  lecturas = [];
  notificar.mockClear();
  generarResumenDiario.mockReset();
  generarResumenDiario.mockImplementation(async (u) => (u.id === 'q1' ? null : '🌙 *Tu cierre de hoy*\n\nRESUMEN ' + u.id));
  logMock.error.mockClear();
  logMock.info.mockClear();
  analyticsMock.capture.mockClear();
  delete process.env.CIERRE_DIA_PRUEBA;
  vi.setSystemTime(new Date(LAS_21_05));
});

describe('a quién le sale el cierre', () => {
  it('a los días 0-2 en prueba que escribieron hoy, y a nadie más', async () => {
    await checks.checkCierreDiaPrueba();
    expect(notificados()).toEqual(['a0', 'b1', 'c2', 'e2', 'n1', 'p1', 'p2']);
  });

  it('el día 3 queda fuera aunque su primer gasto haya sido a las 23:30', async () => {
    await checks.checkCierreDiaPrueba();
    expect(notificados()).not.toContain('d3');
    expect(notificados()).not.toContain('d4');
  });

  it('quien escribió ayer y no hoy queda fuera; su control del mismo día 0 entra', async () => {
    await checks.checkCierreDiaPrueba();
    expect(notificados()).not.toContain('f0');
    expect(notificados()).toContain('a0');
  });

  it('una transacción desde la web o una respuesta de Neto no abren la ventana', async () => {
    await checks.checkCierreDiaPrueba();
    expect(notificados()).not.toContain('o0');
  });

  it('is_test_user en NULL es un usuario real y entra', async () => {
    await checks.checkCierreDiaPrueba();
    expect(notificados()).toContain('a0');
    expect(notificados()).not.toContain('j1');
  });

  it('sin número (solo BSUID) no se corta: pasa whatsapp null y el chokepoint resuelve', async () => {
    await checks.checkCierreDiaPrueba();
    expect(llamadaDe('n1').whatsapp).toBeNull();
  });

  it('sin gastos con fecha de hoy no sale nada', async () => {
    await checks.checkCierreDiaPrueba();
    expect(notificados()).not.toContain('q1');
    expect(generarResumenDiario).toHaveBeenCalledWith(expect.objectContaining({ id: 'q1' }), { cierre: true });
  });
});

describe('cómo sale', () => {
  it('por los dos canales, con claim y el tipo del cierre', async () => {
    await checks.checkCierreDiaPrueba();
    for (const a of notificar.mock.calls.map((c) => c[0])) {
      expect(a.canales).toBe('ambos');
      expect(a.claimInApp).toBe(true);
      expect(a.tipo).toBe('cierre_dia_prueba');
      expect(a.titulo).toBe('El cierre de tu día');
    }
  });

  it('solo el día 2 ofrece seguir, con /manoslibres', async () => {
    await checks.checkCierreDiaPrueba();
    for (const id of ['c2', 'e2']) {
      expect(llamadaDe(id).mensaje).toContain('¿Quieres que siga cada noche a las 9? Escribe */manoslibres*.');
    }
    for (const id of ['a0', 'b1', 'n1', 'p1']) {
      expect(llamadaDe(id).mensaje).not.toContain('/manoslibres');
    }
  });

  it('sin cuenta web lleva el link de activación; con cuenta web, no', async () => {
    await checks.checkCierreDiaPrueba();
    expect(llamadaDe('a0').mensaje).toContain('/activar?t=');
    expect(llamadaDe('n1').mensaje).toContain('/activar?t=');
    expect(llamadaDe('b1').mensaje).not.toContain('/activar?t=');
  });

  it('si el empujón de activación salió HOY (fecha Lima), el cierre no repite el link', async () => {
    await checks.checkCierreDiaPrueba();
    expect(llamadaDe('p1').mensaje).not.toContain('/activar?t=');
  });

  it('si salió AYER a las 23h Lima (ya es hoy en UTC), el link de hoy sí va', async () => {
    await checks.checkCierreDiaPrueba();
    expect(llamadaDe('p2').mensaje).toContain('/activar?t=');
  });
});

describe('cuándo no sale', () => {
  it.each([
    ['20:59', '2026-09-15T01:59:00Z'],
    ['21:15', '2026-09-15T02:15:00Z'],
    ['09:05', '2026-09-14T14:05:00Z'],
  ])('fuera del gate (%s Lima) no lee nada', async (_h, cuando) => {
    vi.setSystemTime(new Date(cuando));
    await checks.checkCierreDiaPrueba();
    expect(lecturas).toEqual([]);
    expect(notificar).not.toHaveBeenCalled();
  });

  it('con el freno puesto no lee ni manda', async () => {
    process.env.CIERRE_DIA_PRUEBA = 'off';
    await checks.checkCierreDiaPrueba();
    expect(lecturas).toEqual([]);
    expect(notificar).not.toHaveBeenCalled();
  });

  it('dedup: quien ya tiene su cierre de hoy no recibe otro; los demás sí', async () => {
    tablas.notificaciones = [{ usuario_id: 'b1', titulo: 'El cierre de tu día', fecha: '2026-09-15T02:00:10.000Z' }];
    await checks.checkCierreDiaPrueba();
    expect(notificados()).not.toContain('b1');
    expect(notificados()).toContain('c2');
  });

  it('control del dedup: un cierre de AYER no bloquea el de hoy', async () => {
    tablas.notificaciones = [{ usuario_id: 'b1', titulo: 'El cierre de tu día', fecha: '2026-09-14T02:00:10.000Z' }];
    await checks.checkCierreDiaPrueba();
    expect(notificados()).toContain('b1');
  });

  it('si el dedup no se puede leer, no manda (falla cerrado) y lo deja dicho', async () => {
    errores.notificaciones = 'boom-dedup';
    await checks.checkCierreDiaPrueba();
    expect(notificar).not.toHaveBeenCalled();
    expect(JSON.stringify(logMock.error.mock.calls)).toContain('boom-dedup');
  });

  it('si no se puede saber quién escribió hoy, no manda y lo deja dicho', async () => {
    errores.conversaciones = 'boom-turnos';
    await checks.checkCierreDiaPrueba();
    expect(notificar).not.toHaveBeenCalled();
    expect(JSON.stringify(logMock.error.mock.calls)).toContain('boom-turnos');
  });

  it('un resumen que revienta para uno no le quita el cierre a los demás', async () => {
    generarResumenDiario.mockImplementation(async (u) => { if (u.id === 'b1') throw new Error('boom-b1'); return 'RESUMEN ' + u.id; });
    await checks.checkCierreDiaPrueba();
    expect(notificados()).not.toContain('b1');
    expect(notificados()).toContain('c2');
    const conUsuario = logMock.error.mock.calls.filter((c) => c[0].tag === 'CIERRE_DIA_PRUEBA' && c[0].usuarioId === 'b1');
    expect(conUsuario.length).toBe(1);
  });
});

describe('seleccionarCierreDiaPrueba es la misma que usa el cron (la corre el dry-run)', () => {
  it('devuelve a los mismos, con su día', async () => {
    const sel = await checks.seleccionarCierreDiaPrueba(new Date(LAS_21_05));
    const porId = Object.fromEntries(sel.map((s) => [s.usuario.id, s.dia]));
    expect(porId).toEqual({ a0: 0, b1: 1, c2: 2, e2: 2, n1: 1, p1: 1, p2: 1, q1: 1 });
  });
});

/**
 * Un cron exportado que no está en `TAREAS` no corre nunca, y nada lo dice: la revisión
 * adversarial le quitó la fila del cierre a `cron/schedule.js` y la suite entera siguió verde,
 * mientras la respuesta al primer gasto seguía prometiendo el cierre de la noche.
 */
describe('todo cron exportado está agendado', () => {
  it('cada check* que exporta cron/checks.js tiene su fila en TAREAS', () => {
    const { TAREAS } = require('../../cron/schedule');
    const agendados = new Set(TAREAS.map((t) => t.nombre));
    const exportados = Object.keys(checks).filter((k) => /^check[A-Z]/.test(k) && typeof checks[k] === 'function');
    expect(exportados.length, 'antivacuidad: no encontré los crons exportados').toBeGreaterThan(15);
    expect(exportados).toContain('checkCierreDiaPrueba');
    expect(exportados.filter((n) => !agendados.has(n))).toEqual([]);
  });

  // El primer gasto PROMETE este cierre. Sin `alBoot`, un redeploy a las 21:03 deja el primer
  // tick del proceso nuevo después de las 21:15 y la noche se pierde para todos.
  it('el cierre corre también al levantar el proceso (alBoot)', () => {
    const { TAREAS } = require('../../cron/schedule');
    const fila = TAREAS.find((t) => t.nombre === 'checkCierreDiaPrueba');
    expect(fila).toBeTruthy();
    expect(fila.alBoot).toBe(true);
  });
});
