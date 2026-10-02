import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
import { readdirSync } from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);

/**
 * La clase "escritura con datos que el mensaje no nombra" (02-oct-2026), cerrada en
 * `dispatchIntent` por `lib/datos-dichos.js`. El caso de prod: "No aparece en mi dashboard" llegó a
 * `registrar_deuda` con `monto: 20, contraparte: "bidon de agua"` copiados del turno anterior.
 *
 * Tres bloques:
 *   1. La FAMILIA, por el camino real (`dispatchIntent` con el registry cargado de verdad): cada
 *      campo de cada intent de `ESCRITURAS`, con un valor que el mensaje no dice, NO llega al
 *      handler. Es lo que hace que sacar la llamada de `intent-registry.js` (una sola mutación)
 *      ponga rojo a TODOS los intents de la familia, no a uno.
 *   2. Los CONTROLES: el mismo valor, dicho, sí llega. Sin ellos el bloque 1 pasaría con una guarda
 *      que descarta todo.
 *   3. El inventario CERRADO: todo intent registrado está en `ESCRITURAS` o en `SIN_REVISION`.
 */

// Los handlers reales se envuelven ANTES de que el registry los capture: registran qué datos
// recibieron y no tocan la base. El bloque de pipeline (handlers reales escribiendo) vive en
// `tests/handlers/datos-no-dichos-pipeline.test.js`.
const DIR = path.join(path.dirname(require.resolve('../../handlers/intent-registry.js')), 'intents');
const llamadas = [];
for (const f of readdirSync(DIR).filter((x) => x.endsWith('.js'))) {
  const mod = require(path.join(DIR, f));
  if (mod.intents && mod.handle) mod.handle = vi.fn(async ({ intencion, datos }) => { llamadas.push({ intencion, datos }); return 'HANDLER'; });
}
const { dispatchIntent, listIntents } = require('../../handlers/intent-registry');
const { ESCRITURAS, SIN_REVISION, revisarDatosDichos, textoDicho, numerosEnPalabras, montoDicho, campoDicho, esReporteNoAparece, REPORTE } = require('../../lib/datos-dichos');

// En prueba: el muro no aplica, así que lo único entre el mensaje y el handler es la guarda.
const USUARIO = { id: 'u-1', plan: 'premium', trial_estado: 'activo', trial_vence: '2099-01-01' };
// Un mensaje que no nombra NINGÚN dato ni objeto, y que NO es un reporte de "no aparece": ese tiene
// su propio bloque abajo, y usado acá taparía la revisión campo por campo.
const MSG_QUE_NO_NOMBRA = 'ok, gracias por todo';
// Un valor por tipo, y un mensaje que los dice TODOS y nombra todos los objetos.
const VALOR = { monto: 20, texto: 'bidon de agua', fecha: '2026-12-31', moneda: 'USD', codigo: 'ABC12345' };
const MSG_QUE_NOMBRA = 'restaura la meta del presupuesto de comida: 20 dolares a bidon de agua para el 31 de diciembre, codigo abc-12345';

async function despachar(intencion, msg, datos) {
  llamadas.length = 0;
  const r = await dispatchIntent({ intencion, msg, datos, usuario: USUARIO, from: '51999', ctx: {} });
  return { r, llamada: llamadas[0] || null };
}

const CASOS = Object.entries(ESCRITURAS).flatMap(([intencion, regla]) =>
  Object.entries(regla.campos).map(([campo, tipo]) => [intencion, campo, tipo]));

