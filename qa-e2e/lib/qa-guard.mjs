// Barrera de datos para los harness de qa-e2e.
//
// POR QUÉ EXISTE. Los harness corren contra la Supabase de PRODUCCIÓN con la
// service key, que ignora RLS. No hay staging, y no lo va a haber: el valor de
// estos harness es justamente que ejercitan el backend y la DB de verdad. La
// consecuencia es que un `usuario_id` equivocado en un cleanup borra los datos
// de alguien que paga, sin red debajo — el borrado por service role es duro y no
// pasa por `transacciones_eliminadas`.
//
// QUÉ HACE. Envuelve el cliente de Supabase e intercepta cada operación en el
// momento en que se ejecuta (no cuando se construye: los filtros se agregan
// DESPUÉS de `.delete()`, así que validar antes no vería nada). Las lecturas
// pasan libres. Las escrituras tienen que estar fijadas a un sujeto permitido:
//
//   1. Todo valor filtrado sobre una columna de dueño (`usuario_id`, `user_id`,
//      y el `id` cuando la tabla es `usuarios`) tiene que estar en la allowlist
//      de usuarios QA. Si aparece un id que no está, aborta. Este es el punto
//      que cierra el caso del 01-ago-2026.
//   2. Además, la operación tiene que tener AL MENOS un filtro que la fije: por
//      dueño, o por una fila registrada durante esta corrida. Un UPDATE o un
//      DELETE sin `where` que fije el sujeto aborta siempre.
//
// Una fila queda registrada cuando la creó esta corrida (INSERT que devuelve id)
// o cuando salió de un SELECT que ya estaba fijado a un usuario permitido. Ese
// segundo caso es lo que hace que el patrón normal de los harness — leer las
// filas del usuario QA y después borrarlas por id — siga funcionando sin
// excepciones a mano.
//
// NO HAY INTERRUPTOR PARA APAGARLA. Si un harness necesita tocar un usuario que
// no está en la lista, la respuesta es registrarlo con `permitirUsuarioDePrueba`
// (que verifica `is_test_user` contra la DB antes de aceptarlo), no saltear la
// barrera. Una barrera con bypass no es una barrera.
//
// LÍMITES CONOCIDOS, para que nadie la crea más ancha de lo que es:
//   · Solo cubre lo que pasa por el cliente de Supabase. El SQL ad-hoc (editor
//     del dashboard, MCP) no lo ve nadie desde acá — para eso está el trigger de
//     auditoría de la migración 055.
//   · No cubre Storage ni el Admin API de Auth.
//   · De los RPC solo valida los declarados en RPC_DESTRUCTIVOS.
//   · **No ve las CASCADAS.** Valida la fila que se toca, no las que Postgres borra
//     detrás por una FK `ON DELETE CASCADE`. Un DELETE fijado por `creador_id` sobre
//     `gastos_compartidos` se lleva sus `gasto_participantes`, y esas hijas pueden tener
//     un `usuario_id` que la barrera nunca miró. Hoy es inocuo (las hijas son de usuarios
//     QA), pero el día que una cascada alcance filas ajenas la barrera no lo va a impedir.

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Usuario QA histórico. Los harness anteriores a qa.env lo tienen hardcodeado.
const QA_LEGACY = 'ded7e219-e5fd-4ff4-b5a3-3cd5cdffd172';

