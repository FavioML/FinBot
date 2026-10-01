import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const handler = require('../../handlers/intents/transacciones');
const { EDICIONES, pedirOrden } = require('../../lib/orden-edicion');

/**
 * CLASE 8 (chip 5, 01-oct-2026): una edición de un movimiento que nadie pidió.
 *
 * El clasificador lee el historial y, detrás de un gasto recién anotado, manda el gasto SIGUIENTE
 * a una edición del anterior. En toda la historia de producción hubo 12 ediciones por WhatsApp y 5
 * fueron eso, a 3 personas en su día 0-2. Los cinco primeros mensajes de `MALOS` son los reales y
 * sus `datos` son los que devolvió el clasificador real con el historial real (sonda N=3). El
 * resto los encontraron las dos revisiones adversariales de las versiones anteriores, ejecutados
 * contra el handler: las puertas gemelas, el valor sacado del historial, el/la <cosa> fue N, el
 * método de pago como comercio y las colas libres.
 *
 * Lo que NO prueba: que el clasificador elija la edición. Acá se le entrega ya elegida, que es el
 * peor caso para la guarda. Las formas, una por una, están en tests/lib/orden-edicion.test.js.
 */

function makeChain(data, error = null) {
  const c = {};
  const METHODS = ['select', 'insert', 'update', 'delete', 'upsert',
    'eq', 'ilike', 'gte', 'lte', 'is', 'neq', 'not', 'order', 'limit', 'single', 'maybeSingle'];
  for (const m of METHODS) c[m] = vi.fn().mockReturnValue(c);
  c.then = (ok, ko) => Promise.resolve({ data, error }).then(ok, ko);
  c.catch = () => Promise.resolve({ data, error });
  return c;
}

const TX = {
  id: 'tx-tronco', usuario_id: 'user-001', moneda: 'PEN', monto: 25, monto_pen: 25, tipo_cambio: null,
  comercio: 'traer tronco', categoria: 'Alimentación', tipo: 'gasto',
  fecha: '2026-09-28', created_at: '2026-09-29T01:30:48Z',
};

/** `filas` es lo que devuelve la búsqueda por comercio; el último movimiento es siempre TX. */
// La ventana normal detrás de un registro: NETO acaba de confirmar "traer tronco".
const TRAS_CONFIRMAR = () => [
  { rol: 'usuario', mensaje: '25 para traer tronco', created_at: new Date(Date.now() - 60000).toISOString() },
  { rol: 'neto', mensaje: '✅ S/25.00 en Alimentación · 28-sep-26', created_at: new Date(Date.now() - 60000).toISOString() },
];

async function correr(intencion, msg, datos, { filas = [TX], historial = TRAS_CONFIRMAR() } = {}) {
  const chains = {};
  const supabase = { from: vi.fn((t) => { if (!chains[t]) chains[t] = makeChain(filas); return chains[t]; }) };
  const obtenerUltimaTransaccion = vi.fn().mockResolvedValue(TX);
  const guardarTransaccion = vi.fn().mockResolvedValue({ id: 'nueva' });
  const ctx = {
    supabase, mesActual: 9, anioActual: 2026, historialConv: historial,
    obtenerUltimaTransaccion, guardarTransaccion,
    recategorizarTransaccion: vi.fn(), guardarReglaComercio: vi.fn(), retroaplicarRegla: vi.fn(),
    corregirTransaccionEspecifica: vi.fn(),
    obtenerTipoCambio: vi.fn().mockResolvedValue({ venta: 3.4, fuente: 'test' }),
    convertirUsdAPen: (m, tc) => ({ monto_pen: m * tc.venta, tipo_cambio: tc.venta }),
    tipoCambioDeLaFila: vi.fn().mockResolvedValue({ venta: 3.4 }),
    verificarAlertaPresupuesto: vi.fn(), asegurarCategoriaUsuario: vi.fn(),
    crearSubcategoriaLibreUsuario: vi.fn(), detectarCategoriaIA: vi.fn(),
    parsearRegistroManual: vi.fn(), parsearCorreccionesMultiples: vi.fn(),
    fechaHoyPeru: () => '2026-09-28', fechaAyerPeru: () => '2026-09-27', formatFecha: (f) => f || '',
  };
  const res = await handler.handle({ intencion, msg, datos, usuario: { id: 'user-001' }, from: '51999', ctx });
  const updates = chains.transacciones ? chains.transacciones.update.mock.calls.map((c) => c[0]) : [];
  // Cada escritura hace `.update(...).select('id')`: una búsqueda es un SELECT DE MÁS.
  const busco = !!chains.transacciones && chains.transacciones.select.mock.calls.length > chains.transacciones.update.mock.calls.length;
  return { res, updates, busco, insertados: guardarTransaccion.mock.calls.length, leyoUltima: obtenerUltimaTransaccion.mock.calls.length > 0 };
}

