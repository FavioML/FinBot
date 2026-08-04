import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

/**
 * El periodo que se compra, y el descuento que se consume al comprarlo (B8 y B10 de la
 * auditoría CTO, ola 4). Las dos cosas mueven plata:
 *
 *   B8 — el vencimiento se calculaba con `new Date(y, mes + n, dia)`, que hace ROLLOVER
 *   cuando el día no existe en el mes destino. Un pago del 31 de enero no vencía el 28 de
 *   febrero sino el 3 de MARZO, porque el 31 de febrero se desborda. Regalaba días en todos
 *   los meses cortos, y el anual repetía el patrón en cada bisiesto.
 *
 *   B10 — el 50% off de referido ("tu primer mes") no se marcaba consumido al convertir.
 *   Como la ventana se ancla al fin del trial, quedaba vigente hasta 7 días DESPUÉS de
 *   pagar, y `POST /pro/solicitud` calcula el monto esperado con `precioProEfectivo`: una
 *   renovación pedida dentro de esa ventana entraba a la cola en S/5.
 */

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '../..',
);

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

const BASE_USER = { id: 'u-1', whatsapp: '51999888777', nombre: 'Favio', plan: 'free', premium_desde: null };
const updateUsuarios = () => ops.find(o => o.table === 'usuarios' && o.op === 'update');

