import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { partirEscrituraLectura, detectarContinuacion } = require('../../services/multi-intent-splitter');
const pool = require('../nlp/pool.js');

/**
 * `partirEscrituraLectura` decide ESCRIBIR PLATA a partir de un regex, así que la mitad que
 * pesa de este archivo son los negativos y la medición sobre el pool real. Los positivos
 * solos serían un test que se cree a sí mismo.
 *
 * El caso que lo origina: "Gasté 20 en Movilidad, cuánto llevo hoy" perdía el gasto entero
 * porque `detectarQuerySinMonto` mira el mensaje COMPLETO y contesta "esto es una consulta".
 * Quien estaba en el muro recibía el paywall en lugar de su gasto.
 */

const parte = (m) => partirEscrituraLectura(m);

describe('partirEscrituraLectura — positivos', () => {
  // Cada fila: [mensaje, monto esperado, comercio esperado, intención de lectura esperada].
  // Se asierta el CONTENIDO de las dos mitades, no solo que partió: un splitter que corta en
  // el lugar equivocado también devuelve un objeto, y ahí el gasto se guarda mal.
  const CASOS = [
    ['Gasté 20 en Movilidad, cuánto llevo hoy', 20, 'Movilidad', 'listar_gastos_dia'],
    ['Gasté 20 en Movilidad y cuánto llevo hoy', 20, 'Movilidad', 'listar_gastos_dia'],
    ['gasté 100 en comida y cuánto llevo este mes', 100, 'comida', 'ver_total_gastado'],
    ['Gasté 1.50 en Movilidad, cuánto llevo hoy', 1.5, 'Movilidad', 'listar_gastos_dia'],
    ['gasté 20 en taxi, cuánto gasté esta semana', 20, 'taxi', 'listar_gastos_semana'],
    ['20 taxi, cuánto llevo hoy', 20, 'taxi', 'listar_gastos_dia'],
    ['Pagué 45 en farmacia, cuál fue mi gasto mayor', 45, 'farmacia', 'ver_gasto_mayor'],
    // ⚠️ LOS TRES DE ACÁ SON LA REGRESIÓN DEL BUG MÁS GRAVE QUE TUVO ESTE MÓDULO, y por eso
    // están del lado POSITIVO y asertan el MONTO, no solo que partió.
    //
    // La primera versión de `SEP_MIXTO` cortaba en la primera coma sin mirar si era decimal:
    // "Gasté 1,50 en pan, cuánto llevo hoy" se partía en "Gasté 1" y registraba **S/1.00 con
    // un ✅ encima**. Perder el gasto (el bug original) es visible y la persona lo reescribe;
    // cobrarle un tercio del monto no lo es.
    //
    // Un negativo NO alcanza para cuidar esto: lo que hay que fijar es que el monto que llega
    // a `guardarTransaccion` sea el COMPLETO. Si alguien saca los lookarounds de `SEP_MIXTO`,
    // estos tres se ponen rojos por el monto, que es la única aserción que lo delata.
    ['Gasté 1,50 en pan, cuánto llevo hoy', 1.5, 'pan', 'listar_gastos_dia'],
    ['gasté 12,90 en menú, cuánto llevo hoy', 12.9, 'menú', 'listar_gastos_dia'],
    ['Pagué 45,50 en farmacia, cuánto gasté esta semana', 45.5, 'farmacia', 'listar_gastos_semana'],
  ];

  for (const [msg, monto, comercio, lectura] of CASOS) {
    it(`parte ${JSON.stringify(msg)}`, () => {
      const r = parte(msg);
      expect(r).toBeTruthy();
      expect(r.intencionLectura).toBe(lectura);
      const { extraerGastoSinIA } = require('../../lib/nlp-guards');
      const g = extraerGastoSinIA(r.parte1);
      expect(g.monto).toBe(monto);
      expect(g.comercio).toBe(comercio);
    });
  }
});

