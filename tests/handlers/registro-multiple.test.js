import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * Varios movimientos en un mensaje (07-oct-2026): todos o ninguno, y nunca un ✅ de un subconjunto
 * en silencio. Ver `handlers/registro-multiple.js`.
 *
 * El parser y el separador se mockean por TEXTO: cada fragmento tiene su respuesta, porque lo que
 * se prueba es lo que el código hace con lo que devuelve el modelo, no el modelo (eso lo mide
 * `qa-e2e/qa-varios-movimientos.mjs` contra producción).
 */

const cola = vi.fn().mockResolvedValue('');
require('../../lib/trial').colaConfirmacionGasto = cola;
const { registrarVariosMovimientos, ajustarFechaRegistro, validarSeparacion, pideOtraOperacion } = require('../../handlers/registro-multiple');
const { montosDeMovimiento } = require('../../lib/nlp-guards');
const { COPY_NO_ES_MOVIMIENTO, COPY_MONEDA_NO_SOPORTADA } = require('../../handlers/intents/transacciones');

const HOY = '2026-10-07';
const G = (monto, extra = {}) => ({ ok: true, decision: 'registrar', tipo: 'gasto', monto, moneda: 'PEN', comercio: 'x', categoria: 'Otros', subcategoria: 'sin_categoria', fecha: HOY, ...extra });

function ctxCon({ partes, porTexto = {}, entero, guardar } = {}) {
  let n = 0;
  return {
    separarMovimientos: vi.fn().mockResolvedValue(partes),
    parsearRegistroManual: vi.fn(async (texto) => {
      if (texto in porTexto) {
        const r = porTexto[texto];
        if (r instanceof Error) throw r;
        return r;
      }
      return entero || { ok: true, decision: 'registrar', tipo: 'gasto', monto: 1, moneda: 'PEN' };
    }),
    guardarTransaccion: guardar || vi.fn(async (_u, d) => ({ id: 'tx-' + (++n), categoria: d.categoria, subcategoria: d.subcategoria, conteoTx: n })),
    detectarCategoriaIA: vi.fn().mockResolvedValue({ categoria: null }),
    verificarAlertaPresupuesto: vi.fn().mockResolvedValue(null),
    asegurarCategoriaUsuario: vi.fn().mockResolvedValue('nada'),
    crearSubcategoriaLibreUsuario: vi.fn().mockResolvedValue(null),
    fechaHoyPeru: () => HOY,
    formatFecha: (f) => f,
  };
}
const USUARIO = { id: 'u-1', plan: 'premium', trial_estado: 'activo' };
const correr = (msg, ctx) => registrarVariosMovimientos({ msg, montos: montosDeMovimiento(msg, { soloSeguras: true }), usuario: USUARIO, ctx });
const guardados = (ctx) => ctx.guardarTransaccion.mock.calls.map((c) => c[1]);

beforeEach(() => cola.mockClear());

