import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { direccionPrestamo, ladoDelPago, abonoDeDeudaExistente, enrutarPorVerbo } = require('../../lib/prestamos.js');
const pool = require('../nlp/pool.js');

// La dirección de un préstamo la decide el verbo (07-oct-2026). Ver lib/prestamos.js.
describe('direccionPrestamo', () => {
  const TABLA = [
    // Los de prod (usuario d21c11e0).
    ['Y preste 118 soles', 'ambiguo'],
    ['Me preste 50 soles', 'ambiguo'],
    ['No no, yo le preste 118 soles a mi madre', 'me_deben'],
    // Inequívocos: me deben.
    ['presté 100 a Juan', 'me_deben'],
    ['le presté S/100 a Carlos', 'me_deben'],
    ['te presté 20', 'me_deben'],
    ['a Juan le presté 50', 'me_deben'],
    ['preste 118 a Rosa', 'me_deben'],
    ['Preste 500 soles a mi hermano', 'me_deben'],
    ['le he prestado 200 a Ana', 'me_deben'],
    ['me pidió prestado 50 Carla', 'me_deben'],
    ['No, le presté 100 a Juan', 'me_deben'],
    // Inequívocos: debo.
    ['Mi mamá me prestó 200', 'debo'],
    ['Juan me presto 50', 'debo'],
    ['me prestaron 500 del banco', 'debo'],
    ['pedí prestado 300 a mi primo', 'debo'],
    ['le pedí prestado 100 a Juan', 'debo'],
    ['nos prestó 1000 mi suegro', 'debo'],
    ['me ha prestado 80 Lucía', 'debo'],
    // Ambiguos: se pregunta.
    ['Pata me presté 30 mangos taxi', 'ambiguo'],
    ['me presté 50 de Juan', 'ambiguo'],
    ['preste 118', 'ambiguo'],
    ['Juan preste 200 para mi pasaje', 'ambiguo'],
    ['presté 5000 del banco para la moto', 'ambiguo'],
    ['presté 3000 de la caja Arequipa', 'ambiguo'],
    ['le presté 100 a Juan y Pedro me prestó 50', 'ambiguo'],
    // Sin pronombre hace falta el destinatario (revisión del 07-oct): "presté" también es "me endeudé".
    ['Presté 118 soles', 'ambiguo'],
    ['yo preste 118 soles', 'ambiguo'],
    ['presté 2000 en la caja Huancayo para la moto', 'ambiguo'],
    ['presté 1500 al banco para la casa', 'ambiguo'],
    ['yo preste 1500 en el banco', 'ambiguo'],
    ['presté 3000 para la moto', 'ambiguo'],
    ['presté 1500 a la caja Huancayo', 'ambiguo'],
    // Discurso referido sin comillas: el "te presté" lo dijo otro.
    ['Juan me dijo: te presté 200, devuélvemelo', 'ambiguo'],
    ['mi hermana me escribió te presté 300 para tu pasaje', 'ambiguo'],
    // La plantilla que muestra el bot, copiada con sus comillas, no es una cita.
    ['"le presté 118 a mi mamá"', 'me_deben'],
    ['_"le presté 118 a mi mamá"_', 'me_deben'],
    // No dicen un préstamo del usuario.
    ['yo no le presté, Juan me prestó 200', 'debo'],
    ['nunca le presté nada a Juan', null],
    ['le pedí a Carla que me lo preste y me dio 300', null],
    ['Mi mamá me dijo "te presté 200", le debo eso', null],
    ['mi primo quiere que le preste 100', null],
    ['si le preste 100 a Juan, cuánto me queda', null],
    ['Juan le prestó 50 a Pedro', null],
    ['pagué la cuota del préstamo 300', null],
    ["Juan me dijo 'te presté 200'", 'ambiguo'],
    // Sin plata en el mensaje no es un préstamo de plata.
    ['me prestó su carro', null],
    // Personas e instituciones con artículo (tercera revisión del 07-oct: se tomaban por cosas).
    ['me prestó el banco 5000', 'debo'],
    ['me prestó la señora 200', 'debo'],
    ['mi jefa me prestó un adelanto de 800', 'debo'],
    ['le presté un billete de 100 a mi hermano', 'me_deben'],
    // Una persona después del verbo no es una cosa: el préstamo es de plata (el gasto, si lo hay, lo
    // separa `enrutarPorVerbo`).
    ['compré la refri de 1500 con lo que me prestó mi tío', 'debo'],
    ['Me prestó mi tío 200', 'debo'],
    ['se lo presté a mi hermano, 200', 'me_deben'],
    // La plata ANTES del verbo, o en palabras (segunda revisión del 07-oct: volvían al clasificador).
    ['118 le presté a mi madre', 'me_deben'],
    ['100 soles le presté a mi mamá', 'me_deben'],
    ['Los 200 que me prestó Juan, anótalos', 'debo'],
    ['S/ 200 me prestó Juan', 'debo'],
    ['le presté cincuenta a Juan', 'me_deben'],
    ['Juan me prestó doscientos', 'debo'],
    ['Le presté a Juan con intereses 500', 'me_deben'],
    ['Mi tía me prestó con su tarjeta 500', 'debo'],
    ['presté 1,500 a Juan', 'me_deben'],
    // "a" + algo que no es una persona: no es un destinatario.
    ['presté 5000 a pagar en 12 cuotas', 'ambiguo'],
    ['presté 2000 a plazo fijo', 'ambiguo'],
    ['presté 3000 a Falabella', 'ambiguo'],
    ['Presté 3000 a Crediscotia', 'ambiguo'],
    ['Presté 2000 a sola firma en la caja', 'ambiguo'],
    // Una cita con una sola comilla en el borde no es la plantilla: la decide el clasificador, como
    // antes (segunda revisión del 07-oct: salían me_deben, al revés).
    ['"Te presté 200" me reclama Juan', null],
    ['Juan me reclama "te presté 200"', null],
    ['“Te presté 200” me escribe Juan', null],
    ['Mi tío me manda: "te presté 500"', null],
    ['Juan me reclama: te presté 200', 'ambiguo'],
    ['Gasté 25 soles en Wong', null],
    ['', null],
    [null, null],
  ];
  for (const [msg, esperado] of TABLA) {
    it(`${JSON.stringify(msg)} → ${esperado}`, () => {
      expect(direccionPrestamo(msg)).toBe(esperado);
    });
  }
});

