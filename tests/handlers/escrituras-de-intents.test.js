import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const RAIZ = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]):/, '$1:'), '../..');

/**
 * CONFIRMACIÓN INCONDICIONAL — las 15 escrituras de `handlers/intents/` (ítem 9B-bis).
 *
 * Cuarta superficie de la misma clase (9A plata, 9A-bis cero filas, 9D el alta) y el daño
 * vuelve a cambiar de forma. Acá no hay máquina de estados que trabe a nadie ni un gasto que se
 * pierda: lo que se rompe es la palabra del producto sobre cosas que la persona NO va a volver
 * a mirar. *"🔇 Recordatorios desactivados"* sobre alguien que mañana a las 8pm recibe el
 * resumen igual. *"✅ Gasto compartido creado, cada uno S/ 75"* sobre un reparto que no existe,
 * que además es plata de terceros. Un código de referido que se reparte y no resuelve nunca.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * LO QUE ESTE ARCHIVO TIENE QUE PODER DISTINGUIR, y es lo que define el mock
 *
 * Tres desenlaces, no dos:
 *
 *   1. **la escritura FALLÓ**              → `fallos`, que fabrica el `{ error }` de postgrest
 *   2. **no tocó NINGUNA fila**            → la fila objetivo NO está sembrada, así que las
 *      cero filas las produce el `.eq('id', …)` del propio statement. No es un stub: es el
 *      mecanismo de producción (`merge_and_link` movió la identidad, otro dispositivo borró la
 *      meta entre la lectura y el update) y además **mata la mutación que quita el WHERE**
 *   3. **el efecto NO ocurrió**            → se prueba **RE-LEYENDO LA FILA**, nunca mirando el
 *      mensaje. Es la única de las tres que el copy no puede fingir
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * EL HARNESS ES TRANSFERIDO, NO REINVENTADO
 *
 * La lección que pagó 9A-bis: llevar la clase de bug a otro archivo **sin llevar los
 * accesorios** produjo 14 supervivientes con la suite en verde. Van los cuatro de
 * `escrituras-de-plata.test.js` MÁS el estado que agregó 9D:
 *
 *   · `filtros(tabla, verbo)` — el WHERE, expuesto. `intento()` dice que hubo un delete, nunca
 *     sobre QUÉ. Acá hay cuatro DELETE y un UPDATE cuyo WHERE **se corrigió en este mismo
 *     commit** (`configurar_presupuesto` filtraba por `(usuario_id, categoria)` sin mes ni
 *     año): sin mirar el filtro, ese arreglo no tiene quien lo sostenga.
 *   · `lanza` — el RECHAZO de la promesa, que postgrest-js no produce. Sin él, el `catch` de
 *     `verificarEscritura` es código sin medir.
 *   · `single` ≠ `maybeSingle` — `single()` sobre cero filas devuelve `PGRST116` en `error`.
 *     `moderacion.js` lo usa para buscar el último `survey_event`, y una guarda que decide por
 *     `if (error)` se comporta al revés según cuál se haya escrito.
 *   · **el RETURNING modelado** — una escritura sin `.select()` devuelve `data: null` SIEMPRE.
 *     Es lo que hace que quitarle el `.select('id')` a un sitio sea una mutación que mata: sin
 *     él, `sin_fila` dispararía en TODAS las escrituras.
 *   · **el ESTADO** — un update que entra aplica su patch y uno que falla no. Sin eso,
 *     `sb.fila('usuarios','u1').recordatorios_activos` sería una declaración y no una
 *     observación.
 *
 * Y el control que faltaba en 9A: **el camino feliz afirma CERO logs**. `verificarEscritura`
 * emite todo su diagnóstico por `log`, así que un `log.warn` incondicional —o un `.select()`
 * borrado, que produce exactamente eso— pasaría los tres casos malos sin que nada lo note.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * EL ALCANCE, DICHO EN VEZ DE INSINUADO
 *
 * Este archivo cubre `handlers/intents/`. **Las 6 de `handlers/webhook.js` las cerró 9B-ter el
 * 25-ago-2026** (`tests/handlers/escrituras-del-webhook.test.js`); lo que sigue queda escrito
 * porque explica POR QUÉ no entraron acá, que es la parte reusable. Una revisión adversarial
 * las midió (656, 830, 833, 840, 946, 979) con el inventario de este mismo commit, y dos cosas
 * las volvían peores que las de acá y no un resto:
 *
 *   · **`webhook.js:946` es el `ver_referidos` que de verdad corre.** Su rama matchea TEXTO
 *     LIBRE por regex (`mis referidos`, `link de referido`, `quiero invitar`…) y
 *     `procesarMensajeLibre` —lo único que llega a `premium.js`— es el `else` del final de la
 *     cascada. O sea que el arreglo de `premium.js` cubre la cola y el código mudo se queda con
 *     las frases comunes.
 *   · **`webhook.js:830/833` está citado como el ejemplo canónico de la clase** en el docblock
 *     de `tests/cron/lecturas-leen-el-error.test.js`. El commit arregla el gemelo
 *     (`moderacion.js`) y deja el original que lo nombra.
 *
 * No entraron acá a propósito: meter hallazgos nuevos en la segunda vuelta de un arreglo es
 * cómo se produjo el incidente del 04-ago (la lección está escrita en 9A-bis). Fueron al backlog
 * con su medición y salieron en la sesión siguiente, y
 * `node scripts/inventario-escrituras-intents.mjs handlers/webhook.js` lo vuelve a contar sin
 * creerle a este comentario: hoy da `verificadas=6, escrituras mudas=0`.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * LA DIFERENCIA CON 9D, y hace el archivo más simple
 *
 * Estos handlers reciben `supabase` por `ctx`; no lo destructuran de `lib/db` al cargar. O sea
 * que el doble se pasa por parámetro y no hace falta pisarlo en el require-cache antes de
 * requerir el módulo. Lo único que sí se pisa son los dos módulos que `consultas.js` y
 * `premium.js` SÍ destructuran al tope (`gmail.js` y `services/referrals.js`), que además
 * hablan con el cliente REAL de Supabase.
 */

