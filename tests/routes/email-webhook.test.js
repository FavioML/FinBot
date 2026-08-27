import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'module';
import path from 'path';
import crypto from 'crypto';

/**
 * El webhook de Resend y la ruta de baja, probados CONTRA UN SERVIDOR DE VERDAD.
 *
 * No es sobre-ingeniería: los dos son rutas ANÓNIMAS, y una de ellas escribe en
 * `notification_deliveries`, que es la tabla que decide qué se considera entregado. Un test
 * estático (grep sobre el archivo) diría que la verificación de firma "está escrita"; lo que
 * hay que saber es si RECHAZA, y eso incluye el paso por express, el `rawBody` del `verify`
 * de `express.json()`, y el orden de los chequeos.
 *
 * Se monta el router real sobre express y se le pega por HTTP. Sin `supertest`: express ya
 * está, y `fetch` es global desde Node 18.
 */

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '../..',
);

// ── Dobles de los módulos pesados que `routes/public.js` arrastra ─────────────────────────
// Se cachean ANTES de requerir el router. No se está evitando "trabajo": `gmail.js` construye
// un cliente OAuth al cargar y `analytics` abre PostHog, o sea efectos de red al importar.
const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };

let updates = [];
let resultadoUpdate = { data: [{ id: 1, tipo: 'deuda', usuario_id: 'u1' }], error: null };
/**
 * El doble de PostgREST. El `then` NO es decorativo, y su ausencia produjo un falso verde en
 * la primera corrida: un builder de supabase-js es THENABLE, así que
 * `await supabase.from(x).update(y).eq(z)` —sin `.select()`, que es como escribe la ruta de
 * baja— resuelve a `{ data, error }`. Con un doble que solo devolvía la cadena, ese `await`
 * daba el objeto cadena, `const { error }` quedaba `undefined`, y la rama de error **no se
 * ejercitaba nunca**: el test de "si el UPDATE falla" pasaba por el camino feliz.
 *
 * Es la trampa de `feedback_await_que_resuelve_no_prueba_exito` en su forma más barata: el
 * await resolvía, así que parecía que la llamada había funcionado.
 */
const chain = () => {
  const c = {
    update: vi.fn((patch) => { updates.push({ patch, filtros: {} }); return c; }),
    eq: vi.fn((col, val) => { if (updates.length) updates[updates.length - 1].filtros[col] = val; return c; }),
    select: vi.fn(async () => resultadoUpdate),
    then: (resolver, rechazar) => Promise.resolve(resultadoUpdate).then(resolver, rechazar),
  };
  return c;
};
const dbMock = { supabase: { from: vi.fn(() => chain()) } };

const stubs = [
  ['lib/logger.js', logMock],
  ['lib/db.js', dbMock],
  ['lib/whatsapp.js', { enviarWhatsapp: vi.fn() }],
  ['lib/analytics.js', { capture: vi.fn(), default: { capture: vi.fn() } }],
  ['lib/trial.js', { esProPagado: vi.fn(() => false) }],
  ['gmail.js', {
    oauth2Client: {}, obtenerPerfilGoogle: vi.fn(), guardarTokens: vi.fn(),
    verificarState: vi.fn(), emailGmailVinculado: vi.fn(), esElMismoGmail: vi.fn(),
  }],
  ['services/gmail-scanner.js', { escanearGmailYRegistrar: vi.fn(), escanearHistoricoInicial: vi.fn() }],
];
for (const [rel, exports] of stubs) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const express = require('express');
const publicRoutes = require('../../routes/public');
const { construirTokenBaja } = require('../../lib/email');

const SECRETO = 'whsec_' + Buffer.from('clave-de-prueba-para-svix').toString('base64');

