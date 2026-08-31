import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

/**
 * El correo de deudas se manda UNA vez por PERSONA, no una por deuda.
 *
 * **El bug medido**, que es lo que este archivo tiene que impedir que vuelva: el 31-ago-2026 a
 * las 9:05 un usuario con 6 deudas activas recibió **4 correos en 11 segundos**, uno por cada
 * deuda que había alcanzado un touch. El 29-ago le habían salido 8 filas de
 * `notification_deliveries` (4 deudas × 2 canales).
 *
 * **No era repetición del mismo aviso, y la distinción decide el arreglo.** El ledger
 * `deudas.recordatorios_enviados` funciona: son 4 toques como máximo en toda la vida de una
 * deuda (`p3`, `v1`, `v0`, y el de 3 días después), y tres deudas ya habían llegado a 4 y ahí
 * terminaron. Lo que estaba mal era la RÁFAGA de un mismo día, que sale de que el bucle sea
 * por deuda. Un arreglo sobre el ledger no habría tocado el problema.
 *
 * `lib/email.js` ya lo decía en el comentario de `TOPE_DIARIO_POR_USUARIO`: el tope de 5 no es
 * el arreglo, el arreglo de fondo es agrupar por persona.
 *
 * **Lo que se corre acá es el cron de verdad**, con `notificarUsuario` mockeado, y se afirma el
 * EFECTO —cuántas veces se notifica, a quién, y qué dice— y no la forma de la query. Los
 * guards de forma que acompañan a este cambio son otros tres y ninguno reemplaza a éste:
 * `email-necesita-su-columna` (que el select traiga la dirección), `canal-unico-sin-cuenta-web`
 * (que mire la baja) y `dedup-claim-in-app` (que pida el claim).
 *
 * El caso 2 es el que ata el otro extremo de la mudanza: **`checkRecordatorioDeudas` dejó de
 * declarar correo**. Sin él, alguien puede "arreglar" el problema agregando el resumen y
 * dejando los dos emisores vivos, que es la ráfaga de antes más un correo.
 */

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '../..',
);

/** Filas por tabla. Lo que no esté acá devuelve []. */
let tablas = {};
/** Tablas cuya LECTURA falla, por nombre: `{ notificaciones: { message: 'boom' } }`. */
let errores = {};

const notificar = vi.fn();
/** Lo que `obtenerDeudasParaResumenSemanal` devuelve, por test. */
const deudasResumen = vi.fn();
const deudasProximas = vi.fn();

/**
 * El mock FILTRA de verdad sobre `eq` y los rangos. No es adorno: el dedup del cron es una
 * query con cuatro filtros, y con la cadena en no-op el caso "ya salió esta semana" y el caso
 * "todavía no" devolverían lo mismo — o sea que la mutación que borra el dedup saldría verde.
 */
function makeChain(table) {
  const filtros = [];
  let tope = null;
  const chain = {};
  for (const m of ['not', 'is', 'or', 'in', 'ilike', 'order', 'neq']) chain[m] = () => chain;
  const noEsNull = (f, col) => f[col] !== null && f[col] !== undefined;
  const rango = (cmp) => (col, val) => { filtros.push((f) => noEsNull(f, col) && cmp(f[col], val)); return chain; };
  chain.gt = rango((a, b) => a > b);
  chain.gte = rango((a, b) => a >= b);
  chain.lt = rango((a, b) => a < b);
  chain.lte = rango((a, b) => a <= b);
  chain.eq = (col, val) => { filtros.push((f) => f[col] === val); return chain; };
  chain.limit = (n) => { tope = n; return chain; };
  chain.select = () => chain;
  const resolver = () => {
    if (errores[table]) return { data: null, count: null, error: errores[table] };
    let filas = (tablas[table] || []).filter((f) => filtros.every((p) => p(f)));
    if (tope !== null) filas = filas.slice(0, tope);
    return { data: filas, count: filas.length, error: null };
  };
  chain.then = (resolve) => resolve(resolver());
  chain.single = () => Promise.resolve({ data: (resolver().data || [])[0] || null, error: null });
  chain.maybeSingle = chain.single;
  return chain;
}

