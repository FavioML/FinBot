import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * P′4 de la auditoría del 10-ago: el arranque de CADA mensaje hacía tres lecturas
 * independientes en serie (sesión de soporte, cuentas de Gmail, historial). Ahora van en un
 * `Promise.all`.
 *
 * El riesgo que la auditoría nombró explícitamente NO es la latencia sino el orden:
 * `obtenerHistorial` tiene que resolver ANTES de que se inserte el turno actual, o el
 * mensaje del usuario entra DOS VECES en el contexto que se le manda al LLM (una desde el
 * historial, otra como último turno). Meter `guardarMensaje` dentro del `Promise.all` —que
 * es la "simplificación" obvia— rompe eso sin romper ningún otro test.
 *
 * Hasta este archivo **ningún test ejecutaba una sola línea de `procesarMensajeLibre`**: lo
 * único que lo recorría eran los harness E2E contra prod con OpenAI real.
 */

// ─── Parchar singletons ANTES de requerir el SUT ────────────────────────────
// message-processor.js destructura sus dependencias al cargar, así que hay que reemplazar
// la propiedad en cada módulo antes del require.

const eventos = [];
const reg = (e) => { eventos.push(e); return e; };

// Retardo controlado: obliga a que "inicio" y "fin" queden separados en el tiempo. Sin esto
// una versión en serie y una en paralelo producen la misma traza.
const tras = (ms, valor) => new Promise((r) => setTimeout(() => r(valor), ms));

let sesionAbierta = null;
const obtenerSesionAbierta = vi.fn(async () => {
  reg('sesion:inicio');
  const v = await tras(10, sesionAbierta);
  reg('sesion:fin');
  return v;
});
require('../../lib/support-tickets').obtenerSesionAbierta = obtenerSesionAbierta;

const obtenerCuentasGmail = vi.fn(async () => {
  reg('gmail:inicio');
  const v = await tras(10, []);
  reg('gmail:fin');
  return v;
});
require('../../gmail').obtenerCuentasGmail = obtenerCuentasGmail;

const obtenerHistorial = vi.fn(async () => {
  reg('historial:inicio');
  const v = await tras(10, []);
  reg('historial:fin');
  return v;
});
const guardarMensaje = vi.fn(async (usuarioId, rol) => { reg('guardarMensaje:' + rol); });
require('../../helpers/db-helpers').obtenerHistorial = obtenerHistorial;
require('../../helpers/db-helpers').guardarMensaje = guardarMensaje;

require('../../lib/neto-prompt').construirNetoPrompt = vi.fn(() => 'PROMPT');
require('../../services/survey-triggers').marcarRespuestaProactiva = vi.fn().mockResolvedValue(undefined);
require('../../lib/admin-notify').notificarAdmin = vi.fn().mockResolvedValue(undefined);

// OpenAI responde con texto plano (sin tool_calls): el camino más corto que igual recorre
// todo el arranque y termina antes del dispatch de intents.
const crearCompletion = vi.fn().mockResolvedValue({
  choices: [{ message: { content: 'Respuesta directa de NETO' } }],
});
require('../../lib/ai').openai = { chat: { completions: { create: crearCompletion } } };

// Supabase solo lo toca la rama de soporte (update del ticket).
const chainSb = {};
for (const m of ['select', 'insert', 'update', 'eq', 'in', 'order', 'limit', 'is']) {
  chainSb[m] = vi.fn(() => chainSb);
}
chainSb.then = (onF, onR) => Promise.resolve({ data: [], error: null, count: 0 }).then(onF, onR);
require('../../lib/db').supabase = { from: vi.fn(() => chainSb) };

const { procesarMensajeLibre } = require('../../handlers/message-processor');

const USUARIO = { id: 'u-1', nombre: 'Favio', plan: 'premium', gmail_access_token: null };

beforeEach(() => {
  eventos.length = 0;
  sesionAbierta = null;
  guardarMensaje.mockClear();
  obtenerHistorial.mockClear();
  obtenerCuentasGmail.mockClear();
  obtenerSesionAbierta.mockClear();
  crearCompletion.mockClear();
});

