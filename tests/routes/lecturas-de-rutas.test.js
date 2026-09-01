import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

/**
 * LA OTRA MITAD DEL ÍTEM 21, para `routes/`: qué CONTESTA cada ruta cuando la lectura se cae.
 *
 * `tests/lecturas-del-resto.test.js` mira la FORMA —que el `{ error }` se destructure— y eso no
 * alcanza, medido: el parser compartido **no exige que el error se CONSULTE**. La mutación que
 * lo demuestra es la misma de los ítems 19 y 20: **quitarle a `/admin/pendientes` su
 * `if (error)` dejando el destructuring deja el guard de forma VERDE y mata este archivo.**
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * CADA CASO TRAE SU CONTROL, Y ACÁ NO ES CEREMONIA
 *
 * El modo de fallo que este ítem persigue no es "la ruta no contesta": es que contesta **lo
 * mismo** que cuando de verdad no hay nada. Un test que sólo afirmara el 500 pasaría igual si
 * los dos casos devolvieran 500, y un test que sólo afirmara el 404 pasaría con el bug intacto.
 * Por eso cada sitio se ejercita DOS veces —con la tabla caída y con cero filas— y se afirma
 * que los códigos son DISTINTOS.
 *
 * `routes/` es el perímetro donde el arreglo es un **status code** y no un texto de WhatsApp,
 * y eso cambia lo que ve la webapp: un 404 es "no existe, no reintentes", un 5xx es "reintenta".
 * Con la lectura muda, las nueve rutas de acá contestaban lo primero sobre lo segundo.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * LOS DOS QUE FALLAN ABIERTO, Y POR QUÉ NO SON UN DESCUIDO
 *
 * No todo se arregla cortando. Dos sitios siguen adelante con la lectura caída, y los dos
 * tienen su caso acá para que el día que alguien los "arregle" a 500 se ponga rojo:
 *
 *   · `/admin/notify` resolviendo el usuario por NÚMERO: el mensaje se manda igual. Esa
 *     lectura sólo sirve para archivar la fila en `conversaciones`, y la respuesta reporta
 *     `saved_in_history` — que desde el 31-ago sale del RETORNO de `guardarMensaje` y no de
 *     que no haya excepción. Cortar el envío por ella sería apagar un efecto correcto, el error
 *     que el ítem 20 pagó con el aviso del autocierre.
 *   · El UPDATE del perfil de Google en `/auth/callback`: los tokens ya se guardaron y el OAuth
 *     fue un éxito. Fallar la página ahí convierte una conexión buena en un error a la vista.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * LO QUE ESTE ARCHIVO **NO** CUBRE, DECLARADO PORQUE YA MINTIÓ UNA VEZ
 *
 * La primera versión afirmaba que los dos fail-open del callback "tienen su caso acá", y
 * `/auth/callback` no se montaba: aparecía sólo en comentarios. Lo midió la revisión
 * adversarial. Hoy el router público SÍ está montado y lo cubierto es la **resolución del
 * usuario** (el 500 vs el 404, y que un error del `uid` no caiga al fallback por número).
 *
 * **Los dos UPDATE fail-open de más adentro YA están cubiertos** (01-sep-2026, ítem 21b), y
 * hasta entonces este bloque decía lo contrario: que llegar ahí pedía "montar medio flujo de
 * OAuth para afirmar dos `log.error`". Esa estimación era de cuando `/auth/callback` no se
 * montaba acá. Con el router público montado y `gmail.js` en un doble, el camino feliz ya lo
 * recorren tres casos de este archivo y lo único que faltaba era sembrar el error en el
 * `usuarios:update` — con una COLA, para que cada caso diga cuál de las dos escrituras midió.
 *
 * Y hacía falta, porque el guard de forma no ve la DIRECCIÓN del fallo: la mutación peligrosa
 * en un fail-open no es borrarle el `if (error)` sino "completarlo" con un corte.
 */

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'),
  '../..',
);

// ── El doble de PostgREST, indexado por (tabla, operación) ───────────────────────────────
/**
 * Clave `tabla:op`, igual que `tests/lib/lecturas-de-soporte.test.js`. Una cola posicional no
 * sirve acá: `/admin/stats` encadena seis queries sobre dos tablas y `/auth/callback` resuelve
 * el usuario por dos caminos, así que un cambio de orden convertiría cualquier caso en uno que
 * mide otra cosa sin ponerse rojo.
 *
 * El `then` NO es decorativo: un builder de supabase-js es THENABLE, y las queries que no
 * terminan en `.maybeSingle()` se resuelven con el `await` a secas. Sin él, `const { error }`
 * quedaría `undefined` y la rama de error no se ejercitaría nunca — el falso verde que ya
 * documentó `tests/routes/email-webhook.test.js`.
 */