describe('la familia entera: un dato que el mensaje no nombra no llega al handler', () => {
  it('la tabla no está vacía (antivacuidad del it.each)', () => {
    expect(CASOS.length).toBeGreaterThanOrEqual(25);
    expect(Object.keys(ESCRITURAS)).toEqual(expect.arrayContaining([
      'registrar_deuda', 'abonar_deuda', 'marcar_deuda_pagada', 'saldar_todo_contraparte', 'crear_meta',
      'editar_meta', 'eliminar_meta', 'abonar_meta', 'abandonar_plan', 'configurar_presupuesto',
      'eliminar_presupuesto', 'poner_limite_gasto', 'registrar_gasto_espacio', 'liquidar_espacio',
      'unirse_espacio', 'restaurar_eliminado', 'corregir_categoria', 'editar_categoria_comercio',
    ]));
  });

  it.each(CASOS)('%s.%s (%s) no dicho: el handler no lo recibe', async (intencion, campo, tipo) => {
    const { r, llamada } = await despachar(intencion, MSG_QUE_NO_NOMBRA, { [campo]: VALOR[tipo], extra: 'x' });
    if (llamada) {
      expect(llamada.datos).not.toHaveProperty(campo);
      expect(llamada.datos.extra).toBe('x');   // lo que no se revisa viaja intacto
    } else {
      expect([ESCRITURAS[intencion].pregunta, ESCRITURAS[intencion].preguntaMonto]).toContain(r.respuesta);
    }
  });

  it.each(CASOS)('control %s.%s (%s) dicho: el handler SÍ lo recibe', async (intencion, campo, tipo) => {
    const { llamada } = await despachar(intencion, MSG_QUE_NOMBRA, { [campo]: VALOR[tipo] });
    expect(llamada).not.toBeNull();
    expect(llamada.datos[campo]).toEqual(VALOR[tipo]);
  });

  it('una contraparte que el mensaje no nombra pregunta: el handler no corre', async () => {
    const { r, llamada } = await despachar('registrar_deuda', MSG_QUE_NO_NOMBRA, { monto: 20, contraparte: 'bidon de agua', tipo: 'debo' });
    expect(llamada).toBeNull();
    expect(r.respuesta).toBe(ESCRITURAS.registrar_deuda.pregunta);
  });

  it('un monto no dicho llega sin él (el handler pregunta o lo saca del mensaje)', async () => {
    const { llamada } = await despachar('registrar_deuda', 'anota la deuda con bidon de agua', { monto: 20, contraparte: 'bidon de agua', tipo: 'debo' });
    expect(llamada.datos).toEqual({ contraparte: 'bidon de agua', tipo: 'debo' });
  });

  // Ronda 2, causa c: una queja que REPITE los datos no es una orden. La revisión adversarial lo
  // escribió con todo dicho ("La deuda de 20 con Juan no aparece…") y la deuda se duplicaba.
  it.each(Object.keys(ESCRITURAS))('%s: un reporte de "no aparece" no escribe aunque traiga los datos', async (intencion) => {
    const { r, llamada } = await despachar(intencion, 'La deuda de 20 con bidon de agua no aparece en mi dashboard', { monto: 20, contraparte: 'bidon de agua' });
    expect(llamada).toBeNull();
    expect(r.respuesta).toBe(REPORTE);
  });

  it.each(Object.entries(ESCRITURAS).filter(([, r]) => r.objeto))(
    '%s sin objeto nombrado: pregunta y el handler no corre', async (intencion) => {
      const { r, llamada } = await despachar(intencion, MSG_QUE_NO_NOMBRA, {});
      expect(llamada).toBeNull();
      expect(r.manejado).toBe(true);
      expect(r.respuesta).toBe(ESCRITURAS[intencion].pregunta);
    });

  it('un intent que no escribe pasa sus datos sin tocar, y el MISMO objeto', async () => {
    const datos = { monto: 999, comercio: 'nadie' };
    const { llamada } = await despachar('listar_gastos_categoria', MSG_QUE_NO_NOMBRA, datos);
    expect(llamada.datos).toBe(datos);
  });

  it('nunca muta los datos del llamador (la continuación multi-intent los reusa)', () => {
    const datos = { monto: 20, contraparte: 'bidon de agua' };
    revisarDatosDichos({ intencion: 'registrar_deuda', msg: MSG_QUE_NO_NOMBRA, datos });
    expect(datos).toEqual({ monto: 20, contraparte: 'bidon de agua' });
  });
});