describe('arranque de procesarMensajeLibre', () => {
  it('el turno actual se inserta DESPUÉS de que el historial resolvió', async () => {
    await procesarMensajeLibre('gaste 20 en pan', USUARIO, '51999');

    const finHistorial = eventos.indexOf('historial:fin');
    const insert = eventos.indexOf('guardarMensaje:usuario');
    expect(finHistorial).toBeGreaterThanOrEqual(0);
    expect(insert).toBeGreaterThanOrEqual(0);
    // ⚠️ Esto muere si alguien mete `guardarMensaje` dentro del Promise.all: el mensaje del
    // usuario quedaría en `conversaciones` antes de que se lea el historial y viajaría dos
    // veces al LLM.
    expect(insert).toBeGreaterThan(finHistorial);
  });

  it('las tres lecturas arrancan juntas: ninguna espera a que la anterior termine', async () => {
    await procesarMensajeLibre('gaste 20 en pan', USUARIO, '51999');

    const primerFin = Math.min(
      eventos.indexOf('sesion:fin'),
      eventos.indexOf('gmail:fin'),
      eventos.indexOf('historial:fin'),
    );
    for (const inicio of ['sesion:inicio', 'gmail:inicio', 'historial:inicio']) {
      expect(eventos.indexOf(inicio)).toBeGreaterThanOrEqual(0);
      // ⚠️ En serie, el "inicio" de la segunda lectura cae después del "fin" de la primera.
      expect(eventos.indexOf(inicio)).toBeLessThan(primerFin);
    }
  });

  it('con sesión de soporte abierta no toca el historial del asistente', async () => {
    sesionAbierta = { id: 't-1', estado: 'esperando_mensaje' };
    const res = await procesarMensajeLibre('necesito ayuda', USUARIO, '51999');

    expect(res).toContain('Recibido');
    // La rama de soporte retornaba antes de `guardarMensaje` y tiene que seguir haciéndolo:
    // un mensaje para el admin no es un turno de la conversación con el bot.
    expect(guardarMensaje).not.toHaveBeenCalled();
    expect(crearCompletion).not.toHaveBeenCalled();
  });

  it('el token legacy de Gmail evita el round-trip a gmail_cuentas', async () => {
    await procesarMensajeLibre('gaste 20 en pan', { ...USUARIO, gmail_access_token: 'ya-lo-tengo' }, '51999');
    expect(obtenerCuentasGmail).not.toHaveBeenCalled();
  });

  // P′9: la respuesta de Neto se escribía DOS veces en `conversaciones` — una acá y otra en
  // `handlers/webhook.js`, que guarda lo que esta función devuelve. El 7.2% de las filas
  // 'neto' eran duplicados a menos de 5s. No era solo ruido en la tabla: `obtenerHistorial`
  // lee las últimas 6 y se las manda al clasificador, así que cada turno duplicado le comía
  // la mitad del contexto.
  it('NO escribe la respuesta de Neto: el único escritor es el webhook', async () => {
    const res = await procesarMensajeLibre('gaste 20 en pan', USUARIO, '51999');
    expect(res).toBe('Respuesta directa de NETO');

    const roles = guardarMensaje.mock.calls.map((c) => c[1]);
    // El turno del USUARIO sí se escribe acá, y tiene que seguir haciéndolo: va después de
    // `obtenerHistorial` para no entrar dos veces al contexto del LLM.
    expect(roles).toContain('usuario');
    expect(roles).not.toContain('neto');
  });

  it('un fallo leyendo gmail_cuentas no tumba el mensaje', async () => {
    obtenerCuentasGmail.mockImplementationOnce(async () => { throw new Error('gmail_cuentas caido'); });
    const res = await procesarMensajeLibre('gaste 20 en pan', USUARIO, '51999');
    // El Promise.all rechaza entero si un miembro lanza: por eso el catch vive DENTRO de
    // `resolverCorreoConectado` y no alrededor del Promise.all.
    expect(res).toBe('Respuesta directa de NETO');
    expect(res).not.toContain('Tuve un problema');
  });
});
