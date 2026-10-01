import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';

const require = createRequire(import.meta.url);
const { revisarEdicion, tieneForma, esExplicita, pedirOrden, PEDIR_ORDEN, EDICIONES, numerosDe } = require('../../lib/orden-edicion');
const POOL = require('../nlp/pool.js');

/**
 * La gramática cerrada de una corrección del último movimiento (chip 5, 01-oct-2026).
 *
 * Tres versiones anteriores cayeron ante la revisión adversarial con la MISMA clase (se editaba
 * una fila que nadie nombró). Todo lo que esas revisiones ejecutaron con éxito está abajo como
 * NEGATIVO fijo, y cada mutación que sobrevivió a la tercera tiene su caso.
 */

const AHORA = Date.parse('2026-10-01T15:00:00Z');
const hace = (min) => new Date(AHORA - min * 60000).toISOString();
// La ventana normal detrás de un registro: NETO acaba de confirmar un movimiento guardado.
const TRAS_CONFIRMAR = { historial: [{ rol: 'usuario', mensaje: '25 para traer tronco', created_at: hace(2) }, { rol: 'neto', mensaje: '✅ S/25.00 en Alimentación · 28-sep-26', created_at: hace(2) }], ahora: AHORA };
const algunaForma = (m) => [...EDICIONES].some((i) => tieneForma(i, m));

describe('gastos nuevos, comentarios y otros movimientos: ninguna forma de orden', () => {
  it.each([
    // Los cinco de producción.
    'aby 143', 'Aby 143', '“145 Aby”', 'Manos libres', 'El pago de 12.00 de cigarros, lo pagué con la tarjeta de crédito BCP',
    // Primera revisión.
    'cambie aceite 120', 'cambié las llantas 300', 'cambie 100 dolares', 'cambié dólares 50', 'cambio de aceite 120', 'cambio 100',
    'cambiar la luna del carro 250', 'arreglé la moto 80', 'reemplazo de pantalla 200', 'pon que gaste 15 en menu', 'pon como gasto 30 de luz',
    'ponle 20 de saldo al cel', 'pon 20 de taxi', 'editar videos me pagaron 300', 'Solté 180 en jato para arreglos',
    'fue 10 soles de pasaje', 'Fueron 45 en el mercado', 'fueron 3 pasajes 15', 'era 20 el menu de hoy', 'el de hoy fue 20 de taxi',
    'eso fue todo por hoy', 'ese dia fue mi cumple gaste 100', 'el menu de hoy fue 15', 'esa chompa costó 80', 'la tienda era cara gaste 80',
    'el lugar es caro 40 el menu', 'el total es 120, falta el taxi', 'el total del super fue 230', 'el precio del pasaje es 3.50',
    'esta mal, no gaste eso', 'en realidad gaste 50 en el mercado', 'no fue mucho, 20 en pan', 'quise decir 30 en taxi', 'perdón, aby 143',
    'aby 143 no más', 'menu 12 no incluye 3 de propina', 'pasajes 2 no 1', 'gaste 20 hoy no el sabado', 'cena 80 no fue 100',
    'Neto es 15800 soles', 'me pagaron 300 por la chamba', 'pizza 40 a medias con mi pata', 'otro taxi 15', 'gasté 20 en taxi',
    // Segunda revisión.
    'la luz fue 120', 'el agua fue 38', 'el taxi fue 15', 'la pension es 350', 'el internet es 99', 'el almuerzo fue 25', 'ya son 200', 'ahora son 25',
    'eso fue en efectivo', 'fue en tarjeta bcp', 'fue en yape', 'copia de llaves 10', 'copia del dni 3', 'repite el menu 12', 'repetir examen 50',
    'cambiar dolares en la casa de cambio 350', 'cambiar aceite al carro 120', 'ponlo como gasto 30 de luz', 'cambiar llanta en la vulca 30',
    'editar video por 200', 'ponle gasolina al carro 50', 'el bono fue un ingreso', 'parte del alquiler 500 entre 2',
    'cambia el monto de los tacos a 20', 'cambia el monto del pan a 5', 'el de ayer fue 38', 'el de 50 fue 38', 'el del sabado fue el viernes',
    'corrige el de ayer a 30', 'lo del agua fueron 38', 'corrige Netflix a 25', 'Cambia el monto del taxi a 55',
    // Tercera revisión.
    'total 120', 'total: S/120', 'total son 200', 'el total es 45 pe', 'en total son 200', 'fueron 30 en total', 'la cuenta fue 80',
    'fueron 30 🍕', '🚕 fue 15', 'fue $20 🍔🍟',
    'corregir nombre en reniec 20', 'corregir nombre dni 20', 'actualizar nombre en sunarp 35', 'cambiar nombre del titular de la luz 25',
    'cambia el comercio del taxi a Uber', 'cambia el nombre de los tacos a Taco Bell', 'cambia el nombre del de ayer a Wong', 'nombre aby 143',
    'lo mismo que ayer', 'igual que ayer', 'repite del lunes', 'copia de ayer', 'otra vez lo mismo', 'de nuevo lo mismo', 'repite por favor',
    'lo mismo', 'repite el lunes', 'el nombre era muy largo', 'el comercio fue lo peor',
  ])('"%s"', (m) => {
    expect(algunaForma(m)).toBe(false);
  });

  it('ningún registro del pool tiene forma de orden', () => {
    const registros = POOL.filter((c) => c.intent === 'registrar_manual');
    expect(registros.length).toBeGreaterThanOrEqual(100);
    expect(registros.filter((c) => algunaForma(c.msg)).map((c) => c.msg)).toEqual([]);
  });

  it('un número pelado no es una fecha', () => {
    expect(tieneForma('editar_fecha', 'fueron 25')).toBe(false);
    expect(tieneForma('editar_fecha', 'cámbialo al 19')).toBe(true);   // detrás de verbo y conector, sí
  });
});