const app = express();
// Idéntico a `index.js`: `rawBody` lo puebla el `verify` de `express.json()`, y sin él no hay
// bytes crudos que firmar. Montarlo distinto acá haría que el test pase con un servidor que
// no es el que corre en producción.
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
// El webhook NO cuelga del router: `index.js` lo monta aparte para sacarlo de `publicLimiter`
// (60/min, pensado para navegadores) y ponerlo bajo `webhookLimiter`. Se monta igual acá para
// que el test ejercite la misma forma de wiring que produccion, y no una propia.
app.post('/webhooks/resend', publicRoutes.resendWebhookHandler);
app.use('/', publicRoutes);

let servidor, base;
await new Promise((r) => { servidor = app.listen(0, () => { base = 'http://127.0.0.1:' + servidor.address().port; r(); }); });
afterAll(() => new Promise((r) => servidor.close(r)));

const ENV = { ...process.env };
beforeEach(() => {
  updates = [];
  resultadoUpdate = { data: [{ id: 1, tipo: 'deuda', usuario_id: 'u1' }], error: null };
  vi.clearAllMocks();
  process.env.RESEND_WEBHOOK_SECRET = SECRETO;
  process.env.EMAIL_OPTOUT_SECRET = 'secreto-de-baja';
});
afterAll(() => { process.env = ENV; });

/** Firma como firma Svix: `id.timestamp.body`, HMAC-SHA256, secreto base64 tras `whsec_`. */
function firmar(cuerpo, { id = 'msg_1', ts = Math.floor(Date.now() / 1000), secreto = SECRETO } = {}) {
  const clave = Buffer.from(secreto.replace(/^whsec_/, ''), 'base64');
  const firma = crypto.createHmac('sha256', clave).update(id + '.' + ts + '.' + cuerpo).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': 'v1,' + firma };
}

const postear = (cuerpo, headers) => fetch(base + '/webhooks/resend', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: cuerpo,
});

const EVENTO = (type, id = 'resend-abc') => JSON.stringify({ type, data: { email_id: id } });

describe('webhook de Resend: la firma decide', () => {
  it('una firma válida se acepta y marca la entrega', async () => {
    const cuerpo = EVENTO('email.delivered');
    const res = await postear(cuerpo, firmar(cuerpo));
    expect(res.status).toBe(200);
    // El 200 sale ANTES de escribir (Resend reintenta ante un no-2xx y un reintento no
    // arregla un fallo de escritura nuestro), así que hay que esperar a que la escritura pase.
    await vi.waitFor(() => expect(updates.length).toBe(1));
    expect(updates[0].patch).toEqual({ delivered_at: expect.any(String) });
    // Los DOS filtros: sin `canal='email'`, un id de Resend que colisionara con un wamid de
    // Meta escribiría sobre la fila equivocada.
    expect(updates[0].filtros).toEqual({ wamid: 'resend-abc', canal: 'email' });
  });

  it('una firma inválida se rechaza con 401 y NO escribe', async () => {
    const cuerpo = EVENTO('email.delivered');
    const headers = firmar(cuerpo);
    headers['svix-signature'] = 'v1,' + Buffer.from('firma-falsa').toString('base64');
    const res = await postear(cuerpo, headers);
    expect(res.status).toBe(401);
    expect(updates).toEqual([]);
  });

  it('un cuerpo alterado después de firmar se rechaza', async () => {
    // El ataque real: interceptar un callback legítimo y cambiarle el `email_id` para marcar
    // entregado otro aviso. La firma cubre el cuerpo, así que no pega.
    const original = EVENTO('email.delivered', 'resend-abc');
    const headers = firmar(original);
    const res = await postear(EVENTO('email.delivered', 'resend-OTRO'), headers);
    expect(res.status).toBe(401);
    expect(updates).toEqual([]);
  });

  it('un callback viejo se rechaza (ventana de 5 min contra replay)', async () => {
    const cuerpo = EVENTO('email.delivered');
    const viejo = Math.floor(Date.now() / 1000) - 3600;
    // Firmado CORRECTAMENTE con ese timestamp: lo que lo rechaza es la edad, no la firma.
    const res = await postear(cuerpo, firmar(cuerpo, { ts: viejo }));
    expect(res.status).toBe(400);
    expect(updates).toEqual([]);
  });

  it('sin RESEND_WEBHOOK_SECRET falla CERRADO (503), no abierto', async () => {
    // Un webhook sin verificar es una ruta anónima que escribe en la tabla que decide qué se
    // considera entregado. Degradarlo a "acepto todo" la vuelve inútil justo para lo único
    // que sirve.
    delete process.env.RESEND_WEBHOOK_SECRET;
    const cuerpo = EVENTO('email.delivered');
    const res = await postear(cuerpo, firmar(cuerpo));
    expect(res.status).toBe(503);
    expect(updates).toEqual([]);
  });

  it.each([
    ['sin svix-id', { 'svix-id': undefined }],
    ['sin svix-timestamp', { 'svix-timestamp': undefined }],
    ['sin svix-signature', { 'svix-signature': undefined }],
  ])('%s se rechaza con 400', async (_c, quitar) => {
    const cuerpo = EVENTO('email.delivered');
    const headers = { ...firmar(cuerpo) };
    for (const k of Object.keys(quitar)) delete headers[k];
    const res = await postear(cuerpo, headers);
    expect(res.status).toBe(400);
    expect(updates).toEqual([]);
  });

  it('acepta una LISTA de firmas: durante una rotación de secreto llegan varias', async () => {
    // Svix manda `v1,a v1,b` mientras se rota. Comparar contra el header entero rechazaría
    // los callbacks legítimos justo cuando menos se quiere perder el veredicto de entrega.
    const cuerpo = EVENTO('email.delivered');
    const buena = firmar(cuerpo)['svix-signature'];
    const headers = firmar(cuerpo);
    headers['svix-signature'] = 'v1,' + Buffer.from('vieja').toString('base64') + ' ' + buena;
    const res = await postear(cuerpo, headers);
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(updates.length).toBe(1));
  });
});

