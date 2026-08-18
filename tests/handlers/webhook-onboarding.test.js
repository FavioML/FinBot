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

// El borrado de cuenta vive entero en `services/account-deletion.js` desde la migracion 073.
// Se mockea porque aca lo que se prueba es el DESPACHO y el TEXTO; el flujo (RPC, Storage,
// auth.users) tiene su propio archivo, y "las 30 tablas quedaron vacias" no es mockeable:
// este doble no ejecuta FKs ni triggers. Eso lo mide qa-e2e/qa-borrado-cuenta.mjs.
const borrarCuenta = vi.fn();
require('../../services/account-deletion').borrarCuenta = borrarCuenta;

const capture = vi.fn();
require('../../lib/analytics').capture = capture;

// El wipe fallido es el único evento de esta rama que deja rastro consultable: `log.error` es
// pino a stdout, así que sin esto el único registro son los logs de Railway. Se espía acá
// arriba porque `handlers/onboarding.js` destructura `registrarError` al cargar el módulo.
const registrarError = vi.fn().mockResolvedValue(undefined);
require('../../lib/error-monitor').registrarError = registrarError;

// Mock de Supabase controlable por test. Una cadena por tabla; los metodos de
// filtrado retornan la misma cadena; await → { data }. update() retorna una
// subcadena propia para poder simular un resultado distinto (ej. 23505) y para
// poder asertar el payload. `otherChains` guarda la cadena por tabla para poder
// inspeccionar deletes/updates del flujo destructivo (paso -1).
function makeChain(data = [], opts = {}) {
  const c = {};
  for (const m of ['eq', 'ilike', 'gte', 'lte', 'is', 'neq', 'not', 'order', 'limit', 'single', 'maybeSingle']) {
    c[m] = vi.fn().mockReturnValue(c);
  }
  // El `opts.error` se aplica a la OPERACIÓN, no a la tabla, y la distinción hace falta desde
  // que el wipe vuelve a contar `transacciones` DESPUÉS de que su delete falló: con el error
  // pegado al chain, ese segundo SELECT heredaba el fallo del DELETE y no se podía escribir el
  // caso que importa (delete roto, conteo sano). En el cliente real son dos requests distintos.
  // `__op` se resetea en cada await para que el mismo chain sirva a varias operaciones.
  for (const m of ['select', 'insert', 'delete', 'upsert']) {
    c[m] = vi.fn(() => { c.__op = m; if (m === 'delete') c.__deleteHecho = true; return c; });
  }
  const updateResult = opts.updateResult || { data: [], error: null };
  c.update = vi.fn(() => {
    const u = { eq: vi.fn(() => u), then: (onF, onR) => Promise.resolve(updateResult).then(onF, onR) };
    return u;
  });
  c.then = (onF, onR) => {
    const op = c.__op;
    c.__op = null;
    // `__count` alimenta el `{ count }` de los SELECT con `head: true`. Sin fijarlo queda
    // undefined, que es lo que ya asumían los tests preexistentes (`filas` termina en null).
    // El conteo se sirve POR FASE, no por llamada. El wipe cuenta `transacciones` ANTES de
    // borrar y otra vez DESPUÉS del fallo, y el caso que de verdad importa —el DELETE commiteó
    // pese al `{error}`— es justamente aquel en que los dos conteos DIFIEREN (7 antes, 0
    // después). Con un `__count` único ese escenario era inexpresable, y el test que decía
    // cubrirlo ejercitaba otra cosa.
    //
    // Se probó con una COLA consumida por `shift()` y estaba mal: el webhook consulta
    // `transacciones` antes de llegar al wipe, así que esa llamada se comía el primer valor y
    // los dos conteos del wipe salían corridos. Anclar la fase al `delete` es inmune a cuántos
    // selects haya de más, que es lo que uno quiere de un doble de pruebas.
    const cnt = (c.__deleteHecho && c.__countDespues !== undefined) ? c.__countDespues : c.__count;
    const res = op === 'select'
      ? { data, error: null, count: cnt }
      : { data, error: opts.error || null };
    return Promise.resolve(res).then(onF, onR);
  };
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
  // El default es el camino FELIZ. Los casos que prueban el fallo lo sobreescriben: sin
  // reset, un test que fuerza `ok: false` se lo dejaba puesto al siguiente y ese siguiente
  // pasaba por el motivo equivocado.
  borrarCuenta.mockReset().mockResolvedValue({ ok: true, tieneGmail: false, resumen: { transacciones: 0 }, sucio: [] });
  obtenerGastosMes.mockReset().mockResolvedValue([]);
  crearCategoriasDesdeIndices.mockReset().mockResolvedValue(undefined);
  obtenerCategoriasUsuario.mockReset().mockResolvedValue([]);
  guardarPresupuesto.mockReset().mockResolvedValue(undefined);
  interpretarComandoPresupuesto.mockReset();
  capture.mockClear();
  registrarError.mockReset().mockResolvedValue(undefined);
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

  // ─── El wipe, después de la migración 073 ──────────────────────────────────
  //
  // Acá vivían 22 casos que ejercitaban una taxonomía de fallo PARCIAL: falló
  // `presupuestos` pero no `transacciones`, había 7 y ahora hay 0, el conteo previo no se
  // pudo leer, se marcó la baja con los datos a medias. Esa taxonomía ya no existe: el
  // borrado corre en UNA transacción, así que o pasó todo o no pasó nada. Los casos no se
  // "perdieron" — dejaron de ser expresables porque el estado que describían es inalcanzable.
  //
  // Lo que SÍ hay que seguir cubriendo se partió en tres, y conviene saber dónde está cada
  // cosa antes de agregar un test acá:
  //
  //   · el TEXTO y el despacho          → estos casos
  //   · el flujo (RPC, Storage, auth)   → tests/services/account-deletion.test.js
  //   · que las 30 tablas queden vacías → qa-e2e/qa-borrado-cuenta.mjs, contra la DB real
  //
  // Ese último no se puede mockear y no es una preferencia: el doble de `makeChain` no
  // ejecuta FKs ni triggers, así que un verde acá no dice NADA sobre qué se lleva puesto un
  // DELETE. Un test que afirmara "se borraron las 30 tablas" con este mock estaría midiendo
  // su propia configuración.

  it('multi-cuenta, "N+2" → delega el borrado en el servicio', async () => {
    obtenerCuentasGmail.mockResolvedValue([
      { id: 'g1', email: 'a@x.com' }, { id: 'g2', email: 'b@x.com' },
    ]);
    await enviarTexto({ id: 'u1', onboarding_paso: -1 }, '4');
    expect(borrarCuenta).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u1' }),
      expect.objectContaining({ origen: 'whatsapp' })
    );
  });

  it('una cuenta, "2" → delega el borrado en el servicio', async () => {
    obtenerCuentasGmail.mockResolvedValue([{ id: 'g1', email: 'a@x.com' }]);
    await enviarTexto({ id: 'u1', onboarding_paso: -1 }, '2');
    expect(borrarCuenta).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u1' }),
      expect.objectContaining({ origen: 'whatsapp' })
    );
  });

  it('sin cuentas, "1" → delega el borrado en el servicio', async () => {
    obtenerCuentasGmail.mockResolvedValue([]);
    await enviarTexto({ id: 'u1', onboarding_paso: -1 }, '1');
    expect(borrarCuenta).toHaveBeenCalled();
  });

  // El guard que impide que vuelvan las tres copias. Si alguien re-agrega un delete en
  // `onboarding.js` —o vuelve a "arreglar" algo del borrado acá en vez de en el servicio—
  // este caso lo ve: con el servicio mockeado, NINGUNA tabla debería tocarse desde el
  // handler. Es el mismo error que se unificó el 17-ago, y ahora hay dos canales para
  // repetirlo.
  it('onboarding NO borra por su cuenta: el flujo entero vive en el servicio', async () => {
    obtenerCuentasGmail.mockResolvedValue([{ id: 'g1', email: 'a@x.com' }]);
    await enviarTexto({ id: 'u1', onboarding_paso: -1 }, '2');
    expect(otherChains['transacciones']).toBeUndefined();
    expect(otherChains['gmail_cuentas']).toBeUndefined();
    expect(otherChains['presupuestos']).toBeUndefined();
    // Tampoco la marca de baja: `cuenta_borrada_at` se escribe DENTRO de la transacción.
    for (const [campos] of usuariosChain.update.mock.calls) {
      expect(campos).not.toHaveProperty('cuenta_borrada_at');
    }
  });

  // El caso que da nombre a todo este trabajo. El mensaje decía "Todos tus datos han sido
  // eliminados" y era falso incluso con el borrado arreglado, porque hay cosas que se
  // conservan por obligación contable y porque los backups cifrados no se pueden reescribir.
  it('el mensaje NOMBRA lo que se conserva y no promete el absoluto', async () => {
    obtenerCuentasGmail.mockResolvedValue([]);
    const enviado = await enviarTexto({ id: 'u1', onboarding_paso: -1 }, '1');
    expect(enviado).toMatch(/pagos/i);
    expect(enviado).toMatch(/respaldo/i);
    expect(enviado, 'volvió a prometer que se borró TODO').not.toMatch(/todos tus datos/i);
  });

  // Los dos lados van en casos SEPARADOS a propósito: `enviarTexto` devuelve el PRIMER
  // mensaje que salió, así que dos borrados en un mismo caso comparan el segundo contra el
  // texto del primero — y el test pasaba o fallaba por eso, no por lo que dice afirmar.
  it('menciona el Gmail cuando había una cuenta conectada', async () => {
    obtenerCuentasGmail.mockResolvedValue([{ id: 'g1', email: 'a@x.com' }]);
    borrarCuenta.mockResolvedValue({ ok: true, tieneGmail: true, resumen: {}, sucio: [] });
    expect(await enviarTexto({ id: 'u1', onboarding_paso: -1 }, '2')).toMatch(/gmail/i);
  });

  it('no menciona el Gmail cuando no había ninguna conectada', async () => {
    obtenerCuentasGmail.mockResolvedValue([]);
    borrarCuenta.mockResolvedValue({ ok: true, tieneGmail: false, resumen: {}, sucio: [] });
    expect(await enviarTexto({ id: 'u1', onboarding_paso: -1 }, '1')).not.toMatch(/gmail/i);
  });

  // Se le borra el número, así que si vuelve NO se lo reconoce solo. El Pro sigue pagado en
  // su fila, pero recuperarlo pasa a ser un trámite — y decírselo ANTES de que se vaya es lo
  // que convierte esa pérdida en un trámite en vez de una sorpresa.
  it('a un Pro PAGADO le dice hasta cuándo tiene Pro y cómo reclamarlo', async () => {
    obtenerCuentasGmail.mockResolvedValue([]);
    const enviado = await enviarTexto(
      { id: 'u1', onboarding_paso: -1, plan: 'premium', trial_estado: 'convertido', premium_vence: '2027-03-15' },
      '1'
    );
    expect(enviado).toMatch(/15\/03\/2027/);
    expect(enviado).toMatch(/hola@neto\.pe/);
  });

  it('un trial en curso NO recibe el párrafo de Pro pagado', async () => {
    obtenerCuentasGmail.mockResolvedValue([]);
    const enviado = await enviarTexto(
      { id: 'u1', onboarding_paso: -1, plan: 'premium', trial_estado: 'activo', premium_vence: '2026-09-01' },
      '1'
    );
    expect(enviado).not.toMatch(/hola@neto\.pe/);
  });

  // Con el borrado en una transacción esto es verdad por construcción, no por medición: si
  // el RPC falló, no se tocó una sola fila. El wipe viejo necesitaba tres conteos y un
  // desambiguador para no mentir acá.
  it('si el borrado falla, le dice que su cuenta sigue igual', async () => {
    obtenerCuentasGmail.mockResolvedValue([]);
    borrarCuenta.mockResolvedValue({ ok: false, motivo: 'statement timeout', tieneGmail: false, resumen: null, sucio: [] });
    const enviado = await enviarTexto({ id: 'u1', onboarding_paso: -1 }, '1');
    expect(enviado).toMatch(/sigue igual/i);
    expect(enviado).not.toMatch(/eliminad/i);
    expect(enviado).toMatch(/soporte/i);
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
    expect(borrarCuenta).not.toHaveBeenCalled();
    expect(enviado).toMatch(/desconectado/i);
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