describe('qué cuenta como dicho', () => {
  it.each([
    ['Mama me debe 120', 'mama', true],
    ['mamá me debe 120', 'Mama', true],
    ['mi tía Jenny me pagó 500', 'Jenny Pérez', true],     // el modelo completa: no inventa
    ['Debo 140 a Víctor', 'victor', true],
    ['le debo 50 a los chicos', 'chico', true],
    ['No aparece en mi dashboard', 'bidon de agua', false],
    ['Y preste 118 soles', 'desconocida', false],           // relleno del modelo, medido en prod
    ['ella me debe 302 soles', 'madre', false],             // costo declarado: pregunta a quién
    ['debo 20 a Juan', 'de la', false],                     // sin palabra clave: el valor entero
    ['debo 20 al de la bodega', 'de la', true],
  ])('%s / %s → %s', (msg, valor, esperado) => {
    expect(textoDicho(valor, msg)).toBe(esperado);
  });

  it('USD exige la moneda en el mensaje; PEN es el default y no se exige', () => {
    const r = (msg, moneda) => revisarDatosDichos({ intencion: 'registrar_deuda', msg, datos: { moneda } }).datos.moneda;
    expect(r('debo 20 a Juan', 'USD')).toBeUndefined();
    expect(r('debo 20 dólares a Juan', 'USD')).toBe('USD');
    expect(r('debo $20 a Juan', 'USD')).toBe('USD');
    expect(r('debo 20 a Juan', 'PEN')).toBe('PEN');
  });

  it('un objeto lo nombra también el nombre dicho, sin palabra del dominio', () => {
    expect(revisarDatosDichos({ intencion: 'eliminar_meta', msg: 'borra lo de la moto', datos: { nombre: 'Moto' } }).pregunta).toBeNull();
    expect(revisarDatosDichos({ intencion: 'eliminar_meta', msg: 'borra lo de la moto', datos: { nombre: 'Viaje' } }).pregunta).not.toBeNull();
    expect(revisarDatosDichos({ intencion: 'eliminar_meta', msg: 'elimina mi meta', datos: {} }).pregunta).toBeNull();
  });
});

