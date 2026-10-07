import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

/**
 * `registrar_manual` con el parser que dice POR QUÉ no registra (chip 1, 30-sep-2026).
 *
 * El parser va REAL y lo que se mockea es OpenAI: el defecto vivía en el contrato entre los
 * dos (un único `ok:false` para tres cosas distintas, que el rescate leía como "no pude leer"),
 * así que mockear `parsearRegistroManual` entero dejaría fuera justo la costura que se arregla.
 * El modelo real se mide aparte, en `qa-e2e/probe-parser-decision.mjs`.
 */

const require = createRequire(import.meta.url);

const registrarErrorSpy = vi.fn();
require('../../lib/error-monitor').registrarError = registrarErrorSpy;

// La instancia que `services/parsers.js` destructuró al cargar es ESTE objeto, así que se le
// pisa el método en vez de reemplazar el export.
let respuestaModelo = null;
const crear = vi.fn(async () => ({ choices: [{ message: { content: JSON.stringify(respuestaModelo) } }] }));
require('../../lib/ai').openai.chat.completions.create = crear;

const { parsearRegistroManual } = require('../../services/parsers');
const { extraerGastoSinIA } = require('../../lib/nlp-guards');
const handler = require('../../handlers/intents/transacciones');
require('../../handlers/intent-registry');
const deudas = require('../../handlers/intents/deudas');

function makeChain(data = []) {
  const c = {};
  for (const m of ['select', 'insert', 'update', 'delete', 'upsert', 'eq', 'ilike', 'gte', 'lte', 'is',
    'neq', 'not', 'order', 'limit', 'single', 'maybeSingle']) c[m] = vi.fn().mockReturnValue(c);
  c.then = (f, r) => Promise.resolve({ data, error: null, count: 0 }).then(f, r);
  return c;
}
const sb = { from: vi.fn(() => makeChain([])) };

function ctxRegistro() {
  return {
    supabase: sb,
    parsearRegistroManual,
    guardarTransaccion: vi.fn(async (_uid, d) => ({ id: 'tx-1', categoria: d.categoria, subcategoria: d.subcategoria })),
    detectarCategoriaIA: vi.fn().mockResolvedValue({ categoria: null }),
    asegurarCategoriaUsuario: vi.fn().mockResolvedValue('creada'),
    crearSubcategoriaLibreUsuario: vi.fn(),
    verificarAlertaPresupuesto: vi.fn().mockResolvedValue(null),
    fechaHoyPeru: () => '2026-09-30',
    fechaAyerPeru: () => '2026-09-29',
    formatFecha: (f) => f || '',
  };
}
// Premium con trial convertido: fuera del muro y sin cola de estreno, para que la respuesta
// sea la confirmación pelada.
const USUARIO = { id: 'u-1', plan: 'premium', trial_estado: 'convertido', whatsapp: '51999' };
const registrar = (msg, ctx) => handler.handle({ intencion: 'registrar_manual', msg, datos: {}, usuario: USUARIO, from: '51999', ctx });

const vacio = { tipo: '', monto: 0, moneda: 'PEN', comercio: '', categoria: '', subcategoria: '', fecha: '' };

beforeEach(() => { crear.mockClear(); });

describe('parsearRegistroManual: el esquema obliga a decir por qué', () => {
  it('pide salida estructurada estricta con `decision` obligatoria', async () => {
    respuestaModelo = { decision: 'sin_monto', ...vacio };
    await parsearRegistroManual('Viaje', '2026-09-30');
    const req = crear.mock.calls[0][0];
    expect(req.response_format.type).toBe('json_schema');
    expect(req.response_format.json_schema.strict).toBe(true);
    const esquema = req.response_format.json_schema.schema;
    expect(esquema.required).toContain('decision');
    expect(esquema.properties.decision.enum).toEqual(['registrar', 'tipo_dudoso', 'no_es_movimiento', 'sin_monto']);
    // Sin EUR y 'otra' el modelo no puede decir la verdad sobre "20 euros": saldría PEN.
    expect(esquema.properties.moneda.enum).toEqual(expect.arrayContaining(['PEN', 'USD', 'EUR', 'otra']));
  });

  // Una versión intermedia devolvía el contrato viejo y el rescate guardaba, sin ninguna de las
  // decisiones, "Neto es 15800 soles" como gasto (segunda revisión adversarial, 30-sep).
  it('sin contenido (refusal) LANZA y no se guarda nada', async () => {
    crear.mockResolvedValueOnce({ choices: [{ message: { content: null, refusal: 'no' } }] });
    await expect(parsearRegistroManual('Neto es 15800 soles', '2026-09-30')).rejects.toThrow(/refusal/);
    crear.mockResolvedValueOnce({ choices: [{ message: { content: null, refusal: 'no' } }] });
    const ctx = ctxRegistro();
    await registrar('Neto es 15800 soles', ctx);
    expect(ctx.guardarTransaccion).not.toHaveBeenCalled();
  });

  it('una decisión fuera del enum se trata como ausente (contrato viejo)', async () => {
    respuestaModelo = { ...vacio, decision: 'quizas' };
    const p = await parsearRegistroManual('Almuerzo 10', '2026-09-30');
    expect(p.decision).toBeUndefined();
    expect(p.ok).toBeFalsy();
  });

  it('con una decisión que no registra PELA el dato: ok:false y monto 0, aunque el modelo mande monto', async () => {
    respuestaModelo = { ...vacio, decision: 'no_es_movimiento', monto: 500, tipo: 'gasto' };
    const p = await parsearRegistroManual('saqué una tarjeta de crédito con 500 disponibles', '2026-09-30');
    expect(p).toMatchObject({ ok: false, decision: 'no_es_movimiento', monto: 0 });
  });

  it('`tipo_dudoso` lleva el monto aparte, fuera de `monto`', async () => {
    respuestaModelo = { ...vacio, decision: 'tipo_dudoso', monto: 35 };
    const p = await parsearRegistroManual('35.00', '2026-09-30');
    expect(p).toMatchObject({ ok: false, decision: 'tipo_dudoso', monto: 0, monto_dudoso: 35 });
  });

  it('"registrar" sin monto cuenta como sin_monto', async () => {
    respuestaModelo = { ...vacio, decision: 'registrar', tipo: 'gasto', monto: 0 };
    const p = await parsearRegistroManual('almuerzo', '2026-09-30');
    expect(p).toMatchObject({ ok: false, decision: 'sin_monto' });
  });

  it('con `tipo_dudoso` el fallback sub-1 no adivina un ingreso', async () => {
    respuestaModelo = { ...vacio, decision: 'tipo_dudoso', monto: 0.5 };
    const p = await parsearRegistroManual('0.50 USD', '2026-09-30');
    expect(p.ok).toBe(false);
  });
});