describe('registra TODOS cuando todos se entienden', () => {
  const MSG = 'Recibí mil soles hoy y gasté 280 en pago de parachoque y 300 gasto de chancalatas';
  const PARTES = ['Recibí mil soles hoy', 'gasté 280 en pago de parachoque', '300 gasto de chancalatas'];

  it('una fila por movimiento, con su monto, tipo y moneda, y un ✅ por fila', async () => {
    const ctx = ctxCon({ partes: PARTES, porTexto: {
      'Recibí mil soles hoy': G(1000, { tipo: 'ingreso' }),
      'gasté 280 en pago de parachoque': G(280),
      '300 gasto de chancalatas': G(300),
    } });
    const r = await correr(MSG, ctx);
    expect(guardados(ctx).map((d) => [d.monto, d.tipo, d.moneda])).toEqual([[1000, 'ingreso', 'PEN'], [280, 'gasto', 'PEN'], [300, 'gasto', 'PEN']]);
    expect(r.split('✅').length - 1).toBe(3);
    expect(r).toContain('S/1000.00 en Ingresos');
    expect(ctx.registroMultiple).toBe(true);
  });

  it('respeta los dólares dichos', async () => {
    const ctx = ctxCon({ partes: ['gasté $20 en taxi', '$5 en café'], porTexto: {
      'gasté $20 en taxi': G(20, { moneda: 'USD' }), '$5 en café': G(5, { moneda: 'USD' }),
    } });
    const r = await correr('gasté $20 en taxi y $5 en café', ctx);
    expect(guardados(ctx).map((d) => d.moneda)).toEqual(['USD', 'USD']);
    expect(r).toContain('$20.00');
  });

  it('los guards de fecha corren sobre el texto de CADA movimiento', async () => {
    const ctx = ctxCon({ partes: ['gasté 70 en juguetes', '34.5 en el almuerzo'], porTexto: {
      // fechas alucinadas sin mención: el TZ guard las vuelve hoy
      'gasté 70 en juguetes': G(70, { fecha: '2026-10-01' }), '34.5 en el almuerzo': G(34.5, { fecha: '2026-09-01' }),
    } });
    await correr('gasté 70 en juguetes y 34.5 en el almuerzo', ctx);
    expect(guardados(ctx).map((d) => d.fecha)).toEqual([HOY, HOY]);
  });

  // Quinta revisión: el separador real no siempre repite la fecha ("ayer menú 12, gaseosa 3" →
  // "gaseosa 3", 3 de 3) y la gaseosa salía con fecha de hoy.
  it.each([
    ['ayer menú 12, gaseosa 3', ['ayer menú 12', 'gaseosa 3'], 'ayer gaseosa 3'],
    ['antier pan 5 y leche 6', ['antier pan 5', 'leche 6'], 'antier leche 6'],
    ['antes de ayer pan 5 y leche 6', ['antes de ayer pan 5', 'leche 6'], 'antes de ayer leche 6'],
  ])('la fecha dicha una vez al principio vale para todos: %s', async (msg, partes, esperado) => {
    const ctx = ctxCon({ partes });
    await correr(msg, ctx);
    expect(ctx.parsearRegistroManual.mock.calls.map((c) => c[0])).toContain(esperado);
  });

  it('una fecha que puede ser sólo de uno no se reparte: se pregunta', async () => {
    const ctx = ctxCon({ partes: ['70 que realice ayer en juguetes', '34.5 en el almuerzo'], porTexto: {
      '70 que realice ayer en juguetes': G(70, { fecha: '2026-10-06' }), '34.5 en el almuerzo': G(34.5),
    } });
    const r = await correr('70 que realice ayer en juguetes y 34.5 en el almuerzo', ctx);
    expect(ctx.guardarTransaccion).not.toHaveBeenCalled();
    expect(r).toContain('«34.5 en el almuerzo»: no sé de qué día es');
  });

  it('con dos fechas al principio, la ventana sin fecha tampoco elige: se pregunta', async () => {
    const ctx = ctxCon({ partes: ['ayer o antier menú 12', 'gaseosa 3'], porTexto: { 'ayer o antier menú 12': G(12), 'gaseosa 3': G(3) } });
    const r = await correr('ayer o antier menú 12, gaseosa 3', ctx);
    expect(ctx.guardarTransaccion).not.toHaveBeenCalled();
    expect(r).toContain('«gaseosa 3»: no sé de qué día es');
  });

  // Revisión del arreglo de fechas (07-oct): cuatro casos que la primera versión resolvía mal.
  it.each([
    // "hoy" cuenta como segunda fecha: la gaseosa no recibe "ayer", se pregunta
    ['ayer menú 12, hoy taxi 5 y gaseosa 3', ['ayer menú 12', 'hoy taxi 5', 'gaseosa 3'], 2, null],
    // "para el sábado" es de otra cosa: no se presta, se pregunta
    ['compré las entradas para el sábado 60 y la cena 45', ['compré las entradas para el sábado 60', 'la cena 45'], 1, null],
    // "en la noche" a secas recibe la fecha del día dicho antes
    ['ayer almuerzo 15 y en la noche pollo 30', ['ayer almuerzo 15', 'en la noche pollo 30'], -1, 'ayer en la noche pollo 30'],
    // "el 20 de luz" es un monto, no una fecha: no se presta
    ['pagué el 20 de luz y 15 de agua', ['pagué el 20 de luz', '15 de agua'], -1, '15 de agua'],
  ])('%s', (msg, partes, dudosa, paraParser) => {
    const r = validarSeparacion(partes, msg);
    expect(r).toHaveLength(partes.length);
    r.forEach((x, i) => expect(!!x.fechaDudosa, 'ventana ' + i).toBe(i === dudosa));
    if (paraParser) expect(r.map((x) => x.paraParser)).toContain(paraParser);
  });

  it('"hoy" no obliga a nada: es la fecha que el parser pone igual', async () => {
    const ctx = ctxCon({ partes: ['Recibí mil soles hoy', 'gasté 280 en pago de parachoque'], porTexto: {
      'Recibí mil soles hoy': G(1000, { tipo: 'ingreso' }), 'gasté 280 en pago de parachoque': G(280),
    } });
    await correr('Recibí mil soles hoy y gasté 280 en pago de parachoque', ctx);
    expect(ctx.guardarTransaccion).toHaveBeenCalledTimes(2);
  });

  it('la categoría del clasificador pisa la del parser, como en el camino de uno', async () => {
    const ctx = ctxCon({ partes: ['pan 3', 'leche 5'], porTexto: { 'pan 3': G(3), 'leche 5': G(5) } });
    ctx.detectarCategoriaIA.mockResolvedValue({ categoria: 'Alimentación', subcategoria: 'mercado' });
    await correr('pan 3 leche 5', ctx);
    expect(guardados(ctx).map((d) => d.categoria)).toEqual(['Alimentación', 'Alimentación']);
    expect(ctx.detectarCategoriaIA.mock.calls.map((c) => c[0])).toEqual(['pan 3', 'leche 5']);
  });

  it('el trial que arranca un movimiento llega a la cola y al ctx', async () => {
    const guardar = vi.fn()
      .mockResolvedValueOnce({ id: 'a', trialIniciado: true, trialVence: '2026-10-21', conteoTx: 1 })
      .mockResolvedValueOnce({ id: 'b', conteoTx: 2 });
    const ctx = ctxCon({ partes: ['pan 3', 'leche 5'], porTexto: { 'pan 3': G(3), 'leche 5': G(5) }, guardar });
    await correr('pan 3 leche 5', ctx);
    expect(ctx.trialRecienIniciado).toEqual({ vence: '2026-10-21' });
    expect(cola.mock.calls[0][1]).toMatchObject({ id: 'a' });
    expect(cola.mock.calls[0][2]).toBe(2);
  });
});

