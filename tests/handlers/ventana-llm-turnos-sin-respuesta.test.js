import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * El mensaje que el clasificador tiene que contestar es EL ÚLTIMO, no el anterior.
 *
 * `handlers/webhook.js` es el único escritor de la fila 'neto', y la escribe DESPUÉS de que
 * `procesarMensajeLibre` devolvió. Si el usuario manda un segundo mensaje antes de que eso
 * ocurra, la ventana que lee el segundo termina en una fila 'usuario' sin respuesta. La
 * traducción a turnos `user`/`assistant` la mandaba tal cual y el clasificador terminaba
 * contestando la pregunta de atrás en vez del mensaje nuevo.
 *
 * Medido contra producción con "gaste 30 en taxi" y un usuario en el muro (gpt-4o-mini,
 * temperature 0, 4 corridas por escenario): con la ventana alternada 0/4 mal clasificadas;
 * con una sola pregunta sin responder al final 2/4 (`ver_neto_score`, `ver_balance`); con
 * tres o cuatro, 4/4 (`ver_fugas`, `ver_suscripciones`). Un gasto clasificado como LECTURA le
 * entrega el paywall al usuario del muro en vez de la confirmación, contra la regla que
 * `handlers/intents-acceso.js` declara innegociable: escribir nunca se corta.
 *
 * Este test mira la ventana que SALE hacia OpenAI, no la respuesta: la respuesta depende del
 * modelo (2/4, no 4/4) y un test que la mirara sería intermitente por construcción.
 */

// ─── Parchar singletons ANTES de requerir el SUT ────────────────────────────
let historial = [];
require('../../helpers/db-helpers').obtenerHistorial = vi.fn(async () => historial);
require('../../helpers/db-helpers').guardarMensaje = vi.fn(async () => {});
require('../../lib/support-tickets').obtenerSesionAbierta = vi.fn(async () => null);
require('../../gmail').obtenerCuentasGmail = vi.fn(async () => []);
require('../../lib/neto-prompt').construirNetoPrompt = vi.fn(() => 'PROMPT');
require('../../services/survey-triggers').marcarRespuestaProactiva = vi.fn().mockResolvedValue(undefined);
require('../../lib/admin-notify').notificarAdmin = vi.fn().mockResolvedValue(undefined);

const crearCompletion = vi.fn().mockResolvedValue({
  choices: [{ message: { content: 'Respuesta directa de NETO' } }],
});
require('../../lib/ai').openai = { chat: { completions: { create: crearCompletion } } };

const chainSb = {};
for (const m of ['select', 'insert', 'update', 'eq', 'in', 'order', 'limit', 'is']) chainSb[m] = vi.fn(() => chainSb);
chainSb.then = (onF, onR) => Promise.resolve({ data: [], error: null, count: 0 }).then(onF, onR);
require('../../lib/db').supabase = { from: vi.fn(() => chainSb) };

const { procesarMensajeLibre } = require('../../handlers/message-processor');

const USUARIO = { id: 'u-1', nombre: 'Favio', plan: 'free', trial_estado: 'vencido', gmail_access_token: null };
const u = (m) => ({ rol: 'usuario', mensaje: m });
const n = (m) => ({ rol: 'neto', mensaje: m });

/** Los turnos que viajaron a OpenAI, sin el system prompt. */
const turnosEnviados = () =>
  crearCompletion.mock.calls[0][0].messages.filter((m) => m.role !== 'system');

beforeEach(() => { crearCompletion.mockClear(); historial = []; });

describe('la ventana que va al clasificador', () => {
  it('NO le manda la pregunta que quedó sin responder delante del gasto nuevo', async () => {
    historial = [u('gaste 20 en pan'), n('✅ S/20.00'), u('cual es mi score')];

    await procesarMensajeLibre('gaste 30 en taxi', USUARIO, '51999');

    const enviados = turnosEnviados();
    // ⚠️ Pre-arreglo esto trae 'cual es mi score' pegado adelante de 'gaste 30 en taxi'.
    expect(enviados.map((m) => m.content)).not.toContain('cual es mi score');
    expect(enviados[enviados.length - 1].content).toBe('gaste 30 en taxi');
  });

  it('nunca manda dos turnos `user` seguidos: el último tiene que ser el mensaje nuevo', async () => {
    historial = [
      u('cuanto gaste este mes'), u('dame mi reporte'),
      u('en que se me va la plata'), u('cual es mi score'),
    ];

    await procesarMensajeLibre('gaste 30 en taxi', USUARIO, '51999');

    const roles = turnosEnviados().map((m) => m.role);
    // ⚠️ Pre-arreglo: ['user','user','user','user','user'].
    const seguidos = roles.filter((r, i) => r === 'user' && roles[i + 1] === 'user');
    expect(seguidos).toEqual([]);
    expect(turnosEnviados().pop().content).toBe('gaste 30 en taxi');
  });

  it('la ventana que SÍ alterna llega entera: el arreglo no recorta contexto legítimo', async () => {
    historial = [u('gaste 20 en pan'), n('✅ S/20.00'), u('cuanto llevo'), n('Van S/20.00')];

    await procesarMensajeLibre('gaste 30 en taxi', USUARIO, '51999');

    expect(turnosEnviados().map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
  });
});
