import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

/**
 * **La agregación multi-cuenta, ejecutada de verdad y no mirada de reojo.**
 *
 * `leerCorreosBancarios` colapsa el resultado de N cuentas en un solo `{error, mensajes,
 * salteados}`, y ahí vivía el defecto original en su forma más cara: una cuenta con 429 y otra
 * sana devolvían `salteados: 0`, así que el barrido histórico **conservaba** su claim y los 30
 * días de la cuenta caída se perdían para siempre. Dos causas juntas: la salida `listado_fallido`
 * de una cuenta omitía su contador, y `todasFallaron` usa `every`, o sea que una sola cuenta sana
 * anulaba el fatal de su hermana.
 *
 * **Este archivo existe porque el guard de forma que lo reemplazaba era evadible y su
 * justificación era falsa.** Se había escrito que el camino multi-cuenta "no es ejecutable sin
 * salir a la red, porque pasa por `configurarClienteParaCuenta`, que construye un `OAuth2Client`
 * real". Es mentira, y el contraejemplo estaba en el repo: `tests/gmail-estado-auth.test.js` ya
 * lo ejecuta interceptando `@supabase/supabase-js` y `googleapis` por `require.cache` (vitest
 * aísla por archivo, que es por qué eso no contamina a `gmail-timeout`). Mientras tanto, el guard
 * de forma dejaba pasar en verde dos mutaciones realistas: `return {...agregado, salteados: 0}`,
 * y re-inlinear la agregación con otros nombres satisfaciendo su aserción positiva **desde un
 * comentario**. Las dos con la consecuencia completa: claim conservado sobre un barrido a medias.
 */

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'), '..');

const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };

let cuentasActivas = [];
/** Tokens en `usuarios.gmail_access_token`: el camino LEGACY, que no pasa por el agregador. */
let usuarioLegacy = null;

function tabla(nombre) {
  // Las dos lecturas de `usuarios` con `.single()` piden columnas distintas y hay que
  // distinguirlas: `remitentesParaUsuario` pide `bancos_seleccionados` y `cargarTokens` los
  // tokens legacy. Un doble que contestara lo mismo a las dos deja el camino legacy inalcanzable.
  let columnas = '';
  const q = {
    select(cols) { columnas = cols || ''; return q; },
    eq() { return q; },
    is() { return q; },
    order() { return q; },
    limit() { return q; },
    update() { return q; },
    single() {
      if (columnas.includes('gmail_access_token')) return Promise.resolve({ data: usuarioLegacy, error: null });
      return Promise.resolve({ data: { bancos_seleccionados: null }, error: null });
    },
    then(resolve) {
      return Promise.resolve({ data: nombre === 'gmail_cuentas' ? cuentasActivas : [], error: null }).then(resolve);
    },
  };
  return q;
}

// `gmail.js` no usa `lib/db`: arma su cliente con `createClient` desde el env, así que mockear
// `lib/db` lo dejaría hablando con Supabase de PRODUCCIÓN. Se intercepta en su origen.
const supaPath = require.resolve('@supabase/supabase-js', { paths: [projectRoot] });
require.cache[supaPath] = {
  id: supaPath, filename: supaPath, loaded: true,
  exports: { createClient: () => ({ from: (n) => tabla(n) }) },
};

/**
 * El doble de la API de Gmail discrimina por el `access_token` que el cliente de esa cuenta trae
 * descifrado: es lo único que distingue una cuenta de otra dentro de `leerCorreosDesdeCuenta`.
 */
const apiPorToken = {};

class OAuth2Fake {
  constructor() { this.credentials = {}; }
  setCredentials(c) { this.credentials = c; }
  generateAuthUrl() { return 'https://accounts.google.com/fake'; }
  async revokeToken() {}
  async getToken() { return { tokens: {} }; }
  async refreshAccessToken() {
    return { credentials: { access_token: this.credentials.access_token, expiry_date: Date.now() + 3600000 } };
  }
}

function cuota() {
  const e = new Error('Quota exceeded for quota metric');
  e.code = 429;
  throw e;
}

/**
 * Un correo que PASA los tres filtros de `leerCorreosDesdeCuenta` (no reenviado, dentro de la
 * ventana, bancario).
 *
 * **La primera versión del doble no podía producir uno solo**, y eso volvía muerto medio archivo:
 * devolvía `payload: { headers: [] }`, así que `extraerTexto` daba `''`, `esBancario` descartaba
 * todo y cada "cuenta sana" era en realidad sana Y VACÍA. Lo que anulaba el `todasFallaron` no era
 * traer correos sino no tener error, o sea que la variante que importa —una cuenta sana **con
 * correos** tapando a la caída— no estaba probada y no se podía escribir. Peor: quien agregara un
 * caso con mensajes habría recibido 0 en silencio y escrito la aserción contra el doble.
 */
