import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(import.meta.url);

/**
 * CONFIRMACIÓN INCONDICIONAL — las 6 escrituras de `handlers/webhook.js` (ítem 9B-ter).
 *
 * Quinta superficie de la misma clase (9A plata, 9A-bis cero filas, 9D el alta, 9B-bis los
 * intents), y **no es un resto**. Dos de las seis son peores que cualquiera de las quince que
 * cerró 9B-bis:
 *
 *   · **`ref_code` es el `ver_referidos` que DE VERDAD CORRE.** Esta rama matchea texto libre
 *     por regex (`mis referidos`, `link de referido`, `quiero invitar`…), y
 *     `procesarMensajeLibre` —lo único que llega al intent de `premium.js`— es el `else` del
 *     final de esta misma cascada. O sea que 9B-bis arregló la cola y las frases comunes se
 *     quedaron mudas. Eso no se afirma de palabra acá: se MIDE, abajo, con el spy de
 *     `procesarMensajeLibre` y su control negativo.
 *   · **`recordatorios_activos` es el ejemplo canónico de la clase**, citado por línea en el
 *     docblock de `tests/cron/lecturas-leen-el-error.test.js`. 9B-bis arregló el gemelo
 *     (`moderacion.js:22/63`) y dejó vivo el original que lo nombra.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * LO QUE ESTE ARCHIVO TIENE QUE PODER DISTINGUIR, y es lo que define el mock
 *
 * Tres desenlaces, no dos:
 *
 *   1. **la escritura FALLÓ**       → `fallos`, que fabrica el `{ error }` de postgrest
 *   2. **no tocó NINGUNA fila**     → la fila objetivo NO se siembra, así que las cero filas
 *      las produce el `.eq('id', …)` del propio statement. No es un stub: es el mecanismo de
 *      producción (`merge_and_link` movió la identidad, la cuenta se borró en el medio) y
 *      además **mata la mutación que le quita el WHERE**
 *   3. **el efecto NO ocurrió**     → se prueba **RE-LEYENDO LA FILA**, nunca mirando el
 *      mensaje. Es la única de las tres que el copy no puede fingir
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * EL HARNESS ES TRANSFERIDO, NO REINVENTADO
 *
 * La lección que pagó 9A-bis: llevar la clase de bug a otro archivo **sin llevar los
 * accesorios** produjo 14 supervivientes con la suite en verde. Van los cinco de 9B-bis:
 * `filtros(tabla,verbo)` para ver el WHERE, `lanza` para fabricar el rechazo que postgrest-js
 * no produce, `single` ≠ `maybeSingle` con `PGRST116`, el RETURNING modelado (sin el cual
 * borrar un `.select('id')` no cambiaría nada acá y en producción lo cambia todo), y el ESTADO
 * (un update que entra aplica su patch y uno que falla no). Más el control anti-vacuidad:
 * **el camino feliz afirma CERO logs**, que es lo único que mata el `.select()` borrado.
 *
 * Y `antesDeEscribir`, que acá no es de adorno: el bloque del OTP **LEE `webapp_otp` y después
 * la ESCRIBE**, así que no sembrar la fila haría fallar la lectura y el update nunca se
 * intentaría — verde por otra condición.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * LAS DOS DIFERENCIAS CON 9B-bis, y las dos cambian el harness
 *
 *   · **`webhook.js` NO recibe `supabase` por `ctx`**: lo destructura de `lib/db` al cargar.
 *     Hay que pisarlo en el require-cache ANTES de requerir el módulo, como hace 9D
 *     (`escrituras-del-alta.test.js`), no como 9B-bis.
 *   · **`webhook.js` es una CASCADA de `else if` sobre `cmd`, no un `switch` que devuelve.**
 *     No hay valor de retorno que afirmar: las ramas ASIGNAN `respuesta`, que se manda una vez
 *     al salir. Así que la entrada es un POST firmado con HMAC al handler REAL —el mismo
 *     camino que corre en producción, muro incluido— y la salida es lo que recibió
 *     `enviarWhatsapp`. Es el patrón de los ocho `webhook-*.test.js` que ya existen.
 */

process.env.META_APP_SECRET = 'test-secret';

// ─── Las dependencias que `webhook.js` DESTRUCTURA al cargar ─────────────────
// Se reemplazan ANTES de requerirlo: la destructuración captura la referencia para siempre.

const enviarWhatsapp = vi.fn().mockResolvedValue(undefined);
require('../../lib/whatsapp').enviarWhatsapp = enviarWhatsapp;

const obtenerOCrearUsuario = vi.fn();
require('../../helpers/db-helpers').obtenerOCrearUsuario = obtenerOCrearUsuario;
require('../../helpers/db-helpers').guardarMensaje = vi.fn().mockResolvedValue(undefined);
require('../../helpers/db-helpers').getUserPlanConfig = vi.fn(() => ({ resumenDiario: true, maxGmailAccounts: 3 }));

const manejarOnboarding = vi.fn().mockResolvedValue(null);
require('../../handlers/onboarding').manejarOnboarding = manejarOnboarding;

// El muro se evalúa en la cascada de `/` y `/categorias` está detrás de él. No se mueve nada
// de eso: se declara fuera del muro, que es la precondición de los cinco sitios de la tabla.
require('../../lib/trial').estaEnMuro = vi.fn(() => false);

// `generarRefCode` es aleatorio; fijarlo es lo que permite que `efectoOk` sea un valor y no
// una forma.
require('../../lib/formatters').generarRefCode = vi.fn(() => 'REF9999');

const obtenerCategoriasUsuario = vi.fn().mockResolvedValue(null);
require('../../services/categories').obtenerCategoriasUsuario = obtenerCategoriasUsuario;

const obtenerEstadisticasReferidos = vi.fn().mockResolvedValue({ total: 0, pagados: 0, mesesGanados: 0 });
require('../../services/referrals').obtenerEstadisticasReferidos = obtenerEstadisticasReferidos;
require('../../services/referrals').mensajeMisReferidos = (code) => 'Tu código de referido es ' + code;
const registrarReferido = vi.fn().mockResolvedValue(undefined);
require('../../services/referrals').registrarReferido = registrarReferido;

const registrarError = vi.fn().mockResolvedValue(undefined);
require('../../lib/error-monitor').registrarError = registrarError;
const notificarErrorAdmin = vi.fn().mockResolvedValue(undefined);
require('../../lib/admin-notify').notificarErrorAdmin = notificarErrorAdmin;
require('../../lib/analytics').capture = vi.fn();

// ─── El doble de Supabase (transferido de 9B-bis / 9D) ───────────────────────
//
// Se instala UNA vez —la destructuración de `webhook.js` guarda esta referencia para siempre—
// y delega en el mock del test en curso.

let sbActual = null;
require('../../lib/db').supabase = {
  from: (tabla) => {
    if (!sbActual) throw new Error('el test no montó un mock de supabase (llamá a montar())');
    return sbActual.from(tabla);
  },
  rpc: (nombre, args) => {
    if (!sbActual) throw new Error('el test no montó un mock de supabase (llamá a montar())');
    return sbActual.rpc(nombre, args);
  },
};

const MUTANTES = ['insert', 'update', 'delete', 'upsert'];

/**
 * @param filas  `{ tabla: [fila, …] }`. Las filas se MUTAN: un update que entra aplica su
 *               patch, que es lo que permite re-leer el estado en vez de creerle al mensaje.
 * @param fallos `{'tabla:verbo': 'motivo'}` o un ARRAY indexado por número de llamada.
 *               `'rpc:merge_and_link'` también es una clave válida.
 * @param vacios `'tabla:verbo'` — stub declarado de "cero filas". **Casi no se usa**: los casos
 *               de 0 filas se construyen NO sembrando la fila objetivo, para que las cero filas
 *               las produzca el WHERE real. Un caso así también muere si alguien le quita el
 *               `.eq('id', …)`; el stub no.
 * @param lanza  `'tabla:verbo'` — fabrica un RECHAZO de la promesa.
 * @param rpcs   `{ nombre: valor }` — lo que devuelve `supabase.rpc(nombre)`.
 * @param antesDeEscribir `(tabla, verbo, filas) => void`, justo antes de que una escritura
 *        resuelva. Acá lo pide el bloque del OTP, que LEE `webapp_otp` y después la escribe:
 *        sacarla de la siembra rompería la lectura y el update no llegaría a intentarse.
 */
