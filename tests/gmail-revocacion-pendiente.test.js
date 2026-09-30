import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'), '..');

/**
 * Una revocación que Google no confirma tiene que poder reintentarse.
 *
 * El comentario de `revocarAccesoGmail` prometía "si la revocación falla, se limpia local igual
 * — la próxima corrida de checkGmailHuerfanos lo reintenta". No era cierto (revisión adversarial
 * del 30-sep-2026): ante un 503 de Google o un token que no se pudo descifrar, la fila quedaba
 * `activa=false` con los tokens en null. `checkGmailHuerfanos` solo mira `activa=true`, y aunque
 * mirara más no quedaba con qué revocar: el grant seguía vivo en Google, para siempre, sobre la
 * bandeja de alguien que no paga.
 *
 * El marcador de "pendiente" es un estado que antes no existía y no necesita columna nueva:
 *   - `gmail_cuentas`: `activa=false` con `refresh_token` puesto.
 *   - legacy (`usuarios`): `gmail_refresh_token` puesto con `gmail_access_token` en null.
 * Medido el 30-sep-2026: 0 filas en cualquiera de los dos estados, así que nada existente se lee
 * como pendiente por error.
 *
 * Y el caso legacy: quien solo tenía los tokens en `usuarios` (sin fila en `gmail_cuentas`,
 * lo produce un canje donde `obtenerPerfilGoogle` no devolvió el correo) no lo revocaba nadie.
 */

const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };

// ── Una base en memoria que aplica los filtros de verdad ─────────────────────
// Con estado a propósito: el hallazgo es sobre lo que QUEDA escrito y sobre lo que la corrida
// siguiente puede encontrar. Un doble que devuelve lo mismo mire lo que mire no distingue "la
// fila quedó pendiente" de "la fila quedó limpia".
let db;
/** `{ 'usuarios:select': 'boom' }` hace fallar esa operación sobre esa tabla. */
let fallas = {};

function consulta(tabla) {
  const filtros = [];
  let op = 'select';
  let patch = null;
  const q = {
    select() { return q; },
    order() { return q; },
    eq(col, val) { filtros.push((f) => f[col] === val); return q; },
    is(col, val) { filtros.push((f) => (val === null ? f[col] == null : f[col] === val)); return q; },
    not(col, operador, val) {
      if (operador !== 'is' || val !== null) throw new Error('filtro no soportado por el doble: ' + operador);
      filtros.push((f) => f[col] != null);
      return q;
    },
    update(p) { op = 'update'; patch = p; return q; },
    maybeSingle() { return ejecutar().then((r) => ({ data: (r.data || [])[0] || null, error: r.error })); },
    then(resolve, reject) { return ejecutar().then(resolve, reject); },
  };
  function ejecutar() {
    // supabase-js no lanza: devuelve `{ error }`. Sin poder inyectarlo, ninguna rama de error
    // de gmail.js se prueba (revisión adversarial: cuatro mutaciones en esas ramas salían verdes).
    const falla = fallas[tabla + ':' + op];
    if (falla) return Promise.resolve({ data: null, error: { message: falla } });
    const filas = db[tabla].filter((f) => filtros.every((p) => p(f)));
    if (op === 'update') filas.forEach((f) => Object.assign(f, patch));
    return Promise.resolve({ data: filas.map((f) => ({ ...f })), error: null });
  }
  return q;
}

const supabaseMock = { from: (t) => consulta(t) };

// gmail.js arma su propio cliente con `createClient`: mockear lib/db lo deja hablando con
// Supabase REAL. Se intercepta el cliente en su origen.
const supaPath = require.resolve('@supabase/supabase-js', { paths: [projectRoot] });
require.cache[supaPath] = { id: supaPath, filename: supaPath, loaded: true, exports: { createClient: () => supabaseMock } };
const logPath = require.resolve(path.join(projectRoot, 'lib/logger.js'));
require.cache[logPath] = { id: logPath, filename: logPath, loaded: true, exports: logMock };

process.env.GOOGLE_CLIENT_ID = 'test-client';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
// 32 bytes en hex: lo que pide getKey() para AES-256. Valor de prueba, nunca el real.
const KEY_PRUEBA = 'b2'.repeat(32);
process.env.ENCRYPTION_KEY = KEY_PRUEBA;

