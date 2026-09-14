import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'), '../..');

// La foto del comprobante que le llega al admin por Telegram (y su texto de respaldo) tiene que
// decir quién es la persona y si ya pagó antes. Antes decía "WhatsApp: <from>", que para quien
// escribe sin número visible era el BSUID crudo, y no decía nada del historial.

process.env.TELEGRAM_ADMIN_CHAT_ID = '123';

let router = () => ({});
let ops = [];
function makeChain(table, op, payload) {
  const q = { table, op, payload, filtros: [], head: false };
  const c = {};
  for (const m of ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'or', 'limit', 'order', 'in', 'not', 'is']) {
    c[m] = (...a) => { q.filtros.push([m, ...a]); return c; };
  }
  // `head` solo cuenta con `count: 'exact'`: postgrest-js no llena `count` sin él.
  c.select = (_cols, opts) => { if (opts && opts.head && opts.count === 'exact') q.head = true; return c; };
  c.single = () => c;
  c.maybeSingle = () => c;
  c.then = (res, rej) => { ops.push(q); return Promise.resolve({ data: null, error: null, ...(router(q) || {}) }).then(res, rej); };
  return c;
}
const dbMock = {
  supabase: {
    from: (t) => ({
      select: (...a) => makeChain(t, 'select').select(...a),
      insert: (p) => makeChain(t, 'insert', p),
      update: (p) => makeChain(t, 'update', p),
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

const LUIS = { id: 'u-7', nombre: 'Luis Calderón', whatsapp: '51970111222', plan: 'premium' };
const solicitar = (usuario = LUIS) => pro.registrarSolicitudPro({
  usuario, monto: 10, montoDetectado: 10, tipoPlan: 'mensual',
  comprobanteBuffer: Buffer.from('x'), mimeType: 'image/jpeg', origen: 'whatsapp',
});

// Conteo de pagos previos: `null` = la lectura falló.
let previos;
function routerBase(q) {
  if (q.table === 'pagos' && q.op === 'insert') return { data: { id: 'pago-9' } };
  if (q.table === 'pagos' && q.head) {
    return previos === null ? { error: { message: 'db caída' } } : { count: previos };
  }
  return {};
}
const caption = () => tgMock.enviarTelegramFotoConBotones.mock.calls[0][3];

beforeEach(() => {
  ops = [];
  previos = 0;
  router = routerBase;
  for (const m of [tgMock.enviarTelegramFotoConBotones, notifyMock.notificarAdmin, logMock.warn]) m.mockClear();
  tgMock.enviarTelegramFotoConBotones.mockResolvedValue({ ok: true });
});

describe('caption de la solicitud Pro', () => {
  it('cliente nuevo: nombre, teléfono legible y "primer pago"', async () => {
    await solicitar();
    expect(caption()).toContain('Cliente: Luis Calderón');
    expect(caption()).toContain('WhatsApp: +51 970 111 222');
    expect(caption()).toContain('🆕 Cliente nuevo: sería su primer pago');
  });

  it('recurrente: cuántas veces pagó y qué número sería este', async () => {
    previos = 3;
    await solicitar();
    expect(caption()).toContain('ya pagó 3 veces, este sería el pago N° 4');
  });

  it('cuenta sin la fila recién abierta y solo pagos con plata', async () => {
    await solicitar();
    const conteo = ops.find((q) => q.table === 'pagos' && q.head);
    expect(conteo.filtros).toEqual(expect.arrayContaining([
      ['eq', 'usuario_id', 'u-7'], ['eq', 'estado', 'aprobado'], ['gt', 'monto', 0], ['neq', 'id', 'pago-9'],
    ]));
  });

  it('si no pudo leer el historial lo dice, y la foto con botones sale igual', async () => {
    previos = null;
    await solicitar();
    expect(tgMock.enviarTelegramFotoConBotones).toHaveBeenCalledOnce();
    expect(caption()).toMatch(/No pude leer cuántas veces pagó/);
    expect(caption()).not.toMatch(/Cliente nuevo/);
  });

  it('sin número visible no muestra el BSUID como teléfono', async () => {
    await solicitar({ id: 'u-8', nombre: 'Ana', whatsapp: null, bsuid: 'PE.1049206861029395' });
    expect(caption()).toContain('WhatsApp: sin número visible');
    expect(caption()).not.toMatch(/PE\.1049/);
  });

  it('el texto de respaldo (Telegram sin foto) lleva la misma ficha y conserva /pago', async () => {
    tgMock.enviarTelegramFotoConBotones.mockResolvedValue({ ok: false });
    previos = 1;
    await solicitar();
    const texto = notifyMock.notificarAdmin.mock.calls[0][0];
    expect(texto).toContain('Cliente: Luis Calderón');
    expect(texto).toContain('WhatsApp: +51 970 111 222');
    expect(texto).toContain('ya pagó 1 vez, este sería el pago N° 2');
    expect(texto).toContain('/pago 51970111222 mensual');
  });
});