const MALOS = [
  // Los cinco de producción.
  { msg: 'aby 143', intencion: 'editar_comercio', datos: { comercio: 'aby', comercio_nuevo: '143' } },
  { msg: 'Aby 143', intencion: 'editar_comercio', datos: { comercio_nuevo: 'Aby 143' } },
  { msg: '“145 Aby”', intencion: 'editar_monto', datos: { comercio: 'Aby', monto_nuevo: 145 } },
  { msg: 'Manos libres', intencion: 'editar_comercio', datos: { comercio_nuevo: 'Manos libres' } },
  { msg: 'El pago de 12.00 de cigarros, lo pagué con la tarjeta de crédito BCP', intencion: 'editar_comercio',
    datos: { comercio: 'cigarros', comercio_nuevo: 'tarjeta de crédito BCP' } },
  // La misma forma corta por la puerta gemela de la moneda.
  { msg: '145 dólares Aby', intencion: 'corregir_monto_moneda', datos: { monto: 145, moneda: 'USD' } },
  // Gastos nuevos con un verbo o un "fue" adentro (revisión adversarial de la primera versión).
  { msg: 'cambié 100 dólares', intencion: 'corregir_monto_moneda', datos: { monto: 100, moneda: 'USD' } },
  { msg: 'Fueron 45 en el mercado', intencion: 'editar_monto', datos: { monto_nuevo: 45 } },
  { msg: 'pon que gaste 15 en menu', intencion: 'editar_comercio', datos: { comercio_nuevo: 'menu' } },
  // El sujeto nombrado que el modelo no trajo: sin él, el S/38 caía en "traer tronco".
  { msg: 'lo del agua fueron 38', intencion: 'editar_monto', datos: { monto_nuevo: 38 } },
  // La orden existe pero el valor viene del historial, no del mensaje.
  { msg: 'quiero corregir lo último', intencion: 'editar_comercio', datos: { comercio_nuevo: 'aby 143' } },
  // Una pregunta no es una orden.
  { msg: 'el monto fue 50?', intencion: 'editar_monto', datos: { monto_nuevo: 50 } },
  // Las puertas gemelas que escribían sobre el último sin orden.
  { msg: 'me pagaron 300 por la chamba', intencion: 'marcar_como_ingreso', datos: {} },
  { msg: 'pizza 40 a medias con mi pata', intencion: 'dividir_gasto', datos: { partes: 2 } },
  { msg: 'otro taxi 15', intencion: 'duplicar_gasto', datos: {} },
  // Segunda revisión: el/la <cosa> fue N, método de pago como comercio, colas libres.
  { msg: 'la luz fue 120', intencion: 'editar_monto', datos: { monto_nuevo: 120 } },
  { msg: 'eso fue en efectivo', intencion: 'editar_comercio', datos: { comercio_nuevo: 'efectivo' } },
  { msg: 'copia de llaves 10', intencion: 'duplicar_gasto', datos: {} },
  { msg: 'cambiar dolares en la casa de cambio 350', intencion: 'corregir_monto_moneda', datos: { monto: 350, moneda: 'USD' } },
  { msg: 'ponlo como gasto 30 de luz', intencion: 'editar_monto', datos: { monto_nuevo: 30 } },
  { msg: 'el bono fue un ingreso', intencion: 'marcar_como_ingreso', datos: {} },
  { msg: 'parte del alquiler 500 entre 2', intencion: 'dividir_gasto', datos: { partes: 2 } },
  { msg: 'corrige el de ayer a 30', intencion: 'editar_monto', datos: { monto_nuevo: 30, fecha_token: 'ayer' } },
];