describe('webhook de Resend: qué evento significa qué', () => {
  it.each([
    ['email.delivered', { delivered_at: expect.any(String) }],
    ['email.bounced', { failed_at: expect.any(String), error: 'bounced' }],
    ['email.complained', { failed_at: expect.any(String), error: 'complained' }],
  ])('%s escribe su desenlace', async (tipo, patch) => {
    const cuerpo = EVENTO(tipo);
    await postear(cuerpo, firmar(cuerpo));
    await vi.waitFor(() => expect(updates.length).toBe(1));
    expect(updates[0].patch).toEqual(patch);
  });

  it.each([['email.sent'], ['email.opened'], ['email.clicked']])('%s no escribe nada', async (tipo) => {
    // `sent` ya lo registró el POST. Si se escribiera acá, "aceptado" volvería a contarse
    // como "entregado", que es el hallazgo B23 exacto.
    const cuerpo = EVENTO(tipo);
    const res = await postear(cuerpo, firmar(cuerpo));
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    expect(updates).toEqual([]);
  });

  it('un callback sin email_id no escribe', async () => {
    const cuerpo = JSON.stringify({ type: 'email.delivered', data: {} });
    await postear(cuerpo, firmar(cuerpo));
    await new Promise((r) => setTimeout(r, 30));
    expect(updates).toEqual([]);
  });

  it('si el UPDATE falla, se grita: supabase-js no lanza', async () => {
    // La lección de `procesarStatuses`: con error, `data` viene null, y sin distinguir los
    // dos casos un UPDATE rechazado se lee como "este callback no era de un aviso nuestro".
    resultadoUpdate = { data: null, error: { message: 'RLS' } };
    const cuerpo = EVENTO('email.delivered');
    await postear(cuerpo, firmar(cuerpo));
    await vi.waitFor(() => expect(logMock.error).toHaveBeenCalled());
  });

  it('cero filas es debug, no error: puede ser un correo que no es un aviso', async () => {
    resultadoUpdate = { data: [], error: null };
    const cuerpo = EVENTO('email.delivered');
    await postear(cuerpo, firmar(cuerpo));
    await vi.waitFor(() => expect(logMock.debug).toHaveBeenCalled());
    expect(logMock.error).not.toHaveBeenCalled();
  });
});