describe('partirEscrituraLectura — negativos (pesan más que los positivos)', () => {
  const NO_PARTEN = [
    // Un gasto solo. Sin consulta no hay nada que separar.
    ['Gasté 20 en Movilidad', 'no hay mitad de lectura'],
    // Una consulta sola. La mitad de escritura no existe.
    ['cuánto llevo hoy', 'no hay mitad de escritura'],
    ['cuánto gasté hoy, en serio', 'la parte 1 ES la consulta'],
    ['cuánto llevo hoy, cuánto llevo esta semana', 'las dos mitades son consultas'],
    // Los saldos, que este repo rebota A PROPÓSITO: modelar patrimonio es otra decisión.
    // Registrarlos en silencio es peor que rebotarlos (un usuario real terminó con
    // "Ingresos: S/ 3815.70" sobre plata que no era ingreso).
    ['592.91', 'saldo dictado'],
    ['En mi cuenta de ahorros de BCP tengo 1045.21', 'saldo en prosa'],
    ['Ingreso por saldo de Sueldo 592.91', 'saldo real que ya llegó a producción'],
    // Dos montos en la mitad de escritura: no se puede saber cuál es EL monto, y adivinar
    // sobre plata ajena guardaría S/15 con comercio "taxi 40 cena".
    ['gasté 15 en taxi y 40 en cena, cuánto llevo', 'dos montos candidatos'],
    // Comas que no separan dos intenciones. Son la razón por la que la coma no se puede
    // agregar a CONJUNCION a secas.
    ['Compré 3 panes, 2 leches y una gaseosa', 'coma de lista, no de intención'],
  ];

  for (const [msg, porque] of NO_PARTEN) {
    it(`NO parte ${JSON.stringify(msg)} (${porque})`, () => {
      expect(parte(msg)).toBeNull();
    });
  }

  /**
   * Los de acá son distintos del resto y por eso van aparte: son los ÚNICOS que fallan por UNA
   * sola de las cuatro condiciones de la regla.
   *
   * Los negativos de arriba están todos sobre-determinados (los rechazan dos o tres
   * condiciones a la vez), así que quitarle una guarda a la función los deja pasar igual y el
   * archivo entero seguía verde. Se midió: las mutaciones "se quita la guarda de montos", "se
   * quita el extractor" y "la parte1 puede ser consulta" sobrevivían las tres con 125 tests en
   * verde. Cada uno de éstos mata exactamente una.
   *
   * **La lección que costó el bug de la coma decimal:** un negativo que pasa no dice nada
   * hasta que sabés POR QUÉ rechaza. El control de "Gasté 1,50 en pan" existía, pasaba, y
   * rechazaba por no tener mitad de lectura — el motivo escrito al lado era falso, y debajo
   * vivía un registro de S/1.00 en vez de S/1.50. Por eso estas filas nombran la condición.
   *
   * Si agregás una condición nueva a `partirEscrituraLectura`, le corresponde su fila acá, y
   * la forma de encontrar el mensaje es descomponer la regla y buscar el que caiga por una
   * sola condición — no alcanza con que "parezca" del caso.
   */
  const AISLANTES = [
    ['gasté 15 en taxi 40 en cena, cuánto llevo hoy',
     'contarMontosCandidatos(mensaje entero) !== 1',
     'sin esto se guarda S/15 con comercio "taxi 40 en cena" y la persona ve un ✅ creyendo que entraron los dos'],
    // Éste es el que prueba que el conteo va sobre el mensaje ENTERO y no sobre `parte1`: el
    // corte MUEVE el segundo monto a parte2, donde con la guarda vieja nadie lo contaba.
    // Medido: registraba S/15 y los 40 desaparecían sin dejar rastro.
    ['pagué 15 taxi, 40 cena, cuánto llevo hoy',
     'contarMontosCandidatos(mensaje entero) !== 1 — con la guarda sobre parte1 esto PASABA',
     'el separador cae ANTES del segundo monto, así que parte1 tiene uno solo y la guarda vieja lo dejaba entrar'],
    ['Compré 3 panes, 2 leches y una gaseosa, cuánto llevo hoy',
     'contarMontosCandidatos(mensaje entero) !== 1 — misma forma, lista de compras',
     'registraba S/3 con comercio "panes" y descartaba el resto de la lista'],
    ['me quedan 200 disponibles, cuánto llevo hoy',
     'extraerGastoSinIA(parte1) es null',
     'la mitad 1 no es un gasto: es un saldo. Sin el extractor, la pregunta bastaba para inventar una escritura'],
    ['gasté 500 en saldo, cuánto llevo hoy',
     'detectarQuerySinMonto(parte1) reconoce la parte 1 como consulta',
     'la mitad 1 se lee como consulta de saldo Y como gasto extraíble: ante la duda no se escribe plata'],
  ];

  /**
   * Descompone el mensaje en las condiciones de la regla para poder afirmar CUÁL rechaza.
   *
   * Sí, el separador está escrito dos veces (acá y en el módulo), y es a propósito: los
   * reconocedores son los REALES —`detectarQuerySinMonto`, `extraerGastoSinIA`,
   * `contarMontosCandidatos`— así que lo único duplicado es dónde cae el corte. Sin esto, un
   * negativo solo puede decir "no partió", que es justo lo que hizo pasar el bug de la coma
   * decimal durante toda una sesión.
   */
  function condicionesQueRechazan(msg) {
    const SEP = /\s*(?:(?<!\d),(?!\d)|;|\s+(?:pero\s+tambi[eé]n|y\s+tambi[eé]n|pero|y|luego|despu[eé]s)\s+)\s*/i;
    const { extraerGastoSinIA, contarMontosCandidatos } = require('../../lib/nlp-guards');
    const { detectarQuerySinMonto } = require('../../handlers/intents/transacciones');
    const m = msg.match(SEP);
    if (!m) return ['sin-separador'];
    const p1 = msg.slice(0, m.index).trim();
    const p2 = msg.slice(m.index + m[0].length).trim();
    const fallan = [];
    if (p1.length < 4 || p2.length < 4) fallan.push('mitad-muy-corta');
    if (!detectarQuerySinMonto(p2)) fallan.push('parte2-no-es-consulta');
    if (detectarQuerySinMonto(p1)) fallan.push('parte1-ES-consulta');
    if (contarMontosCandidatos(msg) !== 1) fallan.push('montos-del-mensaje-entero');
    if (!extraerGastoSinIA(p1)) fallan.push('parte1-no-rinde-gasto');
    return fallan;
  }

  for (const [msg, condicion, porque] of AISLANTES) {
    it(`NO parte ${JSON.stringify(msg)} — y la ÚNICA razón es: ${condicion}`, () => {
      expect(parte(msg)).toBeNull();
      // Lo que de verdad vuelve útil a este negativo: que rechace por UNA condición. Con dos o
      // más, quitarle esa guarda al módulo lo deja pasar igual y el test sigue verde.
      const fallan = condicionesQueRechazan(msg);
      expect(fallan).toHaveLength(1);
      expect(porque).toBeTruthy();
    });
  }

  it('no parte basura ni tipos raros', () => {
    for (const m of [null, undefined, '', '   ', 42, {}, [], ',', ' , ']) {
      expect(parte(m)).toBeNull();
    }
  });
});

