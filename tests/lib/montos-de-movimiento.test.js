import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { montosDeMovimiento, contarMontosCandidatos, sentidosDelTexto } = require('../../lib/nlp-guards');

/**
 * `montosDeMovimiento` decide si un mensaje anota VARIOS movimientos (07-oct-2026). Los textos de
 * acá son mensajes de usuarios reales (`conversaciones`, 07-oct), no inventados: cada máscara del
 * contador está por uno de ellos. Medido ese día sobre los 994 mensajes reales distintos: los 11
 * que anotan varios movimientos dan 2 o más, y de los mensajes que registran UN movimiento sólo
 * "Pokémon 151 China S/658" da 2 (el número es parte del nombre; ver el docblock del contador).
 */
const valores = (t) => montosDeMovimiento(t).map((m) => m.valor);
const monedas = (t) => montosDeMovimiento(t).map((m) => m.moneda);

describe('los mensajes reales que anotan varios movimientos cuentan todos sus montos', () => {
  it.each([
    ['Gaste 2 soles más en pasajes, gaste 1.30 en cigarros y preste 118 soles', [2, 1.3, 118]],
    ['70 que realice antes de ayer en comprar juguetes y 34.5 en el almuerzo de hoy', [70, 34.5]],
    ['Gaste 15.92 en la comida de Willy (mi perrito)\nGasté 5 soles en el estacionamiento', [15.92, 5]],
    ['Recibí mil soles hoy y gasté 280 en pago de parachoque y 300 gasto de chancalatas', [1000, 280, 300]],
    ['En los almuerzos de hoy gasté 36 y en pasajes 17 soles', [36, 17]],
    ['Pancito Chapala 3 \nQueso fresco 6.24 \nYogurt la Molina 11', [3, 6.24, 11]],
    ['Compré queso 7.50 soles pan 3 soles tamal 7 soles', [7.5, 3, 7]],
    ['Gaste 2.50 en el desayuno, 15 en el almuerzo y 13 en la cena', [2.5, 15, 13]],
    ['He gastado 8.90 en alimentación y 31 en alimentación tambien', [8.9, 31]],
    ['pan 3 leche 5', [3, 5]],
    ['Gasto 20 en comida, 15 en transporte', [20, 15]],
  ])('%s', (texto, esperado) => {
    expect(valores(texto)).toEqual(esperado);
  });
});

describe('lo que NO es un monto de movimiento (cada caso es un mensaje real de un solo gasto)', () => {
  it.each([
    // fechas
    ['gasté S/10 en cuota para futbol el 06/10', [10]],
    ['El 11/06/26 gaste 82 en alimentación', [82]],
    ['600 ahorro el 16.09', [600]],
    ['200 otros el 17 de setiembre', [200]],
    ['Gasté 8,80 en helado Bembos el día 25 de julio', [8.8]],
    ['Gasté 8.80 en helado Bembos 25 de julio', [8.8]],
    ['CON FECHA 10 DE AGOSTO GASTÉ 171 SOLES EN EL MEDICO ODONTOLOGO', [171]],
    ['Pareja: 5 soles moto casa, 13 mayo', [5]],
    ['Hamburguesa 6 soles pero eso fue ayer 4 de octubre', [6]],
    ['✅ S/11.40 en Alimentación > Snacks · 22-sep-26 lo pagué con la tarjeta de crédito BCP', [11.4]],
    ['30 del bus fue el 18', [30]],
    // horas
    ['gasté 25 en taxi a las 3', [25]],
    ['almuerzo 18 a las 13:30', [18]],
    ['cena 45 a las 9pm', [45]],
    // medidas y cantidades
    ['Gaste S/79.90 en cacerola de 18cm', [79.9]],
    ['Pago 847 de 3 celulares Entel de mi empresa NVF', [847]],
    ['Gaste 3 soles en 1 galleta para elena', [3]],
    ['compré 2 kilos de papa 10', [10]],
    // formas raras de UN número
    ['Gaste 2. 20 soles en Fútbol', [2.2]],
    ['185. 00 cena de Lucero', [185]],
    ['Ingreso de 23 280', [23280]],
    ['me depositaron 15mil', [15000]],
    // identificadores, links y números pegados a letras
    ['pagué mi recibo 1234567890 de 80 soles', [80]],
    ['pagué 30 en https://rappi.pe/p/45', [30]],
    ['compré un iPhone15 a 3500', [3500]],
    ['recarga 4G 50', [50]],
    // más fechas y horas (formas que el set real no trae, una por máscara)
    ['gasté 15 en taxi octubre 5', [15]],
    ['cuota 1560 los días 25', [1560]],
    ['gasté 80 en la matrícula del 2026', [80]],
    ['cena 45 9pm', [45]],
    ['cena 45 tipo 9 pm', [45]],
    ['taxi 12 como a la 1 de la tarde', [12]],
  ])('%s', (texto, esperado) => {
    expect(valores(texto)).toEqual(esperado);
  });

  // Control de que las máscaras no son ciegas: sin ellas el contador viejo SÍ ve dos o más.
  it('el contador viejo sí cuenta las fechas: las máscaras son las que separan', () => {
    expect(contarMontosCandidatos('gasté S/10 en cuota para futbol el 06/10')).toBeGreaterThan(1);
    expect(contarMontosCandidatos('200 otros el 17 de setiembre')).toBeGreaterThan(1);
  });
});

