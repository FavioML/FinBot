import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(import.meta.url);

/**
 * LO QUE SE LE ANUNCIA A LA PERSONA CUANDO LA SESIÓN DE SOPORTE NO SE PUDO ABRIR NI CERRAR.
 *
 * Sale del ítem 20: `abrirSesion` y `cerrarSesion` descartaban su `{ error }`, así que un
 * insert o un update rechazado por Supabase llegaba hasta acá disfrazado de "no había nada". El
 * arreglo de `lib/` es la mitad; **la otra mitad es lo que se dice**, y vive en estos dos
 * call-sites:
 *
 *   · `/soporte` contestaba *"Modo soporte activado, escribe tu consulta y se la hago llegar al
 *     equipo"* sobre un ticket que no existe. Lo que la persona escribiera después no encuentra
 *     sesión (`obtenerSesionAbierta` devuelve null) y se lo lleva el bot: cree estar
 *     contándole su problema a alguien del equipo y Neto le responde sobre sus gastos.
 *   · `/salir` decía *"No estabas en modo soporte"* cuando sí estaba y el cierre había fallado,
 *     dejándola hablándole al admin sin saberlo. Es la mentira simétrica.
 *
 * Los dos casos tienen su CONTROL, porque el defecto no era "no contesta" sino "contesta lo
 * mismo que en el caso bueno".
 */

process.env.META_APP_SECRET = 'test-secret';

const enviarWhatsapp = vi.fn().mockResolvedValue(undefined);
require('../../lib/whatsapp').enviarWhatsapp = enviarWhatsapp;

const obtenerOCrearUsuario = vi.fn();
require('../../helpers/db-helpers').obtenerOCrearUsuario = obtenerOCrearUsuario;
require('../../helpers/db-helpers').guardarMensaje = vi.fn().mockResolvedValue(undefined);

// `handlers/webhook.js` DESTRUCTURA estas dos al cargar, así que el parche va antes del
// require de abajo. Se mockean a propósito: lo que este archivo mide es el mensaje, no la
// query — de la query se encarga `tests/lib/lecturas-de-soporte.test.js`.
const abrirSesion = vi.fn();
const cerrarSesion = vi.fn();
require('../../lib/support-tickets').abrirSesion = abrirSesion;
require('../../lib/support-tickets').cerrarSesion = cerrarSesion;

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
    entry: [{ changes: [{ value: { messages: [{ from: '51999000222', id: 'wamid-sop-' + (wamidSeq++), type: 'text', text: { body: texto } }] } }] }],
  };
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = 'sha256=' + crypto.createHmac('sha256', 'test-secret').update(rawBody).digest('hex');
  await webhookHandler({ headers: { 'x-hub-signature-256': signature }, rawBody, body }, { sendStatus: vi.fn() });
  return enviarWhatsapp.mock.calls[0] ? String(enviarWhatsapp.mock.calls[0][1]) : null;
}

beforeEach(() => {
  enviarWhatsapp.mockClear();
  abrirSesion.mockReset();
  cerrarSesion.mockReset();
  obtenerOCrearUsuario.mockReset().mockResolvedValue({
    id: 'u1', nombre: 'Juan', plan: 'premium', trial_estado: 'convertido',
    onboarding_paso: 0, onboarding_completado: true,
  });
});

describe('/soporte · no se anuncia el modo soporte si el ticket no nació', () => {
  it('CONTROL: la sesión se abre → se anuncia y se le pide la consulta', async () => {
    abrirSesion.mockResolvedValue({ yaAbierta: false, ticket: { id: 't-nuevo' } });

    const res = await enviarComando('/soporte');

    expect(res).toMatch(/Modo soporte activado/);
  });

  it('CONTROL: ya estaba abierta → el otro texto, y tampoco se traba', async () => {
    // `yaAbierta: true` viene con el ticket EXISTENTE, no con uno nuevo. Sin este control, una
    // guarda escrita de más ("si no hay ticket, error") rompería el camino idempotente.
    abrirSesion.mockResolvedValue({ yaAbierta: true, ticket: { id: 't-viejo' } });

    const res = await enviarComando('/soporte');

    expect(res).toMatch(/Ya estás en modo soporte/);
  });

  it('el insert fue rechazado → se lo dice, en vez de anunciar una sesión que no existe', async () => {
    abrirSesion.mockResolvedValue({ yaAbierta: false, ticket: null });

    const res = await enviarComando('/soporte');

    expect(res, 'sigue anunciando el modo soporte sobre un ticket que no existe').not.toMatch(/Modo soporte activado/);
    expect(res).toMatch(/trabó/i);
    // Y que ofrezca la salida que sí funciona: la bandeja de hola@neto.pe se lee.
    expect(res).toMatch(/hola@neto\.pe/);
  });
});

describe('/salir · "no estabas" dejó de ser también la cara de un cierre fallido', () => {
  it('CONTROL: cerró de verdad → vuelve el asistente', async () => {
    cerrarSesion.mockResolvedValue({ closed: 1, msg: null });

    const res = await enviarComando('/salir');

    expect(res).toMatch(/Saliste del modo soporte/);
  });

  it('CONTROL: no estaba en modo soporte → se lo dice, sin alarmar', async () => {
    cerrarSesion.mockResolvedValue({ closed: 0, msg: null });

    const res = await enviarComando('/salir');

    expect(res).toMatch(/No estabas en modo soporte/);
  });

  it('el cierre falló → no le dice que no estaba: le dice que reintente', async () => {
    // Con `ok: false` y `closed: 0`, la versión anterior caía en el mismo mensaje que "no
    // estabas" — y esa persona SÍ está en modo soporte, o sea que todo lo que escriba después
    // se lo sigue llevando el admin mientras cree haber vuelto al asistente.
    cerrarSesion.mockResolvedValue({ ok: false, closed: 0, msg: '❌ No pude cerrar la conversación de soporte. Reintenta en un momento.' });

    const res = await enviarComando('/salir');

    expect(res).not.toMatch(/No estabas en modo soporte/);
    expect(res).toMatch(/No pude cerrar el modo soporte/i);
  });
});
