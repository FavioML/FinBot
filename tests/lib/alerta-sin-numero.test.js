import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * 02-sep-2026. Llegó una alerta que decía *"Error repetitivo detectado · WEBHOOK · Mensaje
 * entrante sin from · 5 veces en la última hora · Esto puede indicar un problema sistémico"*, y
 * las dos afirmaciones del final estaban mal: no había ningún problema del sistema, y "5 veces"
 * escondía el único dato que decidía qué hacer.
 *
 * Detrás de esas 5 había UNA persona (Julio) mandando su código de verificación nueve veces
 * seguidas. El mismo umbral lo habrían disparado cinco personas distintas cayendo una vez cada
 * una, y significa lo contrario: la primera es un caso de soporte, la segunda es el canal de
 * adquisición perdiendo gente. El copy genérico las mostraba idénticas, así que para distinguirlas
 * había que ir a la base — que es justo lo que una alerta debería evitar.
 *
 * El mock va ANTES del require porque `error-monitor` destructura sus dependencias en la carga.
 */

const notificarAdmin = vi.fn().mockResolvedValue(true);
require('../../lib/admin-notify').notificarAdmin = notificarAdmin;
require('../../lib/db').supabase = { from: () => ({ insert: async () => ({ error: null }) }) };

const { registrarError, esSinNumeroVisible } = require('../../lib/error-monitor');

const SIN_FROM = 'Mensaje entrante sin from';

/**
 * Dispara el umbral (5 en una hora) con los actores dados y devuelve la alerta.
 * Cada test usa un `tag` distinto: el contador del módulo es estado en memoria por
 * `tag:mensaje`, así que compartirlo heredaría el conteo del test anterior.
 */
async function alertaCon(tag, actores) {
  for (const actor of actores) await registrarError(tag, SIN_FROM, { actor });
  return notificarAdmin.mock.calls.at(-1)?.[0] || '';
}

describe('la alerta de usuarios sin número dice CUÁNTA GENTE, no cuántos mensajes', () => {
  it('una sola persona insistiendo se lee como una sola persona', async () => {
    const alerta = await alertaCon('T1', Array(5).fill('PE.111'));

    expect(alerta).toMatch(/SIN NÚMERO VISIBLE/);
    expect(alerta).toMatch(/Una persona/i);
    expect(alerta).toMatch(/insistiendo/i);
    // Lo que NO tiene que decir: el copy viejo mandaba a buscar un bug que no existe.
    expect(alerta).not.toMatch(/problema sistémico/i);
  });

  it('cinco personas distintas se leen como cinco, no como "5 veces"', async () => {
    const alerta = await alertaCon('T2', ['PE.1', 'PE.2', 'PE.3', 'PE.4', 'PE.5']);

    expect(alerta).toMatch(/5 personas distintas/);
    expect(alerta).not.toMatch(/Una persona/i);
  });

  // El control que separa los dos casos de arriba: si el conteo mirara los MENSAJES en vez de los
  // actores, los dos tests anteriores pasarían igual (los dos tienen 5 mensajes). Este exige que
  // los dos números salgan de fuentes distintas: 5 mensajes, 2 personas.
  //
  // **La alerta sale UNA vez, al cruzar el umbral, y después el cooldown de 10 minutos la calla.**
  // O sea que lo que se lee es la foto de ese instante, no el acumulado del episodio — la primera
  // versión de este test mandaba 9 mensajes y esperaba "9", y lo que llega es el quinto.
  it('cuenta actores distintos, no mensajes', async () => {
    const alerta = await alertaCon('T3', ['PE.a', 'PE.a', 'PE.a', 'PE.b', 'PE.a']);

    expect(alerta).toMatch(/2 personas distintas/);
    expect(alerta).toMatch(/5 mensajes/);
    expect(alerta).not.toMatch(/5 personas/);
  });

  it('sin actor declarado no inventa un conteo de personas', async () => {
    // `registrarError` sin `actor` es el caso de todos los demás llamadores del repo. La alerta
    // tiene que degradar a contar mensajes, nunca decir "0 personas".
    for (let i = 0; i < 5; i++) await registrarError('T4', SIN_FROM);
    const alerta = notificarAdmin.mock.calls.at(-1)?.[0] || '';

    expect(alerta).toMatch(/SIN NÚMERO VISIBLE/);
    expect(alerta).toMatch(/5 mensajes en la última hora/);
    expect(alerta).not.toMatch(/0 personas/);
    expect(alerta).not.toMatch(/personas distintas/);
  });

  it('dice que Neto no está roto y qué sí funciona', async () => {
    const alerta = await alertaCon('T5', ['PE.x', 'PE.y', 'PE.z', 'PE.w', 'PE.v']);

    // La distinción que hace accionable la alerta: el OTP sí se resuelve solo, responderles no.
    expect(alerta).toMatch(/Neto no está roto/i);
    expect(alerta).toMatch(/NETO-XXXXXX/);
    expect(alerta).toMatch(/no funciona es contestarles/i);
  });

  it('el predicado no se lleva puesto cualquier error del webhook', () => {
    expect(esSinNumeroVisible('Mensaje entrante sin from')).toBe(true);
    expect(esSinNumeroVisible('MENSAJE ENTRANTE SIN FROM')).toBe(true);
    // Control: sin esto, un predicado que devolviera true siempre pasaría todo lo de arriba.
    expect(esSinNumeroVisible('Timeout llamando a la API de Meta')).toBe(false);
    expect(esSinNumeroVisible('')).toBe(false);
    expect(esSinNumeroVisible(null)).toBe(false);
  });
});
