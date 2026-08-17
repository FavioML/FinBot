import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(import.meta.url);

// ─── Setup: parchar singletons ANTES de requerir el webhook ──────────────────
// webhook.js destructura sus dependencias al cargar (const { x } = require(...)).
// Para interceptarlas hay que reemplazar la propiedad en el modulo ANTES de
// requerir webhook, para que la destructuracion capture nuestro spy. Los modulos
// que se usan como objeto (supabase, analytics) se mutan in-place: alcanza porque
// webhook mantiene la misma referencia.

process.env.META_APP_SECRET = 'test-secret';

const enviarWhatsapp = vi.fn().mockResolvedValue(undefined);
require('../../lib/whatsapp').enviarWhatsapp = enviarWhatsapp;

// `notificarAdmin` intenta Telegram PRIMERO y solo cae a WhatsApp si falla. Sin este stub
// los tests del wipe asertaban sobre el fallback —un camino que en Railway no se usa— y,
// peor, con TELEGRAM_BOT_TOKEN exportado en el shell mandaban mensajes REALES al celular
// de Favio en cada corrida. Ya pasó con `webhook-harness` (ver project_avisos_entrega_b23).
// Devuelve false a propósito: así el aviso sale por WhatsApp, que es lo que estos tests
// pueden observar, y el camino de Telegram queda stubeado en vez de vivo.
const enviarTelegram = vi.fn().mockResolvedValue(false);
require('../../lib/telegram').enviarTelegram = enviarTelegram;

const obtenerOCrearUsuario = vi.fn();
require('../../helpers/db-helpers').obtenerOCrearUsuario = obtenerOCrearUsuario;
// guardarMensaje se usa en el envio comun; que sea no-op para no tocar supabase.
require('../../helpers/db-helpers').guardarMensaje = vi.fn().mockResolvedValue(undefined);

// Helpers de servicios que tocan las ramas de onboarding.
const obtenerCuentasGmail = vi.fn().mockResolvedValue([]);
require('../../gmail').obtenerCuentasGmail = obtenerCuentasGmail;

// Desconectar dejó de ser un `activa: false` local y pasó a revocar el grant en Google
// (gmail.js:revocarAccesoGmail). El flip local le cortaba la lectura al usuario pero nos
// dejaba el permiso vivo sobre una bandeja que él acababa de pedir cerrar.
const revocarAccesoGmail = vi.fn().mockResolvedValue({ revocadas: 1, emails: ['a@x.com'] });
require('../../gmail').revocarAccesoGmail = revocarAccesoGmail;

const obtenerGastosMes = vi.fn().mockResolvedValue([]);
require('../../services/transactions').obtenerGastosMes = obtenerGastosMes;

const crearCategoriasDesdeIndices = vi.fn().mockResolvedValue(undefined);
const obtenerCategoriasUsuario = vi.fn().mockResolvedValue([]);
require('../../services/categories').crearCategoriasDesdeIndices = crearCategoriasDesdeIndices;
require('../../services/categories').obtenerCategoriasUsuario = obtenerCategoriasUsuario;

const guardarPresupuesto = vi.fn().mockResolvedValue(undefined);
require('../../services/budget').guardarPresupuesto = guardarPresupuesto;

const interpretarComandoPresupuesto = vi.fn();
require('../../services/parsers').interpretarComandoPresupuesto = interpretarComandoPresupuesto;

const capture = vi.fn();
require('../../lib/analytics').capture = capture;

// Mock de Supabase controlable por test. Una cadena por tabla; los metodos de
// filtrado retornan la misma cadena; await → { data }. update() retorna una
// subcadena propia para poder simular un resultado distinto (ej. 23505) y para
// poder asertar el payload. `otherChains` guarda la cadena por tabla para poder
// inspeccionar deletes/updates del flujo destructivo (paso -1).
function makeChain(data = [], opts = {}) {
  const c = {};
  for (const m of ['select', 'insert', 'delete', 'upsert',
    'eq', 'ilike', 'gte', 'lte', 'is', 'neq', 'not', 'order', 'limit', 'single', 'maybeSingle']) {
    c[m] = vi.fn().mockReturnValue(c);
  }
  const updateResult = opts.updateResult || { data: [], error: null };
  c.update = vi.fn(() => {
    const u = { eq: vi.fn(() => u), then: (onF, onR) => Promise.resolve(updateResult).then(onF, onR) };
    return u;
  });
  c.then = (onF, onR) => Promise.resolve({ data, error: opts.error || null }).then(onF, onR);
  return c;
}