describe('baja de recordatorios', () => {
  const baja = (t, metodo = 'GET') =>
    fetch(base + '/baja-recordatorios' + (t == null ? '' : '?t=' + encodeURIComponent(t)), { method: metodo });

  /**
   * **El GET NO puede mutar, y esto no es purismo de HTTP.**
   *
   * El link viaja en el cuerpo del correo Y en el header `List-Unsubscribe`. Los escáneres de
   * links corporativos (Outlook ATP Safe Links, Proofpoint, Mimecast) hacen GET a cada URL de
   * un correo para verificarla, y los clientes que no honran `List-Unsubscribe-Post` también
   * hacen GET sobre el header. Con la primera versión, cualquiera de esos apagaba los
   * recordatorios de alguien que nunca clickeó nada — y como esto apaga TAMBIÉN WhatsApp, lo
   * dejaba en silencio total, con un rastro indistinguible de una baja real.
   */
  it('el GET solo pregunta: NO apaga nada', async () => {
    const res = await baja(construirTokenBaja('u-abc'));
    expect(res.status).toBe(200);
    expect(updates, 'un escáner de links acaba de dar de baja a alguien').toEqual([]);
    const html = await res.text();
    expect(html).toMatch(/¿Dejar de recibir/i);
    expect(html).toContain('<form method="POST"');
  });

  it('el POST es el que apaga: es lo que exige el one-click de Gmail y Outlook', async () => {
    // `List-Unsubscribe-Post` manda POST (RFC 8058). Sigue siendo UN solo paso para el
    // usuario: el botón nativo del cliente de correo hace el POST por él.
    const res = await baja(construirTokenBaja('u-abc'), 'POST');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('no te escribimos más');
    expect(updates[0].patch).toEqual({ recordatorios_activos: false });
    expect(updates[0].filtros).toEqual({ id: 'u-abc' });
  });

  it('el POST también acepta el token por body (el form de confirmación)', async () => {
    const res = await fetch(base + '/baja-recordatorios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 't=' + encodeURIComponent(construirTokenBaja('u-abc')),
    });
    expect(res.status).toBe(200);
    expect(updates[0].filtros).toEqual({ id: 'u-abc' });
  });

  it('las DOS pantallas dicen que apaga todos los canales, no solo el correo', async () => {
    // Es lo que de hecho hace (`recordatorios_activos` lo respetan también los crons de
    // WhatsApp). Prometer solo-correo y apagar todo sería mentir en la única pantalla que
    // alguien ve cuando pide que no lo molesten más.
    for (const metodo of ['GET', 'POST']) {
      const html = await (await baja(construirTokenBaja('u-abc'), metodo)).text();
      expect(html, metodo).toMatch(/todos los canales/i);
      expect(html, metodo).toMatch(/whatsapp/i);
    }
  });

  it.each([['token forjado', 'a.b'], ['sin token', null], ['vacío', '']])
  ('%s: 400 y NO apaga nada, por GET y por POST', async (_c, t) => {
    for (const metodo of ['GET', 'POST']) {
      const res = await baja(t, metodo);
      expect(res.status, metodo).toBe(400);
    }
    expect(updates).toEqual([]);
  });

  it('si el UPDATE falla, NO dice que la baja quedó', async () => {
    // El peor fallo posible de esta ruta: supabase-js no lanza, así que sin leer el `{error}`
    // un UPDATE rechazado devolvería la misma página de "listo" que un éxito y la persona
    // seguiría recibiendo correos después de haberse dado de baja.
    resultadoUpdate = { data: null, error: { message: 'PostgREST 503' } };
    const res = await baja(construirTokenBaja('u-abc'), 'POST');
    expect(res.status).toBe(500);
    expect(await res.text()).not.toMatch(/no te escribimos más/);
    expect(logMock.error).toHaveBeenCalled();
  });
});