const db = { resp: {}, llamadas: [] };
const CAIDA = { data: null, error: { message: 'connection terminated unexpectedly', code: '57P01' } };
const VACIO = { data: null, error: null };
// Lo que PostgREST devuelve cuando un `.single()` no encuentra fila. Ver el doble de abajo.
const SIN_FILAS = { code: 'PGRST116', details: 'The result contains 0 rows', message: 'JSON object requested, multiple (or no) rows returned' };

function cadena(tabla) {
  const c = {};
  let op = 'select';
  const resultado = () => {
    db.llamadas.push(tabla + ':' + op);
    const v = db.resp[tabla + ':' + op];
    // COLA por clave: sembrar un array responde una vez por elemento. Sin esto, las DOS
    // lecturas de `/auth/callback` sobre `usuarios` reciben lo mismo, y el caso que separa
    // "no caigo al fallback" de "caigo al fallback y da igual" **no puede existir** — es
    // exactamente la evasión que dejó ese test verde contra su propia mutación.
    if (Array.isArray(v)) return v.length ? v.shift() : { data: null, error: null };
    return v !== undefined ? v : { data: null, error: null };
  };
  for (const m of ['select', 'eq', 'neq', 'in', 'is', 'not', 'gte', 'lte', 'order', 'limit', 'ilike']) c[m] = () => c;
  c.insert = () => { op = 'insert'; return c; };
  c.update = () => { op = 'update'; return c; };
  c.maybeSingle = async () => resultado();
  // **`single()` NO es igual a `maybeSingle()`, y hacerlos iguales dejaba sin cobertura la
  // distinción que este trabajo declara load-bearing en cinco sitios.** PostgREST devuelve
  // PGRST116 cuando un `.single()` no encuentra fila; ése es todo el motivo por el que el
  // arreglo usa `maybeSingle` + `if (error)` separado del `if (!data)` en vez de un
  // `if (error)` a secas. Con los dos dobles idénticos, revertir un `.maybeSingle()` a
  // `.single()` dejaba la suite entera en verde — medido por la revisión adversarial — y en
  // producción esa mutación convierte cada 404 legítimo en un 500. Ahora la mata este doble.
  c.single = async () => {
    const r = resultado();
    return (r.data == null && !r.error) ? { data: null, error: SIN_FILAS } : r;
  };
  c.then = (res, rej) => Promise.resolve(resultado()).then(res, rej);
  return c;
}

const logMock = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };
const activarProMock = vi.fn(async () => ({ venceStr: '30-sep-26' }));
const registrarSolicitudProMock = vi.fn(async () => ({ pagoId: 'p1', comprobantePath: 'x', usuarioMarcado: true }));
const registrarReferidoMock = vi.fn(async () => {});
const enviarWhatsappMock = vi.fn(async () => ({ ok: true }));
/**
 * `gmail.js` sale a una variable porque `/auth/callback` la maneja: cada caso decide qué
 * devuelve `verificarState` (o sea si viene `uid`, `num`, o los dos) sin tener que fabricar un
 * state firmado. El `getToken` resuelve siempre: lo que estos casos miden es lo que pasa
 * **después** del canje, que es donde vivía el 404 sobre una lectura caída.
 */
const gmailMock = {
  oauth2Client: { getToken: vi.fn(async () => ({ tokens: { refresh_token: 'rt' } })), setCredentials: vi.fn() },
  obtenerPerfilGoogle: vi.fn(async () => ({ email: 'x@gmail.com', nombre: 'X' })),
  guardarTokens: vi.fn(async () => {}), verificarState: vi.fn(() => ({ uid: 'u1', modo: 'inicial' })),
  emailGmailVinculado: vi.fn(async () => ({ email: null, emailHash: null })),
  esElMismoGmail: vi.fn(() => true),
  generarUrlAutorizacion: vi.fn(() => 'https://accounts.google.com/x'),
  BANCOS_CATALOGO: [], revocarAccesoGmail: vi.fn(),
};

