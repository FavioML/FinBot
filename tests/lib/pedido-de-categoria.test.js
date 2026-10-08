import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { diceFecha, montoNegado, esPreguntaSinOrden, esRespuestaPelada, comercioDichoFueraDelDestino, montosEnMensaje, montoDelModelo } = require('../../lib/pedido-de-categoria');
const { pideAlcanceRetroactivo } = require('../../lib/datos-dichos');

/**
 * ¿Qué pide un mensaje que llegó a `corregir_categoria`? (08-oct-2026). Los casos son los de
 * producción: los tres del usuario 90ba3e37 (25 y 27-sep), el "No" del 13-ago, y las correcciones
 * LEGÍTIMAS de toda la historia, que no pueden quedar bloqueadas (query sobre `conversaciones`:
 * toda respuesta "Listo! Movi" con el mensaje que la produjo).
 */

describe('una pregunta no es una orden', () => {
  it.each([
    'y lo de IKF 38 SANTA ANITA 1 ?',
    'a que te refieres con los 15 soles en boticas y salud?',
    'y lo de IKF 38 SANTA ANITA 1', // sin signo: la continuación sin destino
    'a que te refieres con lo de boticas',
    'por que movista eso',
    'cual moviste',
    '¿eso va en salud?',
    // La revisión adversarial del 08-oct, sin "?": abreviaturas, "del", "y el X" y el "a" de un nombre
    'y el ikf', 'y lo del ikf', 'q paso con lo de ikf', 'xq lo moviste a salud', 'en que categoria esta el ikf',
    'osea lo pasaste a salud', 'seguro que el ikf es salud', 'y los 15 soles', '¿puedes cambiarlo?',
    // La segunda revisión: con "?" y una palabra de pedido en cualquier lugar, escribían con regla
    'por favor dime si lo pasaste a salud?', 'porfa, ya lo pasaste a salud?', 'puedes decirme si el ikf esta en salud?',
    'podrias explicarme por que el ikf esta en salud?', 'me pasas la lista de lo que hay en salud?',
    'puedes ver si esta bien en salud?', 'neto porfa me confirmas si quedo en salud?', 'puede ser que el ikf vaya en salud?',
    'pasalo a salud o a comida?', 'me lo pasaste a salud?', 'lo pusiste en salud?',
  ])('%j es pregunta', (m) => expect(esPreguntaSinOrden(m)).toBe(true));

  it.each([
    'si pero 11.40 a Salud',
    'y el de 11.40 a salud',
    '¿puedes mover el de 11.40 a salud?', // el pedido cortés que abre el mensaje
    'eso no va alimentacion snacks, eso va en medicamentos',
    // Las correcciones legítimas de prod
    'Corrige el gasto, se trata de taxi', 'Este cámbialo a salud', 'Cambiar este último registro a Salud',
    'otros', 'gasolina', 'Detergente para el hogar', 'Edwin Qui* 12 - pasar a Traslados',
    // Un "?" que pide una acción con destino es un pedido cortés
    'pasalo a salud?', 'me lo pasas a salud?', 'lo puedes pasar a salud?', 'porfa puedes pasarlo a salud?', 'oye puedes mover el ikf a salud?',
    'lo cambias a salud?', 'me lo pasas a salud porfa?',
  ])('%j no es pregunta', (m) => expect(esPreguntaSinOrden(m)).toBe(false));
});

describe('una respuesta pelada no trae a dónde ni qué', () => {
  it.each(['No', 'no', 'si', 'ok', 'no, eso no', 'Sí, ok', 'ya pe', 'nooo', 'no pues', 'ok gracias neto', '👍', 'no no no no no no'])('%j es pelada', (m) => expect(esRespuestaPelada(m)).toBe(true));
  it.each(['otros', 'otro', 'gasolina', 'salud', 'no, es salud', 'no era comida, era salud', 'super', 'perro', 'esso'])('%j no es pelada', (m) => expect(esRespuestaPelada(m)).toBe(false));
});