// ─── Los dos módulos que los handlers destructuran al cargar ─────────────────
const gmailMock = { obtenerCuentasGmail: vi.fn().mockResolvedValue([]) };
const referralsMock = {
  obtenerEstadisticasReferidos: vi.fn().mockResolvedValue({ total: 0, pagados: 0, mesesGanados: 0 }),
  mensajeMisReferidos: (code) => 'Tu código: ' + code + ' — link https://neto.pe/r/' + code,
};
for (const [rel, exports] of [['gmail.js', gmailMock], ['services/referrals.js', referralsMock]]) {
  const p = require.resolve(path.join(RAIZ, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

// ═════════════════════════════════════════════════════════════════════════════
// El doble de Supabase (transferido de 9D)
// ═════════════════════════════════════════════════════════════════════════════

const MUTANTES = ['insert', 'update', 'delete', 'upsert'];

/**
 * @param filas  `{ tabla: [fila, …] }`. Las filas se MUTAN: un update que entra aplica su
 *               patch, que es lo que permite re-leer el estado en vez de creerle al mensaje.
 * @param fallos `{'tabla:verbo': 'motivo'}` o un ARRAY indexado por número de llamada
 *               (`['db caída', null]` = falla la primera, pasa la segunda).
 * @param vacios `'tabla:verbo'` — stub declarado de "cero filas". **Casi no se usa**: los casos
 *               de 0 filas se construyen NO sembrando la fila objetivo, para que las cero filas
 *               las produzca el WHERE real. Un caso así también muere si alguien le quita el
 *               `.eq('id', …)`; el stub no.
 * @param lanza  `'tabla:verbo'` — fabrica un RECHAZO de la promesa.
 * @param antesDeEscribir  `(tabla, verbo, filas) => void`, justo antes de que una escritura
 *        resuelva. Existe por un caso que ningún stub reproduce bien: en `editar_meta`,
 *        `eliminar_meta` y `eliminar_presupuesto` el handler **LEE la fila y después la
 *        escribe**, así que sacarla de la siembra hace fallar la LECTURA y el update nunca se
 *        intenta — el test saldría verde por otra condición. El mecanismo real es que la fila
 *        desaparezca ENTRE las dos (otro dispositivo la borró, el barrido de baja de cuenta), y
 *        eso es lo que este hook modela.
 */
function montar({ filas = {}, fallos = {}, vacios = [], lanza = [], antesDeEscribir = null } = {}) {
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

    from(tabla) {
      let verbo = 'select';
      const b = {};
      const filtros = [];
      const passthrough = ['ilike', 'gte', 'lte', 'neq', 'not', 'order', 'limit'];
      for (const m of passthrough) b[m] = () => b;

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

      const matchean = () => tabla_(tabla).filter((f) => filtros.every(([c, v]) => f[c] === v));
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
       * que decide por `if (error)` se comporta al revés según cuál se haya escrito.
       */
      const uno = (esSingle) => {
        const r = resolver();
        if (r.error) return r;
        const arr = Array.isArray(r.data) ? r.data : (r.data == null ? [] : [r.data]);
        if (arr.length === 1) return { data: arr[0], error: null };
        if (!esSingle) return { data: arr.length ? arr[0] : null, error: null };
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
    /** Sólo lo que emite `verificarEscritura`: el resto del ruido de los handlers no cuenta. */
    escrituras: () => [...propios(errores), ...propios(warns)],
    erroresDe: (sitio) => propios(errores).filter((a) => a[0].sitio === sitio),
    warnsDe: (sitio) => propios(warns).filter((a) => a[0].sitio === sitio),
    restaurar: () => { log.error = origE; log.warn = origW; },
  };
}

// ─── Los handlers ────────────────────────────────────────────────────────────
const H = {
  consultas: require('../../handlers/intents/consultas'),
  deudas: require('../../handlers/intents/deudas'),
  metas: require('../../handlers/intents/metas'),
  moderacion: require('../../handlers/intents/moderacion'),
  premium: require('../../handlers/intents/premium'),
  presupuestos: require('../../handlers/intents/presupuestos'),
  social: require('../../handlers/intents/social'),
  utilidades: require('../../handlers/intents/utilidades'),
};

const USUARIO = {
  id: 'u1', whatsapp: '+51999', nombre: 'Ana', plan: 'premium',
  trial_estado: 'convertido', premium_vence: '2027-01-01', recordatorios_activos: true,
  onboarding_paso: 0, reporte_gmail_modo: 'unificado', ref_code: null,
};
const u = (extra) => ({ ...USUARIO, ...extra });

/** Otro usuario, siempre sembrado: si un update pierde su `.eq('id', …)`, lo pisa. */
const OTRO = () => u({
  id: 'u-999', nombre: 'Otro', plan: 'free', recordatorios_activos: true,
  onboarding_paso: 7, reporte_gmail_modo: 'unificado', ref_code: 'VIEJO1',
});

/** ctx compartido. Cada sitio agrega lo suyo. */
function ctxBase(sb) {
  return {
    supabase: sb,
    obtenerCuentasGmail: vi.fn().mockResolvedValue([]),
    hoyPeru: () => '2026-08-24',
    mesActual: 8,
    anioActual: 2026,
    mE: { 8: 'Agosto' },
    ultimoDiaMes: () => 31,
    getEmojiCategoria: () => '🍔',
    guardarPresupuesto: vi.fn().mockResolvedValue({ id: 'p1', usuario_id: 'u1', categoria: 'Comida', monto_limite: 500, mes: 8, anio: 2026 }),
    registrarDeuda: vi.fn().mockResolvedValue({ id: 'd-nueva' }),
    barraProgreso: () => '▓▓',
    formatFecha: (f) => String(f),
    calcularRitmoAhorro: () => ({ montoMensual: null, enRitmo: true }),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// LOS 16 SITIOS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Un `sitio` por entrada: es el discriminador del log Y la clave de esta tabla, así que dos
 * entradas no pueden colapsar sin que se note.
 *
 * `objetivo` es la fila que el WHERE tiene que tocar; NO sembrarla es como se fabrica el caso
 * de cero filas, y `testigo` es lo que un WHERE perdido pisaría.
 *
 * `efecto(sb)` es la re-lectura: la única aserción que el copy no puede fingir.
 */
const META = { id: 'm1', usuario_id: 'u1', nombre: 'Viaje', monto_objetivo: 5000, monto_actual: 1200, completada: false, status: 'active', fecha_limite: null, monthly_quota: null };
const PRES = { id: 'p1', usuario_id: 'u1', categoria: 'Comida', monto_limite: 500, alerta_porcentaje: 80, mes: 8, anio: 2026 };

const SITIOS = [
  {
    sitio: 'silenciar',
    handler: 'moderacion', intencion: 'silenciar', tabla: 'usuarios', verbo: 'update',
    siembra: () => ({ usuarios: [u({ recordatorios_activos: true }), OTRO()] }),
    entrada: () => ({ usuario: u({ recordatorios_activos: true }), msg: 'silencia' }),
    exito: /Recordatorios desactivados/i,
    malo: /No pude desactivar los recordatorios/i,
    efecto: (sb) => sb.fila('usuarios', 'u1').recordatorios_activos,
    efectoOk: false, efectoMalo: true,
    where: [['id', 'u1']],
  },
  {
    sitio: 'reactivar_recordatorios',
    handler: 'moderacion', intencion: 'reactivar_recordatorios', tabla: 'usuarios', verbo: 'update',
    siembra: () => ({ usuarios: [u({ recordatorios_activos: false }), OTRO()] }),
    entrada: () => ({ usuario: u({ recordatorios_activos: false }), msg: 'activa los recordatorios' }),
    exito: /Recordatorios activados/i,
    malo: /No pude activar los recordatorios/i,
    efecto: (sb) => sb.fila('usuarios', 'u1').recordatorios_activos,
    efectoOk: true, efectoMalo: false,
    where: [['id', 'u1']],
  },
  {
    sitio: 'desconectar_cuenta',
    handler: 'moderacion', intencion: 'desconectar_cuenta', tabla: 'usuarios', verbo: 'update',
    siembra: () => ({ usuarios: [u({ onboarding_paso: 0 }), OTRO()] }),
    entrada: () => ({ usuario: u({ onboarding_paso: 0 }), msg: 'desconectar cuenta' }),
    // **El `exito` no puede ser `/Desconectar cuenta/`**, que era lo primero que escribí: el
    // copy del fallo dice *"Escríbeme desconectar cuenta de nuevo"*, así que el negativo
    // (`not.toMatch(exito)`) se ponía rojo sobre el mensaje correcto. Una aserción que no
    // separa las dos hipótesis no prueba ninguna. Lo que SÓLO tiene el menú son sus opciones.
    exito: /Eliminar mis datos/i,
    malo: /Se me trabó abriendo el menú/i,
    efecto: (sb) => sb.fila('usuarios', 'u1').onboarding_paso,
    efectoOk: -1, efectoMalo: 0,
    where: [['id', 'u1']],
  },
  {
    sitio: 'preferencia_reporte_gmail',
    handler: 'consultas', intencion: 'preferencia_reporte_gmail', tabla: 'usuarios', verbo: 'update',
    siembra: () => ({ usuarios: [u(), OTRO()] }),
    entrada: () => ({ usuario: u(), msg: 'quiero mis reportes separados', datos: { modo: 'separado' } }),
    // Con menos de dos cuentas Gmail el handler responde otra cosa ("tus reportes ya salen en
    // uno solo") DESPUÉS de escribir, así que el camino feliz no llegaba a su copy. Dos cuentas
    // es además el único estado en que el modo separado significa algo.
    preludio: () => gmailMock.obtenerCuentasGmail.mockResolvedValue([{ id: 'g1', email: 'a@x.com' }, { id: 'g2', email: 'b@x.com' }]),
    exito: /Reportes configurados/i,
    malo: /No pude guardar tu preferencia de reportes/i,
    efecto: (sb) => sb.fila('usuarios', 'u1').reporte_gmail_modo,
    efectoOk: 'separado', efectoMalo: 'unificado',
    where: [['id', 'u1']],
  },
  {
    sitio: 'ver_referidos',
    handler: 'premium', intencion: 'ver_referidos', tabla: 'usuarios', verbo: 'update',
    siembra: () => ({ usuarios: [u({ ref_code: null }), OTRO()] }),
    entrada: () => ({ usuario: u({ ref_code: null }), msg: 'mis referidos' }),
    exito: /Tu código: /,
    malo: /Se me trabó creando tu código de referido/i,
    efecto: (sb) => typeof sb.fila('usuarios', 'u1').ref_code,
    efectoOk: 'string', efectoMalo: 'object',
    where: [['id', 'u1']],
  },
  {
    sitio: 'cambiar_nombre',
    handler: 'utilidades', intencion: 'cambiar_nombre', tabla: 'usuarios', verbo: 'update',
    siembra: () => ({ usuarios: [u({ nombre: 'Ana' }), OTRO()] }),
    entrada: () => ({ usuario: u({ nombre: 'Ana' }), msg: 'me llamo Maria', datos: { nombre_nuevo: 'maria' } }),
    exito: /ahora te llamo \*Maria\*/i,
    malo: /No pude actualizar tu nombre/i,
    efecto: (sb) => sb.fila('usuarios', 'u1').nombre,
    efectoOk: 'Maria', efectoMalo: 'Ana',
    where: [['id', 'u1']],
  },
  {
    sitio: 'feedback',
    handler: 'social', intencion: 'feedback', tabla: 'nlp_errors', verbo: 'insert',
    siembra: () => ({ usuarios: [u(), OTRO()], nlp_errors: [] }),
    entrada: () => ({ usuario: u(), msg: 'sería bueno que leas los SMS' }),
    exito: /Gracias por tu sugerencia/i,
    malo: /Se me trabó guardando tu sugerencia/i,
    efecto: (sb) => sb.todas('nlp_errors').length,
    efectoOk: 1, efectoMalo: 0,
    // Un insert no tiene WHERE. `sinFilaPorWhere:false` lo declara: su caso de cero filas se
    // fabrica con el stub `vacios`, que es lo único disponible, y va dicho en vez de fingido.
    sinFilaPorWhere: false,
  },
  {
    // Gemelo del de arriba, y por eso va pegado: la queja usa la MISMA tabla y el mismo verbo.
    // Nace guardada (28-ago-2026); antes devolvia un texto con un numero y no dejaba rastro,
    // asi que este sitio no existia y su caida no la veia nadie.
    sitio: 'queja',
    handler: 'social', intencion: 'queja', tabla: 'nlp_errors', verbo: 'insert',
    siembra: () => ({ usuarios: [u(), OTRO()], nlp_errors: [] }),
    entrada: () => ({ usuario: u(), msg: 'me cobraron dos veces el Pro' }),
    exito: /Lo anoté y lo va a revisar el equipo/i,
    malo: /se me trabó anotándolo/i,
    efecto: (sb) => sb.todas('nlp_errors').length,
    efectoOk: 1, efectoMalo: 0,
    sinFilaPorWhere: false,
  },
  {
    sitio: 'crear_meta',
    handler: 'metas', intencion: 'crear_meta', tabla: 'metas_ahorro', verbo: 'insert',
    siembra: () => ({ usuarios: [u(), OTRO()], metas_ahorro: [] }),
    entrada: () => ({ usuario: u(), msg: 'quiero ahorrar 5000', datos: { nombre: 'Viaje', monto: 5000 } }),
    exito: /Plan de ahorro creado/i,
    malo: /No pude crear el plan/i,
    efecto: (sb) => sb.todas('metas_ahorro').length,
    efectoOk: 1, efectoMalo: 0,
    sinFilaPorWhere: false,
  },
  {
    sitio: 'editar_meta',
    handler: 'metas', intencion: 'editar_meta', tabla: 'metas_ahorro', verbo: 'update',
    // La meta ajena existe para que el `where` test tenga qué pisar: sin una segunda fila,
    // 'no se derrama' es un no-op y el borrado masivo pasa en verde.
    siembra: () => ({ usuarios: [u()], metas_ahorro: [{ ...META }, { ...META, id: 'm-ajena', nombre: 'Ajena' }] }),
    entrada: () => ({ usuario: u(), msg: 'sube mi meta a 8000', datos: { monto_nuevo: 8000 } }),
    exito: /actualizada/i,
    malo: /No pude editar la meta/i,
    // 0 filas tiene su PROPIO copy acá: "ya no está" no invita al reintento que no va a andar.
    sinFila: /ya no está, así que no hay nada que cambiarle/i,
    efecto: (sb) => sb.fila('metas_ahorro', 'm1').monto_objetivo,
    efectoOk: 8000, efectoMalo: 5000,
    where: [['id', 'm1']],
    // La fila que el WHERE busca no es la del usuario: para el caso de cero filas hay que
    // sacar la META, no el usuario — el handler la LEE antes para elegir cuál editar.
    sinFilaQuitando: 'metas_ahorro',
  },
  {
    sitio: 'eliminar_meta',
    handler: 'metas', intencion: 'eliminar_meta', tabla: 'metas_ahorro', verbo: 'delete',
    siembra: () => ({ usuarios: [u()], metas_ahorro: [{ ...META }, { ...META, id: 'm-ajena', nombre: 'Ajena' }] }),
    entrada: () => ({ usuario: u(), msg: 'borra mi meta', datos: {} }),
    exito: /Eliminé la meta/i,
    malo: /No pude eliminar la meta/i,
    sinFila: /ya no está/i,
    // Mide la fila OBJETIVO, no el conteo de la tabla: con una fila ajena sembrada (que hace
    // falta para que el `where` test no sea un no-op) un conteo mezcla las dos cosas.
    efecto: (sb) => sb.fila('metas_ahorro', 'm1') !== null,
    efectoOk: false, efectoMalo: true,
    where: [['id', 'm1']],
    sinFilaQuitando: 'metas_ahorro',
  },
  {
    sitio: 'eliminar_presupuesto',
    handler: 'presupuestos', intencion: 'eliminar_presupuesto', tabla: 'presupuestos', verbo: 'delete',
    // El ajeno va en OTRO mes: el `.eq('mes', …)` de la lectura lo deja afuera, así que no
    // cambia cuál fila elige el handler, y sigue estando para que el delete pueda pisarlo.
    siembra: () => ({ usuarios: [u()], presupuestos: [{ ...PRES }, { ...PRES, id: 'p-ajeno', mes: 7 }] }),
    entrada: () => ({ usuario: u(), msg: 'quita el límite de comida', datos: { categoria: 'Comida' } }),
    exito: /Eliminé el presupuesto/i,
    malo: /No pude eliminar el presupuesto/i,
    sinFila: /ya no está/i,
    efecto: (sb) => sb.fila('presupuestos', 'p1') !== null,
    efectoOk: false, efectoMalo: true,
    where: [['id', 'p1']],
    sinFilaQuitando: 'presupuestos',
  },
  {
    sitio: 'configurar_presupuesto_alerta',
    handler: 'presupuestos', intencion: 'configurar_presupuesto', tabla: 'presupuestos', verbo: 'update',
    siembra: () => ({ usuarios: [u()], presupuestos: [{ ...PRES, alerta_porcentaje: 80 }, { ...PRES, id: 'p-ajeno', mes: 7, alerta_porcentaje: 90 }] }),
    entrada: () => ({ usuario: u(), msg: 'límite de 500 en Comida al 60%', datos: { categoria: 'Comida', monto: 500, alerta_porcentaje: 60 } }),
    exito: /Te aviso cuando llegues al 60%/i,
    // El monto SIEMPRE se confirma: `guardarPresupuesto` ya entró. Lo que cambia es la alerta.
    malo: /El aviso quedó como estaba/i,
    efecto: (sb) => sb.fila('presupuestos', 'p1').alerta_porcentaje,
    efectoOk: 60, efectoMalo: 80,
    where: [['id', 'p1']],
    sinFilaQuitando: 'presupuestos',
  },
  {
    sitio: 'dividir_gasto_grupal',
    handler: 'deudas', intencion: 'dividir_gasto_grupal', tabla: 'gasto_participantes', verbo: 'insert',
    siembra: () => ({ usuarios: [u()], gastos_compartidos: [], gasto_participantes: [] }),
    entrada: () => ({ usuario: u(), msg: 'pagué 300 la cena entre 4', datos: {} }),
    exito: /Gasto compartido creado/i,
    malo: /No pude anotar el reparto/i,
    efecto: (sb) => sb.todas('gasto_participantes').length,
    efectoOk: 3, efectoMalo: 0,
    sinFilaPorWhere: false,
  },
];

const porSitio = (s) => SITIOS.find((x) => x.sitio === s);

/**
 * Arma el mock y la invocación de un sitio.
 *
 * `conObjetivo:false` NO usa un stub: quita la fila que el WHERE busca, para que las cero filas
 * las produzca el `.eq(…)` real. Es lo que mata la mutación que le saca el WHERE al statement.
 */
function preparar(sitio, { fallos = {}, lanza = [], vacios = [], conObjetivo = true } = {}) {
  if (sitio.preludio) sitio.preludio();
  const filas = sitio.siembra();
  let antesDeEscribir = null;
  if (!conObjetivo) {
    if (sitio.sinFilaQuitando) {
      // El handler LEE esta fila antes de escribirla, así que sacarla de la siembra rompería la
      // lectura y el write no llegaría a intentarse: verde por otra condición. Se saca ENTRE
      // las dos, que es el mecanismo real.
      const tabla = sitio.sinFilaQuitando;
      let yaCorrio = false;
      antesDeEscribir = (t, verbo, f) => {
        if (t !== tabla || yaCorrio) return;
        yaCorrio = true;
        f[tabla] = (f[tabla] || []).filter((r) => r.id !== 'm1' && r.id !== 'p1');
      };
    } else {
      // Acá el WHERE apunta a `usuarios` y el handler NO lee esa fila (le llega por parámetro),
      // así que no sembrarla es exactamente el caso de producción: `merge_and_link` movió la
      // identidad, o la cuenta se borró. Y mata la mutación que quita el `.eq('id', …)`.
      filas.usuarios = (filas.usuarios || []).filter((f) => f.id !== 'u1');
    }
  }
  const sb = montar({ filas, fallos, lanza, vacios, antesDeEscribir });
  const e = sitio.entrada();
  const ctx = ctxBase(sb);
  const invocar = () => H[sitio.handler].handle({
    intencion: sitio.intencion, msg: e.msg, datos: e.datos || {},
    usuario: e.usuario, from: '+51999', ctx,
  });
  return { sb, invocar, ctx };
}

async function correr(invocar) {
  const spy = espiarLog();
  try {
    return { res: await invocar(), spy };
  } finally {
    spy.restaurar();
  }
}

beforeEach(() => {
  gmailMock.obtenerCuentasGmail.mockResolvedValue([]);
  referralsMock.obtenerEstadisticasReferidos.mockResolvedValue({ total: 0, pagados: 0, mesesGanados: 0 });
});

// ═════════════════════════════════════════════════════════════════════════════
// La tabla: cuatro casos por sitio
// ═════════════════════════════════════════════════════════════════════════════

describe('9B-bis · las escrituras de handlers/intents/ dejan de confirmar lo que no entró', () => {
  for (const sitio of SITIOS) {
    describe(sitio.sitio, () => {
      const clave = sitio.tabla + ':' + sitio.verbo;

      it('camino feliz: confirma, el efecto está en la fila, y NO deja ningún log', async () => {
        const { sb, invocar } = preparar(sitio);
        const { res, spy } = await correr(invocar);
        expect(res).toMatch(sitio.exito);
        expect(res).not.toMatch(sitio.malo);
        // La re-lectura, que es lo que el copy no puede fingir.
        expect(sitio.efecto(sb)).toEqual(sitio.efectoOk);
        // **El control anti-vacuidad.** Sin esto, un `log.warn` incondicional —o el `.select()`
        // borrado, que produce exactamente eso— pasa los tres casos de abajo sin que nada lo
        // note, y el archivo deja de discriminar.
        expect(spy.escrituras().map((a) => a[0].sitio),
          'el camino feliz emitió diagnóstico: revisá el RETURNING').toEqual([]);
      });

      it('la DB RECHAZA: lo dice, no afirma el éxito, y el efecto NO ocurrió', async () => {
        const { sb, invocar } = preparar(sitio, { fallos: { [clave]: 'db caída' } });
        const { res, spy } = await correr(invocar);
        // Las dos mitades: aparece el mensaje que toca Y no aparece el de la clase de al lado.
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

      it('cero filas: lo anota DISTINTO del rechazo y el efecto no ocurrió', async () => {
        // **Los dos casos NO son el mismo, y la diferencia va declarada.** Donde hay WHERE, las
        // cero filas las produce el `.eq(…)` real y eso además mata la mutación que lo quita.
        // En un INSERT no hay WHERE que pueda no matchear: postgrest o devuelve las filas o
        // devuelve `error`. Ahí el stub no simula un estado de producción — simula **el
        // RETURNING ausente**, que sí es alcanzable (es exactamente lo que queda si alguien le
        // borra el `.select('id')`), y lo que se afirma es que ese desenlace tampoco confirma.
        const opciones = sitio.sinFilaPorWhere === false
          ? { vacios: [clave] }
          : { conObjetivo: false };
        const { sb, invocar } = preparar(sitio, opciones);
        const { res, spy } = await correr(invocar);
        expect(sb.intento(sitio.tabla, sitio.verbo)).toBe(true);
        const anotado = spy.warnsDe(sitio.sitio);
        expect(anotado.length, 'no quedó rastro de que la escritura no tocó nada').toBe(1);
        expect(String(anotado[0][1])).toMatch(/NINGUNA fila/i);
        // …y NO por el camino del rechazo. Es lo que separa "se cayó la DB" de "esa fila ya no
        // está", que mandan a mirar lugares distintos.
        expect(spy.erroresDe(sitio.sitio)).toEqual([]);
        expect(res).toMatch(sitio.sinFila || sitio.malo);
        expect(res).not.toMatch(sitio.exito);
      });

      it('si el cliente RECHAZA la promesa, contesta igual en vez de tirar', async () => {
        // postgrest-js no produce este rechazo (convierte el fallo de fetch en `error`), así que
        // el mock lo fabrica. Sin él, el `catch` de `verificarEscritura` es código sin medir — y
        // un throw acá sube al catch general de `procesarMensajeLibre`, que deja una fila en
        // `nlp_errors` culpando a la NLP y contesta "Tuve un problema".
        const { invocar } = preparar(sitio, { lanza: [clave] });
        const llamada = correr(invocar);
        await expect(llamada, 'el rechazo subió: la persona recibe "Tuve un problema"')
          .resolves.toBeDefined();
        const { res, spy } = await llamada;
        expect(res).toMatch(sitio.malo);
        expect(spy.erroresDe(sitio.sitio).length).toBe(1);
        expect(spy.erroresDe(sitio.sitio)[0][0].err).toMatch(/conexión cortada/);
      });

      if (sitio.where) {
        it('el WHERE apunta a la fila que dice, y no se derrama sobre el resto', async () => {
          // `intento(tabla, verbo)` dice que hubo un update, NUNCA sobre qué. Es la mutación
          // que 9A dejó escrita: sin mirar el filtro, un UPDATE sin WHERE pisa toda la tabla
          // con la suite en verde.
          //
          // **La mitad del "no se derrama" era un NO-OP en cuatro sitios**, y lo encontró una
          // revisión adversarial: para `editar_meta`, `eliminar_meta`, `eliminar_presupuesto` y
          // `configurar_presupuesto_alerta` la siembra tenía UNA sola fila de su tabla, así que
          // no había nada que pisar y `todas(tabla).length` daba lo mismo con WHERE que sin él.
          // Lo único que atrapaba el derrame era la comparación de `filtros()`. Ahora los ocho
          // sitios siembran una fila ajena de SU tabla y se compara antes/después.
          const objetivo = sitio.where[0][1];
          const { sb, invocar } = preparar(sitio);
          const ajenas = sb.todas(sitio.tabla).filter((f) => f.id !== objetivo).map((f) => ({ ...f }));
          expect(ajenas.length, 'la siembra no trae ninguna fila ajena: el derrame sería invisible')
            .toBeGreaterThan(0);
          await correr(invocar);
          expect(sb.filtros(sitio.tabla, sitio.verbo)).toEqual(sitio.where);
          // Ni pisadas (update) ni desaparecidas (delete).
          expect(sb.todas(sitio.tabla).filter((f) => f.id !== objetivo)).toEqual(ajenas);
        });
      }
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Lo que NO comparte forma con la tabla: una decisión por sitio
// ═════════════════════════════════════════════════════════════════════════════

describe('9B-bis · desconectar_cuenta: el menú destructivo no se imprime si el paso no entró', () => {
  // El gemelo del menú que cerró 9D, desde el otro lado. `onboarding_paso = -1` es lo único que
  // hace que el próximo mensaje se lea como una OPCIÓN. Sin ese estado, imprimir "1️⃣ Eliminar
  // mis datos" es ofrecer un trámite que no existe: el "1" cae al NLP y el pedido de baja no
  // hace nada, sin que nadie se lo diga.
  for (const [caso, opciones] of [
    ['la DB rechaza', { fallos: { 'usuarios:update': 'db caída' } }],
    ['cero filas', { conObjetivo: false }],
  ]) {
    it(`${caso}: no aparece ninguna opción numerada`, async () => {
      const { res } = await correr(preparar(porSitio('desconectar_cuenta'), opciones).invocar);
      expect(res).not.toMatch(/Eliminar mis datos/i);
      expect(res).not.toMatch(/Eliminar todo/i);
      expect(res).not.toMatch(/Responde 1/i);
      expect(res).toMatch(/no lo leería como una opción/i);
    });
  }

  it('control: con una cuenta Gmail conectada, el camino feliz SÍ imprime las dos opciones', async () => {
    // Sin este control, un menú que dejara de imprimirse SIEMPRE pasaría los dos casos de
    // arriba. Y con una cuenta viva la opción 2 es el borrado total, que es lo que hace que
    // imprimir el menú sobre un paso que no entró sea grave y no sólo feo.
    const p = preparar(porSitio('desconectar_cuenta'));
    p.ctx.obtenerCuentasGmail.mockResolvedValue([{ id: 'g1', email: 'a@x.com' }]);
    const { res } = await correr(p.invocar);
    expect(res).toMatch(/Solo desconectar/i);
    expect(res).toMatch(/Eliminar todo/i);
    expect(p.sb.fila('usuarios', 'u1').onboarding_paso).toBe(-1);
  });
});

describe('9B-bis · dividir_gasto_grupal: el reparto que no entra se COMPENSA', () => {
  const sitio = porSitio('dividir_gasto_grupal');

  it('el padre queda escrito y las partes no → se borra el padre y NO se confirma el reparto', async () => {
    // Sin compensar, el reintento —que es lo que la persona va a hacer al leer "no pude"— crea
    // un SEGUNDO gasto compartido. El arreglo del mensaje habría fabricado un duplicado.
    const { sb, invocar } = preparar(sitio, { fallos: { 'gasto_participantes:insert': 'rls' } });
    const { res } = await correr(invocar);
    expect(res).not.toMatch(/Cada uno/);
    expect(res).toMatch(/no dejé el gasto compartido a medias/i);
    expect(sb.todas('gastos_compartidos')).toEqual([]);
    expect(sb.todas('gasto_participantes')).toEqual([]);
    // Y el DELETE de compensación apunta al gasto que se acaba de crear **y a su dueño**. El
    // `creador_id` es redundante hoy (el id nació en esta request) y va igual porque el cliente
    // es service role: sin él, lo único que separa este DELETE de borrar el split de cualquiera
    // es la procedencia de una variable. Lo pidió una revisión adversarial.
    expect(sb.filtros('gastos_compartidos', 'delete')).toEqual([['id', 'nueva-1'], ['creador_id', 'u1']]);
  });

  it('la compensación no puede tocar el gasto compartido de otro usuario', async () => {
    // El caso que el `filtros()` de arriba deja implícito, ejercitado: un split ajeno sembrado
    // en la misma tabla tiene que seguir vivo después de la compensación.
    const filas = {
      usuarios: [u()],
      gastos_compartidos: [{ id: 'gc-ajeno', creador_id: 'u-999', descripcion: 'Cena de otro', monto_total: 90 }],
      gasto_participantes: [],
    };
    const sb = montar({ filas, fallos: { 'gasto_participantes:insert': 'rls' } });
    const ctx = ctxBase(sb);
    await correr(() => H.deudas.handle({
      intencion: 'dividir_gasto_grupal', msg: 'pagué 300 la cena entre 4',
      datos: {}, usuario: u(), from: '+51999', ctx,
    }));
    expect(sb.fila('gastos_compartidos', 'gc-ajeno')).toEqual({
      id: 'gc-ajeno', creador_id: 'u-999', descripcion: 'Cena de otro', monto_total: 90,
    });
  });

  it('si la compensación TAMPOCO entra, el copy es otro y manda a mirar antes de repetir', async () => {
    // Es el único desenlace donde queda algo a medias. Decirle "volvé a dictármelo" ahí es
    // pedirle que duplique.
    const { sb, invocar } = preparar(sitio, {
      fallos: { 'gasto_participantes:insert': 'rls', 'gastos_compartidos:delete': 'db caída' },
    });
    const { res, spy } = await correr(invocar);
    expect(res).toMatch(/me quedó a medias/i);
    expect(res).toMatch(/antes de volver a dictármelo/i);
    expect(res).not.toMatch(/no dejé el gasto compartido a medias/i);
    expect(sb.todas('gastos_compartidos').length).toBe(1);
    expect(spy.erroresDe('dividir_gasto_grupal_limpieza').length).toBe(1);
  });

  it('camino feliz: N-1 participantes con la parte que dice el mensaje', async () => {
    // El control de los dos de arriba, y afirma la PLATA: "cada uno S/ 75" tiene que ser lo que
    // se escribió en `monto_debe`, no un número calculado sólo para el texto.
    const { sb, invocar } = preparar(sitio);
    const { res } = await correr(invocar);
    expect(res).toMatch(/Cada uno: \*S\/ 75\.00\*/);
    const partes = sb.todas('gasto_participantes');
    expect(partes.length).toBe(3);
    expect(partes.every((p) => p.monto_debe === 75)).toBe(true);
    expect(sb.todas('gastos_compartidos').length).toBe(1);
  });
});

describe('9B-bis · configurar_presupuesto: el monto se confirma igual; lo que se cae es la alerta', () => {
  const sitio = porSitio('configurar_presupuesto_alerta');

  it('la alerta no entra → el presupuesto SÍ se confirma y el % no se promete', async () => {
    // Son dos escrituras y una no arrastra a la otra: `guardarPresupuesto` ya entró (si hubiera
    // fallado, lanza y cae al catch). Negarle el "presupuesto configurado" a alguien cuyo
    // presupuesto SÍ se guardó sería la mentira simétrica.
    const { res } = await correr(preparar(sitio, { fallos: { 'presupuestos:update': 'db caída' } }).invocar);
    expect(res).toMatch(/Presupuesto configurado/);
    expect(res).toMatch(/Comida:\* S\/ 500\.00\/mes/);
    expect(res).toMatch(/El aviso quedó como estaba/);
    expect(res).not.toMatch(/Te aviso cuando llegues al 60%/);
  });

  it('el WHERE usa el id que devolvió guardarPresupuesto, no (usuario_id, categoria)', async () => {
    // **Este caso ES el arreglo del WHERE.** El filtro viejo no llevaba `mes`/`anio`, así que
    // "aviso al 60%" reescribía el umbral de todos los meses de esa categoría, historia
    // incluida — y de paso "cero filas" no significaba nada. `verificarAlertaPresupuesto` sólo
    // lee el mes en curso: los meses viejos no tenían por qué moverse nunca.
    const p = preparar(sitio);
    // Un presupuesto del mes pasado, misma categoría y mismo usuario: es exactamente lo que el
    // WHERE viejo pisaba.
    p.sb.todas('presupuestos'); // (fuerza la tabla)
    const { sb, invocar } = (() => {
      const filas = { usuarios: [u()], presupuestos: [{ ...PRES }, { ...PRES, id: 'p-viejo', mes: 7, alerta_porcentaje: 90 }] };
      const s = montar({ filas });
      const ctx = ctxBase(s);
      const e = sitio.entrada();
      return { sb: s, invocar: () => H.presupuestos.handle({ intencion: 'configurar_presupuesto', msg: e.msg, datos: e.datos, usuario: e.usuario, from: '+51999', ctx }) };
    })();
    await correr(invocar);
    expect(sb.filtros('presupuestos', 'update')).toEqual([['id', 'p1']]);
    expect(sb.fila('presupuestos', 'p1').alerta_porcentaje).toBe(60);
    expect(sb.fila('presupuestos', 'p-viejo').alerta_porcentaje, 'el mes pasado se movió').toBe(90);
  });

  it('si guardarPresupuesto no devuelve fila, no se inventa un update ni se promete el %', async () => {
    // Su contrato es `.select().single()`, pero el call-site no puede asumir que siempre trae
    // `id`: sin fila no hay a qué apuntar, y disparar el update igual sería un WHERE vacío.
    const filas = { usuarios: [u()], presupuestos: [{ ...PRES }] };
    const sb = montar({ filas });
    const ctx = ctxBase(sb);
    ctx.guardarPresupuesto = vi.fn().mockResolvedValue(null);
    const e = sitio.entrada();
    const { res } = await correr(() => H.presupuestos.handle({ intencion: 'configurar_presupuesto', msg: e.msg, datos: e.datos, usuario: e.usuario, from: '+51999', ctx }));
    expect(res).toMatch(/El aviso quedó como estaba/);
    expect(sb.intento('presupuestos', 'update'), 'se disparó un update sin objetivo').toBe(false);
  });
});

describe('9B-bis · registrar_deuda: la corrección de la deuda opuesta NO corta el registro', () => {
  // Es lo único accesorio del case. Abortar perdería la deuda que la persona acaba de dictar,
  // que es lo que vino a hacer.
  const RECIENTE = { id: 'd-op', usuario_id: 'u1', estado: 'activa', monto_original: 200, tipo: 'me_deben', contraparte: 'Juan', created_at: new Date().toISOString() };
  const armar = (fallos = {}) => {
    const filas = { usuarios: [u()], deudas: [{ ...RECIENTE }] };
    const sb = montar({ filas, fallos });
    const ctx = ctxBase(sb);
    return {
      sb, ctx,
      invocar: () => H.deudas.handle({
        intencion: 'registrar_deuda', msg: 'debo 200 soles a Juan',
        datos: { tipo: 'debo', contraparte: 'Juan', monto: 200 }, usuario: u(), from: '+51999', ctx,
      }),
    };
  };

  it('el DELETE falla → la deuda se registra IGUAL y se avisa que quedó la opuesta', async () => {
    const { sb, ctx, invocar } = armar({ 'deudas:delete': 'db caída' });
    const { res, spy } = await correr(invocar);
    expect(ctx.registrarDeuda, 'se perdió la deuda por una corrección accesoria').toHaveBeenCalled();
    expect(res).toMatch(/Anotado\. Le debes/);
    expect(res).toMatch(/te quedó también la anotación opuesta/i);
    expect(sb.fila('deudas', 'd-op'), 'la opuesta debería seguir viva').toBeTruthy();
    expect(spy.erroresDe('registrar_deuda_corrige_opuesta').length).toBe(1);
  });

  it('cero filas NO es una anomalía acá: la fila ya no está, que es el objetivo', async () => {
    // `ceroFilas: 'esperado'`, y es la única del barrido. Este DELETE apunta a una fila leída un
    // instante antes y no lleva condición que otro pueda invalidar: si no está, el estado
    // deseado se cumplió. Un `warn` diario ahí es una falsa alarma, y un log que grita sin
    // motivo se deja de leer.
    const filas = { usuarios: [u()], deudas: [{ ...RECIENTE }] };
    const sb = montar({ filas, vacios: ['deudas:delete'] });
    const ctx = ctxBase(sb);
    const { res, spy } = await correr(() => H.deudas.handle({
      intencion: 'registrar_deuda', msg: 'debo 200 soles a Juan',
      datos: { tipo: 'debo', contraparte: 'Juan', monto: 200 }, usuario: u(), from: '+51999', ctx,
    }));
    expect(res).toMatch(/Anotado\. Le debes/);
    expect(res).not.toMatch(/anotación opuesta/i);
    expect(spy.escrituras(), 'cero filas acá no tiene que gritar').toEqual([]);
  });

  it('camino feliz: borra la opuesta, por su id, y sin aviso', async () => {
    const { sb, invocar } = armar();
    const { res } = await correr(invocar);
    expect(sb.filtros('deudas', 'delete')).toEqual([['id', 'd-op']]);
    expect(sb.fila('deudas', 'd-op')).toBeNull();
    expect(res).not.toMatch(/anotación opuesta/i);
  });
});

describe('9B-bis · silenciar: el opt-out de survey_events es ACCESORIO y no toca el copy', () => {
  const armar = (extra = {}) => {
    const filas = {
      usuarios: [u({ recordatorios_activos: true })],
      survey_events: [{ id: 'sv1', user_id: 'u1', channel: 'whatsapp', sent_at: '2026-08-01', opted_out_after: false }],
    };
    const sb = montar({ filas, ...extra });
    const ctx = ctxBase(sb);
    return { sb, invocar: () => H.moderacion.handle({ intencion: 'silenciar', msg: 'silencia', datos: {}, usuario: u({ recordatorios_activos: true }), from: '+51999', ctx }) };
  };

  it('camino feliz: marca el opt-out por su id y confirma el silencio', async () => {
    const { sb, invocar } = armar();
    const { res, spy } = await correr(invocar);
    expect(res).toMatch(/Recordatorios desactivados/);
    expect(sb.fila('survey_events', 'sv1').opted_out_after).toBe(true);
    expect(sb.filtros('survey_events', 'update')).toEqual([['id', 'sv1']]);
    expect(spy.escrituras()).toEqual([]);
  });

  it('el opt-out falla → el copy NO cambia, y queda el log con SU sitio', async () => {
    // Accesoria de verdad: para cuando corre, el silencio ya está escrito y a la persona no le
    // cambia nada. Lo único que se compra es que la serie de fatiga deje de perder opt-outs.
    const { sb, invocar } = armar({ fallos: { 'survey_events:update': 'db caída' } });
    const { res, spy } = await correr(invocar);
    expect(res).toMatch(/Recordatorios desactivados/);
    expect(sb.fila('usuarios', 'u1').recordatorios_activos).toBe(false);
    expect(spy.erroresDe('silenciar_opt_out').length).toBe(1);
    expect(spy.erroresDe('silenciar')).toEqual([]);
  });

  it('si el SILENCIO no entra, el opt-out ni se intenta', async () => {
    // Marcarle un opt-out a alguien que sigue recibiendo recordatorios ensucia la única serie
    // que mide fatiga, y el corte de arriba es lo que lo evita.
    const { sb, invocar } = armar({ fallos: { 'usuarios:update': 'db caída' } });
    const { res } = await correr(invocar);
    expect(res).toMatch(/No pude desactivar/);
    expect(sb.intento('survey_events', 'update')).toBe(false);
    expect(sb.fila('survey_events', 'sv1').opted_out_after).toBe(false);
  });

  it('sin survey_event previo, `single()` da PGRST116 y el silencio se confirma igual', async () => {
    // El caso que sólo existe porque el mock distingue `single` de `maybeSingle`: sobre cero
    // filas `single()` devuelve un ERROR (`PGRST116`), no `{data:null,error:null}`. El
    // `catch` de tracking lo absorbe y el intent no se rompe.
    const filas = { usuarios: [u({ recordatorios_activos: true })], survey_events: [] };
    const sb = montar({ filas });
    const ctx = ctxBase(sb);
    const { res } = await correr(() => H.moderacion.handle({ intencion: 'silenciar', msg: 'silencia', datos: {}, usuario: u({ recordatorios_activos: true }), from: '+51999', ctx }));
    expect(res).toMatch(/Recordatorios desactivados/);
    expect(sb.intento('survey_events', 'update')).toBe(false);
  });
});

describe('9B-bis · ver_referidos: el código que no se guarda no se reparte', () => {
  it('el update falla → NO aparece ningún código ni link en el mensaje', async () => {
    // El código ES la credencial: `routes/public.js` lo resuelve contra la fila. Repartir uno
    // que no está en la base es entregar un link permanentemente muerto, y cada referido que
    // traiga no le paga el mes gratis a nadie.
    const { res } = await correr(preparar(porSitio('ver_referidos'), { fallos: { 'usuarios:update': 'db caída' } }).invocar);
    expect(res).not.toMatch(/neto\.pe\/r\//);
    expect(res).not.toMatch(/Tu código/);
    expect(res).toMatch(/no te lo puedo dar/i);
  });

  it('quien YA tiene ref_code no escribe nada y recibe su link', async () => {
    // El control: sin él, un `return` incondicional pasaría el caso de arriba. Y afirma que la
    // rama de "ya tiene" no escribe — el update está adentro del `if (!refCode)`.
    const filas = { usuarios: [u({ ref_code: 'ABC123' })] };
    const sb = montar({ filas });
    const ctx = ctxBase(sb);
    const { res, spy } = await correr(() => H.premium.handle({ intencion: 'ver_referidos', msg: 'mis referidos', datos: {}, usuario: u({ ref_code: 'ABC123' }), from: '+51999', ctx }));
    expect(res).toMatch(/ABC123/);
    expect(sb.intento('usuarios', 'update')).toBe(false);
    expect(spy.escrituras()).toEqual([]);
  });
});

describe('9B-bis · editar_meta y eliminar_meta: "ya no está" no invita a reintentar', () => {
  // Los dos copies malos tienen que ser DISTINTOS entre sí. Si alguien los unifica, el caso de
  // cero filas de la tabla de arriba deja de discriminar y este archivo pierde la mitad de lo
  // que mide.
  for (const nombre of ['editar_meta', 'eliminar_meta', 'eliminar_presupuesto']) {
    it(`${nombre}: el copy de cero filas ≠ el copy del rechazo`, async () => {
      const sitio = porSitio(nombre);
      const clave = sitio.tabla + ':' + sitio.verbo;
      const { res: resCero } = await correr(preparar(sitio, { conObjetivo: false }).invocar);
      const { res: resErr } = await correr(preparar(sitio, { fallos: { [clave]: 'db caída' } }).invocar);
      expect(resCero).not.toEqual(resErr);
      expect(resCero).toMatch(/ya no está/i);
      expect(resCero).not.toMatch(/Intenta de nuevo/i);
      expect(resErr).toMatch(/Intenta de nuevo/i);
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// El doble de pruebas, probado
// ═════════════════════════════════════════════════════════════════════════════

/**
 * **Un fixture más benévolo que la realidad convierte al guard en decoración**, y ya pasó tres
 * veces en este repo (`meta_aportes` el 04-ago, `bindActivacion` el 18-ago, el `maybeSingle`
 * aliaseado del ítem 8). Los accesorios de este mock son la mitad de lo que hace que los casos
 * de arriba midan algo, así que se prueban solos: si mañana alguien "simplifica" el RETURNING o
 * iguala `single` con `maybeSingle`, cae acá y no dentro de un caso de intents, donde se leería
 * como otra cosa.
 */
describe('9B-bis · el mock cumple el contrato de PostgREST', () => {
  const sembrar = () => montar({ filas: { usuarios: [{ id: 'a', paso: 1 }, { id: 'b', paso: 2 }] } });

  it('una escritura SIN .select() devuelve data null aunque haya afectado filas', async () => {
    const sb = sembrar();
    const r = await sb.from('usuarios').update({ paso: 9 }).eq('id', 'a');
    expect(r).toEqual({ data: null, error: null });
    expect(sb.fila('usuarios', 'a').paso).toBe(9); // el efecto ocurrió igual
  });

  it('con .select() devuelve las filas afectadas, proyectadas a las columnas pedidas', async () => {
    const sb = sembrar();
    const { data } = await sb.from('usuarios').update({ paso: 9 }).eq('id', 'a').select('id');
    expect(data).toEqual([{ id: 'a' }]);
  });

  it('con .select() y cero coincidencias devuelve [] y no aplica nada', async () => {
    const sb = sembrar();
    const { data, error } = await sb.from('usuarios').update({ paso: 9 }).eq('id', 'zzz').select('id');
    expect(data).toEqual([]);
    expect(error).toBeNull();
    expect(sb.fila('usuarios', 'a').paso).toBe(1);
  });

  it('un insert con .select() devuelve SÓLO lo insertado, no la tabla entera', async () => {
    // El aliaseo que el ítem 8 encontró en el otro mock: un upsert que no devolvía la fila
    // escrita dejaba pasar cualquier guarda que la mirara.
    const sb = sembrar();
    const { data } = await sb.from('usuarios').insert([{ paso: 7 }, { paso: 8 }]).select('id');
    expect(data.length).toBe(2);
    expect(sb.todas('usuarios').length).toBe(4);
  });

  it('una escritura RECHAZADA no aplica su patch', async () => {
    const sb = montar({ filas: { usuarios: [{ id: 'a', paso: 1 }] }, fallos: { 'usuarios:update': 'rls' } });
    const { error } = await sb.from('usuarios').update({ paso: 9 }).eq('id', 'a').select('id');
    expect(error.message).toBe('rls');
    expect(sb.fila('usuarios', 'a').paso).toBe(1);
  });

  it('single() sobre cero filas da PGRST116 y maybeSingle() no', async () => {
    const sb = sembrar();
    const conSingle = await sb.from('usuarios').select('id').eq('id', 'zzz').single();
    expect(conSingle.data).toBeNull();
    expect(conSingle.error.code).toBe('PGRST116');
    const sb2 = sembrar();
    const conMaybe = await sb2.from('usuarios').select('id').eq('id', 'zzz').maybeSingle();
    expect(conMaybe).toEqual({ data: null, error: null });
  });

  it('single() sobre UNA fila devuelve el objeto, no el array', async () => {
    const sb = sembrar();
    const { data, error } = await sb.from('usuarios').select('id').eq('id', 'a').single();
    expect(error).toBeNull();
    expect(data).toEqual({ id: 'a' });
  });

  it('filtros() expone el WHERE de la escritura, y `lanza` fabrica un rechazo', async () => {
    const sb = sembrar();
    await sb.from('usuarios').update({ paso: 9 }).eq('id', 'a').select('id');
    expect(sb.filtros('usuarios', 'update')).toEqual([['id', 'a']]);
    const sb2 = montar({ filas: { usuarios: [{ id: 'a' }] }, lanza: ['usuarios:update'] });
    await expect(sb2.from('usuarios').update({ paso: 9 }).eq('id', 'a').select('id'))
      .rejects.toThrow(/conexión cortada/);
  });

  it('sin WHERE, un update pisa TODA la tabla (la forma del daño que filtros() vigila)', async () => {
    const sb = sembrar();
    await sb.from('usuarios').update({ paso: 9 }).select('id');
    expect(sb.fila('usuarios', 'a').paso).toBe(9);
    expect(sb.fila('usuarios', 'b').paso).toBe(9);
  });

  it('un delete con .select() devuelve lo borrado y lo saca de la tabla', async () => {
    const sb = sembrar();
    const { data } = await sb.from('usuarios').delete().eq('id', 'a').select('id');
    expect(data).toEqual([{ id: 'a' }]);
    expect(sb.fila('usuarios', 'a')).toBeNull();
    expect(sb.fila('usuarios', 'b')).toBeTruthy();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// El helper, medido solo
// ═════════════════════════════════════════════════════════════════════════════

describe('9B-bis · verificarEscritura reporta los tres desenlaces y no decide ninguno', () => {
  const { verificarEscritura, entro } = require('../../helpers/escritura-verificada');
  const sembrar = () => montar({ filas: { t: [{ id: 'a', v: 1 }] } });
  const correrH = async (consulta, opts) => {
    const spy = espiarLog();
    try { return { v: await verificarEscritura(consulta, opts), spy }; } finally { spy.restaurar(); }
  };
  const base = { sitio: 's', userId: 'u1', campos: ['v'] };

  it('el tag es literalmente `INTENT_ESCRITURA`', () => {
    // **Este caso existe porque su mutación sobrevivía.** Todo el resto del archivo filtra los
    // logs por `TAG_ESCRITURA` importado del propio helper, así que renombrar la constante la
    // renombra en los dos lados y el espía sigue matcheando: la expectativa estaba DERIVADA de
    // la cosa medida, que es la tautología de `feedback_guards_que_no_ven`.
    //
    // Y el tag no es decoración: es el único asidero para encontrar estos quince sitios en los
    // logs de producción. Un rename no rompe nada que se ejecute — rompe la búsqueda del día
    // que alguien necesite saber cuántas confirmaciones salieron sobre una escritura caída.
    expect(TAG_ESCRITURA).toBe('INTENT_ESCRITURA');
  });

  it('ok cuando toca filas, y sin log', async () => {
    const sb = sembrar();
    const { v, spy } = await correrH(sb.from('t').update({ v: 2 }).eq('id', 'a').select('id'), base);
    expect(v).toBe('ok');
    expect(entro(v)).toBe(true);
    expect(spy.escrituras()).toEqual([]);
  });

  it('error cuando la DB rechaza, por log.error', async () => {
    const sb = montar({ filas: { t: [{ id: 'a' }] }, fallos: { 't:update': 'boom' } });
    const { v, spy } = await correrH(sb.from('t').update({ v: 2 }).eq('id', 'a').select('id'), base);
    expect(v).toBe('error');
    expect(spy.erroresDe('s').length).toBe(1);
    expect(spy.warnsDe('s')).toEqual([]);
  });

  it('sin_fila cuando el WHERE no matchea, por log.warn (nivel distinto a propósito)', async () => {
    const sb = sembrar();
    const { v, spy } = await correrH(sb.from('t').update({ v: 2 }).eq('id', 'zzz').select('id'), base);
    expect(v).toBe('sin_fila');
    expect(spy.warnsDe('s').length).toBe(1);
    expect(spy.erroresDe('s')).toEqual([]);
  });

  it('SIN .select() todo sale sin_fila: es lo que hace que borrarlo rompa los tests', async () => {
    // La mutación más importante del ítem. postgrest devuelve `data: null` en toda escritura sin
    // RETURNING, así que el helper no puede distinguir nada — y el control "cero logs" del
    // camino feliz se pone rojo en los 16 sitios a la vez.
    const sb = sembrar();
    const { v } = await correrH(sb.from('t').update({ v: 2 }).eq('id', 'a'), base);
    expect(v).toBe('sin_fila');
    expect(sb.fila('t', 'a').v, 'el efecto sí ocurrió: por eso es una mentira peligrosa').toBe(2);
  });

  it('`PGRST116` sale como sin_fila, no como rechazo de la DB', async () => {
    // **Este caso existe porque una revisión adversarial lo encontró faltando.** Una escritura
    // que termine en `.select(…).single()` devuelve `PGRST116` cuando no matcheó nada: sin la
    // rama, el helper diría "la DB rechazó la escritura" sobre el desenlace que los tres sitios
    // con copy propio existen para separar, y mandaría a "Intenta de nuevo" sobre una fila que
    // no está. Llama la atención que el mock SÍ modelaba `PGRST116` a propósito y ningún caso
    // le pasaba una cadena con `.single()` al helper.
    const sb = sembrar();
    const { v, spy } = await correrH(sb.from('t').update({ v: 2 }).eq('id', 'zzz').select('id').single(), base);
    expect(v).toBe('sin_fila');
    expect(spy.warnsDe('s').length).toBe(1);
    expect(spy.erroresDe('s')).toEqual([]);
  });

  it('control: `.single()` que SÍ matchea sigue siendo ok', async () => {
    // Sin el control, tratar todo `.single()` como `sin_fila` pasaría el caso de arriba.
    const sb = sembrar();
    const { v, spy } = await correrH(sb.from('t').update({ v: 2 }).eq('id', 'a').select('id').single(), base);
    expect(v).toBe('ok');
    expect(spy.escrituras()).toEqual([]);
  });

  it('un error que NO es PGRST116 sigue saliendo como rechazo', async () => {
    // El otro control: sin él, tragarse todos los errores pasaría los dos de arriba.
    const sb = montar({ filas: { t: [{ id: 'a' }] }, fallos: { 't:update': 'rls' } });
    const { v, spy } = await correrH(sb.from('t').update({ v: 2 }).eq('id', 'a').select('id'), base);
    expect(v).toBe('error');
    expect(spy.erroresDe('s').length).toBe(1);
  });

  it('un RECHAZO de la promesa no se propaga: sale como error', async () => {
    const sb = montar({ filas: { t: [{ id: 'a' }] }, lanza: ['t:update'] });
    const { v, spy } = await correrH(sb.from('t').update({ v: 2 }).eq('id', 'a').select('id'), base);
    expect(v).toBe('error');
    expect(spy.erroresDe('s')[0][0].err).toMatch(/conexión cortada/);
  });

  it('ceroFilas:"esperado" devuelve ok y NO loguea', async () => {
    // El único sitio que lo usa es el DELETE que corrige la deuda opuesta. Si el default fuera
    // éste, los otros catorce perderían su diagnóstico de cero filas en silencio.
    const sb = sembrar();
    const { v, spy } = await correrH(
      sb.from('t').delete().eq('id', 'zzz').select('id'), { ...base, ceroFilas: 'esperado' });
    expect(v).toBe('ok');
    expect(spy.escrituras()).toEqual([]);
  });

  it('el default NO es "esperado": sin la opción, cero filas avisa', async () => {
    // El control del anterior. Sin él, un default cambiado pasaría los dos.
    const sb = sembrar();
    const { v, spy } = await correrH(sb.from('t').delete().eq('id', 'zzz').select('id'), base);
    expect(v).toBe('sin_fila');
    expect(spy.warnsDe('s').length).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// El celular personal NO vuelve a la superficie de soporte
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Por qué existe: un usuario llegó al celular PERSONAL de Favio el 28-ago-2026 y la hipótesis
 * era que lo había sacado de vortik.dev. No: se lo dio Neto. El intent `feedback` terminaba
 * con *"escríbenos al 970398192"* y el de `queja` con lo mismo.
 *
 * El guard NO puede ser "el número no aparece en el repo": en las líneas de Yape aparece a
 * propósito y tiene que seguir (es la cuenta que cobra). Lo que se prohíbe es el número en la
 * superficie de CONTACTO, y por eso se mide sobre la RESPUESTA que recibe la persona, no sobre
 * el archivo — un helper que lo interpole seguiría cayendo acá.
 *
 * Los cuatro desenlaces, no sólo el feliz: el copy del número vivía en el camino de FALLO del
 * feedback, que es justo el que nadie mira.
 */
describe('la superficie de soporte no reparte el número personal del admin', () => {
  // **El número va ESCRITO acá, no derivado de `ADMIN_NUMBER`.** Es la primera versión de este
  // bloque y la mató su propio control: en CI `ADMIN_WHATSAPP` vale la cadena `test`
  // (`.github/workflows/ci.yml`), así que la aguja quedaba en `"test"` y ninguna respuesta la
  // contiene nunca. El guard entero pasaba a VERDE mirando nada — con el celular de vuelta en
  // el copy — y sólo el control lo delató. Lo que se prohíbe es un número concreto que ya se
  // repartió, no "lo que diga el entorno".
  const PERSONAL = '51970398192';
  const LOCAL = '970398192';

  // Y además el configurado, si el entorno trae un teléfono de verdad: el día que el número
  // cambie, el nuevo también tiene que estar prohibido en la superficie de contacto.
  const { ADMIN_NUMBER } = require('../../lib/config');
  const configurado = String(ADMIN_NUMBER || '').replace(/[^0-9]/g, '');
  const AGUJAS = [PERSONAL, LOCAL].concat(configurado.length >= 9 ? [configurado] : []);

  // **Normaliza por TOKEN, no sobre el mensaje entero.** Borrar todos los no-dígitos de la
  // respuesta completa fabrica el número juntando cifras que no tienen nada que ver: el caso
  // de abajo, *"Llevas S/ 970.39 este mes en 8192 movimientos"*, colapsa a `970398192` exacto
  // y ponía el build rojo por un mensaje de plata inocente. Un guard que grita por lo que no es
  // se termina ignorando, y este vigila algo que ya se escapó una vez.
  //
  // Un token es una tirada de dígitos con los separadores que lleva un teléfono tecleado a mano
  // (espacios, guiones, puntos, paréntesis, +). Cualquier letra lo corta, que es justo lo que
  // separa "970.39 este mes" de "970 398 192".
  //
  // Evasión conocida y aceptada: partir el número con markdown (`9703*98192*`) lo esconde. No
  // se cubre porque la reintroducción realista es alguien volviendo a teclear el número, no
  // ofuscándolo; y bajar el umbral para atraparlo devuelve los falsos positivos de arriba.
  const contieneNumero = (t) => {
    const tokens = String(t || '').match(/\+?\d[\d\s\-().+]{6,}\d/g) || [];
    return tokens.some((tok) => { const d = tok.replace(/[^0-9]/g, ''); return AGUJAS.some((n) => d.includes(n)); });
  };

  // Control del propio guard. Sin esto, un detector roto pone en verde todo el bloque y el
  // archivo pasaría a afirmar "no está el número" sin poder verlo en ningún lado. Ya pasó.
  it('el detector ve el número donde SÍ está, y no lo inventa donde no', () => {
    expect(contieneNumero('Yapea al *' + LOCAL + '* y envíame la captura')).toBe(true);
    expect(contieneNumero('📲 Yapea al *+51 ' + LOCAL + '*')).toBe(true);
    // Espaciado y con guiones: es como se teclea un teléfono cuando alguien lo re-agrega.
    expect(contieneNumero('escríbenos al 970 398 192')).toBe(true);
    expect(contieneNumero('WhatsApp: +51-970-398-192')).toBe(true);
    expect(contieneNumero('Escríbenos a 📧 hola@neto.pe')).toBe(false);
    expect(contieneNumero('Escribe */soporte* y seguimos por acá')).toBe(false);
    // Un monto no es un teléfono: el normalizador junta dígitos y podría fabricar un match.
    expect(contieneNumero('Llevas S/ 970.39 este mes en 8192 movimientos')).toBe(false);
  });

  it('las agujas no están vacías (si no, el guard afirma sobre nada)', () => {
    // `includes("")` es TRUE siempre: una aguja vacía invertiría todo el bloque. Y una aguja
    // demasiado corta haría match contra cualquier cifra de un mensaje de plata.
    expect(AGUJAS.length).toBeGreaterThanOrEqual(2);
    for (const n of AGUJAS) expect(n.length).toBeGreaterThanOrEqual(9);
  });

  for (const nombre of ['queja', 'feedback']) {
    const sitio = porSitio(nombre);
    const clave = sitio.tabla + ':' + sitio.verbo;

    it(nombre + ': ninguno de los cuatro desenlaces imprime el número', async () => {
      const casos = [
        ['camino feliz', {}],
        ['la DB rechaza', { fallos: { [clave]: 'db caída' } }],
        ['cero filas', { vacios: [clave] }],
        ['la promesa rechaza', { lanza: [clave] }],
      ];
      for (const [etiqueta, opts] of casos) {
        const { invocar } = preparar(sitio, opts);
        const { res } = await correr(invocar);
        expect(contieneNumero(res), etiqueta + ': la respuesta trae el celular personal').toBe(false);
        // Y que la respuesta EXISTA: un handler que devuelve undefined pasaría lo de arriba.
        expect(String(res).length).toBeGreaterThan(10);
      }
    });
  }

  it('hablar_con_humano: el CATCH tampoco lo imprime', async () => {
    // El camino feliz de este intent abre sesión de soporte y nunca imprimió el número; el que
    // lo imprimía era su `catch`. Se fuerza inyectando un `abrirSesion` que tira, porque
    // moderacion.js hace el require ADENTRO del case y por eso la caché se consulta al invocar.
    const ruta = require.resolve('../../lib/support-tickets');
    const previo = require.cache[ruta];
    require.cache[ruta] = {
      id: ruta, filename: ruta, loaded: true,
      exports: { abrirSesion: () => { throw new Error('boom'); } },
    };
    try {
      const sb = montar({ filas: { usuarios: [u()] } });
      const { res } = await correr(() => H.moderacion.handle({
        intencion: 'hablar_con_humano', msg: 'quiero hablar con alguien', datos: {},
        usuario: u(), from: '+51999', ctx: ctxBase(sb),
      }));
      expect(contieneNumero(res)).toBe(false);
      expect(res).toMatch(/soporte/i);
    } finally {
      if (previo) require.cache[ruta] = previo; else delete require.cache[ruta];
    }
  });
});