const gmail = require(path.join(projectRoot, 'gmail.js'));
const { encrypt } = require(path.join(projectRoot, 'lib', 'crypto.js'));

// Google, por test: qué tokens se le mandaron y cómo responde.
const enGoogle = [];
let respuestaGoogle;
gmail.oauth2Client.revokeToken = vi.fn(async (t) => { enGoogle.push(t); return respuestaGoogle(t); });
const ok = async () => ({ status: 200 });
const caido = async () => { throw new Error('Request failed with status code 503'); };
const yaMuerto = async () => { throw new Error('invalid_token'); };

function filaGmail(id, usuarioId, { activa = true } = {}) {
  return {
    id, usuario_id: usuarioId, email: id + '@gmail.com', activa,
    access_token: encrypt('at-' + id), refresh_token: encrypt('rt-' + id), token_expiry: 1900000000000,
  };
}
function usuario(id, extra = {}) {
  return { id, plan: 'free', trial_estado: 'convertido', gmail_access_token: null, gmail_refresh_token: null, gmail_token_expiry: null, ...extra };
}
const fila = (id) => db.gmail_cuentas.find((f) => f.id === id);
const user = (id) => db.usuarios.find((u) => u.id === id);

beforeEach(() => {
  db = { gmail_cuentas: [], usuarios: [] };
  fallas = {};
  enGoogle.length = 0;
  respuestaGoogle = ok;
  gmail.oauth2Client.revokeToken.mockClear();
  Object.values(logMock).forEach((f) => f.mockClear());
  process.env.ENCRYPTION_KEY = KEY_PRUEBA;
});

describe('revocarAccesoGmail: un fallo en Google deja la fila reintentable', () => {
  it('Google caído → la fila sale de la lectura pero CONSERVA el refresh token', async () => {
    db.usuarios.push(usuario('u1'));
    db.gmail_cuentas.push(filaGmail('g1', 'u1'));
    respuestaGoogle = caido;

    const r = await gmail.revocarAccesoGmail('u1', { motivo: 'premium_vencido' });

    expect(fila('g1').activa, 'la lectura tiene que cortarse igual').toBe(false);
    expect(fila('g1').refresh_token, 'sin el refresh token no hay con qué reintentar: el grant queda vivo para siempre').not.toBeNull();
    expect(fila('g1').access_token).toBeNull();
    expect(r.pendientes).toBe(1);
  });

  it('el token que no se pudo descifrar también queda pendiente (la clave se arregla, el grant no se va solo)', async () => {
    db.usuarios.push(usuario('u1'));
    db.gmail_cuentas.push(filaGmail('g1', 'u1'));
    // Una ENCRYPTION_KEY de otro largo hace que `decrypt` lance: es el caso de una variable mal
    // cargada en un deploy, que se corrige después. Borrar el token ahí es irreversible.
    process.env.ENCRYPTION_KEY = 'c3'.repeat(16);

    const r = await gmail.revocarAccesoGmail('u1', { motivo: 'premium_vencido' });

    expect(gmail.oauth2Client.revokeToken).not.toHaveBeenCalled();
    expect(fila('g1').activa).toBe(false);
    expect(fila('g1').refresh_token).not.toBeNull();
    expect(r.pendientes).toBe(1);
  });

  it('revocación confirmada → tokens en null y nada pendiente (el comportamiento de siempre)', async () => {
    db.usuarios.push(usuario('u1'));
    db.gmail_cuentas.push(filaGmail('g1', 'u1'));

    const r = await gmail.revocarAccesoGmail('u1', { motivo: 'premium_vencido' });

    expect(enGoogle).toEqual(['rt-g1']);
    expect(fila('g1')).toMatchObject({ activa: false, access_token: null, refresh_token: null });
    expect(r).toMatchObject({ revocadas: 1, pendientes: 0 });
  });

  it('invalid_token NO es un fallo: el grant ya no existía, que es el destino', async () => {
    db.usuarios.push(usuario('u1'));
    db.gmail_cuentas.push(filaGmail('g1', 'u1'));
    respuestaGoogle = yaMuerto;

    const r = await gmail.revocarAccesoGmail('u1', { motivo: 'premium_vencido' });

    expect(fila('g1').refresh_token).toBeNull();
    expect(r.pendientes).toBe(0);
  });

  // Con `cuentaId` se revoca UNA. La otra sigue leyendo y no puede perder nada.
  it('desconectar una cuenta no toca a la otra, falle o no Google', async () => {
    db.usuarios.push(usuario('u1', { plan: 'premium' }));
    db.gmail_cuentas.push(filaGmail('g1', 'u1'), filaGmail('g2', 'u1'));
    respuestaGoogle = caido;

    await gmail.revocarAccesoGmail('u1', { motivo: 'usuario_desconecto_una', cuentaId: 'g1' });

    expect(enGoogle).toEqual(['rt-g1']);
    expect(fila('g2')).toMatchObject({ activa: true });
    expect(fila('g2').access_token).not.toBeNull();
  });
});