describe('el abono a una deuda que ya existe', () => {
  const TABLA = [
    ['Me pagó mi tío 150 que me debía', 'me_deben'],
    ['Juan me devolvió lo que le presté, 100', 'me_deben'],
    ['Andrea ya me yapeó los 40 que me debe', 'me_deben'],
    ['le devolví a Juan los 50 que me prestó', 'debo'],
    ['le pagué a Ana 30 de lo que le debo', 'debo'],
    // Negado o pendiente: no es un abono.
    ['no me pagó lo que me debía', null],
    ['todavía no me paga lo que me debe', null],
    ['Juan nunca me devolvió lo que le presté', null],
    // Sin la referencia a la deuda, no es este caso (lo decide el clasificador).
    ['Juan me pagó 50', null],
    ['me pagaron 3500 de sueldo', null],
    // Pago y referencia de lados opuestos: no se adivina.
    ['me pagó lo que le debía', null],
    // Lo que no es un abono limpio lo decide el clasificador (revisión del 07-oct: saldaban deuda real).
    ['Juan me pagó lo que me debía y le volví a prestar 100', null],
    ['Juan dice que me pagó los 100 que me debe pero es mentira', null],
    ['¿Juan me pagó lo que me debía?', null],
    ['me dijo que me pagó lo que me debía pero no me llegó nada', null],
    ['si Juan me pagó lo que me debía, cuánto me queda', null],
    ['Juan me pagó 100 que me debía y aún me debe 50', null],
    ['Juan me pagó los 100 que me debía, pero es mentira', null],
    ['Juan supuestamente me pagó lo que me debía', null],
    ['creo que Juan me pagó lo que me debía', null],
    ['Juan me pagó lo que me debía pero no me llegó', null],
    // Lo que va DESPUÉS del pago es un cierre normal, no una duda.
    ['Juan me pagó lo que me debía, ya no me debe nada', 'me_deben'],
    ['Le pagué a mi mamá lo que le debía, ya no le debo nada', 'debo'],
    ['Juan me pagó lo que me debía, ahora si estamos a mano', 'me_deben'],
    // El abono parcial, la forma más común con dos cifras.
    // Con dos cifras no se adivina cuál es el abono (tercera revisión: "1,500 de los 2,000" se leía 1.5).
    ['Juan me pagó 50 de los 200 que me debía', null],
    ['Juan me pagó 1,500 de los 2,000 que me debía', null],
    ['Juan me pagó 1 de las 2 cuotas que me debía', null],
    // El plural impersonal es un ingreso (un empleador, un banco), no el abono de una persona.
    ['me pagaron 1500 que me debían del sueldo', null],
  ];
  for (const [msg, esperado] of TABLA) {
    it(`${JSON.stringify(msg)} → ${esperado}`, () => {
      expect(abonoDeDeudaExistente(msg)).toBe(esperado);
    });
  }

  it('el lado del pago sale del verbo', () => {
    expect(ladoDelPago('Juan me pagó 50')).toBe('me_deben');
    expect(ladoDelPago('Annie me dio la mitad')).toBe('me_deben');
    expect(ladoDelPago('le pagué 100 a Juan')).toBe('debo');
    expect(ladoDelPago('le di 50 a Carlos a cuenta')).toBe('debo');
    expect(ladoDelPago('le pagué 50 a Ana, Rosa me pagó 20')).toBe(null);
    expect(ladoDelPago('Abono 30 a la deuda de Pedro')).toBe(null);
  });
});