const db = require('../../lib/db');
let usuariosChain;
let otherChains;
db.supabase.from = vi.fn((table) => {
  if (table === 'usuarios') return usuariosChain;
  if (!otherChains[table]) otherChains[table] = makeChain([]);
  return otherChains[table];
});

const createWebhookHandler = require('../../handlers/webhook');
const webhookHandler = createWebhookHandler(vi.fn());

// ─── Helper: construir req firmado + res ─────────────────────────────────────
let wamidSeq = 0;
function buildReqRes(from, texto) {
  const body = {
    entry: [{
      changes: [{
        value: { messages: [{ from, id: 'wamid-' + (wamidSeq++), type: 'text', text: { body: texto } }] }
      }]
    }]
  };
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = 'sha256=' + crypto.createHmac('sha256', 'test-secret').update(rawBody).digest('hex');
  const req = { headers: { 'x-hub-signature-256': signature }, rawBody, body };
  const res = { sendStatus: vi.fn() };
  return { req, res };
}

// Ejercita el webhook con un usuario en cierto estado y devuelve el texto enviado
// AL USUARIO.
//
// El filtro por destinatario no es cosmético. Sin token de Telegram, `notificarAdmin`
// cae a `enviarWhatsapp(ADMIN_NUMBER, ...)`, así que el aviso de baja del wipe entra al
// mismo mock — y como sale ANTES de que webhook envíe la respuesta, `calls[0]` pasó a
// ser el mensaje del admin. Dos tests del wipe empezaron a leer el aviso interno creyendo
// que era lo que le llegó a la persona. Es el mismo hoyo que tuvo `qa-bsuid-media`
// contando el total de salientes: un guard que no mira A QUIÉN le escribió no puede
// distinguir un mensaje al usuario de uno al admin.
const ADMIN_NUMBER = require('../../lib/config').ADMIN_NUMBER;

async function enviarTexto(usuario, texto, from = '51999000111') {
  obtenerOCrearUsuario.mockResolvedValue(usuario);
  const { req, res } = buildReqRes(from, texto);
  await webhookHandler(req, res);
  const alUsuario = enviarWhatsapp.mock.calls.filter((c) => c[0] !== ADMIN_NUMBER);
  return alUsuario[0] ? alUsuario[0][1] : null;
}

/** Lo que se le mandó al admin en esta corrida (null si no se le mandó nada). */
function mensajesAlAdmin() {
  return enviarWhatsapp.mock.calls.filter((c) => c[0] === ADMIN_NUMBER).map((c) => c[1]);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  enviarWhatsapp.mockClear();
  obtenerOCrearUsuario.mockReset();
  obtenerCuentasGmail.mockReset().mockResolvedValue([]);
  // Sin este reset las llamadas se acumulan y un test pasa por lo que hizo el anterior.
  revocarAccesoGmail.mockReset().mockResolvedValue({ revocadas: 1, emails: ['a@x.com'] });
  obtenerGastosMes.mockReset().mockResolvedValue([]);
  crearCategoriasDesdeIndices.mockReset().mockResolvedValue(undefined);
  obtenerCategoriasUsuario.mockReset().mockResolvedValue([]);
  guardarPresupuesto.mockReset().mockResolvedValue(undefined);
  interpretarComandoPresupuesto.mockReset();
  capture.mockClear();
  usuariosChain = makeChain([]);
  otherChains = {};
});

