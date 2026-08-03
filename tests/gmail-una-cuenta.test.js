import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'), '..');

/**
 * Un usuario, UNA cuenta de Gmail.
 *
 * No es una preferencia de producto: cada cuenta de Google distinta consume otro de los 100
 * cupos que Google da hasta CASA, el límite se cuenta sobre todo el ciclo de vida del proyecto
 * y NO se restablece. Permitir varias dejaba a un usuario quemando N cupos permanentes por un
 * solo pago de S/10, y cobrar por cuenta conectada se descartó por no complicar el modelo.
 *
 * El agujero era sutil y NO era el botón de la webapp: `guardarTokens` solo desactivaba las
 * cuentas anteriores cuando el modo era `'reemplazar'`. El modo por defecto —el que manda la
 * webapp— es `'inicial'`, y con ese el upsert dejaba viva la cuenta previa. O sea que el
 * límite no vivía en el servidor sino en que la UI escondiera el botón, y bastaba con volver
 * a llamar la API teniendo ya una cuenta conectada para acumular.
 *
 * Por eso la exclusividad se impone ahora SIN mirar el modo: el modo viaja dentro de un state
 * firmado que dura 7 días, así que un invariante que dependa de él depende de un enlace viejo.
 */

const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };

// Estado de la "base": las cuentas activas del usuario antes de la conexión nueva.
let cuentasActivas = [];
const escrituras = [];
const revocadasEnGoogle = [];

function tabla(nombre) {
  const q = {
    _filtros: {},
    select() { return q; },
    eq(col, val) { q._filtros[col] = val; return q; },
    order() { return q; },
    update(payload) { escrituras.push({ tabla: nombre, op: 'update', payload }); return q; },
    upsert(payload) { escrituras.push({ tabla: nombre, op: 'upsert', payload }); return Promise.resolve({ data: null, error: null }); },
    then(resolve) {
      const data = nombre === 'gmail_cuentas' && !q._filtros.id ? cuentasActivas : [];
      return Promise.resolve({ data, error: null }).then(resolve);
    },
  };
  return q;
}

const supabaseMock = { from: (nombre) => tabla(nombre) };

// gmail.js NO usa lib/db: tiene su propio `getSupabase()` que llama a `createClient` con las
// env vars. Mockear lib/db acá no sirve de nada y, peor, deja el módulo hablando con Supabase
// REAL (el runner carga el .env). Se intercepta el cliente en su origen.
const supaPath = require.resolve('@supabase/supabase-js', { paths: [projectRoot] });
require.cache[supaPath] = {
  id: supaPath, filename: supaPath, loaded: true,
  exports: { createClient: () => supabaseMock },
};

for (const [rel, exports] of [['lib/logger.js', logMock]]) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

process.env.GOOGLE_CLIENT_ID = 'test-client';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
// 32 bytes en hex: lo que pide getKey() para AES-256. Valor de prueba, nunca el real.
process.env.ENCRYPTION_KEY = 'a1'.repeat(32);

const gmail = require(path.join(projectRoot, 'gmail.js'));

// Se espía la revocación real en Google: lo que importa no es solo que la fila local quede
// inactiva, sino que el grant de la cuenta reemplazada se suelte de verdad.
gmail.oauth2Client.revokeToken = vi.fn(async (t) => { revocadasEnGoogle.push(t); });

const TOKENS = { access_token: 'at-nuevo', refresh_token: 'rt-nuevo', expiry_date: 1900000000000 };

const { encrypt } = require(path.join(projectRoot, 'lib', 'crypto.js'));

// Las filas reales llevan el refresh token CIFRADO, y es lo que `revocarAccesoGmail` usa para
// tumbar el grant. Un fixture con tokens en null haría pasar el test sin que se revoque nada.
function cuenta(id, email) {
  return { id, email, activa: true, access_token: encrypt('at-' + id), refresh_token: encrypt('rt-' + id) };
}

/** Todas las escrituras de desactivación sobre gmail_cuentas. */
function desactivaciones() {
  return escrituras.filter((e) => e.tabla === 'gmail_cuentas' && e.op === 'update' && e.payload.activa === false);
}

beforeEach(() => {
  escrituras.length = 0;
  revocadasEnGoogle.length = 0;
  cuentasActivas = [];
  gmail.oauth2Client.revokeToken.mockClear();
});

