import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * CONFIRMACIÓN INCONDICIONAL — las 17 escrituras de `handlers/onboarding.js` (ítem 9D).
 *
 * Misma clase que 9A/9A-bis, otra superficie y otro daño. Allá el síntoma era un `'✅ Fecha
 * corregida'` sobre un gasto que no se movió; acá es una MÁQUINA DE ESTADOS, así que un update
 * perdido no produce sólo un mensaje falso: deja a alguien parado en un paso con la
 * confirmación ya enviada. Y por WhatsApp nadie vuelve a preguntar.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * LO QUE ESTE ARCHIVO TIENE QUE PODER DISTINGUIR, y es lo que define el mock
 *
 * Tres desenlaces, no dos:
 *
 *   1. **la escritura FALLÓ**            → `fallos`, que fabrica el `{ error }` de postgrest
 *   2. **la escritura no tocó NINGUNA fila** → la fila del usuario NO está sembrada, así que
 *      el `.eq('id', …)` del propio update no matchea. No es un stub: es el mecanismo de
 *      producción (`merge_and_link` movió la identidad, o la cuenta se borró en el medio)
 *   3. **el paso NO avanzó**             → se prueba **RE-LEYENDO LA FILA**, nunca mirando el
 *      mensaje. Es la única de las tres que el copy no puede fingir, y por eso el mock de 9A
 *      —con `filas` estático— no alcanzaba: acá un update que entra APLICA su patch y uno que
 *      falla no, así que `sb.fila('usuarios', 'u1').onboarding_paso` es una observación y no
 *      una declaración.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * EL HARNESS ES TRANSFERIDO, NO REINVENTADO
 *
 * La lección que pagó 9A-bis: llevar la clase de bug a otro archivo **sin llevar los
 * accesorios** produjo 14 supervivientes con la suite en verde. Los cuatro de
 * `escrituras-de-plata.test.js` están acá, y cada uno se gana el lugar:
 *
 *   · `filtros(tabla, verbo)` — el WHERE, expuesto. `intento()` dice que hubo un update, nunca
 *     sobre QUÉ. Los 17 sitios pisan `usuarios`: sin el `.eq('id', …)` un update del alta
 *     reescribe el plan de TODA la base, y eso sale verde si nadie mira el filtro.
 *   · `lanza` — el RECHAZO de la promesa, que postgrest-js no produce. Acá no es defensa en
 *     profundidad: `manejarOnboarding` corre dentro del try de `webhook.js:744`, cuyo catch
 *     (`:1004`) loguea y avisa al admin **sin responderle nada a la persona**. Sin el `catch`
 *     de `escribirUsuario`, un rechazo deja al usuario en silencio absoluto — y sin `lanza`
 *     ese `catch` es código sin medir.
 *   · `single` ≠ `maybeSingle` — `single()` sobre cero filas devuelve `PGRST116` en `error`,
 *     `maybeSingle()` devuelve `{data:null, error:null}`. El mock de 9A los modelaba iguales y
 *     lo declaraba como límite conocido; acá está cerrado, porque una guarda que decide por
 *     `if (error)` se comporta al revés según cuál se usó.
 *   · **el RETURNING modelado** — una escritura sin `.select()` devuelve `data: null` SIEMPRE.
 *     Es lo que hace que quitar el `.select('id')` sea una mutación que mata: sin él la guarda
 *     de cero filas dispararía en todas las escrituras y el alta le contestaría "se me trabó"
 *     a todo el mundo.
 *
 * Y el control que faltaba: **donde la guarda sólo escribe un LOG** (`nombre_intentos`), el
 * caso sano afirma que ese log **NO salió**. Sin esa mitad, un `log.warn` incondicional pasa
 * los dos casos y el archivo deja de discriminar.
 */

// ─── Dependencias: `onboarding.js` las DESTRUCTURA al cargar ─────────────────
// Hay que reemplazarlas en el módulo ANTES de requerirlo, si no la destructuración captura la
// función real. Por eso son `vi.fn()` estables cuya implementación se cambia por test, y no
// objetos que se reasignan.

const obtenerCuentasGmail = vi.fn().mockResolvedValue([]);
const revocarAccesoGmail = vi.fn().mockResolvedValue({ revocadas: 1, emails: ['a@x.com'] });
require('../../gmail').obtenerCuentasGmail = obtenerCuentasGmail;
require('../../gmail').revocarAccesoGmail = revocarAccesoGmail;

const crearCategoriasDesdeIndices = vi.fn().mockResolvedValue(undefined);
require('../../services/categories').crearCategoriasDesdeIndices = crearCategoriasDesdeIndices;

const interpretarComandoPresupuesto = vi.fn().mockResolvedValue({ es_presupuesto: false });
require('../../services/parsers').interpretarComandoPresupuesto = interpretarComandoPresupuesto;
require('../../services/budget').guardarPresupuesto = vi.fn().mockResolvedValue(undefined);

const borrarCuenta = vi.fn().mockResolvedValue({ ok: true, tieneGmail: false, resumen: {} });
require('../../services/account-deletion').borrarCuenta = borrarCuenta;

// `linkPanelPro` en null deja `colaReconexion` en cadena vacía: acá no se mide esa cola.
require('../../lib/trial').linkPanelPro = vi.fn(() => null);

const capture = vi.fn();
require('../../lib/analytics').capture = capture;

// ─── El doble de Supabase ────────────────────────────────────────────────────
//
// Se instala UNA vez (la destructuración de `onboarding.js` guarda esta referencia para
// siempre) y delega en el mock del test en curso.

