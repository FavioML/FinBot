import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extraerGastoSinIA } = require('../../lib/nlp-guards');

/**
 * B16 de la auditoría CTO del 2026-08-10.
 *
 * El salvavidas del 429 tomaba el PRIMER número del mensaje, sin preguntarse si el
 * mensaje era un gasto, y lo guardaba siempre como soles.
 *
 * LO QUE LA MEDICIÓN CAMBIÓ, y conviene saberlo antes de tocar esto: el hallazgo citaba
 * "163 filas de una vez" como daño ya producido, y ese daño NO existe. De las 163 filas
 * `rate_limit` de `nlp_errors` (2026-04-29 a 2026-06-09), 156 son del harness de CI del
 * NLP agent (whatsapp `51999999999`, `usuario_id` NULL) repartidas en cuatro días, y con
 * `usuario` en null el call-site ni siquiera llama al salvavidas. Las otras 7 son de dos
 * personas reales: cuatro sin un solo dígito y tres del 09-jun. El salvavidas se desplegó
 * el 03-jul (`31180d2`), o sea TRES SEMANAS DESPUÉS del último 429 registrado.
 *
 * `salvarGastoSinIA` nunca corrió en producción. Cero rescates y cero filas basura. Eso
 * no lo vuelve inofensivo —el próximo 429 lo estrena— pero sí significa que no hay
 * comportamiento en producción que estos tests puedan romper, y que la elección correcta
 * es la conservadora en cada duda.
 *
 * Los mensajes de acá abajo NO son inventados: son los que de verdad llegaron por el
 * camino del 429, leídos de `nlp_errors` en prod.
 */

describe('extraerGastoSinIA — los mensajes REALES que llegaron por el camino del 429', () => {
  // Los tres del 09-jun-2026 del usuario d049f587. El segundo es el caso Ricardo, el
  // que le da la razón de existir a todo esto.
  it('rescata "7.90 taxi" (número suelto + sustantivo)', () => {
    expect(extraerGastoSinIA('7.90 taxi')).toEqual({
      monto: 7.9, moneda: 'PEN', tipo: 'gasto', comercio: 'taxi',
    });
  });

  it('rescata "4.10 pastillas" — el caso Ricardo', () => {
    expect(extraerGastoSinIA('4.10 pastillas')).toEqual({
      monto: 4.1, moneda: 'PEN', tipo: 'gasto', comercio: 'pastillas',
    });
  });

  it('rescata "Gaste 4.10 en pastillas" (verbo sin tilde)', () => {
    const r = extraerGastoSinIA('Gaste 4.10 en pastillas');
    expect(r?.monto).toBe(4.1);
    expect(r?.tipo).toBe('gasto');
  });

  // Los cuatro del 29-30 de abril del usuario 64a2262f. Ninguno tiene un dígito, así
  // que la versión vieja ya devolvía null: sirven de control de que no se rompió eso.
  it.each([
    'Comenzaremos desde hoy a llevar el control de todo',
    'Dame mi reporte',
    'Ok',
    'Comencémos',
  ])('no inventa un gasto con %j', (msg) => {
    expect(extraerGastoSinIA(msg)).toBeNull();
  });
});

/**
 * LA prueba del hallazgo: el filtro de intención. Cada uno de estos mensajes producía
 * una fila de plata con la versión anterior.
 */
