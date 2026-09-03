import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guard de la FORMA de las excepciones de canal, hermano de `notificaciones-duales.test.js`.
 *
 * Aquel exige que un canal único traiga `motivo`. Éste exige que el motivo sea CIERTO, que es
 * otra pregunta y hasta el 20-ago-2026 no la hacía nadie.
 *
 * La regla que las cinco excepciones venían cumpliendo, escrita en el docblock de
 * `notify-user.js` y en el CLAUDE.md: *la query que selecciona al destinatario exige que NO
 * tenga cuenta web, así que no hay campana donde mostrar nada*. Es lo único que hace honesto
 * mandar por un canal que entrega al 10%.
 *
 * **El modo de falla es que la premisa envejezca sin que el canal se entere**, y ya ocurrió:
 * `checkRecordatorioOnboarding` seleccionaba por `onboarding_completado = false`, y cuando el
 * alta reordenada dejó esa columna en `true` el criterio se cambió por "no anotó nada". El
 * canal y su motivo se quedaron como estaban. La población nueva incluye altas web-first, así
 * que entre el 17 y el 18-ago tres usuarios con cuenta web y `whatsapp IS NULL` salieron
 * `skipped_no_whatsapp` y no se enteró nadie. Ni un test se puso rojo: el `motivo` seguía ahí,
 * la sintaxis seguía bien, y la afirmación era falsa.
 *
 * Lo que este archivo puede y lo que no:
 *
 *   · SÍ: que la función que rodea a cada `SOLO_WHATSAPP` **mire** `supabase_auth_id`. Es una
 *     declaración, no una demostración — no puede saber si la mira bien.
 *   · NO: que el filtro sea correcto. Eso es un test de comportamiento, y para el nudge de
 *     primer gasto vive en `tests/cron/nudge-primer-gasto.test.js`.
 *
 * Aun siendo una declaración sirve: para evadirlo hay que escribir a mano la exención de abajo,
 * y eso es exactamente la conversación que no se tuvo cuando cambió la población.
 */

const RAIZ = process.cwd();
/**
 * El barrido es LISTA NEGRA, igual que los `watchPatterns` de `railway.json` y por la misma
 * razón: con lista blanca, un directorio de runtime NUEVO queda invisible **en silencio**.
 *
 * No es hipotético. La versión anterior enumeraba seis directorios; un ataque adversarial creó
 * `jobs/reactivacion.js` con un `SOLO_WHATSAPP` pelado, sin ningún filtro, y el archivo quedó
 * **verde**: como ni se escaneaba, el conteo de sitios tampoco se movía. Con lista negra el
 * default es mirar, y cada exclusión hay que justificarla.
 */
const EXCLUIDOS = new Set([
  'node_modules', '.git', '.next', '.claude',
  'webapp',                                    // TypeScript, con su propia suite
  'tests',                                     // este archivo y sus vecinos
  'qa-e2e',                                    // harness: corre a mano o en CI, nunca en el server
  'migrations', 'docs', 'assets', 'content',   // no ejecutan JS de runtime
  'scripts', 'tasks',                          // one-shot operativos, no le escriben a usuarios
]);

/**
 * Call-sites que declaran `SOLO_WHATSAPP` sin mirar `supabase_auth_id`. Vacía a propósito.
 * Una entrada acá es una decisión de producto que alguien tiene que firmar, no un atajo:
 * significa "le mando por el canal que entrega al 10% a alguien que quizás tiene campana".
 */
const EXENTOS = new Map([]);

/**
 * El conteo fijado: si aparece un canal único nuevo, este archivo lo hace notar.
 *
 * Cuenta **solo `SOLO_WHATSAPP`**, que es el canal que este bloque vigila. Un `SOLO_IN_APP`
 * nuevo no lo mueve, y eso es correcto: el riesgo que se mide acá es mandarle por el canal que
 * entrega al 10% a alguien que quizá tiene campana, no al revés.
 */
const SITIOS_ESPERADOS = 4;