let sbActual = null;
require('../../lib/db').supabase = {
  from: (tabla) => {
    if (!sbActual) throw new Error('el test no montó un mock de supabase (llamá a montar())');
    return sbActual.from(tabla);
  },
};

const MUTANTES = ['insert', 'update', 'delete', 'upsert'];

/**
 * @param filas  `{ tabla: [fila, …] }`. Las filas se MUTAN: un update que entra aplica su
 *               patch, que es lo que permite re-leer el estado en vez de creerle al mensaje.
 * @param fallos `{'tabla:verbo': 'motivo'}` o un ARRAY indexado por número de llamada
 *               (`['db caída', null]` = falla la primera, pasa la segunda). El array no es
 *               adorno: `/manual` y el paso del nombre hacen DOS updates sobre `usuarios`, y
 *               sin poder separarlos la mitad de cada par es inalcanzable desde un test.
 * @param vacios `'tabla:verbo'` — stub declarado de "cero filas". **Casi no se usa acá**: los
 *               casos de 0 filas se construyen NO sembrando la fila del usuario, para que las
 *               cero filas las produzca el WHERE del propio update. Un caso así también muere
 *               si alguien le quita el `.eq('id', …)`; el stub no.
 * @param lanza  `'tabla:verbo'` — fabrica un RECHAZO de la promesa.
 */
function montar({ filas = {}, fallos = {}, vacios = [], lanza = [] } = {}) {
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

    from(tabla) {
      let verbo = 'select';
      const b = {};
      const filtros = [];
      const passthrough = ['ilike', 'gte', 'lte', 'neq', 'not', 'order', 'limit'];
      for (const m of passthrough) b[m] = () => b;

      // `.select()` sobre una escritura es su cláusula RETURNING. Sin modelarla el mock miente
      // en la dirección peligrosa: quitarle el `.select('id')` a un update no cambiaría nada
      // acá y en producción lo cambia todo (postgrest devuelve `data: null` siempre, o sea que
      // la guarda de "0 filas" dispara en TODAS las escrituras).
      let retorno = false;
      let columnas = null;
      b.select = (cols) => {
        // Las columnas se guardan SIEMPRE (también sobre una lectura): proyectar es lo que
        // hace que a un `select` le pueda faltar una columna y se note. Lo que sólo aplica a
        // una escritura es `retorno`, que es la marca de "esto es un RETURNING".
        columnas = cols || columnas;
        if (verbo !== 'select') retorno = true;
        return b;
      };
      b.eq = (col, val) => { filtros.push([col, val]); return b; };
      b.is = (col, val) => { filtros.push([col, val]); return b; };

      for (const m of MUTANTES) {
        b[m] = (payload) => {
          if (verbo === 'select') { verbo = m; llamadas.push({ tabla, verbo: m, payload, filtros }); }
          return b;
        };
      }

      const matchean = () => tabla_(tabla).filter((f) => filtros.every(([c, v]) => f[c] === v));
      // Proyecta como PostgREST: `.select('id')` devuelve `{id}`, no la fila entera. Un doble
      // que devuelve todo hace invisible que a la query le falte una columna (ya pasó con
      // `bindActivacion`, ver DEFECTOS 2026-08-18).
      const proyectar = (f) => {
        if (!columnas) return { ...f };
        const out = {};
        for (const c of String(columnas).split(',').map((s) => s.trim())) out[c] = f[c];
        return out;
      };

      const resolver = () => {
        if (verbo === 'select') llamadas.push({ tabla, verbo: 'select', filtros });
        if (lanza.includes(tabla + ':' + verbo)) throw new Error('conexión cortada');
        const err = fallo(tabla + ':' + verbo);
        // Una escritura rechazada NO aplica su patch. Es la mitad del doble que hace que
        // re-leer la fila signifique algo.
        if (err) return { data: null, error: { message: err, code: 'XX000' } };
        if (verbo === 'select') return { data: matchean().map(proyectar), error: null };

        const objetivo = vacios.includes(tabla + ':' + verbo) ? [] : matchean();
        if (verbo === 'update') for (const f of objetivo) Object.assign(f, b.__payload);
        if (verbo === 'insert' || verbo === 'upsert') {
          const nuevas = Array.isArray(b.__payload) ? b.__payload : [b.__payload];
          for (const f of nuevas) tabla_(tabla).push({ ...f });
        }
        if (verbo === 'delete') {
          for (const f of objetivo) filas[tabla].splice(filas[tabla].indexOf(f), 1);
        }
        // Sin RETURNING no hay filas, pase lo que pase con el WHERE.
        if (!retorno) return { data: null, error: null };
        // Con RETURNING y cero coincidencias, postgrest devuelve `[]` (no `null`).
        return { data: objetivo.map(proyectar), error: null };
      };

      // El payload del primer verbo mutante, que es el que manda.
      const updateOrig = b.update;
      b.update = (payload) => { if (verbo === 'select') b.__payload = payload; return updateOrig(payload); };
      const insertOrig = b.insert;
      b.insert = (payload) => { if (verbo === 'select') b.__payload = payload; return insertOrig(payload); };

      /**
       * `single()` y `maybeSingle()` NO son sinónimos, y el mock de 9A los modelaba iguales
       * declarándolo como límite. Sobre cero filas `single()` devuelve `PGRST116` en `error` y
       * `maybeSingle()` devuelve `{data:null, error:null}`: una guarda que decide por
       * `if (error)` se comporta al revés según cuál se haya escrito. Está cerrado acá para
       * que la próxima escritura del alta que use uno de los dos no salga verde por el doble.
       */
      const uno = (esSingle) => {
        const r = resolver();
        if (r.error) return r;
        const arr = Array.isArray(r.data) ? r.data : (r.data == null ? [] : [r.data]);
        if (arr.length === 1) return { data: arr[0], error: null };
        if (!esSingle) return { data: arr.length ? arr[0] : null, error: null };
        return {
          data: null,
          error: {
            code: 'PGRST116',
            message: arr.length === 0
              ? 'JSON object requested, multiple (or no) rows returned'
              : 'JSON object requested, multiple (or no) rows returned',
          },
        };
      };
      b.single = async () => uno(true);
      b.maybeSingle = async () => uno(false);
      b.then = (ok, ko) => Promise.resolve(resolver()).then(ok, ko);
      b.catch = (ko) => Promise.resolve(resolver()).catch(ko);
      return b;
    },
  };
  sbActual = sb;
  return sb;
}

