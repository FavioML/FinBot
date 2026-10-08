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
    // Lo prestado es una COSA: el monto es de un gasto (revisión del 07-oct, cuatro gastos que se
    // volvían deudas). Sin plata en la cláusula del verbo, decide el clasificador.
    ['Mi viejo me prestó su carro y le eché 50 de gasolina', null],
    ['le presté mi taladro a Juan y compré brocas por 30', null],
    ['Rosa me prestó su casa de playa, gasté 200 en comida', null],
    ['compré la refri de 1500 con lo que me prestó mi tío', null],
    ['pagué 350 de la cuota de lo que me prestaron en el BCP', null],
    // Con la coma corta la cláusula: el monto suelto después ya no se liga (lo decide el clasificador).
    ['se lo presté a mi hermano, 200', null],
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
    ['Juan me pagó 50 de los 100 que me debía', null],
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
  it('un préstamo que llegó como gasto se vuelve deuda con la dirección del verbo', () => {
    expect(enrutarPorVerbo({ intencion: 'registrar_manual', datos: { monto: 200, comercio: 'Juan' }, msg: 'Presté 200 a Juan' }))
      .toEqual({ intencion: 'registrar_deuda', datos: { monto: 200, moneda: undefined, tipo: 'me_deben' } });
  });
  it('el tipo del verbo pisa el del clasificador', () => {
    const r = enrutarPorVerbo({ intencion: 'registrar_deuda', datos: { tipo: 'debo', contraparte: 'madre', monto: 118 }, msg: 'No no, yo le preste 118 soles a mi madre' });
    expect(r).toEqual({ intencion: 'registrar_deuda', datos: { tipo: 'me_deben', contraparte: 'madre', monto: 118 } });
  });
  it('un gasto con una cosa prestada sigue siendo un gasto', () => {
    const datos = { monto: 30, comercio: 'brocas' };
    expect(enrutarPorVerbo({ intencion: 'registrar_manual', datos, msg: 'le presté mi taladro a Juan y compré brocas por 30' }))
      .toEqual({ intencion: 'registrar_manual', datos });
  });
  it('lo ambiguo pregunta, venga de donde venga', () => {
    for (const intencion of ['registrar_manual', 'registrar_deuda']) {
      expect(enrutarPorVerbo({ intencion, datos: { monto: 118 }, msg: 'Y preste 118 soles' }).pregunta).toMatch(/prestaste tú/);
    }
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