describe('reintentarRevocacionesPendientes: la corrida siguiente de verdad reintenta', () => {
  it('la fila que Google no confirmó se revoca en la corrida siguiente y queda limpia', async () => {
    db.usuarios.push(usuario('u1'));
    db.gmail_cuentas.push(filaGmail('g1', 'u1'));
    respuestaGoogle = caido;
    await gmail.revocarAccesoGmail('u1', { motivo: 'premium_vencido' });

    respuestaGoogle = ok;
    enGoogle.length = 0;
    const r = await gmail.reintentarRevocacionesPendientes();

    expect(enGoogle, 'el barrido no le volvió a pedir a Google que suelte el grant').toEqual(['rt-g1']);
    expect(fila('g1').refresh_token).toBeNull();
    expect(r).toMatchObject({ soltadas: 1, siguenPendientes: 0 });
  });

  it('si Google sigue caído, la fila sigue pendiente (y se registra como error)', async () => {
    db.gmail_cuentas.push({ ...filaGmail('g1', 'u1'), activa: false, access_token: null });
    respuestaGoogle = caido;

    const r = await gmail.reintentarRevocacionesPendientes();

    expect(fila('g1').refresh_token).not.toBeNull();
    expect(r).toMatchObject({ soltadas: 0, siguenPendientes: 1 });
    expect(logMock.error).toHaveBeenCalled();
  });

  // Las cuentas vivas y las ya limpias no son asunto del reintento.
  it('no toca cuentas activas ni cuentas ya revocadas', async () => {
    db.gmail_cuentas.push(
      filaGmail('viva', 'u1'),
      { ...filaGmail('limpia', 'u2'), activa: false, access_token: null, refresh_token: null },
    );

    await gmail.reintentarRevocacionesPendientes();

    expect(gmail.oauth2Client.revokeToken).not.toHaveBeenCalled();
    expect(fila('viva').activa).toBe(true);
  });

  /**
   * La carrera que el reintento no puede cerrar del lado de Google pero sí del nuestro: si entre
   * la lectura y la escritura la persona reconectó ese mismo correo, el upsert de `guardarTokens`
   * dejó `activa=true` con un refresh token NUEVO. El cierre no puede pisarlo.
   */
  it('el cierre es condicional: no borra el token de una fila que se reconectó en el medio', async () => {
    db.gmail_cuentas.push({ ...filaGmail('g1', 'u1'), activa: false, access_token: null });
    respuestaGoogle = async () => {
      Object.assign(fila('g1'), { activa: true, refresh_token: encrypt('rt-nuevo'), access_token: encrypt('at-nuevo') });
    };

    await gmail.reintentarRevocacionesPendientes();

    expect(fila('g1').activa).toBe(true);
    expect(fila('g1').refresh_token).not.toBeNull();
  });
});

