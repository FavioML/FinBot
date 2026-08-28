import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * 28-ago-2026. OpenAI se quedó sin saldo y salieron dos defectos del MISMO origen: el código
 * miraba el `429` y no la causa.
 *
 * OpenAI devuelve 429 para dos cosas incomparables. `rate_limit_exceeded` es saturación y se
 * pasa sola en segundos. `insufficient_quota` es la cuenta en cero y no se pasa nunca hasta
 * que alguien pague. Tratarlas igual produjo:
 *
 *  1. Al usuario se le respondía "reenvía tu mensaje en unos segundos y lo registro". Con
 *     saldo en cero eso es imposible de cumplir: `extraerGastoSinIA` es pura y determinista,
 *     así que el mismo texto reenviado cae en la misma rama para siempre.
 *  2. A Favio le llegó un Telegram rotulado `📍 CORREO`, que es el componente que REPORTÓ el
 *     error, no el que estaba roto. Lo leyó como un problema del correo cuando en realidad
 *     estaba caído todo lo que usa IA: NLP de WhatsApp, audios, fotos de recibos y Excel.
 *     El escaneo de Gmail salía en el tag sólo porque fue el único que corrió en esa ventana.
 *
 * El mock se instala ANTES de requerir el módulo a propósito: `error-monitor` destructura
 * `supabase` y `notificarAdmin` en la carga, así que parchear después no lo alcanzaría.
 */

const notificarAdmin = vi.fn().mockResolvedValue(true);
require('../../lib/admin-notify').notificarAdmin = notificarAdmin;
require('../../lib/db').supabase = { from: () => ({ insert: async () => ({ error: null }) }) };

const { registrarError, esOpenAISinCreditos } = require('../../lib/error-monitor');

// El umbral del monitor es 5 iguales en una hora. Cada test usa un mensaje distinto para
// no heredar el contador del anterior (el módulo guarda estado en memoria).
async function dispararAlerta(tag, mensaje) {
  for (let i = 0; i < 5; i++) await registrarError(tag, mensaje);
  return notificarAdmin.mock.calls.at(-1)?.[0] || '';
}

describe('esOpenAISinCreditos distingue saldo agotado de saturación', () => {
  it.each([
    '429 You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.',
    '429 You exceeded your current quota, please check your plan and billing details.',
    'insufficient_quota',
    'Error code: 429 - insufficient quota',
  ])('reconoce %j', (msg) => {
    expect(esOpenAISinCreditos(msg)).toBe(true);
  });

  it.each([
    '429 Rate limit reached for gpt-4o-mini in organization org-x on tokens per min',
    '429 Too Many Requests',
    'rate_limit_exceeded',
    'connection timeout',
  ])('NO confunde %j con falta de saldo', (msg) => {
    expect(esOpenAISinCreditos(msg)).toBe(false);
  });

  it('no revienta con null, undefined ni un no-string', () => {
    // Este predicado corre DENTRO de un catch. Si tira, se lleva puesto el rescate del gasto
    // y el aviso al admin — el peor caso causado por el manejo del peor caso, que es
    // exactamente lo que documenta `msgErr` en este mismo módulo.
    for (const v of [null, undefined, 0, {}, []]) {
      expect(() => esOpenAISinCreditos(v)).not.toThrow();
      expect(esOpenAISinCreditos(v)).toBe(false);
    }
  });

  it('el "billing" de la URL no alcanza por sí solo para dar positivo', () => {
    // Los dos mensajes de OpenAI traen la misma URL de billing. Si el predicado se apoyara en
    // esa palabra, un rate limit legítimo que la incluya se leería como falta de saldo y el
    // usuario recibiría "no reintentes" cuando reintentar era justamente la salida.
    expect(esOpenAISinCreditos(
      '429 Rate limit reached. See https://platform.openai.com/settings/organization/billing/'
    )).toBe(false);
  });
});

describe('la alerta de Telegram dice QUÉ está caído, no quién lo reportó', () => {
  beforeEach(() => notificarAdmin.mockClear());

  it('sin créditos: avisa que es de cuenta y que afecta todo lo que usa IA', async () => {
    const alerta = await dispararAlerta('CORREO', '429 You have no credits remaining. Add credits at billing.');

    // Lo que se rompió: el tag hacía leer el incidente como acotado al correo.
    expect(alerta).toMatch(/NO es del componente/i);
    expect(alerta).toMatch(/WhatsApp/);
    expect(alerta).toMatch(/Gmail/);
    // Y tiene que decir qué hacer, que es lo único que lo destraba.
    expect(alerta).toContain('platform.openai.com');
    // El tag sigue presente: sirve para saber por dónde se detectó, pero ya no es el titular.
    expect(alerta).toContain('CORREO');
    expect(alerta).not.toMatch(/puede indicar un problema sistémico/i);
  });

  it('rate limit de verdad: sigue saliendo la alerta genérica, sin hablar de saldo', async () => {
    // Control. Sin esto, un predicado que devolviera `true` siempre pasaría el test de arriba.
    const alerta = await dispararAlerta('NLP', '429 Rate limit reached for gpt-4o-mini');

    expect(alerta).toMatch(/ALERTA CRITICA/);
    expect(alerta).toMatch(/puede indicar un problema sistémico/i);
    expect(alerta).not.toMatch(/SIN CRÉDITOS/i);
    expect(alerta).not.toContain('platform.openai.com');
  });

  it('un error que no es de OpenAI no cambia de forma', async () => {
    const alerta = await dispararAlerta('WEBHOOK', 'Mensaje entrante sin from');

    expect(alerta).toMatch(/ALERTA CRITICA/);
    expect(alerta).toContain('WEBHOOK');
    expect(alerta).not.toMatch(/SIN CRÉDITOS/i);
  });
});
