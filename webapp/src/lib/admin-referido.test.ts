import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { avisosReferido, montoEsperado } from './admin-referido';
import { PRO_PRICE_MONTHLY_PEN } from './constants';

/**
 * Lo que el admin ve ANTES de aprobar un comprobante, que es una pantalla que mueve plata.
 *
 * El caso que da nombre al archivo: cuando `resumenReferidoParaAdmin` no pudo leer devuelve
 * `parcial: true`, y sus valores por defecto —0% de descuento, sin referrer— **son exactamente
 * los de un usuario sin referido**. La condición de render del panel era
 * `descuentoPct > 0 || referrerNombre`, así que en el caso `parcial` no se pintaba nada: la
 * pantalla callaba justo cuando había algo que decir, y el admin aprobaba creyendo que se
 * esperaban S/10 cuando quizá eran S/5.
 *
 * El aviso de Telegram (`lib/pro-payment.js` en el backend) ya imprimía la advertencia. Las
 * dos superficies dicen lo mismo desde el 01-sep-2026; **son dos proyectos npm con dos CI que
 * sólo hacen checkout de lo suyo**, así que el texto está duplicado a propósito y no
 * compartido — igual que las reglas de `copy-claims.test.ts` y `verify-claims.mjs`.
 */
describe('avisosReferido', () => {
  const SANO = { descuentoPct: 0, referrerNombre: null, yaPremiado: false, parcial: false };

  it('con la lectura CAÍDA avisa, aunque los otros campos vengan en su default', () => {
    // El caso entero: `parcial` con el default completo es indistinguible de "sin referido".
    const avisos = avisosReferido({ ...SANO, parcial: true });
    expect(avisos.length, 'la pantalla donde se aprueba el pago no dijo nada').toBeGreaterThan(0);
    expect(avisos[0].tono).toBe('advertencia');
    expect(avisos[0].texto).toMatch(/no se pudo leer/i);
  });

  it('CONTROL: un usuario sin referido y con la lectura sana no muestra nada', () => {
    // La mitad que impide "avisar siempre". Con los mismos valores que el caso de arriba, lo
    // único que cambia es `parcial` — si esto se pusiera rojo, el panel gritaría en cada pago.
    expect(avisosReferido(SANO)).toEqual([]);
    expect(avisosReferido(null)).toEqual([]);
    expect(avisosReferido(undefined)).toEqual([]);
    // Y una respuesta vieja del backend, sin el campo, tampoco.
    expect(avisosReferido({ descuentoPct: 0, referrerNombre: null, yaPremiado: false })).toEqual([]);
  });

  /**
   * **La primera versión de esta función cortaba después de la advertencia**, con el argumento
   * de que al lado de "no pude leer" un monto se lee como dato. Estaba mal, y lo encontró una
   * revisión adversarial: `parcial` se enciende desde TRES sitios independientes del backend
   * (la lectura del descuento, la de la fila de `referidos`, y su catch), así que hay entradas
   * alcanzables donde una mitad se leyó perfecto — y cortar borraba justo el dato que evita el
   * daño. Los dos casos de acá abajo son ésos, y son los que Telegram ya mostraba enteros.
   */
  it('con la lectura parcial NO borra lo que sí se pudo leer', () => {
    // Falló la fila de `referidos`, el descuento se leyó: el monto esperado es un dato real.
    const conDescuento = avisosReferido({ descuentoPct: 50, referrerNombre: null, yaPremiado: false, parcial: true });
    expect(conDescuento.map((a) => a.tono)).toEqual(['advertencia', 'info']);
    expect(conDescuento[1].texto, 'se ocultó un descuento que sí se había leído').toContain('S/ 5.00');

    // Falló la lectura del descuento, el referrer se leyó: hay alguien que gana un mes.
    const conReferrer = avisosReferido({ descuentoPct: 0, referrerNombre: 'Ana', yaPremiado: false, parcial: true });
    expect(conReferrer.map((a) => a.tono)).toEqual(['advertencia', 'info']);
    expect(conReferrer[1].texto, 'se ocultó un referrer que sí se había leído').toContain('Ana');
  });

  it('la advertencia no afirma CUÁL de las lecturas falló, porque no lo sabe', () => {
    // El backend enciende un solo flag para tres sitios. El texto anterior decía "no se pudo
    // leer el descuento Y el referrer", que es falso en los dos casos de arriba.
    const texto = avisosReferido({ ...SANO, parcial: true })[0].texto;
    expect(texto).not.toMatch(/descuento y (el )?referrer/i);
    expect(texto, 'no dice qué hacer con el aviso').toMatch(/reintenta/i);
  });

  it('con descuento vigente dice el monto esperado y el precio de lista', () => {
    const avisos = avisosReferido({ descuentoPct: 50, referrerNombre: null, yaPremiado: false });
    expect(avisos).toHaveLength(1);
    expect(avisos[0].tono).toBe('info');
    // Los dos números, y los dos importan: sin el de lista, "S/ 5.00" no dice que hay descuento.
    expect(avisos[0].texto).toContain('S/ 5.00');
    expect(avisos[0].texto).toContain('S/ 10.00');
  });

  it('nombra al referrer y distingue si ya cobró su mes', () => {
    // `convertido_pro` significa "el referido pagó", NO "al referrer se le pagó el mes": desde
    // la migración 062 son dos hechos distintos que pueden diferir. El backend ya resuelve
    // `yaPremiado` con `premio_otorgado_at`; acá se afirma que el panel no los colapsa.
    const debe = avisosReferido({ descuentoPct: 0, referrerNombre: 'Ana', yaPremiado: false });
    const pagado = avisosReferido({ descuentoPct: 0, referrerNombre: 'Ana', yaPremiado: true });
    expect(debe[0].texto).toMatch(/gana 1 mes gratis/);
    expect(pagado[0].texto).toMatch(/ya recibió su mes/);
    expect(debe[0].texto, 'los dos estados dicen lo mismo').not.toBe(pagado[0].texto);
  });

  it('sin nombre del referrer cae al id, en vez de callar que hay uno', () => {
    // `resumenReferidoParaAdmin` deja `referrerNombre` en null SIN marcar `parcial` cuando no
    // pudo leer el nombre, y su comentario declara que "el consumidor lo imprime cuando falta".
    // Eso era cierto para Telegram y falso para esta pantalla, que es un segundo consumidor —
    // y también pasa con un `usuarios.nombre` simplemente NULL, sin ningún error de por medio.
    const avisos = avisosReferido({ descuentoPct: 0, referrerNombre: null, referrerId: 'e3b1-uuid', yaPremiado: false });
    expect(avisos, 'el admin no se enteró de que hay un referrer que gana un mes').toHaveLength(1);
    expect(avisos[0].texto).toContain('e3b1-uuid');
    expect(avisos[0].texto).toMatch(/gana 1 mes gratis/);
  });

  it('CONTROL: sin nombre y sin id no hay referrer que nombrar', () => {
    // La mitad que impide que el fallback se vuelva "avisar siempre": un usuario sin referido
    // tiene las dos en null y no tiene que producir una línea vacía.
    expect(avisosReferido({ descuentoPct: 0, referrerNombre: null, referrerId: null, yaPremiado: false })).toEqual([]);
  });

  it('las dos líneas informativas conviven en el mismo aviso', () => {
    const avisos = avisosReferido({ descuentoPct: 50, referrerNombre: 'Ana', yaPremiado: false });
    expect(avisos).toHaveLength(2);
    expect(avisos.map((a) => a.tono)).toEqual(['info', 'info']);
  });

  it('el monto esperado sale del precio real, no de un 10 escrito a mano', () => {
    expect(montoEsperado(50)).toBe(PRO_PRICE_MONTHLY_PEN / 2);
    expect(montoEsperado(0)).toBe(PRO_PRICE_MONTHLY_PEN);
    expect(montoEsperado(100)).toBe(0);
    // **Con un precio distinto del real**, y ésa es la mitad que hace el caso: hoy
    // `PRO_PRICE_MONTHLY_PEN` vale 10, así que hardcodear un 10 en la fórmula pasa las tres
    // aserciones de arriba sin que nada se entere. Verificado por mutación.
    expect(montoEsperado(50, 20)).toBe(10);
    const texto = avisosReferido({ descuentoPct: 50, referrerNombre: null, yaPremiado: false }, 20)[0].texto;
    // Los DOS números, y el de lista es el que discrimina: con el precio hardcodeado en 10 el
    // texto también contiene "S/ 10.00" (como monto esperado en vez de como precio de lista),
    // así que afirmar sólo ése pasaba por vacuidad. Lo encontró una revisión adversarial.
    expect(texto).toContain('se espera S/ 10.00');
    expect(texto).toContain('(no S/ 20.00)');
  });
});