describe('NO escribe ninguno si uno no se entiende, y nombra cuál', () => {
  const MSG = 'Gaste 2 soles más en pasajes, gaste 1.30 en cigarros y preste 118 soles';
  const PARTES = ['Gaste 2 soles más en pasajes', 'gaste 1.30 en cigarros', 'preste 118 soles'];
  const OK = { 'Gaste 2 soles más en pasajes': G(2), 'gaste 1.30 en cigarros': G(1.3) };

  const casos = [
    ['tipo_dudoso', { ok: false, decision: 'tipo_dudoso', monto: 0, monto_dudoso: 118 }, 'entró o salió'],
    ['no_es_movimiento', { ok: false, decision: 'no_es_movimiento', monto: 0 }, 'no parece plata'],
    ['sin_monto', { ok: false, decision: 'sin_monto', monto: 0 }, 'monto'],
    ['moneda no soportada', G(118, { moneda: 'EUR' }), 'soles y dólares'],
    ['monto distinto del escrito', G(18), 'monto'],
    ['tipo que contradice el verbo', G(118, { tipo: 'ingreso' }), null],
    ['parser que lanza', new Error('refusal'), 'monto'],
  ];
  it.each(casos)('%s', async (_n, respuesta, motivo) => {
    const texto3 = _n === 'tipo que contradice el verbo' ? 'gaste 118 soles' : 'preste 118 soles';
    const msg = _n === 'tipo que contradice el verbo' ? MSG.replace('preste 118 soles', 'gaste 118 soles') : MSG;
    const ctx = ctxCon({ partes: [PARTES[0], PARTES[1], texto3], porTexto: { ...OK, [texto3]: respuesta } });
    const r = await correr(msg, ctx);
    expect(ctx.guardarTransaccion).not.toHaveBeenCalled();
    expect(r).toContain('No anoté ninguno de los 3 movimientos');
    expect(r).toContain('S/2, S/1.30 y S/118');
    expect(r).toContain('«' + texto3 + '»');
    if (motivo) expect(r).toContain(motivo);
    // los que sí se entendieron no se listan como problema
    expect(r).not.toContain('«Gaste 2 soles más en pasajes»');
  });

  // Sonda local del 07-oct: el pedazo "uno de 500 soles en regalos" perdía la palabra "ingreso" y
  // entraba como GASTO en 2 de 3 corridas. El mensaje sólo nombra ingresos.
  it('un pedazo con el signo contrario al único que dice el mensaje', async () => {
    const msg = 'Registra un ingreso de 200 USD y también uno de 500 soles en regalos';
    const ctx = ctxCon({ partes: ['Registra un ingreso de 200 USD', 'uno de 500 soles en regalos'], porTexto: {
      'Registra un ingreso de 200 USD': G(200, { tipo: 'ingreso', moneda: 'USD' }),
      'uno de 500 soles en regalos': G(500),
    } });
    const r = await correr(msg, ctx);
    expect(ctx.guardarTransaccion).not.toHaveBeenCalled();
    expect(r).toContain('«uno de 500 soles en regalos»: no sé si esa plata entró o salió');
  });

  it('con los dos sentidos en el mensaje, cada pedazo decide el suyo', async () => {
    const ctx = ctxCon({ partes: ['me pagaron 300', 'gasté 120 en zapatillas'], porTexto: {
      'me pagaron 300': G(300, { tipo: 'ingreso' }), 'gasté 120 en zapatillas': G(120),
    } });
    await correr('me pagaron 300 y gasté 120 en zapatillas', ctx);
    expect(guardados(ctx).map((d) => d.tipo)).toEqual(['ingreso', 'gasto']);
  });

  it('dólares pegados que el parser leyó como soles', async () => {
    const ctx = ctxCon({ partes: ['gasté $20 en taxi', '$5 en café'], porTexto: { 'gasté $20 en taxi': G(20), '$5 en café': G(5, { moneda: 'USD' }) } });
    const r = await correr('gasté $20 en taxi y $5 en café', ctx);
    expect(ctx.guardarTransaccion).not.toHaveBeenCalled();
    expect(r).toContain('soles o dólares');
  });

  it('dólares que nadie dijo', async () => {
    const ctx = ctxCon({ partes: ['pan 3', 'leche 5'], porTexto: { 'pan 3': G(3), 'leche 5': G(5, { moneda: 'USD' }) } });
    await correr('pan 3 leche 5', ctx);
    expect(ctx.guardarTransaccion).not.toHaveBeenCalled();
  });
});

