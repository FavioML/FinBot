import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

/**
 * "Conectado" y "conectado pero muerto" tienen que ser distinguibles DESPUÉS de un redeploy.
 *
 * Cuando Google revoca el refresh token, el barrido avisaba y seguía: la fila quedaba en
 * `activa = true` y el único rastro vivía en un `Map` en memoria (`authErrorNotifiedAt`), que
 * un redeploy borra. La app le afirmaba "Gmail conectado ✓" a alguien cuya ingesta automática
 * llevaba días rota.
 *
 * El sello va en `configurarClienteParaCuenta` y no en el barrido a propósito: es el único
 * punto que sabe QUÉ fila falló (más arriba, `leerCorreosBancarios` colapsa N cuentas en un
 * flag y `escanearGmailYRegistrar` devuelve `{authError:true}` pelado), y así marcan los tres
 * caminos que producen el error, no solo el barrido automático.
 */

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'), '..');

const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };

// --- Estado de la "base" ---
let cuentasActivas = [];
const escrituras = [];

/**
 * Query builder mínimo. Registra payload Y filtros: el sello depende de `.is('auth_error_at',
 * null)` para escribir una sola vez, y un mock que solo mirara el payload lo daría por bueno
 * aunque el filtro se hubiera caído.
 */
function tabla(nombre) {
  const q = {
    _filtros: {},
    _op: null,
    _payload: null,
    select() { return q; },
    eq(col, val) { q._filtros[col] = val; return q; },
    is(col, val) { q._filtros['is:' + col] = val; return q; },
    order() { return q; },
    limit() { return q; },
    update(payload) {
      q._op = 'update'; q._payload = payload;
      escrituras.push({ tabla: nombre, op: 'update', payload, filtros: q._filtros });
      return q;
    },
    upsert(payload) {
      escrituras.push({ tabla: nombre, op: 'upsert', payload, filtros: q._filtros });
      return Promise.resolve({ data: null, error: null });
    },
    single() {
      // Solo lo usa remitentesParaUsuario (bancos_seleccionados).
      return Promise.resolve({ data: { bancos_seleccionados: null }, error: null });
    },
    then(resolve) {
      const data = nombre === 'gmail_cuentas' && q._op !== 'update' ? cuentasActivas : [];
      return Promise.resolve({ data, error: null }).then(resolve);
    },
  };
  return q;
}

// gmail.js NO usa lib/db: arma su propio cliente con createClient desde env. Mockear lib/db
// lo dejaría hablando con Supabase de PRODUCCIÓN. Se intercepta el cliente en su origen.
const supaPath = require.resolve('@supabase/supabase-js', { paths: [projectRoot] });
require.cache[supaPath] = {
  id: supaPath, filename: supaPath, loaded: true,
  exports: { createClient: () => ({ from: (nombre) => tabla(nombre) }) },
};

// Y googleapis: el `invalid_grant` tiene que ser determinista y sin red. Un OAuth2 real con
// credenciales de prueba fallaría con lo que Google conteste ese día, que puede no matchear
// la detección de auth permanente — el test pasaría o no según la red.
let refreshFalla = true;
const refreshCalls = [];
class OAuth2Fake {
  constructor() { this.credentials = {}; }
  setCredentials(c) { this.credentials = c; }
  generateAuthUrl() { return 'https://accounts.google.com/fake'; }
  async revokeToken() {}
  async getToken() { return { tokens: {} }; }
  async refreshAccessToken() {
    refreshCalls.push(this.credentials);
    if (refreshFalla) throw new Error('invalid_grant: Token has been expired or revoked.');
    return { credentials: { access_token: 'at-refrescado', expiry_date: Date.now() + 3600000 } };
  }
}
const googlePath = require.resolve('googleapis', { paths: [projectRoot] });
require.cache[googlePath] = {
  id: googlePath, filename: googlePath, loaded: true,
  exports: { google: { auth: { OAuth2: OAuth2Fake }, gmail: () => ({}), oauth2: () => ({}) } },
};