/**
 * La medida que decide si esto se puede shippear: cuántos mensajes REALES partiría de más.
 *
 * Un cero acá, solo, sería verde por vacuidad — pasaría igual con una función que devuelve
 * null siempre. Lo que le da sentido es el bloque de positivos de arriba, que prueba que la
 * misma función sí parte cuando corresponde. Los dos juntos son la afirmación completa:
 * parte lo que tiene que partir y nada del corpus real.
 */
describe('partirEscrituraLectura — costo medido sobre el pool real', () => {
  it('no parte NINGUNO de los 510 casos del pool', () => {
    const partidos = pool.filter((c) => parte(c.msg));
    // El mensaje del assert nombra los culpables: un número pelado no dice qué revisar.
    expect(partidos.map((c) => `${c.intent}: ${c.msg}`)).toEqual([]);
  });

  it('el pool sigue siendo el corpus que este test cree estar midiendo', () => {
    // Sin esto, alguien puede vaciar o mover el pool y el cero de arriba se vuelve trivial.
    expect(pool.length).toBeGreaterThanOrEqual(500);
  });
});

/**
 * El splitter es el dueño de "este mensaje tiene dos mitades", así que la continuación
 * multi-intent tiene que ver el caso de la coma igual que ya veía el de la conjunción. Sin
 * esto, `registrar_manual` registraría la escritura y la pregunta se quedaría sin respuesta.
 */
describe('detectarContinuacion — hereda el caso de la coma', () => {
  it('devuelve la lectura para el mixto separado por coma', () => {
    const c = detectarContinuacion('Gasté 20 en Movilidad, cuánto llevo hoy', 'registrar_manual');
    expect(c).toBeTruthy();
    expect(c.intencion).toBe('listar_gastos_dia');
    expect(c.parte2).toBe('cuánto llevo hoy');
  });

  it('sigue resolviendo el caso viejo de la conjunción (mlt-003)', () => {
    const c = detectarContinuacion('gasté 100 en comida y cuánto llevo este mes', 'registrar_manual');
    expect(c).toBeTruthy();
    expect(c.intencion).toBe('ver_total_gastado');
    expect(c.parte2).toBe('cuánto llevo este mes');
  });

  it('la coma NO se convierte en separador general: no toca los otros pares', () => {
    // (b) register+edit y (c) delete+register siguen exigiendo conjunción. Si la coma se
    // hubiera agregado a CONJUNCION en vez de a un separador propio, esto partiría.
    expect(detectarContinuacion('borra el último, registra 100 en comida', 'eliminar_transaccion')).toBeNull();
    expect(detectarContinuacion('registra 50 en taxi hoy, edita el de ayer a 90', 'registrar_manual')).toBeNull();
  });
});