// ─── Trigger de entrada: usuario nuevo ───────────────────────────────────────
describe('Onboarding — entrada (usuario nuevo)', () => {
  it('"hola" sin nombre ni onboarding → pide nombre y pasa a paso 100', async () => {
    const enviado = await enviarTexto({ id: 'u1', onboarding_paso: 0 }, 'hola');
    expect(usuariosChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ onboarding_paso: 100 })
    );
    expect(enviado).toMatch(/c[oó]mo te llamas/i);
  });

  it('"hola" con nombre pero sin completar → cierra el alta y pide el primer gasto', async () => {
    const enviado = await enviarTexto({ id: 'u1', onboarding_paso: 0, nombre: 'Juan' }, 'hola');
    expect(usuariosChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ onboarding_paso: 0, onboarding_completado: true })
    );
    expect(capture).toHaveBeenCalledWith('u1', 'wa_onboarding_completed', { via: 'nombre' });
    expect(enviado).toMatch(/gast[eé] 20 en taxi/i);
  });

  it('el alta ya NO ofrece elegir plan (el modelo es probar y después pagar)', async () => {
    const enviado = await enviarTexto({ id: 'u1', onboarding_paso: 0, nombre: 'Juan' }, 'hola');
    expect(usuariosChain.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ onboarding_paso: 1 })
    );
    expect(enviado).not.toMatch(/plan pro/i);
    expect(enviado).not.toMatch(/S\/10/);
  });

  it('texto libre de usuario nuevo (no comando) → pasa a paso 100', async () => {
    const enviado = await enviarTexto({ id: 'u1', onboarding_paso: 0 }, 'quiero registrar mis gastos');
    expect(usuariosChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ onboarding_paso: 100 })
    );
    expect(enviado).toMatch(/c[oó]mo te llamas/i);
  });

  it('primer mensaje que YA es un gasto → cierra el alta y lo deja pasar al pipeline', async () => {
    // El punto de todo el reordenamiento: nadie pierde su primer gasto por un
    // formulario. onboarding devuelve null → lo registra el pipeline normal.
    const enviado = await enviarTexto({ id: 'u1', onboarding_paso: 0 }, 'gasté 20 en taxi');
    expect(usuariosChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ onboarding_paso: 0, onboarding_completado: true })
    );
    expect(capture).toHaveBeenCalledWith('u1', 'wa_onboarding_completed', { via: 'primer_gasto' });
    expect(usuariosChain.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ onboarding_paso: 100 })
    );
    expect(enviado).toBeNull();   // no responde el alta: responde el registro del gasto
  });

  it('"/manual" → activa Free, completa onboarding y captura evento', async () => {
    const enviado = await enviarTexto({ id: 'u1', onboarding_paso: 0 }, '/manual');
    expect(usuariosChain.update).toHaveBeenCalledWith(expect.objectContaining({ plan: 'free' }));
    expect(usuariosChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ onboarding_paso: 0, onboarding_completado: true })
    );
    expect(capture).toHaveBeenCalledWith('u1', 'wa_onboarding_completed', { via: 'manual' });
    expect(enviado).toMatch(/gasto/i);
  });

  it('"hola" de usuario ya onboardeado (manual) → saludo normal, NO cambia el paso', async () => {
    const enviado = await enviarTexto(
      { id: 'u1', onboarding_paso: 0, nombre: 'Juan', onboarding_completado: true },
      'hola'
    );
    expect(usuariosChain.update).not.toHaveBeenCalled();
    expect(enviado).toMatch(/hola/i);
  });
});

