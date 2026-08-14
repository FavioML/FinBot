import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'), '../..');

// Supabase chainable stub: cualquier metodo devuelve la cadena, y la cadena es
// awaitable resolviendo { data: [] } (sin historial => sin alerta de gasto inusual).
// `historial` es lo que la cadena devuelve cuando el código pide el histórico de la categoría;
// por defecto vacío (sin alerta de gasto inusual). Los tests de B17 lo siembran.
let historial = [];
let columnasPedidas = null;
function makeChain() {
  const chain = {};
  for (const m of ['eq', 'ilike', 'gte', 'neq', 'limit', 'order', 'insert', 'update']) {
    chain[m] = () => chain;
  }
  chain.select = (cols) => { columnasPedidas = cols; return chain; };
  chain.then = (resolve) => resolve({ data: historial });
  return chain;
}

const dbMock = { supabase: { from: vi.fn(() => makeChain()) } };
const waMock = { enviarWhatsapp: vi.fn().mockResolvedValue(true) };
const budgetMock = { verificarAlertaPresupuesto: vi.fn().mockResolvedValue(null) };
const notifDbMock = { crearNotificacion: vi.fn().mockResolvedValue(true) };

const dbPath = require.resolve(path.join(projectRoot, 'lib/db.js'));
const waPath = require.resolve(path.join(projectRoot, 'lib/whatsapp.js'));
const budgetPath = require.resolve(path.join(projectRoot, 'services/budget.js'));
const notifDbPath = require.resolve(path.join(projectRoot, 'lib/notifications-db.js'));

require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbMock };
require.cache[waPath] = { id: waPath, filename: waPath, loaded: true, exports: waMock };
require.cache[budgetPath] = { id: budgetPath, filename: budgetPath, loaded: true, exports: budgetMock };
require.cache[notifDbPath] = { id: notifDbPath, filename: notifDbPath, loaded: true, exports: notifDbMock };

const { enviarAlertaTransaccion } = require('../../services/notifications');

const TX = { id: 'tx1', monto_pen: 142 };
const RESULTADO = { monto: 142, comercio: 'BCP', categoria: 'Otros', tipo: 'gasto', fecha: '2026-07-14' };

describe('enviarAlertaTransaccion — opt-out alertas_transaccion', () => {
  beforeEach(() => { waMock.enviarWhatsapp.mockClear(); historial = []; columnasPedidas = null; });

  it('NO envia WhatsApp si el usuario apago las alertas (alertas_transaccion=false)', async () => {
    const usuario = { id: 'u1', whatsapp: '51999', alertas_transaccion: false };
    await enviarAlertaTransaccion(usuario, TX, RESULTADO);
    expect(waMock.enviarWhatsapp).not.toHaveBeenCalled();
  });

  it('envia WhatsApp si las alertas estan activas (alertas_transaccion=true)', async () => {
    const usuario = { id: 'u1', whatsapp: '51999', alertas_transaccion: true };
    await enviarAlertaTransaccion(usuario, TX, RESULTADO);
    expect(waMock.enviarWhatsapp).toHaveBeenCalledTimes(1);
  });

  it('envia WhatsApp si el campo no existe (usuario legacy / columna ausente)', async () => {
    const usuario = { id: 'u1', whatsapp: '51999' };
    await enviarAlertaTransaccion(usuario, TX, RESULTADO);
    expect(waMock.enviarWhatsapp).toHaveBeenCalledTimes(1);
  });

  it('la tarjeta incluye comercio, monto y categoria', async () => {
    const usuario = { id: 'u1', whatsapp: '51999', alertas_transaccion: true };
    await enviarAlertaTransaccion(usuario, TX, RESULTADO);
    const msg = waMock.enviarWhatsapp.mock.calls[0][1];
    expect(msg).toContain('Nuevo gasto');
    expect(msg).toContain('BCP');
    expect(msg).toContain('142.00');
    expect(msg).toContain('Otros');
  });

  it('no envia nada si la transaccion es invalida', async () => {
    const usuario = { id: 'u1', whatsapp: '51999', alertas_transaccion: true };
    await enviarAlertaTransaccion(usuario, null, RESULTADO);
    await enviarAlertaTransaccion(usuario, TX, { monto: null });
    expect(waMock.enviarWhatsapp).not.toHaveBeenCalled();
  });
});