function archivosJs(dir) {
  const out = [];
  let entradas;
  try { entradas = readdirSync(join(RAIZ, dir || '.'), { withFileTypes: true }); } catch { return out; }
  for (const e of entradas) {
    if (EXCLUIDOS.has(e.name)) continue;
    const rel = dir ? join(dir, e.name) : e.name;
    if (e.isDirectory()) out.push(...archivosJs(rel));
    else if (e.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

const FUENTES = archivosJs('')
  .map((rel) => ({ rel: rel.replace(/\\/g, '/'), src: readFileSync(join(RAIZ, rel), 'utf8') }));

/**
 * Parte un archivo en funciones de nivel superior. No es un parser: alcanza porque en este repo
 * las funciones de runtime se declaran en la columna 0. Si alguna vez dejan de estarlo, el
 * chequeo de antivacuidad de abajo (cada cuerpo tiene que ser corto y contener el call-site)
 * es lo que lo delata en vez de dejarlo pasar.
 */
function funciones(src) {
  // TODAS las formas de declarar algo invocable en la columna 0. Las dos últimas salieron de
  // ataques sucesivos, y las dos tenían el mismo efecto: un call-site nuevo se pegaba al cuerpo
  // de la función ANTERIOR, heredaba su `supabase_auth_id` y ni siquiera movía el conteo de
  // sitios. Primero fue `const nudge = async (u) => {...}`; cerrado eso, la vuelta siguiente usó
  // `exports.nudge = async (u) => {...}`, que es la misma clase con otro sintagma.
  //
  // Lo que queda fuera a propósito: métodos de clase y funciones anidadas. Acá el runtime son
  // módulos CommonJS con funciones de nivel superior, y una anidada vive DENTRO del cuerpo de su
  // padre, o sea que su call-site ya se le atribuye a alguien que el guard sí mira.
  const marcas = [...src.matchAll(
    /^(?:(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(|(?:const|let|var|(?:module\.)?exports\.|this\.)\s*([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:function\b|\(|[A-Za-z0-9_$]+\s*=>))/gm,
  )];
  return marcas.map((m, i) => ({
    nombre: m[1] || m[2],
    cuerpo: src.slice(m.index, i + 1 < marcas.length ? marcas[i + 1].index : src.length),
  }));
}

/**
 * Borra comentarios ANTES de buscar el filtro, y no es paranoia: la primera versión de este
 * archivo no lo hacía y **pasó en verde con la guarda borrada**, porque `maybeWebappInvite`
 * tiene arriba un comentario que dice *"Si tiene supabase_auth_id, ya se logueo en webapp
 * alguna vez"*. O sea que el guard se estaba midiendo contra la documentación del código en
 * vez de contra el código — la misma clase que ya está dos veces en `docs/DEFECTOS.md`
 * (17 y 18-ago-2026), y que en las dos ocasiones se resolvió igual.
 *
 * No maneja `//` dentro de un string ni de una regex. Del lado seguro: borrar de más solo puede
 * poner el guard ROJO por no encontrar el filtro, nunca verde.
 */
function sinComentarios(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Borra el VALOR de `motivo:`, y esta es la segunda evasión que encontró la prueba por mutación
 * — la misma clase que la de los comentarios, un escalón más adentro.
 *
 * Con la guarda de `maybeWebappInvite` borrada, el guard seguía verde porque su propio motivo
 * dice *"el trigger exige supabase_auth_id NULL (arriba)"*. O sea: el guard existe para
 * verificar que esa frase sea cierta, y la frase se estaba verificando a sí misma. Es la
 * tercera aparición de `guard-que-se-mide-contra-su-documentacion` en este repo.
 *
 * NO se borran todos los literales, a propósito: `supabase_auth_id` aparece legítimamente
 * dentro de strings como nombre de COLUMNA (`.is('supabase_auth_id', null)`, y el `.select()`),
 * y eso sí es código que filtra. Lo que no puede contar es la prosa.
 */
function sinMotivos(src) {
  return src.replace(/motivo\s*:\s*(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)/g, 'motivo: MOTIVO');
}

/**
 * **La pregunta no es "¿aparece la cadena?" sino "¿aparece FILTRANDO?"**, y ese cambio es lo que
 * cierra la clase entera en vez de tapar evasiones de a una.
 *
 * La version anterior buscaba la cadena en el texto y despues iba borrando los lugares donde no
 * valia: comentarios, el valor de `motivo:`, el argumento de `.select(...)`. Cada parche cerraba
 * UNA evasion y la revision adversarial encontraba la siguiente — la cuarta fue mover la lista de
 * columnas a una constante (`.select(COLS_NUDGE)`), que ningun scrubber de literales puede ver, y
 * es un refactor mundano que nadie asocia con un guard. Tambien pasaban: la prosa en un
 * `log.info`, la clave suelta en `datos: { supabase_auth_id }` y una variable
 * `supabase_auth_id_pendiente`.
 *
 * Con lista blanca esas seis mueren juntas, porque ninguna es una de estas dos formas:
 *
 *   · **filtro de PostgREST** — la columna es el sujeto de un `.is/.eq/.neq/.not/.or/...`.
 *     Un `.select()` NO entra: es una PROYECCION. Traer la columna no dice nada sobre a quien
 *     se eligio, y esa distincion es la misma que el guard del MRR termino necesitando.
 *   · **acceso a propiedad** — `u.supabase_auth_id`, o sea una rama de JS mirandola.
 *
 * Sigue siendo una DECLARACION y no una demostracion: no sabe si el filtro esta bien puesto.
 * Eso lo prueba el test de comportamiento (`tests/cron/nudge-primer-gasto.test.js`).
 */
const FILTRO_POSTGREST = /\.(?:is|eq|neq|not|or|filter|match|gt|gte|lt|lte)\(\s*['"`][^'"`]*\bsupabase_auth_id\b/;
/**
 * El acceso tiene que estar DECIDIENDO algo, no solo leyéndose.
 *
 * La versión anterior aceptaba cualquier `.supabase_auth_id`, y un ataque la pasó con
 * `log.info({ web: u.supabase_auth_id }, ...)` seguido de un `SOLO_WHATSAPP` incondicional: la
 * función "mira" la columna y no cambia nada. Lo único que se ponía rojo era el conteo de
 * sitios, que es justo lo que sube quien agrega un call-site nuevo — o sea que la evasión venía
 * con su propio arreglo aparente.
 *
 * Se exige un token de decisión en la MISMA línea. Cubre las formas que este repo usa
 * (`if (u.supabase_auth_id)`, `if (!u.supabase_auth_id) return`, el ternario, `&&`/`||`) y deja
 * fuera la lectura decorativa. Un `if` multilínea con el acceso en otro renglón quedaría fuera:
 * es del lado seguro (rojo de más, nunca verde de más) y se resuelve escribiéndolo en una línea.
 */
const ACCESO_EN_DECISION = new RegExp(
  String.raw`^.*(?:\bif\s*\(|\breturn\b|\bcontinue\b|\?|&&|\|\|).*\.supabase_auth_id\b`
  + String.raw`|^.*\.supabase_auth_id\b.*(?:\?|&&|\|\|)`,
  'm',
);

function filtraPorCuentaWeb(cuerpo) {
  return FILTRO_POSTGREST.test(cuerpo) || ACCESO_EN_DECISION.test(cuerpo);
}

const SITIOS = [];
for (const { rel, src } of FUENTES) {
  if (rel === 'lib/notify-user.js') continue; // la definición: nombra las constantes, no las usa
  const limpio = sinMotivos(sinComentarios(src));
  for (const fn of funciones(limpio)) {
    if (!/CANALES\.SOLO_WHATSAPP/.test(fn.cuerpo)) continue;
    SITIOS.push({ rel, nombre: fn.nombre, cuerpo: fn.cuerpo, largoArchivo: limpio.length });
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════
// El AGUJERO DE AL LADO: declarar AMBOS y cortar antes por falta de número
// ═════════════════════════════════════════════════════════════════════════════════════════
//
// Todo lo de arriba mira los `CANALES.SOLO_*`, y por eso durante meses **no vio** el modo de
// falla más común de los dos. Cuatro crons de `cron/checks.js` declaraban `CANALES.AMBOS` como
// corresponde y una línea más arriba tenían un `if (!usuario.whatsapp) continue;`. El guard
// pasaba verde con toda razón: el canal declarado era el correcto. Lo que estaba mal era que
// el destinatario nunca llegaba a la declaración.
//
// **El corte no protege nada**, y ese es el punto entero: `notificarUsuario` con AMBOS ya
// maneja `whatsapp: null` — llama igual a `enviarWhatsapp`, que hace no-op y deja
// `skipped_no_whatsapp` en el ledger, y escribe la campana. Lo único que el corte agrega es
// apagar la mitad in-app para quien no tiene número. Al 27-ago-2026 eso eran **14 usuarios
// reales, los 14 con cuenta web y los 14 con los recordatorios prendidos**, y uno de los
// cuatro crons era Manos Libres, que es opt-in explícito: el silencio contradecía algo que la
// persona había pedido.
//
// Es la misma lección que el guard de arriba con otra cara: *un canal declarado no dice nada
// sobre a quién se le declaró*. Y el corte es invisible en producción — el cron corre, no
// falla, y `continue` no deja rastro en ninguna tabla.
//
// ─── La SÉPTIMA evasión, y la primera que no salió de una mutación sino de producción ────
//
// Hasta el 01-sep-2026 la aserción de abajo corría sobre `CON_AMBOS`: las funciones cuyo
// cuerpo contiene `canales: CANALES.AMBOS`. Ésa era **la población equivocada**, y el quinto
// sitio de la clase lo demostró: en `services/survey-triggers.js` el `if (!u.whatsapp)
// continue;` vivía en `checkSurveyTriggers` (el bucle) y los `CANALES.AMBOS` en las cuatro
// funciones que ese bucle llama. El cuerpo del bucle no contiene la cadena `CANALES.AMBOS`,
// así que **nunca entraba a `CON_AMBOS`** y su corte no se examinaba jamás. El corte se movió
// un nivel arriba, al llamador, y con eso salió del alcance del guard sin poner nada rojo.
//
// Y la antivacuidad no avisaba: `CON_AMBOS.length >= 15` y "la lista contiene cron/checks.js"
// seguían siendo ciertas con el agujero abierto. Es la forma exacta de
// `feedback_guards_que_no_ven`: el instrumento sano contestando otra pregunta.
//
// **Lo que se hizo, y por qué NO es un grafo de llamadas.** Medido el 01-sep-2026 sobre los 95
// `.js` de runtime del backend: **26 funciones declaran AMBOS y sólo DOS contienen un corte por
// falta de número**, y ninguna de las dos declara AMBOS. O sea que la intersección que la
// versión anterior examinaba estaba vacía. Con una población de dos, seguir la cadena
// llamador→llamado (y encima cruzando archivos) es maquinaria que puede fallar sola, y su
// próxima evasión es obvia: subir el corte un nivel más, o mudarlo de archivo.
//
// La regla que queda es la simple: **ningún archivo de runtime puede cortar por falta de
// número sin declararlo**, mire a donde mire ese corte. Falla del lado seguro —un rojo que
// pide una firma, nunca un verde silencioso— y su lista de exenciones queda siendo el
// inventario de los caminos que de verdad son sólo-WhatsApp, que es justo la conversación que
// no se tuvo en ninguno de los cinco sitios de esta clase.
//
// **Los límites CONOCIDOS, medidos con un ataque el 01-sep-2026 y escritos para que nadie los
// re-descubra creyendo que el guard cubre más de lo que cubre.** Detecta la forma negativa
// (`if (!x.whatsapp)`) con `continue`/`return`/`break`, con o sin llaves, con statements en el
// medio, y con la comparación explícita contra `null`/`undefined`. **NO** detecta:
//
//   · la forma POSITIVA (`if (u.whatsapp) { await avisar(u); }`), que es el mismo silencio al
//     revés. No se cubre a propósito: `if (u.whatsapp)` es también la forma legítima de todo el
//     código que sí depende del número, y marcarla haría del guard puro ruido;
//   · el número destructurado (`const { whatsapp } = u; if (!whatsapp) continue;`). Cubrirlo
//     pide soltar el punto, y ahí caen los `if (!whatsapp) return res.status(400)` de
//     `routes/admin.js`, que son validación de un body y no un corte de canal;
//   · el filtro sobre la población (`usuarios.filter((x) => x.whatsapp)`) y el filtro en la
//     query (`.not('whatsapp', 'is', null)`), que son otra forma sintáctica entera.
//
// Para `services/survey-triggers.js` —el archivo donde vivió el quinto corte— las cuatro están
// cubiertas por COMPORTAMIENTO, en `tests/services/survey-triggers-web-first.test.js`, que
// afirma que el usuario sin número recibe. Ése es el respaldo real; esto es la red de forma.
// El cuerpo opcional entre la condición y el corte admite hasta tres pares de llaves
// balanceadas (`log.debug({ tag: 'X' }, 'sin numero'); continue;`) y no más: con un comodín
// suelto, un `if (!u.whatsapp)` seguido de cualquier `return` lejano daría falso positivo, que
// es el error que empuja al siguiente a aflojar el regex y abrir el hueco de verdad.
const CUERPO_ANTES_DEL_CORTE = String.raw`(?:\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*){0,3})?\s*(?:continue|return|break)\b`;
const CORTE_POR_WHATSAPP = new RegExp(
  // negación: `if (!u.whatsapp)`, con cualquier profundidad de propiedad y optional chaining
  String.raw`\bif\s*\([^)]*!\s*[\w$]+(?:\s*\??\.\s*[\w$]+)*\s*\??\.\s*whatsapp\b[^)]*\)` + CUERPO_ANTES_DEL_CORTE
  // comparación explícita: `if (u.whatsapp === null)`. Solo `==`/`===`: `!==` es la forma
  // POSITIVA (cortar a quien SÍ tiene número), que es otra cosa y no la marca este guard.
  + String.raw`|\bif\s*\([^)]*[\w$]+(?:\s*\??\.\s*[\w$]+)*\s*\??\.\s*whatsapp\s*===?\s*(?:null|undefined)[^)]*\)` + CUERPO_ANTES_DEL_CORTE,
);

/**
 * Los cortes por falta de número que están bien, con su motivo. Una entrada acá es una
 * decisión que alguien firma, no un `continue` que quedó de antes: el default correcto es
 * sacar el corte, porque `notificarUsuario` ya sabe qué hacer sin número.
 *
 * Sirve además de inventario: son los únicos caminos del backend que de verdad terminan sólo
 * en WhatsApp.
 */
const CORTES_EXENTOS = new Map([
  ['services/registro-silencioso.js:intentarConfirmar',
    'no pasa por `notificarUsuario`: le habla a `enviarWhatsapp` directo, para medir si el ' +
    'número guardado sigue sirviendo cuando Meta dejó de mandar el del remitente (D10). El ' +
    'chokepoint devuelve el resultado crudo pero no lo interpreta, y acá el `code` de un ' +
    'rechazo síncrono ES el veredicto. Sin número no hay nada que INTENTAR — la parte in-app ' +
    'sí existe y vive al lado, en `dejarRastroEnLaCampana` (SOLO_IN_APP), que corre para el ' +
    'mismo usuario por `confirmarComoSePueda`. Hasta el 03-sep-2026 esta entrada decía que ' +
    'tampoco había "nada in-app que escribir", y era falso: describía el silencio total que ' +
    'ese día se cerró.'],
  ['services/survey-triggers.js:maybeReminderD14',
    'el mensaje ES una pregunta abierta ("¿hay algo que te complica? cuéntame en una sola ' +
    'línea") y su único valor es la respuesta. La campana no tiene caja de respuesta y el ' +
    'hilo de soporte vive en WhatsApp por decisión escrita. Corta ANTES de registrar, así ' +
    'que no quema nada: el día que agregue un número lo recibe.'],
  ['services/survey-triggers.js:maybeFeedback30',
    'misma razón que `maybeReminderD14` ("si pudieras cambiar UNA sola cosa, ¿qué sería?"), y ' +
    'además es one-shot con unique index: registrarlo sin poder entregarlo le quemaría para ' +
    'siempre la única vez que se manda.'],
  ['services/survey-triggers.js:maybeWakeUpOnboarding',
    'el alta que este mensaje pide terminar es la de WhatsApp: la máquina de estados vive en ' +
    '`handlers/onboarding.js` y se avanza escribiéndole al bot, así que sin número no hay ' +
    'forma de completarla y las tres variantes del copy piden algo imposible. Ojo: NO se ' +
    'sostiene en que "toda cuenta web nace con el onboarding cerrado" — eso es una propiedad ' +
    'del nacimiento, y `/api/whatsapp/unlink` borra el número desde Configuración sin tocar ' +
    'esa columna.'],
]);

const CON_AMBOS = [];
for (const { rel, src } of FUENTES) {
  if (rel === 'lib/notify-user.js') continue;   // la definición
  const limpio = sinMotivos(sinComentarios(src));
  for (const fn of funciones(limpio)) {
    if (!/canales\s*:\s*CANALES\.AMBOS/.test(fn.cuerpo)) continue;
    CON_AMBOS.push({ rel, nombre: fn.nombre, cuerpo: fn.cuerpo });
  }
}

/**
 * TODO corte por falta de número del runtime, mire a donde mire. Ésta es la población que la
 * versión anterior no tenía: aquélla preguntaba por las funciones que DECLARAN el canal, y el
 * corte no vive necesariamente ahí.
 */
const CORTES_HALLADOS = [];
/**
 * Sitios que el ARCHIVO tiene y el troceo por función NO ve. Es la red debajo de la red, y sin
 * ella el guard entero es evadible con un refactor mundano.
 *
 * `funciones()` solo ancla en la columna 0 con `function` o `const|let|var|exports.|this.` =.
 * Un archivo cuyos invocables sean **métodos de una clase** o de un **objeto literal**
 * (`const jobs = { async correr() {…} }`) produce CERO funciones, así que ni `SITIOS`, ni
 * `CON_AMBOS`, ni `CORTES_HALLADOS` se mueven: el archivo entero queda invisible para los dos
 * bloques de este test a la vez. Verificado el 01-sep-2026 metiendo un `services/` nuevo con
 * una clase, un `if (!u.whatsapp) continue` y un `SOLO_WHATSAPP` sin filtro: **la suite entera
 * quedó en verde, 163 de 163**.
 *
 * Es la misma lección que la lista negra de directorios, un nivel más adentro: el default tiene
 * que ser MIRAR. Por eso lo que se compara es el archivo contra la suma de sus funciones — no
 * hace falta que el troceo entienda la forma nueva, solo que se dé cuenta de que se le escapó.
 *
 * El docblock de `funciones()` decía que los métodos quedaban fuera "a propósito" porque una
 * anidada se le atribuye a su padre. Vale para las anidadas; un método de clase no tiene padre
 * en columna 0, así que no se le atribuye a nadie.
 */
const NO_ATRIBUIDOS = [];
for (const { rel, src } of FUENTES) {
  if (rel === 'lib/notify-user.js') continue;   // la definición
  const limpio = sinMotivos(sinComentarios(src));
  const fns = funciones(limpio);
  for (const fn of fns) {
    if (!CORTE_POR_WHATSAPP.test(fn.cuerpo)) continue;
    CORTES_HALLADOS.push({
      rel, nombre: fn.nombre, cuerpo: fn.cuerpo,
      declaraAmbos: /canales\s*:\s*CANALES\.AMBOS/.test(fn.cuerpo),
    });
  }
  // Lo que el archivo tiene y ninguna función recogió. `cuenta` sobre el texto completo contra
  // la suma de los cuerpos: si el troceo se perdió una región, la diferencia lo delata.
  const cuenta = (texto, re) => (texto.match(new RegExp(re.source, 'g')) || []).length;
  const enElArchivo = { corte: cuenta(limpio, CORTE_POR_WHATSAPP), solo: cuenta(limpio, /CANALES\.SOLO_WHATSAPP/) };
  const enFunciones = fns.reduce((acc, fn) => ({
    corte: acc.corte + cuenta(fn.cuerpo, CORTE_POR_WHATSAPP),
    solo: acc.solo + cuenta(fn.cuerpo, /CANALES\.SOLO_WHATSAPP/),
  }), { corte: 0, solo: 0 });
  if (enElArchivo.corte > enFunciones.corte || enElArchivo.solo > enFunciones.solo) {
    NO_ATRIBUIDOS.push({ rel, ...enElArchivo, vistos: enFunciones });
  }
}

describe('un canal SOLO_WHATSAPP mira si el destinatario tiene cuenta web', () => {
  it('el barrido encuentra los call-sites (antivacuidad)', () => {
    // Sin esto, romper el regex o el troceo dejaría el archivo verde sin haber mirado nada.
    expect(SITIOS.length).toBe(SITIOS_ESPERADOS);
    // Y cada cuerpo tiene que ser UNA función, no el archivo entero colapsado: si el troceo
    // fallara, un `supabase_auth_id` de cualquier otra función haría pasar a todas.
    //
    // El umbral es RELATIVO al archivo, no un número de bytes: el absoluto (6000) ya se puso
    // rojo con `checkRecordatorioOnboarding` a 7713 por sus comentarios, o sea que castigaba
    // documentar. Lo que hay que distinguir es "una función" de "el archivo entero", y un
    // tercio separa esas dos cosas con aire de sobra (hoy el peor caso está en 12%).
    for (const s of SITIOS) {
      expect(
        s.cuerpo.length / s.largoArchivo,
        `${s.rel}:${s.nombre} ocupa casi todo el archivo: el troceo por función no funcionó`,
      ).toBeLessThan(0.34);
    }
  });

  /**
   * El guard atacado con las SEIS formas que lo evadieron. Ninguna es hipótesis: las tres
   * primeras salieron de mutar call-sites reales y ver el archivo verde con la guarda borrada;
   * las otras tres, de una revisión adversarial dedicada a romperlo.
   *
   * Un guard verde por evasión es indistinguible de un guard verde por corrección, así que estas
   * entradas son lo único que separa las dos cosas. La cuarta es la que enseñó más: mover la
   * lista de columnas a una constante (`.select(COLS_NUDGE)`) es un refactor mundano que nadie
   * asocia con un guard, y ningún scrubber de literales puede verlo. Fue lo que hizo cambiar el
   * enfoque de "borrar donde no vale" a "exigir una forma que filtre".
   */
  const EVASIONES = [
    ['en un comentario', `async function f(u) {\n  // Si tiene supabase_auth_id, no reinvitar.\n  await notificarUsuario({ canales: CANALES.SOLO_WHATSAPP, motivo: 'x' });\n}\n`],
    ['en el propio motivo', `async function f(u) {\n  await notificarUsuario({ canales: CANALES.SOLO_WHATSAPP, motivo: 'el trigger exige supabase_auth_id NULL' });\n}\n`],
    ['en un comentario de bloque', `async function f(u) {\n  /* exige supabase_auth_id nulo */\n  await notificarUsuario({ canales: CANALES.SOLO_WHATSAPP, motivo: 'x' });\n}\n`],
    ['en un .select() (proyección, no filtro)', `async function f(u) {\n  const { data } = await supabase.from('usuarios').select('id, whatsapp, supabase_auth_id');\n  await notificarUsuario({ canales: CANALES.SOLO_WHATSAPP, motivo: 'x' });\n}\n`],
    ['en un .select() indirectado por una constante', `async function f(u) {\n  const { data } = await supabase.from('usuarios').select(COLS_NUDGE);\n  await notificarUsuario({ canales: CANALES.SOLO_WHATSAPP, motivo: 'x' });\n}\n`],
    ['en la prosa de un log', `async function f(u) {\n  log.info({ tag: 'X' }, 'destinatario sin supabase_auth_id');\n  await notificarUsuario({ canales: CANALES.SOLO_WHATSAPP, motivo: 'x' });\n}\n`],
    ['como clave suelta de un objeto', `async function f(u) {\n  await notificarUsuario({ canales: CANALES.SOLO_WHATSAPP, motivo: 'x', datos: { supabase_auth_id: null } });\n}\n`],
    ['dentro de otro identificador', `async function f(u) {\n  const supabase_auth_id_pendiente = true;\n  if (supabase_auth_id_pendiente) return;\n  await notificarUsuario({ canales: CANALES.SOLO_WHATSAPP, motivo: 'x' });\n}\n`],
    // La novena, y la más fina de todas: la función SÍ lee la columna, pero la lectura no
    // decide nada. Pasaba la aserción por-sitio y solo movía el conteo, que es exactamente lo
    // que sube quien agrega un call-site legítimo.
    ['leyéndola sin decidir nada', `async function f(u) {\n  log.info({ web: u.supabase_auth_id }, 'nudge');\n  await notificarUsuario({ canales: CANALES.SOLO_WHATSAPP, motivo: 'x' });\n}\n`],
  ];

  it.each(EVASIONES)('un call-site que solo nombra supabase_auth_id %s NO cuenta', (_como, fuente) => {
    const limpio = sinMotivos(sinComentarios(fuente));
    const fn = funciones(limpio)[0];
    expect(fn, 'el troceo no encontró la función del fixture').toBeTruthy();
    expect(/CANALES\.SOLO_WHATSAPP/.test(fn.cuerpo), 'el fixture perdió su call-site').toBe(true);
    expect(filtraPorCuentaWeb(fn.cuerpo)).toBe(false);
  });

  // Los dos controles POSITIVOS. Sin ellos, un `filtraPorCuentaWeb` que devolviera siempre false
  // pasaría los ocho negativos de arriba y el archivo entero sería verde por vacuidad.
  it.each([
    ['acceso a propiedad', `async function f(u) {\n  if (u.supabase_auth_id) return false;\n  await notificarUsuario({ canales: CANALES.SOLO_WHATSAPP, motivo: 'x' });\n}\n`],
    ['filtro de PostgREST', `async function f(u) {\n  const { data } = await supabase.from('usuarios').select('id').is('supabase_auth_id', null);\n  await notificarUsuario({ canales: CANALES.SOLO_WHATSAPP, motivo: 'x' });\n}\n`],
  ])('un call-site que SÍ lo filtra (%s) cuenta', (_forma, fuente) => {
    const fn = funciones(sinMotivos(sinComentarios(fuente)))[0];
    expect(filtraPorCuentaWeb(fn.cuerpo)).toBe(true);
  });

  it.each([
    ['const', 'const nuevo = async (u) => {'],
    ['exports.', 'exports.nuevo = async (u) => {'],
    ['module.exports.', 'module.exports.nuevo = async (u) => {'],
    ['exports. con function', 'exports.nuevo = async function (u) {'],
  ])('el troceo ve un call-site declarado con %s como su propia función', (_forma, decl) => {
    // La evasión estructural, en sus cuatro sintagmas. Un call-site escrito así entre dos
    // `function` se pegaba al cuerpo de la ANTERIOR, heredaba su filtro, y ni movía el conteo.
    const fuente = `async function anterior(u) {\n  if (u.supabase_auth_id) return false;\n}\n\n${decl}\n  await notificarUsuario({ canales: CANALES.SOLO_WHATSAPP, motivo: 'x' });\n};\n`;
    const conCallSite = funciones(sinMotivos(sinComentarios(fuente)))
      .filter((f) => /CANALES\.SOLO_WHATSAPP/.test(f.cuerpo));
    expect(conCallSite.map((f) => f.nombre)).toEqual(['nuevo']);
    expect(filtraPorCuentaWeb(conCallSite[0].cuerpo)).toBe(false);
  });

  it('el troceo ve una arrow function de módulo como su propia función', () => {
    // La evasión estructural: un call-site nuevo escrito como `const x = async (u) => {...}`
    // entre dos `function` se pegaba al cuerpo de la ANTERIOR, heredaba su filtro, y ni siquiera
    // movía el conteo de sitios.
    const fuente = `async function anterior(u) {\n  if (u.supabase_auth_id) return false;\n}\n\nconst nuevo = async (u) => {\n  await notificarUsuario({ canales: CANALES.SOLO_WHATSAPP, motivo: 'x' });\n};\n`;
    const conCallSite = funciones(sinMotivos(sinComentarios(fuente)))
      .filter((f) => /CANALES\.SOLO_WHATSAPP/.test(f.cuerpo));
    expect(conCallSite.map((f) => f.nombre)).toEqual(['nuevo']);
    expect(filtraPorCuentaWeb(conCallSite[0].cuerpo)).toBe(false);
  });

  it.each(SITIOS.map((s) => [`${s.rel}:${s.nombre}`, s]))('%s', (_id, sitio) => {
    if (EXENTOS.has(`${sitio.rel}:${sitio.nombre}`)) return;
    expect(
      filtraPorCuentaWeb(sitio.cuerpo),
      `${sitio.rel} → ${sitio.nombre}() manda por SOLO_WHATSAPP sin mirar supabase_auth_id. ` +
      'Su `motivo` afirma que el destinatario no tiene cuenta web; nada lo verifica. ' +
      'O agregá el filtro, o pasá a AMBOS, o declaralo en EXENTOS con el porqué.',
    ).toBe(true);
  });
});

describe('declarar AMBOS y cortar por falta de número es lo mismo que no declararlo', () => {
  it('el barrido encuentra los call-sites de AMBOS (antivacuidad)', () => {
    // Sin esto, un regex roto dejaría la lista vacía y las aserciones de abajo pasarían sin
    // haber mirado nada. El piso es holgado a propósito: lo que se afirma es "el barrido ve
    // el backend", no un conteo que envejece con cada aviso nuevo.
    expect(CON_AMBOS.length).toBeGreaterThanOrEqual(15);
    // Y que vea el archivo donde vivían los cuatro cortes.
    expect(CON_AMBOS.map((s) => s.rel)).toContain('cron/checks.js');
  });

  /**
   * Contraprueba del detector. Sin esto, un `CORTE_POR_WHATSAPP` que no matcheara nunca
   * dejaría el archivo verde para siempre — que es exactamente el estado en el que este
   * agujero vivió hasta el 27-ago-2026, con la diferencia de que entonces ni existía la regla.
   *
   * Las cuatro formas son las que estaban EN EL REPO, no inventadas: tres `if (!u.whatsapp)
   * continue;` y el `||` compuesto del bucle de espacios.
   */
  const CORTES = [
    ['el corte pelado', 'if (!usuario.whatsapp) continue;'],
    ['con return', 'if (!usuario.whatsapp) return;'],
    ['con llave', 'if (!usuario.whatsapp) {\n  continue;\n}'],
    ['encadenado con ||', 'if (!m.usuarios?.whatsapp || m.usuarios?.recordatorios_activos === false) continue;'],
    ['con optional chaining simple', 'if (!u?.whatsapp) continue;'],
    ['anidado más profundo', 'if (!deuda.usuarios.whatsapp) continue;'],
    // Las cuatro de abajo salieron del ataque del 01-sep-2026 al guard nuevo: las cuatro
    // reintroducen el ítem 23 y las cuatro lo dejaban VERDE. Ninguna es rebuscada — la primera
    // es lo que escribe cualquiera que quiera dejar rastro en el log del corte que agrega.
    ['con un statement antes del corte', "if (!u.whatsapp) {\n  log.debug({ tag: 'X', userId: u.id }, 'sin numero');\n  continue;\n}"],
    ['con break en vez de continue', 'if (!u.whatsapp) break;'],
    ['comparando contra null', 'if (u.whatsapp === null) continue;'],
    ['comparando con == laxo (null y undefined a la vez)', 'if (u.whatsapp == null) continue;'],
  ];
  it.each(CORTES)('el detector reconoce %s', (_como, linea) => {
    expect(CORTE_POR_WHATSAPP.test(linea)).toBe(true);
  });

  /**
   * Y los negativos, que son los que impiden que el detector sea un `return true` disfrazado.
   *
   * El tercero es el que más importa: **pasar `whatsapp` al chokepoint no es cortar**. Si el
   * detector lo marcara, el arreglo correcto (sacar el corte y seguir pasando el número) se
   * vería rojo y la única salida sería dejar de pasar el número — o sea que el guard estaría
   * empujando hacia el bug contrario.
   */
  it.each([
    ['una condición sobre otra columna', 'if (!usuario.email) continue;'],
    ['el corte de recordatorios', 'if (usuario.recordatorios_activos === false) continue;'],
    ['pasar el número al chokepoint', 'usuarioId: u.id, whatsapp: u.whatsapp,'],
    ['leer el número sin cortar', 'const dest = usuario.whatsapp || null;'],
    ['un if sobre whatsapp que NO corta', 'if (!usuario.whatsapp) log.info({ web: true });'],
    // La forma POSITIVA, que es el límite declarado del detector: cortar a quien SÍ tiene
    // número es otra decisión (el camino solo-WhatsApp) y marcarla haría del guard ruido.
    ['cortar al que SÍ tiene número', 'if (usuario.whatsapp !== null) continue;'],
    // Y el falso positivo que la ampliación del 01-sep pudo abrir: un `if (!x.whatsapp)` que
    // hace su trabajo y sigue, con un `return` de OTRA rama más abajo. Sin el tope de llaves
    // balanceadas del cuerpo, el comodín se los comía a los dos.
    ['un bloque que maneja el caso y sigue, con un return lejano de otra rama',
      "if (!u.whatsapp) {\n  faltantes.push(u.id);\n  log.info({ tag: 'X' }, 'sin numero');\n  metricas.sinNumero += 1;\n  avisos.push({ id: u.id, canal: 'in_app' });\n  pendientes.set(u.id, { intentos: 0, ultimo: null });\n}\nif (otraCosa) return;"],
  ])('el detector NO marca %s', (_como, linea) => {
    expect(CORTE_POR_WHATSAPP.test(linea)).toBe(false);
  });

  /**
   * La contraprueba de la SÉPTIMA evasión, y es la que separa esta versión de la anterior.
   *
   * El fixture es la forma exacta que vivió en producción: el corte en el LLAMADOR, la
   * declaración en el LLAMADO. Se afirman las dos mitades — que la población vieja no lo veía,
   * y que la nueva sí — porque sólo la segunda sin la primera dejaría creer que el guard viejo
   * ya alcanzaba.
   */
  it('un corte en el LLAMADOR, con el AMBOS en el llamado, sí se ve', () => {
    const fuente = 'async function envia(u) {\n'
      + "  await notificarUsuario({ canales: CANALES.AMBOS, usuarioId: u.id, whatsapp: u.whatsapp || null });\n"
      + '}\n\n'
      + 'async function bucle(usuarios) {\n'
      + '  for (const u of usuarios) {\n'
      + '    if (!u.whatsapp) continue;\n'
      + '    await envia(u);\n'
      + '  }\n'
      + '}\n';
    const fns = funciones(sinMotivos(sinComentarios(fuente)));
    const conAmbos = fns.filter((f) => /canales\s*:\s*CANALES\.AMBOS/.test(f.cuerpo));
    const conCorte = fns.filter((f) => CORTE_POR_WHATSAPP.test(f.cuerpo));

    // La mitad que documenta el agujero: la población vieja son las que declaran AMBOS, y
    // ninguna de ellas tiene el corte. Preguntarles a ellas devuelve verde.
    expect(conAmbos.map((f) => f.nombre)).toEqual(['envia']);
    expect(conAmbos.every((f) => !CORTE_POR_WHATSAPP.test(f.cuerpo))).toBe(true);

    // La mitad que lo cierra: barriendo TODAS las funciones, el corte aparece igual.
    expect(conCorte.map((f) => f.nombre)).toEqual(['bucle']);
  });

  it('ningún archivo esconde un corte o un canal único fuera del troceo por función', () => {
    // La evasión E-A: `class Reactivador { async correr() { if (!u.whatsapp) continue; … } }`
    // en un archivo nuevo dejaba la suite ENTERA en verde, porque el troceo no emite ninguna
    // función y los tres barridos de este archivo se quedan vacíos sin que nada lo note.
    expect(
      NO_ATRIBUIDOS,
      'un archivo tiene un corte por falta de número (o un CANALES.SOLO_WHATSAPP) que el ' +
      'troceo por función no le atribuye a nadie: casi seguro son métodos de una clase o de un ' +
      'objeto literal, que `funciones()` no ve. Declaralo en columna 0, o enseñale la forma ' +
      'nueva al troceo. Lo que NO vale es dejarlo: ahí adentro el guard no mira nada.',
    ).toEqual([]);
  });

  it('el barrido de cortes no está vacío (antivacuidad)', () => {
    // Sin esto, un `CORTE_POR_WHATSAPP` que dejara de matchear —o un troceo roto— vaciaría la
    // lista y las aserciones de abajo pasarían sin haber mirado nada. Peor: se vería sano,
    // porque "cero cortes" es exactamente el estado que este archivo persigue.
    //
    // El ancla es un sitio EXENTO a propósito: sobrevive al arreglo, así que no hay que
    // acordarse de mudarla cuando se cierre el próximo corte. El piso es 1 y no el conteo de
    // hoy: un número acá se ataría a las exenciones vigentes, y el día que una se levante
    // —que es el desenlace BUENO— este archivo se pondría rojo por el motivo equivocado.
    expect(CORTES_HALLADOS.length).toBeGreaterThanOrEqual(1);
    expect(CORTES_HALLADOS.map((s) => `${s.rel}:${s.nombre}`))
      .toContain('services/registro-silencioso.js:intentarConfirmar');
  });

  it('toda exención declarada corresponde a un corte que existe', () => {
    // El trinquete al revés: una exención que ya no apunta a nada es un permiso abierto
    // esperando a que alguien reintroduzca el corte y lo encuentre pre-firmado.
    const hallados = new Set(CORTES_HALLADOS.map((s) => `${s.rel}:${s.nombre}`));
    for (const id of CORTES_EXENTOS.keys()) {
      expect(hallados.has(id), `la exención de ${id} sobrevivió a su corte: bórrala`).toBe(true);
    }
  });

  it.each(CORTES_HALLADOS.map((s) => [`${s.rel}:${s.nombre}`, s]))('%s', (id, sitio) => {
    expect(
      CORTES_EXENTOS.has(id),
      `${sitio.rel} → ${sitio.nombre}() corta por falta de número` +
      (sitio.declaraAmbos ? ' y encima declara CANALES.AMBOS' : ' antes de llamar a quien avisa') +
      '. Eso NO protege nada: notificarUsuario ya maneja whatsapp:null (deja ' +
      '`skipped_no_whatsapp` en el ledger y escribe la campana igual). Lo único que hace el ' +
      'corte es apagarle la mitad in-app a quien entró por la web. Sacá el corte, o declaralo ' +
      'en CORTES_EXENTOS con el porqué.',
    ).toBe(true);
  });
});

/**
 * El correo PROMETE respetar la baja, y esto es lo único que lo obliga.
 *
 * Cada email lleva al pie, textual: *"se apagan en todos los canales, también en WhatsApp"*, y
 * la página de baja repite la frase. Eso hoy es cierto por una sola razón: el único emisor
 * (`checkRecordatorioDeudas`) casualmente mira `recordatorios_activos` antes de notificar.
 * **Ni `notificarUsuario` ni `enviarEmail` lo chequean** — no pueden, sin meter I/O en el
 * chokepoint, que es una decisión ya tomada y revertida una vez.
 *
 * O sea que el próximo emisor que declare `email:` y se olvide del flag le manda un correo a
 * alguien que pidió explícitamente no recibirlos, y no hay nada que se ponga rojo. Un opt-out
 * que se cumple por casualidad no es un opt-out; y a diferencia de WhatsApp, acá la persona
 * tiene un botón de "spam" a un click que le cuesta reputación al dominio entero.
 *
 * Igual que el guard de arriba, esto es una DECLARACIÓN, no una demostración: verifica que la
 * función MIRE el flag, no que lo mire bien.
 */
const DECLARA_EMAIL = /\bemail\s*:\s*\{/;
const FILTRA_RECORDATORIOS = /\.(?:is|eq|neq|not|or|filter|match)\(\s*['"`][^'"`]*\brecordatorios_activos\b/;
const RECORDATORIOS_EN_DECISION = new RegExp(
  String.raw`^.*(?:\bif\s*\(|\breturn\b|\bcontinue\b|\?|&&|\|\|).*\.recordatorios_activos\b`
  + String.raw`|^.*\.recordatorios_activos\b.*(?:===|!==|\?|&&|\|\|)`,
  'm',
);
const miraLaBaja = (cuerpo) => FILTRA_RECORDATORIOS.test(cuerpo) || RECORDATORIOS_EN_DECISION.test(cuerpo);

/** Emisores de correo que NO miran la baja, a propósito. Vacía, y debería quedarse vacía. */
const EMAIL_SIN_OPTOUT = new Map([]);

const CON_EMAIL = [];
for (const { rel, src } of FUENTES) {
  if (rel === 'lib/notify-user.js' || rel === 'lib/email.js') continue;   // definición y transporte
  const limpio = sinMotivos(sinComentarios(src));
  for (const fn of funciones(limpio)) {
    if (!DECLARA_EMAIL.test(fn.cuerpo)) continue;
    CON_EMAIL.push({ rel, nombre: fn.nombre, cuerpo: fn.cuerpo });
  }
}

describe('todo emisor de correo respeta la baja que el propio correo promete', () => {
  it('el barrido encuentra al menos un emisor (antivacuidad)', () => {
    // Sin esto el archivo pasa por vacuidad el día que el regex deje de matchear — y encima
    // se vería sano, porque "cero emisores de correo" no llama la atención.
    expect(CON_EMAIL.length).toBeGreaterThanOrEqual(1);
    // 31-ago-2026: el correo de deudas se mudó de `checkRecordatorioDeudas` (uno por deuda) a
    // `checkResumenDeudasSemanal` (uno por persona, los lunes). El emisor cambió; la obligación
    // de mirar la baja no, y por eso el ancla se muda con él en vez de borrarse.
    expect(CON_EMAIL.map((s) => `${s.rel}:${s.nombre}`)).toContain('cron/checks.js:checkResumenDeudasSemanal');
  });

  it.each([
    ['acceso en decisión', "async function f(u) {\n  if (u.recordatorios_activos === false) continue;\n  await notificarUsuario({ email: { to: u.email, asunto: 'x' } });\n}\n"],
    ['filtro de PostgREST', "async function f(u) {\n  const { data } = await supabase.from('usuarios').select('id').eq('recordatorios_activos', true);\n  await notificarUsuario({ email: { to: u.email, asunto: 'x' } });\n}\n"],
  ])('un emisor que SÍ mira la baja (%s) cuenta', (_forma, fuente) => {
    expect(miraLaBaja(funciones(sinMotivos(sinComentarios(fuente)))[0].cuerpo)).toBe(true);
  });

  it.each([
    ['sin mirarla', "async function f(u) {\n  await notificarUsuario({ email: { to: u.email, asunto: 'x' } });\n}\n"],
    ['solo en un comentario', "async function f(u) {\n  // el cron ya filtra recordatorios_activos\n  await notificarUsuario({ email: { to: u.email, asunto: 'x' } });\n}\n"],
    ['solo en el .select() (proyección, no filtro)', "async function f(u) {\n  const { data } = await supabase.from('usuarios').select('id, recordatorios_activos');\n  await notificarUsuario({ email: { to: u.email, asunto: 'x' } });\n}\n"],
    ['leyéndola sin decidir', "async function f(u) {\n  log.info({ act: u.recordatorios_activos }, 'x');\n  await notificarUsuario({ email: { to: u.email, asunto: 'x' } });\n}\n"],
  ])('un emisor que NO la mira (%s) no cuenta', (_forma, fuente) => {
    expect(miraLaBaja(funciones(sinMotivos(sinComentarios(fuente)))[0].cuerpo)).toBe(false);
  });

  it.each(CON_EMAIL.map((s) => [`${s.rel}:${s.nombre}`, s]))('%s', (id, sitio) => {
    if (EMAIL_SIN_OPTOUT.has(id)) return;
    expect(
      miraLaBaja(sitio.cuerpo),
      `${sitio.rel} → ${sitio.nombre}() manda correo sin mirar recordatorios_activos. El pie de ` +
      'cada email promete por escrito que la baja apaga TODOS los canales, y el chokepoint no ' +
      'puede hacerlo cumplir (leer el flag ahí sería meter I/O en notificarUsuario, decisión ya ' +
      'revertida una vez). O filtrás por el flag, o lo declarás en EMAIL_SIN_OPTOUT con el porqué.',
    ).toBe(true);
  });
});