const { manejarOnboarding } = require('../../handlers/onboarding');

// ─── Espía de logs ───────────────────────────────────────────────────────────
// pino exporta un singleton CJS, así que el handler mira la MISMA referencia y el spy la ve.
const log = require('../../lib/logger');

function espiarLog() {
  const errores = [];
  const warns = [];
  const origE = log.error.bind(log);
  const origW = log.warn.bind(log);
  log.error = (...a) => { errores.push(a); };
  log.warn = (...a) => { warns.push(a); };
  return {
    errores,
    warns,
    /** Todo rastro de una escritura del alta, sin importar el nivel. */
    escrituras: () => [...errores, ...warns].filter((a) => a[0] && a[0].tag === 'ALTA_ESCRITURA'),
    restaurar: () => { log.error = origE; log.warn = origW; },
  };
}

async function correr(sb, entrada) {
  const spy = espiarLog();
  try {
    const res = await manejarOnboarding({
      usuario: entrada.usuario,
      msg: entrada.msg,
      cmd: entrada.cmd !== undefined ? entrada.cmd : entrada.msg.toLowerCase().trim(),
    });
    return { res, spy };
  } finally {
    spy.restaurar();
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Los 17 sitios
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Un `paso` por sitio: es el discriminador del log Y la clave de esta tabla, así que dos
 * entradas no pueden colapsar sin que se note.
 *
 * `desenlace` es lo que NO comparten. `mensaje` = se le dice a la persona (y `noAparece`
 * enumera lo que ese mensaje tiene prohibido llevar); `aviso` = la confirmación es verdad y se
 * queda, con una cola que advierte; `silencioso` = el copy no cambia y lo único que queda es
 * el log.
 */
const BASE = {
  id: 'u1', whatsapp: '+51999', nombre: null, nombre_intentos: 0,
  plan: 'premium', trial_estado: 'activo', onboarding_paso: 0,
  onboarding_completado: false, gmail_access_token: null, premium_vence: null,
};
const u = (extra) => ({ ...BASE, ...extra });

/** Otro usuario, siempre sembrado: si un update pierde su `.eq('id', …)`, lo pisa. */
const OTRO = () => u({ id: 'u-999', nombre: 'Otro', plan: 'free', onboarding_paso: 7, nombre_intentos: 4 });

const SITIOS = [
  {
    paso: 'completar_alta',
    entrada: () => ({ usuario: u({ onboarding_paso: 100 }), msg: 'saltar' }),
    escribe: { onboarding_paso: 0, onboarding_completado: true },
    exito: /Anótame tu primer gasto/i,
    // Decisión declarada en el código: el copy NO cambia. El paso 100 deja pasar cualquier
    // mensaje que parezca gasto hacia el pipeline, así que quien haga lo que el mensaje pide
    // lo ve registrado y reintenta el cierre. Lo que se arregla es la telemetría.
    desenlace: { tipo: 'silencioso' },
  },
  {
    paso: 'desconectar_una',
    cuentas: [{ id: 'g1', email: 'a@x.com' }, { id: 'g2', email: 'b@x.com' }],
    entrada: () => ({ usuario: u({ onboarding_paso: -1 }), msg: '1' }),
    escribe: { onboarding_paso: 0 },
    exito: /a@x\.com desconectado/i,
    desenlace: { tipo: 'aviso', conserva: /a@x\.com desconectado/i },
  },
  {
    paso: 'desconectar_todas',
    cuentas: [{ id: 'g1', email: 'a@x.com' }, { id: 'g2', email: 'b@x.com' }],
    entrada: () => ({ usuario: u({ onboarding_paso: -1 }), msg: '3' }),
    escribe: { onboarding_paso: 0 },
    exito: /Todas las cuentas Gmail desconectadas/i,
    desenlace: { tipo: 'aviso', conserva: /Todas las cuentas Gmail desconectadas/i },
  },
  {
    paso: 'desconectar',
    cuentas: [{ id: 'g1', email: 'a@x.com' }],
    entrada: () => ({ usuario: u({ onboarding_paso: -1 }), msg: '1' }),
    escribe: { onboarding_paso: 0 },
    exito: /Gmail desconectado/i,
    desenlace: { tipo: 'aviso', conserva: /Gmail desconectado/i },
  },
  {
    paso: 'cancelar_menu',
    cuentas: [],
    entrada: () => ({ usuario: u({ onboarding_paso: -1 }), msg: 'mejor no' }),
    escribe: { onboarding_paso: 0 },
    exito: /Cancelado\. Tu cuenta sigue igual/i,
    desenlace: { tipo: 'aviso', conserva: /Tu cuenta sigue igual/i },
  },
  {
    paso: 'nombre_intentos',
    entrada: () => ({ usuario: u({ onboarding_paso: 100, nombre_intentos: 0 }), msg: 'A' }),
    escribe: { nombre_intentos: 1 },
    exito: /No pillé tu nombre/i,
    // El ÚNICO de los 17 que sólo se anota: el copy ya lleva la salida (*saltar*).
    desenlace: { tipo: 'silencioso' },
  },
  {
    paso: 'nombre',
    // dos updates sobre `usuarios` (el nombre y el cierre del alta): el fallo va al PRIMERO.
    fallosSolo: ['db caída', null],
    entrada: () => ({ usuario: u({ onboarding_paso: 100 }), msg: 'maria' }),
    escribe: { nombre: 'Maria' },
    exito: /Listo, \*Maria\*/i,
    desenlace: { tipo: 'mensaje', fallo: /¡Listo! 🤝/, noAparece: [/Maria/] },
  },
  {
    paso: 'plan_free',
    entrada: () => ({ usuario: u({ onboarding_paso: 1 }), msg: 'free' }),
    escribe: { plan: 'free', onboarding_paso: 0, onboarding_completado: true },
    exito: /Bienvenido a Neto Free/i,
    desenlace: {
      tipo: 'mensaje',
      fallo: /Se me trabó activando tu plan/i,
      noAparece: [/Bienvenido a Neto Free/i],
    },
  },
  {
    paso: 'elige_pro',
    entrada: () => ({ usuario: u({ onboarding_paso: 1 }), msg: 'pro' }),
    escribe: { onboarding_paso: 2 },
    exito: /Elige tu plan/i,
    desenlace: {
      tipo: 'mensaje',
      fallo: /Escríbeme \*pro\* otra vez/i,
      // Lo que NO puede llevar: el número de Yape. `esperaComprobante()` reconoce la captura
      // por `onboarding_paso === 2`, así que sin ese 2 escrito el pago se registra como gasto.
      noAparece: [/970398192/, /Elige tu plan/i],
    },
  },
  {
    paso: 'rechaza_plan',
    entrada: () => ({ usuario: u({ onboarding_paso: 1 }), msg: 'no' }),
    escribe: { onboarding_paso: 0 },
    exito: /escribe \*hola\* cuando quieras/i,
    desenlace: {
      tipo: 'mensaje',
      fallo: /escribe \*free\* y seguimos gratis/i,
      // El *hola* del copy bueno no funciona desde el paso 1: la guarda de este paso se come
      // el saludo antes de que llegue a los triggers de entrada.
      noAparece: [/escribe \*hola\* cuando quieras/i],
    },
  },
  {
    paso: 'tipo_plan_mensual',
    entrada: () => ({ usuario: u({ onboarding_paso: 2 }), msg: '1' }),
    escribe: { tipo_plan: 'mensual' },
    exito: /Plan \*mensual\*/i,
    desenlace: {
      tipo: 'mensaje',
      fallo: /No yapees todavía/i,
      noAparece: [/970398192/, /Yapea S\//i],
    },
  },
  {
    paso: 'tipo_plan_anual',
    entrada: () => ({ usuario: u({ onboarding_paso: 2 }), msg: '2' }),
    escribe: { tipo_plan: 'anual' },
    exito: /Plan \*anual\*/i,
    desenlace: {
      tipo: 'mensaje',
      fallo: /No yapees todavía/i,
      noAparece: [/970398192/, /Yapea S\//i],
    },
  },
  {
    paso: 'categorias',
    entrada: () => ({ usuario: u({ onboarding_paso: 10 }), msg: '1 3' }),
    escribe: { onboarding_paso: 20, onboarding_completado: true },
    exito: /¿Quieres configurar un presupuesto mensual\?/i,
    desenlace: {
      tipo: 'mensaje',
      fallo: /escríbeme \*\/presupuesto\*/i,
      // La invitación al presupuesto es lo que se cae: sin el paso 20, un "limite de 500
      // soles en Comida" cae a los triggers de abajo y se registra como GASTO de 500.
      noAparece: [/¿Quieres configurar un presupuesto mensual\?/i, /limite de 500/i],
      conserva: /Categorias activadas/i,
    },
  },
  {
    paso: 'presupuesto_listo',
    entrada: () => ({ usuario: u({ onboarding_paso: 20, onboarding_completado: true, nombre: 'Ana' }), msg: 'listo' }),
    escribe: { onboarding_paso: 0 },
    exito: /Ya estoy trabajando por ti/i,
    desenlace: {
      tipo: 'mensaje',
      fallo: /Escríbeme \*listo\* otra vez/i,
      noAparece: [/Ya estoy trabajando por ti/i],
    },
  },
  {
    paso: 'pide_nombre_hola',
    entrada: () => ({ usuario: u({ onboarding_paso: 0 }), msg: 'hola' }),
    escribe: { onboarding_paso: 100 },
    exito: /¿Cómo te llamas\?/i,
    desenlace: {
      tipo: 'mensaje',
      fallo: /Se me trabó justo al arrancar/i,
      // Preguntar el nombre sin dejar escrito que lo esperamos abre el bucle que este paso
      // dejó de tener a propósito: la respuesta vuelve a caer por el mismo trigger.
      noAparece: [/¿Cómo te llamas\?/i],
    },
  },
  {
    paso: 'manual_plan_free',
    fallosSolo: ['db caída', null],
    entrada: () => ({ usuario: u({ nombre: 'Ana' }), msg: '/manual' }),
    escribe: { plan: 'free' },
    exito: /Anótame tu primer gasto/i,
    // A propósito NO comparte arreglo con `plan_free`: acá el cierre del alta es una escritura
    // aparte que puede entrar igual, así que un plan perdido no encierra a nadie.
    desenlace: { tipo: 'silencioso' },
  },
  {
    paso: 'pide_nombre_nuevo',
    entrada: () => ({ usuario: u({ onboarding_paso: 0 }), msg: 'buenas' }),
    escribe: { onboarding_paso: 100 },
    exito: /¿Cómo te llamas\?/i,
    desenlace: {
      tipo: 'mensaje',
      fallo: /Se me trabó justo al arrancar/i,
      noAparece: [/¿Cómo te llamas\?/i],
    },
  },
];

beforeEach(() => {
  capture.mockClear();
  obtenerCuentasGmail.mockResolvedValue([]);
  crearCategoriasDesdeIndices.mockClear();
  // `borrarCuenta` y `revocarAccesoGmail` se afirman con `toHaveBeenCalled()` más abajo. Sin
  // limpiarlos, una llamada de un test ANTERIOR deja esas aserciones pasando por su cuenta:
  // un verde que no viene del caso que dice medir.
  borrarCuenta.mockClear();
  revocarAccesoGmail.mockClear();
  interpretarComandoPresupuesto.mockResolvedValue({ es_presupuesto: false });
  sbActual = null;
});

/** Prepara el mock con la fila del usuario sembrada (o no) más el usuario testigo. */
function preparar(sitio, { conFila = true, ...opts } = {}) {
  const entrada = sitio.entrada();
  if (sitio.cuentas) obtenerCuentasGmail.mockResolvedValue(sitio.cuentas);
  const filas = { usuarios: conFila ? [{ ...entrada.usuario }, OTRO()] : [OTRO()] };
  return { entrada, sb: montar({ filas, ...opts }) };
}

/** El mensaje que corresponde cuando la escritura NO entró, según el desenlace del sitio. */
function afirmarDesenlace(sitio, res) {
  const d = sitio.desenlace;
  if (d.tipo === 'silencioso') {
    // el copy no cambia: sigue siendo el del camino feliz
    expect(res).toMatch(sitio.exito);
    return;
  }
  if (d.tipo === 'aviso') {
    // la confirmación es verdad y se conserva; lo que se agrega es la advertencia. Lo que la
    // advertencia tiene que decir es "no mandes un número": mandar a un `/comando` NO cierra
    // el menú (ningún `/x` toca `onboarding_paso`), y esa fue la primera versión, equivocada.
    expect(res).toMatch(d.conserva);
    expect(res).toMatch(/No me escribas nada que empiece con un número/i);
    expect(res).toMatch(/se me trabó cerrando el menú/i);
    return;
  }
  expect(res).toMatch(d.fallo);
  for (const no of d.noAparece || []) expect(res).not.toMatch(no);
  if (d.conserva) expect(res).toMatch(d.conserva);
}

describe('9D · las 17 escrituras del alta: los tres desenlaces', () => {
  for (const sitio of SITIOS) {
    describe(sitio.paso, () => {
      it('la escritura entra → confirma, deja el estado escrito y no anota nada', async () => {
        const { entrada, sb } = preparar(sitio);
        const { res, spy } = await correr(sb, entrada);
        expect(res).toMatch(sitio.exito);
        // 1) el estado quedó escrito — re-leyendo la fila, no mirando el mensaje
        const fila = sb.fila('usuarios', 'u1');
        for (const [col, val] of Object.entries(sitio.escribe)) expect(fila[col]).toEqual(val);
        // 2) **el control del caso sano**: ni un rastro de escritura fallida. Sin esta mitad,
        // un log incondicional pasaría los dos casos y el archivo dejaría de discriminar —
        // que es exactamente lo que le faltaba al sitio que sólo loguea.
        expect(spy.escrituras()).toEqual([]);
      });

      it('la escritura FALLÓ → lo dice según su desenlace, y el paso NO avanzó', async () => {
        const { entrada, sb } = preparar(sitio, {
          fallos: { 'usuarios:update': sitio.fallosSolo || 'db caída' },
        });
        const original = { ...entrada.usuario };
        const { res, spy } = await correr(sb, entrada);

        // 0) se intentó de verdad: si no, el verde vendría de un `return` anterior
        expect(sb.intento('usuarios', 'update')).toBe(true);
        // 1) apuntando a la fila de ESTE usuario
        expect(sb.filtros('usuarios', 'update')).toEqual([['id', 'u1']]);
        // 2) quedó rastro, con su tag y su paso: es lo único observable en producción
        const anotado = spy.errores.find((a) => a[0] && a[0].tag === 'ALTA_ESCRITURA' && a[0].paso === sitio.paso);
        expect(anotado, 'no quedó rastro de que la escritura falló').toBeTruthy();
        expect(anotado[0].userId).toBe('u1');
        expect(String(anotado[1])).toMatch(/rechazó el update/i);
        // 3) el mensaje de su clase
        afirmarDesenlace(sitio, res);
        // 4) **el paso NO avanzó**, y esto se prueba re-leyendo la fila
        const fila = sb.fila('usuarios', 'u1');
        for (const col of Object.keys(sitio.escribe)) expect(fila[col]).toEqual(original[col]);
      });

      it('la escritura no tocó NINGUNA fila → lo anota distinto, y no pisa a nadie más', async () => {
        // La fila del usuario NO está sembrada: las cero filas las produce el `.eq('id', …)`
        // del propio update, no un stub. Es el mecanismo real (`merge_and_link` movió la
        // identidad, la cuenta se borró) y además mata la mutación que quita el WHERE.
        const { entrada, sb } = preparar(sitio, { conFila: false });
        const testigo = { ...sb.fila('usuarios', 'u-999') };
        const { res, spy } = await correr(sb, entrada);

        expect(sb.intento('usuarios', 'update')).toBe(true);
        const anotado = spy.warns.find((a) => a[0] && a[0].tag === 'ALTA_ESCRITURA' && a[0].paso === sitio.paso);
        expect(anotado, 'no quedó rastro de que la escritura no tocó nada').toBeTruthy();
        expect(anotado[0].userId).toBe('u1');
        expect(String(anotado[1])).toMatch(/CERO filas/i);
        // el diagnóstico es OTRO que el de "la DB lo rechazó": es lo que decide a dónde mira
        // quien lea el log
        expect(spy.errores.some((a) => a[0] && a[0].tag === 'ALTA_ESCRITURA')).toBe(false);
        afirmarDesenlace(sitio, res);
        // y el update no se derramó sobre el resto de la tabla
        expect(sb.fila('usuarios', 'u-999')).toEqual(testigo);
      });

      it('si el cliente RECHAZA, contesta igual en vez de dejar a la persona muda', async () => {
        // postgrest-js no produce este rechazo, así que el mock lo fabrica. Acá no es defensa
        // decorativa: sin el `catch` de `escribirUsuario` el throw sube al try de webhook.js,
        // cuyo catch loguea y avisa al admin pero NO le responde nada al usuario.
        const { entrada, sb } = preparar(sitio, { lanza: ['usuarios:update'] });
        // **La aserción principal es que la llamada RESUELVE**, y va escrita: sin ella este
        // caso parecería no tener aserción propia (el rechazo lo delataría igual poniendo el
        // test rojo, pero eso se lee como un error del test y no como el invariante).
        const llamada = correr(sb, entrada);
        await expect(llamada, 'el rechazo subió a webhook, que no le contesta nada a la persona')
          .resolves.toBeDefined();
        const { res, spy } = await llamada;
        const anotado = spy.errores.find((a) => a[0] && a[0].tag === 'ALTA_ESCRITURA' && a[0].paso === sitio.paso);
        expect(anotado, 'el rechazo no dejó rastro').toBeTruthy();
        expect(anotado[0].err).toMatch(/conexión cortada/);
        afirmarDesenlace(sitio, res);
      });
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Lo que NO comparte forma con la tabla: una decisión por sitio
// ═════════════════════════════════════════════════════════════════════════════

describe('9D · completarAlta: la telemetría deja de afirmar un cierre que no ocurrió', () => {
  const eventos = (nombre) => capture.mock.calls.filter((c) => c[1] === nombre);

  it('cierre que entra → wa_onboarding_completed y step_ok', async () => {
    const { entrada, sb } = preparar(SITIOS[0]);
    await correr(sb, entrada);
    expect(eventos('wa_onboarding_completed')).toHaveLength(1);
    expect(eventos('wa_onboarding_step_ok')).toHaveLength(1);
    expect(eventos('wa_onboarding_step_failed')).toHaveLength(0);
  });

  it('cierre que NO entra → ni completed ni step_ok, y el motivo distingue la causa', async () => {
    // Es el evento con el que se decide dónde se cae la gente en el embudo. Emitirlo sobre un
    // cierre que no entró produce el número que menos se puede auditar: nadie va a cruzar 82
    // eventos contra 82 filas.
    const { entrada, sb } = preparar(SITIOS[0], { fallos: { 'usuarios:update': 'db caída' } });
    await correr(sb, entrada);
    expect(eventos('wa_onboarding_completed')).toHaveLength(0);
    expect(eventos('wa_onboarding_step_ok')).toHaveLength(0);
    expect(eventos('wa_onboarding_step_failed')[0][2]).toEqual({ paso: 100, motivo: 'cierre_no_entro' });
  });

  it('cierre sobre CERO filas → el motivo lo separa del rechazo de la DB', async () => {
    const { entrada, sb } = preparar(SITIOS[0], { conFila: false });
    await correr(sb, entrada);
    expect(eventos('wa_onboarding_completed')).toHaveLength(0);
    expect(eventos('wa_onboarding_step_failed')[0][2]).toEqual({ paso: 100, motivo: 'cierre_sin_fila' });
  });

  it('el gasto sigue pasando al pipeline aunque el cierre no entre (la recuperación)', async () => {
    // **Este caso ES la decisión de no cambiar el copy de `completarAlta`.** Si el cierre
    // fallara y devolviéramos un mensaje de error, el gasto de la persona se perdería: el
    // `null` es lo que lo manda a `message-processor`. Cambiar eso por un texto rompería la
    // única recuperación que tiene el paso 100.
    const { entrada, sb } = preparar(
      { ...SITIOS[0], entrada: () => ({ usuario: u({ onboarding_paso: 100 }), msg: 'gasté 20 en taxi' }) },
      { fallos: { 'usuarios:update': 'db caída' } },
    );
    const { res } = await correr(sb, entrada);
    expect(res).toBeNull();
    expect(sb.intento('usuarios', 'update')).toBe(true);
  });
});

/**
 * Los tres `wa_onboarding_step_failed` nuevos del paso 1.
 *
 * **Estaban sin afirmar y sin mutación**, que es el mismo hueco que la revisión adversarial de
 * 9B encontró con los `LECTURA_CAIDA`: la observabilidad que nadie prueba se borra sola y sale
 * verde. Acá alimentan el embudo del alta, o sea el número con el que se decide dónde se cae
 * la gente — y los motivos distinguen "rechazó el plan" de "no le pudimos escribir el plan",
 * que son dos cosas opuestas contadas en el mismo bucket.
 */
describe('9D · el paso 1 distingue el rechazo del usuario del fallo de escritura', () => {
  const motivos = () => capture.mock.calls
    .filter((c) => c[1] === 'wa_onboarding_step_failed').map((c) => c[2].motivo);

  for (const [paso, motivoMalo] of [
    ['plan_free', 'plan_free_no_entro'],
    ['elige_pro', 'paso_pro_no_entro'],
    ['rechaza_plan', 'rechaza_plan_no_entro'],
  ]) {
    it(`${paso}: la escritura que no entra sale como "${motivoMalo}"`, async () => {
      const { entrada, sb } = preparar(SITIOS.find((s) => s.paso === paso), {
        fallos: { 'usuarios:update': 'db caída' },
      });
      await correr(sb, entrada);
      expect(motivos()).toContain(motivoMalo);
    });
  }

  it('control: cuando la escritura entra, el motivo malo NO aparece', async () => {
    // `rechaza_plan` es el único de los tres que emite un `step_failed` en el camino feliz
    // (la persona rechazó el plan, que es un desenlace del embudo y no un fallo). Sin este
    // control, un motivo emitido siempre pasaría los tres casos de arriba.
    const { entrada, sb } = preparar(SITIOS.find((s) => s.paso === 'rechaza_plan'));
    await correr(sb, entrada);
    expect(motivos()).toEqual(['rechaza_plan']);
  });

  it('control positivo: free y categorías SÍ emiten wa_onboarding_completed cuando entran', async () => {
    // El negativo de más abajo ("0 eventos cuando falla") no dice nada sin su positivo: con el
    // evento borrado del todo, los dos casos saldrían verdes.
    for (const paso of ['plan_free', 'categorias']) {
      capture.mockClear();
      const { entrada, sb } = preparar(SITIOS.find((s) => s.paso === paso));
      await correr(sb, entrada);
      expect(capture.mock.calls.filter((c) => c[1] === 'wa_onboarding_completed'), paso).toHaveLength(1);
    }
  });
});

describe('9D · el nombre no se afirma si no se guardó, pero el alta se cierra igual', () => {
  it('el nombre falla → saluda sin nombre Y el alta queda cerrada', async () => {
    // Dos escrituras distintas y una no arrastra a la otra: es la misma decisión que ya tomó
    // `nombre_intentos` (vale más un usuario adentro que uno trabado con su nombre).
    const { entrada, sb } = preparar(SITIOS.find((s) => s.paso === 'nombre'), {
      fallos: { 'usuarios:update': ['db caída', null] },
    });
    const { res } = await correr(sb, entrada);
    expect(res).toMatch(/¡Listo! 🤝/);
    expect(res).not.toMatch(/Maria/);
    const fila = sb.fila('usuarios', 'u1');
    expect(fila.nombre).toBeNull();
    expect(fila.onboarding_completado).toBe(true);
    expect(fila.onboarding_paso).toBe(0);
  });

  it('el nombre entra y el CIERRE falla → saluda CON el nombre (control del de arriba)', async () => {
    // Sin este control, el caso anterior podría estar verde porque el saludo perdió el nombre
    // siempre. Mismo par de updates, invertido cuál falla.
    const { entrada, sb } = preparar(SITIOS.find((s) => s.paso === 'nombre'), {
      fallos: { 'usuarios:update': [null, 'db caída'] },
    });
    const { res } = await correr(sb, entrada);
    expect(res).toMatch(/Listo, \*Maria\*/);
    expect(sb.fila('usuarios', 'u1').nombre).toBe('Maria');
    expect(sb.fila('usuarios', 'u1').onboarding_completado).toBe(false);
  });
});

describe('9D · el paso 1: el plan que no entra deja a la persona ENCERRADA en el menú', () => {
  it('free que no entra: el plan queda como estaba y el paso sigue en 1', async () => {
    // La dirección del daño es lo que esconde este bug: le REGALA Pro a quien eligió Free, así
    // que no hay usuario que reclame. Lo que sí encierra es el paso.
    const { entrada, sb } = preparar(SITIOS.find((s) => s.paso === 'plan_free'), {
      fallos: { 'usuarios:update': 'db caída' },
    });
    const { res } = await correr(sb, entrada);
    const fila = sb.fila('usuarios', 'u1');
    expect(fila.plan).toBe('premium');
    expect(fila.onboarding_paso).toBe(1);
    expect(fila.onboarding_completado).toBe(false);
    // y el mensaje da la palabra que SÍ funciona desde adentro del paso 1
    expect(res).toMatch(/\*free\*/);
    expect(capture.mock.calls.filter((c) => c[1] === 'wa_onboarding_completed')).toHaveLength(0);
  });

  it('pro que no entra: no se entregan los datos de pago', async () => {
    // `esperaComprobante()` (lib/pro-payment.js) reconoce la captura leyendo
    // `onboarding_paso === 2`. Sin ese 2, quien yapea recibe su pago registrado como un GASTO
    // de S/10 y su Pro no se activa: dar el número sabiendo que el estado no entró es cobrar
    // a ciegas.
    const { entrada, sb } = preparar(SITIOS.find((s) => s.paso === 'elige_pro'), {
      fallos: { 'usuarios:update': 'db caída' },
    });
    const { res } = await correr(sb, entrada);
    expect(res).not.toMatch(/970398192/);
    expect(res).toMatch(/no yapees todavía/i);
    expect(sb.fila('usuarios', 'u1').onboarding_paso).toBe(1);
  });
});

describe('9D · el paso 2: el tipo_plan decide cuánto yapear', () => {
  for (const [cmd, tipo] of [['1', 'mensual'], ['2', 'anual']]) {
    it(`"${cmd}" que no entra: no se pide monto y la columna queda intacta`, async () => {
      // El mensaje bueno ES el que dice cuánto yapear, así que confirmarlo sin haber escrito
      // la elección hace que la persona transfiera una cifra sobre un estado que no existe.
      // (El motivo NO es que la aprobación lea esta columna: `resolverTipoPlan` prioriza el
      // monto del comprobante y la columna es el respaldo — ver el comentario del handler.)
      const sitio = SITIOS.find((s) => s.paso === 'tipo_plan_' + tipo);
      const { entrada, sb } = preparar(sitio, { fallos: { 'usuarios:update': 'db caída' } });
      const { res } = await correr(sb, entrada);
      expect(res).not.toMatch(/Yapea S\//i);
      expect(res).not.toMatch(/970398192/);
      expect(res).toMatch(/No yapees todavía/i);
      // El respaldo queda sin escribir, y `resolverTipoPlan` cae a 'mensual' en silencio
      // cuando Vision no puede leer el monto: ése es el caso que de verdad cobra de menos.
      expect(sb.fila('usuarios', 'u1').tipo_plan).toBeUndefined();
    });
  }
});

describe('9D · el menú del paso -1: un menú que no se cierra apunta al borrado total', () => {
  // Con las cuentas ya revocadas el menú pasa a tener UNA sola opción: `1` = eliminar todo. O
  // sea que un "1" escrito por inercia después de un "✅ Gmail desconectado" dispara el wipe.
  // Por eso el aviso manda a un `/comando`, que es lo único que escapa la máquina de estados.
  it('la desconexión SÍ ocurrió, así que el ✅ se conserva y lo que se agrega es la advertencia', async () => {
    const { entrada, sb } = preparar(SITIOS.find((s) => s.paso === 'desconectar'), {
      fallos: { 'usuarios:update': 'db caída' },
    });
    const { res } = await correr(sb, entrada);
    expect(revocarAccesoGmail).toHaveBeenCalled();
    expect(res).toMatch(/✅ \*Gmail desconectado\*/);
    expect(res).toMatch(/No me escribas nada que empiece con un número/i);
    expect(sb.fila('usuarios', 'u1').onboarding_paso).toBe(-1);
  });

  it('el "1" siguiente, con el menú abierto y cero cuentas, es el borrado total (por qué existe el aviso)', async () => {
    // No es una hipótesis: se ejercita el estado que deja el caso de arriba.
    obtenerCuentasGmail.mockResolvedValue([]);
    const sb = montar({ filas: { usuarios: [u({ onboarding_paso: -1 })] } });
    const { res } = await correr(sb, { usuario: u({ onboarding_paso: -1 }), msg: '1' });
    expect(borrarCuenta).toHaveBeenCalled();
    expect(res).toMatch(/Cuenta eliminada/i);
  });

  it('camino feliz: el aviso NO sale cuando el menú sí se cerró', async () => {
    const { entrada, sb } = preparar(SITIOS.find((s) => s.paso === 'desconectar'));
    const { res } = await correr(sb, entrada);
    expect(res).not.toMatch(/No me escribas nada que empiece/i);
    expect(res).not.toMatch(/se me trabó/i);
    expect(sb.fila('usuarios', 'u1').onboarding_paso).toBe(0);
  });
});

describe('9D · categorías: las creadas se confirman, la invitación que no va a funcionar no', () => {
  it('las categorías se crearon igual, y no se emite el cierre del alta', async () => {
    const { entrada, sb } = preparar(SITIOS.find((s) => s.paso === 'categorias'), {
      fallos: { 'usuarios:update': 'db caída' },
    });
    const { res } = await correr(sb, entrada);
    expect(crearCategoriasDesdeIndices).toHaveBeenCalled();
    expect(res).toMatch(/Categorias activadas/i);
    expect(res).not.toMatch(/limite de 500/i);
    expect(capture.mock.calls.filter((c) => c[1] === 'wa_onboarding_completed')).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// El doble de pruebas, probado
// ═════════════════════════════════════════════════════════════════════════════

/**
 * **Un fixture más benévolo que la realidad convierte al guard en decoración**, y ya pasó dos
 * veces en este repo (`meta_aportes` el 04-ago, `bindActivacion` el 18-ago). Los accesorios de
 * este mock son la mitad de lo que hace que los casos de arriba midan algo, así que se prueban
 * solos: si mañana alguien "simplifica" el RETURNING o iguala `single` con `maybeSingle`, cae
 * acá y no dentro de un caso de onboarding, donde se leería como otra cosa.
 */
describe('9D · el mock cumple el contrato de PostgREST', () => {
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

  it('una escritura RECHAZADA no aplica su patch', async () => {
    const sb = montar({ filas: { usuarios: [{ id: 'a', paso: 1 }] }, fallos: { 'usuarios:update': 'rls' } });
    const { error } = await sb.from('usuarios').update({ paso: 9 }).eq('id', 'a').select('id');
    expect(error.message).toBe('rls');
    expect(sb.fila('usuarios', 'a').paso).toBe(1);
  });

  it('single() sobre cero filas da PGRST116 y maybeSingle() no', async () => {
    // El límite que el mock de 9A declaraba y no cerraba. Una guarda que decide por
    // `if (error)` se comporta al revés según cuál de los dos se haya escrito.
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
});
