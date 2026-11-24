import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * El rescate del 429 (`salvarGastoSinIA`) guarda SIN preguntar, así que tiene que pasar por el
 * mismo invariante de sentido que el rescate de `registrar_manual` (24-nov-2026). El tipo del
 * extractor sale de una lista corta de verbos: "480 ingreso" o "me depositaron 1200" salían GASTO.
 *
 * Se recorre `procesarMensajeLibre` de verdad, con OpenAI lanzando un 429, porque la función no
 * se exporta y lo que importa es la escritura que llega a `guardarTransaccion`.
 */

require('../../lib/support-tickets').obtenerSesionAbierta = vi.fn(async () => null);
require('../../gmail').tieneGmailConectado = vi.fn(async () => false);
require('../../helpers/db-helpers').obtenerHistorial = vi.fn(async () => []);
require('../../helpers/db-helpers').guardarMensaje = vi.fn(async () => {});
require('../../lib/neto-prompt').construirNetoPrompt = vi.fn(() => 'PROMPT');
require('../../services/survey-triggers').marcarRespuestaProactiva = vi.fn().mockResolvedValue(undefined);
require('../../lib/admin-notify').notificarAdmin = vi.fn().mockResolvedValue(undefined);

const guardarTransaccion = vi.fn(async () => ({ id: 'tx-1' }));
require('../../services/transactions').guardarTransaccion = guardarTransaccion;

require('../../lib/ai').openai = { chat: { completions: { create: vi.fn().mockRejectedValue(new Error('429 Rate limit reached for gpt-4o-mini')) } } };

const chainSb = {};
for (const m of ['select', 'insert', 'update', 'eq', 'in', 'order', 'limit', 'is']) chainSb[m] = vi.fn(() => chainSb);
chainSb.then = (onF, onR) => Promise.resolve({ data: [], error: null, count: 0 }).then(onF, onR);
require('../../lib/db').supabase = { from: vi.fn(() => chainSb) };

const { procesarMensajeLibre } = require('../../handlers/message-processor');
const { extraerGastoSinIA } = require('../../lib/nlp-guards');

const USUARIO = { id: 'u-1', nombre: 'Ana', plan: 'premium', trial_estado: 'convertido', gmail_access_token: null };

beforeEach(() => { guardarTransaccion.mockClear(); });

describe('rescate del 429 con el sentido del mensaje', () => {
  for (const msg of ['480 ingreso', '150.00 ingreso de estilista', '150 entró a cuenta', 'me depositaron 1200 soles']) {
    it(`no guarda como gasto lo que el mensaje dice que entró: ${JSON.stringify(msg)}`, async () => {
      // Precondición: el extractor SÍ lo lee, y como gasto. Si deja de leerlo, este test no prueba nada.
      expect(extraerGastoSinIA(msg)).toMatchObject({ tipo: 'gasto' });
      const res = await procesarMensajeLibre(msg, USUARIO, '51999');
      expect(guardarTransaccion).not.toHaveBeenCalled();
      expect(res).toContain('Reenvía tu mensaje');
    });
  }

  it('CONTROL: un gasto corto sigue entrando por el rescate', async () => {
    const res = await procesarMensajeLibre('7.90 taxi', USUARIO, '51999');
    expect(guardarTransaccion).toHaveBeenCalledTimes(1);
    expect(guardarTransaccion.mock.calls[0][1]).toMatchObject({ tipo: 'gasto', monto: 7.9 });
    expect(res).toContain('Lo registré al toque');
  });
});
