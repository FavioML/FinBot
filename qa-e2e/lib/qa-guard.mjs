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
//   · **Inspecciona el BUILDER, no el request que sale.** Un cliente armado con un `fetch`
//     propio que reescriba la request después de validar (le agregue un `Prefer`, le cambie el
//     body) pasa. Es código hostil, no un descuido, y cerrarlo pide validar dentro de un fetch
//     envuelto: decisión aparte. Lo encontró la revisión adversarial del 12-sep.

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
// `borrar_cuenta_total` (migración 073) es el RPC más destructivo que existe: borra 24 tablas
// y anonimiza la fila de `usuarios` en una sola transacción. Sin declararlo acá la barrera lo
// dejaba pasar entero — solo valida los RPC que conoce — y un `p_usuario_id` equivocado en un
// harness borraba la cuenta de alguien que paga, que es exactamente el caso del 01-ago-2026
// que este archivo existe para cerrar.
const RPC_DESTRUCTIVOS = {
  merge_and_link: ['p_survivor', 'p_loser'],
  borrar_cuenta_total: ['p_usuario_id'],
};

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

// ── Altas que hace el CÓDIGO BAJO PRUEBA, no el harness ───────────────────────
//
// La regla de `is_test_user` de abajo protege contra lo que SIEMBRA un harness. Hay un caso en
// que la fila sin la marca la escribe el código que se está probando, y la marca no se le puede
// pedir: `altaPorBsuid` (helpers/db-helpers.js) da de alta a quien escribe sin número con
// `{ whatsapp: null, bsuid }`, y esa forma exacta es lo que hay que verificar
// (`qa-bsuid-alta.mjs`).
//
// No es un interruptor: el harness DECLARA el BSUID antes de mandar el mensaje, y la barrera
// admite solo una fila que no puede ser de nadie real:
//   · el BSUID lleva el prefijo de harness `PE.qa` (Meta los emite como `PE.<dígitos>`, y
//     `PE.qa*` es el prefijo que el CLAUDE.md ya separa de los eventos reales al contar);
//   · la fila es EXACTAMENTE `{ whatsapp: null, bsuid }`, una por INSERT y una por declaración;
//   · nunca por upsert;
//   · y **la barrera la MARCA `is_test_user` en el mismo instante en que nace**, con el cliente
//     crudo, antes de devolverle la fila al código. Si el INSERT no devolvió el `id` (sin
//     `.select()`), la marca va por la forma: ese BSUID y sin número. Si la marca no toca
//     exactamente una fila, la operación falla.
//
// La marca al nacer es la decisión que cierra la clase, y llegó en la segunda vuelta. La primera
// vez la marca la ponía el harness después de verificar, y la barrera cuidaba la fila sin marca
// ENUMERANDO lo que no podía ganar (número, email, cuenta): la revisión adversarial le cambió el
// `bsuid` por uno real, le puso plan y tokens, y pasó. Enumerar lo prohibido deja siempre la
// columna siguiente. Con la marca puesta antes de que nadie más escriba, la fila sin marca no
// existe más que durante el INSERT: el cuerpo que mandó el código queda registrado en
// `altasRegistradas(bsuid).cuerpos` (esa es la prueba de que nació como nace en producción) y
// después es un throwaway más. El cuerpo se registra solo si el INSERT terminó bien: un 23505 de
// una carrera no es un alta.
//
// Lo único que se sigue vigilando sobre esa fila es su IDENTIDAD, `bsuid` incluido: un fixture
// marcado con el número o el BSUID de una persona real la deja muda, porque `enviarWhatsapp` la
// reconoce como de prueba y no le escribe (ver `qa-usuarios-marcados.mjs`). Y ningún UPDATE
// puede quitarle la marca a nadie (ver `validarEscritura`).
const BSUID_DE_HARNESS = /^PE\.qa[A-Za-z0-9]{8,}$/;
const altasDeclaradas = new Map(); // bsuid -> { intentos, ids, cuerpos }
const idsDeAltas = new Set();      // filas nacidas por esta vía
const CLAVES_DEL_ALTA = new Set(['bsuid', 'whatsapp']);
const CLAVES_DE_IDENTIDAD = ['whatsapp', 'email', 'supabase_auth_id', 'bsuid'];