/**
 * El comercio vacío del 30-sep (FinBot 6aac09d → fix del 01-oct). Al pasar a json_schema el
 * contrato `"comercio":"descripcion breve"` salió del prompt, y el modelo guardó `''` en 37 de 42
 * registros medidos; en producción, 16 filas reales en un día. El arreglo NO toca el prompt de
 * decisión (ver el comentario en `parsearRegistroManual`): si el parser deja el comercio vacío,
 * un segundo llamado lo nombra, y si ese falla queda la etiqueta fija. Que el modelo nombre bien
 * lo mide la sonda (`probe-parser-decision.mjs` falla con cualquier registro sin nombre); acá se
 * prueba lo que no depende del modelo.
 */
describe('parsearRegistroManual: el comercio nunca sale vacío con decision=registrar', () => {
  const { COMERCIO_SIN_DESCRIPCION } = require('../../services/parsers');
  const registro = (extra) => ({ decision: 'registrar', tipo: 'gasto', monto: 39, moneda: 'PEN', comercio: '', categoria: 'Otros', subcategoria: 'sin_categoria', fecha: '2026-09-30', ...extra });
  const json = (o) => ({ choices: [{ message: { content: JSON.stringify(o) } }] });
  // Encola respuestas del modelo en orden: la primera es el parser, la segunda el nombre.
  const encolar = (...rs) => { for (const r of rs) crear.mockImplementationOnce(async () => (r instanceof Error ? Promise.reject(r) : json(r))); };

  it('comercio vacío o en blanco → lo nombra el segundo llamado, sin tocar monto, moneda ni tipo', async () => {
    for (const comercio of ['', '   ']) {
      crear.mockClear();
      encolar(registro({ comercio }), { nombre: 'aguas' });
      const p = await parsearRegistroManual('39 aguas', '2026-09-30');
      expect(p).toMatchObject({ ok: true, decision: 'registrar', tipo: 'gasto', monto: 39, moneda: 'PEN', comercio: 'Aguas' });
      expect(crear).toHaveBeenCalledTimes(2);
      // El parser va primero; el segundo llamado recibe SÓLO el mensaje y no ve ni devuelve plata.
      expect(crear.mock.calls[0][0].response_format.json_schema.name).toBe('registro_manual');
      expect(crear.mock.calls[1][0].response_format.json_schema.schema.required).toEqual(['nombre']);
      expect(crear.mock.calls[1][0].messages.at(-1).content).toBe('39 aguas');
    }
  });

  // El nombre se pide EN PARALELO con el parser (en serie costaba +620ms de mediana por gasto), así
  // que el segundo llamado existe siempre; lo que se afirma es que se CANCELA cuando no hace falta y
  // que su respuesta no pisa lo que trajo el parser.
  const senalDelNombre = () => crear.mock.calls[1][1].signal;

  it('con comercio del parser se usa el suyo (recortado) y el pedido del nombre se cancela', async () => {
    encolar(registro({ comercio: '  Aguas ' }), { nombre: 'servilletas' });
    const p = await parsearRegistroManual('39 aguas', '2026-09-30');
    expect(p.comercio).toBe('Aguas');
    expect(senalDelNombre().aborted).toBe(true);
  });

  it('una decisión que no registra no usa el nombre y lo cancela', async () => {
    encolar({ ...vacio, decision: 'tipo_dudoso', monto: 35 }, { nombre: 'aguas' });
    const p = await parsearRegistroManual('35.00', '2026-09-30');
    expect(p).toMatchObject({ ok: false, decision: 'tipo_dudoso', monto: 0 });
    expect(p.comercio).toBeUndefined();
    expect(senalDelNombre().aborted).toBe(true);
  });

  it('si el parser LANZA (refusal), el pedido del nombre también se cancela', async () => {
    crear.mockImplementationOnce(async () => ({ choices: [{ message: { content: null, refusal: 'no' } }] }));
    encolar({ nombre: 'aguas' });
    await expect(parsearRegistroManual('39 aguas', '2026-09-30')).rejects.toThrow(/refusal/);
    expect(senalDelNombre().aborted).toBe(true);
  });

  it('nombre que el mensaje no escribe, con dígitos o vacío → etiqueta fija (no se inventa)', async () => {
    for (const nombre of ['Supermercado', 'aguas 39', '', '   ', 'aguas '.repeat(7)]) {
      encolar(registro(), { nombre });
      const p = await parsearRegistroManual('39 aguas', '2026-09-30');
      expect(p.comercio, JSON.stringify(nombre)).toBe(COMERCIO_SIN_DESCRIPCION);
      expect(p).toMatchObject({ ok: true, monto: 39, tipo: 'gasto' });
    }
  });

  it('palabras sin contenido (conectores, moneda, verbo) no hacen pasar un nombre inventado', async () => {
    for (const [msg, nombre] of [
      ['pagué 120 del cole', 'Pensión del colegio'],   // colgado del "del"
      ['me cobraron 25 de comisión', 'Comisión BCP'],   // una palabra real y otra inventada
      ['gasté 39 soles en aguas', 'Soles'],
      ['gasté 39 soles en aguas', 'Gasté'],
    ]) {
      encolar(registro(), { nombre });
      const p = await parsearRegistroManual(msg, '2026-09-30');
      expect(p.comercio, `${msg} → ${nombre}`).toBe(COMERCIO_SIN_DESCRIPCION);
    }
  });

  it('un nombre de varias palabras que el mensaje escribe completas sí pasa', async () => {
    for (const [msg, nombre] of [
      ['100.00 clases de filosofia', 'Clases de filosofia'],
      ['me cobraron 25 de comisión', 'comisión'],
      ['tv 500', 'TV'],                 // dos letras: con palabras de 3+ caía a la etiqueta
      ['pan leche 5', 'Pan y leche'],   // la "y" del nombre no es una palabra que haya que encontrar
      ['uñas pies 35', 'Uñas de pies'], // ni el "de"
      ['Uñas 35', 'Uñas'],              // sin la ñ, "uñas" quedaba "unas", el artículo, y caía a la etiqueta
      ['Taxi cholo 3', 'Taxis'],        // singular y plural valen igual
      ['Gasté 14.8 Alimentos', 'Alimento'],
      ['mangos 10', 'Mangos'],          // la fruta: la jerga de moneda que también es otra cosa no está en la lista
      ['pension cole 120', 'Pensión del cole'], // el "del" no hay que encontrarlo
    ]) {
      encolar(registro(), { nombre });
      const p = await parsearRegistroManual(msg, '2026-09-30');
      expect(p.comercio, msg).toBe(nombre.charAt(0).toUpperCase() + nombre.slice(1));
    }
  });

  it('el pedido del nombre lleva timeout corto y sin reintentos (si no, el gasto espera minutos)', async () => {
    encolar(registro(), { nombre: 'aguas' });
    await parsearRegistroManual('39 aguas', '2026-09-30');
    expect(crear.mock.calls[1][1]).toMatchObject({ timeout: 8000, maxRetries: 0 });
  });

  it('con comercio del parser NO espera al pedido del nombre (aunque nunca conteste)', async () => {
    encolar(registro({ comercio: 'Aguas' }));
    crear.mockImplementationOnce(() => new Promise(() => {}));
    const p = await parsearRegistroManual('39 aguas', '2026-09-30');
    expect(p.comercio).toBe('Aguas');
  }, 2000);

  it('las tildes y mayúsculas no impiden reconocer la palabra del mensaje', async () => {
    encolar(registro({ monto: 12 }), { nombre: 'Alimentacion' });
    const p = await parsearRegistroManual('12.00 alimentación', '2026-09-30');
    expect(p.comercio).toBe('Alimentacion');
  });

  it('si el segundo llamado falla o devuelve basura, NO lanza: etiqueta fija y el gasto entra', async () => {
    encolar(registro({ tipo: 'ingreso', monto: 84 }), new Error('timeout'));
    const ing = await parsearRegistroManual('Ingreso 84 soles', '2026-09-30');
    expect(ing).toMatchObject({ ok: true, tipo: 'ingreso', monto: 84, comercio: COMERCIO_SIN_DESCRIPCION });
    encolar(registro());
    crear.mockImplementationOnce(async () => ({ choices: [{ message: { content: 'no es json' } }] }));
    const p = await parsearRegistroManual('39 aguas', '2026-09-30');
    expect(p.comercio).toBe(COMERCIO_SIN_DESCRIPCION);
  });

  it('la etiqueta es un texto no vacío (si no, el piso no sería piso)', () => {
    expect(typeof COMERCIO_SIN_DESCRIPCION).toBe('string');
    expect(COMERCIO_SIN_DESCRIPCION.trim().length).toBeGreaterThan(0);
  });

  it('por el handler: a guardarTransaccion le llega un nombre, nunca ""', async () => {
    encolar(registro({ monto: 8.5, categoria: 'Transporte', subcategoria: 'taxi' }), { nombre: 'Taxi' });
    const ctx = ctxRegistro();
    await registrar('Taxi 8.50', ctx);
    expect(ctx.guardarTransaccion).toHaveBeenCalledOnce();
    const d = ctx.guardarTransaccion.mock.calls[0][1];
    expect(d).toMatchObject({ tipo: 'gasto', monto: 8.5, comercio: 'Taxi' });
  });
});