describe('enrutarPorVerbo', () => {
  // Desde un gasto el código no convierte nada en deuda: pregunta. La única salida sin pregunta es una
  // cosa prestada con posesivo, que sigue siendo el gasto que el clasificador leyó.
  for (const msg of ['Presté 200 a Juan', 'Me preste 50 soles', 'Pata me presté 30 mangos taxi', 'Mi mamá me prestó 200',
    'gasolina 50 para la moto que me prestó Juan', 'puse 100 de gasolina al carro que me prestó mi tío',
    'me prestó mi tío su camioneta y le puse 100 de gasolina', 'me prestó mi hermano la moto, gasolina 20',
    'Juan me prestó la camioneta y le puse 100 de gasolina', 'le presté a Juan el carro y le puse 50 de gasolina',
    'me prestó el banco 5000', 'compré la refri de 1500 con lo que me prestó mi tío',
    'pagué la luz 120 con la tarjeta que me prestó mi hermana', 'pagué 350 de la cuota de lo que me prestaron en el BCP']) {
    it(`desde un gasto, ${JSON.stringify(msg)} pregunta préstamo o gasto, o si es un pago`, () => {
      expect(enrutarPorVerbo({ intencion: 'registrar_manual', datos: { monto: 50 }, msg }).pregunta).toMatch(/préstamo o un gasto|No cambié nada/);
    });
  }
  // Plata con posesivo no es una cosa (cuarta revisión: la lista negra la dejaba como gasto).
  for (const msg of ['Mi mamá me prestó sus ahorros, 2000 soles', 'Me prestó su quincena mi hermano, 800', 'Me prestó sus luquitas mi causa, 50']) {
    it(`desde un gasto, plata con posesivo pregunta: ${JSON.stringify(msg)}`, () => {
      expect(enrutarPorVerbo({ intencion: 'registrar_manual', datos: { monto: 50 }, msg }).pregunta).toMatch(/préstamo o un gasto/);
    });
  }
  for (const msg of ['Mi viejo me prestó su carro y le eché 50 de gasolina', 'le presté mi taladro a Juan y compré brocas por 30',
    'Rosa me prestó su casa de playa, gasté 200 en comida', 'me prestó su moto para ir a comprar 50 de gasolina']) {
    it(`una cosa prestada con posesivo sigue siendo el gasto: ${JSON.stringify(msg)}`, () => {
      const datos = { monto: 50 };
      expect(enrutarPorVerbo({ intencion: 'registrar_manual', datos, msg })).toEqual({ intencion: 'registrar_manual', datos });
    });
  }
  it('desde un gasto, el abono limpio de lo que ME deben abona', () => {
    expect(enrutarPorVerbo({ intencion: 'registrar_manual', datos: { monto: 150 }, msg: 'Me pagó mi tío 150 que me debía' }))
      .toEqual({ intencion: 'abonar_deuda', datos: { monto: 150, tipo: 'me_deben' } });
  });
  it('el tipo del verbo pisa el del clasificador', () => {
    const r = enrutarPorVerbo({ intencion: 'registrar_deuda', datos: { tipo: 'debo', contraparte: 'madre', monto: 118 }, msg: 'No no, yo le preste 118 soles a mi madre' });
    expect(r).toEqual({ intencion: 'registrar_deuda', datos: { tipo: 'me_deben', contraparte: 'madre', monto: 118 } });
  });
  // Lo que tiene FORMA de abono y no es limpio nunca crea una deuda nueva ni se abona (cuarta revisión
  // del 07-oct: subjuntivo, plurales, verbos fuera de la lista, cantidades en palabras).
  for (const msg of ['Mi hermana quiere que le pague los 300 que le debo', 'Juan me pidió que le abone 100 de lo que le debo',
    'Cuando le pague los 200 que le debo a Juan te aviso', 'Tengo que esperar que le deposite los 500 que le debo a mi tío',
    'Mis papás me devolvieron 200 de lo que les presté', 'Juan y Pedro me devolvieron los 300 que les presté',
    'Mis tíos me pagaron los 500 que les presté', 'Me pagó Juan la mitad de los 300 que me debía',
    'Me pagó Juan cien de los 300 que me debía', 'Le pasé 200 a Juan de lo que le debo', 'Le mandé 200 a Juan de lo que le debo',
    'Juan me cobró los 200 que le debía', 'todavía no me paga lo que me debe', 'Juan aún no me devuelve los 200 que le presté',
    'le pague a Ana 30 de lo que le debo', 'Le presté 500 a Juan y ya me devolvió 200', 'Mi hermano me prestó 500 y ya le devolví 200']) {
    for (const intencion of ['registrar_deuda', 'registrar_manual']) {
      it(`${intencion}: no escribe ${JSON.stringify(msg)}`, () => {
        const r = enrutarPorVerbo({ intencion, datos: { contraparte: 'Juan', monto: 50, tipo: 'me_deben' }, msg });
        expect(r.pregunta, JSON.stringify(r)).toBeTruthy();
      });
    }
  }
  for (const msg of ['Juan me pagó 50 de los 200 que me debía', 'Juan me pagó 1,500 de los 2,000 que me debía',
    'no me pagó lo que me debía', 'Juan dice que me pagó los 100 que me debe pero es mentira',
    'Juan me pagó lo que me debía y le volví a prestar 100', 'mi inquilino me pagó 2 de los 3 meses que me debe']) {
    it(`con forma de abono no limpio pregunta: ${JSON.stringify(msg)}`, () => {
      expect(enrutarPorVerbo({ intencion: 'registrar_deuda', datos: { contraparte: 'Juan', monto: 50, tipo: 'me_deben' }, msg }).pregunta)
        .toMatch(/No cambié nada/);
    });
  }
  it('un gasto con una cosa prestada sigue siendo un gasto', () => {
    const datos = { monto: 30, comercio: 'brocas' };
    expect(enrutarPorVerbo({ intencion: 'registrar_manual', datos, msg: 'le presté mi taladro a Juan y compré brocas por 30' }))
      .toEqual({ intencion: 'registrar_manual', datos });
  });
  it('lo ambiguo pregunta, venga de donde venga', () => {
    expect(enrutarPorVerbo({ intencion: 'registrar_deuda', datos: { monto: 118 }, msg: 'Y preste 118 soles' }).pregunta).toMatch(/prestaste tú/);
    expect(enrutarPorVerbo({ intencion: 'registrar_manual', datos: { monto: 118 }, msg: 'Y preste 118 soles' }).pregunta).toMatch(/préstamo o un gasto/);
  });
  it('en registrar_deuda el verbo decide aunque haya un artículo ("me prestó el banco 5000")', () => {
    expect(enrutarPorVerbo({ intencion: 'registrar_deuda', datos: { tipo: 'me_deben', contraparte: 'banco', monto: 5000 }, msg: 'me prestó el banco 5000' }).datos.tipo).toBe('debo');
    expect(enrutarPorVerbo({ intencion: 'registrar_deuda', datos: { tipo: 'debo', contraparte: 'hermano', monto: 100 }, msg: 'le presté un billete de 100 a mi hermano' }).datos.tipo).toBe('me_deben');
  });
  it('"que me debía" con un pago es un abono del lado del pago', () => {
    for (const intencion of ['registrar_manual', 'registrar_deuda', 'abonar_deuda']) {
      const r = enrutarPorVerbo({ intencion, datos: { contraparte: 'tío', monto: 150, tipo: 'debo' }, msg: 'Me pagó mi tío 150 que me debía' });
      expect(r.intencion).toBe('abonar_deuda');
      expect(r.datos.tipo).toBe('me_deben');
      expect(r.datos.monto).toBe(150);
    }
  });
  it('fuera de los intents que registran no toca nada', () => {
    for (const intencion of ['ver_deudas', 'marcar_deuda_pagada', 'saldar_todo_contraparte', 'consolidar_deudas', 'eliminar_transaccion']) {
      const datos = { contraparte: 'Juan' };
      expect(enrutarPorVerbo({ intencion, datos, msg: 'Me pagó Juan lo que me debía, presté 50' })).toEqual({ intencion, datos });
    }
  });
});