describe('correcciones del último con forma de orden', () => {
  it.each([
    // Las ocho de producción.
    ['editar_monto', '300 para ser exacto'], ['editar_monto', 'Editar es 15800'], ['editar_fecha', 'Cambialo al 19 de septiembre'],
    ['editar_fecha', 'Cambiar fecha 29 septiembre'], ['editar_fecha', 'Cambialo a 25 de septiembre'], ['editar_monto', 'Quiero corregir 256.40'],
    ['editar_fecha', 'Esa fecha es de 19 setiembre'], ['editar_fecha', 'Cambiar a 29 setiembre'],
    // Formas comunes y gemelas.
    ['editar_monto', 'cambia el monto a 1,500'], ['editar_monto', 'no era 25, era 30'], ['editar_monto', 'eran 30 bro'], ['editar_monto', 'puse mal, eran 30'],
    ['editar_monto', 'uy eran 30'], ['editar_monto', '30 no 25'], ['editar_monto', 'el ultimo fue 30'], ['editar_monto', 'corrige el monto'], ['editar_monto', 'no, 30'],
    ['editar_fecha', 'fue anoche'], ['editar_fecha', 'fue antes de ayer'], ['editar_fecha', 'fue el 15/09'], ['editar_fecha', 'fue el martes 23'],
    ['editar_fecha', 'ese gasto fue el viernes'], ['editar_fecha', 'el gasto fue el 15 de marzo'], ['editar_fecha', 'cambia la fecha del gasto al lunes'],
    ['editar_comercio', 'el comercio es Aby 143'], ['editar_comercio', 'ponle como comercio Pardos Chicken'], ['editar_comercio', 'quiero corregir lo último'],
    ['corregir_monto_moneda', 'cambia eso a dólares no soles'], ['corregir_monto_moneda', 'el último fueron 200 dólares no soles'], ['corregir_monto_moneda', 'en dolares'],
    ['marcar_como_ingreso', 'márcalo como ingreso'], ['marcar_como_ingreso', 'ese era ingreso no gasto'], ['marcar_como_ingreso', 'no es gasto'],
    ['dividir_gasto', 'divide ese gasto entre 3'], ['dividir_gasto', 'a medias'], ['dividir_gasto', 'entre 2'],
    ['duplicar_gasto', 'duplícalo'], ['duplicar_gasto', 'copia ese gasto'], ['duplicar_gasto', 'repítelo para ayer'],
  ])('%s: "%s"', (intencion, m) => {
    expect(tieneForma(intencion, m)).toBe(true);
  });

  it('los ejemplos que sugieren los handlers de edición son EXPLÍCITOS', () => {
    // Si el bot pide "fue ayer" y detrás de su propia pregunta eso no vale, la persona queda en un
    // círculo. Se leen DEL CÓDIGO del handler, para que cambiar un texto no deje esto atrás.
    const src = fs.readFileSync(require.resolve('../../handlers/intents/transacciones'), 'utf8');
    const casos = [
      ['editar_monto', 'Dime el monto correcto'], ['editar_fecha', 'Dime la fecha correcta'], ['editar_comercio', 'Dime el nombre correcto'],
      ['corregir_monto_moneda', 'Dime el monto. Ej'], ['dividir_gasto', 'Dime entre cuántos dividir'],
    ];
    for (const [intencion, ancla] of casos) {
      const linea = src.split('\n').find((l) => l.includes(ancla));
      expect(linea, ancla).toBeTruthy();
      const ejemplos = [...linea.matchAll(/_"([^"]+)"_/g)].map((m) => m[1]);
      expect(ejemplos.length, ancla).toBeGreaterThan(0);
      for (const e of ejemplos) expect(esExplicita(intencion, e), intencion + ': ' + e).toBe(true);
    }
  });

  it('del pool, reciben la pregunta solo las que nombran otro movimiento o no traen orden (declaradas)', () => {
    const ediciones = POOL.filter((c) => EDICIONES.has(c.intent));
    expect(ediciones.length).toBeGreaterThanOrEqual(30);
    const sinForma = ediciones.filter((c) => !tieneForma(c.intent, c.msg)).map((c) => c.msg).sort();
    expect(sinForma).toEqual([
      // Nombran otro movimiento: por WhatsApp se corrige solo el último (regla 1).
      'Cambia el del taxi a 8 dólares', 'Cambia el monto del taxi a 55', 'El almuerzo fue ayer no hoy', 'El de 50 soles fue en Plaza Vea no Wong',
      'El de Wong fueron 30 no 25', 'Haz un duplicado del de Rappi', 'Pon que el comercio es Wong no Metro',
      // Sin orden con forma: un mensaje más.
      'El de 3500 es ingreso cámbialo', 'Ese gasto lo hice la semana pasada', 'Pon la fecha del 20 de febrero', 'Ponle menos',
    ].sort());
  });
});