describe('la separación se valida contra el mensaje', () => {
  const MSG = 'pan 3 leche 5';
  const ok = { 'pan 3': G(3), 'leche 5': G(5) };
  it.each([
    ['no contestó', null],
    ['juntó dos montos en un texto', ['pan 3 leche 5']],
    ['perdió uno', ['pan 3']],
    ['inventó una palabra', ['pan 3', 'leche 5 soles']],
    ['inventó una cifra', ['pan 3', 'leche 50']],
    ['partió un monto en dos', ['pan 3', 'leche 5', 'leche 5']],
    ['repitió uno y perdió otro', ['pan 3', 'pan 3']],
  ])('%s: no escribe nada y nombra los montos', async (_n, partes) => {
    const ctx = ctxCon({ partes, porTexto: ok });
    const r = await correr(MSG, ctx);
    expect(ctx.guardarTransaccion).not.toHaveBeenCalled();
    expect(r).toContain('no supe separarlos');
    expect(r).toContain('S/3 y S/5');
  });

  // Dos casos donde las otras validaciones NO alcanzan, a propósito: los montos cuadran igual.
  it('una cifra que el mensaje no tiene, aunque no sea un monto (una fecha inventada)', async () => {
    const ctx = ctxCon({ partes: ['el pan 3', 'la leche 5 el 05/10'], porTexto: { 'el pan 3': G(3), 'la leche 5 el 05/10': G(5) } });
    const r = await correr('el pan 3 y la leche 5', ctx);
    expect(ctx.guardarTransaccion).not.toHaveBeenCalled();
    expect(r).toContain('no supe separarlos');
  });

  it('un texto con dos montos no es una separación, aunque el total cuadre', async () => {
    const ctx = ctxCon({ partes: ['pan 3 leche 5', 'leche 5', 'taxi 7'], porTexto: { 'pan 3 leche 5': G(3), 'leche 5': G(5), 'taxi 7': G(7) } });
    const r = await correr('pan 3 leche 5 taxi 7', ctx);
    expect(ctx.guardarTransaccion).not.toHaveBeenCalled();
    expect(r).toContain('no supe separarlos');
  });

  it('el separador que lanza no escribe nada', async () => {
    const ctx = ctxCon({ partes: ['pan 3', 'leche 5'], porTexto: ok });
    ctx.separarMovimientos.mockRejectedValue(new Error('timeout'));
    const r = await correr(MSG, ctx);
    expect(ctx.guardarTransaccion).not.toHaveBeenCalled();
    expect(r).toContain('no supe separarlos');
  });

  it('control: repetir la FECHA dicha una vez sí vale', async () => {
    const ctx = ctxCon({ partes: ['ayer gasté 20 en taxi', 'ayer 30 en cine'], porTexto: {
      'ayer gasté 20 en taxi': G(20), 'ayer 30 en cine': G(30),
    } });
    await correr('ayer gasté 20 en taxi y 30 en cine', ctx);
    expect(ctx.guardarTransaccion).toHaveBeenCalledTimes(2);
  });

  it('validarSeparacion usa cada monto del mensaje una sola vez', () => {
    const msg = 'taxi 5 y pasaje 5';
    expect(validarSeparacion(['taxi 5', 'pasaje 5'], msg)).toHaveLength(2);
    expect(validarSeparacion(['taxi 5', 'taxi 5', 'pasaje 5'], msg)).toBeNull();
    expect(validarSeparacion(['taxi 5', 'taxi 5'], msg)).toBeNull();
  });
});

/**
 * Los ataques de la revisión adversarial del 07-oct, con la salida del separador que los produce.
 * Con la validación por "bolsa de palabras" los cinco escribían plata con el monto, el signo, la
 * fecha o la moneda cruzados. Cada texto tiene que ser una VENTANA del mensaje alrededor de su monto.
 */