const stubs = [
  ['lib/logger.js', logMock],
  ['lib/db.js', { supabase: { from: (t) => cadena(t) } }],
  ['lib/whatsapp.js', { enviarWhatsapp: enviarWhatsappMock, META_ERR_FUERA_VENTANA: 131047 }],
  ['lib/analytics.js', { capture: vi.fn(), default: { capture: vi.fn() } }],
  ['lib/notify-user.js', { notificarUsuario: vi.fn(async () => ({})), CANALES: { AMBOS: 'ambos', SOLO_WHATSAPP: 'wa', SOLO_IN_APP: 'app' } }],
  ['lib/trial.js', { esProPagado: () => true, linkPanelPro: () => 'https://app.neto.pe/dashboard/pro' }],
  ['lib/pro-payment.js', {
    activarPro: activarProMock,
    reclamarPagoPendiente: vi.fn(async () => true),
    registrarSolicitudPro: registrarSolicitudProMock,
  }],
  ['services/referrals.js', {
    registrarReferido: registrarReferidoMock,
    resumenReferidoParaAdmin: vi.fn(async () => ({ descuentoPct: 0, referrerId: null, referrerNombre: null, yaPremiado: false, parcial: false })),
  }],
  ['services/parsers.js', { parsearCorreoBancario: vi.fn() }],
  ['lib/support-tickets.js', { responderTicket: vi.fn(), contactarUsuario: vi.fn() }],
  ['helpers/db-helpers.js', { guardarMensaje: vi.fn(async () => {}) }],
  ['services/gmail-scanner.js', { escanearGmailYRegistrar: vi.fn(), escanearHistoricoInicial: vi.fn() }],
  ['gmail.js', gmailMock],
];
for (const [rel, exports] of stubs) {
  const p = require.resolve(path.join(projectRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const express = require('express');
const adminRoutes = require('../../routes/admin');
const publicRoutes = require('../../routes/public');
const proRoutes = require('../../routes/pro');
const internalRoutes = require('../../routes/internal');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
// Mismo wiring que `index.js`, sin los rate limiters: montarlo distinto haría que el test pase
// con un servidor que no es el que corre en producción.
app.use('/pro', proRoutes);
app.use('/internal', internalRoutes);
app.use('/admin', adminRoutes);
// El público va ÚLTIMO, igual que en `index.js`: tiene rutas de catch-all.
app.use('/', publicRoutes);

let servidor, base;
await new Promise((r) => { servidor = app.listen(0, () => { base = 'http://127.0.0.1:' + servidor.address().port; r(); }); });
afterAll(() => new Promise((r) => servidor.close(r)));

const ENV = { ...process.env };
beforeEach(() => {
  db.resp = {};
  db.llamadas = [];
  vi.clearAllMocks();
  process.env.ADMIN_KEY = 'clave-admin-de-prueba';
  process.env.INTERNAL_API_KEY = 'clave-interna-de-prueba';
  gmailMock.verificarState.mockReturnValue({ uid: 'u1', modo: 'inicial' });
  gmailMock.oauth2Client.getToken.mockResolvedValue({ tokens: { refresh_token: 'rt' } });
});
afterAll(() => { process.env = ENV; });

const ADMIN = { 'x-admin-key': 'clave-admin-de-prueba', 'Content-Type': 'application/json' };
const INTERNA = { 'x-internal-key': 'clave-interna-de-prueba', 'Content-Type': 'application/json' };

const get = (ruta, headers) => fetch(base + ruta, { headers });
const post = (ruta, cuerpo, headers) => fetch(base + ruta, { method: 'POST', headers, body: JSON.stringify(cuerpo) });

/**
 * El molde de todos los casos: MISMA petición, dos siembras, y los dos códigos tienen que
 * diferir. Sin la segunda mitad, el test no distingue "arreglado" de "siempre contesta 500".
 */
async function caidaVsVacio(pedir, { claveCaida, esperado = 500, cuandoVacio }) {
  db.resp = { [claveCaida]: CAIDA };
  const conCaida = await pedir();
  db.resp = { [claveCaida]: VACIO };
  const conVacio = await pedir();
  expect(conCaida.status, 'con la lectura caída').toBe(esperado);
  expect(conVacio.status, 'CONTROL: con cero filas').toBe(cuandoVacio);
  expect(conCaida.status, 'los dos casos contestan lo mismo: la ruta no los distingue')
    .not.toBe(conVacio.status);
  return conCaida;
}

describe('routes/admin.js: una lectura caída no es "no existe"', () => {
  it('/activar: 500 al no poder leer, 404 cuando el usuario no está', async () => {
    // La lectura muda contestaba **404 "Usuario no encontrado"** al admin que acaba de pedir un
    // comp. Es la ruta que el enunciado del ítem citaba como "activa Pro después de un pago";
    // el pago va por `/aprobar-pago`, que ya leía su error desde antes. La mentira es la misma.
    await caidaVsVacio(() => post('/admin/activar', { whatsapp: '51999888777' }, ADMIN),
      { claveCaida: 'usuarios:select', cuandoVacio: 404 });
    expect(activarProMock, 'se activó Pro sobre una lectura que nunca respondió').not.toHaveBeenCalled();
  });

  it('/pendientes: 500 en vez de una lista vacía con ok:true', async () => {
    // El peor de los cuatro de lectura: `pendientes: []` con `ok: true` es literalmente "no hay
    // nadie esperando", y del otro lado hay alguien que pagó y mandó su comprobante.
    db.resp = { 'usuarios:select': CAIDA };
    const caida = await get('/admin/pendientes', ADMIN);
    expect(caida.status).toBe(500);
    expect((await caida.json()).ok).toBe(false);

    db.resp = { 'usuarios:select': { data: [], error: null } };
    const vacio = await get('/admin/pendientes', ADMIN);
    expect(vacio.status, 'CONTROL: cero pendientes sigue siendo 200').toBe(200);
    expect(await vacio.json()).toEqual({ ok: true, pendientes: [] });
  });

  it('/usuarios: 500 en vez de afirmar que no hay ni un registrado', async () => {
    db.resp = { 'usuarios:select': CAIDA };
    expect((await get('/admin/usuarios', ADMIN)).status).toBe(500);
    db.resp = { 'usuarios:select': { data: [], error: null } };
    const vacio = await get('/admin/usuarios', ADMIN);
    expect(vacio.status).toBe(200);
    expect((await vacio.json()).total, 'CONTROL: cero usuarios sigue siendo un 200 con total 0').toBe(0);
  });

  it('/pagos: 500 en vez de una constancia de suscripción vacía', async () => {
    db.resp = { 'pagos:select': CAIDA };
    expect((await get('/admin/pagos?usuario_id=u1', ADMIN)).status).toBe(500);
    db.resp = { 'pagos:select': { data: [], error: null } };
    expect((await get('/admin/pagos?usuario_id=u1', ADMIN)).status, 'CONTROL').toBe(200);
  });

  it('/errores: 500 en vez de decir que no hay errores mientras la tabla no responde', async () => {
    db.resp = { 'errores:select': CAIDA };
    expect((await get('/admin/errores', ADMIN)).status).toBe(500);
    db.resp = { 'errores:select': { data: [], error: null } };
    const vacio = await get('/admin/errores', ADMIN);
    expect(vacio.status, 'CONTROL').toBe(200);
    expect((await vacio.json()).total).toBe(0);
  });

  it('/stats: las SEIS lecturas cortan, y cada una nombra cuál falló', async () => {
    // Un tablero a medias con `ok: true` es peor que ninguno: una métrica en cero porque la
    // base no contestó es indistinguible de un cero real. Se ejercitan las dos tablas por
    // separado para que el corte no dependa de que la primera query sea la que falla.
    db.resp = { 'usuarios:select': CAIDA };
    const porUsuarios = await get('/admin/stats', ADMIN);
    expect(porUsuarios.status).toBe(500);
    expect((await porUsuarios.json()).msg, 'el mensaje no dice qué consulta falló').toMatch(/usuarios/);

    db.resp = { 'transacciones:select': CAIDA };
    const porTx = await get('/admin/stats', ADMIN);
    expect(porTx.status).toBe(500);
    expect((await porTx.json()).msg).toMatch(/transacciones/);

    db.resp = {};
    const sano = await get('/admin/stats', ADMIN);
    expect(sano.status, 'CONTROL: sin errores el tablero responde 200').toBe(200);
  });

  it('/notify por usuario_id: 500 al no poder leer, 404 si no existe', async () => {
    await caidaVsVacio(() => post('/admin/notify', { usuario_id: 'u1', mensaje: 'hola' }, ADMIN),
      { claveCaida: 'usuarios:select', cuandoVacio: 404 });
  });

  it('/notify por número FALLA ABIERTO: manda igual y lo dice en saved_in_history', async () => {
    // El único de este archivo que sigue adelante. Si alguien lo "arregla" a 500, esto se pone
    // rojo: esa lectura sólo sirve para archivar, y el número ya está validado.
    db.resp = { 'usuarios:select': CAIDA };
    const res = await post('/admin/notify', { whatsapp: '51999888777', mensaje: 'hola' }, ADMIN);
    expect(res.status, 'una lectura de archivado no puede frenar un mensaje válido').toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo.ok).toBe(true);
    expect(cuerpo.saved_in_history, 'dice que no se archivó, en vez de callarlo').toBe(false);
    expect(enviarWhatsappMock, 'no se mandó el mensaje').toHaveBeenCalledTimes(1);
    // Y que el fallo quedó registrado: sin log, un mensaje sin fila en `conversaciones` no
    // deja ni un rastro de por qué.
    expect(logMock.error).toHaveBeenCalled();
  });

  it('/referido-web: 500 en vez de "ese código no existe" — de ahí cuelga plata', async () => {
    // El default de esta ruta con la lectura muda era `{ ok: true, linked: false }`, o sea un
    // no-op EXITOSO: nadie reintenta eso, y el vínculo (1 mes gratis + 50% off) se perdía.
    db.resp = { 'usuarios:select': CAIDA };
    const caida = await post('/admin/referido-web', { ref_code: 'ABCD', referido_id: 'u2' }, ADMIN);
    expect(caida.status).toBe(500);
    expect(registrarReferidoMock).not.toHaveBeenCalled();

    db.resp = { 'usuarios:select': VACIO };
    const vacio = await post('/admin/referido-web', { ref_code: 'ABCD', referido_id: 'u2' }, ADMIN);
    expect(vacio.status, 'CONTROL: un código inexistente sigue siendo un no-op con 200').toBe(200);
    expect(await vacio.json()).toEqual({ ok: true, linked: false });
  });
});

describe('routes/pro.js e internal.js: lo que ve alguien que ya pagó', () => {
  it('/pro/solicitud: 500 al no poder leer al usuario, 404 si no existe', async () => {
    // Del otro lado de este 404 hay alguien subiendo el comprobante de un pago que YA hizo.
    const pedir = () => fetch(base + '/pro/solicitud', {
      method: 'POST',
      headers: { ...INTERNA, 'Content-Type': 'application/octet-stream', 'x-usuario-id': 'u1' },
      body: Buffer.from('imagen-falsa'),
    });
    await caidaVsVacio(pedir, { claveCaida: 'usuarios:select', cuandoVacio: 404 });
    expect(registrarSolicitudProMock).not.toHaveBeenCalled();
  });

  it('/pro/solicitud: el anti-abuso de `pagos` FALLA CERRADO', async () => {
    // Con el error descartado, una caída daba `pendiente = null` y el gate se abría: segunda
    // fila en `pagos` y segundo comprobante en Storage para el mismo usuario.
    db.resp = { 'usuarios:select': { data: { id: 'u1', plan: 'free' }, error: null }, 'pagos:select': CAIDA };
    const caida = await fetch(base + '/pro/solicitud', {
      method: 'POST',
      headers: { ...INTERNA, 'Content-Type': 'application/octet-stream', 'x-usuario-id': 'u1' },
      body: Buffer.from('imagen-falsa'),
    });
    expect(caida.status).toBe(500);
    expect(registrarSolicitudProMock, 'se creó una segunda solicitud sobre una lectura caída').not.toHaveBeenCalled();

    db.resp = { 'usuarios:select': { data: { id: 'u1', plan: 'free' }, error: null }, 'pagos:select': VACIO };
    const vacio = await fetch(base + '/pro/solicitud', {
      method: 'POST',
      headers: { ...INTERNA, 'Content-Type': 'application/octet-stream', 'x-usuario-id': 'u1' },
      body: Buffer.from('imagen-falsa'),
    });
    expect(vacio.status, 'CONTROL: sin solicitud pendiente, la solicitud se crea').toBe(200);
    expect(registrarSolicitudProMock).toHaveBeenCalledTimes(1);
  });

  it('/pro/gmail-auth-url: 500 al no poder leer, 404 si no existe', async () => {
    await caidaVsVacio(() => get('/pro/gmail-auth-url?usuario_id=u1', INTERNA),
      { claveCaida: 'usuarios:select', cuandoVacio: 404 });
  });

  it('/internal/activacion-completada: 500 en vez de 404 sobre una cuenta recién vinculada', async () => {
    // Acá el usuario existe por construcción —la webapp acaba de vincularlo—, así que un 404
    // sólo podía ser una lectura caída, y se llevaba el WhatsApp de confirmación y el evento
    // del embudo (paso 200) sin dejar rastro.
    await caidaVsVacio(() => post('/internal/activacion-completada', { usuario_id: 'u1' }, INTERNA),
      { claveCaida: 'usuarios:select', cuandoVacio: 404 });
  });
});

describe('routes/public.js: el callback de OAuth y la mini-landing', () => {
  // **Este bloque existe porque la revisión adversarial midió que NO existía.** El docblock de
  // arriba afirmaba que los dos fail-open del callback "tienen su caso acá", y `auth/callback`
  // sólo aparecía en comentarios: las nueve combinaciones de resolución y el 503 con
  // `no-store` estaban afirmados únicamente en prosa. Es la clase `feedback_guards_que_no_ven`
  // en su forma más incómoda: declarar cobertura que no se tiene.

  it('/api/referidor: 503 con no-store al no poder leer, 404 si el código no existe', async () => {
    // El 404 viaja con `Cache-Control: public, max-age=300`, así que una caída de 5 segundos se
    // cacheaba 5 MINUTOS como "ese código no existe". El header es la mitad del arreglo.
    db.resp = { 'usuarios:select': CAIDA };
    const caida = await get('/api/referidor/ABCD', {});
    expect(caida.status).toBe(503);
    expect(caida.headers.get('cache-control'), 'un parpadeo se sigue cacheando como veredicto').toMatch(/no-store/);

    db.resp = { 'usuarios:select': VACIO };
    const vacio = await get('/api/referidor/ABCD', {});
    expect(vacio.status, 'CONTROL: un código inexistente sigue siendo 404').toBe(404);
    expect(vacio.headers.get('cache-control'), 'CONTROL: el 404 legítimo SÍ se cachea').toMatch(/max-age=300/);

    db.resp = { 'usuarios:select': { data: { nombre: 'Ana Pérez' }, error: null } };
    const ok = await get('/api/referidor/ABCD', {});
    expect(ok.status, 'CONTROL: el camino feliz').toBe(200);
    expect((await ok.json()).nombre).toBe('Ana');
  });

  it('/auth/callback: la lectura del uid caída NO cae al fallback por número', async () => {
    // La fila del `uid` y la del `whatsapp` pueden ser personas distintas (identidad partida:
    // ver `persistirBsuidConEstado`, hallazgo B21, y `merge_and_link` de la migración 046).
    // Con el error descartado, un parpadeo mandaba el refresh token de Gmail —y con él los
    // correos bancarios— a la fila equivocada, en la ruta cuyo comentario dice "NUNCA
    // adivinamos el usuario".
    //
    // **La siembra es una COLA de dos, y ésa es la mitad que hace el caso.** La primera versión
    // sembraba `CAIDA` a secas: las dos lecturas recibían el error, el fallback tampoco
    // resolvía, y salía 500 **con o sin la guarda**. Verificado por mutación — el caso pasaba
    // 21/21 en verde contra su propio revert. Acá la segunda lectura SÍ encuentra, y encuentra
    // a OTRO usuario, que es el escenario entero.
    gmailMock.verificarState.mockReturnValue({ uid: 'u1', num: '51999888777', modo: 'inicial' });
    db.resp = { 'usuarios:select': [CAIDA, { data: { id: 'OTRA-PERSONA', plan: 'premium', trial_estado: 'convertido' }, error: null }] };
    const res = await get('/auth/callback?code=abc&state=s', {});
    expect(res.status, 'se resolvió por número una identidad que el uid no pudo confirmar').toBe(500);
    expect(gmailMock.guardarTokens, 'se guardaron los tokens de Gmail en la fila equivocada').not.toHaveBeenCalled();
  });

  it('/auth/callback: CONTROL — sin uid, el fallback por número sigue funcionando', async () => {
    // La mitad que impide que "no caer al fallback" se vuelva "no hay fallback". Éste es el
    // camino de TODOS los flujos de WhatsApp, que no mandan uid.
    gmailMock.verificarState.mockReturnValue({ num: '51999888777', modo: 'inicial' });
    db.resp = { 'usuarios:select': { data: { id: 'u9', plan: 'premium', trial_estado: 'convertido' }, error: null } };
    const res = await get('/auth/callback?code=abc&state=s', {});
    expect(res.status, 'el fallback por número dejó de resolver').toBe(200);
    expect(gmailMock.guardarTokens).toHaveBeenCalled();
  });

  it('/auth/callback: 404 sólo cuando la lectura respondió y no había fila', async () => {
    gmailMock.verificarState.mockReturnValue({ num: '51999888777', modo: 'inicial' });
    db.resp = { 'usuarios:select': VACIO };
    const res = await get('/auth/callback?code=abc&state=s', {});
    expect(res.status).toBe(404);
    expect(await res.text()).toMatch(/No se encontró tu cuenta/);
  });

  it('/auth/callback: sin uid y con la lectura por número caída, 500 y no 404', async () => {
    gmailMock.verificarState.mockReturnValue({ num: '51999888777', modo: 'inicial' });
    db.resp = { 'usuarios:select': CAIDA };
    const res = await get('/auth/callback?code=abc&state=s', {});
    expect(res.status).toBe(500);
    // El 404 que había llegaba DESPUÉS del `getToken`, o sea con el code ya canjeado (es de un
    // solo uso) y el consentimiento de Google ya gastado: al usuario se le decía "no se
    // encontró tu cuenta" y tenía que rehacer el OAuth entero.
    expect(gmailMock.oauth2Client.getToken, 'el canje ya ocurrió: por eso el texto importa').toHaveBeenCalled();
    expect(await res.text()).toMatch(/No pudimos leer tu cuenta/);
  });

  /**
   * ─── LOS DOS UPDATE FAIL-OPEN, ahora con COMPORTAMIENTO y no sólo con el guard de forma ───
   *
   * El docblock de arriba declaraba, hasta el 01-sep-2026, que estos dos quedaban "bajo el
   * guard de forma nada más" porque llegar hasta ellos pedía "montar medio flujo de OAuth".
   * Esa estimación era de cuando `/auth/callback` no se montaba: hoy el router público está
   * acá, `gmail.js` entero está en un doble que ya resuelve `obtenerPerfilGoogle`,
   * `emailGmailVinculado` y `guardarTokens`, y `lib/trial.js` responde `esProPagado: true`. O
   * sea que el camino feliz ya lo recorren tres casos de este mismo archivo, y lo único que
   * faltaba era sembrar el error en el `usuarios:update`.
   *
   * **Y hacía falta, porque el guard de forma no puede ver la DIRECCIÓN del fallo.** Estos dos
   * son de los que siguen adelante a propósito, así que la mutación peligrosa no es borrar el
   * `if (error)` —eso lo atrapa el guard estático— sino "completar el trabajo" convirtiéndolos
   * en un corte. Un `return res.status(500)` ahí transforma una conexión de Gmail EXITOSA,
   * con los tokens ya guardados, en un error a la vista del usuario; y en el segundo,
   * silenciar el "¡Listo!" no arregla el flag y encima borra una confirmación cierta.
   *
   * La siembra es una COLA sobre `usuarios:update`: la primera es la del perfil, la segunda la
   * del cierre de onboarding. Sin cola, sembrar el error alcanzaría a las dos y ninguno de los
   * dos casos diría cuál de las dos ramas midió.
   */
  describe('/auth/callback: los dos UPDATE que fallan ABIERTO siguen fallando abierto', () => {
    /** El destinatario: Pro pagado, resuelto por número, con Gmail nuevo y modo inicial. */
    const listo = (extra) => {
      gmailMock.verificarState.mockReturnValue({ num: '51999888777', modo: 'inicial' });
      db.resp = {
        'usuarios:select': { data: { id: 'u9', whatsapp: '51999888777', nombre: null, plan: 'premium', trial_estado: 'convertido', historico_importado: true }, error: null },
        ...extra,
      };
    };
    // `redirect: 'manual'` y no el default: el camino feliz termina en un 302 a app.neto.pe, y
    // seguirlo haría que esta suite salga a internet de verdad.
    const canjear = () => fetch(base + '/auth/callback?code=abc&state=s', { redirect: 'manual' });

    it('el UPDATE del perfil de Google caído NO convierte la conexión en un error', async () => {
      listo({ 'usuarios:update': [CAIDA] });
      const res = await canjear();

      // Lo que importa: los tokens YA se guardaron y el OAuth fue un éxito. Lo único que se
      // pierde es el nombre y el email de perfil, que no gatean nada.
      expect(gmailMock.guardarTokens, 'el fixture no llegó al UPDATE: el caso no prueba nada').toHaveBeenCalled();
      expect(res.status, 'un UPDATE accesorio caído rompió una conexión buena').toBe(302);
      expect(res.headers.get('location')).toMatch(/gmail=conectado/);
      // Y deja rastro: sin el log, el usuario queda sin nombre y nadie sabe por qué.
      const mio = logMock.error.mock.calls.filter((c) => c[0] && c[0].tag === 'OAUTH');
      expect(mio.length, 'el UPDATE caído se fue mudo').toBeGreaterThan(0);
      expect(JSON.stringify(mio)).toMatch(/perfil de Google/);
    });

    it('CONTROL: con el UPDATE sano, mismo 302 y ningún error', async () => {
      // Sin esta mitad, una ruta que devolviera 302 y logueara SIEMPRE pasaría el caso de
      // arriba, y el `toBe(302)` no distinguiría nada.
      listo({ 'usuarios:update': [{ data: null, error: null }] });
      const res = await canjear();

      expect(res.status).toBe(302);
      expect(logMock.error.mock.calls.filter((c) => c[0] && c[0].tag === 'OAUTH')).toEqual([]);
    });

    it('el UPDATE de onboarding_completado caído deja dicho que el alta se va a repetir', async () => {
      // Corre DENTRO del `setTimeout(2000)` que arranca después del redirect, así que el caso
      // espera por el efecto en vez de por la respuesta. La cola pone el error en la SEGUNDA
      // escritura: la primera (el perfil) va sana, para que lo que se mida sea ésta.
      listo({ 'usuarios:update': [{ data: null, error: null }, CAIDA] });
      const res = await canjear();
      expect(res.status).toBe(302);

      const suyo = () => logMock.error.mock.calls.filter(
        (c) => c[0] && c[0].tag === 'CALLBACK' && /no se pudo cerrar el onboarding/.test(String(c[1])),
      );
      // Sondeo en vez de un sleep fijo: el `setTimeout` son 2s y un sleep justo encima lo hace
      // flakear en una máquina cargada, que es la clase `flake-de-umbral` de DEFECTOS.
      const limite = Date.now() + 8000;
      while (suyo().length === 0 && Date.now() < limite) await new Promise((r) => setTimeout(r, 100));

      expect(suyo().length, 'el flag no se pudo cerrar y no quedó una línea: se ve como onboarding repetido sin causa').toBeGreaterThan(0);
      // Y el efecto que NO se apaga: el usuario conectó Gmail de verdad, así que el "listo"
      // sigue siendo cierto. Callarlo no arregla el flag y borra una confirmación real.
      expect(enviarWhatsappMock, 'se silenció una confirmación cierta por un flag que no pegó').toHaveBeenCalled();
    });
  });
});

describe('antivacuidad: el harness ejercita de verdad', () => {
  it('las rutas responden 200 con la base sana (si no, los 500 no prueban nada)', async () => {
    // El primer modo de fallo de `feedback_guards_que_no_ven`: un harness mal cableado devuelve
    // 500 en TODOS los casos y los tests de arriba pasarían sin que ningún arreglo exista.
    db.resp = {};
    expect((await get('/admin/pendientes', ADMIN)).status).toBe(200);
    expect((await get('/admin/errores', ADMIN)).status).toBe(200);
    expect((await get('/admin/stats', ADMIN)).status).toBe(200);
  });

  it('el doble de supabase se USA (si nadie lo llama, sembrar una caída no siembra nada)', async () => {
    db.resp = {};
    db.llamadas = [];
    await get('/admin/stats', ADMIN);
    expect(db.llamadas.length, 'la ruta no tocó el doble: está leyendo de otro lado').toBeGreaterThan(3);
    expect(db.llamadas).toContain('usuarios:select');
    expect(db.llamadas).toContain('transacciones:select');
  });

  it('la auth sigue viva: sin clave no se llega a ninguna lectura', async () => {
    // Si el harness dejara pasar sin credencial, los casos de arriba estarían midiendo el 401.
    expect((await get('/admin/pendientes', { 'Content-Type': 'application/json' })).status).toBe(401);
    expect((await get('/pro/gmail-auth-url?usuario_id=u1', { 'Content-Type': 'application/json' })).status).toBe(401);
  });
});