// ─── Paso 100: nombre (última pregunta del alta, y salteable) ────────────────
describe('Onboarding paso 100 — nombre', () => {
  it('nombre valido → capitaliza, guarda y CIERRA el alta pidiendo el primer gasto', async () => {
    const enviado = await enviarTexto({ id: 'u1', onboarding_paso: 100 }, 'juan carlos');
    expect(usuariosChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ nombre: 'Juan Carlos' })
    );
    expect(usuariosChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ onboarding_paso: 0, onboarding_completado: true })
    );
    expect(enviado).toMatch(/gast[eé] 20 en taxi/i);
    expect(enviado).not.toMatch(/correo/i);   // el email salió del alta
  });

  it('extrae el nombre de "me llamo Ana"', async () => {
    await enviarTexto({ id: 'u1', onboarding_paso: 100 }, 'me llamo Ana');
    expect(usuariosChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ nombre: 'Ana' })
    );
  });

  it('"saltar" → cierra el alta sin nombre, sin insistir', async () => {
    const enviado = await enviarTexto({ id: 'u1', onboarding_paso: 100 }, 'saltar');
    expect(usuariosChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ onboarding_paso: 0, onboarding_completado: true })
    );
    expect(capture).toHaveBeenCalledWith('u1', 'wa_onboarding_completed', { via: 'saltado' });
    expect(enviado).toMatch(/gast[eé] 20 en taxi/i);
  });

  it('un gasto en vez del nombre → NO lo guarda como nombre, cierra el alta y lo deja pasar', async () => {
    // Antes esto guardaba "Gasté 20 En Taxi" COMO nombre (el validador acepta
    // cualquier cosa de 2-50 chars) y encima se perdía el gasto.
    const enviado = await enviarTexto({ id: 'u1', onboarding_paso: 100 }, 'gasté 20 en taxi');
    expect(usuariosChain.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ nombre: expect.any(String) })
    );
    expect(capture).toHaveBeenCalledWith('u1', 'wa_onboarding_completed', { via: 'primer_gasto' });
    expect(enviado).toBeNull();
  });

  it('nombre invalido, primer intento → repregunta UNA vez y cuenta el intento', async () => {
    const enviado = await enviarTexto({ id: 'u1', onboarding_paso: 100, nombre_intentos: 0 }, 'A');
    expect(usuariosChain.update).toHaveBeenCalledWith({ nombre_intentos: 1 });
    expect(capture).toHaveBeenCalledWith('u1', 'wa_onboarding_step_failed', { paso: 100, motivo: 'nombre_invalido' });
    expect(enviado).toMatch(/saltar/i);
  });

  it('nombre invalido, segundo intento → deja de insistir y cierra el alta', async () => {
    const enviado = await enviarTexto({ id: 'u1', onboarding_paso: 100, nombre_intentos: 1 }, 'A');
    expect(usuariosChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ onboarding_paso: 0, onboarding_completado: true })
    );
    expect(enviado).toMatch(/gast[eé] 20 en taxi/i);
  });
});

// ─── Paso 101: retirado (solo queda la rama de compatibilidad) ───────────────
describe('Onboarding paso 101 — retirado', () => {
  it('nunca pide el correo: desatasca al que quedó ahí con el flujo viejo', async () => {
    const enviado = await enviarTexto({ id: 'user-1', onboarding_paso: 101, nombre: 'Juan' }, 'hola?');
    expect(usuariosChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ onboarding_paso: 0, onboarding_completado: true })
    );
    expect(capture).toHaveBeenCalledWith('user-1', 'wa_onboarding_completed', { via: 'desatascado_101' });
    expect(enviado).not.toMatch(/correo|email/i);
    expect(enviado).toMatch(/gast[eé] 20 en taxi/i);
  });

  it('si el atascado escribe un gasto, se desatasca y el gasto se registra', async () => {
    const enviado = await enviarTexto({ id: 'user-1', onboarding_paso: 101, nombre: 'Juan' }, 'gasté 30 en pollo');
    expect(usuariosChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ onboarding_paso: 0, onboarding_completado: true })
    );
    expect(enviado).toBeNull();
  });

  it('un correo escrito a destiempo ya no se guarda como email', async () => {
    usuariosChain = makeChain([]);
    await enviarTexto({ id: 'user-1', onboarding_paso: 101, nombre: 'Juan' }, 'juan@gmail.com');
    expect(usuariosChain.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ email: 'juan@gmail.com' })
    );
  });
});

