import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { esCorreoMasivo, direccionDe } = require('../gmail');
const { parsearCorreoBancario } = require('../services/parsers');

const mockCreate = globalThis.__mockOpenAICreate;

/**
 * UNA PROMOCIÓN NO ES UN GASTO.
 *
 * Reportado por Favio el 04-sep-2026 mirando su propio dashboard: una fila de S/ 100 en
 * "LATAM Pass BCP" con método "BCP Crédito" que él nunca gastó. El origen era el mailing
 * "¡Favio, gana hasta 1,000,000 de Millas!" de `bcpcomunica@email.bcp.com.pe`, cuyo cuerpo dice
 * "Por cada S/ 100 de consumo, con tu Tarjeta de Crédito LATAM Pass BCP, puedes participar".
 * Confirmado en la base: la fila traía `gmail_msg_id = 1a06ec07139adf60`, o sea que la escribió
 * el barrido de Gmail y no la persona.
 *
 * Había DOS agujeros y el correo pasó por los dos, así que este archivo prueba los dos por
 * separado — tapar uno solo deja la clase viva:
 *
 *   1. Ningún filtro de LECTURA lo paraba. La dirección no está en `REMITENTES_BANCARIOS`, así
 *      que entró por la query de palabras clave, y `esBancario` es un OR de palabras sueltas
 *      donde "BCP", "tarjeta", "consumo" y "S/" alcanzan de sobra. Ninguna palabra del cuerpo
 *      separa "gastaste S/ 100" de "gana millas por cada S/ 100 de consumo": el discriminador
 *      está en los headers de envío masivo, no en el texto.
 *
 *   2. El PARSER no tenía cómo negarse. Su JSON no incluía ningún campo para decir "esto no es
 *      un movimiento", y el system prompt lo declara "parser experto de notificaciones
 *      bancarias": ante un texto con un monto, la única salida disponible era inventar el gasto.
 *      El único gate posterior es `if (!resultado.monto) return` — y monto había.
 */

const CUERPO_PROMO_BCP = [
  '¡Favio, gana hasta 1,000,000 de Millas! Hola, Favio.',
  '¡Tus compras pueden llevarte a viajar como nunca!',
  'Por cada S/ 100 de consumo, con tu Tarjeta de Crédito LATAM Pass BCP, puedes participar por',
  'uno de los increíbles premios en Millas LATAM Pass: 50,000 Millas (20 ganadores),',
  '¡1,000,000! de Millas (4 ganadores), 10,000 Millas (100 ganadores).',
  '¡Inscríbete hoy, acumula opciones con tus compras y acércate a tu próximo destino!',
  'Participa aquí. BANCA EXCLUSIVA.',
].join(' ');

const headers = (obj) => Object.entries(obj).map(([name, value]) => ({ name, value }));

describe('capa 1: el filtro de lectura descarta el envío masivo', () => {
  const REMITENTE_PROMO = 'BCP Comunica <bcpcomunica@email.bcp.com.pe>';
  const REMITENTE_ALERTA = 'BCP <alertas@bcp.com.pe>';

  it('descarta el correo real que originó el falso gasto', () => {
    // Gmail sólo dibuja el botón "Anular la suscripción" que se ve en la captura cuando el
    // mensaje trae `List-Unsubscribe`. Ése es el header, y es el que decide.
    expect(esCorreoMasivo(headers({
      From: REMITENTE_PROMO,
      Subject: '¡Favio, gana hasta 1,000,000 de Millas!',
      'List-Unsubscribe': '<https://email.bcp.com.pe/unsub?id=abc>',
    }), REMITENTE_PROMO)).toBe(true);
  });

  it('reconoce las otras marcas de envío masivo', () => {
    for (const h of [
      { 'List-Id': '<campanas.email.bcp.com.pe>' },
      { 'Feedback-ID': '1234:campaign:bcp:ses' },
      { Precedence: 'bulk' },
      { Precedence: 'list' },
    ]) {
      expect(esCorreoMasivo(headers({ From: REMITENTE_PROMO, ...h }), REMITENTE_PROMO)).toBe(true);
    }
  });

  it('NO toca al remitente transaccional aunque traiga los mismos headers', () => {
    // El camino que hoy funciona no se toca: no pude inspeccionar los headers reales de un
    // aviso de consumo de `alertas@bcp.com.pe`, y perder un gasto real en silencio es peor
    // error que el que se está arreglando. Las promos que salgan de acá las agarra la capa 2.
    expect(esCorreoMasivo(headers({
      From: REMITENTE_ALERTA,
      'List-Unsubscribe': '<https://bcp.com.pe/unsub>',
      Precedence: 'bulk',
    }), REMITENTE_ALERTA)).toBe(false);
  });

  it('deja pasar un aviso normal de un remitente desconocido', () => {
    const otro = 'Banco Nuevo <avisos@banconuevo.pe>';
    expect(esCorreoMasivo(headers({ From: otro, Subject: 'Realizaste un consumo' }), otro)).toBe(false);
  });

  it('lee la dirección esté o no entre ángulos, y sin importar mayúsculas', () => {
    expect(direccionDe('BCP <Alertas@BCP.com.pe>')).toBe('alertas@bcp.com.pe');
    expect(direccionDe('alertas@bcp.com.pe')).toBe('alertas@bcp.com.pe');
  });

  it('el nombre visible no alcanza para hacerse pasar por transaccional', () => {
    // Un phishing puede escribir lo que quiera en el display name; la dirección es lo único
    // que el filtro mira. Con `List-Unsubscribe` encima, sigue siendo masivo.
    const disfrazado = 'alertas@bcp.com.pe <promos@otrodominio.com>';
    expect(esCorreoMasivo(headers({
      From: disfrazado, 'List-Unsubscribe': '<https://x/u>',
    }), disfrazado)).toBe(true);
  });
});