const dbMock = {
  supabase: {
    from: vi.fn((t) => {
      const base = makeChain(t);
      return { ...base, update: () => makeChain(t), insert: () => makeChain(t), delete: () => makeChain(t) };
    }),
  },
};
const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };

const serviciosMock = [
  ['lib/db.js', dbMock],
  ['lib/logger.js', logMock],
  ['lib/whatsapp.js', { enviarWhatsapp: vi.fn().mockResolvedValue({ ok: true }) }],
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
    obtenerDeudasProximasVencer: deudasProximas,
    obtenerDeudasParaResumenSemanal: deudasResumen,
  }],
  ['services/spending-alerts.js', {
    generarAlertasFugas: vi.fn().mockResolvedValue([]), generarMensajeFugas: vi.fn(), guardarAlertas: vi.fn(),
  }],
  ['services/neto-score.js', {
    upsertScore: vi.fn(), obtenerTendenciaScore: vi.fn(), scoreLabel: () => 'bien',
  }],
  ['services/metas.js', { calcularRitmoAhorro: () => ({ enRitmo: true, montoMensual: 100 }) }],
  ['services/shared-spaces.js', { obtenerBalanceEspacio: vi.fn(), ownerEsPro: vi.fn() }],
  ['services/subscriptions/index.js', { detectarSuscripciones: vi.fn() }],
  ['services/survey-triggers.js', { checkSurveyTriggers: vi.fn() }],
];
for (const [rel, exports] of serviciosMock) {
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

/** Un instante real cuyo horario en Lima (UTC-5) es el que el gate del cron exige. */
const enLima = (iso) => new Date(iso + '-05:00');
/** 2026-08-31 es LUNES. El gate pide lunes, hora 9, minuto <= 14. */
const LUNES_9AM = '2026-08-31T09:05:00';

const PRO = { whatsapp: '51900000001', email: 'ana@ejemplo.pe', nombre: 'Ana Torres', plan: 'premium', recordatorios_activos: true };

/** Una deuda del fixture. Por defecto: la debe el usuario, en soles, vence en 3 días. */
const deuda = (over = {}) => ({
  id: 'd-1', usuario_id: 'u-1', contraparte: 'Juan', moneda: 'PEN',
  monto_pendiente: '100', tipo: 'debo', fecha_vencimiento: '2026-09-03',
  estado: 'activa', usuarios: PRO, ...over,
});

/** El argumento con el que se llamó a `notificarUsuario`, por índice. */
const arg = (i = 0) => notificar.mock.calls[i][0];

beforeEach(() => {
  tablas = {};
  errores = {};
  notificar.mockClear();
  notificar.mockResolvedValue({ wa: { ok: false, skipped: 'canal_no_declarado' }, inApp: true, email: { ok: true } });
  // `mockClear` y no sólo `mockResolvedValue`: los casos del gate afirman que la población
  // NO se lee, y sin limpiar el contador arrastran las llamadas de los tests anteriores.
  deudasResumen.mockClear();
  deudasProximas.mockClear();
  deudasResumen.mockResolvedValue([]);
  deudasProximas.mockResolvedValue([]);
  logMock.error.mockClear();
  logMock.warn.mockClear();
  logMock.info.mockClear();
  vi.setSystemTime(enLima(LUNES_9AM));
});

describe('el correo de deudas sale UNA vez por persona', () => {
  it('tres deudas del mismo usuario producen UN aviso, con las tres adentro', async () => {
    // El caso exacto del 31-ago: varias deudas del mismo usuario el mismo día. Contra el
    // código anterior esto eran tres correos; el que los contaba no existía.
    deudasResumen.mockResolvedValue([
      deuda({ id: 'd-1', contraparte: 'Juan', monto_pendiente: '100' }),
      deuda({ id: 'd-2', contraparte: 'Luis', monto_pendiente: '50.50' }),
      deuda({ id: 'd-3', contraparte: 'Marta', monto_pendiente: '25' }),
    ]);

    await checks.checkResumenDeudasSemanal();

    expect(notificar).toHaveBeenCalledTimes(1);
    const a = arg();
    expect(a.mensaje).toContain('Juan');
    expect(a.mensaje).toContain('Luis');
    expect(a.mensaje).toContain('Marta');
    expect(a.email.to).toBe('ana@ejemplo.pe');
  });

  it('dos usuarios reciben un aviso cada uno, y no se mezclan', async () => {
    // La contraprueba del agrupamiento: agrupar mal —una sola llamada para todos— es tan bug
    // como no agrupar, y le mandaría a cada uno las deudas del otro.
    deudasResumen.mockResolvedValue([
      deuda({ id: 'd-1', usuario_id: 'u-1', contraparte: 'Juan' }),
      deuda({ id: 'd-2', usuario_id: 'u-2', contraparte: 'Marta', usuarios: { ...PRO, email: 'beto@ejemplo.pe', nombre: 'Beto' } }),
    ]);

    await checks.checkResumenDeudasSemanal();

    expect(notificar).toHaveBeenCalledTimes(2);
    const [uno, dos] = notificar.mock.calls.map((c) => c[0]);
    expect(uno.usuarioId).toBe('u-1');
    expect(uno.mensaje).toContain('Juan');
    expect(uno.mensaje).not.toContain('Marta');
    expect(dos.usuarioId).toBe('u-2');
    expect(dos.mensaje).toContain('Marta');
    expect(dos.mensaje).not.toContain('Juan');
  });

  it('el aviso por deuda ya NO manda correo (el otro extremo de la mudanza)', async () => {
    // Sin esto, el arreglo "agregar el resumen" deja los dos emisores vivos y el resultado es
    // la ráfaga de antes MÁS un correo semanal. Contra el commit anterior este caso falla.
    deudasProximas.mockResolvedValue([
      deuda({ recordatorios_enviados: [], fecha_vencimiento: '2026-08-31' }),
    ]);

    await checks.checkRecordatorioDeudas();

    expect(notificar).toHaveBeenCalledTimes(1);
    expect(arg().email, 'checkRecordatorioDeudas volvió a declarar el canal de correo').toBeUndefined();
    // Y sigue mandando por los otros dos: sacar el correo no puede haber apagado el aviso.
    expect(arg().canales).toBe('ambos');
    expect(arg().mensaje).toContain('Juan');
  });
});

describe('qué entra en el resumen', () => {
  it('lo ya vencido entra, y se nombra en pasado', async () => {
    // El tramo vencido es la mitad de la decisión de alcance: sin él, una deuda que venció el
    // jueves pasado no vuelve a nombrarla nadie, porque el ledger de toques ya se agotó.
    deudasResumen.mockResolvedValue([deuda({ fecha_vencimiento: '2026-07-22' })]);

    await checks.checkResumenDeudasSemanal();

    expect(notificar).toHaveBeenCalledTimes(1);
    expect(arg().mensaje).toContain('venció el 22-jul-26');
  });

  it('separa lo que debe de lo que le deben, y no mezcla los totales', async () => {
    deudasResumen.mockResolvedValue([
      deuda({ id: 'd-1', contraparte: 'Juan', monto_pendiente: '100', tipo: 'debo' }),
      deuda({ id: 'd-2', contraparte: 'Marta', monto_pendiente: '300', tipo: 'me_deben' }),
    ]);

    await checks.checkResumenDeudasSemanal();

    const a = arg();
    expect(a.mensaje).toContain('*Debes:*');
    expect(a.mensaje).toContain('*Te deben:*');
    expect(a.email.asunto).toBe('Debes S/ 100.00 y te deben S/ 300.00');
  });

  it('no suma soles con dólares (no hay tipo de cambio que inventar)', async () => {
    deudasResumen.mockResolvedValue([
      deuda({ id: 'd-1', contraparte: 'Juan', monto_pendiente: '100', moneda: 'PEN' }),
      deuda({ id: 'd-2', contraparte: 'Mike', monto_pendiente: '40', moneda: 'USD' }),
    ]);

    await checks.checkResumenDeudasSemanal();

    // El separador de MONEDAS es ` + ` y no ` y `, que es el que separa los dos LADOS un nivel
    // arriba. Ver el caso del cruce, abajo: con los dos en ` y ` el asunto se vuelve ilegible.
    expect(arg().email.asunto).toBe('Debes S/ 100.00 + $ 40.00');
    expect(arg().mensaje).toContain('$ 40.00');
  });

  it('dos monedas Y los dos lados: cada nivel de la lista tiene su separador', async () => {
    // El cruce de los dos casos de arriba, que ninguno de los dos cubría. Con `totalPorMoneda`
    // uniendo con ` y ` —como estaba— el asunto salía
    // *"Debes S/ 100.00 y $ 40.00 y te deben S/ 300.00 y $ 20.00"*: cuatro cifras unidas por el
    // mismo conector, sin forma de saber dónde termina lo que debe. Al 31-ago ya hay un usuario
    // real con deuda en USD y otro con los dos lados a la vez: falta una sola deuda para verlo.
    deudasResumen.mockResolvedValue([
      deuda({ id: 'd-1', contraparte: 'Juan', monto_pendiente: '100', moneda: 'PEN', tipo: 'debo' }),
      deuda({ id: 'd-2', contraparte: 'Mike', monto_pendiente: '40', moneda: 'USD', tipo: 'debo' }),
      deuda({ id: 'd-3', contraparte: 'Marta', monto_pendiente: '300', moneda: 'PEN', tipo: 'me_deben' }),
      deuda({ id: 'd-4', contraparte: 'Ann', monto_pendiente: '20', moneda: 'USD', tipo: 'me_deben' }),
    ]);

    await checks.checkResumenDeudasSemanal();

    expect(arg().email.asunto).toBe('Debes S/ 100.00 + $ 40.00 y te deben S/ 300.00 + $ 20.00');
  });

  it('un total de exactamente 0 no borra su moneda del asunto', async () => {
    // `filter((m) => totales[m])` dejaba caer el 0 por falsy y el asunto salía `'Debes '` pelado.
    // El CHECK de la tabla permite `monto_pendiente = 0`, así que es alcanzable.
    deudasResumen.mockResolvedValue([deuda({ monto_pendiente: '0' })]);

    await checks.checkResumenDeudasSemanal();

    expect(arg().email.asunto).toBe('Debes S/ 0.00');
  });

  it('una deuda con monto no numérico queda fuera, y las sanas del mismo usuario siguen', async () => {
    // **Este fixture NO es alcanzable hoy, y decirlo es la mitad del test.** Medido contra el
    // esquema vivo, `deudas.monto_pendiente` es NOT NULL con CHECK `>= 0` y `<= 999999.99`: el
    // insert se rechaza y la fila no llega a existir. El comentario anterior afirmaba lo
    // contrario (la "deuda envenenada" de qa-money-edge) sin haberlo medido.
    // Lo que este caso fija es el COMPORTAMIENTO si la columna alguna vez se afloja: un monto
    // que no se puede sumar no puede poner "S/ NaN" en una bandeja, que no se puede desdecir.
    deudasResumen.mockResolvedValue([
      deuda({ id: 'd-1', contraparte: 'Rota', monto_pendiente: null }),
      deuda({ id: 'd-2', contraparte: 'Sana', monto_pendiente: '80' }),
    ]);

    await checks.checkResumenDeudasSemanal();

    expect(notificar).toHaveBeenCalledTimes(1);
    expect(arg().mensaje).not.toContain('NaN');
    expect(arg().mensaje).not.toContain('Rota');
    expect(arg().mensaje).toContain('Sana');
    expect(arg().email.asunto).toBe('Debes S/ 80.00');
    expect(logMock.warn.mock.calls.some((c) => c[0] && c[0].deudaId === 'd-1')).toBe(true);
  });

  it('si TODAS las deudas del usuario están rotas, no se le manda un correo vacío', async () => {
    deudasResumen.mockResolvedValue([deuda({ monto_pendiente: null })]);

    await checks.checkResumenDeudasSemanal();

    expect(notificar).not.toHaveBeenCalled();
  });
});

describe('a quién NO se le manda', () => {
  it('a quien se dio de baja de los recordatorios', async () => {
    // El pie de cada correo promete textual que la baja apaga todos los canales. Acá es donde
    // esa promesa se cumple o no: `notificarUsuario` no puede chequearlo (no lee la base).
    deudasResumen.mockResolvedValue([deuda({ usuarios: { ...PRO, recordatorios_activos: false } })]);

    await checks.checkResumenDeudasSemanal();

    expect(notificar).not.toHaveBeenCalled();
  });

  it('a quien está en el muro (el resumen ES el ledger, y eso se cobra)', async () => {
    deudasResumen.mockResolvedValue([deuda({ usuarios: { ...PRO, plan: 'free' } })]);

    await checks.checkResumenDeudasSemanal();

    expect(notificar).not.toHaveBeenCalled();
  });

  it('a quien ya lo recibió hoy (dedup por la fila de la campana)', async () => {
    tablas.notificaciones = [{
      id: 'n-1', usuario_id: 'u-1', tipo: 'deuda_resumen',
      titulo: 'Tus deudas pendientes', fecha: enLima('2026-08-31T09:00:00').toISOString(),
    }];
    deudasResumen.mockResolvedValue([deuda()]);

    await checks.checkResumenDeudasSemanal();

    expect(notificar).not.toHaveBeenCalled();
  });

  it('pero una fila del cron VECINO no lo dedupea (el dedup tiene que ser del resumen)', async () => {
    // Los lunes a las 9 corren los dos crons. El vecino escribe su propia fila de campana
    // ('deuda_vence', títulos variables); si el dedup del resumen la contara, el toque por
    // deuda de esa mañana mataría el resumen de esa persona **todos los lunes**. Se separan por
    // el `tipo` y por el `titulo`, y este caso mueve los dos.
    tablas.notificaciones = [{
      id: 'n-1', usuario_id: 'u-1', tipo: 'deuda_vence',
      titulo: 'Deuda vence hoy', fecha: enLima('2026-08-31T09:00:00').toISOString(),
    }];
    deudasResumen.mockResolvedValue([deuda()]);

    await checks.checkResumenDeudasSemanal();

    expect(notificar).toHaveBeenCalledTimes(1);
  });

  it('y una fila de la semana PASADA tampoco (si no, el resumen sale una sola vez en la vida)', async () => {
    tablas.notificaciones = [{
      id: 'n-1', usuario_id: 'u-1', tipo: 'deuda_resumen',
      titulo: 'Tus deudas pendientes', fecha: enLima('2026-08-24T09:00:00').toISOString(),
    }];
    deudasResumen.mockResolvedValue([deuda()]);

    await checks.checkResumenDeudasSemanal();

    expect(notificar).toHaveBeenCalledTimes(1);
  });
});

describe('el log de cierre distingue "corrió y no había nada" de "no corrió"', () => {
  it('con población vacía igual loguea', async () => {
    // Antes había un `if (!deudas.length) return;` antes del `log.info`, así que una semana sin
    // deudas y un cron que no arrancó producían el MISMO silencio en los logs — que es la
    // confusión que este archivo entero existe para evitar.
    deudasResumen.mockResolvedValue([]);

    await checks.checkResumenDeudasSemanal();

    const cierres = logMock.info.mock.calls.filter((c) => c[0] && c[0].tag === 'DEUDAS_SEMANAL');
    expect(cierres).toHaveLength(1);
    expect(cierres[0][0]).toMatchObject({ deudas: 0, elegibles: 0, enviados: 0 });
  });

  it('cuenta lo que se MANDÓ, no a quién se consideró', async () => {
    // `porUsuario.size` contaba elegibles: con todos los avisos fallando, el log salía idéntico
    // al de una semana normal.
    notificar.mockResolvedValueOnce({ wa: { ok: false, skipped: 'claim_in_app_fallo' }, inApp: false, email: { ok: false } });
    deudasResumen.mockResolvedValue([
      deuda({ id: 'd-1', usuario_id: 'u-1' }),
      deuda({ id: 'd-2', usuario_id: 'u-2', usuarios: { ...PRO, email: 'beto@ejemplo.pe' } }),
    ]);

    await checks.checkResumenDeudasSemanal();

    const cierre = logMock.info.mock.calls.find((c) => c[0] && c[0].tag === 'DEUDAS_SEMANAL')[0];
    expect(cierre).toMatchObject({ deudas: 2, elegibles: 2, enviados: 1 });
  });
});

describe('cuándo corre', () => {
  it.each([
    ['un martes a la misma hora', '2026-09-01T09:05:00'],
    ['el lunes a las 10', '2026-08-31T10:05:00'],
    ['el lunes 9:20 (fuera de la ventana de 15 minutos)', '2026-08-31T09:20:00'],
  ])('no corre %s', async (_cuando, iso) => {
    vi.setSystemTime(enLima(iso));
    deudasResumen.mockResolvedValue([deuda()]);

    await checks.checkResumenDeudasSemanal();

    // El gate corta ANTES de leer: si leyera y después decidiera, la query correría 96 veces
    // por día para nada.
    expect(deudasResumen).not.toHaveBeenCalled();
    expect(notificar).not.toHaveBeenCalled();
  });

  it('sí corre el lunes 9:05', async () => {
    // El control positivo. Sin él, un gate que devolviera siempre `return` pasaría los tres
    // casos de arriba y este archivo entero sería verde por vacuidad.
    deudasResumen.mockResolvedValue([deuda()]);

    await checks.checkResumenDeudasSemanal();

    expect(notificar).toHaveBeenCalledTimes(1);
  });
});

describe('la forma del aviso', () => {
  it('el asunto NO es el título de la campana, y lleva la plata sin emoji', async () => {
    deudasResumen.mockResolvedValue([deuda({ monto_pendiente: '120.50' })]);

    await checks.checkResumenDeudasSemanal();

    const a = arg();
    expect(a.titulo).toBe('Tus deudas pendientes');
    expect(a.email.asunto).toBe('Debes S/ 120.50');
    expect(a.email.asunto).not.toBe(a.titulo);
    // Sin emoji: el asunto es lo único que miran los filtros de spam antes de decidir.
    expect(/\p{Extended_Pictographic}/u.test(a.email.asunto)).toBe(false);
  });

  it('no manda WhatsApp: ese canal ya lleva el toque fechado de cada deuda', async () => {
    deudasResumen.mockResolvedValue([deuda()]);

    await checks.checkResumenDeudasSemanal();

    const a = arg();
    expect(a.canales).toBe('solo_in_app');
    // `tipo` propio y no el 'deuda_vence' del vecino: es la mitad de la clave del dedup, y
    // compartirlo la dejaba colgando sólo del título.
    expect(a.tipoInApp).toBe('deuda_resumen');
    expect(a.motivo, 'un canal único sin motivo es una excepción que nadie firmó').toBeTruthy();
    // El claim: la fila in-app se escribe antes del correo, y es la que lee el dedup.
    expect(a.claimInApp).toBe(true);
    expect(a.link).toBe('/dashboard/deudas');
  });
});

describe('un fallo no se lleva puesto al resto', () => {
  it('si el aviso de un usuario revienta, el siguiente recibe el suyo', async () => {
    notificar.mockRejectedValueOnce(new Error('boom'));
    deudasResumen.mockResolvedValue([
      deuda({ id: 'd-1', usuario_id: 'u-1' }),
      deuda({ id: 'd-2', usuario_id: 'u-2', usuarios: { ...PRO, email: 'beto@ejemplo.pe' } }),
    ]);

    await checks.checkResumenDeudasSemanal();

    expect(notificar).toHaveBeenCalledTimes(2);
    // Con rastro: sin el log, un fallo sistemático se ve igual que "nadie tenía deudas".
    expect(logMock.error.mock.calls.map((c) => c[0] && c[0].tag)).toContain('DEUDAS_SEMANAL');
  });

  it('si el claim de la campana falla, queda dicho con el tag del cron', async () => {
    // `notificarUsuario` es best-effort y NUNCA lanza: con el insert de `notificaciones` caído
    // devuelve `inApp:false`, **no manda el correo**, y el `try/catch` de este cron no se entera.
    // Sin mirar el resultado, el modo de falla más caro —perder el resumen de toda la semana—
    // dejaba como único rastro un `warn` con tag `NOTIF` que dice "se reintenta en la próxima
    // corrida", y acá la próxima corrida es dentro de siete días.
    notificar.mockResolvedValueOnce({ wa: { ok: false, skipped: 'claim_in_app_fallo' }, inApp: false, email: { ok: false, skipped: 'canal_no_declarado' } });
    deudasResumen.mockResolvedValue([
      deuda({ id: 'd-1', usuario_id: 'u-1' }),
      deuda({ id: 'd-2', usuario_id: 'u-2', usuarios: { ...PRO, email: 'beto@ejemplo.pe' } }),
    ]);

    await checks.checkResumenDeudasSemanal();

    expect(logMock.error.mock.calls.map((c) => c[0] && c[0].tag)).toContain('DEUDAS_SEMANAL');
    // Y el siguiente usuario recibe el suyo: mirar el resultado no puede cortar el barrido.
    expect(notificar).toHaveBeenCalledTimes(2);
  });

  it('si el dedup no se puede leer, se manda igual (fail open, y queda dicho)', async () => {
    // Al revés que el dedup gemelo de `checkTrialExpiry`: aquel es horario y saltearse una
    // corrida cuesta una hora; éste corre una vez por semana, y fallar cerrado lo pierde
    // siete días.
    errores.notificaciones = { message: 'boom' };
    deudasResumen.mockResolvedValue([deuda()]);

    await checks.checkResumenDeudasSemanal();

    expect(notificar).toHaveBeenCalledTimes(1);
    expect(logMock.warn.mock.calls.map((c) => c[0] && c[0].tag)).toContain('DEUDAS_SEMANAL');
  });

  it('si la población no se puede leer, no se manda nada y queda el error', async () => {
    // `obtenerDeudasParaResumenSemanal` TIRA cuando PostgREST falla, en vez de devolver []:
    // un `|| []` ahí convertiría la caída en "esta semana no vence nada", que es el silencio
    // exacto que costó 12 días en el cron de onboarding.
    deudasResumen.mockRejectedValue(new Error('PostgREST caído'));

    await checks.checkResumenDeudasSemanal();

    expect(notificar).not.toHaveBeenCalled();
    expect(logMock.error.mock.calls.map((c) => c[0] && c[0].tag)).toContain('DEUDAS_SEMANAL');
  });
});