// Columnas que identifican al DUEÑO de la fila. Un filtro sobre cualquiera de
// estas fija la operación a un usuario, y ese usuario tiene que estar permitido.
// `referrer_id`/`referido_id` son las columnas de dueño de `referidos`, que no tiene
// `usuario_id`. Sin ellas la barrera no podía FIJAR ninguna operación sobre esa tabla, así
// que la bloqueaba entera (fail-closed, correcto) — y el efecto colateral era que ningún
// harness podía ejercitar referidos. Se descubrió al escribir el E2E del premio del referrer
// en trial (auditoría 2026-08-04): la barrera tenía un punto ciego que se leía como "no se
// puede testear esto". Agregarlas no la relaja: convierte un bloqueo total en una validación
// de dueño, que es lo que hace con el resto de las tablas.
// `creador_id` entra por el mismo motivo, y se descubrió igual: `gastos_compartidos` no
// tiene `usuario_id`, así que la barrera no podía FIJAR ninguna escritura sobre esa tabla
// y la bloqueaba entera. Fail-closed es correcto, pero el efecto colateral era que los
// gastos compartidos (split) no se podían ejercitar desde ningún harness — y son la mitad
// de S′10. Agregarla no relaja nada: convierte un bloqueo total en validación de dueño.
const COLS_DUENO = ['usuario_id', 'user_id', 'referrer_id', 'referido_id', 'creador_id'];

// Columnas que identifican una FILA concreta. Sirven para fijar la operación si
// la fila fue creada o leída por esta corrida.
// `gasto_id` NO está acá, y se sacó después de medirlo: el harness de invite codes lo pedía
// para limpiar `gasto_participantes`, pero esa FK es `ON DELETE CASCADE`, así que borrar el
// `gastos_compartidos` padre ya se lleva las hijas. Ampliar la barrera para una limpieza que
// no hacía falta es superficie regalada.
const COLS_FILA = ['id', 'space_id', 'tx_id', 'deuda_id', 'meta_id'];

// RPC que mueven o borran datos de usuarios. El valor es la lista de argumentos
// que tienen que apuntar a usuarios permitidos.
const RPC_DESTRUCTIVOS = { merge_and_link: ['p_survivor', 'p_loser'] };

const usuariosPermitidos = new Set();
const filasPermitidas = new Set();
const stats = { lecturas: 0, escrituras: 0, bloqueos: 0 };
let cargada = false;
let clienteCrudo = null; // cliente sin envolver, para las verificaciones del propio guard

class QaGuardError extends Error {}

function leerQaEnv() {
  try {
    const txt = readFileSync(join(homedir(), '.config', 'neto', 'qa.env'), 'utf8');
    const env = {};
    for (const linea of txt.split(/\r?\n/)) {
      const m = linea.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) env[m[1]] = m[2].trim();
    }
    return env;
  } catch {
    return {};
  }
}

function cargarAllowlist() {
  if (cargada) return;
  cargada = true;
  const env = leerQaEnv();
  const candidatos = [
    QA_LEGACY,
    env.NETO_QA_USUARIO_ID,
    env.NETO_QA_FREE_USUARIO_ID,
    env.NETO_QA_M3_USUARIO_ID,
    ...String(process.env.NETO_QA_EXTRA_IDS || '').split(',').map((s) => s.trim()),
  ];
  for (const id of candidatos) {
    if (id && UUID_RE.test(id)) usuariosPermitidos.add(id.toLowerCase());
  }
  if (usuariosPermitidos.size === 0) {
    throw new QaGuardError(
      'qa-guard: no se pudo armar la allowlist de usuarios QA. Falta ~/.config/neto/qa.env ' +
      'con NETO_QA_USUARIO_ID. Sin allowlist no se corre nada: fallar cerrado es el punto.',
    );
  }
}

// ── Lectura de los filtros de PostgREST ───────────────────────────────────────
// Solo `eq.` e `in.(...)` fijan el sujeto. `like`, `gt`, `is` y compañía pueden
// matchear filas de cualquiera, así que para el guard no cuentan como fijación.
function valoresDelFiltro(raw) {
  if (raw.startsWith('eq.')) return [raw.slice(3)];
  if (raw.startsWith('in.(')) {
    return raw.slice(4, raw.endsWith(')') ? -1 : undefined)
      .split(',')
      .map((v) => v.replace(/^"|"$/g, ''))
      .filter(Boolean);
  }
  return null;
}

const permitido = (id) => usuariosPermitidos.has(String(id).toLowerCase());

