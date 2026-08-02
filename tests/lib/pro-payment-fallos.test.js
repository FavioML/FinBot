import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'path';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'), '../..');

// Regresion de lib/pro-payment.js: escrituras y avisos que dependian de una lectura
// que puede fallar sin lanzar. Ver docs/SESION-escrituras-sobre-lectura-fallida.md.
//
// Los tres que costaban plata:
//  - reclamarPagoPendiente devolvia null con el SELECT roto, y routes/admin.js respondia
//    { ok: true, already: true, "El pago ya estaba procesado" }: el usuario pagaba, el
//    admin veia exito y Pro no se activaba nunca.
//  - registrarPagoAprobado insertaba una fila aprobada nueva si no podia leer el pendiente
//    (`pagos` no tiene unique que lo frene): revenue inflado + pendiente huerfano.
//  - activarPro mandaba "¡Pago confirmado!" aunque el UPDATE del plan hubiera fallado.

let router;
let ops = [];
function makeChain(table, op) {
  const q = { table, op, payload: null, methods: [] };
  const chain = {};
  for (const m of ['eq', 'neq', 'gte', 'lte', 'lt', 'gt', 'ilike', 'limit', 'order', 'not', 'in']) {
    chain[m] = (...a) => { q.methods.push([m, ...a]); return chain; };
  }
  chain.select = (cols, opts) => { if (!q.op) q.op = 'select'; if (opts && opts.head) q.head = true; return chain; };
  chain.single = () => { q.single = true; return chain; };
  chain.maybeSingle = () => { q.single = true; return chain; };
  chain.then = (resolve, reject) => {
    ops.push(q);
    return Promise.resolve({ data: null, error: null, ...(router(q) || {}) }).then(resolve, reject);
  };
  return { chain, q };
}

const dbMock = {
  supabase: {
    from: (t) => ({
      select: (...a) => makeChain(t).chain.select(...a),
      insert: (p) => { const { chain, q } = makeChain(t, 'insert'); q.payload = p; return chain; },
      update: (p) => { const { chain, q } = makeChain(t, 'update'); q.payload = p; return chain; },
    }),
    storage: { from: () => ({ upload: async () => ({ error: null }) }) },
  },
};
const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };
const waMock = { enviarWhatsapp: vi.fn().mockResolvedValue(true) };
const notifyMock = { notificarAdmin: vi.fn().mockResolvedValue(true) };
const tgMock = { enviarTelegramFotoConBotones: vi.fn().mockResolvedValue({ ok: true }) };
const notifDbMock = { crearNotificacion: vi.fn().mockResolvedValue(true) };
const gmailMock = { generarUrlAutorizacion: () => 'https://oauth.example/x' };
const helpersMock = { guardarMensaje: vi.fn().mockResolvedValue(true) };
const refMock = {
  procesarConversionProReferido: vi.fn().mockResolvedValue(true),
  resumenReferidoParaAdmin: vi.fn().mockResolvedValue({}),
};

