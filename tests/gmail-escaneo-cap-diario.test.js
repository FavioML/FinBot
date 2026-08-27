import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

/**
 * El resumen del escaneo de Gmail: como máximo UNO por día por usuario.
 *
 * El cron de escaneo corre cada 15 minutos y esta rama escribía una fila en la campana por
 * CADA corrida que encontrara movimientos. Medido contra producción el 27-ago-2026 sobre 30
 * días: **209 filas a 2 usuarios**, o sea el 26.7% de todo el volumen in-app del producto,
 * 4.4 por día en el más activo. Las 4.4 dicen exactamente lo mismo y enlazan al mismo sitio.
 *
 * **Se colapsa la cadencia; NO se borra el aviso.** La diferencia importa y casi me la como:
 * el `motivo` del call-site dice que cada transacción ya manda su propia tarjeta, y eso
 * invita a borrar el resumen por redundante. Pero esa tarjeta es de WHATSAPP —
 * `enviarAlertaTransaccion` no escribe fila in-app salvo en la rama de gasto inusual, y su
 * docblock explica que convertirla en `notificarUsuario` sería "una campana de spam"—, así
 * que sin el resumen la campana se queda sin NADA que cuente que el correo trajo movimientos.
 *
 * El caso que decide es el tercero: el dedup ilegible tiene que fallar CERRADO. Al revés que
 * los crons horarios de `checks.js`, porque acá "ante la duda mandar" son hasta 96 filas
 * idénticas en un día.
 */

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '..',
);

const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };

/** Filas de `notificaciones` que el dedup encuentra, y el error que devuelve la consulta. */
let avisosDeHoy = [];
let errorDedup = null;
/** Los filtros con que se consultó `notificaciones`, para mirar la CLAVE y no solo el efecto. */
let filtrosDedup = null;
const avisosMandados = [];

function tabla(nombre) {
  const q = {
    _f: {},
    select() { return q; },
    not() { return q; },
    is() { return q; },
    in() { return q; },
    order() { return q; },
    eq(col, val) { q._f[col] = val; return q; },
    gte(col, val) { q._f['gte:' + col] = val; return q; },
    single: async () => ({ data: null, error: null }),
    maybeSingle: async () => ({ data: null, error: null }),
    limit() {
      if (nombre === 'notificaciones') {
        filtrosDedup = { ...q._f };
        return Promise.resolve({ data: errorDedup ? null : avisosDeHoy, error: errorDedup });
      }
      return Promise.resolve({ data: [], error: null });
    },
    then(res) {
      const filas =
        nombre === 'usuarios'
          ? [{ id: 'u1', plan: 'premium', estado_pago: 'pagado', premium_vence: '2099-01-01', whatsapp: '51999', gmail_access_token: 'tok' }]
          : [];
      return Promise.resolve({ data: filas, error: null }).then(res);
    },
  };
  return q;
}

const stubs = {
  'lib/logger.js': logMock,
  'lib/db.js': { supabase: { from: tabla } },
  'lib/error-monitor.js': { registrarError: vi.fn() },
  'lib/admin-notify.js': { notificarErrorAdmin: vi.fn() },
  'gmail.js': { leerCorreosBancarios: async () => ({ error: null, mensajes: [{ id: 'm1', texto: 'compra', asunto: 'BCP', fecha: '2026-08-27' }] }) },
  'services/parsers.js': { parsearCorreoBancario: async () => ({ monto: 25, tipo: 'gasto', comercio: 'Wong' }) },
  'services/transactions.js': { guardarTransaccion: async () => ({ id: 'tx1', categoria: 'Alimentación' }) },
  'services/categories.js': { obtenerCategoriasUsuario: async () => [] },
  'services/notifications.js': { enviarAlertaTransaccion: vi.fn() },
  'lib/trial.js': { esProPagado: () => true, linkPanelPro: () => 'https://app.neto.pe/dashboard/pro' },
  'lib/notify-user.js': {
    CANALES: { AMBOS: 'ambos', SOLO_WHATSAPP: 'solo_whatsapp', SOLO_IN_APP: 'solo_in_app' },
    notificarUsuario: async (o) => { avisosMandados.push(o); return { wa: { ok: false }, inApp: true }; },
  },
};
for (const [rel, exports] of Object.entries(stubs)) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const { escaneoAutomatico } = require('../services/gmail-scanner');

beforeEach(() => {
  avisosDeHoy = [];
  errorDedup = null;
  filtrosDedup = null;
  avisosMandados.length = 0;
  logMock.warn.mockClear();
});

const resumenes = () => avisosMandados.filter((a) => a.tipo === 'gmail_escaneo');

describe('el resumen del escaneo de Gmail va como máximo 1 vez al día', () => {
  it('sin aviso previo, manda uno', async () => {
    await escaneoAutomatico();
    // El control positivo: sin esto, un cap que corte SIEMPRE pasaría los dos casos de abajo.
    expect(resumenes()).toHaveLength(1);
    expect(resumenes()[0].titulo).toBe('Escaneo de correo completado');
  });

  it('con un aviso de hoy, NO manda otro', async () => {
    avisosDeHoy = [{ id: 'n1' }];
    await escaneoAutomatico();
    expect(resumenes()).toHaveLength(0);
  });

  it('si el dedup no se puede leer, falla CERRADO', async () => {
    errorDedup = { message: 'timeout' };
    await escaneoAutomatico();
    // 96 corridas al día: "ante la duda mandar" acá no es un duplicado, es una campana llena
    // de la misma fila. El costo de saltarlo es que la persona ve sus movimientos al entrar.
    expect(resumenes()).toHaveLength(0);
    // Y no en silencio: si esto deja de avisar, el cap se vuelve indistinguible de un cron
    // que dejó de encontrar movimientos.
    expect(logMock.warn).toHaveBeenCalled();
  });

  it('la clave del dedup es usuario + tipo + título + hoy en Lima', async () => {
    await escaneoAutomatico();
    // Mirar el EFECTO no alcanza: un dedup sin `usuario_id` silenciaría a todo el mundo en
    // cuanto una sola persona recibiera su resumen, y el caso "no manda otro" pasaría igual.
    expect(filtrosDedup).toMatchObject({
      usuario_id: 'u1',
      tipo: 'sistema',
      titulo: 'Escaneo de correo completado',
    });
    // El corte es medianoche de Lima (-05:00), no UTC: con UTC el día se corta a las 19:00
    // hora local y el usuario recibe dos resúmenes cada tarde.
    expect(filtrosDedup['gte:fecha']).toBeTruthy();
    const corte = new Date(filtrosDedup['gte:fecha']);
    expect(corte.getUTCHours()).toBe(5);
    expect(corte.getUTCMinutes()).toBe(0);
  });
});