describe('el separador no puede mover nada entre movimientos', () => {
  const todoRegistra = (partes, porMonto) => Object.fromEntries(partes.map((p, i) => [p, porMonto[i]]));
  it.each([
    ['montos cruzados entre ingreso y gasto', 'me pagaron 300 y compré zapatillas por 120',
      ['me pagaron 120', 'compré zapatillas por 300'], [G(120, { tipo: 'ingreso' }), G(300)]],
    ['un verbo trasplantado ("cobré" al alquiler)', 'cobré 500, gasté 100 en taxi y 200 en alquiler',
      ['cobré 500', 'gasté 100 en taxi', 'cobré 200 en alquiler'], [G(500, { tipo: 'ingreso' }), G(100), G(200, { tipo: 'ingreso' })]],
    ['una fecha trasplantada ("ayer" a lo de hoy)', 'ayer gasté 20 en taxi y hoy 30 en cine',
      ['ayer gasté 20 en taxi', 'ayer gasté 30 en cine'], [G(20), G(30)]],
    ['monedas cruzadas', 'gasté 20 dólares en taxi y 20 soles en cine',
      ['gasté 20 soles en taxi', '20 dólares en cine'], [G(20), G(20, { moneda: 'USD' })]],
    ['un "$" que el monto no tenía', 'gasté $20 en taxi y 30 en el mercado',
      ['gasté $20 en taxi', 'gasté $30 en el mercado'], [G(20, { moneda: 'USD' }), G(30, { moneda: 'USD' })]],
    ['los montos en otro orden', 'taxi 8 cine 25', ['cine 25', 'taxi 8'], [G(25), G(8)]],
    // segunda revisión: verbos y fechas que ninguna lista conoce
    ['"me pagaron" prestado por encima de "le di"', 'Me pagaron 300 y le di 100 a mi mamá',
      ['Me pagaron 300', 'Me pagaron 100 a mi mamá'], [G(300, { tipo: 'ingreso' }), G(100, { tipo: 'ingreso' })]],
    ['"cobré" prestado por encima de "mandé"', 'cobré 500 y mandé 200 a mi mamá',
      ['cobré 500', 'cobré 200 a mi mamá'], [G(500, { tipo: 'ingreso' }), G(200, { tipo: 'ingreso' })]],
    ['"el sábado" prestado por encima de "anoche"', 'el sábado gasté 40 en cine y anoche 25 en pizza',
      ['el sábado gasté 40 en cine', 'el sábado gasté 25 en pizza'], [G(40), G(25)]],
    ['una ventana que se estira hasta el verbo siguiente', 'cobré 500 y gasté 100 en taxi',
      ['cobré 500 y gasté', '100 en taxi'], [G(500), G(100)]],
    ['un sustantivo prestado como prefijo', 'taxi 5 y pasaje 5', ['taxi 5', 'taxi 5'], [G(5), G(5)]],
    ['un sustantivo prestado aunque todo quede cubierto', 'taxi 5 y 8', ['taxi 5', 'taxi 8'], [G(5), G(8)]],
    // tercera revisión: una fecha atrás sólo vale si es la del texto siguiente
    ['una fecha atrás que no es la del siguiente', 'gasté 20 en taxi ayer y 30 en cine',
      ['gasté 20 en taxi ayer', '30 en cine ayer'], [G(20), G(30)]],
    ['un texto que deja una palabra sin cubrir', 'gasté 20 en taxi y luego compré 30 en cine',
      ['gasté 20 en taxi', '30 en cine'], [G(20), G(30)]],
  ])('%s', async (_n, msg, partes, parseos) => {
    const ctx = ctxCon({ partes, porTexto: todoRegistra(partes, parseos) });
    const r = await correr(msg, ctx);
    expect(ctx.guardarTransaccion).not.toHaveBeenCalled();
    expect(r).toContain('no supe separarlos');
  });

  // Tercera revisión: un verbo que el separador repite puede ser el contrario del que la persona
  // elidió ("Cobré 1500 de sueldo y 80 de luz" → "Cobré 80 de luz" salía INGRESO). El separador puede
  // repetirlo, pero el parser NUNCA lo ve: recibe la ventana del mensaje sola.
  it.each([
    ['Cobré 1500 de sueldo y 80 de luz', ['Cobré 1500 de sueldo', 'Cobré 80 de luz'], '80 de luz'],
    ['Gasté 50 en taxi y 300 de sueldo', ['Gasté 50 en taxi', 'Gasté 300 de sueldo'], '300 de sueldo'],
    ['Me pagaron 300 y le di 100 a mi mamá', ['Me pagaron 300', 'Me pagaron le di 100 a mi mamá'], 'le di 100 a mi mamá'],
  ])('el verbo prestado no llega al parser: %s', async (msg, partes, ventana) => {
    const ctx = ctxCon({ partes });
    await correr(msg, ctx);
    const vistos = ctx.parsearRegistroManual.mock.calls.map((c) => c[0]);
    expect(vistos).toContain(ventana);
    expect(vistos).not.toContain(partes[1]);
  });

  it('un sufijo prestado es sólo una fecha, y la del texto siguiente', () => {
    // un verbo atrás no se presta
    expect(validarSeparacion(['taxi 20 pagué', 'cine 30 pagué'], 'taxi 20 y cine 30 pagué')).toBeNull();
    // una fecha que el texto siguiente no tiene (y el mensaje tampoco) no se presta
    expect(validarSeparacion(['gasté 20 en taxi ayer', '30 en cine hoy'], 'gasté 20 en taxi y 30 en cine hoy')).toBeNull();
    // control
    expect(validarSeparacion(['gasté 20 en taxi hoy', '30 en cine hoy'], 'gasté 20 en taxi y 30 en cine hoy')).toHaveLength(2);
  });

  it('la fecha prestada decide la fecha guardada', async () => {
    const ctx = ctxCon({ partes: ['ayer gasté 20 en taxi', 'ayer gasté 30 en cine'], porTexto: {
      'ayer gasté 20 en taxi': G(20, { fecha: '2026-10-06' }), 'ayer 30 en cine': G(30, { fecha: '2026-10-06' }),
    } });
    await correr('ayer gasté 20 en taxi y 30 en cine', ctx);
    expect(guardados(ctx).map((d) => d.fecha)).toEqual(['2026-10-06', '2026-10-06']);
  });

  it('la fecha prestada sí llega al parser, adelante y atrás', async () => {
    const ctx = ctxCon({ partes: ['ayer gasté 20 en taxi', 'ayer gasté 30 en cine'] });
    await correr('ayer gasté 20 en taxi y 30 en cine', ctx);
    expect(ctx.parsearRegistroManual.mock.calls.map((c) => c[0])).toContain('ayer 30 en cine');
    const ctx2 = ctxCon({ partes: ['gasté 20 en taxi ayer', '30 en cine ayer'] });
    await correr('gasté 20 en taxi y 30 en cine ayer', ctx2);
    expect(ctx2.parsearRegistroManual.mock.calls.map((c) => c[0])).toContain('gasté 20 en taxi ayer');
  });

  it('controles: separaciones buenas (la fecha repetida adelante o atrás) pasan', async () => {
    const casos = [
      ['Gaste 2.50 en el desayuno, 15 en el almuerzo y 13 en la cena', ['Gaste 2.50 en el desayuno', '15 en el almuerzo', '13 en la cena']],
      ['taxi 8 cine 25', ['taxi 8', 'cine 25']],
      ['ayer gasté 20 en taxi y 30 en cine', ['ayer gasté 20 en taxi', 'ayer 30 en cine']],
      ['gasté 20 en taxi y 30 en cine ayer', ['gasté 20 en taxi ayer', '30 en cine ayer']],
      ['Recibí mil soles hoy y gasté 280 en pago de parachoque y 300 gasto de chancalatas',
        ['Recibí mil soles hoy', 'gasté 280 en pago de parachoque', '300 gasto de chancalatas']],
      // el separador dice que "alquiler depa 800" es un movimiento aunque la heurística de "depa N" lo tape
      ['alquiler depa 800 y luz 120', ['alquiler depa 800', 'luz 120']],
      // una cantidad que la heurística explica queda adentro de su ventana
      ['Pago 847 de 3 celulares Entel', ['Pago 847 de 3 celulares Entel']],
      ['me dieron 300 de gratificación y 100 de bono', ['me dieron 300 de gratificación', '100 de bono']],
    ];
    for (const [msg, partes] of casos) {
      expect(validarSeparacion(partes, msg), msg).toHaveLength(partes.length);
    }
  });

  // Para perder un monto en silencio tienen que equivocarse los dos: el separador lo deja adentro de
  // otra ventana Y la heurística lo tapa. Si sólo uno de los dos lo suelta, no se escribe.
  it('con una cantidad adentro, el monto de la ventana es el que ve el contador fino', () => {
    const r = validarSeparacion(['compré 2 polos por 60'], 'compré 2 polos por 60');
    expect(r).toHaveLength(1);
    expect(r[0].montoMsg.valor).toBe(60);
  });

  // Tercera revisión: el separador y la heurística de "número de nombre" se equivocan JUNTOS (el
  // prompt dice lo mismo que la heurística), así que una ventana con otro número no puede cruzar
  // una coma, un salto de línea o un "y": ahí son dos movimientos.
  it.each([
    ['taxi 8, recargué la línea 10'],
    ['Menú 12\nrecarga línea 10'],
    ['Le pagué a Julio 50 y gasté 20 en taxi'],
  ])('una ventana con dos números a los dos lados de un corte no pasa: %s', (msg) => {
    expect(validarSeparacion([msg], msg)).toBeNull();
  });

  it('un monto que el contador fino ve no puede quedar sin dueño', () => {
    expect(validarSeparacion(['pan 3 leche 5'], 'pan 3 leche 5')).toBeNull();
    expect(validarSeparacion(['polo 35, medias 15'], 'polo 35, medias 15')).toBeNull();
  });
});