/**
 * B17 (auditoría 10-ago-2026): el detector de gasto inusual promediaba `monto` CRUDO, o sea
 * mezclando soles con dólares, y después imprimía el resultado con "S/" al lado. Era el único
 * sitio del backend fuera de la convención `monto_pen`.
 *
 * Rompe en las dos direcciones y ninguna es cosmética: con suscripciones en dólares en la
 * categoría el promedio sale ~3.7x más bajo de lo real y un gasto normal dispara la alarma
 * (entrenar a ignorarla es peor que no tenerla); y un consumo grande en dólares se compara como
 * si fueran soles, así que no dispara nunca — justo el gasto que más querrías ver.
 */
describe('gasto inusual: la comparación es en soles', () => {
  const usuario = { id: 'u1', whatsapp: '51999', alertas_transaccion: true };
  const alerta = () => waMock.enviarWhatsapp.mock.calls[0]?.[1] || '';

  // `verificarAlertaPresupuesto` entra al clear porque hay una aserción de "no se llamó" más
  // abajo: sin esto arrastra las llamadas de los casos anteriores y el test falla por sucio,
  // no por el código.
  beforeEach(() => {
    waMock.enviarWhatsapp.mockClear();
    notifDbMock.crearNotificacion.mockClear();
    budgetMock.verificarAlertaPresupuesto.mockClear();
    historial = []; columnasPedidas = null;
  });

  it('pide monto_pen además de monto', () => {
    // Si la query no trae la columna, el resto del fix no puede funcionar: sería `undefined`
    // en cada fila y el `??` caería siempre al monto crudo, en silencio.
    expect(columnasPedidas).toBe(null);
    return enviarAlertaTransaccion(usuario, TX, RESULTADO).then(() => {
      expect(columnasPedidas).toContain('monto_pen');
    });
  });

  it('un historial en dólares no infla el factor de un gasto normal en soles', async () => {
    // Tres suscripciones de US$10 (≈S/37 cada una). Con `monto` crudo el promedio es 10 y un
    // gasto de S/40 sale 4.0x → alerta falsa. En soles el promedio es 37 y sale 1.08x.
    historial = [
      { monto: 10, monto_pen: 37 },
      { monto: 10, monto_pen: 37 },
      { monto: 10, monto_pen: 37 },
    ];
    await enviarAlertaTransaccion(
      usuario,
      { id: 'tx2', monto_pen: 40 },
      { monto: 40, comercio: 'Wong', categoria: 'Compras', tipo: 'gasto', fecha: '2026-08-10' },
    );
    expect(alerta()).not.toContain('Gasto inusual');
    expect(notifDbMock.crearNotificacion).not.toHaveBeenCalled();
  });

  it('un gasto grande en dólares SÍ dispara contra un historial en soles', async () => {
    // US$40 ≈ S/150 contra un promedio de S/20: 7.5x. Con `monto` crudo se comparaba 40 vs 20
    // = 2.0x y no llegaba al umbral de 2.5, así que el gasto más raro del mes pasaba callado.
    historial = [
      { monto: 20, monto_pen: 20 },
      { monto: 20, monto_pen: 20 },
      { monto: 20, monto_pen: 20 },
    ];
    await enviarAlertaTransaccion(
      usuario,
      { id: 'tx3', monto_pen: 150 },
      { monto: 40, moneda: 'USD', comercio: 'Adobe', categoria: 'Compras', tipo: 'gasto', fecha: '2026-08-10' },
    );
    expect(alerta()).toContain('Gasto inusual');
    expect(alerta()).toContain('7.5x');
    // El promedio se imprime con "S/" al lado, así que tiene que SER soles.
    expect(alerta()).toContain('S/ 20.00');
  });

  it('la notificación in-app no le pega "S/" a un monto en dólares', async () => {
    historial = [
      { monto: 20, monto_pen: 20 },
      { monto: 20, monto_pen: 20 },
      { monto: 20, monto_pen: 20 },
    ];
    await enviarAlertaTransaccion(
      usuario,
      { id: 'tx4', monto_pen: 150 },
      { monto: 40, moneda: 'USD', comercio: 'Adobe', categoria: 'Compras', tipo: 'gasto', fecha: '2026-08-10' },
    );
    const cuerpo = notifDbMock.crearNotificacion.mock.calls[0][3];
    expect(cuerpo).toContain('$40.00');
    expect(cuerpo).not.toMatch(/S\/40\.00/);
  });

  // Las dos ramas de abajo salieron de la revisión adversarial del propio fix: `monto_pen ?? monto`
  // a secas arreglaba el caso grande y dejaba vivo el mismo bug en chico, porque un null de una
  // fila en DÓLARES no se puede tratar como soles. Sin `moneda` en el select no hay forma de
  // distinguirlo, y el promedio volvía a mezclar unidades.
  it('descarta del promedio la fila USD que no tiene conversión', async () => {
    historial = [
      { monto: 100, monto_pen: null, moneda: 'USD' }, // sin conversión: no se puede comparar
      { monto: 20, monto_pen: 20, moneda: 'PEN' },
      { monto: 20, monto_pen: 20, moneda: 'PEN' },
      { monto: 20, monto_pen: 20, moneda: 'PEN' },
    ];
    await enviarAlertaTransaccion(
      usuario,
      { id: 'tx6', monto_pen: 100 },
      { monto: 100, comercio: 'Wong', categoria: 'Compras', tipo: 'gasto', fecha: '2026-08-10' },
    );
    // Promedio sobre las 3 filas en soles = 20 → 5.0x. Contando los 100 "dólares" como soles
    // el promedio sería 40 y el factor 2.5x, o sea otro número inventado.
    expect(alerta()).toContain('5.0x');
    expect(alerta()).toContain('S/ 20.00');
  });

  it('se calla si el gasto nuevo es USD y no tiene conversión', async () => {
    // No hay comparación honesta posible: comparar 40 dólares contra un promedio en soles es
    // justo el bug. Callarse es la única salida que no miente.
    historial = [
      { monto: 20, monto_pen: 20, moneda: 'PEN' },
      { monto: 20, monto_pen: 20, moneda: 'PEN' },
      { monto: 20, monto_pen: 20, moneda: 'PEN' },
    ];
    await enviarAlertaTransaccion(
      usuario,
      { id: 'tx7', monto_pen: null },
      { monto: 40, moneda: 'USD', comercio: 'Adobe', categoria: 'Compras', tipo: 'gasto', fecha: '2026-08-10' },
    );
    expect(alerta()).not.toContain('Gasto inusual');
    expect(notifDbMock.crearNotificacion).not.toHaveBeenCalled();
  });

  it('descartar filas puede dejar la muestra bajo el umbral, y entonces no decide', async () => {
    // El umbral de 3 es lo que impide que el descarte produzca un promedio sobre una o dos
    // filas — que sería peor que no alertar.
    historial = [
      { monto: 100, monto_pen: null, moneda: 'USD' },
      { monto: 100, monto_pen: null, moneda: 'USD' },
      { monto: 20, monto_pen: 20, moneda: 'PEN' },
    ];
    await enviarAlertaTransaccion(
      usuario,
      { id: 'tx8', monto_pen: 500 },
      { monto: 500, comercio: 'Wong', categoria: 'Compras', tipo: 'gasto', fecha: '2026-08-10' },
    );
    expect(alerta()).not.toContain('Gasto inusual');
  });

  // B24 (auditoría 10-ago-2026). Acá arriba había un `if (!usuario.whatsapp) return` que se
  // llevaba puesta la notificación in-app: al usuario web-first no le llegaba la alerta por
  // NINGÚN canal, ni siquiera por el único que sí lo alcanza. Estas dos aserciones son las que
  // mueren si alguien restaura ese return — la primera por lo que deja de escribirse, la
  // segunda para que el arreglo no se pase de largo y le mande un WhatsApp a un `null`.
  it('el usuario web-first (sin WhatsApp) SÍ recibe la campana de gasto inusual', async () => {
    historial = [
      { monto: 20, monto_pen: 20, moneda: 'PEN' },
      { monto: 20, monto_pen: 20, moneda: 'PEN' },
      { monto: 20, monto_pen: 20, moneda: 'PEN' },
    ];
    await enviarAlertaTransaccion(
      { id: 'uweb', whatsapp: null, alertas_transaccion: true },
      { id: 'tx9', monto_pen: 150 },
      { monto: 150, comercio: 'Wong', categoria: 'Compras', tipo: 'gasto', fecha: '2026-08-14' },
    );
    expect(notifDbMock.crearNotificacion).toHaveBeenCalledTimes(1);
    expect(notifDbMock.crearNotificacion.mock.calls[0][2]).toBe('Gasto inusual detectado');
    expect(waMock.enviarWhatsapp).not.toHaveBeenCalled();
    // La alerta de presupuesto solo existe como texto pegado al mensaje de WhatsApp: no tiene
    // canal in-app. Sin número, consultarla son dos queries cuyo resultado no se lee. Esta
    // aserción es la única que muere si se le quita el `&& usuario.whatsapp` a esa rama —
    // el resto del test pasa igual, que es cómo la línea llegó a estar sin cobertura.
    expect(budgetMock.verificarAlertaPresupuesto).not.toHaveBeenCalled();
  });

  it('el opt-out sigue apagando la campana, no solo el WhatsApp', async () => {
    // Sin esto, quitar el return temprano deja al que apagó las alertas recibiéndolas por
    // in-app: el opt-out es sobre la ALERTA, no sobre el canal.
    historial = [
      { monto: 20, monto_pen: 20, moneda: 'PEN' },
      { monto: 20, monto_pen: 20, moneda: 'PEN' },
      { monto: 20, monto_pen: 20, moneda: 'PEN' },
    ];
    await enviarAlertaTransaccion(
      { id: 'uweb', whatsapp: null, alertas_transaccion: false },
      { id: 'tx10', monto_pen: 150 },
      { monto: 150, comercio: 'Wong', categoria: 'Compras', tipo: 'gasto', fecha: '2026-08-14' },
    );
    expect(notifDbMock.crearNotificacion).not.toHaveBeenCalled();
    expect(waMock.enviarWhatsapp).not.toHaveBeenCalled();
  });

  it('una fila con monto_pen nulo cuenta igual, con su monto crudo', async () => {
    // `monto_pen` es NULLABLE a propósito (rama USD fuera de rango). Descartar esas filas
    // encogería la muestra justo en las categorías con gasto internacional, que es donde el
    // umbral de 3 filas más cerca está de no alcanzarse.
    historial = [
      { monto: 20, monto_pen: null },
      { monto: 20, monto_pen: 20 },
      { monto: 20, monto_pen: 20 },
    ];
    await enviarAlertaTransaccion(
      usuario,
      { id: 'tx5', monto_pen: 100 },
      { monto: 100, comercio: 'Wong', categoria: 'Compras', tipo: 'gasto', fecha: '2026-08-10' },
    );
    expect(alerta()).toContain('5.0x');
  });
});