describe('el filtro de intención (defecto 1 de B16)', () => {
  it('una consulta con verbo de gasto NO se registra', () => {
    // El ejemplo textual del hallazgo. Tiene "gasté": si el verbo se mirara antes que
    // el rechazo, esto entraba como un gasto de S/30.
    expect(extraerGastoSinIA('¿cuánto gasté en los últimos 30 días?')).toBeNull();
    expect(extraerGastoSinIA('cuánto gasté hoy')).toBeNull();
    expect(extraerGastoSinIA('cuánto he gastado en comida')).toBeNull();
  });

  it('un comando que lleva un número pero no es una transacción tampoco', () => {
    expect(extraerGastoSinIA('crea un presupuesto de 200 para comida este mes')).toBeNull();
    expect(extraerGastoSinIA('ponme una meta de 500')).toBeNull();
    expect(extraerGastoSinIA('borra el gasto de 50')).toBeNull();
    expect(extraerGastoSinIA('cambia los 40 de ayer a Transporte')).toBeNull();
  });

  it('lo futuro o hipotético tampoco', () => {
    expect(extraerGastoSinIA('mañana voy a gastar 100 en comida')).toBeNull();
    expect(extraerGastoSinIA('quiero gastar menos de 300 este mes')).toBeNull();
  });

  it('un número suelto sin verbo, sin moneda y sin forma de registro tampoco', () => {
    expect(extraerGastoSinIA('el partido terminó 3 a 1 y fue increíble de ver')).toBeNull();
  });

  /**
   * LA contraprueba del filtro, y la que costó una revisión adversarial.
   *
   * La primera versión buscaba `que`, `como`, `cuando`, `donde` y `cambio` en
   * CUALQUIER posición, y se justificaba diciendo "si rechaza de más el usuario
   * reenvía". Es falso: la función es determinista, así que reenviar el mismo texto
   * cae en la misma rama y el gasto se pierde igual — durante todo el 429, que es
   * justo cuando este código existe. Y esas cuatro son palabras funcionales del
   * español: se comían el caso común.
   *
   * En español la pregunta y el comando se FORMAN al principio. Anclarlos ahí conserva
   * el rechazo que importa y devuelve las frases naturales.
   */
  it('una palabra funcional EN EL MEDIO no cancela el rescate', () => {
    for (const [msg, monto] of [
      ['gaste 20 en el taxi que me llevo al trabajo', 20],
      ['pague 50 al mercado como siempre', 50],
      ['gaste 30 en el cambio de aceite', 30],
      ['pague 100 cuando fui a la clinica', 100],
      ['gaste 40 donde mi tia', 40],
    ]) {
      expect(extraerGastoSinIA(msg)?.monto, msg).toBe(monto);
    }
  });

  it('pero la MISMA palabra al inicio sí rechaza', () => {
    for (const msg of [
      'cuanto gaste hoy',
      'oye cuanto gaste hoy',           // el relleno de saludo no la desancla
      'cambia los 40 de ayer a Transporte',
      'borra el gasto de 50',
      'divide 300 entre 4',
      'crea un presupuesto de 200',
    ]) {
      expect(extraerGastoSinIA(msg), msg).toBeNull();
    }
  });
});

/**
 * Defecto 2: PEN fijo. Es el mismo bug que B15 arregló en el prompt de Vision.
 */
describe('la moneda (defecto 2 de B16)', () => {
  it('"gasté 100 dólares en zapatillas" entra como USD, no como soles', () => {
    const r = extraerGastoSinIA('gasté 100 dólares en zapatillas');
    expect(r?.monto).toBe(100);
    expect(r?.moneda).toBe('USD');
  });

  it.each(['gasté 50 USD en Steam', 'pagué $30 de Netflix', 'compré 20 verdes'])(
    'reconoce dólares en %j', (msg) => {
      expect(extraerGastoSinIA(msg)?.moneda).toBe('USD');
    }
  );

  it('los modismos peruanos son SOLES 1:1, no dólares y no ×1000', () => {
    for (const [msg, monto] of [
      ['gasté 50 lucas en la pollada del trabajo', 50],
      ['boté 20 cocos en el menú del día', 20],
      ['pagué 100 mangos por el uber al aeropuerto', 100],
      ['saqué 30 mortadelos del cajero', 30],
    ]) {
      const r = extraerGastoSinIA(msg);
      expect(r?.moneda, msg).toBe('PEN');
      expect(r?.monto, msg).toBe(monto);
    }
  });

  it('con las dos monedas nombradas gana PEN (default del pipeline)', () => {
    expect(extraerGastoSinIA('pagué 50 soles y 15 dólares de propina')?.moneda).toBe('PEN');
  });
});

/**
 * Defecto 3, el que le da el título al hallazgo: "registra el PRIMER número que
 * encuentra". No hacía falta una consulta para que fallara — bastaba un mensaje que
 * empezara con una fecha o una duración.
 */