describe('el comercio cuenta como dicho solo fuera del destino', () => {
  it('"Salud" no nombra a BOTICAS Y SALUD cuando es la categoría a la que se mueve', () => {
    expect(comercioDichoFueraDelDestino('BOTICAS Y SALUD', 'si pero 11.40 a Salud', 'Salud')).toBe(false);
  });
  it('control: con "boticas" en el mensaje sí lo nombra', () => {
    expect(comercioDichoFueraDelDestino('BOTICAS Y SALUD', 'lo de boticas y salud va en salud', 'Salud')).toBe(true);
  });
  it('control: sin destino que quitar sigue siendo textoDicho', () => {
    expect(comercioDichoFueraDelDestino('Rappi', 'mueve Rappi a Entretenimiento', 'Entretenimiento')).toBe(true);
    expect(comercioDichoFueraDelDestino(null, 'mueve eso a salud', 'Salud')).toBe(false);
  });
  it('la SUBcategoría no se quita: se llama como el comercio ("el taxi era transporte", sub Taxi)', () => {
    expect(comercioDichoFueraDelDestino('taxi', 'el taxi era transporte', 'Transporte')).toBe(true);
    expect(comercioDichoFueraDelDestino('clinica', 'lo de la clinica era salud', 'Salud')).toBe(true);
    expect(comercioDichoFueraDelDestino('taxi', 'el taxi era transporte', ['Transporte', 'Taxi'])).toBe(true);
  });
  it('pero DESPUÉS del marcador de destino tampoco nombra ("eso va en farmacia", sub Farmacia)', () => {
    expect(comercioDichoFueraDelDestino('Farmacia Universal', 'eso va en farmacia', ['Salud', 'Farmacia'])).toBe(false);
    expect(comercioDichoFueraDelDestino('Farmacia Universal', 'lo de farmacia universal va en salud', ['Salud', 'Farmacia'])).toBe(true);
  });
  it('una fecha dicha se reconoce', () => {
    for (const m of ['el ikf del 15.09 era salud', 'el ikf del dia 15.09 era salud', 'el de 15 de setiembre', 'el ikf del 15/09 era salud']) expect(diceFecha(m), m).toBe(true);
    // "hoy", "ayer" y los días describen también un ALCANCE: no cuentan (tercera revisión)
    for (const m of ['si pero 11.40 a Salud', 'el de 15 soles era salud', 'gasolina', 'de hoy en adelante lo de rappi va en delivery',
      'cambia rappi a delivery desde hoy', 'rappi siempre va en delivery, lo pido todos los viernes']) expect(diceFecha(m), m).toBe(false);
  });
  it('una respuesta de una palabra es toda destino: no nombra al comercio del historial', () => {
    expect(comercioDichoFueraDelDestino('BOTICAS Y SALUD', 'salud', ['Salud'])).toBe(false);
    expect(comercioDichoFueraDelDestino('BOTICAS Y SALUD', 'salud pe', ['Salud'])).toBe(false);
    expect(comercioDichoFueraDelDestino('Farmacia Universal', 'farmacia', ['Salud', 'Farmacia'])).toBe(false);
  });
  it('sin marcador pero con una palabra fuera del destino, el comercio sigue dicho (cuarta revisión)', () => {
    expect(comercioDichoFueraDelDestino('taxi', 'el taxi, transporte', ['Transporte', 'Taxi'])).toBe(true);
    expect(comercioDichoFueraDelDestino('taxi', 'taxi = transporte', ['Transporte', 'Taxi'])).toBe(true);
    expect(comercioDichoFueraDelDestino('gimnasio', 'lo del gimnasio salud', ['Salud', 'Gimnasio'])).toBe(true);
    expect(comercioDichoFueraDelDestino('Farmacia Universal', 'farmacia universal salud', ['Salud', 'Farmacia'])).toBe(true);
    expect(comercioDichoFueraDelDestino('Farmacia Universal', 'farmacia salud', ['Salud', 'Farmacia'])).toBe(true);
  });
});