// ─── Paso 1: Free / Pro ──────────────────────────────────────────────────────
describe('Onboarding paso 1 — Free/Pro', () => {
  it('"free" → completa onboarding en plan free y captura evento', async () => {
    const enviado = await enviarTexto({ id: 'u1', onboarding_paso: 1, nombre: 'Juan' }, 'free');
    expect(usuariosChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ plan: 'free', onboarding_paso: 0, onboarding_completado: true })
    );
    expect(capture).toHaveBeenCalledWith('u1', 'wa_onboarding_completed', { via: 'free' });
    expect(enviado).toMatch(/free/i);
  });

  it('"pro" → avanza a paso 2 con datos de Yape', async () => {
    const enviado = await enviarTexto({ id: 'u1', onboarding_paso: 1, nombre: 'Juan' }, 'pro');
    expect(usuariosChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ onboarding_paso: 2 })
    );
    expect(enviado).toMatch(/970398192/);
  });

  it('"dale" (sinonimo de si) → avanza a paso 2', async () => {
    await enviarTexto({ id: 'u1', onboarding_paso: 1, nombre: 'Juan' }, 'dale');
    expect(usuariosChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ onboarding_paso: 2 })
    );
  });

  it('"no" → vuelve a paso 0 sin completar onboarding', async () => {
    await enviarTexto({ id: 'u1', onboarding_paso: 1, nombre: 'Juan' }, 'no');
    expect(usuariosChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ onboarding_paso: 0 })
    );
    expect(usuariosChain.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ onboarding_completado: true })
    );
  });

  it('texto no reconocido → reprompt sin cambiar de paso', async () => {
    const enviado = await enviarTexto({ id: 'u1', onboarding_paso: 1, nombre: 'Juan' }, 'tal vez');
    expect(usuariosChain.update).not.toHaveBeenCalled();
    expect(enviado).toMatch(/free/i);
  });
});

// ─── Paso 2: mensual / anual ─────────────────────────────────────────────────
describe('Onboarding paso 2 — plan mensual/anual', () => {
  it('"1" → set tipo_plan mensual', async () => {
    const enviado = await enviarTexto({ id: 'u1', onboarding_paso: 2, nombre: 'Juan' }, '1');
    expect(usuariosChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ tipo_plan: 'mensual' })
    );
    expect(enviado).toMatch(/mensual/i);
  });

  it('"anual" → set tipo_plan anual', async () => {
    const enviado = await enviarTexto({ id: 'u1', onboarding_paso: 2, nombre: 'Juan' }, 'anual');
    expect(usuariosChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ tipo_plan: 'anual' })
    );
    expect(enviado).toMatch(/anual/i);
  });

  it('texto no reconocido → recuerda las opciones sin cambiar tipo_plan', async () => {
    const enviado = await enviarTexto({ id: 'u1', onboarding_paso: 2, nombre: 'Juan' }, 'que?');
    expect(usuariosChain.update).not.toHaveBeenCalled();
    expect(enviado).toMatch(/mensual/i);
  });
});

// ─── Paso 10: categorias ─────────────────────────────────────────────────────
describe('Onboarding paso 10 — categorias', () => {
  it('indices validos → crea categorias, completa onboarding y avanza a paso 20', async () => {
    const enviado = await enviarTexto({ id: 'u1', onboarding_paso: 10, nombre: 'Juan' }, '1 3');
    expect(crearCategoriasDesdeIndices).toHaveBeenCalledWith('u1', [1, 3]);
    expect(usuariosChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ onboarding_paso: 20, onboarding_completado: true })
    );
    expect(capture).toHaveBeenCalledWith('u1', 'wa_onboarding_completed', { via: 'categorias' });
    expect(enviado).toMatch(/categor/i);
  });

  it('sin indices validos → NO crea categorias ni avanza a paso 20', async () => {
    await enviarTexto({ id: 'u1', onboarding_paso: 10, nombre: 'Juan' }, 'no se');
    expect(crearCategoriasDesdeIndices).not.toHaveBeenCalled();
    expect(usuariosChain.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ onboarding_paso: 20 })
    );
  });
});