describe('regla 3: una corrección ELÍPTICA solo vale detrás de la confirmación de lo guardado', () => {
  // La tercera revisión: NETO pregunta por algo que NO guardó, la persona contesta con la forma
  // corta, y eso editaba el último guardado, que es otro movimiento.
  const pregunta = (mensaje, min = 1) => ({ historial: [{ rol: 'usuario', mensaje: '35.00', created_at: hace(min) }, { rol: 'neto', mensaje, created_at: hace(min) }], ahora: AHORA });
  it.each([
    ['marcar_como_ingreso', 'es ingreso', {}, '¿Esos S/35 entraron o salieron? Escríbemelo con el verbo: "gasté 35 en…" o "me pagaron 35".'],
    ['editar_monto', 'fueron 110.70', { monto_nuevo: 110.7 }, 'No pude leer el monto de ahí. Mándamelo con el número en dígitos y qué fue, así: "110.70 carne".'],
    ['corregir_monto_moneda', 'fueron 20 dolares', { monto: 20, moneda: 'USD' }, 'Solo anoto soles y dólares.'],
    ['editar_fecha', 'fue ayer', { fecha_nueva: '2026-09-30' }, '¿Cuánto pagaste y entre cuántos?'],
    ['dividir_gasto', 'entre 3', { partes: 3 }, '¿Cuánto pagaste y entre cuántos?'],
    // Una confirmación de DEUDA no es la de una transacción.
    ['editar_monto', 'eran 30', { monto_nuevo: 30 }, '✅ *Abono registrado*\n\n🎯 Le debes S/70 a Juan'],
  ])('%s: "%s" detrás de una pregunta o de otra cosa: pide la orden', (intencion, msg, datos, netoAntes) => {
    expect(revisarEdicion(intencion, msg, datos, pregunta(netoAntes))).toMatchObject({ ok: false, motivo: 'eliptica_sin_confirmacion' });
  });

  it('cuenta lo ÚLTIMO que dijo NETO: una confirmación anterior a la pregunta no ancla', () => {
    const ctx = { historial: [
      { rol: 'neto', mensaje: '✅ S/25.00 en Alimentación · 28-sep-26', created_at: hace(3) },
      { rol: 'usuario', mensaje: '35.00', created_at: hace(2) },
      { rol: 'neto', mensaje: '¿Esos S/35 entraron o salieron?', created_at: hace(2) },
    ], ahora: AHORA };
    expect(revisarEdicion('marcar_como_ingreso', 'es ingreso', {}, ctx)).toMatchObject({ ok: false, motivo: 'eliptica_sin_confirmacion' });
  });

  it('"no fue ayer" niega: no es una orden de poner ayer', () => {
    expect(tieneForma('editar_fecha', 'no fue ayer')).toBe(false);
    expect(revisarEdicion('editar_fecha', 'no fue ayer', { fecha_nueva: '2026-09-30' }, TRAS_CONFIRMAR).ok).toBe(false);
  });

  it('una confirmación de hace más de 30 minutos ya no ancla la elipsis', () => {
    const vieja = { historial: [{ rol: 'neto', mensaje: '✅ S/25.00 en Alimentación · 28-sep-26', created_at: hace(31) }], ahora: AHORA };
    expect(revisarEdicion('editar_monto', 'eran 30', { monto_nuevo: 30 }, vieja)).toMatchObject({ ok: false, motivo: 'eliptica_sin_confirmacion' });
    expect(revisarEdicion('editar_monto', 'eran 30', { monto_nuevo: 30 }, TRAS_CONFIRMAR).ok).toBe(true);
  });

  it('sin historial solo valen las explícitas', () => {
    expect(revisarEdicion('editar_monto', 'eran 30', { monto_nuevo: 30 })).toMatchObject({ ok: false, motivo: 'eliptica_sin_confirmacion' });
    expect(revisarEdicion('editar_monto', 'cambia el monto a 30', { monto_nuevo: 30 }).ok).toBe(true);
  });

  it.each([
    '✅ S/25.00 en Alimentación · 28-sep-26', '✅ $5.00 en Suscripciones · 28-sep-26', '✅ Monto corregido.\n*Gasto*: S/ 25.00 → S/ 30.00',
    '✅ Fecha corregida.\n*Taxi*: 30-sep-26 → 29-sep-26', '✅ Comercio corregido.\nx → *y*', '✅ Gasto dividido entre 2.', '✅ Gasto duplicado.\n*Taxi*',
    '✅ *Taxi* (S/ 8.00) ahora está marcado como *ingreso*.', 'Corregido. *Taxi*: $8.00 en Transporte.',
  ])('"%s" es confirmación de un movimiento', (mensaje) => {
    const ctx = { historial: [{ rol: 'neto', mensaje, created_at: hace(1) }], ahora: AHORA };
    expect(revisarEdicion('editar_monto', 'eran 30', { monto_nuevo: 30 }, ctx).ok).toBe(true);
  });
});