function montar({ filas = {}, fallos = {}, vacios = [], lanza = [], rpcs = {}, antesDeEscribir = null } = {}) {
  const llamadas = [];
  const nth = {};
  const fallo = (clave) => {
    const f = fallos[clave];
    if (f === undefined) return null;
    if (!Array.isArray(f)) return f;
    const i = (nth[clave] = (nth[clave] || 0) + 1) - 1;
    return f[i] || null;
  };
  const tabla_ = (t) => (filas[t] = filas[t] || []);

  const sb = {
    _llamadas: llamadas,
    intento: (tabla, verbo) => llamadas.some((c) => c.tabla === tabla && c.verbo === verbo),
    cuenta: (tabla, verbo) => llamadas.filter((c) => c.tabla === tabla && c.verbo === verbo).length,
    filtros: (tabla, verbo, n = 0) => ((llamadas.filter((c) => c.tabla === tabla && c.verbo === verbo)[n]) || {}).filtros || null,
    payload: (tabla, verbo, n = 0) => ((llamadas.filter((c) => c.tabla === tabla && c.verbo === verbo)[n]) || {}).payload || null,
    /** Re-lectura del estado. Es la aserción que ningún copy puede fingir. */
    fila: (tabla, id) => (filas[tabla] || []).find((f) => f.id === id) || null,
    todas: (tabla) => (filas[tabla] || []).slice(),

    rpc: (nombre, args) => {
      llamadas.push({ tabla: 'rpc:' + nombre, verbo: 'rpc', payload: args, filtros: [] });
      const err = fallo('rpc:' + nombre);
      if (err) return Promise.resolve({ data: null, error: { message: err, code: 'XX000' } });
      return Promise.resolve({ data: nombre in rpcs ? rpcs[nombre] : 'linked', error: null });
    },

    from(tabla) {
      let verbo = 'select';
      const b = {};
      const filtros = [];
      const passthrough = ['ilike', 'gte', 'lte', 'not', 'order', 'limit'];
      for (const m of passthrough) b[m] = () => b;
      // **`.neq()` NO es passthrough, y dejarlo así borraba una guarda de plata.** La lectura
      // del referrer filtra `.neq('id', usuario.id)`, que es lo único que impide que alguien
      // se refiera a sí mismo con su propio código y se siembre el 50% off. Con el no-op, esa
      // guarda no la medía nadie. Lo encontró la revisión adversarial.
      const negativos = [];
      b.neq = (col, val) => { negativos.push([col, val]); return b; };

      // `.select()` sobre una escritura es su cláusula RETURNING. Sin modelarla el mock miente
      // en la dirección peligrosa: quitarle el `.select('id')` a un update no cambiaría nada
      // acá y en producción lo cambia todo.
      let retorno = false;
      let columnas = null;
      b.select = (cols) => {
        columnas = cols || columnas;
        if (verbo !== 'select') retorno = true;
        return b;
      };
      b.eq = (col, val) => { filtros.push([col, val]); return b; };
      b.is = (col, val) => { filtros.push([col, val]); return b; };

      for (const m of MUTANTES) {
        b[m] = (payload) => {
          if (verbo === 'select') { b.__payload = payload; verbo = m; llamadas.push({ tabla, verbo: m, payload, filtros }); }
          return b;
        };
      }

      const matchean = () => tabla_(tabla).filter((f) =>
        filtros.every(([c, v]) => f[c] === v) && negativos.every(([c, v]) => f[c] !== v));
      // Proyecta como PostgREST: `.select('id')` devuelve `{id}`, no la fila entera. Un doble
      // que devuelve todo hace invisible que a la query le falte una columna.
      const proyectar = (f) => {
        if (!columnas || columnas === '*') return { ...f };
        const out = {};
        for (const c of String(columnas).split(',').map((s) => s.trim())) out[c] = f[c];
        return out;
      };

      const resolver = () => {
        if (verbo === 'select') llamadas.push({ tabla, verbo: 'select', filtros });
        else if (antesDeEscribir) antesDeEscribir(tabla, verbo, filas);
        if (lanza.includes(tabla + ':' + verbo)) throw new Error('conexión cortada');
        const err = fallo(tabla + ':' + verbo);
        // Una escritura rechazada NO aplica su patch. Es la mitad del doble que hace que
        // re-leer la fila signifique algo.
        if (err) return { data: null, error: { message: err, code: 'XX000' } };
        if (verbo === 'select') return { data: matchean().map(proyectar), error: null };

        const mudo = vacios.includes(tabla + ':' + verbo);
        const objetivo = mudo ? [] : matchean();
        if (verbo === 'update') for (const f of objetivo) Object.assign(f, b.__payload);
        let insertadas = [];
        if (!mudo && (verbo === 'insert' || verbo === 'upsert')) {
          const nuevas = Array.isArray(b.__payload) ? b.__payload : [b.__payload];
          insertadas = nuevas.map((f, i) => ({ id: 'nueva-' + (tabla_(tabla).length + i + 1), ...f }));
          for (const f of insertadas) tabla_(tabla).push(f);
        }
        if (verbo === 'delete') {
          for (const f of objetivo) filas[tabla].splice(filas[tabla].indexOf(f), 1);
        }
        // Sin RETURNING no hay filas, pase lo que pase con el WHERE.
        if (!retorno) return { data: null, error: null };
        if (verbo === 'insert' || verbo === 'upsert') return { data: insertadas.map(proyectar), error: null };
        // Con RETURNING y cero coincidencias, postgrest devuelve `[]` (no `null`).
        return { data: objetivo.map(proyectar), error: null };
      };

      /**
       * `single()` y `maybeSingle()` NO son sinónimos. Sobre cero filas `single()` devuelve
       * `PGRST116` en `error` y `maybeSingle()` devuelve `{data:null, error:null}`: una guarda
       * que decide por `if (error)` se comporta al revés según cuál se haya escrito. Acá los
       * dos están vivos en el MISMO archivo — el referrer usa `single()`, el OTP usa
       * `maybeSingle()` — así que colapsarlos borraría la mitad de una de las dos decisiones.
       */
      const uno = (esSingle) => {
        const r = resolver();
        if (r.error) return r;
        const arr = Array.isArray(r.data) ? r.data : (r.data == null ? [] : [r.data]);
        if (arr.length === 1) return { data: arr[0], error: null };
        // **`maybeSingle()` tolera CERO, no "cualquier cantidad".** Con más de una fila
        // PostgREST devuelve `PGRST116` igual que `single()`; el doble devolvía la primera y
        // hacía invisible el caso del código de OTP duplicado, que no tiene índice único.
        if (!esSingle && arr.length === 0) return { data: null, error: null };
        return {
          data: null,
          error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' },
        };
      };
      b.single = async () => uno(true);
      b.maybeSingle = async () => uno(false);
      b.then = (ok, ko) => Promise.resolve(resolver()).then(ok, ko);
      b.catch = (ko) => Promise.resolve(resolver()).catch(ko);
      return b;
    },
  };
  return sb;
}

// ─── Espía de logs ───────────────────────────────────────────────────────────
// pino exporta un singleton CJS, así que el helper mira la MISMA referencia y el spy la ve.
const log = require('../../lib/logger');
const { TAG_ESCRITURA } = require('../../helpers/escritura-verificada');