describe('el mensaje ENTERO decide antes de partir', () => {
  it('si no es un movimiento (un saldo), no se parte ni se escribe', async () => {
    const ctx = ctxCon({ partes: ['yape 156.40', 'Plin 100'], entero: { ok: false, decision: 'no_es_movimiento', monto: 0 },
      porTexto: { 'yape 156.40': G(156.4), 'Plin 100': G(100) } });
    const r = await correr('Eso lo tengo yape 156.40 y Plin 100', ctx);
    expect(r).toBe(COPY_NO_ES_MOVIMIENTO);
    expect(ctx.guardarTransaccion).not.toHaveBeenCalled();
  });

  it('otra moneda en el mensaje entero', async () => {
    const ctx = ctxCon({ partes: ['20 euros en taxi', '30 en cine'], entero: { ok: true, decision: 'registrar', monto: 20, moneda: 'EUR' } });
    expect(await correr('20 euros en taxi y 30 en cine', ctx)).toBe(COPY_MONEDA_NO_SOPORTADA);
    expect(ctx.guardarTransaccion).not.toHaveBeenCalled();
  });

  it('si el parser del mensaje entero falla, se decide por partes', async () => {
    const ctx = ctxCon({ partes: ['pan 3', 'leche 5'], porTexto: { 'pan 3 leche 5': new Error('refusal'), 'pan 3': G(3), 'leche 5': G(5) } });
    await correr('pan 3 leche 5', ctx);
    expect(ctx.guardarTransaccion).toHaveBeenCalledTimes(2);
  });
});

describe('cuando falla la base, se nombra lo que no quedó', () => {
  it('un guardado que falla se nombra y los demás quedan con su ✅', async () => {
    const guardar = vi.fn()
      .mockResolvedValueOnce({ id: 'a' })
      .mockRejectedValueOnce(new Error('db caída'))
      .mockResolvedValueOnce({ id: 'c' });
    const ctx = ctxCon({ partes: ['taxi 1', 'pan 2', 'cine 3'], porTexto: { 'taxi 1': G(1), 'pan 2': G(2), 'cine 3': G(3) }, guardar });
    const r = await correr('taxi 1 pan 2 cine 3', ctx);
    expect(r.split('✅').length - 1).toBe(2);
    expect(r).toContain('⚠️ «pan 2» no lo pude guardar');
  });

  it('un guardado que devuelve null también se nombra', async () => {
    const guardar = vi.fn().mockResolvedValueOnce({ id: 'a' }).mockResolvedValueOnce(null);
    const ctx = ctxCon({ partes: ['taxi 1', 'pan 2'], porTexto: { 'taxi 1': G(1), 'pan 2': G(2) }, guardar });
    const r = await correr('taxi 1 pan 2', ctx);
    expect(r).toContain('⚠️ «pan 2» no lo pude guardar');
  });

  it('dos idénticos que el dedup juntó en una fila: se dice', async () => {
    const guardar = vi.fn().mockResolvedValue({ id: 'misma' });
    const ctx = ctxCon({ partes: ['pasaje 2', 'pasaje 2'], porTexto: { 'pasaje 2': G(2) }, guardar });
    const r = await correr('pasaje 2 y pasaje 2', ctx);
    expect(r.split('✅').length - 1).toBe(1);
    expect(r).toContain('lo anoté una sola vez');
  });
});