describe('cuál número es el monto (defecto 3 de B16)', () => {
  it('toma el que viene DESPUÉS del verbo, no el primero del mensaje', () => {
    // Reales, del harness de CI. El primer número es 3 y 15 respectivamente.
    expect(extraerGastoSinIA('hace 3 días pagué 80 de luz')?.monto).toBe(80);
    expect(extraerGastoSinIA('el 15 de abril gasté 200 en mercado')?.monto).toBe(200);
    expect(extraerGastoSinIA('el lunes pasado gasté 50 en taxi')?.monto).toBe(50);
  });

  it('se salta los números con unidad no monetaria pegada', () => {
    expect(extraerGastoSinIA('compré 2 kg de pollo por 35 soles')?.monto).toBe(35);
    expect(extraerGastoSinIA('pagué 3 horas de estacionamiento, 12 soles')?.monto).toBe(12);
  });

  it('un número con separador de miles es AMBIGUO y no se adivina', () => {
    // "gasté 1.500 soles en alquiler" (real, del harness). La regex vieja capturaba
    // "1.50" y registraba S/1.50 por S/1500. Devolver null manda a reenviar, que es la
    // única salida honesta: 1.500 puede ser mil quinientos o uno con cincuenta.
    expect(extraerGastoSinIA('gasté 1.500 soles en alquiler')).toBeNull();
    expect(extraerGastoSinIA('gasté 1,500 soles en alquiler')).toBeNull();
    // Y dos decimales de verdad siguen entrando.
    expect(extraerGastoSinIA('gasté 1.50 soles en caramelos')?.monto).toBe(1.5);
    expect(extraerGastoSinIA('gasté 50,00 en pan')?.monto).toBe(50);
  });

  it('respeta el techo de la columna', () => {
    expect(extraerGastoSinIA('gasté 1000000 soles')).toBeNull();
    expect(extraerGastoSinIA('gasté 999999.99 soles')?.monto).toBe(999999.99);
  });

  /**
   * Un número sobre el techo CORTA la búsqueda; no pasa al siguiente. Con `continue`,
   * "pagué 1000000 en 5 cosas" registraba S/5 y dejaba el monto real de comercio: la
   * misma adivinanza que el separador de miles, que este módulo ya declara que no se
   * adivina. No se puede rechazar una y aceptar la otra.
   */
  it('un monto fuera de rango no cede el turno al número siguiente', () => {
    expect(extraerGastoSinIA('pagué 1000000 en 5 cosas')).toBeNull();
  });

  /**
   * …pero una corrida de 8+ dígitos es un IDENTIFICADOR (recibo, DNI, RUC, celular), no
   * un importe fuera de rango: se salta y se sigue buscando. Sin la distinción, un
   * número de recibo ANTES del monto abortaba el rescate entero — y este código corre
   * justo cuando al usuario se le prometió que reenviando se registra.
   */
  it('un identificador largo se saltea; no aborta el rescate', () => {
    expect(extraerGastoSinIA('pague mi recibo 1234567890 de 80 soles')?.monto).toBe(80);
    expect(extraerGastoSinIA('pague 50 al 987654321 por el delivery')?.monto).toBe(50);
  });

  /**
   * El monto se saca por ÍNDICE del texto, no con `.replace(token)`: `replace` borra la
   * PRIMERA aparición textual, que desde "el monto es el que sigue al verbo" ya no es
   * la elegida. El síntoma era el monto real metido dentro del nombre del comercio, que
   * es lo que se persiste y lo que el usuario ve en la confirmación.
   */
  it('el comercio no se queda con el monto adentro', () => {
    const r = extraerGastoSinIA('hace 3 dias pague 3 soles de pan');
    expect(r?.monto).toBe(3);
    expect(r?.comercio).toContain('pan');
  });
});