function espiarLog() {
  const errores = [];
  const warns = [];
  const origE = log.error.bind(log);
  const origW = log.warn.bind(log);
  log.error = (...a) => { errores.push(a); };
  log.warn = (...a) => { warns.push(a); };
  const propios = (arr) => arr.filter((a) => a[0] && a[0].tag === TAG_ESCRITURA);
  return {
    errores, warns,
    /** Sólo lo que emite `verificarEscritura`: el resto del ruido del webhook no cuenta. */
    escrituras: () => [...propios(errores), ...propios(warns)],
    erroresDe: (sitio) => propios(errores).filter((a) => a[0].sitio === sitio),
    warnsDe: (sitio) => propios(warns).filter((a) => a[0].sitio === sitio),
    /** Los logs que NO son del helper, para las tres LECTURAS. */
    crudos: () => errores.filter((a) => !(a[0] && a[0].tag === TAG_ESCRITURA)),
    restaurar: () => { log.error = origE; log.warn = origW; },
  };
}

// ─── El handler real ─────────────────────────────────────────────────────────
const createWebhookHandler = require('../../handlers/webhook');
/** El único camino que llega a `handlers/intents/premium.js`. Ver la medición de intercepción. */
const procesarMensajeLibre = vi.fn().mockResolvedValue('respuesta-del-NLP');
const webhookHandler = createWebhookHandler(procesarMensajeLibre);

let wamidSeq = 0;

/**
 * **Un remitente nuevo por mensaje, y NO es cosmético: es el segundo limitador in-memory de
 * este módulo.** `webhook.js` tiene tres piezas de estado que viven en el módulo y no se
 * reinician entre tests — `wamidCache` (dedup, cubierto por el `wamidSeq`), `otpIntentos`
 * (5 intentos / 15 min) y el throttle por remitente (60 mensajes / minuto). Con un `from` fijo,
 * este archivo llegó a 39 de esos 60 en una corrida: cuatro sitios más en `SITIOS` y los tests
 * empiezan a recibir el throttle en vez de la rama que miden, con el rojo apuntando al lugar
 * equivocado. Ya pasó con `otpIntentos` en la primera corrida.
 *
 * Los tests que AFIRMAN sobre el número (`whatsapp_verified`) pasan el suyo explícito.
 */
let remitenteSeq = 0;
const numeroNuevo = () => '5199901' + String(1000 + (remitenteSeq++));

/** Un POST firmado, que es el camino real. Devuelve el ÚLTIMO texto enviado. */
async function enviar(texto, from = numeroNuevo()) {
  const body = {
    entry: [{ changes: [{ value: { messages: [{ from, id: 'wamid-9bter-' + (wamidSeq++), type: 'text', text: { body: texto } }] } }] }],
  };
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = 'sha256=' + crypto.createHmac('sha256', 'test-secret').update(rawBody).digest('hex');
  await webhookHandler({ headers: { 'x-hub-signature-256': signature }, rawBody, body }, { sendStatus: vi.fn() });
  const enviados = enviarWhatsapp.mock.calls.map((c) => c[1]);
  return enviados.length ? enviados[enviados.length - 1] : null;
}

const USUARIO = {
  id: 'u1', whatsapp: '51999000111', nombre: 'Ana', plan: 'premium',
  trial_estado: 'convertido', premium_vence: '2027-01-01', onboarding_completado: true,
  recordatorios_activos: true, manos_libres: false, onboarding_paso: 0, ref_code: null,
};
const u = (extra) => ({ ...USUARIO, ...extra });

/** Otra fila, siempre sembrada: si un update pierde su `.eq('id', …)`, la pisa. */
const OTRO = () => u({
  id: 'u-999', nombre: 'Otro', plan: 'free', recordatorios_activos: true,
  manos_libres: true, onboarding_paso: 7, ref_code: 'VIEJO1',
});

// ═════════════════════════════════════════════════════════════════════════════
// LOS CINCO SITIOS DE FORMA UNIFORME
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Un `sitio` por entrada: es el discriminador del log Y la clave de esta tabla, así que dos
 * entradas no pueden colapsar sin que se note. `/silenciar` y `/recordar` escriben la MISMA
 * columna de la MISMA tabla — lo único que los separa es el `sitio`.
 *
 * `efecto(sb)` es la re-lectura: la única aserción que el copy no puede fingir.
 */
const SITIOS = [
  {
    sitio: 'webhook_silenciar',
    cmd: '/silenciar', tabla: 'usuarios', verbo: 'update',
    usuario: () => u({ recordatorios_activos: true }),
    siembra: () => ({ usuarios: [u({ recordatorios_activos: true }), OTRO()] }),
    exito: /Recordatorios desactivados/i,
    malo: /No pude desactivar los recordatorios/i,
    efecto: (sb) => sb.fila('usuarios', 'u1').recordatorios_activos,
    efectoOk: false, efectoMalo: true,
    where: [['id', 'u1']],
  },
  {
    sitio: 'webhook_recordar',
    cmd: '/recordar', tabla: 'usuarios', verbo: 'update',
    usuario: () => u({ recordatorios_activos: false }),
    siembra: () => ({ usuarios: [u({ recordatorios_activos: false }), OTRO()] }),
    exito: /Recordatorios activados/i,
    malo: /No pude activar los recordatorios/i,
    efecto: (sb) => sb.fila('usuarios', 'u1').recordatorios_activos,
    efectoOk: true, efectoMalo: false,
    where: [['id', 'u1']],
  },
  {
    sitio: 'webhook_manoslibres',
    cmd: '/manoslibres', tabla: 'usuarios', verbo: 'update',
    usuario: () => u({ manos_libres: false }),
    siembra: () => ({ usuarios: [u({ manos_libres: false }), OTRO()] }),
    exito: /Modo Manos Libres activado/i,
    malo: /No pude cambiar el Modo Manos Libres/i,
    efecto: (sb) => sb.fila('usuarios', 'u1').manos_libres,
    efectoOk: true, efectoMalo: false,
    where: [['id', 'u1']],
  },
  {
    sitio: 'webhook_ref_code',
    cmd: 'mis referidos', tabla: 'usuarios', verbo: 'update',
    usuario: () => u({ ref_code: null }),
    siembra: () => ({ usuarios: [u({ ref_code: null }), OTRO()] }),
    exito: /Tu código de referido es REF9999/,
    malo: /Se me trabó creando tu código de referido/i,
    efecto: (sb) => sb.fila('usuarios', 'u1').ref_code,
    efectoOk: 'REF9999', efectoMalo: null,
    where: [['id', 'u1']],
  },
  {
    sitio: 'webhook_categorias_menu',
    cmd: '/categorias', tabla: 'usuarios', verbo: 'update',
    usuario: () => u({ onboarding_paso: 0 }),
    siembra: () => ({ usuarios: [u({ onboarding_paso: 0 }), OTRO()] }),
    exito: /Personaliza tus categorias/i,
    malo: /No pude abrir la personalización de categorías/i,
    efecto: (sb) => sb.fila('usuarios', 'u1').onboarding_paso,
    efectoOk: 10, efectoMalo: 0,
    where: [['id', 'u1']],
  },
];

/**
 * `conObjetivo:false` NO usa un stub: quita la fila que el WHERE busca, para que las cero filas
 * las produzca el `.eq(…)` real. Es lo que mata la mutación que le saca el WHERE al statement.
 */
function preparar(sitio, { fallos = {}, lanza = [], vacios = [], conObjetivo = true } = {}) {
  const filas = sitio.siembra();
  if (!conObjetivo) {
    // El handler NO lee esta fila (le llega por `obtenerOCrearUsuario`), así que no sembrarla
    // es exactamente el caso de producción: `merge_and_link` movió la identidad, o la cuenta se
    // borró entre el mensaje y el update.
    filas.usuarios = (filas.usuarios || []).filter((f) => f.id !== 'u1');
  }
  sbActual = montar({ filas, fallos, lanza, vacios });
  obtenerOCrearUsuario.mockResolvedValue(sitio.usuario());
  return sbActual;
}

async function correr(fn) {
  const spy = espiarLog();
  try {
    return { res: await fn(), spy };
  } finally {
    spy.restaurar();
  }
}

