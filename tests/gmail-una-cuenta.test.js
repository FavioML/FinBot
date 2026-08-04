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

/**
 * Una cuenta por usuario **para siempre**, no "una a la vez".
 *
 * Reemplazar por un correo distinto también gasta un cupo nuevo y permanente, así que alguien
 * podría reconectar con N correos y quemar N cupos pagando uno solo. Decisión de Favio
 * (2026-08-03): un usuario, un correo, punto. Cambiar de correo se resuelve por soporte.
 *
 * Dónde vive cada defensa, y por qué hacen falta las dos:
 *  · `login_hint` en la EMISIÓN — la única que evita el gasto, porque el cupo se consume
 *    cuando el usuario aprueba en la pantalla de Google, antes de nuestro callback.
 *  · rechazo en el CANJE — la que garantiza el invariante. No des-quema el cupo (ya se gastó),
 *    pero impide que el usuario termine con dos cuentas y suelta el permiso en el acto.
 */
describe('un usuario no puede vincular un segundo correo', () => {
  const CALLBACK = require('node:fs').readFileSync(path.join(projectRoot, 'routes', 'public.js'), 'utf-8');
  const PRO = require('node:fs').readFileSync(path.join(projectRoot, 'routes', 'pro.js'), 'utf-8');
  const GMAIL = require('node:fs').readFileSync(path.join(projectRoot, 'gmail.js'), 'utf-8');

  it('el canje compara contra el correo ya vinculado ANTES de guardar', () => {
    const iCheck = CALLBACK.indexOf('emailGmailVinculado(');
    const iGuarda = CALLBACK.indexOf('guardarTokens(usuario.id');
    expect(iCheck, 'el callback no consulta el correo vinculado: un segundo correo entraría').toBeGreaterThan(-1);
    expect(iGuarda).toBeGreaterThan(-1);
    expect(iCheck, 'la comparación corre después de guardar: ya sería tarde').toBeLessThan(iGuarda);
  });

  // Quedarnos con el grant de una cuenta que rechazamos sería lo peor de los dos mundos:
  // el cupo gastado Y permiso de lectura vivo sobre un buzón que no vamos a usar.
  it('el canje rechazado revoca el grant recién otorgado', () => {
    const bloque = CALLBACK.slice(CALLBACK.indexOf('emailPrevio !== emailConectado'), CALLBACK.indexOf('guardarTokens(usuario.id'));
    expect(bloque).toMatch(/revokeToken\s*\(/);
  });

  // Mirar solo las cuentas ACTIVAS dejaría pasar el caso que más importa: quien revocó (o a
  // quien le revocaron por dejar de pagar) ya gastó su cupo, y volver con otro correo gastaría
  // un segundo. El historial es lo que decide.
  it('el correo vinculado se busca en el historial, no solo entre las activas', () => {
    const inicio = GMAIL.indexOf('async function emailGmailVinculado');
    // Sin esta guarda el assert de abajo pasa por VACUIDAD si la función se renombra o se
    // borra: `indexOf` daría -1, el slice quedaría vacío y "no contiene activa" sería cierto.
    expect(inicio, 'emailGmailVinculado ya no existe: este test dejó de mirar nada').toBeGreaterThan(-1);
    const fn = GMAIL.slice(inicio);
    const cuerpo = fn.slice(0, fn.indexOf('\n}'));
    expect(cuerpo.length, 'no se pudo aislar el cuerpo de la función').toBeGreaterThan(50);
    expect(cuerpo, 'filtra por activa: una cuenta revocada volvería a permitir un correo nuevo')
      .not.toMatch(/activa/);
  });

  it('la emisión manda login_hint para que Google preseleccione la cuenta vinculada', () => {
    expect(PRO).toMatch(/emailGmailVinculado\(/);
    expect(GMAIL).toMatch(/login_hint/);
  });
});

/**
 * Hallazgo M12 de la auditoría CTO (2026-08-04): `PLAN_CONFIG.premium.maxGmailAccounts`
 * decía `Infinity`, o sea lo contrario exacto de la regla que el producto aplica.
 *
 * No era explotable —nadie lo lee como límite: el único consumidor
 * (`handlers/intents/consultas.js`) compara `=== 0` para preguntar "¿tiene Pro?"— y por eso
 * mismo era peligroso: una constante que describe la política, que nadie ejecuta y que
 * afirma lo contrario de lo que hacen `guardarTokens` y el canje. El primero que la lea
 * buscando el límite va a creerle a ella.
 *
 * El número queda como DESCRIPCIÓN. El control sigue arriba, en los tests de este archivo.
 */
describe('la constante del plan no contradice la regla', () => {
  const { PLAN_CONFIG } = require('../lib/constants');

  it('premium declara UNA cuenta, no ilimitadas', () => {
    expect(PLAN_CONFIG.premium.maxGmailAccounts).toBe(1);
  });

  it('free declara cero (es el proxy de "¿tiene Pro?" que consultas.js consulta)', () => {
    expect(PLAN_CONFIG.free.maxGmailAccounts).toBe(0);
  });

  // Que ahora sea un número plausible abre un riesgo nuevo: que alguien lo tome por el gate
  // y escriba un segundo control con él. Dos controles del mismo invariante es cómo se
  // desincronizan — y con `Infinity` daba igual, porque `checkProLimit` cortocircuita ahí:
  // con `1` un premium que ya tiene su cuenta pasaría a `blocked`, o sea que cablearlo
  // AHORA sí cambia comportamiento.
  //
  // El barrido es sobre TODO el código de runtime, no sobre una lista blanca: la versión
  // anterior de este guard enumeraba cuatro archivos y omitía justo el único que lee la
  // constante (`handlers/intents/consultas.js`), así que habría pasado verde con el
  // consumidor real sin mirar.
  it('la constante solo se declara y se compara con 0: nadie la usa como límite', () => {
    const fs = require('node:fs');
    const IGNORAR = /^(node_modules|tests|docs|qa-e2e|webapp|scripts|\.git|out|coverage)$/;
    const archivos = [];
    (function barrer(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) { if (!IGNORAR.test(e.name)) barrer(path.join(dir, e.name)); continue; }
        if (/\.(js|cjs|mjs)$/.test(e.name)) archivos.push(path.join(dir, e.name));
      }
    })(projectRoot);

    // Antivacuidad: si el barrido se rompe, esto cae antes que el assert de abajo.
    expect(archivos.length, 'el barrido de archivos no encontró runtime').toBeGreaterThan(50);

    const usos = archivos
      .filter((abs) => /maxGmailAccounts/.test(fs.readFileSync(abs, 'utf-8')))
      .map((abs) => path.relative(projectRoot, abs).split(path.sep).join('/'));

    // Contraprueba de que el barrido SÍ encuentra lo que existe: los dos legítimos.
    expect(usos, 'el barrido no ve ni la declaración: está mirando el árbol equivocado')
      .toContain('lib/constants.js');
    expect(usos).toContain('handlers/intents/consultas.js');
    expect(usos.sort()).toEqual(['handlers/intents/consultas.js', 'lib/constants.js']);
  });

  // El consumidor legítimo pregunta "¿tiene Pro?" (=== 0), no "¿cuántas cuentas tiene?".
  it('el único consumidor la compara con 0, no contra un conteo', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(path.join(projectRoot, 'handlers/intents/consultas.js'), 'utf-8');
    expect(src).toMatch(/maxGmailAccounts\s*===\s*0/);
    expect(src, 'apareció una comparación contra un conteo de cuentas')
      .not.toMatch(/(length|cuentas)[^\n]*maxGmailAccounts|maxGmailAccounts[^\n]*(length|cuentas)/);
  });
});