describe('el token legacy (usuarios.gmail_*) sin fila en gmail_cuentas', () => {
  it('revocarAccesoGmail lo revoca en Google y limpia las columnas', async () => {
    db.usuarios.push(usuario('u1', { gmail_access_token: encrypt('at-legacy'), gmail_refresh_token: encrypt('rt-legacy') }));

    const r = await gmail.revocarAccesoGmail('u1', { motivo: 'premium_vencido' });

    expect(enGoogle, 'el grant legacy quedaba vivo: la función salía antes por no haber filas').toEqual(['rt-legacy']);
    expect(user('u1')).toMatchObject({ gmail_access_token: null, gmail_refresh_token: null });
    expect(r).toMatchObject({ revocadas: 1, pendientes: 0 });
  });

  it('si Google falla, la lectura se corta (access en null) y el refresh queda para reintentar', async () => {
    db.usuarios.push(usuario('u1', { gmail_access_token: encrypt('at-legacy'), gmail_refresh_token: encrypt('rt-legacy') }));
    respuestaGoogle = caido;

    const r = await gmail.revocarAccesoGmail('u1', { motivo: 'premium_vencido' });

    expect(user('u1').gmail_access_token, 'con el access token puesto, tieneGmailConectado sigue diciendo que sí').toBeNull();
    expect(user('u1').gmail_refresh_token).not.toBeNull();
    expect(r.pendientes).toBe(1);

    respuestaGoogle = ok;
    await gmail.reintentarRevocacionesPendientes();
    expect(user('u1').gmail_refresh_token).toBeNull();
  });

  // El caso normal: la fila de gmail_cuentas y la copia legacy guardan EL MISMO token. Se
  // revoca una vez, y el estado pendiente vive en un solo lugar (la fila), no duplicado.
  it('la copia legacy del mismo token no se revoca dos veces ni duplica el pendiente', async () => {
    db.usuarios.push(usuario('u1', { gmail_access_token: encrypt('at-g1'), gmail_refresh_token: encrypt('rt-g1') }));
    db.gmail_cuentas.push(filaGmail('g1', 'u1'));
    respuestaGoogle = caido;

    const r = await gmail.revocarAccesoGmail('u1', { motivo: 'premium_vencido' });

    expect(enGoogle).toEqual(['rt-g1']);
    expect(user('u1')).toMatchObject({ gmail_access_token: null, gmail_refresh_token: null });
    expect(fila('g1').refresh_token).not.toBeNull();
    expect(r.pendientes).toBe(1);
  });
});

