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

const obtenerOCrearUsuario = vi.fn();
require('../../helpers/db-helpers').obtenerOCrearUsuario = obtenerOCrearUsuario;
// guardarMensaje se usa en el envio comun; que sea no-op para no tocar supabase.
require('../../helpers/db-helpers').guardarMensaje = vi.fn().mockResolvedValue(undefined);

// Helpers de servicios que tocan las ramas de onboarding.
const obtenerCuentasGmail = vi.fn().mockResolvedValue([]);
require('../../gmail').obtenerCuentasGmail = obtenerCuentasGmail;

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
  c.then = (onF, onR) => Promise.resolve({ data, error: null }).then(onF, onR);
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

// Ejercita el webhook con un usuario en cierto estado y devuelve el texto enviado.
async function enviarTexto(usuario, texto, from = '51999000111') {
  obtenerOCrearUsuario.mockResolvedValue(usuario);
  const { req, res } = buildReqRes(from, texto);
  await webhookHandler(req, res);
  return enviarWhatsapp.mock.calls[0] ? enviarWhatsapp.mock.calls[0][1] : null;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  enviarWhatsapp.mockClear();
  obtenerOCrearUsuario.mockReset();
  obtenerCuentasGmail.mockReset().mockResolvedValue([]);
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

  it('"hola" con nombre pero sin completar → muestra Free/Pro y pasa a paso 1', async () => {
    const enviado = await enviarTexto({ id: 'u1', onboarding_paso: 0, nombre: 'Juan' }, 'hola');
    expect(usuariosChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ onboarding_paso: 1 })
    );
    expect(enviado).toMatch(/free/i);
    expect(enviado).toMatch(/pro/i);
  });

  it('texto libre de usuario nuevo (no comando) → pasa a paso 100', async () => {
    const enviado = await enviarTexto({ id: 'u1', onboarding_paso: 0 }, 'quiero registrar mis gastos');
    expect(usuariosChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ onboarding_paso: 100 })
    );
    expect(enviado).toMatch(/c[oó]mo te llamas/i);
  });

  it('"/manual" → activa Free, completa onboarding y captura evento', async () => {
    const enviado = await enviarTexto({ id: 'u1', onboarding_paso: 0 }, '/manual');
    expect(usuariosChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ plan: 'free', onboarding_paso: 0, onboarding_completado: true })
    );
    expect(capture).toHaveBeenCalledWith('u1', 'wa_onboarding_completed', { via: 'manual' });
    expect(enviado).toMatch(/free/i);
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

// ─── Paso 100: nombre ────────────────────────────────────────────────────────
describe('Onboarding paso 100 — nombre', () => {
  it('nombre valido → capitaliza, guarda y avanza a paso 101', async () => {
    const enviado = await enviarTexto({ id: 'u1', onboarding_paso: 100 }, 'juan carlos');
    expect(usuariosChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ nombre: 'Juan Carlos', onboarding_paso: 101 })
    );
    expect(enviado).toMatch(/correo/i);
  });

  it('extrae el nombre de "me llamo Ana"', async () => {
    await enviarTexto({ id: 'u1', onboarding_paso: 100 }, 'me llamo Ana');
    expect(usuariosChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ nombre: 'Ana', onboarding_paso: 101 })
    );
  });

  it('nombre solo numerico → rechaza y NO guarda', async () => {
    const enviado = await enviarTexto({ id: 'u1', onboarding_paso: 100 }, '12345');
    expect(usuariosChain.update).not.toHaveBeenCalled();
    expect(enviado).toMatch(/nombre real/i);
  });

  it('nombre demasiado corto → rechaza y NO guarda', async () => {
    const enviado = await enviarTexto({ id: 'u1', onboarding_paso: 100 }, 'A');
    expect(usuariosChain.update).not.toHaveBeenCalled();
    expect(enviado).toMatch(/nombre real/i);
  });
});

// ─── Paso 101: email unico ───────────────────────────────────────────────────
describe('Onboarding paso 101 — email unico', () => {
  it('rechaza el correo si ya esta registrado por otro usuario y NO lo guarda', async () => {
    usuariosChain = makeChain([{ id: 'user-otro' }]);
    const enviado = await enviarTexto({ id: 'user-1', onboarding_paso: 101, nombre: 'Juan' }, 'juan@gmail.com');
    expect(enviado).toMatch(/ya está registrado/i);
    expect(usuariosChain.update).not.toHaveBeenCalled();
  });

  it('guarda el correo y avanza a paso 1 cuando es unico', async () => {
    usuariosChain = makeChain([]);
    const enviado = await enviarTexto({ id: 'user-1', onboarding_paso: 101, nombre: 'Juan' }, 'juan@gmail.com');
    expect(usuariosChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'juan@gmail.com', onboarding_paso: 1 })
    );
    expect(enviado).toMatch(/elige tu plan/i);
  });

  it('si el índice único rechaza el correo (23505) responde amable y no revienta', async () => {
    usuariosChain = makeChain([], { updateResult: { error: { code: '23505' } } });
    const enviado = await enviarTexto({ id: 'user-1', onboarding_paso: 101, nombre: 'Juan' }, 'juan@gmail.com');
    expect(enviado).toMatch(/ya está registrado/i);
  });

  it('email invalido → reprompt y NO guarda', async () => {
    usuariosChain = makeChain([]);
    const enviado = await enviarTexto({ id: 'user-1', onboarding_paso: 101, nombre: 'Juan' }, 'no soy un correo');
    expect(usuariosChain.update).not.toHaveBeenCalled();
    expect(enviado).toMatch(/correo válido/i);
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
    expect(otherChains['gmail_cuentas'].update).toHaveBeenCalledWith({ activa: false });
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
    expect(otherChains['gmail_cuentas'].update).toHaveBeenCalledWith({ activa: false });
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
    expect(usuariosChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ onboarding_paso: 0, onboarding_completado: false, email: null })
    );
    expect(enviado).toMatch(/eliminad|limpia/i);
  });

  it('una cuenta, "1" → desconecta Gmail sin borrar datos', async () => {
    obtenerCuentasGmail.mockResolvedValue([{ id: 'g1', email: 'a@x.com' }]);
    const enviado = await enviarTexto({ id: 'u1', onboarding_paso: -1 }, '1');
    expect(otherChains['gmail_cuentas'].update).toHaveBeenCalledWith({ activa: false });
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