describe('montos negados, miles y números del nombre (tercera revisión)', () => {
  it('el monto rechazado no elige', () => {
    expect(montoNegado('no el de 11.40 no, el de 15 a salud')).toBe(true);
    expect(montoNegado('ese de 11.40 no, el otro, a salud')).toBe(true);
    expect(montoNegado('el de 15 no es comida, es salud')).toBe(false); // el "no" niega la categoría
    expect(montoNegado('si pero 11.40 a Salud')).toBe(false);
    // Un "no" ANTES de la cifra y "otra vez" son correcciones claras (cuarta revisión)
    for (const m of ['no el de 11.40 va en salud', 'no no, el de 11.40 a salud', 'no se, el de 11.40 ponlo en salud', 'otra vez, el de 11.40 a salud']) expect(montoNegado(m), m).toBe(false);
    expect(diceFecha('el pollo de 1/4 era comida')).toBe(false);
    // "el 11.40" es un monto, no el 11 de abril (quinta revisión)
    for (const m of ['el 11.40 a salud', 'el pastel 12.50 era comida', 'el uber, el 20.00, a transporte']) expect(diceFecha(m), m).toBe(false);
  });
  it('"S/ 1,234.50" no se lee como S/ 1.23', () => {
    expect(montosEnMensaje('el alquiler de s/ 1,234.50 era vivienda')).toEqual([]);
  });
  it('"ikf 38" con el comercio "IKF": el 38 es del nombre', () => {
    expect(montoDelModelo(38, 'lo de ikf 38 era salud', 'IKF')).toBeNull();
  });
  it('un verbo de mover en pasado habla de lo que hizo Neto', () => {
    for (const m of ['lo pasaste a salud', 'ya lo moviste a salud', 'me lo cambiaste a salud', 'todavia esta en comida, no lo pasaste a salud']) expect(esPreguntaSinOrden(m), m).toBe(true);
  });
});

describe('los montos del mensaje', () => {
  it('con céntimos, con moneda, o ninguno', () => {
    expect(montosEnMensaje('si pero 11.40 a Salud')).toEqual([11.4]);
    expect(montosEnMensaje('los 15 soles en boticas')).toEqual([15]);
    expect(montosEnMensaje('S/15 de boticas a salud')).toEqual([15]);
    expect(montosEnMensaje('el de 8,50 era salud')).toEqual([8.5]);
    expect(montosEnMensaje('y lo de IKF 38 SANTA ANITA 1 ?')).toEqual([]); // números del nombre
    expect(montosEnMensaje('el del 15 de setiembre era salud')).toEqual([]); // una fecha
    expect(montosEnMensaje('el ikf del 15.09 era salud')).toEqual([]); // una fecha con punto
    expect(montosEnMensaje('si pero 11.4 a Salud')).toEqual([11.4]); // un solo decimal
  });
  it('dos montos son dos correcciones', () => {
    expect(montosEnMensaje('el cabify de 8.37 era salud y el cabify de 99.91 era educación')).toEqual([8.37, 99.91]);
  });
  it('el mismo monto repetido es uno', () => {
    expect(montosEnMensaje('el de 11.40, sí, 11.40, a salud')).toEqual([11.4]);
  });
  it('el monto del modelo vale si está escrito y no es parte del comercio', () => {
    expect(montoDelModelo(8, 'el taxi de 8 era salud', 'taxi')).toBe(8);
    expect(montoDelModelo(38, 'y lo de IKF 38 a salud', 'IKF 38 SANTA ANITA 1')).toBeNull();
    expect(montoDelModelo(20, 'el taxi era salud', 'taxi')).toBeNull(); // del historial
    expect(montoDelModelo(null, 'x', null)).toBeNull();
  });
});

describe('"lo de X" nombra UN gasto; "todo lo de X" es alcance', () => {
  it.each(['pon lo de Uber en Transporte', 'y lo de IKF 38 SANTA ANITA 1 ?'])('%j no retroaplica', (m) => expect(pideAlcanceRetroactivo(m)).toBe(false));
  it.each(['todo lo de Uber va en Transporte', 'los de uber son transporte', 'siempre pon uber en transporte'])('%j retroaplica', (m) => expect(pideAlcanceRetroactivo(m)).toBe(true));
});
