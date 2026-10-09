import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

/**
 * **Una cuenta de Google sin Gmail se veía "conectada y sana" para siempre.**
 *
 * Medido el 07-oct-2026: un Pro pagado conectó el 21-sep una cuenta de Google creada con un
 * Hotmail. El OAuth pasó (y gastó un cupo de los 100), el refresh token anda, pero
 * `users.messages.list` responde 400 FAILED_PRECONDITION "Mail service not enabled". Cada
 * barrido de 15 minutos dejaba dos "Error en query Gmail" en Railway sin usuario, `auth_error_at`
 * seguía en NULL y `/dashboard/pro` le decía "Gmail conectado ✓" con 0 transacciones de Gmail.
 *
 * **La respuesta de Gmail se reproduce en el CABLE, no en el error.** googleapis, gaxios y el
 * OAuth2 de google-auth-library son los reales; lo único falso es el `fetch` que gaxios usa, que
 * devuelve el 400 con el cuerpo que manda Gmail. Así el error que llega a `gmail.js` es el que
 * construye la librería, con la forma que tenga en esta versión: un doble escrito a mano
 * (`new Error('Mail service not enabled')`) probaría el detector contra una forma que inventé yo.
 */

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'), '..');

// --- Supabase: gmail.js arma su propio cliente con createClient (no usa lib/db) ---
let cuentasActivas = [];
const escrituras = [];
function tabla(nombre) {
  const q = {
    _filtros: {}, _op: null,
    select() { return q; },
    eq(col, val) { q._filtros[col] = val; return q; },
    is(col, val) { q._filtros['is:' + col] = val; return q; },
    not(col, op, val) { q._filtros['not:' + col] = [op, val]; return q; },
    upsert(payload) { escrituras.push({ tabla: nombre, op: 'upsert', payload, filtros: q._filtros }); return Promise.resolve({ data: null, error: null }); },
    order() { return q; },
    limit() { return q; },
    update(payload) { q._op = 'update'; escrituras.push({ tabla: nombre, payload, filtros: q._filtros }); return q; },
    single() { return Promise.resolve({ data: { bancos_seleccionados: null }, error: null }); },
    then(resolve) {
      const data = nombre === 'gmail_cuentas' && q._op !== 'update' ? cuentasActivas : [];
      return Promise.resolve({ data, error: null }).then(resolve);
    },
  };
  return q;
}
const supaPath = require.resolve('@supabase/supabase-js', { paths: [projectRoot] });
require.cache[supaPath] = {
  id: supaPath, filename: supaPath, loaded: true,
  exports: { createClient: () => ({ from: (nombre) => tabla(nombre) }) },
};

// `guardarTokens` cifra los tokens antes del upsert.
process.env.ENCRYPTION_KEY = 'a1'.repeat(32);
const { google } = require(require.resolve('googleapis', { paths: [projectRoot] }));
const { leerCorreosDesdeCuenta, leerCorreosBancarios, agregarResultadosDeCuentas, guardarTokens, tocaReprobarSinBuzon } = require('../gmail.js');

// El cuerpo exacto que devuelve Gmail a una cuenta de Google sin buzón.
const CUERPO_SIN_BUZON = {
  error: {
    code: 400,
    message: 'Mail service not enabled',
    errors: [{ message: 'Mail service not enabled', domain: 'global', reason: 'failedPrecondition' }],
    status: 'FAILED_PRECONDITION',
  },
};
// Control: la MISMA razón con otro texto. No es "sin buzón" y no puede sellarse como tal.
const CUERPO_OTRA_PRECONDICION = {
  error: {
    code: 400,
    message: 'Precondition check failed.',
    errors: [{ message: 'Precondition check failed.', domain: 'global', reason: 'failedPrecondition' }],
    status: 'FAILED_PRECONDITION',
  },
};

// 429 de cuota: transitorio, el caso que más fácil se sellaría por error.
const CUERPO_CUOTA = {
  error: { code: 429, message: 'Quota exceeded for quota metric', errors: [{ message: 'Quota exceeded for quota metric', domain: 'usageLimits', reason: 'rateLimitExceeded' }], status: 'RESOURCE_EXHAUSTED' },
};

let respuestaGmail = CUERPO_SIN_BUZON;
const llamadasGmail = [];
async function fetchFalso(url) {
  const u = String(url);
  if (!/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages/.test(u)) {
    throw new Error('llamada inesperada desde el test: ' + u);
  }
  llamadasGmail.push(u);
  const status = respuestaGmail && respuestaGmail.error ? respuestaGmail.error.code : 200;
  return new Response(JSON.stringify(respuestaGmail), { status, headers: { 'content-type': 'application/json' } });
}
// `google.options` es global del módulo: se fija el transporte acá y se suelta al final.
google.options({ fetchImplementation: fetchFalso });
afterAll(() => google.options({ fetchImplementation: undefined }));

function clienteConToken() {
  const c = new google.auth.OAuth2('id', 'secret', 'http://localhost/cb');
  // Token vigente: la llamada sale directo a Gmail, sin refresh.
  c.setCredentials({ access_token: 'tok', refresh_token: 'ref', expiry_date: Date.now() + 3600e3 });
  return c;
}