describe('rondas 2 y 3: lo que las revisiones adversariales escribieron y pasaba', () => {
  const rev = (intencion, msg, datos) => revisarDatosDichos({ intencion, msg, datos });

  it('"una" no es veinte; los decimales hablados dan sus dos lecturas', () => {
    expect(numerosEnPalabras('Una deuda del bidón de agua')).toEqual([1]);
    expect(numerosEnPalabras('le debo ciento veinte a Juan')).toEqual([120]);
    expect(numerosEnPalabras('quiero ahorrar dos mil quinientos')).toEqual([2500]);
    expect(numerosEnPalabras('un millón de soles')).toEqual([1000000]);
    expect(numerosEnPalabras('treinta y cinco del menú')).toEqual([35]);
    expect(numerosEnPalabras('carne ciento diez punto setenta')).toContain(110.7);
    expect(numerosEnPalabras('le pagué dos con cincuenta')).toContain(2.5);
    expect(numerosEnPalabras('tres cincuenta de pan')).toEqual(expect.arrayContaining([53, 3.5]));
    expect(montoDicho(20, 'Una deuda del bidón de agua')).toBe(false);
    expect(montoDicho(50, 'le pagué dos con cincuenta a Juan')).toBe(true);   // lectura cruda, declarada
    expect(montoDicho(120, 'le debo ciento veinte a Juan')).toBe(true);
    expect(montoDicho(20, 'debo 20 a Juan')).toBe(true);
  });

  it('un nombre de meta que el mensaje no dice PREGUNTA, no cae a la más reciente', () => {
    expect(rev('eliminar_meta', 'elimina esa meta', { nombre: 'Viaje' }).pregunta).toBe(ESCRITURAS.eliminar_meta.pregunta);
    expect(rev('abonar_meta', 'aboné 100 a esa meta', { monto: 100, nombre_meta: 'Viaje' }).pregunta).not.toBeNull();
    expect(rev('abonar_meta', 'separé 200', { monto: 200, nombre_meta: 'Viaje' }).pregunta).not.toBeNull();
    // un selector exige TODAS sus palabras: "viaje europa" no nombra "Viaje Cusco"
    expect(rev('eliminar_meta', 'elimina la meta viaje europa', { nombre: 'Viaje Cusco' }).pregunta).not.toBeNull();
    // controles
    expect(rev('eliminar_meta', 'elimina la meta viaje', { nombre: 'Viaje' }).pregunta).toBeNull();
    expect(rev('eliminar_meta', 'elimina la meta viaje cusco', { nombre: 'Viaje Cusco' }).pregunta).toBeNull();
    expect(rev('eliminar_meta', 'elimina mi meta', {}).pregunta).toBeNull();
    expect(rev('abonar_meta', 'aboné 100 a la moto', { monto: 100, nombre_meta: 'Moto' }).pregunta).toBeNull();
  });

  it('"plan" no nombra una meta (es el plan Pro)', () => {
    expect(rev('abandonar_plan', 'ya no quiero el plan', {}).pregunta).not.toBeNull();
    expect(rev('abandonar_plan', 'abandono mi meta de ahorro', {}).pregunta).toBeNull();
  });

  it('una contraparte que el mensaje no nombra pregunta: los fallbacks no leen "Ya" ni "ella"', () => {
    for (const [intencion, msg] of [['abonar_deuda', 'Ya me pagó 50'], ['abonar_deuda', 'Recién me dio 20'],
      ['registrar_deuda', 'ella me debe 30'], ['saldar_todo_contraparte', 'salda todo con ella'], ['marcar_deuda_pagada', 'ya me pagó todo']]) {
      expect(rev(intencion, msg, { contraparte: 'Juan', monto: 50 }).pregunta, msg).toBe(ESCRITURAS[intencion].pregunta);
    }
    // "Luisa" no nombra "Luis", ni "Rosario" a "Rosa": palabra entera, nunca prefijo
    expect(rev('saldar_todo_contraparte', 'salda todo con Luisa', { contraparte: 'Luis' }).pregunta).not.toBeNull();
    expect(rev('marcar_deuda_pagada', 'Rosario ya me pagó todo', { contraparte: 'Rosa' }).pregunta).not.toBeNull();
    // controles
    expect(rev('abonar_deuda', 'Juan me pagó 20', { contraparte: 'Juan', monto: 20 }).pregunta).toBeNull();
    expect(rev('registrar_deuda', 'le debo 50 a mi vieja', { contraparte: 'mi vieja', monto: 50 }).pregunta).toBeNull();
  });

  it('un espacio que el mensaje no nombra pregunta', () => {
    expect(rev('registrar_gasto_espacio', 'pagué 200 del hotel', { monto: 200, nombre_espacio: 'Viaje Cusco' }).pregunta).not.toBeNull();
    expect(rev('registrar_gasto_espacio', 'pagué 200 del hotel en viaje cusco', { monto: 200, nombre_espacio: 'Viaje Cusco' }).pregunta).toBeNull();
  });

  it('el reporte de "no aparece": sus variantes bloquean, y con un verbo de orden no', () => {
    for (const m of ['No aparece en mi dashboard', 'la deuda del bidón no está en mi dashboard', 'la deuda no se refleja en la app',
      'La deuda de 20 con Juan no aparece en mi dashboard', 'Los 100 que Juan me debe no aparecen en neto', 'La deuda de 20 con Juan no está en mis deudas'])
      expect(esReporteNoAparece(m), m).toBe(true);
    for (const m of ['Juan me debe 100 y no lo veo desde marzo', 'elimina la meta viaje, ya no sale',
      'no me aparece el gasto del cine que borré, recupéralo', 'pon 500 de presupuesto en comida, la web no carga', 'debo 20 a Juan',
      'Mi primo Carlos me prestó 50 porque no me carga el yape', 'Anota que le debo 30 a Rosa, no me aparece en la app',
      'Pon 500 de presupuesto en comida, no lo veo en el dashboard'])
      expect(esReporteNoAparece(m), m).toBe(false);
  });

  it('"al mes" no es una fecha; "para julio", "en 6 meses" y "el 15" sí', () => {
    expect(campoDicho('fecha', '2026-12-31', 'quiero ahorrar 500 al mes')).toBe(false);
    expect(campoDicho('fecha', '2027-07-01', 'quiero ahorrar 500 para julio')).toBe(true);
    expect(campoDicho('fecha', '2027-04-01', 'quiero ahorrar 500 en 6 meses')).toBe(true);
    expect(campoDicho('fecha', '2026-10-15', 'para el 15')).toBe(true);
    expect(campoDicho('fecha', '2026-10-15', 'ahorrar 1500 en total')).toBe(false);
  });

  it('restaurar reconoce las formas del system prompt y del día a día', () => {
    for (const m of ['trae de vuelta el gasto', 'restablece el gasto', 'deshaz lo que borraste', 'recupera lo que borré'])
      expect(rev('restaurar_eliminado', m, {}).pregunta, m).toBeNull();
  });

  it('rondas 3 y 4: el reporte que nombra el lugar bloquea aunque traiga verbos; sin lugar queda declarado', () => {
    for (const m of ['El pago de 50 a Juan no me aparece en la app', 'lo que le pagué a Juan, 50, no aparece en mi dashboard',
      'Los 100 que Juan me debe no aparecen en mi dashboard'])
      expect(esReporteNoAparece(m), m).toBe(true);
    expect(esReporteNoAparece('no me aparece en la app el gasto del cine, recupéralo')).toBe(false);
    // ALCANCE: sin lugar no se juzga (las formas sin lugar bloqueaban préstamos reales)
    expect(esReporteNoAparece('no me aparece la deuda de Juan, me debe 20')).toBe(false);
  });

  it('ronda 3: un monto que el mensaje no dice PREGUNTA en el abono (salvo una fracción)', () => {
    expect(rev('abonar_deuda', 'Juan ya me abonó lo de las 2 entradas', { contraparte: 'Juan', monto: 50 }).pregunta)
      .toBe(ESCRITURAS.abonar_deuda.preguntaMonto);
    expect(rev('abonar_deuda', 'Juan me pagó la mitad.', { contraparte: 'Juan', monto: 50 }).pregunta).toBeNull();
    expect(rev('abonar_deuda', 'Juan me pagó todo lo de las 2 entradas', { contraparte: 'Juan', monto: 50 }).pregunta).not.toBeNull();
    expect(rev('abonar_deuda', 'Juan me pagó una parte de las 3 pizzas', { contraparte: 'Juan', monto: 30 }).pregunta).not.toBeNull();
    expect(rev('abonar_deuda', 'Juan me pagó el 40%', { contraparte: 'Juan', monto: 40 }).pregunta).toBeNull();
  });

  it('ronda 3: montos, fechas, códigos y alcance que antes se rechazaban', () => {
    expect(montoDicho(2500, 'mi hermana me debe 2 mil 500')).toBe(true);
    expect(montoDicho(1500, 'Le debo mil 500 soles a Juan')).toBe(true);
    expect(montoDicho(2500, 'Le debo 2 mil quinientos a Juan')).toBe(true);
    expect(montoDicho(200, 'Juancho me debe dos gambas')).toBe(true);
    expect(montoDicho(20.5, 'le pagué veinte cincuenta a Rosa')).toBe(true);
    expect(campoDicho('fecha', '2027-04-01', 'quiero ahorrar 3000 para semana santa')).toBe(true);
    expect(rev('restaurar_eliminado', 'no era para borrar el taxi, ponlo de nuevo', {}).pregunta).toBeNull();
    expect(rev('unirse_espacio', 'unirme al espacio abc-12345', { codigo: 'ABC12345' }).datos.codigo).toBe('ABC12345');
    expect(rev('unirse_espacio', 'unirme al espacio', { codigo: 'ABC12345' }).datos).not.toHaveProperty('codigo');
  });

  it('fuera del alcance, a propósito: la categoría y corregir_categoria sin comercio no se juzgan', () => {
    expect(rev('configurar_presupuesto', 'pon 300 en movilidad', { monto: 300, categoria: 'Transporte' })).toEqual({ datos: { monto: 300, categoria: 'Transporte' }, descartados: [], pregunta: null });
    expect(rev('corregir_categoria', 'pásalo a transporte', { categoria_nueva: 'Transporte' }).pregunta).toBeNull();
  });
});

describe('inventario cerrado', () => {
  it('todo intent registrado está clasificado exactamente una vez', () => {
    const registrados = listIntents().sort();
    const clasificados = [...Object.keys(ESCRITURAS), ...Object.keys(SIN_REVISION)].sort();
    expect(new Set(clasificados).size).toBe(clasificados.length);
    expect(clasificados).toEqual(registrados);
  });

  it('cada campo declara un tipo que la guarda sabe revisar', () => {
    for (const [intencion, regla] of Object.entries(ESCRITURAS)) {
      for (const tipo of Object.values(regla.campos)) expect(['monto', 'texto', 'fecha', 'moneda', 'codigo'], intencion).toContain(tipo);
      for (const sel of regla.selectores || []) expect(Object.keys(regla.campos), intencion).toContain(sel);
      if (regla.objeto || regla.selectores) expect(regla.pregunta, intencion).toMatch(/\S/);
    }
  });
});