// ── Lo que encontró la revisión adversarial del arreglo (30-sep-2026) ─────────
describe('una revocación total termina también los pendientes del usuario', () => {
  // El borrado de cuenta solo miraba filas activas y después el RPC anula todo refresh token:
  // un pendiente de antes se perdía sin revocar y sin avisar. Es el defecto original por otra
  // puerta, y lo cierra que la revocación total no ignore las filas pendientes.
  it('sin cuentaId, reintenta la fila pendiente aunque no tenga ninguna activa', async () => {
    db.usuarios.push(usuario('u1'));
    db.gmail_cuentas.push({ ...filaGmail('g1', 'u1'), activa: false, access_token: null });

    const r = await gmail.revocarAccesoGmail('u1', { motivo: 'usuario_borro_cuenta' });

    expect(enGoogle).toEqual(['rt-g1']);
    expect(fila('g1').refresh_token).toBeNull();
    expect(r.pendientes).toBe(0);
  });

  // D2b de la segunda revisión: ningún caso tenía una fila activa Y una pendiente juntas, así
  // que "reintentar los pendientes solo si no hay activas" salía verde.
  it('con una fila activa Y una pendiente, cierra la activa y reintenta la pendiente', async () => {
    db.usuarios.push(usuario('u1'));
    db.gmail_cuentas.push(
      filaGmail('viva', 'u1'),
      { ...filaGmail('pend', 'u1'), activa: false, access_token: null },
    );

    await gmail.revocarAccesoGmail('u1', { motivo: 'usuario_borro_cuenta' });

    expect(enGoogle.sort()).toEqual(['rt-pend', 'rt-viva']);
    expect(fila('viva')).toMatchObject({ activa: false, refresh_token: null });
    expect(fila('pend').refresh_token).toBeNull();
  });

  it('si Google sigue caído, el pendiente se reporta (el borrado lo manda al admin)', async () => {
    db.usuarios.push(usuario('u1'));
    db.gmail_cuentas.push({ ...filaGmail('g1', 'u1'), activa: false, access_token: null });
    respuestaGoogle = caido;

    const r = await gmail.revocarAccesoGmail('u1', { motivo: 'usuario_borro_cuenta' });

    expect(r.pendientes).toBe(1);
    expect(fila('g1').refresh_token).not.toBeNull();
  });

  // Con `cuentaId` llama guardarTokens en pleno canje. Un pendiente del MISMO correo que se está
  // reconectando comparte grant con el recién emitido: revocarlo lo tumbaría.
  it('con cuentaId NO toca los pendientes', async () => {
    db.usuarios.push(usuario('u1', { plan: 'premium' }));
    db.gmail_cuentas.push(
      filaGmail('vieja', 'u1'),
      { ...filaGmail('mismo', 'u1'), activa: false, access_token: null },
    );

    await gmail.revocarAccesoGmail('u1', { motivo: 'reemplazada_por_conexion_nueva', cuentaId: 'vieja' });

    expect(enGoogle).toEqual(['rt-vieja']);
    expect(fila('mismo').refresh_token).not.toBeNull();
  });

  // Desconectar una de dos: el token legacy es copia de la OTRA, que sigue leyendo.
  it('desconectar una de dos cuentas no revoca ni limpia el token legacy', async () => {
    db.usuarios.push(usuario('u1', { plan: 'premium', gmail_access_token: encrypt('at-g2'), gmail_refresh_token: encrypt('rt-g2') }));
    db.gmail_cuentas.push(filaGmail('g1', 'u1'), filaGmail('g2', 'u1'));

    await gmail.revocarAccesoGmail('u1', { motivo: 'usuario_desconecto_una', cuentaId: 'g1' });

    expect(enGoogle).toEqual(['rt-g1']);
    expect(user('u1').gmail_access_token).not.toBeNull();
    expect(user('u1').gmail_refresh_token).not.toBeNull();
  });
});

// El caso que hace falta el `.eq('activa', false)` del cierre, y no alcanza con el del token:
// si Google no devuelve refresh token al reconectar, el upsert de guardarTokens deja la fila
// ACTIVA con el MISMO refresh token de antes. Sin esa condición, el reintento se lo anulaba a
// una cuenta que volvió a leer (mutación que sobrevivió la primera corrida del runner).
it('el reintento no anula el token de una fila que se reactivó con el MISMO refresh token', async () => {
  db.gmail_cuentas.push({ ...filaGmail('g1', 'u1'), activa: false, access_token: null });
  respuestaGoogle = async () => {
    Object.assign(fila('g1'), { activa: true, access_token: encrypt('at-nuevo') });
  };

  await gmail.reintentarRevocacionesPendientes();

  expect(fila('g1').activa).toBe(true);
  expect(fila('g1').refresh_token).not.toBeNull();
});

describe('el reintento del token legacy', () => {
  // La peor mutación que sobrevivió: sin el `.is('gmail_access_token', null)`, el reintento
  // —que no mira el plan— revocaba a diario el Gmail VIVO de todos, incluidos los que pagan.
  it('no toca el token legacy de quien sigue leyendo (access token puesto)', async () => {
    db.usuarios.push(usuario('paga', { plan: 'premium', gmail_access_token: encrypt('at-p'), gmail_refresh_token: encrypt('rt-p') }));

    await gmail.reintentarRevocacionesPendientes();

    expect(gmail.oauth2Client.revokeToken).not.toHaveBeenCalled();
    expect(user('paga').gmail_refresh_token).not.toBeNull();
  });

  it('con Google caído, el token legacy pendiente se conserva', async () => {
    db.usuarios.push(usuario('u1', { gmail_refresh_token: encrypt('rt-legacy') }));
    respuestaGoogle = caido;

    const r = await gmail.reintentarRevocacionesPendientes();

    expect(user('u1').gmail_refresh_token).not.toBeNull();
    expect(r.siguenPendientes).toBe(1);
  });

  it('no pisa un token legacy que se reconectó en el medio', async () => {
    db.usuarios.push(usuario('u1', { gmail_refresh_token: encrypt('rt-legacy') }));
    respuestaGoogle = async () => {
      Object.assign(user('u1'), { gmail_access_token: encrypt('at-nuevo'), gmail_refresh_token: encrypt('rt-nuevo') });
    };

    await gmail.reintentarRevocacionesPendientes();

    expect(user('u1').gmail_refresh_token).not.toBeNull();
    expect(user('u1').gmail_access_token).not.toBeNull();
  });
});