describe('revisarEdicion', () => {
  it('el valor nuevo tiene que estar escrito, y afirmado', () => {
    const c = TRAS_CONFIRMAR;
    expect(revisarEdicion('editar_comercio', 'quiero corregir lo último', { comercio_nuevo: 'aby 143' })).toMatchObject({ ok: false, motivo: 'valor_no_dicho' });
    expect(revisarEdicion('editar_monto', 'corrige el monto', { monto_nuevo: 145 })).toMatchObject({ ok: false, motivo: 'valor_no_dicho' });
    expect(revisarEdicion('editar_fecha', 'corrige la fecha', { fecha_nueva: '2026-09-19' })).toMatchObject({ ok: false, motivo: 'valor_no_dicho' });
    expect(revisarEdicion('marcar_como_ingreso', 'márcalo como gasto', { tipo_nuevo: 'ingreso' })).toMatchObject({ ok: false, motivo: 'valor_no_dicho' });
    expect(revisarEdicion('marcar_como_ingreso', 'no es ingreso', { tipo_nuevo: 'ingreso' }, c)).toMatchObject({ ok: false, motivo: 'valor_no_dicho' });
    expect(revisarEdicion('dividir_gasto', 'divídelo entre 3', { partes: 4 })).toMatchObject({ ok: false, motivo: 'valor_no_dicho' });
    expect(revisarEdicion('dividir_gasto', 'divídelo a medias', { partes: 4 })).toMatchObject({ ok: false, motivo: 'valor_no_dicho' });
    expect(revisarEdicion('dividir_gasto', 'divídelo entre Ana y yo', { shared_with: ['Luis'] })).toMatchObject({ ok: false, motivo: 'valor_no_dicho' });
    expect(revisarEdicion('dividir_gasto', 'divídelo con Ana', { shared_with: ['Ana', 'Luis', 'Pepe'] })).toMatchObject({ ok: false, motivo: 'valor_no_dicho' });
    expect(revisarEdicion('dividir_gasto', 'divídelo con juan', { shared_with: ['juan'], partes: 5 })).toMatchObject({ ok: false, motivo: 'valor_no_dicho' });
    expect(revisarEdicion('corregir_monto_moneda', 'cambia eso a soles', { moneda: 'USD' })).toMatchObject({ ok: false, motivo: 'valor_no_dicho' });
    expect(revisarEdicion('corregir_monto_moneda', 'cambia eso a soles', {})).toMatchObject({ ok: false, motivo: 'valor_no_dicho' });
    expect(revisarEdicion('corregir_monto_moneda', 'cambia eso a dolares', { moneda: 'PEN' })).toMatchObject({ ok: false, motivo: 'valor_no_dicho' });
    expect(revisarEdicion('duplicar_gasto', 'duplícalo', { fecha: '2026-09-20' })).toMatchObject({ ok: false, motivo: 'valor_no_dicho' });
    // Palabra entera, no subcadena, y al menos dos letras.
    expect(revisarEdicion('editar_comercio', 'el comercio es Tacos Bell', { comercio_nuevo: 'Taco' })).toMatchObject({ ok: false, motivo: 'valor_no_dicho' });
    expect(revisarEdicion('editar_comercio', 'cambia el nombre a X', { comercio_nuevo: 'X' })).toMatchObject({ ok: false, motivo: 'valor_no_dicho' });
    // Negado no es dicho: "no fue 30" no pide 30.
    expect(revisarEdicion('editar_monto', 'no fue 30', { monto_nuevo: 30 }, c)).toMatchObject({ ok: false, motivo: 'valor_no_dicho' });
    expect(revisarEdicion('editar_monto', 'no era 25, era 30', { monto_nuevo: 25 }, c)).toMatchObject({ ok: false, motivo: 'valor_no_dicho' });
    expect(revisarEdicion('editar_monto', '30 no 25', { monto_nuevo: 25 }, c)).toMatchObject({ ok: false, motivo: 'valor_no_dicho' });
    // Exacto al centavo: 30 no es 30.90.
    expect(revisarEdicion('editar_monto', 'eran 30', { monto_nuevo: 30.9 }, c)).toMatchObject({ ok: false, motivo: 'valor_no_dicho' });
  });

  it('CONTROL: con el valor escrito pasa', () => {
    const c = TRAS_CONFIRMAR;
    expect(revisarEdicion('editar_comercio', 'el comercio es Aby 143', { comercio_nuevo: 'Aby 143' }).ok).toBe(true);
    expect(revisarEdicion('editar_monto', 'cambia el monto a 1,500', { monto_nuevo: 1500 }).ok).toBe(true);
    expect(revisarEdicion('editar_monto', 'cambia el monto a 12,50', { monto_nuevo: 12.5 }).ok).toBe(true);
    expect(revisarEdicion('editar_monto', 'no era 25, era 30', { monto_nuevo: 30 }, c).ok).toBe(true);
    expect(revisarEdicion('editar_monto', 'no, 30', { monto_nuevo: 30 }, c).ok).toBe(true);
    expect(revisarEdicion('dividir_gasto', 'divídelo a medias', { partes: 2 }).ok).toBe(true);
    expect(revisarEdicion('dividir_gasto', 'divídelo entre tres', { partes: 3 }).ok).toBe(true);
    expect(revisarEdicion('dividir_gasto', 'divídelo entre Ana y yo', { shared_with: ['Ana'], partes: 2 }).ok).toBe(true);
    expect(revisarEdicion('marcar_como_ingreso', 'eso no es gasto es ingreso', {}, c).ok).toBe(true);
    expect(revisarEdicion('marcar_como_ingreso', 'no es gasto', {}, c).ok).toBe(true);
    expect(revisarEdicion('duplicar_gasto', 'repítelo para ayer', { fecha: '2026-09-27' }).ok).toBe(true);
  });

  it('el separador de miles se lee como miles', () => {
    expect(numerosDe('cambia el monto a 1,500')).toContain(1500);
    expect(numerosDe('S/ 1,250.50')).toContain(1250.5);
    expect(numerosDe('12,50')).toContain(12.5);
  });

  it('un monto inválido no se juzga acá: lo rechaza validarMonto en el handler', () => {
    expect(revisarEdicion('editar_monto', 'corrige el monto', { monto_nuevo: 'Infinity' }).ok).toBe(true);
  });

  it('nunca deja pasar un sujeto: va al último', () => {
    const r = revisarEdicion('editar_monto', 'cámbialo a 30', { comercio: 'aby', monto_nuevo: 30, fecha_token: 'ayer' });
    expect(r.ok).toBe(true);
    expect(r.datos).toEqual({ monto_nuevo: 30 });
  });

  it('la moneda sin monto escrito conserva el de la fila', () => {
    expect(revisarEdicion('corregir_monto_moneda', 'cambia eso a dolares', { moneda: 'USD', monto: 145 }).datos.monto).toBeUndefined();
    expect(revisarEdicion('corregir_monto_moneda', 'son 25 dolares', { moneda: 'USD', monto: 25 }, TRAS_CONFIRMAR).datos.monto).toBe(25);
    // Un monto que no es número sigue al handler, que lo rechaza sin escribir.
    expect(revisarEdicion('corregir_monto_moneda', 'cambia eso a dolares', { moneda: 'USD', monto: 'mucho' }).datos.monto).toBe('mucho');
  });

  it('una pregunta no es una orden, salvo el pedido cortés al empezar', () => {
    expect(revisarEdicion('editar_monto', 'el monto fue 50?', { monto_nuevo: 50 }).motivo).toBe('pregunta');
    expect(revisarEdicion('editar_monto', 'cambia el monto a 50, puedes?', { monto_nuevo: 50 }).motivo).toBe('pregunta');
    expect(revisarEdicion('editar_monto', '¿puedes cambiar el monto a 50?', { monto_nuevo: 50 }).ok).toBe(true);
  });

  it('los intents que no son ediciones pasan sin mirar', () => {
    expect(revisarEdicion('registrar_manual', 'aby 143', { monto: 143 }).ok).toBe(true);
  });
});

describe('la pregunta fija no deja a nadie en un círculo', () => {
  it.each([...EDICIONES])('%s: sus ejemplos de orden son EXPLÍCITOS; el de gasto nuevo no es orden', (intencion) => {
    const ejemplos = [...pedirOrden(intencion).matchAll(/_"([^"]+)"_/g)].map((m) => m[1]);
    const [nuevo, ...ordenes] = ejemplos;
    expect(nuevo).toBe('gasté 20 en almuerzo');
    expect(algunaForma(nuevo)).toBe(false);
    expect(ordenes.length).toBeGreaterThan(0);
    const familia = ['editar_monto', 'editar_fecha', 'editar_comercio', 'corregir_monto_moneda'].includes(intencion)
      ? ['editar_monto', 'editar_fecha', 'editar_comercio'] : [intencion];
    // Explícitas: valen detrás de la propia pregunta, que no es la confirmación de nada.
    for (const o of ordenes) expect(familia.some((i) => esExplicita(i, o)), o).toBe(true);
  });

  it('dice que por WhatsApp se corrige solo lo último', () => {
    for (const t of Object.values(PEDIR_ORDEN)) expect(t).toMatch(/Por WhatsApp corrijo solo lo último/);
  });
});