describe('tipo e ingreso', () => {
  it('un ingreso se clasifica como ingreso', () => {
    expect(extraerGastoSinIA('me pagaron 2000 soles')).toMatchObject({ tipo: 'ingreso', monto: 2000 });
    expect(extraerGastoSinIA('cobré 500 del sueldo')?.tipo).toBe('ingreso');
  });

  it('un gasto sigue siendo gasto', () => {
    expect(extraerGastoSinIA('gasté 20 en propina')?.tipo).toBe('gasto');
  });

  /**
   * El verbo de GASTO gana sobre la palabra de ingreso. "compré abono para las
   * plantas" tiene la palabra `abono`, que en el otro sentido es un depósito recibido:
   * con el orden al revés el gasto entraba con el SIGNO INVERTIDO, inflando ingresos,
   * ahorro y el factor de score. Venía así del código viejo y viajó intacto en la
   * mudanza; lo encontró la revisión adversarial, no la suite.
   */
  it('un verbo de gasto gana sobre una palabra de ingreso ambigua', () => {
    expect(extraerGastoSinIA('compre abono 50 para las plantas')).toMatchObject({ tipo: 'gasto', monto: 50 });
  });

  /**
   * "presté 100 a Juan" es una DEUDA (yo presto), no un gasto mío. El "me" de
   * `me presté` es lo que invierte la dirección, y al reescribir la lista de verbos se
   * había perdido.
   */
  it('prestar NO es gastar (el "me" invierte la dirección)', () => {
    expect(extraerGastoSinIA('preste 100 a Juan')).toBeNull();
    expect(extraerGastoSinIA('me presté 100 del banco')?.monto).toBe(100);
  });

  /**
   * El tipo lo decide EL VERBO QUE PRODUJO EL MONTO. Dos versiones invirtieron el signo
   * por caminos opuestos: mirar solo las palabras de ingreso hacía de "compré abono 50"
   * un ingreso; "cualquier verbo de gasto gana" rompía el mixto. Las dos venían de que
   * el monto y el tipo se decidían con reglas distintas.
   */
  it('en un mensaje MIXTO, el tipo sigue al verbo que dio el monto', () => {
    expect(extraerGastoSinIA('me pagaron 500 y compre 100 de comida'))
      .toMatchObject({ monto: 500, tipo: 'ingreso' });
    expect(extraerGastoSinIA('recibi 800 de sueldo, ya pague el alquiler'))
      .toMatchObject({ monto: 800, tipo: 'ingreso' });
  });

  /**
   * Un SUSTANTIVO de ingreso no es evidencia de que haya pasado algo. Con `sueldo` en
   * la lista de verbos, la consulta "el sueldo de 3000 cuando entra" registraba un
   * INGRESO de S/3000 — que va al ahorro y al factor de score. El caso real no se
   * pierde: quien reporta un cobro escribe un verbo.
   */
  it('un sustantivo de ingreso solo no alcanza como evidencia', () => {
    expect(extraerGastoSinIA('el sueldo de 3000 cuando entra')).toBeNull();
    expect(extraerGastoSinIA('cobré 500 del sueldo')).toMatchObject({ monto: 500, tipo: 'ingreso' });
  });

  it('un interrogativo ACENTUADO rechaza en cualquier posición', () => {
    // Sin tilde son relativos y van anclados al inicio; con tilde siempre preguntan.
    expect(extraerGastoSinIA('el sueldo de 3000 cuándo entra')).toBeNull();
    expect(extraerGastoSinIA('de los 200 que gaste ayer cuánto fue en comida')).toBeNull();
  });
});

describe('robustez de entrada', () => {
  it.each([null, undefined, '', '   ', 'sin números'])('devuelve null con %j', (msg) => {
    expect(extraerGastoSinIA(msg)).toBeNull();
  });

  it('el comercio nunca pasa de 40 chars (la columna no es infinita)', () => {
    const r = extraerGastoSinIA('gasté 20 soles ' + 'zapatillasrojas'.repeat(10));
    expect(r?.comercio.length).toBeLessThanOrEqual(40);
  });

  /**
   * Las regex de módulo con flag `g` llevan `lastIndex`. Si alguna se compartiera con
   * estado entre llamadas, la segunda invocación con el mismo texto daría OTRO
   * resultado — un bug que solo aparece en producción, donde la función se llama muchas
   * veces sobre el mismo proceso.
   */
  it('es idempotente: la segunda llamada da lo mismo que la primera', () => {
    for (const msg of ['gasté 50 soles en taxi', '4.10 pastillas', 'gasté 100 dólares en zapatillas']) {
      expect(extraerGastoSinIA(msg), msg).toEqual(extraerGastoSinIA(msg));
    }
  });
});