/**
 * La revisión adversarial del 07-oct midió el contador para los dos lados. Sobreconteo: un número
 * que no es plata obligaba a un corte que escribía un monto FANTASMA ("iphone 15 a 3500" → S/15).
 * Subconteo: un monto que no se ve devuelve el ✅ de un subconjunto que todo esto existe para cerrar.
 */
describe('casos de la revisión adversarial', () => {
  it.each([
    ['compré iphone 15 a 3500', [3500]],
    ['pagué 350 de alquiler del depa 302', [350]],
    ['compré 2 polos por 60', [60]],
    ['pagué 2 pasajes de 3.50', [3.5]],
    ['almuerzo 25 para 2', [25]],
    ['gasté 100, me quedan 50', [100]],
    ['pagué 50 de luz, vence el 15 de cada mes', [50]],
    ['pagué 15 en la línea 1', [15]],
    ['compre 3 polos a 30 y 2 pantalones a 80', [30, 80]],
    ['pagué 50 por 2 cosas', [50]],
    // subconteo
    ['Recibí mi sueldo de 2050 y pagué 800 de alquiler', [2050, 800]],
    ['desayuno de 12 ayer y almuerzo de 18', [12, 18]],
    ['gasté 20 en taxi y veinticinco soles en cine', [20, 25]],
    ['me pagaron veintiún soles y gasté veintidós soles en pan', [21, 22]],
    ['gasté dieciocho soles en taxi y 5 en pan', [18, 5]],
    ['gasté 20 en uñas y 35 set de brochas', [20, 35]],
    ['gasté 20 en taxi y 15 de set de uñas', [20, 15]],
    ['Pagué luz 80. 45 de agua', [80, 45]],
    ['taxi 10 200 de recarga', [10, 200]],
    ['gasté 20 en taxi el 5 y 30 en cine el 6', [20, 30]],
  ])('%s', (texto, esperado) => {
    expect(valores(texto)).toEqual(esperado);
  });
});

describe('la moneda que va PEGADA a cada monto', () => {
  it('dólares por "$" y por la palabra, soles por "S/" y por la palabra, null sin nada', () => {
    expect(monedas('gasté $20 en taxi y $5 en café')).toEqual(['USD', 'USD']);
    expect(monedas('pagué 30 dólares de hotel y S/12 de taxi')).toEqual(['USD', 'PEN']);
    expect(monedas('Gaste 2 soles más en pasajes, gaste 1.30 en cigarros')).toEqual(['PEN', null]);
    expect(monedas('Recibí mil soles hoy')).toEqual(['PEN']);
  });
});

describe('montos en palabras', () => {
  it('cuentan con una moneda pegada o detrás de un verbo de plata', () => {
    expect(valores('Recibí mil soles hoy')).toEqual([1000]);
    expect(valores('me pagaron quinientos y gasté 20 en taxi')).toEqual([500, 20]);
    expect(valores('gasté dos mil quinientos soles en la laptop')).toEqual([2500]);
  });
  it('un número suelto en palabras no es un monto', () => {
    expect(valores('anota dos gastos: taxi 10')).toEqual([10]);
    expect(valores('una galleta 3')).toEqual([3]);
    expect(valores('compré una gaseosa 3')).toEqual([3]);
  });
  it('"un sol" y "una luca" sí son montos', () => {
    expect(valores('gasté un sol en caramelos y 5 en pan')).toEqual([1, 5]);
  });
});

describe('sentidosDelTexto', () => {
  it.each([
    ['Registra un ingreso de 200 USD y también uno de 500 soles', { ingreso: true, gasto: false }],
    ['Recibí mil soles hoy y gasté 280', { ingreso: true, gasto: true }],
    ['He gastado 8.90 en alimentación y 31', { ingreso: false, gasto: true }],
    ['Gasto 20 en comida, 15 en transporte', { ingreso: false, gasto: true }],
    ['me yapearon 50 y me depositaron 20', { ingreso: true, gasto: false }],
    ['pan 3 leche 5', { ingreso: false, gasto: false }],
  ])('%s', (t, esperado) => expect(sentidosDelTexto(t)).toEqual(esperado));
});