describe('las ramas de error (supabase-js devuelve { error }, no lanza)', () => {
  it('si no puede leer el token legacy, lanza SIN haber tocado Google ni la fila', async () => {
    db.usuarios.push(usuario('u1'));
    db.gmail_cuentas.push(filaGmail('g1', 'u1'));
    fallas['usuarios:select'] = 'boom-legacy';

    await expect(gmail.revocarAccesoGmail('u1', { motivo: 'x' })).rejects.toThrow(/boom-legacy/);
    expect(gmail.oauth2Client.revokeToken).not.toHaveBeenCalled();
    expect(fila('g1').activa).toBe(true);
  });

  it('si no puede leer los pendientes, lanza SIN haber tocado nada', async () => {
    db.usuarios.push(usuario('u1'));
    db.gmail_cuentas.push(filaGmail('g1', 'u1'));
    // La primera lectura de gmail_cuentas (las activas) tiene que pasar: se rompe la segunda.
    const from = supabaseMock.from;
    let lecturas = 0;
    supabaseMock.from = (t) => {
      const q = from(t);
      if (t !== 'gmail_cuentas') return q;
      const select = q.select;
      q.select = (...a) => { lecturas++; if (lecturas === 2) fallas['gmail_cuentas:select'] = 'boom-pend'; return select(...a); };
      return q;
    };
    try {
      await expect(gmail.revocarAccesoGmail('u1', { motivo: 'x' })).rejects.toThrow(/boom-pend/);
    } finally {
      supabaseMock.from = from;
    }
    expect(gmail.oauth2Client.revokeToken).not.toHaveBeenCalled();
    expect(fila('g1').activa).toBe(true);
  });

  // Una fila que no se pudo cerrar sigue LEYENDO: el "desconectado" no puede salir, y en
  // guardarTokens seguir de largo dejaría dos cuentas activas.
  it('si no puede cerrar la fila local, lanza', async () => {
    db.usuarios.push(usuario('u1'));
    db.gmail_cuentas.push(filaGmail('g1', 'u1'));
    fallas['gmail_cuentas:update'] = 'boom-cierre';

    await expect(gmail.revocarAccesoGmail('u1', { motivo: 'x' })).rejects.toThrow(/boom-cierre/);
  });

  // Solo lanza lo que sigue pudiendo LEER. Un access token legacy sobre un grant que Google NO
  // soltó sirve para leer; sobre uno que soltó, es un token muerto.
  it('si no puede limpiar el legacy y Google NO soltó el grant, lanza (con lo hecho en `parcial`)', async () => {
    db.usuarios.push(usuario('u1', { gmail_access_token: encrypt('at-legacy'), gmail_refresh_token: encrypt('rt-legacy') }));
    fallas['usuarios:update'] = 'boom-legacy-update';
    respuestaGoogle = caido;

    const err = await gmail.revocarAccesoGmail('u1', { motivo: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/boom-legacy-update/);
    expect(err.parcial).toBeDefined();
  });

  /**
   * El HIGH de la segunda revisión (reproducido): con la fila ya cerrada y Google habiendo
   * soltado el grant, lanzar por la limpieza del legacy dejaba al usuario sin respuesta y con el
   * menú abierto; el menú se re-arma con las cuentas que QUEDAN (cero), y el "1" reenviado caía
   * en "borrar la cuenta entera". Lo que ya no lee no puede lanzar.
   */
  it('si no puede limpiar el legacy pero Google SÍ soltó el grant, no lanza', async () => {
    db.usuarios.push(usuario('u1', { gmail_access_token: encrypt('at-g1'), gmail_refresh_token: encrypt('rt-g1') }));
    db.gmail_cuentas.push(filaGmail('g1', 'u1'));
    fallas['usuarios:update'] = 'boom-legacy-update';

    const r = await gmail.revocarAccesoGmail('u1', { motivo: 'usuario_desconecto' });

    expect(fila('g1').activa).toBe(false);
    expect(r.revocadas).toBe(1);
  });

  it('una copia legacy de un grant PENDIENTE que no se pudo limpiar sí lanza (su access token lee)', async () => {
    db.usuarios.push(usuario('u1', { gmail_access_token: encrypt('at-g1'), gmail_refresh_token: encrypt('rt-g1') }));
    db.gmail_cuentas.push(filaGmail('g1', 'u1'));
    fallas['usuarios:update'] = 'boom-legacy-update';
    respuestaGoogle = caido;

    const err = await gmail.revocarAccesoGmail('u1', { motivo: 'x' }).catch((e) => e);
    expect(err.message).toMatch(/boom-legacy-update/);
    // El lado FUENTE del contrato que usan el cron y el borrado (tercera revisión: sus tests
    // mockean `parcial`, así que forzarlo a 0 acá salía verde). La fila sí se cerró y quedó
    // pendiente en Google.
    expect(err.parcial).toMatchObject({ revocadas: 1, pendientes: 1 });
  });

  // G1 de la tercera revisión: la copia legacy de una fila PENDIENTE de antes (sin filas
  // activas) hereda "pendiente". Si el reintento la registrara como suelta, la copia no
  // limpiada dejaría de lanzar y seguiría leyendo en silencio: sin filas activas,
  // `cargarTokens` cae al legacy.
  it('la copia legacy de un pendiente PREVIO que no se pudo limpiar lanza', async () => {
    db.usuarios.push(usuario('u1', { gmail_access_token: encrypt('at-g1'), gmail_refresh_token: encrypt('rt-g1') }));
    db.gmail_cuentas.push({ ...filaGmail('g1', 'u1'), activa: false, access_token: null });
    fallas['usuarios:update'] = 'boom-legacy-update';
    respuestaGoogle = caido;

    await expect(gmail.revocarAccesoGmail('u1', { motivo: 'x' })).rejects.toThrow(/boom-legacy-update/);
  });

  it('si Google soltó un pendiente y lo que falla es limpiar su fila, no lanza (el token está muerto)', async () => {
    db.usuarios.push(usuario('u1'));
    db.gmail_cuentas.push({ ...filaGmail('g1', 'u1'), activa: false, access_token: null });
    fallas['gmail_cuentas:update'] = 'boom';

    await expect(gmail.revocarAccesoGmail('u1', { motivo: 'usuario_borro_cuenta' })).resolves.toMatchObject({ pendientes: 0 });
  });

  it('el throw por una fila activa sin cerrar lleva lo hecho en `parcial`', async () => {
    db.usuarios.push(usuario('u1'));
    db.gmail_cuentas.push(filaGmail('g1', 'u1'));
    fallas['gmail_cuentas:update'] = 'boom-cierre';

    const err = await gmail.revocarAccesoGmail('u1', { motivo: 'x' }).catch((e) => e);
    expect(err.parcial).toMatchObject({ revocadas: 0, pendientes: 0 });
  });

  it('en el reintento, una caída de gmail_cuentas no deja sin reintentar el legacy', async () => {
    db.usuarios.push(usuario('u1', { gmail_refresh_token: encrypt('rt-legacy') }));
    fallas['gmail_cuentas:select'] = 'boom';

    const r = await gmail.reintentarRevocacionesPendientes();

    expect(enGoogle).toEqual(['rt-legacy']);
    expect(user('u1').gmail_refresh_token).toBeNull();
    expect(r.errores).toBe(1);
  });

  it('en el reintento, un cierre que falla no se cuenta como resuelto', async () => {
    db.gmail_cuentas.push({ ...filaGmail('g1', 'u1'), activa: false, access_token: null });
    fallas['gmail_cuentas:update'] = 'boom';

    const r = await gmail.reintentarRevocacionesPendientes();

    expect(r).toMatchObject({ soltadas: 0, errores: 1 });
  });
});