function abortar(detalle) {
  stats.bloqueos += 1;
  throw new QaGuardError(
    'qa-guard BLOQUEÓ una escritura: ' + detalle +
    '\n  Usuarios permitidos: ' + [...usuariosPermitidos].join(', ') +
    '\n  Si el objetivo es un usuario de prueba legítimo, registralo con ' +
    'permitirUsuarioDePrueba(id) (verifica is_test_user contra la DB). No hay bypass.',
  );
}

function filasDelBody(body) {
  if (!body) return [];
  return Array.isArray(body) ? body : [body];
}

function validarInsert(tabla, body) {
  // Un INSERT no destruye datos, pero sí puede ensuciar producción: una fila en
  // `usuarios` sin is_test_user entra al embudo y a las métricas como si fuera
  // un alta real. Ver el baseline del embudo en memory project_funnel_baseline.
  const filas = filasDelBody(body);
  if (tabla === 'usuarios') {
    for (const fila of filas) {
      if (fila && fila.is_test_user !== true) {
        abortar('INSERT en `usuarios` sin is_test_user=true. Un usuario de harness ' +
          'que no está marcado como de prueba contamina el embudo y las métricas.');
      }
    }
    // El throwaway que acaba de crear ESTA corrida, con is_test_user=true a la
    // vista, entra solo a la allowlist. Sin esto cada harness de throwaway
    // tendría que registrarlo a mano y la barrera se volvería un trámite que se
    // saltea. Lo que la barrera cuida es que nadie escriba sobre un usuario que
    // no nació de prueba acá adentro.
    return { altaDeThrowaway: true };
  }
  for (const fila of filas) {
    for (const col of COLS_DUENO) {
      if (fila && fila[col] != null && !permitido(fila[col])) {
        abortar('INSERT en `' + tabla + '` con ' + col + '=' + fila[col] + ', que no es un usuario QA.');
      }
    }
  }
  return { fijadoPorDueno: false };
}

function validarEscritura(tabla, metodo, params) {
  let fijadoPorDueno = false;
  let fijadoPorFila = false;

  // Regla 1: todo lo que se filtre por dueño tiene que ser un usuario permitido.
  const colsDueno = tabla === 'usuarios' ? ['id', ...COLS_DUENO] : COLS_DUENO;
  for (const col of colsDueno) {
    const raw = params.get(col);
    if (!raw) continue;
    const valores = valoresDelFiltro(raw);
    if (!valores) {
      abortar(metodo + ' sobre `' + tabla + '` filtrando ' + col + ' con "' + raw +
        '". Solo eq. e in.(...) fijan el sujeto; un operador abierto puede alcanzar a cualquiera.');
    }
    for (const v of valores) {
      if (!permitido(v)) {
        abortar(metodo + ' sobre `' + tabla + '` apuntando a ' + col + '=' + v +
          ', que NO es un usuario de QA. Esto es exactamente el borrado del 01-ago-2026.');
      }
    }
    fijadoPorDueno = true;
  }

  // Regla 2: si no quedó fijado por dueño, tiene que apuntar a filas de esta corrida.
  if (!fijadoPorDueno && tabla !== 'usuarios') {
    for (const col of COLS_FILA) {
      const raw = params.get(col);
      if (!raw) continue;
      const valores = valoresDelFiltro(raw);
      if (!valores) continue;
      if (valores.every((v) => filasPermitidas.has(String(v)))) {
        fijadoPorFila = true;
        break;
      }
      abortar(metodo + ' sobre `' + tabla + '` por ' + col + '=' + valores.join(',') +
        ', filas que esta corrida no creó ni leyó bajo un filtro de usuario QA.');
    }
  }

  if (!fijadoPorDueno && !fijadoPorFila) {
    abortar(metodo + ' sobre `' + tabla + '` sin ningún filtro que fije el sujeto ' +
      '(' + (params.toString() || 'sin filtros') + '). Un WHERE abierto alcanza a toda la tabla.');
  }
  return { fijadoPorDueno };
}