beforeEach(() => {
  respuestaGmail = CUERPO_SIN_BUZON;
  llamadasGmail.length = 0;
  escrituras.length = 0;
  cuentasActivas = [];
});

describe('leerCorreosDesdeCuenta reconoce la cuenta de Google sin Gmail', () => {
  it('devuelve SIN_BUZON, no `listado_fallido`, y no reintenta la segunda query', async () => {
    const r = await leerCorreosDesdeCuenta(clienteConToken(), 'x@hotmail.com', ['a@bcp.com.pe']);
    expect(r.error).toBe('SIN_BUZON');
    expect(r.mensajes).toEqual([]);
    // No es un listado perdido: contarlo liberaría el claim del histórico en cada reconexión.
    expect(r.salteados).toBe(0);
    expect(llamadasGmail.length, 'la segunda query daría el mismo 400').toBe(1);
  });

  it('CONTROL: otra precondición fallida sigue siendo un listado fallido', async () => {
    respuestaGmail = CUERPO_OTRA_PRECONDICION;
    const r = await leerCorreosDesdeCuenta(clienteConToken(), 'x@gmail.com', ['a@bcp.com.pe']);
    expect(r.error).toBe('listado_fallido');
    expect(r.salteados).toBe(2);
  });
});

describe('leerCorreosBancarios sella la cuenta y deja de barrerla', () => {
  const CUENTA = {
    id: 'cuenta-1', usuario_id: 'u-1', email: 'x@hotmail.com', activa: true,
    access_token: 'tok', refresh_token: 'ref', token_expiry: Date.now() + 3600e3,
    auth_error_at: null, sin_buzon_at: null,
  };

  it('la primera vez sella `sin_buzon_at` en ESA fila, condicional a NULL', async () => {
    cuentasActivas = [{ ...CUENTA }];
    const r = await leerCorreosBancarios('u-1');
    expect(r.error).toBe('SIN_BUZON');
    const sello = escrituras.find(w => w.tabla === 'gmail_cuentas' && w.payload && 'sin_buzon_at' in w.payload);
    expect(sello, 'no quedó estado guardado: la app la sigue dando por sana').toBeTruthy();
    expect(typeof sello.payload.sin_buzon_at).toBe('string');
    expect(sello.filtros.id).toBe('cuenta-1');
    expect(sello.filtros['is:sin_buzon_at'], 'sin el filtro la marca se pisa en cada barrido').toBeNull();
    // Y no es auth caída: "reconecta" no le sirve a esta persona.
    expect(escrituras.some(w => w.payload && 'auth_error_at' in w.payload)).toBe(false);
  });

  it('una cuenta ya sellada no le pide nada a Gmail', async () => {
    cuentasActivas = [{ ...CUENTA, sin_buzon_at: '2026-10-08T00:00:00Z' }];
    const r = await leerCorreosBancarios('u-1');
    expect(r.error).toBe('SIN_BUZON');
    expect(llamadasGmail.length, 'el barrido de 15 min sigue golpeando a Gmail').toBe(0);
    expect(escrituras.length).toBe(0);
  });
});

