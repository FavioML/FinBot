import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(import.meta.url);

// ─── Setup: parchar singletons ANTES de requerir el webhook ──────────────────
// webhook.js destructura enviarWhatsapp y obtenerOCrearUsuario al cargar
// (const { x } = require(...)). Para interceptarlos hay que reemplazar la
// propiedad en el modulo ANTES de requerir webhook, para que la destructuracion
// capture nuestro spy. supabase se destructura como objeto → mutar sus metodos
// alcanza porque webhook mantiene la misma referencia.

process.env.META_APP_SECRET = 'test-secret';

const enviarWhatsapp = vi.fn().mockResolvedValue(undefined);
require('../../lib/whatsapp').enviarWhatsapp = enviarWhatsapp;

const obtenerOCrearUsuario = vi.fn();
require('../../helpers/db-helpers').obtenerOCrearUsuario = obtenerOCrearUsuario;

// Mock de Supabase controlable por test. Una cadena por tabla; los metodos de
// filtrado retornan la misma cadena; await → { data }. update() retorna una
// subcadena propia para poder simular un resultado distinto (ej. 23505).
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
db.supabase.from = vi.fn((table) => {
  if (table === 'usuarios') return usuariosChain;
  return makeChain([]);
});

const createWebhookHandler = require('../../handlers/webhook');
const webhookHandler = createWebhookHandler(vi.fn());

// ─── Helper: construir req firmado + res ─────────────────────────────────────
function buildReqRes(from, texto) {
  const body = {
    entry: [{
      changes: [{
        value: { messages: [{ from, id: 'wamid-' + Math.random().toString(36).slice(2), type: 'text', text: { body: texto } }] }
      }]
    }]
  };
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = 'sha256=' + crypto.createHmac('sha256', 'test-secret').update(rawBody).digest('hex');
  const req = { headers: { 'x-hub-signature-256': signature }, rawBody, body };
  const res = { sendStatus: vi.fn() };
  return { req, res };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Onboarding paso 101 — email unico', () => {
  beforeEach(() => {
    enviarWhatsapp.mockClear();
    obtenerOCrearUsuario.mockReset();
  });

  it('rechaza el correo si ya esta registrado por otro usuario y NO lo guarda', async () => {
    obtenerOCrearUsuario.mockResolvedValue({ id: 'user-1', onboarding_paso: 101, nombre: 'Juan' });
    // Otro usuario ya tiene ese email
    usuariosChain = makeChain([{ id: 'user-otro' }]);

    const { req, res } = buildReqRes('51999000111', 'juan@gmail.com');
    await webhookHandler(req, res);

    const enviado = enviarWhatsapp.mock.calls[0][1];
    expect(enviado).toMatch(/ya está registrado/i);
    // No debe guardar: update nunca se llamo
    expect(usuariosChain.update).not.toHaveBeenCalled();
  });

  it('guarda el correo y avanza a paso 1 cuando es unico', async () => {
    obtenerOCrearUsuario.mockResolvedValue({ id: 'user-1', onboarding_paso: 101, nombre: 'Juan' });
    // Nadie mas tiene ese email
    usuariosChain = makeChain([]);

    const { req, res } = buildReqRes('51999000111', 'juan@gmail.com');
    await webhookHandler(req, res);

    expect(usuariosChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'juan@gmail.com', onboarding_paso: 1 })
    );
    const enviado = enviarWhatsapp.mock.calls[0][1];
    expect(enviado).toMatch(/elige tu plan/i);
  });

  it('si el índice único rechaza el correo (23505) responde amable y no revienta', async () => {
    obtenerOCrearUsuario.mockResolvedValue({ id: 'user-1', onboarding_paso: 101, nombre: 'Juan' });
    // Pasa el chequeo app-level (select vacío) pero el UPDATE choca con el índice
    // único (carrera: otro insertó el mismo correo en el intermedio).
    usuariosChain = makeChain([], { updateResult: { error: { code: '23505' } } });

    const { req, res } = buildReqRes('51999000111', 'juan@gmail.com');
    await webhookHandler(req, res);

    const enviado = enviarWhatsapp.mock.calls[0][1];
    expect(enviado).toMatch(/ya está registrado/i);
  });
});