/**
 * La capa SEGURA (`soloSeguras`) decide si el mensaje va al camino de varios movimientos, así que no
 * puede comerse un monto: las heurísticas que la segunda revisión adversarial rompió ("depa 800",
 * "medias 15", "de 40 anoche", "octubre 95") no corren en ella.
 */
describe('la capa segura no aplica heurísticas', () => {
  const seguros = (t) => montosDeMovimiento(t, { soloSeguras: true }).map((m) => m.valor);
  it.each([
    ['alquiler depa 800 y luz 120', [800, 120]],
    ['polo 35, medias 15', [35, 15]],
    ['Cena de 40 anoche y taxi de 10', [40, 10]],
    ['luz de octubre 95, agua de octubre 40', [95, 40]],
    ['pasaje de 3 ida y 3 de vuelta', [3, 3]],
    ['compré iphone 15 a 3500', [15, 3500]],
  ])('%s', (t, esperado) => expect(seguros(t)).toEqual(esperado));
  it('pero sí las fechas, horas, unidades e ids', () => {
    expect(seguros('gasté S/10 en cuota para futbol el 06/10')).toEqual([10]);
    expect(seguros('200 otros el 17 de setiembre')).toEqual([200]);
    expect(seguros('almuerzo 18 a las 13:30')).toEqual([18]);
    expect(seguros('Gaste S/79.90 en cacerola de 18cm')).toEqual([79.9]);
    expect(seguros('pagué mi recibo 1234567890 de 80 soles')).toEqual([80]);
  });
  it('"medias 15" ya no es "días 15" ni en la capa fina', () => {
    expect(valores('polo 35, medias 15')).toEqual([35, 15]);
  });
});

describe('detalles que la segunda revisión encontró', () => {
  it('"me dieron" es ingreso (el escape de \s)', () => {
    expect(sentidosDelTexto('me dieron 300 de gratificación')).toEqual({ ingreso: true, gasto: false });
    expect(sentidosDelTexto('me mandaron 50')).toEqual({ ingreso: true, gasto: false });
  });
  it('"20$" lleva la moneda pegada', () => {
    expect(monedas('gasté 20$ en taxi')).toEqual(['USD']);
  });
});

describe('tercera revisión adversarial: formas de UN monto que se leían como dos', () => {
  it.each([
    ['Me depositaron 15 mil soles de mi CTS', [15000]],
    ['pagué 90 con 10% de descuento', [90]],
    ['Pagué 120 de luz del 1 al 30', [120]],
    ['pagué 120 de luz de setiembre 2026', [120]],
    ['pagué 4 con 50 de pasaje', [4.5]],
  ])('%s', (t, esperado) => {
    expect(valores(t)).toEqual(esperado);
    expect(montosDeMovimiento(t, { soloSeguras: true }).map((m) => m.valor)).toEqual(esperado);
  });
  it('"50 de Julio" detrás de un verbo de plata y "las 50 lucas" son plata', () => {
    expect(montosDeMovimiento('Recibí 50 de Julio y gasté 40 en taxi', { soloSeguras: true }).map((m) => m.valor)).toEqual([50, 40]);
    expect(montosDeMovimiento('me prestó las 50 lucas y gasté 20', { soloSeguras: true }).map((m) => m.valor)).toEqual([50, 20]);
    // control: la fecha sin verbo delante sigue siendo fecha
    expect(valores('Gasté 8.80 en helado Bembos 25 de julio')).toEqual([8.8]);
  });
});

describe('cuarta revisión adversarial', () => {
  it.each([
    ['2 polos 60', [60], [2, 60]],
    ['3 panes 1.50', [1.5], [3, 1.5]],
    ['Compré 2 pollos a la brasa 70', [70], [2, 70]],
    // con un corte de cláusula en el medio, el 2 no es cantidad del 60
    ['2 polos, 60 taxi', [2, 60], [2, 60]],
    ['2 polos y 60 de taxi', [2, 60], [2, 60]],
    ['almuerzo 25 con 10 de propina y taxi 8', [25, 10, 8], [25, 10, 8]],
  ])('%s', (t, fino, seguro) => {
    expect(valores(t)).toEqual(fino);
    expect(montosDeMovimiento(t, { soloSeguras: true }).map((m) => m.valor)).toEqual(seguro);
  });
  it('"20dls" y "20lks" llevan moneda pegada', () => {
    expect(monedas('gasté 20dls en netflix')).toEqual(['USD']);
    expect(monedas('gasté 20lks en pollo')).toEqual(['PEN']);
  });
});