// ─── Paso 20: presupuesto opcional ───────────────────────────────────────────
describe('Onboarding paso 20 — presupuesto', () => {
  it('"listo" → termina el onboarding y vuelve a paso 0', async () => {
    const enviado = await enviarTexto({ id: 'u1', onboarding_paso: 20, nombre: 'Juan' }, 'listo');
    expect(usuariosChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ onboarding_paso: 0 })
    );
    expect(enviado).toMatch(/empezamos/i);
  });

  it('presupuesto valido → lo guarda y sigue ofreciendo mas', async () => {
    interpretarComandoPresupuesto.mockResolvedValue({ es_presupuesto: true, categoria: 'Comida', monto: 500 });
    const enviado = await enviarTexto({ id: 'u1', onboarding_paso: 20, nombre: 'Juan' }, 'limite de 500 en comida');
    expect(guardarPresupuesto).toHaveBeenCalledWith('u1', 'Comida', 500);
    expect(enviado).toMatch(/presupuesto/i);
  });
});

// ─── Paso -1: desconexion / wipe (flujo destructivo) ─────────────────────────
describe('Onboarding paso -1 — desconexion / wipe', () => {
  it('multi-cuenta, "1" → desconecta la primera cuenta y vuelve a paso 0', async () => {
    obtenerCuentasGmail.mockResolvedValue([
      { id: 'g1', email: 'a@x.com' }, { id: 'g2', email: 'b@x.com' },
    ]);
    const enviado = await enviarTexto({ id: 'u1', onboarding_paso: -1 }, '1');
    // Con cuentaId: revocar las otras le apagaría en silencio una lectura que sigue pagando.
    expect(revocarAccesoGmail).toHaveBeenCalledWith('u1', expect.objectContaining({ cuentaId: 'g1' }));
    expect(usuariosChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ onboarding_paso: 0 })
    );
    expect(otherChains['transacciones']).toBeUndefined(); // no borra datos
    expect(enviado).toMatch(/desconectado/i);
  });

  it('multi-cuenta, "N+1" → desconecta todas las cuentas sin borrar datos', async () => {
    obtenerCuentasGmail.mockResolvedValue([
      { id: 'g1', email: 'a@x.com' }, { id: 'g2', email: 'b@x.com' },
    ]);
    const enviado = await enviarTexto({ id: 'u1', onboarding_paso: -1 }, '3');
    // Sin cuentaId = todas.
    expect(revocarAccesoGmail).toHaveBeenCalledWith('u1', expect.not.objectContaining({ cuentaId: expect.anything() }));
    expect(otherChains['transacciones']).toBeUndefined();
    expect(enviado).toMatch(/desconectad/i);
  });

  it('multi-cuenta, "N+2" → WIPE: borra transacciones, categorias, presupuestos y gmail_cuentas', async () => {
    obtenerCuentasGmail.mockResolvedValue([
      { id: 'g1', email: 'a@x.com' }, { id: 'g2', email: 'b@x.com' },
    ]);
    const enviado = await enviarTexto({ id: 'u1', onboarding_paso: -1 }, '4');
    expect(otherChains['transacciones'].delete).toHaveBeenCalled();
    expect(otherChains['categorias_usuario'].delete).toHaveBeenCalled();
    expect(otherChains['presupuestos'].delete).toHaveBeenCalled();
    expect(otherChains['gmail_cuentas'].delete).toHaveBeenCalled();
    // Revocar antes del delete: borrar la fila tira el refresh token y el grant queda vivo.
    expect(revocarAccesoGmail).toHaveBeenCalled();
    expect(usuariosChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ onboarding_paso: 0, onboarding_completado: false, email: null })
    );
    expect(enviado).toMatch(/eliminad|limpia/i);
  });

  // ── La baja declarada ──────────────────────────────────────────────────────
  // Dos de los cinco Pro pagados pasaron por acá (medido 17-ago-2026) y siguieron
  // contando como ingreso recurrente, uno con plan anual vigente hasta 2027, sin que
  // nadie se enterara. Estos casos afirman las dos mitades: que quede la marca y que
  // salga el aviso. Mutación que los mata: quitar `cuenta_borrada_at` del update, o
  // quitar el `await avisarBajaAlAdmin(...)`.

  it('el wipe MARCA la baja en cuenta_borrada_at', async () => {
    obtenerCuentasGmail.mockResolvedValue([{ id: 'g1', email: 'a@x.com' }]);
    await enviarTexto({ id: 'u1', onboarding_paso: -1 }, '2');
    const update = usuariosChain.update.mock.calls.find((c) => 'cuenta_borrada_at' in (c[0] || {}));
    expect(update).toBeDefined();
    expect(typeof update[0].cuenta_borrada_at).toBe('string');
  });

  // El plan es lo único que NO se toca: la persona pagó y si vuelve conserva su Pro.
  // Esto es una marca para las métricas, no una baja de entitlement.
  it('el wipe NO baja el plan ni toca premium_vence', async () => {
    obtenerCuentasGmail.mockResolvedValue([]);
    await enviarTexto({ id: 'u1', onboarding_paso: -1, plan: 'premium', trial_estado: 'convertido' }, '1');
    for (const [campos] of usuariosChain.update.mock.calls) {
      expect(campos).not.toHaveProperty('plan');
      expect(campos).not.toHaveProperty('premium_vence');
      expect(campos).not.toHaveProperty('estado_pago');
    }
  });

  it('el wipe avisa al admin, y ese aviso NO va al usuario', async () => {
    obtenerCuentasGmail.mockResolvedValue([]);
    const enviado = await enviarTexto({ id: 'u1', onboarding_paso: -1, nombre: 'Diego' }, '1');
    const avisos = mensajesAlAdmin();
    expect(avisos.length).toBe(1);
    expect(avisos[0]).toMatch(/BAJA DECLARADA/);
    // Lo que hace accionable el aviso: quién y cuánto perdió.
    expect(avisos[0]).toContain('Diego');
    // Y la persona recibe SU mensaje, no el interno.
    expect(enviado).toMatch(/eliminad/i);
    expect(enviado).not.toMatch(/BAJA DECLARADA/);
  });

  it('el aviso distingue a un Pro PAGADO de alguien que solo probó', async () => {
    obtenerCuentasGmail.mockResolvedValue([]);
    await enviarTexto({
      id: 'u1', onboarding_paso: -1, nombre: 'Diego',
      plan: 'premium', trial_estado: 'convertido', tipo_plan: 'anual', premium_vence: '2027-07-01',
    }, '1');
    const aviso = mensajesAlAdmin()[0];
    expect(aviso).toMatch(/ES PRO PAGADO/);
    expect(aviso).toContain('anual');
    expect(aviso).toContain('2027-07-01');
  });

  it('un trial en curso NO se anuncia como pagado', async () => {
    obtenerCuentasGmail.mockResolvedValue([]);
    await enviarTexto({ id: 'u1', onboarding_paso: -1, plan: 'premium', trial_estado: 'activo' }, '1');
    expect(mensajesAlAdmin()[0]).not.toMatch(/ES PRO PAGADO/);
  });

  // El diseño de "limpiar la marca al volver" se DESCARTÓ: `onboarding_completado = true`
  // se escribe en otros cinco lugares que no limpiaban nada, y `merge_and_link` hereda las
  // dos columnas juntas, así que tras un merge la marca quedaba puesta con el alta ya
  // cerrada — sin salida. Ahora la columna es un HECHO que no se toca nunca, y "¿está de
  // baja hoy?" lo deriva `esBajaDeclarada` en la webapp comparando contra el pago.
  // supabase-js NO lanza: devuelve { error }. Sin leerlo, un statement timeout dejaba los
  // datos intactos y el flujo seguía afirmando tres cosas falsas (al usuario, al admin y en
  // la marca). Mutación que mata esto: sacar el `if (error)` del bucle de deletes.
  it('si el borrado FALLA no se marca la baja ni se le miente al usuario', async () => {
    otherChains = {};
    // Se siembra el chain de transacciones con error ANTES de que el handler lo pida.
    otherChains['transacciones'] = makeChain([], { error: { message: 'statement timeout' } });
    obtenerCuentasGmail.mockResolvedValue([]);
    const enviado = await enviarTexto({ id: 'u1', onboarding_paso: -1 }, '1');
    expect(enviado).toMatch(/no pude eliminar/i);
    expect(enviado).not.toMatch(/eliminados|limpia/i);
    const marcó = usuariosChain.update.mock.calls.some((c) => 'cuenta_borrada_at' in (c[0] || {}));
    expect(marcó, 'marcó la baja aunque el borrado falló').toBe(false);
  });

  it('volver a darse de alta NO toca la marca (es un hecho, no un estado)', async () => {
    await enviarTexto({ id: 'u1', onboarding_paso: 100 }, 'Diego');
    for (const [campos] of usuariosChain.update.mock.calls) {
      expect(campos).not.toHaveProperty('cuenta_borrada_at');
    }
  });

  it('una cuenta, "1" → desconecta Gmail sin borrar datos', async () => {
    obtenerCuentasGmail.mockResolvedValue([{ id: 'g1', email: 'a@x.com' }]);
    const enviado = await enviarTexto({ id: 'u1', onboarding_paso: -1 }, '1');
    expect(revocarAccesoGmail).toHaveBeenCalledWith('u1', expect.anything());
    expect(otherChains['transacciones']).toBeUndefined();
    expect(enviado).toMatch(/desconectado/i);
  });

  it('una cuenta, "2" → WIPE completo', async () => {
    obtenerCuentasGmail.mockResolvedValue([{ id: 'g1', email: 'a@x.com' }]);
    await enviarTexto({ id: 'u1', onboarding_paso: -1 }, '2');
    expect(otherChains['transacciones'].delete).toHaveBeenCalled();
    expect(otherChains['gmail_cuentas'].delete).toHaveBeenCalled();
    expect(usuariosChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ onboarding_paso: 0, onboarding_completado: false })
    );
  });

  it('sin cuentas, "1" → borra datos (sin tocar gmail_cuentas)', async () => {
    obtenerCuentasGmail.mockResolvedValue([]);
    const enviado = await enviarTexto({ id: 'u1', onboarding_paso: -1 }, '1');
    expect(otherChains['transacciones'].delete).toHaveBeenCalled();
    expect(otherChains['categorias_usuario'].delete).toHaveBeenCalled();
    expect(otherChains['presupuestos'].delete).toHaveBeenCalled();
    expect(usuariosChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ onboarding_paso: 0, onboarding_completado: false, email: null })
    );
    expect(enviado).toMatch(/eliminad/i);
  });

  it('respuesta invalida → cancela sin borrar nada y vuelve a paso 0', async () => {
    obtenerCuentasGmail.mockResolvedValue([{ id: 'g1', email: 'a@x.com' }]);
    const enviado = await enviarTexto({ id: 'u1', onboarding_paso: -1 }, '99');
    expect(otherChains['transacciones']).toBeUndefined();
    expect(usuariosChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ onboarding_paso: 0 })
    );
    expect(enviado).toMatch(/cancelado/i);
  });
});

// ─── Precedencia: un comando "/" escapa la maquina de estados ────────────────
describe('Onboarding — precedencia de comandos', () => {
  it('un "/comando" en un paso intermedio NO es capturado por el onboarding', async () => {
    // Usuario en paso 1: "/ayuda" no debe tratarse como respuesta Free/Pro.
    await enviarTexto({ id: 'u1', onboarding_paso: 1, nombre: 'Juan' }, '/ayuda');
    // No hubo transicion de onboarding (no se seteo plan ni paso 2).
    expect(usuariosChain.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ onboarding_paso: 2 })
    );
    expect(usuariosChain.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ plan: 'free' })
    );
  });
});
