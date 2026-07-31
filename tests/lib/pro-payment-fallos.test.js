import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
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

for (const [rel, exports] of [
  ['lib/db.js', dbMock], ['lib/logger.js', logMock], ['lib/whatsapp.js', waMock],
  ['lib/admin-notify.js', notifyMock], ['lib/telegram.js', tgMock],
  ['lib/notifications-db.js', notifDbMock], ['gmail.js', gmailMock],
  ['helpers/db-helpers.js', helpersMock],
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
  for (const m of [logMock.error, logMock.warn, waMock.enviarWhatsapp, notifyMock.notificarAdmin, tgMock.enviarTelegramFotoConBotones, notifDbMock.crearNotificacion]) m.mockClear();
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