for (const [rel, exports] of [['lib/logger.js', logMock]]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

process.env.GOOGLE_CLIENT_ID = 'test-client';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
process.env.ENCRYPTION_KEY = 'a1'.repeat(32);

const gmail = require(path.join(projectRoot, 'gmail.js'));
const { encrypt } = require(path.join(projectRoot, 'lib', 'crypto.js'));

/** Una cuenta con el token ya vencido, que es lo que dispara el refresh. */
function cuentaVencida(id, email) {
  return {
    id,
    usuario_id: 'u1',
    email,
    activa: true,
    access_token: encrypt('at-' + id),
    refresh_token: encrypt('rt-' + id),
    token_expiry: Date.now() - 60_000,
    auth_error_at: null,
  };
}

/** Los updates de `auth_error_at` sobre gmail_cuentas. */
function sellos() {
  return escrituras.filter(
    (e) => e.tabla === 'gmail_cuentas' && e.op === 'update' && 'auth_error_at' in e.payload,
  );
}

beforeEach(() => {
  escrituras.length = 0;
  refreshCalls.length = 0;
  cuentasActivas = [];
  refreshFalla = true;
});

describe('el token muerto queda sellado en la fila, no solo en un log', () => {
  it('un invalid_grant escribe auth_error_at en la cuenta que falló', async () => {
    cuentasActivas = [cuentaVencida('c1', 'roto@gmail.com')];

    await gmail.leerCorreosBancarios('u1');

    const s = sellos();
    expect(s.length, 'nadie marcó la fila: el estado roto muere con el proceso').toBe(1);
    expect(s[0].payload.auth_error_at, 'se selló en null: eso es "sana", no "caída"').toBeTruthy();
    expect(s[0].filtros.usuario_id).toBe('u1');
    expect(s[0].filtros.email, 'el sello no está fijado a la cuenta que falló').toBe('roto@gmail.com');
  });

  it('el sello es condicional a auth_error_at is null: registra CUÁNDO se rompió', async () => {
    // Sin el `.is()`, cada barrido reescribiría la marca y "desde el 3 de agosto" pasaría a
    // decir "desde hace 30 minutos" para siempre.
    cuentasActivas = [cuentaVencida('c1', 'roto@gmail.com')];

    await gmail.leerCorreosBancarios('u1');

    expect(sellos()[0].filtros).toHaveProperty('is:auth_error_at', null);
  });

  it('AUTH_EXPIRED se sigue propagando: el sello no puede tragarse el error', async () => {
    cuentasActivas = [cuentaVencida('c1', 'roto@gmail.com')];

    const res = await gmail.leerCorreosBancarios('u1');

    expect(res.error).toBe('AUTH_EXPIRED');
  });

  it('un refresh que funciona no marca nada', async () => {
    // El contra-caso: sin esto, un sello incondicional daría por rota toda cuenta que
    // simplemente necesitaba refrescar el token, que es la operación normal cada hora.
    refreshFalla = false;
    cuentasActivas = [cuentaVencida('c1', 'sana@gmail.com')];

    await gmail.leerCorreosBancarios('u1');

    expect(refreshCalls.length, 'no se intentó refrescar: el test no probó nada').toBe(1);
    expect(sellos()).toEqual([]);
  });
});

describe('reconectar limpia la marca', () => {
  it('guardarTokens escribe auth_error_at en null en el mismo upsert', async () => {
    await gmail.guardarTokens('u1', { access_token: 'at', refresh_token: 'rt', expiry_date: 1900000000000 }, 'x@gmail.com');

    const upsert = escrituras.find((e) => e.tabla === 'gmail_cuentas' && e.op === 'upsert');
    expect(upsert, 'no se hizo el upsert de la cuenta').toBeTruthy();
    // `in` y no `=== null`: una clave ausente también es `undefined === null ? false`, pero
    // sobre todo NO limpia la columna en Postgres — la fila reconectada seguiría marcada como
    // rota. El assert tiene que distinguir "mandó null" de "no mandó nada".
    expect(upsert.payload, 'el upsert no limpia la marca: reconectar dejaría la cuenta en "caída"')
      .toHaveProperty('auth_error_at', null);
    expect('auth_error_at' in upsert.payload).toBe(true);
  });

  it('la limpieza va en el upsert y no en una escritura aparte', async () => {
    // Si fuera un update separado existiría un instante en que la cuenta está reconectada y la
    // app la sigue dando por rota — y si ese update falla, se queda así.
    await gmail.guardarTokens('u1', { access_token: 'at', refresh_token: 'rt', expiry_date: 1900000000000 }, 'x@gmail.com');

    expect(sellos(), 'apareció un update suelto de auth_error_at').toEqual([]);
  });
});