/**
 * El complemento estático, y es corto a propósito: lo único que un test de node no puede
 * comprobar del JSX es que el componente USE la función. Sin esto, alguien puede dejar
 * `avisosReferido` perfecta y con sus casos en verde, y volver a poner la condición vieja en
 * la pantalla — que es exactamente el defecto que se está arreglando.
 *
 * **Exige una FORMA, no una cadena.** La primera versión prohibía el literal
 * `referido.descuentoPct > 0 ||`, y una revisión adversarial la evadió **reordenando los dos
 * operandos** (`referido.referrerNombre || referido.descuentoPct > 0`): el defecto volvía
 * entero, `tsc` limpio y los ocho casos en verde. Lo que decide de verdad es que el panel no
 * MIRE esos campos: el módulo es el dueño de qué se muestra, y el JSX sólo pinta la lista.
 */
describe('el panel usa la función, no una condición propia', () => {
  const sinComentarios = (src: string) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  // Sin comentarios: el bloque nuevo CITA la condición vieja para explicar por qué se fue, y
  // sin quitarlo este guard se pondría rojo por su propia documentación.
  const PANEL = sinComentarios(readFileSync(
    path.join(process.cwd(), 'src', 'app', 'admin', 'operacion', 'page.tsx'),
    'utf8',
  ));

  it('la lista de avisos es lo que decide el render', () => {
    // Antivacuidad: si el borrador se comiera el archivo, todo lo de abajo pasaría solo.
    expect(PANEL).toMatch(/function PaymentsModal/);
    expect(PANEL, 'el panel dejó de usar la función').toMatch(/avisosReferido\(/);
    expect(PANEL, 'la condición de render dejó de salir de la lista').toMatch(/avisos\.length > 0 &&/);
  });

  it('el panel no vuelve a mirar los campos crudos del referido', () => {
    // Cualquier reimplementación de la condición —en el orden que sea, con `?.` o sin él—
    // tiene que tocar alguno de estos tres. El módulo es el único que los lee.
    for (const campo of ['descuentoPct', 'referrerNombre', 'yaPremiado']) {
      expect(
        PANEL,
        'el panel volvió a decidir con referido.' + campo + ' en vez de con la lista de avisos',
      ).not.toMatch(new RegExp('referido\\??\\.' + campo));
    }
  });

  it('el detector no se come el código de al lado (contraprueba)', () => {
    // Lo que vive en un comentario no cuenta...
    expect(sinComentarios('// referido.descuentoPct > 0')).not.toMatch(/referido\.descuentoPct/);
    expect(sinComentarios('/** referido.descuentoPct */')).not.toMatch(/referido\.descuentoPct/);
    // ...pero el código sí, y un comentario de línea no arrastra la línea siguiente.
    expect(sinComentarios('// nota\nreferido.descuentoPct > 0')).toMatch(/referido\.descuentoPct/);
    // Y una URL con `//` no se come el resto de su línea.
    expect(sinComentarios("const u = 'https://x.com'; referido.descuentoPct;")).toMatch(/referido\.descuentoPct/);
  });
});

/**
 * "No se pudo leer" no es "no hay", tampoco para el historial de pagos.
 *
 * Con el GET caído, `pagos` quedaba en `[]` y el modal afirmaba "Sin pagos registrados
 * todavía." sobre un historial que no se pudo consultar — el mismo colapso que este archivo
 * arregla para el contexto de referido, dos líneas más abajo en la misma pantalla, y el que
 * `routes/admin.js` convirtió en 500 justamente para evitar. El botón de aprobar se pinta
 * igual, porque `hasPending` sale de la fila del usuario y no del fetch, así que el admin
 * podía aprobar sin historial y sin aviso de referido creyendo que los había visto.
 *
 * Lo encontró la revisión adversarial del arreglo del contexto de referido, dos líneas más
 * arriba en el mismo componente.
 */
describe('el historial de pagos distingue vacío de caído', () => {
  const PANEL = readFileSync(
    path.join(process.cwd(), 'src', 'app', 'admin', 'operacion', 'page.tsx'),
    'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('la respuesta no-ok deja un estado de error, no sólo un toast', () => {
    // El setter tiene que llamarse con ALGO, no sólo con el `null` que lo resetea al empezar
    // el fetch. Verificado por mutación: con `/setErrorCarga\(/` a secas, borrar la llamada de
    // la rama de error dejaba el caso en verde, porque el reset la seguía cumpliendo.
    expect(PANEL, 'el estado de error nunca se enciende: sólo se resetea').toMatch(/setErrorCarga\(\s*(?!null\s*\))/);
    expect(PANEL, 'falta el reset al reintentar: un error viejo taparía una carga buena').toMatch(/setErrorCarga\(null\)/);
    // Y ese estado tiene que DECIDIR el render, no quedarse guardado sin consumidor.
    expect(PANEL, 'el estado de error no llega a la pantalla').toMatch(/errorCarga \?/);
  });

  it('el texto de vacío sigue existiendo, y no es el que se muestra al fallar', () => {
    // El control: sin esta mitad, borrar el caso vacío pasaría el test de arriba.
    expect(PANEL).toMatch(/Sin pagos registrados todavía/);
    expect(PANEL).toMatch(/No se pudo leer el historial de pagos/);
  });
});