function correoBancario(id) {
  return {
    id,
    internalDate: String(Date.now()),
    snippet: 'Realizaste un consumo',
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'Subject', value: 'Realizaste un consumo' },
        // Decorativo, anotado para que nadie crea que sostiene un filtro: `esBancario` recibe el
        // asunto y el cuerpo, nunca el remitente, y la lista de `remitentes` sólo arma el query de
        // Gmail, que este doble ignora. Lo que hace pasar el filtro es el Subject, que es
        // literalmente `SUBJECTS_BANCARIOS[0]` — o sea que corta en la primera regla y ni llega a
        // las palabras del cuerpo.
        { name: 'From', value: 'notificaciones@bcp.com.pe' },
      ],
      body: { data: Buffer.from('Realizaste un consumo de S/ 25.00 en TIENDA con tu tarjeta').toString('base64') },
    },
  };
}

const googlePath = require.resolve('googleapis', { paths: [projectRoot] });
// `options` está porque `gmail.js` fija el timeout de transporte al cargarse; un doble
// incompleto acá no falla con una aserción, revienta el archivo al importar.
require.cache[googlePath] = {
  id: googlePath, filename: googlePath, loaded: true,
  exports: {
    google: {
      auth: { OAuth2: OAuth2Fake },
      oauth2: () => ({}),
      options: () => {},
      gmail: ({ auth }) => {
        const token = auth && auth.credentials && auth.credentials.access_token;
        const plan = apiPorToken[token] || {};
        return {
          users: {
            messages: {
              list: async () => {
                if (plan.listFalla) return cuota();
                return { data: plan.ids ? { messages: plan.ids.map((id) => ({ id })) } : {} };
              },
              get: async ({ id }) => {
                if (plan.getFalla) return cuota();
                return { data: correoBancario(id) };
              },
            },
          },
        };
      },
    },
  },
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

/** Token vigente: no dispara el refresh, así que el barrido llega hasta la API. */
function cuenta(id, email, plan) {
  apiPorToken['at-' + id] = plan;
  return {
    id,
    usuario_id: 'u1',
    email,
    activa: true,
    access_token: encrypt('at-' + id),
    refresh_token: encrypt('rt-' + id),
    token_expiry: Date.now() + 3600000,
    auth_error_at: null,
  };
}

beforeEach(() => {
  cuentasActivas = [];
  usuarioLegacy = null;
  for (const k of Object.keys(apiPorToken)) delete apiPorToken[k];
  vi.clearAllMocks();
});

describe('leerCorreosBancarios: una cuenta caída no desaparece detrás de una sana', () => {
  it('con 429 en una cuenta y la otra sana, el agregado LO DICE', async () => {
    // El defecto entero, por el camino real. Sin esto sale `salteados: 0` y el barrido histórico
    // conserva su claim: los 30 días de la cuenta caída no vuelven ni reconectando.
    cuentasActivas = [
      cuenta('c1', 'caida@gmail.com', { listFalla: true }),
      cuenta('c2', 'sana@gmail.com', { ids: [] }),
    ];

    const r = await gmail.leerCorreosBancarios('u1');

    expect(r.salteados, 'la cuenta con 429 desapareció detrás de la sana').toBe(2);
    expect(r.error, 'con una cuenta sana el error deja de ser global, y está bien').toBeNull();
  });

  it('si TODAS las cuentas se caen, el vacío no es un hecho sobre el usuario', async () => {
    cuentasActivas = [
      cuenta('c1', 'a@gmail.com', { listFalla: true }),
      cuenta('c2', 'b@gmail.com', { listFalla: true }),
    ];

    const r = await gmail.leerCorreosBancarios('u1');

    expect(r.error).toBe('listado_fallido');
    expect(r.salteados).toBe(4);
  });

  it('una cuenta que revienta ENTERA cuenta como al menos uno', async () => {
    // **Deriva del sujeto el fixture que antes estaba escrito a mano.** El `catch` genérico por
    // cuenta devuelve `{error: e.message, mensajes: []}` sin contador —no sabe cuántos correos
    // quedaron adentro— y ningún test lo ejecutaba: la regla `n + 1` se probaba sólo contra un
    // `{error: 'boom'}` inventado, o sea contra una forma que nadie garantizaba que existiera.
    //
    // **La causa se buscó midiendo, y las dos primeras candidatas no servían.** Un token que no
    // descifra NO tira (`decrypt` devuelve el string tal cual o `null`), y un UPDATE caído dentro
    // del refresh lo traga el `catch` de `configurarClienteParaCuenta`, que sólo re-lanza si el
    // error parece de auth. La que sí llega: una fila cifrada con OTRA `ENCRYPTION_KEY` —el caso
    // de una rotación de clave— donde `decrypt` tira `Invalid authentication tag length` fuera
    // de todo `try`. Medido: `'aa:bb:cc'` tira, `'no-es-cifrado'` no.
    const rota = cuenta('c1', 'rota@gmail.com', { ids: [] });
    rota.access_token = 'aa:bb:cc';
    cuentasActivas = [rota, cuenta('c2', 'sana@gmail.com', { ids: [] })];

    const r = await gmail.leerCorreosBancarios('u1');

    // Se mira el MENSAJE, no sólo que hubo una llamada: cualquier excepción dentro de ese `try`
    // da los mismos números, así que sin esto el comentario de arriba —que nombra la causa— podría
    // volverse falso sin que nada se ponga rojo.
    expect(logMock.error, 'la cuenta no reventó por donde dice el comentario').toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.stringContaining('authentication tag') }),
      expect.any(String),
    );
    expect(r.error, 'la cuenta sana no debería volverse un fatal global').toBeNull();
    expect(r.salteados, 'una cuenta que ni se pudo abrir se dio por completa').toBe(1);
  });

  it('CONTROL: dos cuentas sanas no inventan un barrido incompleto', async () => {
    // La mitad que impide que "contar los errores" se vuelva "siempre hay algo saltado", y que
    // sostiene el otro lado del claim: sin esto el histórico se re-correría en cada reconexión.
    cuentasActivas = [
      cuenta('c1', 'a@gmail.com', { ids: [] }),
      cuenta('c2', 'b@gmail.com', { ids: [] }),
    ];

    const r = await gmail.leerCorreosBancarios('u1');

    expect(r.salteados).toBe(0);
    expect(r.error).toBeNull();
  });

  it('una cuenta sana CON correos no tapa el contador de la caída', async () => {
    // La variante que el doble viejo no podía escribir. Sin correos de por medio, lo que anula el
    // fatal global es que la cuenta sana no tenga `error`; con correos se ejercita además la
    // unificación, que es donde el agregado podría perder el contador al armar la respuesta.
    cuentasActivas = [
      cuenta('c1', 'caida@gmail.com', { listFalla: true }),
      cuenta('c2', 'sana@gmail.com', { ids: ['m0', 'm1'] }),
    ];

    const r = await gmail.leerCorreosBancarios('u1');

    expect(r.mensajes.length, 'el doble no produjo correos: el caso no prueba lo que dice').toBe(2);
    expect(r.salteados, 'los correos de la cuenta sana taparon el 429 de la otra').toBe(2);
  });

  it('el MISMO id en dos cuentas son dos correos, no uno', async () => {
    // El dedup es por `id + cuentaEmail` a propósito: el id de Gmail es único POR BUZÓN, así que
    // colapsarlos perdería un movimiento real de una de las dos cuentas.
    cuentasActivas = [
      cuenta('c1', 'a@gmail.com', { ids: ['m0'] }),
      cuenta('c2', 'b@gmail.com', { ids: ['m0'] }),
    ];

    const r = await gmail.leerCorreosBancarios('u1');

    expect(r.mensajes.length).toBe(2);
    expect(r.mensajes.map((m) => m.cuentaEmail).sort()).toEqual(['a@gmail.com', 'b@gmail.com']);
  });

  it('EL CAMINO LEGACY también reporta lo que se saltó', async () => {
    // **El hueco que quedaba, y es el camino que MÁS usuarios recorren.** La rama
    // `cuentas.length === 0` (token en `usuarios.gmail_access_token`) devuelve el objeto de
    // `leerCorreosDesdeCuenta` sin pasar por el agregador, así que ningún caso de este archivo la
    // tocaba: todos siembran al menos una fila en `gmail_cuentas`. Verificado por mutación —
    // devolver `{ error: r.error, mensajes: r.mensajes }` ahí dejaba la suite COMPLETA en verde
    // (169 archivos, 3023 tests) con el defecto original vivo para los usuarios legacy.
    cuentasActivas = [];
    apiPorToken['at-legacy'] = { ids: ['m0', 'm1', 'm2'], getFalla: true };
    usuarioLegacy = {
      gmail_access_token: encrypt('at-legacy'),
      gmail_refresh_token: encrypt('rt-legacy'),
      gmail_token_expiry: Date.now() + 3600000,
    };

    const r = await gmail.leerCorreosBancarios('u1');

    // `salteados: 3` es el que PINEA que se llegó acá: si el token no matcheara el plan del doble
    // saldría 0, y si fuera `listFalla` saldría 2 — sólo tres `get` caídos dan 3. `mensajes: []`
    // NO sirve para eso: la ruta `no_auth` (que es donde cae este caso si el doble de `usuarios`
    // deja de distinguir por columnas) devuelve exactamente lo mismo.
    expect(r.salteados, 'el camino legacy dio por completo un barrido con 3 correos sin mirar, o no se llegó a él').toBe(3);
    expect(r.mensajes, 'los tres get se cayeron: no puede haber llegado ningún correo').toEqual([]);
  });

  it('CONTROL: los `get` caídos de una cuenta llegan al agregado', async () => {
    // Cierra la costura entre las dos capas: `leerCorreosDesdeCuenta` cuenta los `get` que Gmail
    // no entregó, y esto verifica que el agregador no los tire por el camino.
    cuentasActivas = [cuenta('c1', 'a@gmail.com', { ids: ['m0', 'm1', 'm2'], getFalla: true })];

    const r = await gmail.leerCorreosBancarios('u1');

    expect(r.mensajes).toEqual([]);
    expect(r.salteados, 'tres correos existían y ninguno llegó al agregado').toBe(3);
  });
});