describe('capa 2: el parser puede negarse a inventar un movimiento', () => {
  beforeEach(() => mockCreate.mockReset());

  it('con es_movimiento:false no devuelve monto, así que ningún llamador registra nada', async () => {
    // Lo que el modelo contesta hoy sobre este cuerpo, con la REGLA CERO en el prompt.
    mockCreate.mockResolvedValue({ choices: [{ message: { content: '{"es_movimiento":false}' } }] });
    const r = await parsearCorreoBancario(CUERPO_PROMO_BCP, '¡Favio, gana hasta 1,000,000 de Millas!');
    expect(r.es_movimiento).toBe(false);
    expect(r.monto).toBeUndefined();
  });

  it('pela el monto aunque el modelo desobedezca y lo mande igual', async () => {
    // La respuesta EXACTA que produjo la fila fantasma, más el campo nuevo en false. El gate no
    // puede confiar en que el modelo se calle los otros campos: lo que se registra es el monto.
    mockCreate.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      es_movimiento: false, tipo: 'gasto', monto: 100, moneda: 'PEN',
      comercio: 'LATAM Pass BCP', categoria: 'Otros', subcategoria: 'sin_categoria',
      banco: 'BCP', metodo_pago: 'Credito', fecha: '2026-09-04',
    }) } }] });
    const r = await parsearCorreoBancario(CUERPO_PROMO_BCP, 'promo');
    expect(r.monto).toBeUndefined();
    expect(r.comercio).toBeUndefined();
  });

  it('un movimiento real sigue pasando entero', async () => {
    mockCreate.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      es_movimiento: true, tipo: 'gasto', monto: 19.2, moneda: 'PEN',
      comercio: 'PedidosYa', categoria: 'Alimentación', subcategoria: 'delivery',
      banco: 'BCP', metodo_pago: 'Credito', fecha: '2026-09-04',
    }) } }] });
    const r = await parsearCorreoBancario('Realizaste un consumo de S/ 19.20 en DLC*PEDIDOSYA', 'consumo');
    expect(r.monto).toBe(19.2);
    expect(r.comercio).toBe('PedidosYa');
  });

  it('una respuesta SIN el campo se comporta exactamente como antes de la regla', async () => {
    // El gate compara contra `false` explícito. Un modelo que no opine no puede volverse un
    // rechazo silencioso: ahí estaría el mismo daño de perder gastos reales.
    mockCreate.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      tipo: 'gasto', monto: 28, moneda: 'PEN', comercio: '345 RESTO CAFE',
      categoria: 'Alimentación', subcategoria: 'restaurante', banco: 'BCP',
    }) } }] });
    const r = await parsearCorreoBancario('Realizaste un consumo de S/ 28.00 en IZI*345 RESTO CAFE', 'consumo');
    expect(r.monto).toBe(28);
  });
});

describe('el prompt le enseña la regla al modelo', () => {
  it('la REGLA CERO nombra el campo y el caso que se rompió', async () => {
    mockCreate.mockResolvedValue({ choices: [{ message: { content: '{"es_movimiento":false}' } }] });
    await parsearCorreoBancario('cualquier cosa', 'x');
    const system = mockCreate.mock.calls[0][0].messages[0].content;
    // Sin estas piezas el campo existe pero el modelo no sabe cuándo usarlo: el gate quedaría
    // verde mirando una respuesta que nunca dice false.
    expect(system).toContain('es_movimiento');
    expect(system).toContain('REGLA CERO');
    expect(system).toMatch(/promoc|sorteo|publicidad/i);
    expect(system).toMatch(/estado de cuenta/i);
  });
});
