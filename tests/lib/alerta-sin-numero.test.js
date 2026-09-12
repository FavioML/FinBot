import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * La alerta de "mensaje entrante sin from", después del 12-sep-2026.
 *
 * Hasta ese día esta fila la producía sobre todo gente que ocultaba su número (llegaba con BSUID y
 * sin `from`), y la alerta contaba PERSONAS para separar "uno insistiendo" de "el canal perdiendo
 * gente" (02-sep-2026, el caso de Julio). Desde el envío por BSUID esa gente se atiende por el
 * camino normal y ya no escribe esta fila. Lo único que la produce es un mensaje que Meta mandó
 * SIN NINGUNA identidad, como los 4 del 01-ago-2026.
 *
 * Lo que la alerta tiene que decir entonces es eso, y sobre todo NO lo de antes: "lo que no
 * funciona es contestarles" dejó de ser cierto, y leerlo mandaría a buscar un problema resuelto.
 *
 * El mock va ANTES del require porque `error-monitor` destructura sus dependencias en la carga.
 */

const notificarAdmin = vi.fn().mockResolvedValue(true);
require('../../lib/admin-notify').notificarAdmin = notificarAdmin;
require('../../lib/db').supabase = { from: () => ({ insert: async () => ({ error: null }) }) };

const { registrarError, esSinNumeroVisible } = require('../../lib/error-monitor');

const SIN_FROM = 'Mensaje entrante sin from ni from_user_id';

/**
 * Dispara el umbral (5 en una hora) y devuelve la alerta. Cada test usa un `tag` distinto: el
 * contador del módulo es estado en memoria por `tag:mensaje`.
 */
async function alerta(tag) {
  for (let i = 0; i < 5; i++) await registrarError(tag, SIN_FROM);
  return notificarAdmin.mock.calls.at(-1)?.[0] || '';
}

describe('la alerta de mensajes sin remitente', () => {
  it('dice qué es: mensajes sin número NI BSUID', async () => {
    const a = await alerta('T1');
    expect(a).toMatch(/SIN REMITENTE/);
    expect(a).toMatch(/5 mensajes en la última hora/);
    expect(a).toMatch(/NI BSUID/);
  });

  it('aclara que NO es la gente con el número oculto, a la que sí se le contesta', async () => {
    const a = await alerta('T2');
    expect(a).toMatch(/No es gente con el número oculto/);
    expect(a).toMatch(/contesta por BSUID/);
  });

  it('ya no afirma lo que dejó de ser cierto', async () => {
    const a = await alerta('T3');
    expect(a).not.toMatch(/no funciona es contestarles/i);
    expect(a).not.toMatch(/SIN NÚMERO VISIBLE/);
    // Y lo que nunca dijo bien: el copy genérico mandaba a buscar un bug que no existe.
    expect(a).not.toMatch(/problema sistémico/i);
  });

  it('dice qué mirar', async () => {
    const a = await alerta('T4');
    expect(a).toMatch(/select detalle from errores/);
  });

  it('el predicado no se lleva puesto cualquier error del webhook', () => {
    expect(esSinNumeroVisible('Mensaje entrante sin from ni from_user_id')).toBe(true);
    expect(esSinNumeroVisible('MENSAJE ENTRANTE SIN FROM')).toBe(true);
    // Control: sin esto, un predicado que devolviera true siempre pasaría todo lo de arriba.
    expect(esSinNumeroVisible('Timeout llamando a la API de Meta')).toBe(false);
    expect(esSinNumeroVisible('')).toBe(false);
    expect(esSinNumeroVisible(null)).toBe(false);
  });
});
