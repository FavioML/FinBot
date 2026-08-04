import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'), '..');

// La RAMA DE ERROR de guardarTokens (auditoría 2026-08-03, hallazgo B5). El fix hizo que las
// tres operaciones lean su `{error}`, pero la verificación de ese día no la ejercitó: los
// tests existentes solo cubrían el camino feliz. Este archivo la cubre.
//
// Por qué importa: supabase-js NO lanza. Sin leer el error,
//  (a) el select de cuentas previas devuelve data=null → el loop de revocación no corre →
//      el upsert deja DOS cuentas activas. Y la regla "una cuenta por usuario" NO vive en la
//      DB (el índice único es (usuario_id,email)), así que nada la repara después.
//  (b) el update/upsert fallan en silencio → el callback redirige feliz y la app dice
//      "Gmail conectado" sobre una fila que no se escribió.
//
// La propiedad que se afirma no es solo "lanza": es que **no escribe** cuando no pudo leer.

const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };

const ERROR_RED = { message: 'network unreachable', code: '500' };

// Qué operación debe fallar en esta corrida: {tabla, op} o null.
let fallo = null;
const escrituras = [];

function resultado(tabla, op) {
  if (fallo && fallo.tabla === tabla && fallo.op === op) return { data: null, error: ERROR_RED };
  if (op === 'select') return { data: [], error: null };   // sin cuentas previas
  return { data: null, error: null };
}

function tablaMock(nombre) {
  const q = {
    _op: null,
    select() { q._op = 'select'; return q; },
    eq() { return q; },
    order() { return q; },
    update(payload) { q._op = 'update'; escrituras.push({ tabla: nombre, op: 'update', payload }); return q; },
    upsert(payload) {
      escrituras.push({ tabla: nombre, op: 'upsert', payload });
      return Promise.resolve(resultado(nombre, 'upsert'));
    },
    then(resolve, reject) { return Promise.resolve(resultado(nombre, q._op)).then(resolve, reject); },
  };
  return q;
}

const supabaseMock = { from: (nombre) => tablaMock(nombre) };

// gmail.js tiene su propio getSupabase() con createClient; interceptarlo en el origen es la
// única forma de que el módulo no hable con la Supabase REAL (el runner carga el .env).
const supaPath = require.resolve('@supabase/supabase-js', { paths: [projectRoot] });
require.cache[supaPath] = {
  id: supaPath, filename: supaPath, loaded: true,
  exports: { createClient: () => supabaseMock },
};
const logPath = require.resolve(path.join(projectRoot, 'lib/logger.js'));
require.cache[logPath] = { id: logPath, filename: logPath, loaded: true, exports: logMock };

process.env.GOOGLE_CLIENT_ID = 'test-client';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
process.env.ENCRYPTION_KEY = 'a1'.repeat(32);

const gmail = require(path.join(projectRoot, 'gmail.js'));

const TOKENS = { access_token: 'at', refresh_token: 'rt', expiry_date: 1900000000000 };
const upserts = () => escrituras.filter((e) => e.op === 'upsert');

beforeEach(() => {
  fallo = null;
  escrituras.length = 0;
  logMock.error.mockClear();
});

describe('guardarTokens: una lectura fallida no puede pasar por "no había cuentas"', () => {
  it('lanza cuando el select de cuentas previas falla', async () => {
    fallo = { tabla: 'gmail_cuentas', op: 'select' };
    await expect(gmail.guardarTokens('u1', TOKENS, 'nuevo@gmail.com')).rejects.toThrow(/cuentas previas/i);
  });

  // La propiedad que de verdad protege el invariante: si no sabemos qué había, NO escribimos.
  // Sin esto, el upsert agregaría la cuenta nueva junto a una previa que nunca se revocó.
  it('y NO escribe la cuenta nueva (si no sabe qué había, no suma una segunda)', async () => {
    fallo = { tabla: 'gmail_cuentas', op: 'select' };
    await expect(gmail.guardarTokens('u1', TOKENS, 'nuevo@gmail.com')).rejects.toThrow();
    expect(upserts()).toHaveLength(0);
  });

  it('lanza cuando el update de usuarios falla (tokens legacy sin sincronizar)', async () => {
    fallo = { tabla: 'usuarios', op: 'update' };
    await expect(gmail.guardarTokens('u1', TOKENS, 'nuevo@gmail.com')).rejects.toThrow(/usuarios/i);
    expect(upserts()).toHaveLength(0);
  });

  it('lanza cuando el upsert de la cuenta falla (no puede decir "conectado" sin fila)', async () => {
    fallo = { tabla: 'gmail_cuentas', op: 'upsert' };
    await expect(gmail.guardarTokens('u1', TOKENS, 'nuevo@gmail.com')).rejects.toThrow(/guardar la cuenta/i);
  });
});

describe('antivacuidad: el camino feliz sigue escribiendo', () => {
  it('sin fallos, guarda la cuenta y no lanza', async () => {
    await expect(gmail.guardarTokens('u1', TOKENS, 'nuevo@gmail.com')).resolves.toBeUndefined();
    const up = upserts();
    expect(up).toHaveLength(1);
    expect(up[0].payload.email).toBe('nuevo@gmail.com');
    expect(up[0].payload.activa).toBe(true);
    // Toda conexión exitosa limpia la marca de auth caída (migr 058).
    expect(up[0].payload.auth_error_at).toBe(null);
  });

  it('sin email no toca gmail_cuentas (rama legacy), y tampoco lanza', async () => {
    await expect(gmail.guardarTokens('u1', TOKENS, null)).resolves.toBeUndefined();
    expect(upserts()).toHaveLength(0);
  });
});