// El COSTO de la regla, medido sobre el pool real (tests/nlp/pool.js): fuera de los casos que el pool
// marca con `prestamo`, la regla no puede preguntar de más ni cambiar el intent de nadie. Es la
// medición que separa "arregla los préstamos" de "arregla los préstamos y rompe otra cosa".
describe('enrutarPorVerbo sobre el pool', () => {
  const resultado = (c) => {
    const r = enrutarPorVerbo({ intencion: c.intent, datos: {}, msg: c.msg });
    if (r.pregunta) return 'pregunta';
    if (r.intencion === 'abonar_deuda' && r.datos.tipo && c.intent !== 'abonar_deuda') return 'abono';
    if (r.intencion === 'abonar_deuda' && c.prestamo === 'abono') return 'abono';
    if (r.intencion !== c.intent) return 'cambia:' + r.intencion;
    if (r.intencion === 'registrar_deuda' && r.datos.tipo) return r.datos.tipo;
    return null;
  };

  it('el pool trae los casos de préstamo que dice traer', () => {
    expect(pool.length).toBeGreaterThanOrEqual(514);
    expect(pool.filter((c) => c.prestamo).length).toBe(9);
  });

  for (const c of pool.filter((x) => x.prestamo)) {
    it(`${JSON.stringify(c.msg)} → ${c.prestamo}`, () => {
      expect(resultado(c)).toBe(c.prestamo);
    });
  }

  it('ningún otro caso del pool pregunta ni cambia de intent', () => {
    const tocados = pool.filter((c) => !c.prestamo).map((c) => ({ msg: c.msg, r: resultado(c) }))
      .filter((x) => x.r !== null);
    expect(tocados).toEqual([]);
  });
});