describe('registrar_manual por decisión', () => {
  it('la forma corta sin verbo se registra como gasto ("Almuerzo 10")', async () => {
    respuestaModelo = { decision: 'registrar', tipo: 'gasto', monto: 10, moneda: 'PEN', comercio: 'Almuerzo', categoria: 'Alimentación', subcategoria: 'restaurante', fecha: '2026-09-30' };
    const ctx = ctxRegistro();
    const res = await registrar('Almuerzo 10', ctx);
    expect(ctx.guardarTransaccion).toHaveBeenCalledOnce();
    expect(ctx.guardarTransaccion.mock.calls[0][1]).toMatchObject({ tipo: 'gasto', monto: 10, moneda: 'PEN' });
    expect(res).toContain('S/10.00');
  });

  it('`tipo_dudoso` pregunta con el monto y NO guarda ni rescata ("Neto es 15800")', async () => {
    respuestaModelo = { ...vacio, decision: 'tipo_dudoso', monto: 15800 };
    const ctx = ctxRegistro();
    const res = await registrar('Neto es 15800', ctx);
    expect(ctx.guardarTransaccion).not.toHaveBeenCalled();
    expect(res).toBe('¿Esos S/15800 entraron o salieron? Escríbemelo con el verbo: "gasté 15800 en…" o "me pagaron 15800".');
  });

  it('`tipo_dudoso` sobre un número solo tampoco se registra ("35.00")', async () => {
    respuestaModelo = { ...vacio, decision: 'tipo_dudoso', monto: 35 };
    const ctx = ctxRegistro();
    const res = await registrar('35.00', ctx);
    expect(ctx.guardarTransaccion).not.toHaveBeenCalled();
    expect(res).toContain('¿Esos S/35 entraron o salieron?');
  });

  it('`no_es_movimiento` no se rescata aunque el texto tenga verbo y monto', async () => {
    respuestaModelo = { ...vacio, decision: 'no_es_movimiento' };
    const ctx = ctxRegistro();
    const res = await registrar('saqué una tarjeta de crédito con 500 disponibles', ctx);
    expect(ctx.guardarTransaccion).not.toHaveBeenCalled();
    expect(res).toContain('Eso no lo anoté');
  });

  // Los dos casos que siguen usan mensajes donde el rescate SÍ registraría (se afirma como
  // precondición). Con "preste 118" o "35.00" el extractor ya devolvía null por su cuenta, así
  // que un test sobre ellos seguía verde aunque el rescate corriera antes que la decisión
  // (mutación M4 de la revisión adversarial del 30-sep).
  // Con "50 soles de mi tía" y no con "preste 118 soles": desde el 07-oct el rescate ya no lee
  // ningún préstamo, así que ese mensaje volvía a no poder probar el orden.
  it('`tipo_dudoso` gana al rescate aunque el rescate sí leería un gasto ("50 soles de mi tía")', async () => {
    expect(extraerGastoSinIA('50 soles de mi tía')).toMatchObject({ monto: 50, tipo: 'gasto' });
    respuestaModelo = { ...vacio, decision: 'tipo_dudoso', monto: 50 };
    const ctx = ctxRegistro();
    const res = await registrar('50 soles de mi tía', ctx);
    expect(ctx.guardarTransaccion).not.toHaveBeenCalled();
    expect(res).toContain('¿Esos S/50 entraron o salieron?');
  });

  it('`no_es_movimiento` gana al rescate aunque el rescate sí leería un gasto ("me quedan 40 soles")', async () => {
    expect(extraerGastoSinIA('me quedan 40 soles')).toMatchObject({ monto: 40, tipo: 'gasto' });
    respuestaModelo = { ...vacio, decision: 'no_es_movimiento' };
    const ctx = ctxRegistro();
    const res = await registrar('me quedan 40 soles', ctx);
    expect(ctx.guardarTransaccion).not.toHaveBeenCalled();
    expect(res).toContain('Eso no lo anoté');
  });

  // Una versión intermedia degradaba `tipo_dudoso` a `sin_monto` cuando había un concepto al lado,
  // y el rescate guardaba "35 me dieron" o "Mi neto es 15800 soles" como GASTO (segunda revisión
  // adversarial, 30-sep). Si el modelo duda, se pregunta, con o sin concepto.
  it('`tipo_dudoso` con un concepto al lado sigue preguntando, no rescata ("35 me dieron")', async () => {
    expect(extraerGastoSinIA('35 me dieron')).not.toBeNull();
    respuestaModelo = { ...vacio, decision: 'tipo_dudoso', monto: 35 };
    const ctx = ctxRegistro();
    const res = await registrar('35 me dieron', ctx);
    expect(ctx.guardarTransaccion).not.toHaveBeenCalled();
    expect(res).toContain('¿Esos S/35 entraron o salieron?');
  });

  describe('invariantes sobre lo que el modelo quiere registrar', () => {
    it('el tipo que contradice un verbo explícito no se guarda: se pregunta ("me yapearon 50" como gasto)', async () => {
      respuestaModelo = { decision: 'registrar', tipo: 'gasto', monto: 50, moneda: 'PEN', comercio: 'Yape', categoria: 'Otros', subcategoria: 'sin_categoria', fecha: '2026-09-30' };
      const ctx = ctxRegistro();
      const res = await registrar('me yapearon 50', ctx);
      expect(ctx.guardarTransaccion).not.toHaveBeenCalled();
      expect(res).toContain('¿Esos S/50 entraron o salieron?');
    });

    it('y al revés: "me cobraron" como ingreso tampoco se guarda', async () => {
      respuestaModelo = { decision: 'registrar', tipo: 'ingreso', monto: 25, moneda: 'PEN', comercio: 'banco', categoria: 'Finanzas', subcategoria: 'comision_banco', fecha: '2026-09-30' };
      const ctx = ctxRegistro();
      await registrar('me cobraron 25 de comisión', ctx);
      expect(ctx.guardarTransaccion).not.toHaveBeenCalled();
    });

    it('con los dos sentidos en el mensaje no hay contradicción que afirmar', async () => {
      respuestaModelo = { decision: 'registrar', tipo: 'gasto', monto: 100, moneda: 'PEN', comercio: 'comida', categoria: 'Alimentación', subcategoria: 'mercado', fecha: '2026-09-30' };
      const ctx = ctxRegistro();
      await registrar('me pagaron 500 y gasté 100 en comida', ctx);
      expect(ctx.guardarTransaccion.mock.calls[0][1]).toMatchObject({ tipo: 'gasto', monto: 100 });
    });

    it('un gasto con "me cobraron" que el modelo leyó bien entra normal', async () => {
      respuestaModelo = { decision: 'registrar', tipo: 'gasto', monto: 12, moneda: 'PEN', comercio: 'taxi', categoria: 'Transporte', subcategoria: 'taxi', fecha: '2026-09-30' };
      const ctx = ctxRegistro();
      await registrar('el taxista me cobró 12', ctx);
      expect(ctx.guardarTransaccion.mock.calls[0][1]).toMatchObject({ tipo: 'gasto', monto: 12 });
    });

    // Rebota, no rescata: la tercera revisión midió que pasarle la decisión al rescate guardaba
    // "me depositaron 15mil soles" como gasto S/15. El rescate se asegura acá como precondición:
    // SÍ leería algo, así que el test muere si alguien vuelve a mandar este caso al rescate.
    it('un monto que no está escrito en el mensaje no se guarda: se pide el número ("s/.25 menu" leído como 0.25)', async () => {
      expect(extraerGastoSinIA('s/.25 menu')).toMatchObject({ monto: 25 });
      respuestaModelo = { decision: 'registrar', tipo: 'gasto', monto: 0.25, moneda: 'PEN', comercio: 'menu', categoria: 'Alimentación', subcategoria: 'restaurante', fecha: '2026-09-30' };
      const ctx = ctxRegistro();
      const res = await registrar('s/.25 menu', ctx);
      expect(ctx.guardarTransaccion).not.toHaveBeenCalled();
      expect(res).toContain('No pude leer el monto');
    });

    for (const [msg, leido] of [['compré una pizza 35', 350], ['desayuno 15', 150], ['menú 12.50', 13], ['dos menús 24', 240]]) {
      it(`un monto mal leído no pasa aunque el mensaje tenga palabras de número: ${JSON.stringify(msg)} como ${leido}`, async () => {
        respuestaModelo = { decision: 'registrar', tipo: 'gasto', monto: leido, moneda: 'PEN', comercio: 'x', categoria: 'Otros', subcategoria: 'sin_categoria', fecha: '2026-09-30' };
        const ctx = ctxRegistro();
        await registrar(msg, ctx);
        expect(ctx.guardarTransaccion).not.toHaveBeenCalled();
      });
    }

    it('el tipo que contradice "cobré", "me depositaron" o "pagué" no se guarda', async () => {
      for (const [msg, tipo, monto] of [['cobré 300 por un trabajo', 'gasto', 300], ['me depositaron 1200', 'gasto', 1200], ['pagué 40 de luz', 'ingreso', 40]]) {
        respuestaModelo = { decision: 'registrar', tipo, monto, moneda: 'PEN', comercio: 'x', categoria: 'Otros', subcategoria: 'sin_categoria', fecha: '2026-09-30' };
        const ctx = ctxRegistro();
        const res = await registrar(msg, ctx);
        expect(ctx.guardarTransaccion, msg).not.toHaveBeenCalled();
        expect(res, msg).toContain('entraron o salieron');
      }
    });

    it('frases con "me dio", "recibí" o "me mandó" que no hablan de plata no disparan la pregunta', async () => {
      for (const msg of ['me dio flojera cocinar, delivery 35', 'recibí mi pedido de rappi 35', 'mi mamá me mandó a comprar pan 5', 'me gané una multa de 80']) {
        const monto = Number(msg.match(/\d+/)[0]);
        respuestaModelo = { decision: 'registrar', tipo: 'gasto', monto, moneda: 'PEN', comercio: 'x', categoria: 'Otros', subcategoria: 'sin_categoria', fecha: '2026-09-30' };
        const ctx = ctxRegistro();
        await registrar(msg, ctx);
        expect(ctx.guardarTransaccion.mock.calls[0]?.[1], msg).toMatchObject({ tipo: 'gasto', monto });
      }
    });

    it('el resultado del RESCATE también pasa por el invariante de sentido ("me depositaron 1200 soles")', async () => {
      expect(extraerGastoSinIA('me depositaron 1200 soles')).toMatchObject({ tipo: 'gasto', monto: 1200 });
      respuestaModelo = { ...vacio, decision: 'sin_monto' };
      const ctx = ctxRegistro();
      const res = await registrar('me depositaron 1200 soles', ctx);
      expect(ctx.guardarTransaccion).not.toHaveBeenCalled();
      expect(res).toContain('¿Esos S/1200 entraron o salieron?');
    });

    it('un monto inventado sin rescate posible no se guarda ("Almuerzo 10" leído como 100)', async () => {
      respuestaModelo = { decision: 'registrar', tipo: 'gasto', monto: 100, moneda: 'PEN', comercio: 'Almuerzo', categoria: 'Alimentación', subcategoria: 'restaurante', fecha: '2026-09-30' };
      const ctx = ctxRegistro();
      const res = await registrar('Almuerzo 10', ctx);
      expect(ctx.guardarTransaccion).not.toHaveBeenCalled();
      expect(res).toContain('No pude leer el monto');
    });

    it('las lecturas legítimas del monto pasan: miles, "k", palabras, decimal sin cero', async () => {
      for (const [msg, monto] of [['Gasté 1,500 en la laptop', 1500], ['15k en la moto', 15000], ['Carne, ciento diez punto setenta', 110.7], ['.50 pan', 0.5], ['S/.12.50 taxi', 12.5],
        ['gasté 2mil en la moto', 2000], ['gasté 15 mil en el carro', 15000], ['pagué 50 céntimos de bolsa', 0.5], ['pagué 1,250.80 de la tarjeta', 1250.8], ['gasté 1 500 en la laptop', 1500]]) {
        respuestaModelo = { decision: 'registrar', tipo: 'gasto', monto, moneda: 'PEN', comercio: 'x', categoria: 'Otros', subcategoria: 'sin_categoria', fecha: '2026-09-30' };
        const ctx = ctxRegistro();
        await registrar(msg, ctx);
        expect(ctx.guardarTransaccion.mock.calls[0]?.[1], msg).toMatchObject({ monto });
      }
    });
  });

  it('`registrar` con tipo ingreso se guarda como INGRESO', async () => {
    respuestaModelo = { decision: 'registrar', tipo: 'ingreso', monto: 1200, moneda: 'PEN', comercio: 'Quincena', categoria: 'Finanzas', subcategoria: 'sin_categoria', fecha: '2026-09-30' };
    const ctx = ctxRegistro();
    const res = await registrar('Quincena 1200', ctx);
    expect(ctx.guardarTransaccion.mock.calls[0][1]).toMatchObject({ tipo: 'ingreso', monto: 1200 });
    expect(res).toContain('Ingresos');
  });

  it('`tipo_dudoso` en dólares pregunta en dólares', async () => {
    respuestaModelo = { ...vacio, decision: 'tipo_dudoso', monto: 20, moneda: 'USD' };
    const ctx = ctxRegistro();
    const res = await registrar('$20', ctx);
    expect(res).toBe('¿Esos $20 entraron o salieron? Escríbemelo con el verbo: "gasté 20 dólares en…" o "me pagaron 20 dólares".');
  });

  it('`tipo_dudoso` en euros NO pregunta en soles: corta por moneda', async () => {
    respuestaModelo = { ...vacio, decision: 'tipo_dudoso', monto: 20, moneda: 'EUR' };
    const ctx = ctxRegistro();
    const res = await registrar('20 euros', ctx);
    expect(ctx.guardarTransaccion).not.toHaveBeenCalled();
    expect(res).not.toContain('S/20');
    expect(res).toContain('solo anoto soles y dólares');
  });

  it('`sin_monto` sí deja correr el rescate determinístico', async () => {
    respuestaModelo = { ...vacio, decision: 'sin_monto' };
    const ctx = ctxRegistro();
    await registrar('4.10 pastillas', ctx);
    expect(ctx.guardarTransaccion).toHaveBeenCalledOnce();
    expect(ctx.guardarTransaccion.mock.calls[0][1]).toMatchObject({ monto: 4.1, tipo: 'gasto' });
  });

  it('sin `decision` (contrato viejo) el rescate corre como antes', async () => {
    const ctx = { ...ctxRegistro(), parsearRegistroManual: vi.fn().mockResolvedValue({ ok: false }) };
    await registrar('4.10 pastillas', ctx);
    expect(ctx.guardarTransaccion).toHaveBeenCalledOnce();
  });

  it('una moneda que no es PEN ni USD no se guarda como soles', async () => {
    respuestaModelo = { decision: 'registrar', tipo: 'gasto', monto: 20, moneda: 'EUR', comercio: 'polo', categoria: 'Compras', subcategoria: 'ropa', fecha: '2026-09-30' };
    const ctx = ctxRegistro();
    const res = await registrar('gasté 20 euros en un polo', ctx);
    expect(ctx.guardarTransaccion).not.toHaveBeenCalled();
    expect(res).toContain('solo anoto soles y dólares');
  });

  it('`registrar` con moneda "otra" tampoco se guarda', async () => {
    respuestaModelo = { decision: 'registrar', tipo: 'gasto', monto: 500, moneda: 'otra', comercio: 'hotel', categoria: 'Otros', subcategoria: 'viaje', fecha: '2026-09-30' };
    const ctx = ctxRegistro();
    const res = await registrar('gasté 500 pesos mexicanos en el hotel', ctx);
    expect(ctx.guardarTransaccion).not.toHaveBeenCalled();
    expect(res).toContain('solo anoto soles y dólares');
  });

  it('el GBP del fallback sub-1 no se guarda como soles', async () => {
    respuestaModelo = { ...vacio, decision: 'sin_monto' };
    const ctx = ctxRegistro();
    const res = await registrar('gasté 0.50 GBP de comisión', ctx);
    expect(ctx.guardarTransaccion).not.toHaveBeenCalled();
    expect(res).toContain('solo anoto soles y dólares');
  });

  it('el rescate no guarda euros como soles, y el rebote dice por qué', async () => {
    respuestaModelo = { ...vacio, decision: 'sin_monto' };
    const ctx = ctxRegistro();
    const res = await registrar('gasté 20 euros en un polo', ctx);
    expect(ctx.guardarTransaccion).not.toHaveBeenCalled();
    expect(res).toContain('solo anoto soles y dólares');
  });

  it('el rescate se niega ante cada forma de moneda no soportada pegada a una cifra', () => {
    for (const msg of ['gasté 18€ en claude', 'gasté 5 £ en un café', 'pagué EUR 30 de hotel', 'gasté 20 GBP en el tren',
      'gasté 20 pesos en un polo', 'gasté 50 reales en la playa', 'gasté 3 esterlinas']) {
      expect(extraerGastoSinIA(msg), msg).toBeNull();
    }
  });

  it('una palabra de moneda que NO va pegada a una cifra no bloquea un gasto en soles', () => {
    for (const [msg, monto] of [['gasté 410 soles comprando euros para el viaje', 410], ['pagué 50 soles en la Euro Shop', 50], ['gasté 80 en la camiseta de la Euro', 80]]) {
      expect(extraerGastoSinIA(msg), msg).toMatchObject({ monto, moneda: 'PEN' });
    }
  });

  it('el fallback sub-1 ve los verbos con tilde ("gasté", "me cobró")', async () => {
    for (const msg of ['gasté 0.50 USD en comisiones', 'me cobró 0.30 USD el banco']) {
      respuestaModelo = { ...vacio, decision: 'sin_monto' };
      const p = await parsearRegistroManual(msg, '2026-09-30');
      expect(p, msg).toMatchObject({ ok: true, tipo: 'gasto' });
    }
  });

  it('"me cobraron" en el fallback sub-1 es gasto, no ingreso', async () => {
    respuestaModelo = { ...vacio, decision: 'sin_monto' };
    const ctx = ctxRegistro();
    await registrar('me cobraron 0.50 USD de comisión', ctx);
    expect(ctx.guardarTransaccion.mock.calls[0][1]).toMatchObject({ tipo: 'gasto', monto: 0.5, moneda: 'USD' });
  });

  it('el rebote sin monto enseña formas que no son la rechazada "110.70 carne"', async () => {
    respuestaModelo = { ...vacio, decision: 'sin_monto' };
    const ctx = ctxRegistro();
    const res = await registrar('Viaje', ctx);
    expect(ctx.guardarTransaccion).not.toHaveBeenCalled();
    expect(res).toContain('No pude leer el monto');
    expect(res).not.toContain('"110.70 carne"');
    expect(res).toContain('"almuerzo 15"');
  });
});