function validar(builder, tabla) {
  cargarAllowlist();
  const metodo = builder.method;
  const params = builder.url.searchParams;
  if (metodo === 'GET' || metodo === 'HEAD') {
    stats.lecturas += 1;
    // Un SELECT fijado a un usuario permitido habilita las filas que devuelve:
    // si se pudo leer bajo ese filtro, son de ese usuario.
    const colsDueno = tabla === 'usuarios' ? ['id', ...COLS_DUENO] : COLS_DUENO;
    const fijado = colsDueno.some((col) => {
      const raw = params.get(col);
      const valores = raw && valoresDelFiltro(raw);
      return !!valores && valores.every(permitido);
    });
    return { cosechar: fijado };
  }
  const info = metodo === 'POST'
    ? validarInsert(tabla, builder.body)
    : validarEscritura(tabla, metodo, params);
  stats.escrituras += 1;
  return { cosechar: true, ...info };
}

// Registra los ids que devolvió una operación ya validada, para que un borrado
// posterior por id no necesite excepción manual.
function cosechar(resultado, info) {
  const filas = Array.isArray(resultado?.data) ? resultado.data
    : resultado?.data ? [resultado.data] : [];
  for (const fila of filas) {
    if (!fila || fila.id == null) continue;
    filasPermitidas.add(String(fila.id));
    if (info?.altaDeThrowaway && UUID_RE.test(String(fila.id))) {
      usuariosPermitidos.add(String(fila.id).toLowerCase());
    }
  }
}

// ── Envoltura del cliente ─────────────────────────────────────────────────────
function envolverBuilder(builder, tabla) {
  const proxy = new Proxy(builder, {
    get(target, prop, receiver) {
      if (prop === 'then') {
        const info = validar(target, tabla); // lanza si no pasa
        return (onOk, onErr) => Reflect.get(target, 'then', target).call(
          target,
          (res) => {
            if (info.cosechar && !res?.error) cosechar(res, info);
            return onOk ? onOk(res) : res;
          },
          onErr,
        );
      }
      const val = Reflect.get(target, prop, target);
      if (typeof val !== 'function') return val;
      return (...args) => {
        const out = val.apply(target, args);
        // Los filtros de postgrest-js devuelven `this`; hay que seguir devolviendo
        // el proxy o la cadena se escapa de la barrera en el primer `.eq()`.
        return out === target ? receiver : out;
      };
    },
  });
  return proxy;
}

function envolverQueryBuilder(qb, tabla) {
  return new Proxy(qb, {
    get(target, prop) {
      const val = Reflect.get(target, prop, target);
      if (typeof val !== 'function') return val;
      return (...args) => envolverBuilder(val.apply(target, args), tabla);
    },
  });
}

function validarRpc(nombre, args) {
  const cols = RPC_DESTRUCTIVOS[nombre];
  if (!cols) return;
  cargarAllowlist();
  for (const col of cols) {
    const v = args?.[col];
    if (v != null && !permitido(v)) {
      abortar('rpc ' + nombre + '() con ' + col + '=' + v + ', que no es un usuario de QA.');
    }
  }
}

// Verificación de que la barrera realmente puede leer lo que necesita. Si una
// versión de postgrest-js cambia estos internos, el guard falla CERRADO acá en
// vez de dejar pasar todo en silencio.
function autoverificar(client) {
  const sonda = client.from('__qa_guard_probe__');
  const b = Reflect.get(sonda, 'delete').call(sonda);
  const conFiltro = b.eq('usuario_id', 'sonda');
  if (conFiltro.method !== 'DELETE' || conFiltro.url.searchParams.get('usuario_id') !== 'eq.sonda') {
    throw new QaGuardError(
      'qa-guard: no puedo inspeccionar el builder de postgrest-js (method/url cambiaron). ' +
      'La barrera no puede garantizar nada, así que no se corre.',
    );
  }
}

