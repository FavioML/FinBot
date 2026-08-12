import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(import.meta.url);

// `/cambiar [comercio] [categoria]` es la CUARTA puerta que escribe `transacciones.categoria`
// a mano, y no tenía una sola línea de cobertura (hallazgo B30).
//
// Lo que hacía mal: `catKnown` compara contra `CATEGORIAS_SUGERIDAS` de forma EXACTA salvo
// mayúsculas, así que `/cambiar berny alimentacion` no matcheaba —por la tilde— y caía al
// `else`, que sólo capitaliza. Resultado: 'Alimentacion' escrito crudo en la fila, o sea la
// misma categoría partida en dos grafías. Es el mismo síntoma que B28 cerró en el camino del
// clasificador y que B30 cierra en el de las reglas.
//
// Mismo patrón de mocking que webhook-onboarding.test.js: parchar los singletons ANTES de
// requerir el webhook, porque webhook.js destructura sus dependencias al cargar.

process.env.META_APP_SECRET = 'test-secret';

const enviarWhatsapp = vi.fn().mockResolvedValue(undefined);
require('../../lib/whatsapp').enviarWhatsapp = enviarWhatsapp;

const obtenerOCrearUsuario = vi.fn();
require('../../helpers/db-helpers').obtenerOCrearUsuario = obtenerOCrearUsuario;
require('../../helpers/db-helpers').guardarMensaje = vi.fn().mockResolvedValue(undefined);

const recategorizarTransaccion = vi.fn();
require('../../services/transactions').recategorizarTransaccion = recategorizarTransaccion;

function makeChain(data = []) {
  const c = {};
  for (const m of ['select', 'insert', 'update', 'delete', 'upsert',
    'eq', 'ilike', 'gte', 'lte', 'is', 'neq', 'not', 'order', 'limit', 'single', 'maybeSingle']) {
    c[m] = vi.fn().mockReturnValue(c);
  }
  c.then = (onF, onR) => Promise.resolve({ data, error: null, count: 0 }).then(onF, onR);
  return c;
}
require('../../lib/db').supabase.from = vi.fn(() => makeChain([]));

const createWebhookHandler = require('../../handlers/webhook');
const webhookHandler = createWebhookHandler(vi.fn());

let wamidSeq = 0;
async function enviarComando(texto) {
  const body = {
    entry: [{ changes: [{ value: { messages: [{ from: '51999000111', id: 'wamid-cc-' + (wamidSeq++), type: 'text', text: { body: texto } }] } }] }],
  };
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = 'sha256=' + crypto.createHmac('sha256', 'test-secret').update(rawBody).digest('hex');
  await webhookHandler({ headers: { 'x-hub-signature-256': signature }, rawBody, body }, { sendStatus: vi.fn() });
  return enviarWhatsapp.mock.calls[0] ? enviarWhatsapp.mock.calls[0][1] : null;
}

describe('/cambiar — la categoría pasa por el mismo resolvedor que el resto (B30)', () => {
  beforeEach(() => {
    enviarWhatsapp.mockClear();
    recategorizarTransaccion.mockReset().mockResolvedValue({ ok: true, msg: 'Listo!' });
    obtenerOCrearUsuario.mockReset().mockResolvedValue({
      id: 'u1', nombre: 'Juan', plan: 'premium', trial_estado: 'convertido',
      onboarding_paso: 0, onboarding_completado: true,
    });
  });

  it('resuelve el alias sin tilde que `catKnown` no matchea', async () => {
    await enviarComando('/cambiar berny alimentacion');
    expect(recategorizarTransaccion).toHaveBeenCalledWith('u1', 'berny', 'Alimentación');
  });

  it('una canónica escrita bien pasa igual', async () => {
    await enviarComando('/cambiar netflix Suscripciones');
    expect(recategorizarTransaccion).toHaveBeenCalledWith('u1', 'netflix', 'Suscripciones');
  });

  // La otra mitad del invariante de B28: lo que el mapa canónico NO resuelve se escribe tal
  // cual. Si esto se pone rojo, `/cambiar` está mandando categorías libres a 'Otros'.
  it('deja intacta la categoría libre que el mapa no resuelve', async () => {
    await enviarComando('/cambiar starbucks Gastos Hormiga');
    expect(recategorizarTransaccion).toHaveBeenCalledWith('u1', 'starbucks', 'Gastos Hormiga');
  });

  it('sin categoría responde el formato y no toca nada', async () => {
    const resp = await enviarComando('/cambiar netflix');
    expect(recategorizarTransaccion).not.toHaveBeenCalled();
    expect(resp).toMatch(/Formato/i);
  });
});