function altaDeclarada(fila) {
  if (!fila || typeof fila.bsuid !== 'string') return null;
  const alta = altasDeclaradas.get(fila.bsuid);
  if (!alta || alta.ids.length > 0) return null;
  if (!Object.keys(fila).every((k) => CLAVES_DEL_ALTA.has(k))) return null;
  if (fila.whatsapp != null) return null;
  return alta;
}

function registrarAlta(alta, id, cuerpo) {
  const lower = String(id).toLowerCase();
  if (!alta.ids.includes(lower)) {
    alta.ids.push(lower);
    alta.cuerpos.push({ ...cuerpo });
  }
  idsDeAltas.add(lower);
  usuariosPermitidos.add(lower);
  filasPermitidas.add(String(id));
}

// Pone la marca con el cliente CRUDO (el mismo cliente, sin la envoltura), repitiendo la forma
// en el WHERE. Si no toca exactamente una fila, lanza: el código bajo prueba recibe un error en
// vez de una fila sin marca, y el harness lo ve como un alta que falló. Sin `id` (el INSERT no
// pidió RETURNING), la busca por la forma y la registra con el id que devuelve la marca.
async function marcarAlta(alta, bsuid, desdeCrudo, id, cuerpo) {
  let res;
  try {
    let q = desdeCrudo('usuarios').update({ is_test_user: true }).eq('bsuid', bsuid).is('whatsapp', null);
    if (id) q = q.eq('id', id);
    res = await q.select('id');
  } catch (e) {
    res = { error: { message: e && e.message } };
  }
  if (res.error || !Array.isArray(res.data) || res.data.length !== 1 || res.data[0].id == null) {
    stats.bloqueos += 1;
    throw new QaGuardError('qa-guard: la fila ' + (id || 'del BSUID ' + bsuid) + ' del alta por BSUID nació y NO ' +
      'se pudo marcar como de prueba (' + (res.error ? res.error.message : (res.data ? res.data.length : 0) + ' filas') +
      '). Puede haber quedado viva sin marca en producción: revísala y bórrala a mano.');
  }
  if (!id) registrarAlta(alta, res.data[0].id, cuerpo);
}

// ── Upserts ───────────────────────────────────────────────────────────────────
//
// Un `.upsert()` sale como POST, igual que un INSERT, pero PostgREST lo resuelve con `ON CONFLICT`
// contra una fila que YA EXISTE y devuelve ESA. Validado como INSERT, un upsert con el `id` de un
// usuario real pasaba y `cosechar` lo adoptaba como de QA; la regla del throwaway lo tenía desde
// antes (`upsert({ id: REAL, is_test_user: true })` además le ponía la marca a la persona real).
//
// La primera respuesta fue prohibirlo entero, y rompía al código bajo prueba: `guardarReglaComercio`,
// `guardarPresupuesto` y `upsertScore` hacen upsert por el cliente compartido, así que un harness en
// proceso veía un "bug de Neto" que era de la barrera (segunda revisión del 12-sep). La regla que
// quedó admite exactamente la forma que usa el backend:
//   · nunca sobre `usuarios`;
//   · siempre con `on_conflict`: sin él, PostgREST resuelve por la clave primaria, y la barrera no
//     sabe cuál es (la tercera revisión: en una tabla con PK sin columna de dueño, el upsert se
//     quedaría con la fila de otro). Los ocho upserts del backend lo declaran;
//   · toda fila trae un dueño, y todo dueño es un usuario permitido;
//   · el conflicto se resuelve por una columna de dueño presente en la fila, así que la fila en
//     conflicto tiene por construcción el mismo dueño.
function esUpsert(builder) {
  const h = builder.headers;
  const prefer = h && typeof h.get === 'function' ? h.get('Prefer') : h && (h.Prefer || h.prefer);
  return /resolution=/i.test(String(prefer || '')) || builder.url.searchParams.has('on_conflict');
}