describe('lo que pasa después de escribir', () => {
  it('si la cola de la confirmación lanza, igual se ve lo que se anotó', async () => {
    cola.mockRejectedValueOnce(new Error('trial caído'));
    const ctx = ctxCon({ partes: ['pan 3', 'leche 5'], porTexto: { 'pan 3': G(3), 'leche 5': G(5) } });
    const r = await correr('pan 3 leche 5', ctx);
    expect(r.split('✅').length - 1).toBe(2);
  });

  it('la métrica no cuenta a los usuarios de prueba', async () => {
    const analytics = require('../../lib/analytics');
    const real = analytics.capture;
    analytics.capture = vi.fn();
    try {
      const ctx = ctxCon({ partes: ['pan 3', 'leche 5'], porTexto: { 'pan 3': G(3), 'leche 5': G(5) } });
      await registrarVariosMovimientos({ msg: 'pan 3 leche 5', montos: montosDeMovimiento('pan 3 leche 5', { soloSeguras: true }), usuario: { ...USUARIO, is_test_user: true }, ctx });
      expect(analytics.capture).not.toHaveBeenCalled();
      const ctx2 = ctxCon({ partes: ['pan 3', 'leche 5'], porTexto: { 'pan 3': G(3), 'leche 5': G(5) } });
      await correr('pan 3 leche 5', ctx2);
      expect(analytics.capture).toHaveBeenCalledWith('u-1', 'wa_multi_movimiento', expect.objectContaining({ resultado: 'registrado' }));
    } finally {
      analytics.capture = real;
    }
  });
});

describe('ajustarFechaRegistro: los tres guards de fecha', () => {
  it('fecha relativa: "ayer" con la fecha del modelo equivocada', () => {
    expect(ajustarFechaRegistro('gasté 20 ayer', '2026-10-01', HOY)).toBe('2026-10-06');
  });
  it('día de semana pasado', () => {
    // 07-oct-2026 es miércoles: "el lunes" es el 05.
    expect(ajustarFechaRegistro('gasté 20 el lunes pasado', '2026-10-01', HOY)).toBe('2026-10-05');
  });
  it('fecha inventada sin mención: hoy', () => {
    expect(ajustarFechaRegistro('gasté 20 en taxi', '2026-03-01', HOY)).toBe(HOY);
  });
  it('fecha dicha: se respeta', () => {
    expect(ajustarFechaRegistro('gasté 20 en taxi el 05/10', '2026-10-05', HOY)).toBe('2026-10-05');
  });
});

describe('pideOtraOperacion: sólo la orden, no la palabra', () => {
  it.each([
    ['gasté 50 en taxi y cambia el de 30 a 40', true],
    ['gasté 20 en pan, borra el último', true],
    ['gasté 20 en pan y porfa elimina lo de ayer', true],
    // segunda revisión adversarial: estos son DOS gastos y antes se iban al camino de uno
    ['gasté 30 en el cambio de aceite y 15 en taxi', false],
    ['compré borrador 2 y lápiz 1.50', false],
    ['pagué 100 a la modista por corregir el vestido y 20 de taxi', false],
    ['me quitaron 50 de comisión y pagué 20 de taxi', false],
    ['gasté 15 en taxi y cambié la llanta por 30', false],
    ['gasté 40 en entradas para las eliminatorias y 10 en cancha', false],
  ])('%s', (msg, esperado) => expect(pideOtraOperacion(msg)).toBe(esperado));
});

describe('lo que no se anota se dice', () => {
  it('el número de una ventana que no es su monto se nombra en la confirmación', async () => {
    const msg = 'Pagué 25 de la recarga de la línea 10';
    const ctx = ctxCon({ partes: [msg], porTexto: { [msg]: G(25) } });
    const r = await correr(msg, ctx);
    expect(guardados(ctx).map((d) => d.monto)).toEqual([25]);
    expect(r).toContain('No anoté como plata el 10 de «Pagué 25 de la recarga de la línea 10»');
  });

  it('una cantidad ("3 celulares") se anota sin nota', async () => {
    const msg = 'Pago 847 de 3 celulares Entel';
    const ctx = ctxCon({ partes: [msg], porTexto: { [msg]: G(847) } });
    const r = await correr(msg, ctx);
    expect(guardados(ctx).map((d) => d.monto)).toEqual([847]);
    expect(r).not.toContain('No anoté como plata');
  });

  it('sin números de más, no hay nota', async () => {
    const ctx = ctxCon({ partes: ['pan 3', 'leche 5'], porTexto: { 'pan 3': G(3), 'leche 5': G(5) } });
    expect(await correr('pan 3 leche 5', ctx)).not.toContain('No anoté como plata');
  });

  it('un monto que guardarTransaccion rechazaría no llega a escribirse a medias', async () => {
    const ctx = ctxCon({ partes: ['taxi 5', 'casa 1000000'], porTexto: { 'taxi 5': G(5), 'casa 1000000': G(1000000) } });
    const r = await correr('taxi 5 casa 1000000', ctx);
    expect(ctx.guardarTransaccion).not.toHaveBeenCalled();
    expect(r).toContain('«casa 1000000»');
  });
});