describe('el sello solo nace de "sin buzón", y tiene salida', () => {
  const CUENTA = {
    id: 'cuenta-1', usuario_id: 'u-1', email: 'x@hotmail.com', activa: true,
    access_token: 'tok', refresh_token: 'ref', token_expiry: Date.now() + 3600e3,
    auth_error_at: null, sin_buzon_at: null,
  };
  const selloEscrito = () => escrituras.some(w => w.tabla === 'gmail_cuentas' && w.payload && w.payload.sin_buzon_at);

  // Sellar ante cualquier error dejaría fuera del barrido, y sin botón, a quien sí tiene Gmail.
  for (const [nombre, cuerpo] of [['otra precondición fallida', CUERPO_OTRA_PRECONDICION], ['un 429 de cuota', CUERPO_CUOTA]]) {
    it(`CONTROL: ${nombre} NO sella la cuenta`, async () => {
      respuestaGmail = cuerpo;
      cuentasActivas = [{ ...CUENTA }];
      const r = await leerCorreosBancarios('u-1');
      expect(r.error).toBe('listado_fallido');
      expect(selloEscrito(), 'un error transitorio selló la cuenta para siempre').toBe(false);
    });
  }

  it('la re-prueba toca una vez por día, no en cada tick', () => {
    const marca = '2026-10-01T00:00:00.000Z';
    const t0 = Date.parse(marca);
    expect(tocaReprobarSinBuzon(marca, t0 + 60e3), 'recién sellada').toBe(false);
    expect(tocaReprobarSinBuzon(marca, t0 + 24 * 3600e3 + 60e3)).toBe(true);
    expect(tocaReprobarSinBuzon(marca, t0 + 24 * 3600e3 + 20 * 60e3), 'fuera de la ventana del tick').toBe(false);
    expect(tocaReprobarSinBuzon(marca, t0 + 3 * 24 * 3600e3 + 5 * 60e3)).toBe(true);
    expect(tocaReprobarSinBuzon(marca, t0 + 36 * 3600e3 + 60e3), 'a las 36 h no toca: es una por día').toBe(false);
    expect(tocaReprobarSinBuzon('basura', t0), 'una marca ilegible se re-prueba').toBe(true);
  });

  it('una cuenta sellada que en la re-prueba lista bien pierde la marca', async () => {
    // El caso real: un admin de Workspace apagó Gmail y lo volvió a prender. Mismo texto de error.
    respuestaGmail = {};
    const marca = new Date(Date.now() - 24 * 3600e3 - 60e3).toISOString();
    cuentasActivas = [{ ...CUENTA, sin_buzon_at: marca }];
    const r = await leerCorreosBancarios('u-1');
    expect(r.error).toBeNull();
    expect(llamadasGmail.length, 'la re-prueba no le preguntó a Gmail').toBeGreaterThan(0);
    const limpieza = escrituras.find(w => w.tabla === 'gmail_cuentas' && w.payload && 'sin_buzon_at' in w.payload);
    expect(limpieza, 'la cuenta quedó sellada aunque ya tiene buzón').toBeTruthy();
    expect(limpieza.payload.sin_buzon_at).toBeNull();
    expect(limpieza.filtros.id).toBe('cuenta-1');
  });

  it('CONTROL: un 429 en la re-prueba NO quita la marca', async () => {
    // Solo un listado SANO prueba que hay buzón. Un error transitorio en la re-prueba no dice nada.
    respuestaGmail = CUERPO_CUOTA;
    const marca = new Date(Date.now() - 24 * 3600e3 - 60e3).toISOString();
    cuentasActivas = [{ ...CUENTA, sin_buzon_at: marca }];
    await leerCorreosBancarios('u-1');
    expect(llamadasGmail.length, 'la re-prueba no corrió: el caso no prueba nada').toBeGreaterThan(0);
    const toca = escrituras.filter(w => w.tabla === 'gmail_cuentas' && w.payload && 'sin_buzon_at' in w.payload);
    expect(toca, 'un 429 le quitó la marca a una cuenta sin buzón').toEqual([]);
  });

  it('CONTROL: una cuenta sana y sin marca no escribe nada sobre la marca', async () => {
    // Sin esto, limpiar en toda cuenta sana pasaría verde: un UPDATE por cuenta en cada tick.
    respuestaGmail = {};
    cuentasActivas = [{ ...CUENTA, email: 'x@gmail.com' }];
    const r = await leerCorreosBancarios('u-1');
    expect(r.error).toBeNull();
    expect(escrituras.filter(w => w.tabla === 'gmail_cuentas' && w.payload && 'sin_buzon_at' in w.payload)).toEqual([]);
  });

  it('la ventana de la re-prueba sigue al intervalo del barrido (SCAN_INTERVAL_HOURS)', () => {
    // Con 15 min fijos y un barrido por hora, la fase de los ticks se repite cada día y una cuenta
    // sellada podía no re-probarse nunca.
    const previo = process.env.SCAN_INTERVAL_HOURS;
    process.env.SCAN_INTERVAL_HOURS = '1';
    try {
      const marca = '2026-10-01T00:00:00.000Z';
      expect(tocaReprobarSinBuzon(marca, Date.parse(marca) + 24 * 3600e3 + 40 * 60e3)).toBe(true);
    } finally {
      if (previo === undefined) delete process.env.SCAN_INTERVAL_HOURS; else process.env.SCAN_INTERVAL_HOURS = previo;
    }
  });

  it('reconectar quita la marca en el mismo upsert', async () => {
    cuentasActivas = [];
    await guardarTokens('u-1', { access_token: 'a', refresh_token: 'r', expiry_date: Date.now() + 3600e3 }, 'x@hotmail.com');
    const upsert = escrituras.find(w => w.tabla === 'gmail_cuentas' && w.op === 'upsert');
    expect(upsert).toBeTruthy();
    expect('sin_buzon_at' in upsert.payload, 'reconectar no limpia la marca: queda sellada aunque Google ya le dé buzón').toBe(true);
    expect(upsert.payload.sin_buzon_at).toBeNull();
  });
});

describe('agregarResultadosDeCuentas: sin buzón solo es global si son TODAS', () => {
  const SANA = { error: null, mensajes: [{ id: 'm1' }], cuentaEmail: 'b@gmail.com', salteados: 0 };
  const SIN = { error: 'SIN_BUZON', mensajes: [], cuentaEmail: 'a@hotmail.com', salteados: 0 };

  it('una sana junto a una sin buzón: los correos de la sana no se descartan', () => {
    const r = agregarResultadosDeCuentas([SANA, SIN]);
    expect(r.error).toBeNull();
    expect(r.mensajes.length).toBe(1);
    expect(r.salteados, 'sin buzón no es un listado perdido').toBe(0);
  });

  it('todas sin buzón: SIN_BUZON', () => {
    expect(agregarResultadosDeCuentas([SIN, { ...SIN, cuentaEmail: 'c@outlook.com' }]).error).toBe('SIN_BUZON');
  });
});
