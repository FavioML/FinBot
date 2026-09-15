import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

/**
 * El correo del fin de prueba sale SOLO a una dirección probada (15-sep-2026).
 *
 * `usuarios.email` no es una columna de direcciones probadas. Las filas nacidas en WhatsApp
 * pueden traer el correo que la persona DICTÓ en el alta viejo (paso 101, retirado el 31-jul en
 * `3c992bb`), y nadie lo verificó: un error de tipeo que cae en la bandeja real de otra persona
 * le manda a un desconocido los avisos de plata de alguien más. Medido el 15-sep: 22 filas
 * vivas sin cuenta web con correo, 1 probada por su propio Gmail.
 *
 * En `trial_d11`/`trial_d14` es peor que un aviso ajeno: para quien no tiene cuenta web, el
 * `link` del aviso es el de activación firmado (`linkPanelPro` → `/activar?t=`), y el botón
 * del correo lo lleva. Quien controle esa bandeja adopta la cuenta. Es el ítem 35(a) del
 * backlog de confiabilidad, y la misma razón por la que el upsell d28 ya gateaba su correo.
 *
 * La regla es `correoVerificado(usuario)` en `lib/email.js`: la dirección sale sólo si la fila
 * tiene cuenta web, que es la única prueba de posesión de la bandeja que queda en pie. Acá se
 * corre el cron de verdad con `notificarUsuario` mockeado y se afirma el `to` que recibe. Los
 * guards de forma son `notificaciones-duales` (todo `to:` pasa por el helper) y
 * `email-necesita-su-columna` (el select trae `supabase_auth_id`); los otros emisores tienen su
 * caso en su propio archivo (inactividad, resumen de deudas, soporte).
 *
 * Cada caso negativo lleva su control con cuenta web: un cron que no mandara nunca correo
 * pasaría los negativos en verde.
 */

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '../..',
);

/** Filas por tabla. Lo que no esté acá devuelve []. */
let tablas = {};
const notificar = vi.fn();

/** El doble FILTRA: con la cadena en no-op, el d11 y el muro leerían la misma población. */
function makeChain(table, op = 'select') {
  const filtros = [];
  let esConteo = false;
  const chain = {};
  for (const m of ['ilike', 'order', 'limit', 'or']) chain[m] = () => chain;
  const noEsNull = (f, col) => f[col] !== null && f[col] !== undefined;
  const rango = (cmp) => (col, val) => { filtros.push((f) => noEsNull(f, col) && cmp(f[col], val)); return chain; };
  chain.gt = rango((a, b) => a > b);
  chain.gte = rango((a, b) => a >= b);
  chain.lt = rango((a, b) => a < b);
  chain.lte = rango((a, b) => a <= b);
  chain.eq = (col, val) => { filtros.push((f) => f[col] === val); return chain; };
  chain.neq = (col, val) => { filtros.push((f) => noEsNull(f, col) && f[col] !== val); return chain; };
  chain.in = (col, arr) => { filtros.push((f) => arr.includes(f[col])); return chain; };
  chain.is = (col, val) => {
    if (val === null) filtros.push((f) => f[col] === null || f[col] === undefined);
    return chain;
  };
  chain.not = (col, op2, val) => {
    if (op2 === 'is' && val === null) filtros.push((f) => noEsNull(f, col));
    return chain;
  };
  chain.select = (_cols, opts) => { if (opts && opts.count) esConteo = true; return chain; };
  const resolver = () => {
    const filas = (tablas[table] || []).filter((f) => filtros.every((p) => p(f)));
    return esConteo ? { data: null, count: filas.length, error: null } : { data: filas, count: filas.length, error: null };
  };
  chain.single = () => Promise.resolve({ data: (resolver().data || [])[0] || null, error: null });
  chain.maybeSingle = chain.single;
  chain.then = (resolve) => resolve(resolver());
  void op;
  return chain;
}

const dbMock = {
  supabase: {
    from: vi.fn((t) => ({
      ...makeChain(t),
      insert: () => makeChain(t, 'insert'),
      update: () => makeChain(t, 'update'),
      delete: () => makeChain(t, 'delete'),
    })),
  },
};
const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };

for (const [rel, exports] of [
  ['lib/db.js', dbMock],
  ['lib/logger.js', logMock],
  ['lib/whatsapp.js', { enviarWhatsapp: vi.fn().mockResolvedValue({ ok: true }), META_ERR_FUERA_VENTANA: 131047 }],
  ['lib/notifications-db.js', { crearNotificacion: vi.fn().mockResolvedValue(true) }],
  ['lib/analytics.js', { capture: vi.fn() }],
  ['lib/admin-notify.js', { notificarAdmin: vi.fn() }],
  ['lib/pro-payment.js', { solicitarComprobante: vi.fn(), esperaComprobante: vi.fn() }],
  ['gmail.js', { revocarAccesoGmail: vi.fn().mockResolvedValue({ revocadas: 0 }) }],
  ['services/summaries.js', {
    generarResumenMensual: vi.fn(), generarResumenSemanal: vi.fn(), generarResumenDiario: vi.fn(),
  }],
  ['services/recommendations.js', { verificarAlertasProactivas: vi.fn() }],
  ['services/debts.js', {
    obtenerDeudasProximasVencer: vi.fn().mockResolvedValue([]),
    obtenerDeudasParaResumenSemanal: vi.fn().mockResolvedValue([]),
  }],
  ['services/spending-alerts.js', { generarAlertasFugas: vi.fn(), generarMensajeFugas: vi.fn(), guardarAlertas: vi.fn() }],
  ['services/neto-score.js', { upsertScore: vi.fn(), obtenerTendenciaScore: vi.fn(), scoreLabel: () => 'bien' }],
  ['services/metas.js', { calcularRitmoAhorro: () => ({ enRitmo: true, montoMensual: 100 }) }],
  ['services/shared-spaces.js', { obtenerBalanceEspacio: vi.fn(), ownerEsPro: vi.fn() }],
  ['services/subscriptions/index.js', { detectarSuscripciones: vi.fn() }],
  ['services/survey-triggers.js', { checkSurveyTriggers: vi.fn() }],
]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

// `notificarUsuario` se reemplaza preservando `CANALES`: el cron lo desestructura al cargar.
const notifyPath = require.resolve(path.join(projectRoot, 'lib/notify-user.js'));
const notifyReal = require(notifyPath);
require.cache[notifyPath] = {
  id: notifyPath, filename: notifyPath, loaded: true,
  exports: { ...notifyReal, notificarUsuario: notificar },
};

const checks = require('../../cron/checks');

vi.useFakeTimers({ toFake: ['Date'] });
afterAll(() => { vi.useRealTimers(); });

const enLima = (iso) => new Date(iso + '-05:00');
/** Martes 15-sep-2026, 10am Lima: el d11 es para quien vence el 18. */
const HOY_10AM = '2026-09-15T10:00:00';

const EN_PRUEBA = {
  trial_estado: 'activo', plan: 'premium', whatsapp: '51900000001', nombre: 'Ana Torres',
  recordatorios_activos: true, cuenta_borrada_at: null, is_test_user: false,
  estado_pago: null, premium_desde: null, premium_vence: null,
};
/** Con cuenta web: la dirección es la de su sesión de Google o del magic link. */
const conWeb = (id, extra) => ({ id, ...EN_PRUEBA, supabase_auth_id: 'auth-' + id, email: id + '@ejemplo.pe', ...extra });
/** Sin cuenta web: la dirección la dictó por WhatsApp y nadie la probó. */
const sinWeb = (id, extra) => ({ id, ...EN_PRUEBA, supabase_auth_id: null, email: id + '-dictado@ejemplo.pe', ...extra });

const llamadaDe = (id, tipo) => notificar.mock.calls.map((c) => c[0]).find((a) => a && a.usuarioId === id && a.tipo === tipo);
/** El destinatario del correo, o null si el canal no se declaró o se declaró sin dirección. */
const correoA = (a) => (a && a.email && a.email.to) || null;

beforeEach(() => {
  tablas = { notificaciones: [], transacciones: [] };
  vi.clearAllMocks();
  notificar.mockResolvedValue({ wa: { ok: true }, inApp: true, email: { ok: true } });
  vi.setSystemTime(enLima(HOY_10AM));
});

describe('checkTrialExpiry · el aviso d11 no manda correo a una dirección sin probar', () => {
  it('sin cuenta web, el aviso sale por WhatsApp y campana pero el correo no tiene destinatario', async () => {
    tablas.usuarios = [sinWeb('u-dictado', { trial_vence: '2026-09-18' })];

    await checks.checkTrialExpiry();

    const a = llamadaDe('u-dictado', 'trial_d11');
    expect(a, 'el d11 no salió: el caso no prueba nada').toBeTruthy();
    // El aviso sigue saliendo: lo que se corta es el CORREO, no el aviso.
    expect(a.canales).toBe('ambos');
    // Y el correo no: llevaría el link de activación a una bandeja que nadie probó.
    expect(correoA(a)).toBe(null);
  });

  it('con cuenta web, el correo sale a su dirección (control)', async () => {
    tablas.usuarios = [conWeb('u-web', { trial_vence: '2026-09-18' })];

    await checks.checkTrialExpiry();

    expect(correoA(llamadaDe('u-web', 'trial_d11'))).toBe('u-web@ejemplo.pe');
  });
});

describe('checkTrialExpiry · el aviso del muro tampoco', () => {
  /** Uso reciente: el correo del muro sólo se declara si anotó algo en 14 días. */
  const conUso = (id) => ({ id: 't-' + id, usuario_id: id, created_at: '2026-09-14T17:00:00' });

  it('sin cuenta web y con uso reciente, no hay correo', async () => {
    tablas.usuarios = [sinWeb('u-dictado', { trial_vence: '2026-09-10' })];
    tablas.transacciones = [conUso('u-dictado')];

    await checks.checkTrialExpiry();

    const a = llamadaDe('u-dictado', 'trial_vencido');
    expect(a, 'el aviso del muro no salió: el caso no prueba nada').toBeTruthy();
    expect(correoA(a)).toBe(null);
  });

  it('con cuenta web y uso reciente, el correo sale (control)', async () => {
    tablas.usuarios = [conWeb('u-web', { trial_vence: '2026-09-10' })];
    tablas.transacciones = [conUso('u-web')];

    await checks.checkTrialExpiry();

    expect(correoA(llamadaDe('u-web', 'trial_vencido'))).toBe('u-web@ejemplo.pe');
  });
});