describe('registrar_deuda: "presté" es plata que me deben', () => {
  const ctxDeuda = () => ({
    supabase: sb,
    hoyPeru: () => '2026-09-30',
    registrarDeuda: vi.fn().mockResolvedValue({ id: 'd-1' }),
    formatearResumenDeudas: vi.fn().mockResolvedValue(''),
    abonarDeuda: vi.fn(), marcarDeudaPagada: vi.fn(), consolidarDeudasPorContraparte: vi.fn().mockResolvedValue(null), saldarTodasDeudas: vi.fn(),
  });
  const deuda = (msg, datos) => {
    const ctx = ctxDeuda();
    return deudas.handle({ intencion: 'registrar_deuda', msg, datos, usuario: USUARIO, from: '51999', ctx }).then(() => ctx);
  };

  it('"presté 100 a Juan" da me_deben aunque el clasificador diga debo', async () => {
    const ctx = await deuda('presté 100 a Juan', { tipo: 'debo', contraparte: 'Juan', monto: 100 });
    expect(ctx.registrarDeuda.mock.calls[0][1]).toBe('me_deben');
  });

  it('"presté" sin tipo del clasificador también', async () => {
    const ctx = await deuda('preste 118 a Rosa', { contraparte: 'Rosa', monto: 118 });
    expect(ctx.registrarDeuda.mock.calls[0][1]).toBe('me_deben');
  });

  // Los ataques de la revisión adversarial: con el clasificador diciendo `debo` (bien), la
  // primera versión de la regla los invertía a me_deben porque buscaba "presté" en cualquier lado.
  // "Juan preste 200 para mi pasaje" salió de esta lista el 07-oct: "preste" sin tilde, sin
  // pronombre y sin destinatario se pregunta (abajo).
  for (const msg of [
    'yo no le presté, Juan me prestó 200',
    'le pedí a Carla que me lo preste y me dio 300',
    'Mi mamá me dijo "te presté 200", le debo eso',
  ]) {
    it(`no invierte lo que el clasificador leyó bien: ${JSON.stringify(msg)}`, async () => {
      const ctx = await deuda(msg, { tipo: 'debo', contraparte: 'Juan', monto: 200 });
      expect(ctx.registrarDeuda.mock.calls[0][1]).toBe('debo');
    });
  }

  // Segunda revisión: sin destinatario, "presté X del banco" es "me presté" sin el "me". Hasta el
  // 07-oct ahí decidía el clasificador; ahora lo que el verbo no decide se PREGUNTA, aunque el
  // clasificador traiga un tipo: con "Y preste 118 soles" traía `debo` y era al revés.
  for (const msg of ['presté 5000 del banco para la moto', 'presté 3000 de la caja Arequipa', 'preste 118',
    'Y preste 118 soles', 'Juan preste 200 para mi pasaje', 'me presté 50 de Juan', 'Me preste 50 soles']) {
    it(`sin dirección clara no anota y pregunta: ${JSON.stringify(msg)}`, async () => {
      const ctx = ctxDeuda();
      const res = await deudas.handle({ intencion: 'registrar_deuda', msg, datos: { tipo: 'debo', contraparte: 'Banco', monto: 100 }, usuario: USUARIO, from: '51999', ctx });
      expect(ctx.registrarDeuda).not.toHaveBeenCalled();
      expect(res).toMatch(/prestaste tú o te/);
    });
  }

  for (const msg of ['te presté 20', 'le presté S/100 a Carlos', 'presté 50 soles a Ana', 'presté a Juan 100', 'yo le presté 50 a mi primo']) {
    it(`con destinatario fuerza me_deben: ${JSON.stringify(msg)}`, async () => {
      const ctx = await deuda(msg, { tipo: 'debo', contraparte: 'Juan', monto: 50 });
      expect(ctx.registrarDeuda.mock.calls[0][1]).toBe('me_deben');
    });
  }

  it('sin tipo del clasificador, "le presté" en medio de la frase sigue siendo me_deben', async () => {
    const ctx = await deuda('a Juan le presté 50', { contraparte: 'Juan', monto: 50 });
    expect(ctx.registrarDeuda.mock.calls[0][1]).toBe('me_deben');
  });

  // Lo que el verbo sí decide gana sobre el clasificador, en las dos direcciones (07-oct-2026).
  for (const [msg, tipoVerbo, tipoClasif] of [
    ['No no, yo le preste 118 soles a mi madre', 'me_deben', 'debo'],
    ['Mi mamá me prestó 200', 'debo', 'me_deben'],
    ['pedí prestado 300 a mi primo', 'debo', 'me_deben'],
    ['me pidió prestado 50 Carla', 'me_deben', 'debo'],
  ]) {
    it(`el verbo gana: ${JSON.stringify(msg)} → ${tipoVerbo}`, async () => {
      const ctx = await deuda(msg, { tipo: tipoClasif, contraparte: 'Mamá', monto: 100 });
      expect(ctx.registrarDeuda.mock.calls[0][1]).toBe(tipoVerbo);
    });
  }

  it('sin persona, la pregunta va en la dirección del verbo', async () => {
    const ctx = ctxDeuda();
    const res = await deudas.handle({ intencion: 'registrar_deuda', msg: 'Presté 118 soles', datos: { monto: 118 }, usuario: USUARIO, from: '51999', ctx });
    expect(ctx.registrarDeuda).not.toHaveBeenCalled();
    expect(res).toContain('¿A quién se lo prestaste?');
  });
});