const LEGITIMAS = [
  // Las ocho de producción, con el valor que tiene que quedar escrito.
  { msg: '300 para ser exacto', intencion: 'editar_monto', datos: { monto_nuevo: 300 }, campo: 'monto', valor: 300 },
  { msg: 'Editar es 15800', intencion: 'editar_monto', datos: { monto_nuevo: 15800 }, campo: 'monto', valor: 15800 },
  { msg: 'Cambialo al 19 de septiembre', intencion: 'editar_fecha', datos: { fecha_nueva: '2026-09-19' }, campo: 'fecha', valor: '2026-09-19' },
  { msg: 'Cambiar fecha 29 septiembre', intencion: 'editar_fecha', datos: { fecha_nueva: '2026-09-29' }, campo: 'fecha', valor: '2026-09-29' },
  { msg: 'Cambialo a 25 de septiembre', intencion: 'editar_fecha', datos: { fecha_nueva: '2026-09-25' }, campo: 'fecha', valor: '2026-09-25' },
  { msg: 'Quiero corregir 256.40', intencion: 'editar_monto', datos: { monto_nuevo: 256.4 }, campo: 'monto', valor: 256.4 },
  { msg: 'Esa fecha es de 19 setiembre', intencion: 'editar_fecha', datos: { fecha_nueva: '2026-09-19' }, campo: 'fecha', valor: '2026-09-19' },
  { msg: 'Cambiar a 29 setiembre', intencion: 'editar_fecha', datos: { fecha_nueva: '2026-09-29' }, campo: 'fecha', valor: '2026-09-29' },
  // Del pool y de las gemelas.
  { msg: 'El comercio es Bembos pe', intencion: 'editar_comercio', datos: { comercio_nuevo: 'Bembos' }, campo: 'comercio', valor: 'Bembos' },
  { msg: 'Cambia eso a dólares no soles', intencion: 'corregir_monto_moneda', datos: { monto: 25, moneda: 'USD' }, campo: 'moneda', valor: 'USD' },
  { msg: 'Marca el último como ingreso', intencion: 'marcar_como_ingreso', datos: {}, campo: 'tipo', valor: 'ingreso' },
  { msg: 'Divide ese gasto entre 3', intencion: 'dividir_gasto', datos: { partes: 3 }, campo: 'monto', valor: 25 / 3 },
];

describe('clase 8: una edición sin orden no escribe nada', () => {
  it.each(MALOS)('"$msg" ($intencion) pregunta y no toca nada', async ({ msg, intencion, datos }) => {
    const { res, updates, insertados, leyoUltima } = await correr(intencion, msg, datos);
    expect(res).toBe(pedirOrden(intencion));
    expect(updates, 'editó una fila que nadie pidió cambiar').toEqual([]);
    expect(insertados, 'insertó un duplicado que nadie pidió').toBe(0);
    // Ni siquiera la busca: la guarda va antes de elegir la fila.
    expect(leyoUltima).toBe(false);
  });

  it.each(LEGITIMAS)('"$msg" ($intencion) sí edita', async ({ msg, intencion, datos, campo, valor }) => {
    const { res, updates } = await correr(intencion, msg, datos);
    expect(res).not.toBe(pedirOrden(intencion));
    expect(updates).toHaveLength(1);
    if (typeof valor === 'number') expect(updates[0][campo]).toBeCloseTo(valor, 2);
    else expect(updates[0][campo]).toBe(valor);
  });

  it('"duplícalo" sí duplica', async () => {
    const { insertados } = await correr('duplicar_gasto', 'duplícalo', {});
    expect(insertados).toBe(1);
  });

  it('la moneda sin monto escrito conserva el monto de la fila (no el que trajo el modelo)', async () => {
    const { updates } = await correr('corregir_monto_moneda', 'cambia eso a dólares', { monto: 145, moneda: 'USD' });
    expect(updates).toHaveLength(1);
    expect(updates[0].monto).toBe(25);
  });
});

describe('regla 1: por WhatsApp se corrige solo el último', () => {
  // La búsqueda por comercio eligió la fila equivocada en producción ("aby 143" buscó "aby", no lo
  // halló y editó "traer tronco") y la segunda revisión mostró más: "de los tacos" no matchea
  // "taco", `%pan%` encuentra "Pantalón Saga", "el de ayer" sin filas de ayer caía a la de hoy.
  // Con un sujeto en `datos`, la orden sobre el último va al último y no busca nada.
  it.each([
    ['editar_monto', 'cámbialo a 30', { comercio: 'aby', monto_nuevo: 30, fecha_token: 'ayer' }, 'monto', 30],
    ['editar_fecha', 'fue ayer', { comercio: 'Wong', fecha_nueva: '2026-09-27' }, 'fecha', '2026-09-27'],
    ['editar_comercio', 'el comercio es Metro', { comercio: 'Wong', comercio_nuevo: 'Metro' }, 'comercio', 'Metro'],
    ['marcar_como_ingreso', 'márcalo como ingreso', { comercio: 'Wong' }, 'tipo', 'ingreso'],
    ['dividir_gasto', 'divídelo entre 2', { comercio: 'Wong', partes: 2 }, 'monto', 12.5],
  ])('%s: "%s" con sujeto en datos edita el último sin buscar', async (intencion, msg, datos, campo, valor) => {
    const { updates, leyoUltima, busco } = await correr(intencion, msg, datos, { filas: [] });
    expect(leyoUltima).toBe(true);
    expect(busco, 'buscó una fila por comercio').toBe(false);
    expect(updates).toHaveLength(1);
    expect(updates[0][campo]).toBe(valor);
  });

  it('nombrar otro movimiento recibe la pregunta, sin leer ni escribir', async () => {
    const { res, updates, leyoUltima, busco } = await correr('editar_monto', 'cambia el monto de los tacos a 20', { comercio: 'taco', monto_nuevo: 20 });
    expect(res).toMatch(/Por WhatsApp corrijo solo lo último/);
    expect(updates).toEqual([]);
    expect(leyoUltima).toBe(false);
    expect(busco).toBe(false);
  });
});