/**
 * Cuarta revisión adversarial del 07-oct: el parser recibe la ventana SIN el verbo prestado, y con
 * eso aparecieron dos riesgos que se cierran acá.
 */
describe('cuarta revisión', () => {
  it('con los dos sentidos, una ventana sin verbo propio sigue al último verbo que la precede', async () => {
    const msg = 'Me yapearon 50 de la cena y 30 del taxi, pagué 20 de luz';
    const partes = ['Me yapearon 50 de la cena', 'Me yapearon 30 del taxi', 'pagué 20 de luz'];
    const ctx = ctxCon({ partes, porTexto: {
      'Me yapearon 50 de la cena': G(50, { tipo: 'ingreso' }), '30 del taxi': G(30), 'pagué 20 de luz': G(20),
    } });
    const r = await correr(msg, ctx);
    expect(ctx.guardarTransaccion).not.toHaveBeenCalled();
    expect(r).toContain('«30 del taxi»: no sé si esa plata entró o salió');
  });

  it('un verbo que ninguna lista conoce ("reembolsaron") también manda sobre la ventana siguiente', async () => {
    const ctx = ctxCon({ partes: ['me reembolsaron clínica 80', 'farmacia 20'], porTexto: {
      'me reembolsaron clínica 80': G(80, { tipo: 'ingreso' }), 'farmacia 20': G(20),
    } });
    const r = await correr('me reembolsaron clínica 80, farmacia 20', ctx);
    expect(ctx.guardarTransaccion).not.toHaveBeenCalled();
    expect(r).toContain('«farmacia 20»: no sé si esa plata entró o salió');
  });

  it('y al revés: "1200 de sueldo" detrás de un "Pagué" no entra como ingreso', async () => {
    const msg = 'Pagué 300 de pensión y 1200 de sueldo a la empleada, cobré 3000';
    const partes = ['Pagué 300 de pensión', '1200 de sueldo a la empleada', 'cobré 3000'];
    const ctx = ctxCon({ partes, porTexto: {
      'Pagué 300 de pensión': G(300), '1200 de sueldo a la empleada': G(1200, { tipo: 'ingreso' }), 'cobré 3000': G(3000, { tipo: 'ingreso' }),
    } });
    await correr(msg, ctx);
    expect(ctx.guardarTransaccion).not.toHaveBeenCalled();
  });

  it('control: con el tipo que sigue al verbo previo, se anota', async () => {
    const msg = 'Me yapearon 50 de la cena y 30 del taxi, pagué 20 de luz';
    const partes = ['Me yapearon 50 de la cena', '30 del taxi', 'pagué 20 de luz'];
    const ctx = ctxCon({ partes, porTexto: {
      'Me yapearon 50 de la cena': G(50, { tipo: 'ingreso' }), '30 del taxi': G(30, { tipo: 'ingreso' }), 'pagué 20 de luz': G(20),
    } });
    await correr(msg, ctx);
    expect(guardados(ctx).map((d) => d.tipo)).toEqual(['ingreso', 'ingreso', 'gasto']);
  });

  it('una ventana que ya dice su fecha no recibe la prestada', async () => {
    const ctx = ctxCon({ partes: ['ayer gasté 20 en taxi', 'ayer gasté hoy 30 en cine'] });
    await correr('ayer gasté 20 en taxi y hoy 30 en cine', ctx);
    const vistos = ctx.parsearRegistroManual.mock.calls.map((c) => c[0]);
    expect(vistos).toContain('hoy 30 en cine');
    expect(vistos).not.toContain('ayer hoy 30 en cine');
  });

  it('un número que sólo ve el contador amplio no es monto si no cierra su ventana', () => {
    expect(validarSeparacion(['Compré 2 pollos', 'a la brasa 70'], 'Compré 2 pollos a la brasa 70')).toBeNull();
    // control: "alquiler depa 800" sí, porque el 800 cierra la ventana
    expect(validarSeparacion(['alquiler depa 800', 'luz 120'], 'alquiler depa 800 y luz 120')).toHaveLength(2);
  });

  it('una cantidad no se nombra en la nota; un número después de una palabra sí', async () => {
    const ctx = ctxCon({ partes: ['2 polos 60'], porTexto: { '2 polos 60': G(60) } });
    const r = await correr('2 polos 60', ctx);
    expect(guardados(ctx).map((d) => d.monto)).toEqual([60]);
    expect(r).not.toContain('No anoté como plata');
    const ctx2 = ctxCon({ partes: ['recarga línea 10 de 20 soles'], porTexto: { 'recarga línea 10 de 20 soles': G(20) } });
    const r2 = await correr('recarga línea 10 de 20 soles', ctx2);
    expect(r2).toContain('No anoté como plata el 10');
  });
});