function validarUpsert(tabla, builder, body) {
  if (tabla === 'usuarios') {
    abortar('UPSERT sobre `usuarios`. PostgREST lo resuelve contra una fila que ya existe y devuelve ' +
      'ESA, así que la barrera adoptaría a su dueño como usuario de QA.');
  }
  const conflicto = (builder.url.searchParams.get('on_conflict') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (conflicto.length === 0) {
    abortar('UPSERT sobre `' + tabla + '` sin on_conflict: se resuelve por la clave primaria, que la ' +
      'barrera no conoce, así que la fila en conflicto puede ser de otra persona.');
  }
  const duenosDelConflicto = conflicto.filter((c) => COLS_DUENO.includes(c));
  for (const fila of filasDelBody(body)) {
    const duenos = COLS_DUENO.filter((c) => fila && fila[c] != null);
    if (duenos.length === 0 || !duenos.every((c) => permitido(fila[c]))) {
      abortar('UPSERT sobre `' + tabla + '` con una fila sin dueño permitido (' + JSON.stringify(fila) + ').');
    }
    const porDueno = duenosDelConflicto.length > 0 && duenosDelConflicto.every((c) => fila[c] != null && permitido(fila[c]));
    if (!porDueno) {
      abortar('UPSERT sobre `' + tabla + '` que resuelve el conflicto por ' + conflicto.join(',') +
        ', sin una columna de dueño de esta fila: la fila en conflicto puede ser de otra persona.');
    }
  }
}

function validarInsert(tabla, body) {
  // Un INSERT no destruye datos, pero sí puede ensuciar producción: una fila en
  // `usuarios` sin is_test_user entra al embudo y a las métricas como si fuera
  // un alta real. Ver el baseline del embudo en memory project_funnel_baseline.
  const filas = filasDelBody(body);
  if (tabla === 'usuarios') {
    let altaBsuid = null;
    let cuerpoAlta = null;
    for (const fila of filas) {
      if (!fila || fila.is_test_user === true) continue;
      const alta = filas.length === 1 ? altaDeclarada(fila) : null;
      if (alta) {
        alta.intentos += 1;
        altaBsuid = fila.bsuid;
        cuerpoAlta = { ...fila };
        continue;
      }
      abortar('INSERT en `usuarios` sin is_test_user=true. Un usuario de harness ' +
        'que no está marcado como de prueba contamina el embudo y las métricas. Si la fila ' +
        'la escribe el código bajo prueba (el alta por BSUID), declarala antes con ' +
        'esperarAltaPorBsuid(bsuid).');
    }
    // El throwaway que acaba de crear ESTA corrida, con is_test_user=true a la
    // vista, entra solo a la allowlist. Sin esto cada harness de throwaway
    // tendría que registrarlo a mano y la barrera se volvería un trámite que se
    // saltea. Lo que la barrera cuida es que nadie escriba sobre un usuario que
    // no nació de prueba acá adentro.
    return { altaDeThrowaway: true, altaBsuid, cuerpoAlta };
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

// La otra escritura que el alta por BSUID hace por su cuenta: `adoptarErroresPrevios` engancha a
// la fila nueva las filas de `errores` que ese BSUID dejó cuando todavía era anónimo
// (`UPDATE errores SET usuario_id = <nuevo> WHERE bsuid = ? AND usuario_id IS NULL`). La regla 1
// la rechaza, porque `is.null` no fija a nadie, y en general eso es lo correcto. Se admite ESTA
// forma y ninguna vecina: exactamente esos dos filtros, el BSUID declarado, y un cuerpo que solo
// escribe `usuario_id` con el id que esa misma alta creó. Nada de eso alcanza filas de otro.
function esAdopcionDeErroresDeUnaAlta(tabla, metodo, params, body) {
  if (tabla !== 'errores' || metodo !== 'PATCH') return false;
  if ([...params.keys()].sort().join(',') !== 'bsuid,usuario_id') return false;
  if (params.getAll('usuario_id').join() !== 'is.null') return false;
  const raw = params.getAll('bsuid');
  if (raw.length !== 1 || !raw[0].startsWith('eq.')) return false;
  const alta = altasDeclaradas.get(raw[0].slice(3));
  if (!alta || !body || typeof body !== 'object' || Array.isArray(body)) return false;
  const claves = Object.keys(body);
  return claves.length === 1 && claves[0] === 'usuario_id' &&
    alta.ids.includes(String(body.usuario_id).toLowerCase());
}

function validarEscritura(tabla, metodo, params, body) {
  if (esAdopcionDeErroresDeUnaAlta(tabla, metodo, params, body)) return { fijadoPorDueno: false };
  if (tabla === 'usuarios' && body && typeof body === 'object') {
    if (Array.isArray(body)) abortar(metodo + ' sobre `usuarios` con un cuerpo lista: un UPDATE no lleva filas.');
    // Quitarle la marca a un usuario de prueba lo convierte en un alta "real" para el embudo y los
    // crons, sin que nadie lo haya sembrado así. Ningún harness lo hace; la barrera lo prohíbe
    // para todos (tercera revisión del 12-sep).
    if ('is_test_user' in body && body.is_test_user !== true) {
      abortar(metodo + ' sobre `usuarios` que le quita la marca is_test_user a una fila de prueba.');
    }
    // La fila de un alta por BSUID no puede ganar una identidad: marcada como de prueba, un número
    // o un BSUID real la vuelven un fixture que deja muda a esa persona.
    const ids = valoresDelFiltro(params.get('id') || '') || [];
    const toca = CLAVES_DE_IDENTIDAD.filter((k) => body[k] != null);
    if (toca.length && ids.some((v) => idsDeAltas.has(String(v).toLowerCase()))) {
      abortar(metodo + ' sobre la fila de un alta por BSUID que le escribe ' + toca.join(', ') +
        '. Esa fila es de prueba y no puede tomar la identidad de una persona.');
    }
  }
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
  // Se valida una COPIA serializada del cuerpo y esa copia es la que sale. Si no, un getter que
  // devuelve otra cosa en la segunda lectura, o un `toJSON`, mandaba un cuerpo distinto del que
  // la barrera miró (revisión adversarial del 12-sep).
  let body = builder.body;
  if (body !== undefined) {
    body = JSON.parse(JSON.stringify(body));
    builder.body = body;
  }
  if (metodo === 'POST' && esUpsert(builder)) validarUpsert(tabla, builder, body);
  const info = metodo === 'POST'
    ? validarInsert(tabla, body)
    : validarEscritura(tabla, metodo, params, body);
  stats.escrituras += 1;
  return { cosechar: true, ...info };
}

// Registra los ids que devolvió una operación ya validada, para que un borrado
// posterior por id no necesite excepción manual. Devuelve los ids de altas por BSUID que
// acaban de nacer, para que la envoltura los marque antes de devolverle la fila al código.
function cosechar(resultado, info) {
  const filas = Array.isArray(resultado?.data) ? resultado.data
    : resultado?.data ? [resultado.data] : [];
  const nacidas = [];
  for (const fila of filas) {
    if (!fila || fila.id == null) continue;
    filasPermitidas.add(String(fila.id));
    if (info?.altaDeThrowaway && UUID_RE.test(String(fila.id))) {
      usuariosPermitidos.add(String(fila.id).toLowerCase());
      if (info.altaBsuid) {
        registrarAlta(altasDeclaradas.get(info.altaBsuid), fila.id, info.cuerpoAlta);
        nacidas.push(String(fila.id));
      }
    }
  }
  return nacidas;
}

// ── Envoltura del cliente ─────────────────────────────────────────────────────
// `desdeCrudo` es el `from` SIN envolver del mismo cliente: lo usa la marca de las altas.
function envolverBuilder(builder, tabla, desdeCrudo) {
  const proxy = new Proxy(builder, {
    get(target, prop, receiver) {
      if (prop === 'then') {
        const info = validar(target, tabla); // lanza si no pasa
        return (onOk, onErr) => Reflect.get(target, 'then', target).call(
          target,
          (res) => {
            const nacidas = info.cosechar && !res?.error ? cosechar(res, info) : [];
            // Un alta que terminó bien pero no devolvió la fila (sin `.select()`) también se
            // marca: por la forma, en vez de por el id (tercera revisión del 12-sep).
            const sinId = !!info.altaBsuid && !res?.error && nacidas.length === 0;
            if (nacidas.length || sinId) {
              const alta = altasDeclaradas.get(info.altaBsuid);
              const marcas = sinId
                ? [marcarAlta(alta, info.altaBsuid, desdeCrudo, null, info.cuerpoAlta)]
                : nacidas.map((id) => marcarAlta(alta, info.altaBsuid, desdeCrudo, id));
              // El fallo de la marca va a `onErr` a mano. `await` llama `then(resolve, reject)`, y
              // una promesa rechazada devuelta desde el callback de éxito NO llega a `reject`: el
              // código bajo prueba se quedaba colgado para siempre en vez de recibir el error. Lo
              // atrapó el test de "si la marca no entra", con un timeout.
              return Promise.all(marcas).then(
                () => (onOk ? onOk(res) : res),
                (e) => { if (onErr) return onErr(e); throw e; },
              );
            }
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

function envolverQueryBuilder(qb, tabla, desdeCrudo) {
  return new Proxy(qb, {
    get(target, prop) {
      const val = Reflect.get(target, prop, target);
      if (typeof val !== 'function') return val;
      return (...args) => envolverBuilder(val.apply(target, args), tabla, desdeCrudo);
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
  // Y que reconozca un upsert: si una versión de postgrest-js deja de marcarlo en `Prefer` o en la
  // URL, `esUpsert` diría false y el upsert volvería a validarse como un INSERT.
  const up = Reflect.get(sonda, 'upsert').call(sonda, { id: 'sonda' });
  if (!esUpsert(up)) {
    throw new QaGuardError(
      'qa-guard: no puedo reconocer un upsert en el builder de postgrest-js (Prefer/on_conflict ' +
      'cambiaron). La barrera no puede garantizar nada, así que no se corre.',
    );
  }
}

// Un nombre de tabla con `/` sale como otra ruta de PostgREST: `from('rpc/borrar_cuenta_total')`
// llega al RPC por la puerta de las tablas, salteando `validarRpc` (tercera revisión del 12-sep).
function envolverFromYRpc(c) {
  const fromReal = c.from.bind(c);
  const rpcReal = c.rpc.bind(c);
  c.from = (tabla) => {
    if (typeof tabla !== 'string' || tabla.includes('/')) {
      abortar('from(' + JSON.stringify(tabla) + '): un nombre de tabla con "/" es otra ruta de PostgREST (un RPC, por ejemplo).');
    }
    return envolverQueryBuilder(fromReal(tabla), tabla, fromReal);
  };
  c.rpc = (nombre, args, opts) => { validarRpc(nombre, args); return rpcReal(nombre, args, opts); };
  if (typeof c.schema === 'function') {
    const schemaReal = c.schema.bind(c);
    c.schema = (s) => { const otro = schemaReal(s); envolverFromYRpc(otro); return otro; };
  }
}

function envolverCliente(client) {
  if (client.__qaGuard) return client;
  autoverificar(client);
  // En supabase-js, `client.from`, `client.rpc` y `client.schema` delegan en `client.rest` (el
  // PostgrestClient). Se envuelve ESE, que es la puerta de verdad: envolver solo `client` dejaba
  // `client.rest.from('usuarios').update(...)` sin barrera (tercera revisión del 12-sep), y
  // envolver los dos validaría cada operación dos veces. Un cliente sin `rest` (los dobles de los
  // tests) se envuelve directo.
  const puerta = client.rest && typeof client.rest.from === 'function' ? client.rest : client;
  envolverFromYRpc(puerta);
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

/**
 * Declara el BSUID con el que el CÓDIGO BAJO PRUEBA va a dar de alta a alguien (ver el bloque
 * "Altas que hace el código bajo prueba"). Solo acepta BSUID de harness (`PE.qa` + al menos 8
 * caracteres): un BSUID con forma real no se puede declarar, así que la excepción no alcanza a
 * nadie que exista.
 */
export function esperarAltaPorBsuid(bsuid) {
  if (typeof bsuid !== 'string' || !BSUID_DE_HARNESS.test(bsuid)) {
    throw new QaGuardError('esperarAltaPorBsuid: ' + JSON.stringify(bsuid) + ' no es un BSUID de harness ' +
      '(PE.qa + al menos 8 letras o dígitos). Un BSUID con forma real no se declara.');
  }
  if (!altasDeclaradas.has(bsuid)) altasDeclaradas.set(bsuid, { intentos: 0, ids: [], cuerpos: [] });
  return bsuid;
}

/**
 * Lo que la barrera vio de esa alta: INSERT intentados, filas que efectivamente nacieron, y el
 * cuerpo exacto de cada INSERT que terminó bien (sin la marca: así lo mandó el código).
 */
export function altasRegistradas(bsuid) {
  const a = altasDeclaradas.get(bsuid);
  return a ? { intentos: a.intentos, ids: [...a.ids], cuerpos: a.cuerpos.map((c) => ({ ...c })) } : null;
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