for (const [rel, exports] of [
  ['lib/db.js', dbMock], ['lib/logger.js', logMock], ['lib/whatsapp.js', waMock],
  ['lib/admin-notify.js', notifyMock], ['lib/telegram.js', tgMock],
  ['lib/notifications-db.js', notifDbMock], ['gmail.js', gmailMock],
  ['helpers/db-helpers.js', helpersMock], ['services/referrals.js', refMock],
]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const pro = require('../../lib/pro-payment');

const FALLO = { data: null, error: { message: 'read failure', code: '500' } };
const USUARIO = { id: 'u-1', whatsapp: '51999888777', nombre: 'Favio', plan: 'free', premium_vence: null, premium_desde: null };
const escrituras = (tabla) => ops.filter(o => (o.op === 'insert' || o.op === 'update') && (!tabla || o.table === tabla));

beforeEach(() => {
  ops = [];
  for (const m of [logMock.error, logMock.warn, waMock.enviarWhatsapp, notifyMock.notificarAdmin, tgMock.enviarTelegramFotoConBotones, notifDbMock.crearNotificacion, refMock.procesarConversionProReferido]) m.mockClear();
});

describe('reclamarPagoPendiente', () => {
  it('lanza cuando no puede leer el pendiente, en vez de decir "ya procesado"', async () => {
    router = (q) => (q.table === 'pagos' && q.op === 'select') ? FALLO : {};
    await expect(pro.reclamarPagoPendiente({ usuarioId: 'u-1' })).rejects.toThrow(/pago pendiente/i);
    expect(logMock.error).toHaveBeenCalled();
  });

  it('devuelve null sin lanzar cuando de verdad no hay pendiente', async () => {
    router = () => ({ data: null, error: null });
    await expect(pro.reclamarPagoPendiente({ usuarioId: 'u-1' })).resolves.toBeNull();
  });

  it('lanza cuando el claim falla por error', async () => {
    router = (q) => (q.table === 'pagos' && q.op === 'update') ? FALLO : { data: { id: 'pago-1' } };
    await expect(pro.reclamarPagoPendiente({ pagoId: 'pago-1' })).rejects.toThrow(/claim/i);
  });

  it('devuelve null sin lanzar cuando otro tap ya gano la fila (doble-tap sigue idempotente)', async () => {
    router = (q) => (q.table === 'pagos' && q.op === 'update') ? { data: null, error: null } : { data: { id: 'pago-1' } };
    await expect(pro.reclamarPagoPendiente({ pagoId: 'pago-1' })).resolves.toBeNull();
  });

  it('devuelve la fila reclamada en el camino feliz', async () => {
    router = (q) => (q.op === 'update') ? { data: { id: 'pago-1', usuario_id: 'u-1' } } : { data: { id: 'pago-1' } };
    await expect(pro.reclamarPagoPendiente({ usuarioId: 'u-1' })).resolves.toEqual({ id: 'pago-1', usuario_id: 'u-1' });
  });
});

describe('registrarPagoAprobado', () => {
  it('no inserta una fila aprobada cuando no puede leer el pendiente', async () => {
    router = (q) => (q.table === 'pagos' && q.op === 'select') ? FALLO : {};
    await pro.registrarPagoAprobado('u-1', { tipoPlan: 'mensual', premiumDesde: '2026-07-22', premiumVence: '2026-08-22' });
    expect(escrituras('pagos')).toHaveLength(0);
    expect(logMock.error).toHaveBeenCalled();
    expect(notifyMock.notificarAdmin).toHaveBeenCalled();
  });

  it('inserta cuando la lectura confirma que no hay pendiente', async () => {
    router = () => ({ data: null, error: null });
    await pro.registrarPagoAprobado('u-1', { tipoPlan: 'mensual', premiumDesde: '2026-07-22', premiumVence: '2026-08-22' });
    const ins = escrituras('pagos');
    expect(ins).toHaveLength(1);
    expect(ins[0].op).toBe('insert');
    expect(ins[0].payload.estado).toBe('aprobado');
  });

  it('marca aprobado el pendiente existente sin insertar', async () => {
    router = (q) => (q.op === 'select') ? { data: { id: 'pago-1' } } : {};
    await pro.registrarPagoAprobado('u-1', { tipoPlan: 'mensual', premiumDesde: '2026-07-22', premiumVence: '2026-08-22' });
    const w = escrituras('pagos');
    expect(w).toHaveLength(1);
    expect(w[0].op).toBe('update');
  });
});

describe('activarPro', () => {
  it('no avisa "Pago confirmado" si el UPDATE del plan falla', async () => {
    router = (q) => (q.table === 'usuarios' && q.op === 'update') ? FALLO : {};
    await expect(pro.activarPro({ usuario: USUARIO, tipoPlan: 'mensual', pagoId: 'pago-1' })).rejects.toThrow(/activar Pro/i);
    expect(waMock.enviarWhatsapp).not.toHaveBeenCalled();
    expect(notifDbMock.crearNotificacion).not.toHaveBeenCalled();
  });

  it('devuelve el pago a pendiente para que el admin pueda reintentar', async () => {
    router = (q) => (q.table === 'usuarios' && q.op === 'update') ? FALLO : {};
    await expect(pro.activarPro({ usuario: USUARIO, tipoPlan: 'mensual', pagoId: 'pago-1' })).rejects.toThrow();
    const rollback = escrituras('pagos').find(o => o.payload && o.payload.estado === 'pendiente');
    expect(rollback).toBeTruthy();
    expect(rollback.methods).toContainEqual(['eq', 'id', 'pago-1']);
  });

  it('avisa al admin si ni siquiera se pudo revertir el pago', async () => {
    router = () => FALLO;
    await expect(pro.activarPro({ usuario: USUARIO, tipoPlan: 'mensual', pagoId: 'pago-1' })).rejects.toThrow();
    expect(notifyMock.notificarAdmin).toHaveBeenCalled();
  });

  it('camino feliz: activa, avisa por WhatsApp y notifica in-app', async () => {
    router = () => ({ data: null, error: null });
    const { venceStr } = await pro.activarPro({ usuario: USUARIO, tipoPlan: 'mensual', pagoId: 'pago-1' });
    expect(venceStr).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(escrituras('usuarios')[0].payload.plan).toBe('premium');
    expect(waMock.enviarWhatsapp).toHaveBeenCalledTimes(1);
    expect(notifDbMock.crearNotificacion).toHaveBeenCalledTimes(1);
  });
});

// Regresion 2026-07-31: un usuario que eligio Pro durante el alta queda en onboarding_paso 2
// (espera del comprobante). Solo el comando /pago lo devolvia a 0, via flag opcional; el boton
// de Telegram, el panel admin y /activar no. Resultado real: pago aprobado el 2026-07-21,
// plan premium, y el usuario respondido con "elige tu plan / mandame la captura" ante cada
// mensaje durante 10 dias, porque esperaComprobante() mira onboarding_paso === 2.
describe('activarPro: desatasco del onboarding', () => {
  const enPaso2 = { ...USUARIO, onboarding_paso: 2, onboarding_completado: false };

  it('saca del paso 2 y marca el alta completa (sin flag, por cualquier ruta de aprobacion)', async () => {
    router = () => ({ data: null, error: null });
    await pro.activarPro({ usuario: enPaso2, tipoPlan: 'mensual', pagoId: 'pago-1' });
    const payload = escrituras('usuarios')[0].payload;
    expect(payload.onboarding_paso).toBe(0);
    expect(payload.onboarding_completado).toBe(true);
  });

  it('el estado resultante ya no dispara esperaComprobante (el usuario puede volver a usar Neto)', async () => {
    router = () => ({ data: null, error: null });
    await pro.activarPro({ usuario: enPaso2, tipoPlan: 'mensual', pagoId: 'pago-1' });
    const payload = escrituras('usuarios')[0].payload;
    expect(pro.esperaComprobante({ ...enPaso2, ...payload })).toBe(false);
  });

  it('marcar el alta completa evita que el trigger de usuario nuevo lo mande de vuelta al paso 100', async () => {
    router = () => ({ data: null, error: null });
    await pro.activarPro({ usuario: enPaso2, tipoPlan: 'mensual', pagoId: 'pago-1' });
    const final = { ...enPaso2, ...escrituras('usuarios')[0].payload };
    // Replica del trigger en handlers/onboarding.js: sin token de Gmail, onboarding_completado
    // en false manda al usuario a "¿como te llamas?" aunque ya haya dado nombre y correo.
    expect(!final.gmail_access_token && !final.onboarding_completado).toBe(false);
  });

  it('no toca el onboarding de un usuario que ya lo termino (renovacion no pisa estado)', async () => {
    router = () => ({ data: null, error: null });
    await pro.activarPro({ usuario: { ...USUARIO, onboarding_paso: 0, onboarding_completado: true }, tipoPlan: 'mensual', pagoId: 'pago-1' });
    const payload = escrituras('usuarios')[0].payload;
    expect(payload).not.toHaveProperty('onboarding_paso');
    expect(payload).not.toHaveProperty('onboarding_completado');
  });

  it('no arrastra al usuario parado en otro paso del alta (ej. 101, dando su correo)', async () => {
    router = () => ({ data: null, error: null });
    await pro.activarPro({ usuario: { ...USUARIO, onboarding_paso: 101, onboarding_completado: false }, tipoPlan: 'mensual', pagoId: 'pago-1' });
    const payload = escrituras('usuarios')[0].payload;
    expect(payload).not.toHaveProperty('onboarding_paso');
    expect(payload).not.toHaveProperty('onboarding_completado');
  });
});

// Regresion 2026-08-02: el camino COMP (Pro regalado, sin pago). Lo usan POST /admin/activar
// y el comando /activar de WhatsApp, los dos con esConversionPagada:false. La ruta HTTP escribia
// su propio UPDATE de 4 columnas en vez de llamar activarPro, y de esa divergencia salian los
// tres agujeros de abajo: el trial sin sellar (checkTrialExpiry bajaba el comp a free al dia 15),
// el periodo contado siempre desde hoy (un comp ACORTABA una suscripcion vigente) y el
// onboarding_paso 2 sin desatascar.
describe('activarPro: comp (esConversionPagada false)', () => {
  const { PRO_PRECIOS } = require('../../lib/config');
  const comp = (usuario) => pro.activarPro({
    usuario, tipoPlan: 'mensual', aprobadoPor: 'admin:comp',
    enviarOAuth: false, esConversionPagada: false,
  });

  it('sella el trial como convertido: el cron de vencimiento ya no lo baja a free', async () => {
    router = () => ({ data: null, error: null });
    await comp({ ...USUARIO, trial_estado: 'activo', trial_vence: '2099-03-10' });
    // checkTrialExpiry (cron/checks.js) baja a `plan:'free'` todo lo que siga en 'activo'.
    expect(escrituras('usuarios')[0].payload.trial_estado).toBe('convertido');
  });

  it('escribe el set completo de columnas que el UPDATE a mano se saltaba', async () => {
    router = () => ({ data: null, error: null });
    await comp(USUARIO);
    const payload = escrituras('usuarios')[0].payload;
    for (const col of ['plan', 'estado_pago', 'tipo_plan', 'fecha_pago', 'fecha_vencimiento',
      'premium_desde', 'premium_vence', 'pago_pendiente', 'esperando_comprobante', 'trial_estado']) {
      expect(payload, 'falta ' + col).toHaveProperty(col);
    }
    expect(payload.estado_pago).toBe('pagado');
    expect(payload.tipo_plan).toBe('mensual');
  });

  it('no acorta una suscripcion vigente: apila sobre premium_vence', async () => {
    router = () => ({ data: null, error: null });
    const { venceStr } = await comp({ ...USUARIO, premium_vence: '2099-01-15' });
    expect(venceStr > '2099-01-15', 'el comp acorto el vencimiento').toBe(true);
    expect(venceStr).toMatch(/^2099-02-/);
  });

  it('durante el trial apila sobre trial_vence (no cobra los dias que faltaban)', async () => {
    router = () => ({ data: null, error: null });
    const { venceStr } = await comp({ ...USUARIO, trial_estado: 'activo', trial_vence: '2099-03-10' });
    expect(venceStr).toMatch(/^2099-04-/);
  });

  it('no premia al referrer: un comp no puede encadenar meses gratis', async () => {
    router = () => ({ data: null, error: null });
    await comp(USUARIO);
    expect(refMock.procesarConversionProReferido).not.toHaveBeenCalled();
  });

  it('registra el pago en S/0: un comp no es caja del mes', async () => {
    router = () => ({ data: null, error: null });   // sin pendiente que reclamar -> inserta
    await comp(USUARIO);
    const ins = escrituras('pagos');
    expect(ins).toHaveLength(1);
    expect(ins[0].payload.monto).toBe(0);
    expect(ins[0].payload.aprobado_por).toBe('admin:comp');
  });

  it('el aviso al usuario sale igual por los dos canales (no se perdio al sacarlo de la ruta)', async () => {
    router = () => ({ data: null, error: null });
    await comp(USUARIO);
    expect(waMock.enviarWhatsapp).toHaveBeenCalledTimes(1);
    expect(notifDbMock.crearNotificacion).toHaveBeenCalledTimes(1);
  });

  it('no le confirma un cobro que no existio: sin "Pago confirmado" y sin precio', async () => {
    router = () => ({ data: null, error: null });
    const { mensaje } = await comp(USUARIO);
    expect(mensaje).not.toMatch(/pago confirmado/i);
    expect(mensaje, 'el comp no menciona precio').not.toMatch(/S\/\s*\d/);
    expect(mensaje).toMatch(/sin costo/i);
  });

  it('contraprueba: la conversion PAGADA si premia y se registra al precio de lista', async () => {
    router = () => ({ data: null, error: null });
    const { mensaje } = await pro.activarPro({ usuario: USUARIO, tipoPlan: 'mensual', aprobadoPor: 'admin:webapp', esConversionPagada: true });
    expect(refMock.procesarConversionProReferido).toHaveBeenCalledTimes(1);
    expect(escrituras('pagos')[0].payload.monto).toBe(PRO_PRECIOS.mensual);
    expect(mensaje).toMatch(/pago confirmado/i);
    expect(mensaje).toContain('S/' + PRO_PRECIOS.mensual);
  });
});

describe('registrarSolicitudPro', () => {
  it('no ofrece botones de Telegram cuando el insert del pago fallo (callback_data seria null)', async () => {
    process.env.TELEGRAM_ADMIN_CHAT_ID = '123';
    router = (q) => (q.table === 'pagos' && q.op === 'insert') ? FALLO : {};
    const { pagoId } = await pro.registrarSolicitudPro({ usuario: USUARIO, monto: 10, montoDetectado: 10, tipoPlan: 'mensual', comprobanteBuffer: Buffer.from('x'), mimeType: 'image/jpeg', origen: 'whatsapp' });
    expect(pagoId).toBeNull();
    expect(tgMock.enviarTelegramFotoConBotones).not.toHaveBeenCalled();
    expect(notifyMock.notificarAdmin).toHaveBeenCalled();
    expect(notifyMock.notificarAdmin.mock.calls[0][0]).toContain('/pago ');
  });

  it('ofrece los botones cuando el insert dio un pagoId', async () => {
    process.env.TELEGRAM_ADMIN_CHAT_ID = '123';
    router = (q) => (q.table === 'pagos' && q.op === 'insert') ? { data: { id: 'pago-9' } } : {};
    const { pagoId } = await pro.registrarSolicitudPro({ usuario: USUARIO, monto: 10, montoDetectado: 10, tipoPlan: 'mensual', comprobanteBuffer: Buffer.from('x'), mimeType: 'image/jpeg', origen: 'whatsapp' });
    expect(pagoId).toBe('pago-9');
    expect(tgMock.enviarTelegramFotoConBotones).toHaveBeenCalledTimes(1);
    expect(notifyMock.notificarAdmin).not.toHaveBeenCalled();
  });
});

describe('solicitarComprobante', () => {
  it('loguea cuando el flag no se pudo setear (la proxima captura seria un gasto)', async () => {
    router = () => FALLO;
    await pro.solicitarComprobante('u-1');
    expect(logMock.error).toHaveBeenCalled();
  });
});

// Guard estatico, hermano del de tests/notificaciones-duales.test.js.
//
// El modo de falla que previene es el que acaba de costar caro: una ruta que "activa Pro" con
// su propio UPDATE. Empieza identica a activarPro y se queda atras en cada columna que se
// agrega despues (trial_estado, esperando_comprobante, el desatasco del onboarding_paso 2) y en
// cada regla que se agrega despues (no acortar una suscripcion vigente). No falla en produccion:
// el usuario queda premium, el admin ve exito, y el agujero aparece semanas mas tarde en el cron
// de vencimiento o en las metricas de MRR.
//
// Los tres escritores declarados NO son tres formas de activar Pro: son tres eventos distintos.
// Solo el primero es una activacion por aprobacion.
describe('la activacion de Pro tiene un solo dueno', () => {
  const ESCRITORES = new Map([
    ['lib/pro-payment.js', 'activarPro: la activacion por aprobacion (fuente unica de los 4 canales)'],
    ['lib/trial.js', 'el alta del trial de 14 dias, que no pasa por ninguna aprobacion'],
    ['services/referrals.js', 'el premio al referrer, que NO re-entra a activarPro a proposito (anti-cadena)'],
  ]);
  const ACTIVA_PLAN = /plan:\s*['"]premium['"]/;
  const DIRS = ['routes', 'handlers', 'services', 'lib', 'cron'];

  const jsDe = (dir) => readdirSync(dir).flatMap((n) => {
    const full = path.join(dir, n);
    return statSync(full).isDirectory() ? jsDe(full) : (full.endsWith('.js') ? [full] : []);
  });
  const FUENTES = DIRS
    .map((d) => path.join(projectRoot, d))
    .filter(existsSync)
    .flatMap(jsDe)
    .map((full) => ({ rel: path.relative(projectRoot, full).replace(/\\/g, '/'), src: readFileSync(full, 'utf-8') }));

  it('el barrido ve el backend y ve la escritura real (si no, lo de abajo miente)', () => {
    expect(FUENTES.length).toBeGreaterThan(40);
    const conEscritura = FUENTES.filter((f) => ACTIVA_PLAN.test(f.src)).map((f) => f.rel);
    expect(conEscritura).toContain('lib/pro-payment.js');
  });

  it('nadie fuera de los declarados escribe plan premium a mano', () => {
    const intrusos = FUENTES
      .filter((f) => ACTIVA_PLAN.test(f.src))
      .map((f) => f.rel)
      .filter((rel) => !ESCRITORES.has(rel));
    // Si esto se pone rojo: no subas el numero, llama a activarPro. POST /admin/activar y el
    // comando /activar de WhatsApp son comps y pasan `esConversionPagada: false`.
    expect(intrusos).toEqual([]);
  });

  it('los comps del panel y de WhatsApp entran por activarPro', () => {
    for (const rel of ['routes/admin.js', 'handlers/admin-commands.js']) {
      const f = FUENTES.find((x) => x.rel === rel);
      expect(f, rel + ' no entro al barrido').toBeDefined();
      expect(f.src, rel + ' dejo de delegar en activarPro').toMatch(/activarPro\(/);
      expect(f.src, rel + ' no declara esConversionPagada en el comp').toMatch(/esConversionPagada:\s*false/);
    }
  });
});