// Los prompts no pueden enseñar lo que el código desmiente (08-oct-2026). Hasta ese día el clasificador
// (message-processor.js) y el parser (parsers.js) decían que "me presté" es jerga de gasto, mientras este
// archivo lo trata como ambiguo y nunca como gasto. El desenlace salía igual porque el código decide
// después, pero la contradicción quedó viva un día entero sin que nada la viera. Las dos reglas se
// BORRARON y no se reemplazaron: medido con el modelo real, cualquier texto nuevo movía otros intents
// sin mejorar ningún desenlace de préstamo (docs/DEFECTOS.md, 08-oct).
describe('ningún prompt enseña "me presté" como gasto', () => {
  const fs = require('fs');
  const path = require('path');
  // PROHÍBE A PROPÓSITO toda mención de "presté" junto a una palabra de gasto, incluida la regla correcta
  // escrita en negativo ("me presté NO es un gasto"): la decisión del 08-oct fue borrar la regla y no
  // reemplazarla, porque medida con el modelo real cualquier texto nuevo movía otros intents sin mejorar
  // ningún desenlace. Quien quiera escribir una regla nueva tiene que medirla con el probe y cambiar este
  // test a la vista, no redactarla para esquivarlo.
  //
  // Es un cable trampa, no una prueba de que el prompt sea correcto. Mira en las dos direcciones ("jerga
  // de gasto: me presté" y "me presté = gasto") y en los cinco archivos que leen el clasificador y el
  // parser. Lo evaden, y está dicho: una oración cortada entre los dos (un punto, un ";" o un salto de
  // línea real, como el de dos strings concatenados), más de 60/80 caracteres entre los dos, un sinónimo
  // fuera de la lista ("consumo") y un escape unicode. La segunda revisión del 08-oct lo atacó con nueve
  // redacciones y la primera versión (solo hacia adelante, tres archivos) dejaba pasar todas.
  const P = '(?:prest[eéoó]|prestar(?:se|me)?|prestaba)(?![a-záéíóúñ])';
  const G = '(?:jerga|gast|pag[oóué]|compr|egreso|register_transaction|registrar(?:_manual)?)';
  const RE_PRESTE_GASTO = new RegExp(P + '[^.;\n]{0,60}?' + G + '|' + G + '[^.;\n]{0,80}?' + P, 'gi');
  for (const f of ['handlers/message-processor.js', 'services/parsers.js', 'tests/nlp/agent.js',
    'handlers/neto-tools.js', 'prompts/NETO_system_prompt.txt']) {
    it(f, () => {
      const src = fs.readFileSync(path.join(__dirname, '../..', f), 'utf8');
      expect([...src.matchAll(RE_PRESTE_GASTO)].map((m) => m[0])).toEqual([]);
    });
  }
});