beforeEach(() => {
  sbActual = null;
  wamidSeq += 1000;
  enviarWhatsapp.mockClear();
  procesarMensajeLibre.mockClear().mockResolvedValue('respuesta-del-NLP');
  manejarOnboarding.mockClear().mockResolvedValue(null);
  registrarError.mockClear();
  registrarReferido.mockClear();
  obtenerCategoriasUsuario.mockClear().mockResolvedValue(null);
  obtenerEstadisticasReferidos.mockClear().mockResolvedValue({ total: 0, pagados: 0, mesesGanados: 0 });
});

describe('9B-ter · las escrituras de handlers/webhook.js dejan de confirmar lo que no entró', () => {
  for (const sitio of SITIOS) {
    describe(sitio.sitio, () => {
      const clave = sitio.tabla + ':' + sitio.verbo;

      it('camino feliz: confirma, el efecto está en la fila, y NO deja ningún log', async () => {
        const sb = preparar(sitio);
        const { res, spy } = await correr(() => enviar(sitio.cmd));
        expect(res).toMatch(sitio.exito);
        expect(res).not.toMatch(sitio.malo);
        expect(sitio.efecto(sb)).toEqual(sitio.efectoOk);
        // **El control anti-vacuidad.** Sin esto, un `log.warn` incondicional —o el `.select()`
        // borrado, que produce exactamente eso— pasa los tres casos de abajo sin que nada lo
        // note, y el archivo deja de discriminar.
        expect(spy.escrituras().map((a) => a[0].sitio),
          'el camino feliz emitió diagnóstico: revisá el RETURNING').toEqual([]);
      });

      it('la DB RECHAZA: lo dice, no afirma el éxito, y el efecto NO ocurrió', async () => {
        const sb = preparar(sitio, { fallos: { [clave]: 'db caída' } });
        const { res, spy } = await correr(() => enviar(sitio.cmd));
        expect(res).toMatch(sitio.malo);
        expect(res).not.toMatch(sitio.exito);
        // Que la escritura se haya INTENTADO: sin esto el verde puede venir de un return previo.
        expect(sb.intento(sitio.tabla, sitio.verbo), 'ni siquiera se intentó la escritura').toBe(true);
        expect(sitio.efecto(sb)).toEqual(sitio.efectoMalo);
        const anotado = spy.erroresDe(sitio.sitio);
        expect(anotado.length, 'el rechazo no dejó rastro con su sitio').toBe(1);
        expect(anotado[0][0].err).toMatch(/db caída/);
        expect(anotado[0][0].userId).toBe('u1');
        // El diagnóstico de "cero filas" es OTRO: si los dos colapsan, el log no decide nada.
        expect(spy.warnsDe(sitio.sitio)).toEqual([]);
      });

      it('cero filas: lo anota DISTINTO del rechazo y tampoco confirma', async () => {
        const sb = preparar(sitio, { conObjetivo: false });
        const { res, spy } = await correr(() => enviar(sitio.cmd));
        expect(sb.intento(sitio.tabla, sitio.verbo)).toBe(true);
        const anotado = spy.warnsDe(sitio.sitio);
        expect(anotado.length, 'no quedó rastro de que la escritura no tocó nada').toBe(1);
        expect(String(anotado[0][1])).toMatch(/NINGUNA fila/i);
        // …y NO por el camino del rechazo. Es lo que separa "se cayó la DB" de "esa fila ya no
        // está", que mandan a mirar lugares distintos.
        expect(spy.erroresDe(sitio.sitio)).toEqual([]);
        expect(res).toMatch(sitio.malo);
        expect(res).not.toMatch(sitio.exito);
      });

      it('si el cliente RECHAZA la promesa, contesta igual en vez de callarse', async () => {
        // postgrest-js no produce este rechazo (convierte el fallo de fetch en `error`), así que
        // el mock lo fabrica. Sin él, el `catch` de `verificarEscritura` es código sin medir — y
        // acá el desenlace es peor que en `intents/`: un throw sube al catch de la cascada, que
        // responde "Tuve un problema consultando tus datos" sobre una ESCRITURA.
        preparar(sitio, { lanza: [clave] });
        const { res, spy } = await correr(() => enviar(sitio.cmd));
        expect(res).toMatch(sitio.malo);
        expect(res).not.toMatch(/Tuve un problema consultando tus datos/);
        expect(spy.erroresDe(sitio.sitio).length).toBe(1);
        expect(spy.erroresDe(sitio.sitio)[0][0].err).toMatch(/conexión cortada/);
      });

      it('el WHERE apunta a la fila que dice, y no se derrama sobre el resto', async () => {
        // `intento(tabla, verbo)` dice que hubo un update, NUNCA sobre qué. Sin mirar el filtro,
        // un UPDATE sin WHERE pisa toda la tabla con la suite en verde.
        const sb = preparar(sitio);
        const ajenas = sb.todas(sitio.tabla).filter((f) => f.id !== 'u1').map((f) => ({ ...f }));
        expect(ajenas.length, 'la siembra no trae ninguna fila ajena: el derrame sería invisible')
          .toBeGreaterThan(0);
        await correr(() => enviar(sitio.cmd));
        expect(sb.filtros(sitio.tabla, sitio.verbo)).toEqual(sitio.where);
        expect(sb.todas(sitio.tabla).filter((f) => f.id !== 'u1')).toEqual(ajenas);
      });
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// LA MEDICIÓN QUE EL ÍTEM PIDIÓ: la rama de webhook INTERCEPTA antes que premium.js
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Sin esto, el arreglo podría volver a hacerse en el lugar que no corre — que es exactamente lo
 * que pasó en 9B-bis, donde `premium.js:ver_referidos` se arregló y las frases comunes
 * quedaron mudas acá.
 *
 * `procesarMensajeLibre` es el ÚNICO camino que llega al dispatch de intents (`webhook.js` lo
 * recibe por parámetro y lo invoca en el `else` final de la cascada). Si el spy no se llamó, el
 * intent `ver_referidos` no corrió.
 */
describe('9B-ter · ref_code: la cascada intercepta ANTES de llegar al intent de premium.js', () => {
  const FRASES = ['/referir', '/referidos', '/invitar', 'mis referidos', 'link de referido', 'quiero invitar'];

  for (const frase of FRASES) {
    it(`"${frase}" nunca llega a procesarMensajeLibre, y escribe el código acá`, async () => {
      const sb = preparar(SITIOS.find((s) => s.sitio === 'webhook_ref_code'));
      await correr(() => enviar(frase));
      expect(procesarMensajeLibre,
        'la frase cayó al NLP: el arreglo de premium.js sería el que corre').not.toHaveBeenCalled();
      expect(sb.intento('usuarios', 'update'), 'no escribió el ref_code por este camino').toBe(true);
      expect(sb.fila('usuarios', 'u1').ref_code).toBe('REF9999');
    });
  }

  /**
   * **CONTROL NEGATIVO.** Sin él, "no se llamó" podría venir de que el spy no se llama nunca
   * con nada — y los seis casos de arriba serían verdes por la razón equivocada.
   */
  it('CONTROL: una frase que la regex NO matchea sí llega a procesarMensajeLibre', async () => {
    preparar(SITIOS.find((s) => s.sitio === 'webhook_ref_code'));
    await correr(() => enviar('cuéntame un chiste'));
    expect(procesarMensajeLibre).toHaveBeenCalledTimes(1);
  });

  /**
   * La otra mitad del arreglo, y no la cubre la tabla: el objeto EN MEMORIA. Dejar
   * `usuario.ref_code` seteado sobre una escritura que no entró propaga el código inventado a
   * todo lo que lea el objeto más abajo en el mismo request.
   */
  it('si el update no entra, `usuario.ref_code` en memoria tampoco queda seteado', async () => {
    const sitio = SITIOS.find((s) => s.sitio === 'webhook_ref_code');
    const usuario = sitio.usuario();
    sbActual = montar({ filas: sitio.siembra(), fallos: { 'usuarios:update': 'db caída' } });
    obtenerOCrearUsuario.mockResolvedValue(usuario);
    await correr(() => enviar('mis referidos'));
    expect(usuario.ref_code).toBeNull();
    // Y no se pidieron las estadísticas de un código que no existe.
    expect(obtenerEstadisticasReferidos).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// /categorias: el menú numerado no se imprime si el paso no entró
// ═════════════════════════════════════════════════════════════════════════════

/**
 * El caso de `desconectar_cuenta` con el orden invertido: acá el mensaje ya estaba compuesto una
 * línea ANTES del update. Lo que hace que el "1 3 5" signifique algo es `onboarding_paso = 10`
 * (`handlers/onboarding.js`), así que imprimir el menú sin ese estado es ofrecer un trámite que
 * no existe.
 */
describe('9B-ter · /categorias: enumerar las opciones es la mitad de la mentira', () => {
  const sitio = () => SITIOS.find((s) => s.sitio === 'webhook_categorias_menu');

  it('con el paso caído NO aparece ninguna de las opciones numeradas', async () => {
    preparar(sitio(), { fallos: { 'usuarios:update': 'db caída' } });
    const { res } = await correr(() => enviar('/categorias'));
    expect(res).not.toMatch(/1\. /);
    expect(res).not.toMatch(/Ej: 1 3 5/);
    expect(res).toMatch(/No pude abrir la personalización/i);
  });

  // **El título dice lo que se afirma, no lo que se quiso hacer.** Que el write vaya ANTES del
  // menú no lo mide este caso: con el orden viejo (menú compuesto y después el update) la
  // guarda igual reasignaría `respuesta`, así que las dos aserciones se cumplen con los dos
  // órdenes. Lo observable es el par: acá el paso queda escrito y el menú sale; arriba, con el
  // write caído, el menú NO sale. El script de mutación lo declara igual.
  it('cuando el paso entra, queda en 10 y el menú se enumera', async () => {
    const sb = preparar(sitio());
    const { res } = await correr(() => enviar('/categorias'));
    expect(sb.fila('usuarios', 'u1').onboarding_paso).toBe(10);
    expect(res).toMatch(/Ej: 1 3 5/);
  });

  /**
   * El otro lado de la rama, que la tabla no toca: si el usuario YA tiene categorías, no hay
   * menú ni write. Sin esto, mover el write podría haber empezado a escribir `onboarding_paso`
   * sobre gente que sólo quería VER sus categorías — y eso la trabaría en un menú fantasma.
   */
  it('con categorías ya creadas no escribe nada y sólo las lista', async () => {
    const sb = preparar(sitio());
    obtenerCategoriasUsuario.mockResolvedValue([{ nombre: 'Comida', emoji: '🍔' }]);
    await correr(() => enviar('/categorias'));
    expect(sb.intento('usuarios', 'update')).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// El OTP inverso: la escritura ACCESORIA y las dos lecturas que RAMIFICAN
// ═════════════════════════════════════════════════════════════════════════════

const OTP_FUTURO = new Date(Date.now() + 10 * 60 * 1000).toISOString();

/** Alias: los tests del OTP piden un número explícito porque afirman sobre él. */
const numeroOtp = numeroNuevo;
/**
 * **La segunda fila NO es relleno: es el testigo del WHERE.** El archivo aplica el principio de
 * `OTRO()` a `usuarios` y se había olvidado de `webapp_otp`, que es la tabla del WHERE más
 * peligroso de los seis — sin `.eq('id', otp.id)`, la escritura marca verificados TODOS los OTP
 * pendientes y le estampa el teléfono de esta persona a cada uno. Medido: con una sola fila
 * sembrada, esa mutación pasaba con los 56 tests en verde. Lo encontró la revisión adversarial.
 */
const OTP_AJENO = () => ({
  id: 'otp-ajeno', code: 'NETO-777777', supabase_auth_id: 'auth-otro',
  email: 'otro@x.com', nombre: 'Otro Web', expires_at: OTP_FUTURO, verified_at: null,
  whatsapp_verified: null,
});
const otpFilas = (extra = {}) => ({
  webapp_otp: [{
    id: 'otp1', code: 'NETO-123456', supabase_auth_id: 'auth-1',
    email: 'ana@x.com', nombre: 'Ana Web', expires_at: OTP_FUTURO, verified_at: null,
    whatsapp_verified: null,
  }, OTP_AJENO()],
  ...extra,
});

/** La fila web ES la misma que la del número: reenvío del código, nada que fusionar. */
const otpMismaCuenta = () => otpFilas({ usuarios: [u({ supabase_auth_id: 'auth-1' }), OTRO()] });

describe('9B-ter · marcarVerificado: accesoria, pero deja de ser silenciosa', () => {
  beforeEach(() => { obtenerOCrearUsuario.mockResolvedValue(u({ supabase_auth_id: 'auth-1' })); });

  it('camino feliz: quema el código, anota el número y no deja log', async () => {
    const sb = montar({ filas: otpMismaCuenta() });
    sbActual = sb;
    const nro = numeroOtp();
    const { res, spy } = await correr(() => enviar('NETO-123456', nro));
    expect(res).toMatch(/verificada y vinculada/i);
    expect(sb.fila('webapp_otp', 'otp1').verified_at).toBeTruthy();
    expect(sb.fila('webapp_otp', 'otp1').whatsapp_verified).toBe(nro);
    expect(spy.escrituras().map((a) => a[0].sitio)).toEqual([]);
  });

  /**
   * **El copy NO cambia a propósito, y esto es lo que lo fija.** El enunciado del ítem decía
   * que acá "el vínculo se declara hecho sin quedar escrito". Medido, es al revés: el vínculo
   * lo escribe el update (o el `merge_and_link`) de más abajo, y la señal que la webapp poletea
   * es `usuarios.whatsapp` —`verified_at` es sólo su fallback
   * (`webapp/src/app/api/onboarding/route.ts:115-141`)—. O sea que el mensaje es VERDAD aunque
   * la quema falle, y contestar "no pude" sería la mentira nueva.
   *
   * Lo que sí se pierde no lo puede arreglar la persona: el código no se quema (sigue vivo su
   * ventana) y `whatsapp_verified` es una de las dos columnas por las que el borrado de cuenta
   * barre esta tabla (`migrations/073`). Por eso: sólo log, con sitio propio.
   */
  it('si la quema falla, el copy sigue diciendo la verdad y queda el diagnóstico', async () => {
    const sb = montar({ filas: otpMismaCuenta(), fallos: { 'webapp_otp:update': 'db caída' } });
    sbActual = sb;
    const { res, spy } = await correr(() => enviar('NETO-123456', numeroOtp()));
    expect(res, 'el vínculo SÍ existe: negarlo sería la mentira nueva').toMatch(/verificada y vinculada/i);
    expect(sb.fila('webapp_otp', 'otp1').verified_at).toBeNull();
    const anotado = spy.erroresDe('webhook_otp_verificado');
    expect(anotado.length, 'la quema falló en silencio').toBe(1);
    expect(anotado[0][0].campos).toEqual(['verified_at', 'whatsapp_verified']);
  });

  /**
   * Cero filas por el WHERE real: la fila del OTP desaparece ENTRE la lectura y el update (otro
   * dispositivo la usó, el barrido de baja la borró). Sacarla de la siembra rompería la LECTURA
   * y el update nunca se intentaría — verde por otra condición. Por eso `antesDeEscribir`.
   */
  it('cero filas se anota DISTINTO del rechazo', async () => {
    let quitada = false;
    const sb = montar({
      filas: otpMismaCuenta(),
      antesDeEscribir: (t, verbo, filas) => {
        if (t !== 'webapp_otp' || quitada) return;
        quitada = true;
        filas.webapp_otp = [];
      },
    });
    sbActual = sb;
    const { spy } = await correr(() => enviar('NETO-123456', numeroOtp()));
    expect(sb.intento('webapp_otp', 'update')).toBe(true);
    expect(spy.warnsDe('webhook_otp_verificado').length).toBe(1);
    expect(spy.erroresDe('webhook_otp_verificado')).toEqual([]);
  });

  /**
   * La rama del MERGE, que es la que el ítem señaló: hay un `merge_and_link` de por medio y el
   * survivor es la fila web. La decisión de la accesoria tiene que valer igual acá.
   */
  it('por la rama del merge la decisión es la misma: el vínculo se confirma, la quema se anota', async () => {
    const sb = montar({
      filas: otpFilas({ usuarios: [u({ id: 'uweb', supabase_auth_id: 'auth-1', nombre: 'Ana Web' }), u(), OTRO()] }),
      fallos: { 'webapp_otp:update': 'db caída' },
      rpcs: { merge_and_link: 'linked' },
    });
    sbActual = sb;
    const { res, spy } = await correr(() => enviar('NETO-123456', numeroOtp()));
    expect(sb.intento('rpc:merge_and_link', 'rpc'), 'no pasó por el merge').toBe(true);
    expect(res).toMatch(/Tus datos quedaron unificados/i);
    const anotado = spy.erroresDe('webhook_otp_verificado');
    expect(anotado.length).toBe(1);
    // **El `userId` del log tiene que ser el SURVIVOR.** `merge_and_link` acaba de borrar la
    // fila del loser (`u1`), así que anotar ese id deja un diagnóstico que no se puede cruzar
    // con nada — y este sitio no tiene otra salida que el log. Los cinco de la tabla afirman
    // `userId === 'u1'` y por eso no podían ver esta rama.
    expect(anotado[0][0].userId, 'el log nombra la fila que el merge borró').toBe('uweb');
  });

  /**
   * **El WHERE, que hasta la revisión adversarial no medía nadie.** Es el más peligroso de los
   * seis: sin `.eq('id', otp.id)`, la escritura marca verificados TODOS los OTP pendientes de
   * la base y les estampa el teléfono de esta persona en `whatsapp_verified`.
   */
  it('el WHERE apunta al OTP que dice, y no toca el de otra cuenta', async () => {
    const sb = montar({ filas: otpMismaCuenta() });
    sbActual = sb;
    const ajeno = { ...sb.fila('webapp_otp', 'otp-ajeno') };
    expect(ajeno.id, 'la siembra no trae un OTP ajeno: el derrame sería invisible').toBe('otp-ajeno');
    await correr(() => enviar('NETO-123456', numeroOtp()));
    expect(sb.filtros('webapp_otp', 'update')).toEqual([['id', 'otp1']]);
    expect(sb.fila('webapp_otp', 'otp-ajeno')).toEqual(ajeno);
  });

  it('si el cliente RECHAZA la promesa, el mensaje sale igual en vez de caer al catch', async () => {
    const sb = montar({ filas: otpMismaCuenta(), lanza: ['webapp_otp:update'] });
    sbActual = sb;
    const { res, spy } = await correr(() => enviar('NETO-123456', numeroOtp()));
    expect(res).toMatch(/verificada y vinculada/i);
    expect(spy.erroresDe('webhook_otp_verificado')[0][0].err).toMatch(/conexión cortada/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// LAS TRES LECTURAS: no son la misma clase, y cada una se decidió aparte
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Las tres fallan CERRADO —ninguna confirma nada falso—, así que no entran en la tabla de
 * arriba. Lo que hace que no sean neutras es OTRA cosa: dos deciden si se vincula una cuenta y
 * la tercera si se siembra el 50% off de un referido.
 */
describe('9B-ter · la lectura del código OTP: "no se pudo preguntar" ≠ "tu código es inválido"', () => {
  beforeEach(() => { obtenerOCrearUsuario.mockResolvedValue(u({ supabase_auth_id: 'auth-1' })); });

  it('con la lectura caída NO declara inválido el código ni manda a generar otro', async () => {
    const sb = montar({ filas: otpMismaCuenta(), fallos: { 'webapp_otp:select': 'db caída' } });
    sbActual = sb;
    const { res } = await correr(() => enviar('NETO-123456', numeroOtp()));
    expect(res).not.toMatch(/no es válido o ya expiró/i);
    expect(res).not.toMatch(/genera uno nuevo/i);
    expect(res).toMatch(/sigue siendo válido/i);
    // Y no escribió nada por ninguna rama.
    expect(sb.intento('usuarios', 'update')).toBe(false);
    expect(sb.intento('webapp_otp', 'update')).toBe(false);
  });

  /**
   * **CONTROL**, y sin él lo de arriba no prueba cobertura: un código que de verdad no existe
   * tiene que seguir dando el mensaje de siempre. Si los dos colapsaran, el arreglo habría
   * cambiado una mentira por otra.
   */
  it('CONTROL: un código que de verdad no existe sigue diciendo que no es válido', async () => {
    sbActual = montar({ filas: { webapp_otp: [], usuarios: [u()] } });
    const { res } = await correr(() => enviar('NETO-999999', numeroOtp()));
    expect(res).toMatch(/no es válido o ya expiró/i);
  });

  it('deja el diagnóstico con su tag, no sólo el mensaje al usuario', async () => {
    // Sin esto, borrar el `log.error` y dejar el `return` no pone nada rojo: el copy es toda la
    // cobertura y el diagnóstico se puede borrar solo.
    sbActual = montar({ filas: otpMismaCuenta(), fallos: { 'webapp_otp:select': 'db caída' } });
    const { spy } = await correr(() => enviar('NETO-123456', numeroOtp()));
    const anotado = spy.crudos().filter((a) => a[0] && a[0].tag === 'WEBAPP_OTP');
    expect(anotado.length).toBe(1);
    expect(anotado[0][0].err).toMatch(/db caída/);
  });

  /**
   * **`PGRST116` no es transitorio y el guard nuevo lo separa.** `webapp_otp.code` no tiene
   * índice único (`migrations/020`: el único unique es por `supabase_auth_id`), así que dos
   * cuentas Google pueden compartir un código de 6 dígitos pendiente. Con dos filas,
   * `maybeSingle()` devuelve `PGRST116` — y contestar *"sigue siendo válido, reintenta"* sería
   * un callejón sin salida: por más que reintente van a seguir siendo dos. Lo encontró la
   * revisión adversarial.
   */
  it('un código DUPLICADO manda a generar otro, no a reintentar el mismo', async () => {
    sbActual = montar({
      filas: {
        webapp_otp: [
          { id: 'otp1', code: 'NETO-123456', supabase_auth_id: 'auth-1', expires_at: OTP_FUTURO, verified_at: null },
          { id: 'otp2', code: 'NETO-123456', supabase_auth_id: 'auth-2', expires_at: OTP_FUTURO, verified_at: null },
        ],
        usuarios: [u()],
      },
    });
    const { res } = await correr(() => enviar('NETO-123456', numeroOtp()));
    expect(res).toMatch(/genera uno nuevo/i);
    expect(res).not.toMatch(/sigue siendo válido/i);
    // Y sobre todo: no eligió una de las dos a ciegas.
    expect(sbActual.intento('usuarios', 'update')).toBe(false);
    expect(sbActual.intento('webapp_otp', 'update')).toBe(false);
  });

  /**
   * **La ficha del rate limit se cobra ANTES de leer nada**, así que sin devolverla cinco hipos
   * de Supabase seguidos bloquean a la persona 15 minutos — mientras el mensaje que acaba de
   * recibir la invita a reintentar en un minuto.
   *
   * **Va como TABLA y no como un caso, y eso lo decidió la revisión del arreglo.** La primera
   * versión medía una sola rama, y con eso borrar el refund de las otras cinco pasaba con la
   * suite ENTERA en verde (2305 tests). Es la trampa de `feedback_guards_que_no_ven`: el guard
   * midiéndose contra la mitad de lo que declara. Cada entrada es una rama distinta que le dice
   * a la persona que reintente por un motivo NUESTRO.
   */
  const RAMAS_QUE_DEVUELVEN = [
    {
      rama: 'la lectura del código se cayó',
      montaje: () => ({ filas: otpMismaCuenta(), fallos: { 'webapp_otp:select': 'db caída' } }),
      espera: /sigue siendo válido/i,
    },
    {
      rama: 'la lectura de la cuenta web se cayó',
      montaje: () => ({
        filas: otpFilas({ usuarios: [u({ id: 'uweb', supabase_auth_id: 'auth-1' }), u()] }),
        fallos: { 'usuarios:select': 'db caída' },
      }),
      espera: /sigue siendo válido/i,
    },
    {
      rama: 'el link directo no tocó ninguna fila',
      montaje: () => ({ filas: otpFilas({ usuarios: [OTRO()] }) }),
      espera: /No pude terminar de vincular/i,
    },
    {
      rama: 'merge_and_link se cayó',
      montaje: () => ({
        filas: otpFilas({ usuarios: [u({ id: 'uweb', supabase_auth_id: 'auth-1' }), u()] }),
        fallos: { 'rpc:merge_and_link': 'lock timeout' },
      }),
      espera: /problema al vincular tu cuenta/i,
    },
    {
      rama: 'merge_and_link devolvió algo inesperado',
      montaje: () => ({
        filas: otpFilas({ usuarios: [u({ id: 'uweb', supabase_auth_id: 'auth-1' }), u()] }),
        rpcs: { merge_and_link: 'vaya_a_saber' },
      }),
      espera: /problema al vincular tu cuenta/i,
    },
    {
      rama: 'el bloque lanzó y cayó al catch',
      montaje: () => ({ filas: otpMismaCuenta(), lanza: ['webapp_otp:select'] }),
      espera: null, // cae al NLP; lo que se mide es que no throttee
    },
  ];

  for (const { rama, montaje, espera } of RAMAS_QUE_DEVUELVEN) {
    it(`cinco fallos seguidos por "${rama}" no gastan el rate limit`, async () => {
      const nro = numeroOtp();
      for (let i = 0; i < 5; i++) {
        sbActual = montar(montaje());
        const { res } = await correr(() => enviar('NETO-123456', nro));
        expect(res, 'ya lo throtteó en el intento ' + (i + 1)).not.toMatch(/Demasiados intentos/i);
        if (espera) expect(res).toMatch(espera);
      }
      // El sexto, con la base sana: tiene que verificar, no rebotar contra el throttle.
      sbActual = montar({ filas: otpMismaCuenta() });
      const { res } = await correr(() => enviar('NETO-123456', nro));
      expect(res).not.toMatch(/Demasiados intentos/i);
      expect(res).toMatch(/verificada y vinculada/i);
    });
  }

  /**
   * **La rama de `conflict` NO devuelve la ficha, y va afirmado porque es una decisión.** No es
   * un fallo nuestro (el merge se negó por un borde inseguro: el número ya está ligado a otra
   * cuenta Google) y no invita a reintentar — manda a soporte. Reintentar ahí no arregla nada,
   * así que la ficha cumple su función.
   */
  it('un merge en CONFLICTO no devuelve la ficha: manda a soporte, no invita a reintentar', async () => {
    const nro = numeroOtp();
    for (let i = 0; i < 5; i++) {
      sbActual = montar({
        filas: otpFilas({ usuarios: [u({ id: 'uweb', supabase_auth_id: 'auth-1' }), u()] }),
        rpcs: { merge_and_link: 'conflict' },
      });
      const { res } = await correr(() => enviar('NETO-123456', nro));
      expect(res).toMatch(/revisión manual|soporte/i);
    }
    sbActual = montar({ filas: otpMismaCuenta() });
    const { res } = await correr(() => enviar('NETO-123456', nro));
    expect(res).toMatch(/Demasiados intentos/i);
  });

  /**
   * **CONTROL, y es el que impide que el arreglo de arriba sea un agujero.** La ficha sólo se
   * devuelve cuando falla NUESTRA lectura. Cinco códigos MALOS seguidos tienen que seguir
   * gastando las cinco: eso es lo único que defiende el código de la fuerza bruta.
   */
  it('CONTROL: cinco códigos malos seguidos SÍ gastan el rate limit', async () => {
    const nro = numeroOtp();
    for (let i = 0; i < 5; i++) {
      sbActual = montar({ filas: { webapp_otp: [], usuarios: [u()] } });
      await correr(() => enviar('NETO-99999' + i, nro));
    }
    sbActual = montar({ filas: { webapp_otp: [], usuarios: [u()] } });
    const { res } = await correr(() => enviar('NETO-999996', nro));
    expect(res).toMatch(/Demasiados intentos/i);
  });
});

describe('9B-ter · la lectura de la cuenta web: no elige rama a ciegas', () => {
  beforeEach(() => { obtenerOCrearUsuario.mockResolvedValue(u({ supabase_auth_id: null })); });

  /**
   * **Es la peor de las tres porque `!webRow` no informa: RAMIFICA.** Con el error descartado,
   * la lectura caída se leía como "la cuenta web no llegó a crear su fila" y mandaba al link
   * DIRECTO, que escribe `supabase_auth_id` sobre la fila del número — contra un unique que la
   * fila web ya ocupa. El 23505 resultante lo atribuía el bloque de abajo al índice del EMAIL,
   * o sea que un hipo de la base terminaba en una escritura por el camino equivocado y en un
   * diagnóstico que apunta a un conflicto inexistente.
   */
  it('con la lectura caída NO intenta el link directo ni culpa al correo', async () => {
    const sb = montar({
      filas: otpFilas({ usuarios: [u({ id: 'uweb', supabase_auth_id: 'auth-1' }), u()] }),
      // El primer `usuarios:select` del bloque es justamente el de la fila web.
      fallos: { 'usuarios:select': 'db caída' },
    });
    sbActual = sb;
    const { res } = await correr(() => enviar('NETO-123456', numeroOtp()));
    expect(sb.intento('usuarios', 'update'), 'escribió por la rama de link directo').toBe(false);
    expect(res).not.toMatch(/ya está vinculado a otra cuenta de WhatsApp/i);
    expect(res).toMatch(/sigue siendo válido/i);
  });

  /**
   * **El link directo tenía la MISMA clase que este commit cierra, seis líneas más abajo.** Sin
   * `.select('id')`, cero filas llega con la forma del éxito (`{data:null, error:null}`): el
   * bot confirmaba el vínculo y QUEMABA el código sobre una fila que ya no estaba. Y el
   * instrumento no podía verlo — `inventario-escrituras-intents.mjs` clasifica por "¿el LHS
   * destructura `error`?", y ése sí lo destructuraba. Lo encontró la revisión adversarial.
   *
   * Las cero filas las produce el WHERE real (la fila `u1` no está sembrada), que es el
   * mecanismo de producción: un merge concurrente o una baja movieron la identidad entre
   * `obtenerOCrearUsuario` y el update.
   */
  it('link directo con cero filas: no confirma el vínculo NI quema el código', async () => {
    const sb = montar({ filas: otpFilas({ usuarios: [OTRO()] }) });
    sbActual = sb;
    const { res } = await correr(() => enviar('NETO-123456', numeroOtp()));
    expect(sb.intento('usuarios', 'update'), 'ni siquiera se intentó el link').toBe(true);
    expect(res).not.toMatch(/verificada y vinculada/i);
    expect(res).toMatch(/No pude terminar de vincular/i);
    // Lo que hace que el reintento sirva: el código sigue vivo.
    expect(sb.fila('webapp_otp', 'otp1').verified_at).toBeNull();
    expect(sb.intento('webapp_otp', 'update'), 'quemó el código igual').toBe(false);
  });

  /**
   * **CONTROL**: cuando la fila web de verdad no existe, el link directo sigue corriendo. Sin
   * esto, el caso de arriba podría estar verde porque nadie llega nunca a esa rama.
   */
  it('CONTROL: sin fila web (lectura sana) el link directo sí ocurre', async () => {
    const sb = montar({ filas: otpFilas({ usuarios: [u()] }) });
    sbActual = sb;
    const { res } = await correr(() => enviar('NETO-123456', numeroOtp()));
    expect(sb.intento('usuarios', 'update')).toBe(true);
    expect(sb.fila('usuarios', 'u1').supabase_auth_id).toBe('auth-1');
    expect(res).toMatch(/verificada y vinculada/i);
  });
});

describe('9B-ter · la lectura del referrer: el 50% off que no se siembra deja de ser indiagnosticable', () => {
  beforeEach(() => { obtenerOCrearUsuario.mockResolvedValue(u({ id: 'u1' })); });

  it('con la lectura caída lo anota y lo deja en la tabla `errores`', async () => {
    sbActual = montar({
      filas: { usuarios: [u({ id: 'uref', ref_code: 'ABCD12' }), u()] },
      fallos: { 'usuarios:select': 'db caída' },
    });
    const { spy } = await correr(() => enviar('hola neto ref:ABCD12'));
    expect(registrarReferido, 'sembró un referido que no pudo resolver').not.toHaveBeenCalled();
    expect(registrarError).toHaveBeenCalledTimes(1);
    expect(registrarError.mock.calls[0][0]).toBe('REFERIDO');
    const anotado = spy.crudos().filter((a) => a[0] && a[0].tag === 'REFERIDO');
    expect(anotado.length).toBe(1);
    expect(anotado[0][0].refCode).toBe('ABCD12');
  });

  /**
   * **CONTROL, y es el que separa las dos causas que `.single()` colapsa.** Un código que no
   * existe devuelve `PGRST116` y eso es NORMAL: si disparara el mismo diagnóstico, el log se
   * llenaría de falsas alarmas cada vez que alguien tipea cualquier cosa, y un guard que grita
   * sin motivo deja de leerse.
   */
  it('CONTROL: un código inexistente (PGRST116) no ensucia el diagnóstico', async () => {
    sbActual = montar({ filas: { usuarios: [u()] } });
    const { spy } = await correr(() => enviar('hola neto ref:NOEXISTE'));
    expect(registrarError).not.toHaveBeenCalled();
    expect(spy.crudos().filter((a) => a[0] && a[0].tag === 'REFERIDO')).toEqual([]);
  });

  /**
   * **El `.neq('id', usuario.id)` es lo único que impide referirse a uno mismo**, y hasta la
   * revisión adversarial el doble lo trataba como no-op, así que no lo medía nadie. Un
   * autorreferido siembra el 50% off sin que nadie haya traído a nadie: es plata.
   */
  it('no se puede uno referir a sí mismo con su propio código', async () => {
    sbActual = montar({ filas: { usuarios: [u({ id: 'u1', ref_code: 'ABCD12' })] } });
    await correr(() => enviar('hola neto ref:ABCD12'));
    expect(registrarReferido).not.toHaveBeenCalled();
    expect(registrarError, 'lo trató como fallo de lectura').not.toHaveBeenCalled();
  });

  it('CONTROL: con el referrer encontrado, el referido se siembra igual que antes', async () => {
    sbActual = montar({ filas: { usuarios: [u({ id: 'uref', ref_code: 'ABCD12' }), u()] } });
    await correr(() => enviar('hola neto ref:ABCD12'));
    expect(registrarReferido).toHaveBeenCalledWith('uref', 'u1');
    expect(registrarError).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// EL MOCK SE PRUEBA A SÍ MISMO — si no, es un fixture sin control
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Transferido de 9B-bis por el mismo motivo por el que existe allá: **cada aserción de arriba
 * depende de que este doble se comporte como PostgREST**, y un doble equivocado produce verdes
 * indistinguibles de los buenos. Se agrega lo propio de acá: `rpc`.
 */
describe('9B-ter · el mock cumple el contrato de PostgREST', () => {
  it('una escritura SIN `.select()` devuelve data null aunque haya matcheado', async () => {
    const sb = montar({ filas: { t: [{ id: 'a', v: 1 }] } });
    const r = await sb.from('t').update({ v: 2 }).eq('id', 'a');
    expect(r).toEqual({ data: null, error: null });
    expect(sb.fila('t', 'a').v, 'el patch no se aplicó igual').toBe(2);
  });

  it('con `.select()` y cero coincidencias devuelve `[]`, no null', async () => {
    const sb = montar({ filas: { t: [{ id: 'a' }] } });
    const r = await sb.from('t').update({ v: 2 }).eq('id', 'zzz').select('id');
    expect(r.data).toEqual([]);
    expect(r.error).toBeNull();
  });

  it('una escritura rechazada NO aplica su patch', async () => {
    const sb = montar({ filas: { t: [{ id: 'a', v: 1 }] }, fallos: { 't:update': 'no' } });
    await sb.from('t').update({ v: 2 }).eq('id', 'a').select('id');
    expect(sb.fila('t', 'a').v).toBe(1);
  });

  it('`single()` sobre cero filas da PGRST116 y `maybeSingle()` da data null sin error', async () => {
    const sb = montar({ filas: { t: [] } });
    const s = await sb.from('t').select('id').eq('id', 'x').single();
    expect(s.error.code).toBe('PGRST116');
    const m = await sb.from('t').select('id').eq('id', 'x').maybeSingle();
    expect(m).toEqual({ data: null, error: null });
  });

  it('`maybeSingle()` sobre VARIAS filas también da PGRST116, no la primera', async () => {
    // Tolera cero, no "cualquier cantidad". El doble devolvía la primera y hacía invisible el
    // caso del código de OTP duplicado (`webapp_otp.code` no tiene índice único).
    const sb = montar({ filas: { t: [{ id: 'a', k: 1 }, { id: 'b', k: 1 }] } });
    const r = await sb.from('t').select('id').eq('k', 1).maybeSingle();
    expect(r.data).toBeNull();
    expect(r.error.code).toBe('PGRST116');
  });

  it('`.neq()` FILTRA de verdad: no es passthrough', async () => {
    const sb = montar({ filas: { t: [{ id: 'a', k: 1 }, { id: 'b', k: 1 }] } });
    const r = await sb.from('t').select('id').eq('k', 1).neq('id', 'a');
    expect(r.data).toEqual([{ id: 'b' }]);
  });

  it('`.select(cols)` PROYECTA: no devuelve la fila entera', async () => {
    const sb = montar({ filas: { t: [{ id: 'a', v: 1, oculto: 9 }] } });
    const r = await sb.from('t').select('id, v').eq('id', 'a');
    expect(r.data).toEqual([{ id: 'a', v: 1 }]);
  });

  it('`lanza` produce un RECHAZO de la promesa, que es lo que postgrest-js nunca hace', async () => {
    const sb = montar({ filas: { t: [{ id: 'a' }] }, lanza: ['t:update'] });
    await expect(sb.from('t').update({ v: 1 }).eq('id', 'a').select('id')).rejects.toThrow(/conexión cortada/);
  });

  it('`filtros` expone el WHERE en el orden en que se encadenó', async () => {
    const sb = montar({ filas: { t: [] } });
    await sb.from('t').update({ v: 1 }).eq('id', 'a').eq('usuario_id', 'u1').select('id');
    expect(sb.filtros('t', 'update')).toEqual([['id', 'a'], ['usuario_id', 'u1']]);
  });

  it('`rpc` devuelve lo declarado y sabe fallar', async () => {
    const ok = montar({ rpcs: { merge_and_link: 'conflict' } });
    expect(await ok.rpc('merge_and_link', {})).toEqual({ data: 'conflict', error: null });
    const mal = montar({ fallos: { 'rpc:merge_and_link': 'db caída' } });
    expect((await mal.rpc('merge_and_link', {})).error.message).toBe('db caída');
  });
});