describe('guardarTokens impone una sola cuenta por usuario', () => {
  /**
   * El caso que estaba abierto. `'inicial'` es el modo por defecto y el que manda la webapp,
   * y antes NO desactivaba nada: la cuenta previa quedaba activa junto a la nueva.
   */
  it('conectar un correo distinto REEMPLAZA al anterior, no lo suma (modo inicial)', async () => {
    cuentasActivas = [cuenta('c-vieja', 'viejo@gmail.com')];
    await gmail.guardarTokens('u1', TOKENS, 'nuevo@gmail.com');
    expect(desactivaciones().length, 'la cuenta anterior quedó activa: el usuario acumula cupos').toBeGreaterThan(0);
  });

  // Desactivar la fila local no basta: el grant sigue vivo del lado de Google, o sea que
  // conservamos permiso de lectura sobre una bandeja que el usuario ya no usa con Neto.
  it('la cuenta reemplazada se revoca EN GOOGLE, no solo se marca inactiva', async () => {
    cuentasActivas = [cuenta('c-vieja', 'viejo@gmail.com')];
    await gmail.guardarTokens('u1', TOKENS, 'nuevo@gmail.com');
    expect(gmail.oauth2Client.revokeToken).toHaveBeenCalled();
  });

  /**
   * Reconectar la MISMA cuenta (el caso de `invalid_grant`) no puede revocar: sería el mismo
   * grant que Google acaba de emitir, así que la reconexión se auto-rompería. Y no hay cupo
   * nuevo en juego — es el mismo usuario de Google, ya contado.
   */
  it('reconectar el MISMO correo no revoca nada (sería tumbar el grant recién emitido)', async () => {
    cuentasActivas = [cuenta('c-vieja', 'mismo@gmail.com')];
    await gmail.guardarTokens('u1', TOKENS, 'mismo@gmail.com');
    expect(gmail.oauth2Client.revokeToken).not.toHaveBeenCalled();
    expect(desactivaciones()).toEqual([]);
  });

  it('la primera conexión no intenta revocar nada', async () => {
    cuentasActivas = [];
    await gmail.guardarTokens('u1', TOKENS, 'primero@gmail.com');
    expect(gmail.oauth2Client.revokeToken).not.toHaveBeenCalled();
  });

  /**
   * El orden importa y es fácil de romper: `revocarAccesoGmail` limpia
   * `usuarios.gmail_access_token` cuando revoca la última cuenta activa. Si eso corriera
   * DESPUÉS de guardar los tokens nuevos, borraría la conexión recién hecha y el usuario
   * quedaría conectado en `gmail_cuentas` pero desconectado en `usuarios`.
   */
  it('revoca ANTES de escribir los tokens nuevos en usuarios', async () => {
    cuentasActivas = [cuenta('c-vieja', 'viejo@gmail.com')];
    await gmail.guardarTokens('u1', TOKENS, 'nuevo@gmail.com');
    const iUsuarios = escrituras.findIndex((e) => e.tabla === 'usuarios' && e.payload.gmail_access_token);
    const iRevoca = escrituras.findIndex((e) => e.tabla === 'gmail_cuentas' && e.payload.activa === false);
    expect(iUsuarios, 'no se guardaron los tokens nuevos').toBeGreaterThan(-1);
    expect(iRevoca, 'no se revocó la anterior').toBeGreaterThan(-1);
    expect(iRevoca, 'la revocación corrió después y borró los tokens nuevos').toBeLessThan(iUsuarios);
  });

  // Un legacy con dos cuentas (nunca ocurrió en producción, pero la tabla lo permite)
  // converge a una sola en su próxima conexión en vez de quedarse a medias.
  it('un usuario legacy con dos cuentas queda con una sola', async () => {
    cuentasActivas = [cuenta('c1', 'uno@gmail.com'), cuenta('c2', 'dos@gmail.com')];
    await gmail.guardarTokens('u1', TOKENS, 'tres@gmail.com');
    expect(desactivaciones().length).toBeGreaterThanOrEqual(2);
  });
});

/**
 * El invariante no puede depender del `modo`: viaja dentro de un state firmado con 7 días de
 * vida, así que un enlace emitido con un modo viejo se canjea igual una semana después. Se
 * afirma sobre el código porque es una propiedad de la FIRMA de la función, no de una corrida.
 */
describe('la exclusividad no depende del modo', () => {
  const SRC = require('node:fs').readFileSync(path.join(projectRoot, 'gmail.js'), 'utf-8');
  const CUERPO = SRC.slice(SRC.indexOf('async function guardarTokens'), SRC.indexOf('async function obtenerCuentasGmail'));

  it('guardarTokens ya no recibe ni mira el modo', () => {
    expect(CUERPO).toMatch(/async function guardarTokens\(usuarioId, tokens, email\)/);
    expect(CUERPO, 'volvió a ramificar por modo: un enlace de 7 días vuelve a decidir el invariante')
      .not.toMatch(/\bmodo\b/);
  });

  it('el callback tampoco se lo pasa', () => {
    const CALLBACK = require('node:fs').readFileSync(path.join(projectRoot, 'routes', 'public.js'), 'utf-8');
    expect(CALLBACK).toMatch(/guardarTokens\(usuario\.id, tokens, emailConectado\)/);
  });
});