describe('regla 3: la corrección elíptica detrás de una pregunta de NETO no edita', () => {
  // La tercera revisión: NETO pregunta por algo que NO guardó y la persona contesta corto. Eso
  // editaba "traer tronco", que es otro movimiento.
  const trasPregunta = (mensaje) => [
    { rol: 'usuario', mensaje: '35.00', created_at: new Date(Date.now() - 60000).toISOString() },
    { rol: 'neto', mensaje, created_at: new Date(Date.now() - 60000).toISOString() },
  ];
  it.each([
    ['marcar_como_ingreso', 'es ingreso', {}, '¿Esos S/35 entraron o salieron? Escríbemelo con el verbo: "gasté 35 en…" o "me pagaron 35".'],
    ['editar_monto', 'fueron 110.70', { monto_nuevo: 110.7 }, 'No pude leer el monto de ahí. Mándamelo con el número en dígitos y qué fue, así: "110.70 carne".'],
  ])('%s: "%s"', async (intencion, msg, datos, netoAntes) => {
    const { res, updates, leyoUltima } = await correr(intencion, msg, datos, { historial: trasPregunta(netoAntes) });
    expect(res).toBe(pedirOrden(intencion));
    expect(updates).toEqual([]);
    expect(leyoUltima).toBe(false);
  });

  it('CONTROL: la misma frase detrás de la confirmación sí edita', async () => {
    const { updates } = await correr('marcar_como_ingreso', 'es ingreso', {});
    expect(updates).toHaveLength(1);
    expect(updates[0].tipo).toBe('ingreso');
  });
});

describe('la puerta cubre las siete ediciones de un movimiento existente', () => {
  it('lista fijada', () => {
    expect([...EDICIONES].sort()).toEqual(['corregir_monto_moneda', 'dividir_gasto', 'duplicar_gasto',
      'editar_comercio', 'editar_fecha', 'editar_monto', 'marcar_como_ingreso']);
  });

  it('ningún otro intent del handler escribe sobre el último movimiento sin pasar por ella', () => {
    // El comentario de la v1 decía "una quinta edición no puede olvidarse" y dos ya estaban
    // afuera. Esto mira el CÓDIGO: todo `case` que llama a `obtenerUltimaTransaccion` y después
    // escribe, o está en EDICIONES, o está en la lista de abajo con su motivo.
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../../handlers/intents/transacciones'), 'utf8');
    const cases = src.split(/\n\s*case '/).slice(1).map((b) => ({ nombre: b.slice(0, b.indexOf("'")), cuerpo: b }));
    const FUERA = {
      // Su respuesta legítima es una palabra suelta que contesta una pregunta de NETO
      // ("gasolina"): otra forma. Chip propio, en docs/DEFECTOS.md (01-oct).
      corregir_categoria: 'otra forma, chip aparte',
      // Borrar tiene su propia guarda (`pideBorrarUnGasto` + sujeto dicho), del 14-sep.
      eliminar_transaccion: 'guarda propia', deshacer_ultimo: 'guarda propia',
    };
    const sinPuerta = cases
      .filter((c) => /obtenerUltimaTransaccion\(/.test(c.cuerpo) && /\.update\(|\.insert\(|guardarTransaccion\(|recategorizarTransaccion\(/.test(c.cuerpo))
      .map((c) => c.nombre)
      .filter((n) => !EDICIONES.has(n) && !FUERA[n]);
    expect(sinPuerta).toEqual([]);
  });
});