/** Activa Pro con "hoy" congelado, para que el periodo no dependa del día en que corran los tests. */
async function activarCon({ hoy, usuario, tipoPlan = 'mensual', esConversionPagada = true }) {
  vi.setSystemTime(new Date(hoy + 'T15:00:00Z')); // 10am Lima: mismo día en Lima y en UTC
  router = () => ({ data: null, error: null });
  ops = [];
  return pro.activarPro({
    usuario: { ...BASE_USER, ...usuario },
    tipoPlan, aprobadoPor: 'test', enviarLinkGmail: false, esConversionPagada,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  for (const m of [logMock.error, logMock.warn, waMock.enviarWhatsapp, notifyMock.notificarAdmin,
    tgMock.enviarTelegramFotoConBotones, notifDbMock.crearNotificacion, refMock.procesarConversionProReferido]) m.mockClear();
});

describe('B8 — el periodo no puede desbordar al mes siguiente', () => {
  // El caso del hallazgo, tal cual: 31-ene + 1 mes daba 3-mar.
  it('31 de enero + 1 mes vence el 28 de febrero, no el 3 de marzo', async () => {
    const { venceStr } = await activarCon({ hoy: '2026-01-31', usuario: {} });
    expect(venceStr).toBe('2026-02-28');
  });

  it('31 de enero de un bisiesto cae en el 29', async () => {
    const { venceStr } = await activarCon({ hoy: '2028-01-31', usuario: {} });
    expect(venceStr).toBe('2028-02-29');
  });

  it('31 de marzo + 1 mes vence el 30 de abril, no el 1 de mayo', async () => {
    const { venceStr } = await activarCon({ hoy: '2026-03-31', usuario: {} });
    expect(venceStr).toBe('2026-04-30');
  });

  it('el anual del 29 de febrero cae en el 28 del año siguiente', async () => {
    const { venceStr } = await activarCon({ hoy: '2028-02-29', usuario: {}, tipoPlan: 'anual' });
    expect(venceStr).toBe('2029-02-28');
  });

  it('un mes normal sigue sumando el mismo día', async () => {
    const { venceStr } = await activarCon({ hoy: '2026-08-04', usuario: {} });
    expect(venceStr).toBe('2026-09-04');
  });

  // Las dos reglas que ya existían y NO se pueden perder al cambiar la aritmética.
  it('renovar sobre una suscripción vigente apila, nunca acorta', async () => {
    const { venceStr } = await activarCon({ hoy: '2026-08-04', usuario: { premium_vence: '2026-08-31' } });
    expect(venceStr).toBe('2026-09-30'); // 31-ago + 1 mes, recortado
  });

  it('un vencimiento ya pasado NO se apila: cuenta desde hoy', async () => {
    const { venceStr } = await activarCon({ hoy: '2026-08-04', usuario: { premium_vence: '2026-01-15' } });
    expect(venceStr).toBe('2026-09-04');
  });

  it('pagar en trial apila sobre trial_vence (no cuesta los días que faltaban)', async () => {
    const { venceStr } = await activarCon({
      hoy: '2026-08-04',
      usuario: { plan: 'premium', trial_estado: 'activo', trial_vence: '2026-08-17' },
    });
    expect(venceStr).toBe('2026-09-17');
  });

  it('una fecha basura en la columna no rompe el cálculo: cuenta desde hoy', async () => {
    const { venceStr } = await activarCon({ hoy: '2026-08-04', usuario: { premium_vence: 'no-es-fecha' } });
    expect(venceStr).toBe('2026-09-04');
  });

  it('la columna legacy fecha_vencimiento nombra el MISMO día que premium_vence', async () => {
    const { venceStr } = await activarCon({ hoy: '2026-01-31', usuario: {} });
    const up = updateUsuarios().payload;
    expect(up.premium_vence).toBe(venceStr);
    // Mediodía de Lima: el mismo día se lea desde donde se lea.
    expect(up.fecha_vencimiento.startsWith(venceStr)).toBe(true);
  });
});

describe('B10 — el 50% off es del PRIMER mes y una conversión pagada lo consume', () => {
  it('una conversión pagada limpia el descuento', async () => {
    await activarCon({
      hoy: '2026-08-04',
      usuario: { referido_dscto_pct: 50, referido_dscto_vence: '2026-08-24' },
      esConversionPagada: true,
    });
    const up = updateUsuarios().payload;
    expect(up.referido_dscto_pct).toBeNull();
    expect(up.referido_dscto_vence).toBeNull();
  });

  it('un comp NO lo consume: no le gasta a nadie su primer mes', async () => {
    await activarCon({
      hoy: '2026-08-04',
      usuario: { referido_dscto_pct: 50, referido_dscto_vence: '2026-08-24' },
      esConversionPagada: false,
    });
    const up = updateUsuarios().payload;
    expect('referido_dscto_pct' in up).toBe(false);
    expect('referido_dscto_vence' in up).toBe(false);
  });

  // El descuento consumido no puede llevarse por delante nada del resto de la activación.
  it('el resto del set de columnas sigue completo', async () => {
    await activarCon({ hoy: '2026-08-04', usuario: { referido_dscto_pct: 50 }, esConversionPagada: true });
    const up = updateUsuarios().payload;
    for (const col of ['plan', 'estado_pago', 'tipo_plan', 'fecha_pago', 'fecha_vencimiento',
      'premium_desde', 'premium_vence', 'pago_pendiente', 'esperando_comprobante', 'trial_estado']) {
      expect(up, 'falta ' + col).toHaveProperty(col);
    }
    expect(up.trial_estado).toBe('convertido');
  });
});

/**
 * La otra mitad de B10, que encontró el revisor del diff (no mi verificación, que estaba
 * verde): cerrar el residuo del descuento no servía de nada si al aprobar el pago se pisaba
 * el monto acordado con el precio de lista.
 *
 * `routes/pro.js` escribe la solicitud con `precioProEfectivo` (S/5 con el 50% off), y
 * `activarPro` llamaba a `registrarPagoAprobado` con `monto: undefined` en toda conversión
 * pagada, así que el fallback al precio de lista sobrescribía la fila ya reclamada.
 * `cajaDelMes` suma esa columna: cada conversión con descuento inflaba el mes en S/5 de
 * plata que nadie transfirió.
 */
describe('B10 (bis) — aprobar un pago no puede pisar el monto acordado', () => {
  async function aprobar({ montoEnLaFila, planEnLaFila = 'mensual', aprobadoComo = 'mensual', esConversionPagada = true }) {
    vi.setSystemTime(new Date('2026-08-04T15:00:00Z'));
    ops = [];
    router = (q) => {
      if (q.table === 'pagos' && q.op === 'select') return { data: { monto: montoEnLaFila, tipo_plan: planEnLaFila } };
      return { data: null, error: null };
    };
    await pro.activarPro({
      usuario: { ...BASE_USER },
      tipoPlan: aprobadoComo, aprobadoPor: 'test', enviarLinkGmail: false,
      esConversionPagada, pagoId: 'pago-1',
    });
    return ops.find(o => o.table === 'pagos' && o.op === 'update' && o.payload && 'monto' in o.payload);
  }

  it('preserva el S/5 del referido, no lo sube a S/10', async () => {
    const up = await aprobar({ montoEnLaFila: 5 });
    expect(up.payload.monto).toBe(5);
  });

  /**
   * El periodo que se aprueba NO sale de la fila: sale del admin (`req.body.tipo_plan` /
   * el botón de Telegram), que ve el comprobante y puede corregirlo. Preservar el monto sin
   * mirar el periodo concede 12 meses registrando S/10. Lo encontró la segunda revisión
   * adversarial, sobre código que YA estaba en producción.
   */
  it('si el admin aprueba OTRO periodo, el monto de la fila NO manda', async () => {
    const up = await aprobar({ montoEnLaFila: 10, planEnLaFila: 'mensual', aprobadoComo: 'anual' });
    expect(up.payload.monto).toBe(99);   // no 10: se conceden 12 meses, se cobran 12 meses
    expect(up.payload.tipo_plan).toBe('anual');
  });

  it('y al revés: fila anual aprobada como mensual queda en el precio mensual', async () => {
    const up = await aprobar({ montoEnLaFila: 99, planEnLaFila: 'anual', aprobadoComo: 'mensual' });
    expect(up.payload.monto).toBe(10);
  });

  it('el descuento sobrevive solo cuando el periodo COINCIDE', async () => {
    const igual = await aprobar({ montoEnLaFila: 5, planEnLaFila: 'mensual', aprobadoComo: 'mensual' });
    expect(igual.payload.monto).toBe(5);
    const distinto = await aprobar({ montoEnLaFila: 5, planEnLaFila: 'mensual', aprobadoComo: 'anual' });
    expect(distinto.payload.monto).toBe(99);
  });

  it('un pago sin descuento sigue quedando en el precio de lista', async () => {
    const up = await aprobar({ montoEnLaFila: 10 });
    expect(up.payload.monto).toBe(10);
  });

  // El camino de WhatsApp puede no detectar el monto en la imagen: ahí el precio de lista
  // sigue siendo la mejor respuesta, no un null que rompería la caja del mes.
  it('si la fila no trae monto, cae al precio de lista', async () => {
    const up = await aprobar({ montoEnLaFila: null });
    expect(up.payload.monto).toBe(10);
  });

  // El comp pasa `monto: 0` EXPLÍCITO: un monto del llamador gana siempre, o el comp
  // volvería a figurar como S/10 cobrados.
  it('un comp se sigue registrando en S/0 aunque la fila diga otra cosa', async () => {
    const up = await aprobar({ montoEnLaFila: 10, esConversionPagada: false });
    expect(up.payload.monto).toBe(0);
  });
});

describe('B10 — el precio que se le cobra al renovador', () => {
  const { precioProEfectivo } = require('../../lib/config');

  // Este es el número que `POST /pro/solicitud` escribe en `pagos.monto`. Con el descuento
  // ya limpiado por activarPro, una renovación vuelve a costar lo que cuesta.
  it('sin descuento en la fila, el mensual vale el precio de lista', () => {
    expect(precioProEfectivo({ referido_dscto_pct: null, referido_dscto_vence: null }, 'mensual', '2026-08-20')).toBe(10);
  });

  it('con el descuento vivo (antes de convertir) vale la mitad', () => {
    expect(precioProEfectivo({ referido_dscto_pct: 50, referido_dscto_vence: '2026-08-24' }, 'mensual', '2026-08-20')).toBe(5);
  });

  it('el anual nunca lleva descuento: no tiene "primer mes"', () => {
    expect(precioProEfectivo({ referido_dscto_pct: 50, referido_dscto_vence: '2026-08-24' }, 'anual', '2026-08-20')).toBe(99);
  });
});
