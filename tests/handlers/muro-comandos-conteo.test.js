import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(import.meta.url);

/**
 * El conteo del muro en la cascada de comandos `/` de `handlers/webhook.js`, que es el gemelo
 * de `handlers/muro-gate.js` (cubierto por `muro-gate-conteo.test.js`) y no tenía test propio.
 *
 * Lo encontró la revisión adversarial del chip 3 (30-sep-2026) mutando la línea a
 * `mensajeMuro(usuario, conteoMuroCmd)`: la suite entera quedó verde. Con el texto nuevo de la
 * rama sin prueba, esa mutación le diría "tu prueba todavía no empezó: se abre con tu primer gasto" a uno
 * de los usuarios dormidos con decenas de movimientos cada vez que la lectura del conteo falle.
 *
 * Entra por un POST firmado al handler real, como los demás `webhook-*.test.js`, y afirma lo
 * que recibió `enviarWhatsapp`.
 */

process.env.META_APP_SECRET = 'test-secret';

const enviarWhatsapp = vi.fn().mockResolvedValue(undefined);
require('../../lib/whatsapp').enviarWhatsapp = enviarWhatsapp;

const SIN_PRUEBA = {
  id: 'u-dormido', whatsapp: '51999000222', nombre: 'Ana', plan: 'free', trial_estado: null,
  onboarding_completado: true, onboarding_paso: 0, recordatorios_activos: true, supabase_auth_id: null,
};
const dbHelpers = require('../../helpers/db-helpers');
dbHelpers.resolverUsuarioEntrante = vi.fn(async () => ({ ...SIN_PRUEBA }));
dbHelpers.guardarMensaje = vi.fn().mockResolvedValue(undefined);
dbHelpers.getUserPlanConfig = vi.fn(() => ({ resumenDiario: true, maxGmailAccounts: 1 }));
require('../../handlers/onboarding').manejarOnboarding = vi.fn().mockResolvedValue(null);
require('../../lib/error-monitor').registrarError = vi.fn().mockResolvedValue(undefined);
require('../../lib/admin-notify').notificarErrorAdmin = vi.fn().mockResolvedValue(undefined);
require('../../lib/analytics').capture = vi.fn();

// El conteo es `from('transacciones').select(..., {count, head}).eq(...)`. Cualquier otra
// lectura del camino recibe vacío: este archivo mide sólo el conteo.
let conteo = { count: 0, error: null };
const tablas = [];
function cadena(tabla) {
  const resultado = () => (tabla === 'transacciones' ? conteo : { data: null, error: null, count: null });
  const c = new Proxy(function () {}, {
    get(_, prop) {
      if (prop === 'then') return (ok, ko) => Promise.resolve(resultado()).then(ok, ko);
      return () => c;
    },
    apply() { return c; },
  });
  return c;
}
require('../../lib/db').supabase = {
  from: (t) => { tablas.push(t); return cadena(t); },
  rpc: () => Promise.resolve({ data: null, error: null }),
};

const createWebhookHandler = require('../../handlers/webhook');
const procesarMensajeLibre = vi.fn().mockResolvedValue('respuesta-del-NLP');
const webhookHandler = createWebhookHandler(procesarMensajeLibre);

let seq = 0;
async function enviar(texto) {
  const from = '5199902' + String(1000 + seq);
  const body = { entry: [{ changes: [{ value: { messages: [{ from, id: 'wamid-muro-cmd-' + (seq++), type: 'text', text: { body: texto } }] } }] }] };
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = 'sha256=' + crypto.createHmac('sha256', 'test-secret').update(rawBody).digest('hex');
  await webhookHandler({ headers: { 'x-hub-signature-256': signature }, rawBody, body }, { sendStatus: vi.fn() });
  const enviados = enviarWhatsapp.mock.calls.map((c) => c[1]);
  return enviados.length ? enviados[enviados.length - 1] : null;
}

beforeEach(() => {
  enviarWhatsapp.mockClear();
  procesarMensajeLibre.mockClear();
  tablas.length = 0;
});

describe('cascada de `/` en el muro: el conteo caído no afirma cero', () => {
  it('con la lectura del conteo caída no dice que no hay movimientos', async () => {
    conteo = { count: null, error: { message: 'boom' } };
    const r = await enviar('/mes');
    expect(procesarMensajeLibre, 'el comando no llegó a la cascada').not.toHaveBeenCalled();
    expect(tablas).toContain('transacciones');
    expect(r).toContain('es parte de *Neto Pro*');
    expect(r, 'le afirma cero movimientos a quien quizá tiene decenas').not.toContain('todavía no empezó');
    expect(r).toContain('registres un gasto');
    expect(r).not.toContain('primer gasto');
  });

  it('control: con el conteo leído en 0 sí lo dice, y en 7 recita los 7', async () => {
    conteo = { count: 0, error: null };
    expect(await enviar('/mes')).toContain('todavía no empezó');
    conteo = { count: 7, error: null };
    expect(await enviar('/mes')).toContain('*7 movimientos* siguen guardados');
  });

  it('/escanear avisa que Gmail no entra en la prueba; /mes no lo menciona', async () => {
    conteo = { count: 0, error: null };
    expect(await enviar('/escanear')).toMatch(/correos del banco.*Pro\* pagado/s);
    // Con argumentos también: `comandoRequiereLectura` los tolera, así que el muro los ve.
    expect(await enviar('/escanear ahora')).toMatch(/correos del banco.*Pro\* pagado/s);
    expect(await enviar('/mes')).not.toMatch(/correo/i);
  });
});