function envolverCliente(client) {
  if (client.__qaGuard) return client;
  autoverificar(client);
  const fromReal = client.from.bind(client);
  const rpcReal = client.rpc.bind(client);
  client.from = (tabla) => envolverQueryBuilder(fromReal(tabla), tabla);
  client.rpc = (nombre, args, opts) => { validarRpc(nombre, args); return rpcReal(nombre, args, opts); };
  client.__qaGuard = true;
  return client;
}

// Cliente SIN envolver, solo para que el propio guard pueda comprobar
// `is_test_user`. Si pasara por la barrera se mordería la cola: no puede leer un
// usuario que todavía no está permitido.
function crudo() {
  if (clienteCrudo) return clienteCrudo;
  const { SUPABASE_URL, SUPABASE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new QaGuardError('qa-guard: faltan SUPABASE_URL/SUPABASE_KEY para verificar is_test_user.');
  }
  clienteCrudo = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
  return clienteCrudo;
}

// ── API pública ───────────────────────────────────────────────────────────────

/**
 * Envuelve el cliente COMPARTIDO del backend (`lib/db`) en su sitio. Como muta la
 * instancia y no el export, los módulos que ya hicieron `const { supabase } =
 * require('../lib/db')` quedan cubiertos igual: es el mismo objeto. Eso cubre las
 * escrituras que hacen los services del backend cuando el harness los importa,
 * que es el camino por el que un harness podría tocar a un usuario real.
 * @param {Function} requireFn  el `require` del harness (createRequire)
 * @param {string} rutaLibDb    ruta a lib/db.js resuelta por el harness
 */
export function instalarGuard(requireFn, rutaLibDb) {
  const db = requireFn(rutaLibDb);
  envolverCliente(db.supabase);
  return db.supabase;
}

/** Reemplazo directo de createClient() para los harness que arman el suyo. */
export function clienteGuardado(url, key, opts = { auth: { persistSession: false } }) {
  return envolverCliente(createClient(url, key, opts));
}

export { envolverCliente };

/**
 * Suma un usuario a la allowlist, después de comprobar contra la DB que es de
 * prueba. Es el único camino para operar sobre un usuario que no venía en
 * qa.env — típicamente un throwaway que el harness acaba de crear.
 */
export async function permitirUsuarioDePrueba(id) {
  cargarAllowlist();
  if (!id || !UUID_RE.test(String(id))) throw new QaGuardError('permitirUsuarioDePrueba: id inválido: ' + id);
  if (permitido(id)) return id;
  const { data, error } = await crudo()
    .from('usuarios').select('id, is_test_user, whatsapp, nombre').eq('id', id).maybeSingle();
  if (error) throw new QaGuardError('permitirUsuarioDePrueba: no pude leer el usuario ' + id + ': ' + error.message);
  if (!data) throw new QaGuardError('permitirUsuarioDePrueba: no existe el usuario ' + id);
  if (data.is_test_user !== true) {
    throw new QaGuardError(
      'permitirUsuarioDePrueba: ' + id + ' NO tiene is_test_user=true (nombre=' + data.nombre +
      ', whatsapp=' + data.whatsapp + '). Es un usuario real: el harness no lo toca.',
    );
  }
  usuariosPermitidos.add(String(id).toLowerCase());
  return id;
}

/** Registra una fila que esta corrida creó por fuera del cliente (ej. vía la API HTTP). */
export function permitirFila(...ids) {
  for (const id of ids.flat()) if (id != null) filasPermitidas.add(String(id));
}

/** Línea de resumen para el final del harness. */
export function resumenGuard() {
  return 'qa-guard: ' + stats.escrituras + ' escrituras permitidas, ' +
    stats.lecturas + ' lecturas, ' + stats.bloqueos + ' bloqueos, ' +
    usuariosPermitidos.size + ' usuarios en la allowlist';
}

export { QaGuardError };
