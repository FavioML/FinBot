// ¿El modelo de `watchPatterns` que usa el harness coincide con lo que Railway HACE?
//
// El cuarto de la familia, y el único que no compara el repo contra sí mismo:
//
//   backend-deploy-fresh    ¿está al día?              → quedó backend en main sin desplegar
//   backend-deploy-tested   ¿lo que corre pasó tests?  → se desplegó algo con la suite roja
//   backend-deploy-gated    ¿el deploy esperó?         → el gate se saltó, verde o no
//   backend-watchpatterns-real  ¿el modelo es cierto?  → el predicado miente sobre Railway
//
// POR QUÉ HACE FALTA. `disparaBuildRailway()` decide si un commit pendiente redespliega el
// backend, y de esa decisión depende que `backend-deploy-fresh` diga PASS o STALE. Hasta el
// 07-ago-2026 lo único que lo vigilaba era un test de paridad contra una segunda copia de la
// lista escrita a mano. Ese test tenía tres agujeros medidos, pero el problema de fondo era
// otro y no se arregla con más paridad: **dos copias de acuerdo entre sí pueden estar las dos
// equivocadas sobre Railway**. La sintaxis de los globs de Railway no está documentada al
// nivel que esta lista necesita (¿`**` matchea dotfiles? ¿`!/*.md` ancla a la raíz?), así que
// lo único que zanja es mirar qué hizo Railway.
//
// CÓMO. Railway publica, por deployment, si construyó o por qué no (`meta.skippedReason`) y
// **con qué patrones** (`meta.serviceManifest.build.watchPatterns`). Con el commit anterior
// que sí construyó se reconstruye el diff que Railway miró, se le pasa al predicado, y se
// contrasta el veredicto contra el suyo.
//
// Se juzga cada deployment con SUS patrones, no con los de hoy: `railway.json` cambia, y
// juzgar el pasado con la config del presente produce desacuerdos que no son bugs del modelo.
//
// Medición inicial (07-ago-2026): **48 de 48 juzgables de acuerdo** con la ventana por
// defecto (60), y **86 de 86** con `NETO_WP_VENTANA=100`. Los dos números salen de correrlo;
// no hay una corrida que dé uno y otra que dé el otro.
//
// No los uses como valor esperado: la ventana son los ÚLTIMOS N deployments, así que cada
// push cambia cuál entra y cuál sale, y el conteo de juzgables se mueve solo. Lo que tiene
// que dar siempre es `desacuerdos: 0`; el resto es cuánto se pudo mirar, no una nota.
//
// HASTA DÓNDE LLEGA, Y ES MENOS DE LO QUE SUENA. Este harness solo prueba el modelo en las
// distinciones que la historia EJERCITA. Comprobado por mutación el 07-ago, y las dos pasaron
// en verde sobre toda la ventana: volver `!/*.md` recursivo (sacarle el ancla de raíz), y
// cambiar `startsWith` por `includes` en `dir/**`. Ninguna de las dos cambiaba el veredicto de
// un solo commit del historial, porque no hubo commits que dependieran de esa diferencia.
//
// **Las dos se cerraron con deploys de control, y ninguna pasa ya en verde:**
//
//   08-ago  `00dd65d`  tocó solo `.claude/commands/deploy.md` (un `.md` ANIDADO, y `.claude/`
//                      está observado) → Railway **construyó**: el ancla de raíz existe.
//   09-ago  `6de1392`  tocó solo `.claude/docs/railway-glob-probe.md` → **`SKIPPED`**: o sea
//                      que `dir/**` NO ancla a la raíz. **El modelo estaba MAL**, y lo
//                      encontró ESTE harness con exit 1, no la suite.
//
// La segunda es la razón de ser del archivo, demostrada: `startsWith` estaba escrito en
// `railway-watch.mjs` Y como `^dir/` en la reimplementación por regex del test de paridad —
// las dos copias de acuerdo y las dos equivocadas. Con la mutación puesta en AMBAS, 12 de 13
// tests de paridad siguen en verde. Un test de paridad no ve un error de concepto compartido.
//
// Sigue sin ejercitarse el **segmento parcial** (`midocs/` contiene `docs/` sin ser el
// segmento `docs`); se modela del lado seguro. Ver la sección de `railway.json` en CLAUDE.md
// y `.claude/docs/railway-glob-probe.md`, que es la sonda.
//
// Por eso el PASS reporta `ejercitado`: qué patrón decidió cuántas filas, y si el ancla de
// raíz llegó a ser decisiva alguna vez. Un PASS con `anclaDeRaizEjercitada: 0` significa
// "coincide en todo lo que se pudo ver", NO "el modelo está verificado". Los near-misses
// (prefijo compartido, ruta anidada, ancla) los cubre `tests/railway-watchpatterns-paridad.test.js`
// contra una reimplementación independiente, que es otra cosa: consistencia, no verdad.
//
// LO QUE NO SE JUZGA, y distinguirlo es la mitad del trabajo. Railway solo da un veredicto de
// `watchPatterns` en dos casos: cuando dice `"No changes to watched files"`, o cuando
// construye. Todo lo demás NO es un veredicto y juzgarlo inventa desacuerdos:
//
//   - `frenado-antes-de-watchpatterns` — `"CI check suite failed"`. Railway evalúa el gate
//     ANTES de resolver la config, así que nunca llegó a mirar los patrones.
//   - `sin-imagen` — el deployment no produjo imagen: otro push lo superó, o quedó esperando
//     una suite que nunca terminó. **Se reconoce por `imageDigest`, no por el status**; ver
//     el comentario de `construyo()`, que es donde estuvo el error que costó una conclusión
//     falsa entera. Incluye algunos que SÍ llegaron a arrancar el build, o sea que subcuenta
//     la cobertura; el comentario de la clasificación explica por qué se acepta.
//   - `todavia-sin-veredicto` — está en vuelo (`WAITING`, `BUILDING`…). Normal si se corre
//     justo después de un push.
//   - `sin-patrones-declarados`, `sin-historia-local`, `sin-base`, `patrones-no-compilables`.
//
// Todas se cuentan en `noJuzgadas` y el total cierra contra `deployments`: si una corrida
// juzga poco, el output dice POR QUÉ en vez de mandar a mirar la ventana.
//
// Exit 0 = el modelo coincide con Railway. Exit 1 = hay un desacuerdo REAL: el predicado dice
// una cosa y Railway hizo otra, con la config aplicada. Exit 2 = no se pudo determinar (token,
// API, o muy pocos deployments juzgables como para que un verde signifique algo).
//
// Usage: node qa-e2e/backend-watchpatterns-real.mjs   (desde app/)
// Requiere: RAILWAY_API_TOKEN (del .env local o del entorno) + el repo con la historia local.

import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

import { consultarRailway, PROJECT_ID, SERVICE_ID, ENVIRONMENT_ID } from '../scripts/railway-api.mjs';
import { compilarPatrones, crearPredicado, evaluarReglas, leerPatrones } from './lib/railway-watch.mjs';

// Solo para el reporte de cobertura: qué patrones declara HOY railway.json, para poder decir
// cuáles de ELLOS nunca decidieron nada en la ventana. Los veredictos se juzgan con los
// patrones de cada deployment (los que trae la API), no con estos.
//
// Por eso NO tira si `railway.json` está roto: este harness no necesita el archivo para
// responder su pregunta, y hacerlo caer al importar lo dejaba en exit 1 con un stack trace —
// que su propio `on_fail` traduce a "el modelo no coincide con Railway", el diagnóstico
// equivocado. Es el mismo error que la derivación perezosa de `backend-deploy-fresh` vino a
// arreglar, reintroducido en el archivo de al lado.
let WATCH_PATTERNS_HOY = null;
try {
  WATCH_PATTERNS_HOY = leerPatrones();
} catch { /* la cobertura por patrón se omite; el veredicto no depende de esto */ }

const VENTANA = Number(process.env.NETO_WP_VENTANA ?? 60);

// Piso de vacuidad. Sin esto, una respuesta con dos deployments juzgables saldría PASS y el
// canary lo leería como "el modelo está verificado". Es la misma lección que el corpus vacío
// del test de paridad: un guard que no ejercitó nada no es un guard verde.
const MIN_JUZGADOS = Number(process.env.NETO_WP_MIN ?? 8);

const SIN_CAMBIOS = 'No changes to watched files';

/**
 * ¿Este deployment llegó a construir? **`meta.imageDigest`, no el `status`.**
 *
 * La primera versión preguntaba `status in {SUCCESS, REMOVED, FAILED, ...}` razonando que
 * "REMOVED construyó igual, solo lo reemplazaron". Es falso y costó una conclusión entera:
 * `REMOVED` significa nada más "ya no es el vigente", y ahí caen también los que **nunca
 * construyeron** — el que se quedó en `WAITING` esperando una suite que el outage de GitHub
 * nunca creó, y el que otro push superó a los 103s, menos de lo que tarda un build.
 *
 * Medido el 07-ago sobre los cinco casos, y Railway lo dice sin ambigüedad:
 *
 *   89206ac  REMOVED  imageDigest ✓   buildLogs: 127 líneas
 *   112465b  REMOVED  imageDigest ✓   buildLogs: 129 líneas
 *   cbf267c  REMOVED  imageDigest ✗   buildLogs: 10   (superado a mitad de build)
 *   573dfc1  REMOVED  imageDigest ✗   buildLogs: 1
 *   8e338ff  REMOVED  imageDigest ✗   "Deployment does not have an associated build"
 *
 * Importa por dos cosas distintas. Uno: solo un deployment que construyó puede ser la BASE
 * del diff siguiente, y tomar como base a uno que no llegó produce un desacuerdo inventado
 * (pasaba con `112465b`, cuya base real era `41b3aca` y no `cbf267c`). Dos: el `meta` de los
 * que no construyeron viene sin `configFile` y con `watchPatterns: []`, y leer eso como
 * "Railway resolvió la config a una lista vacía" es una historia entera construida sobre un
 * campo que falta porque el deployment no llegó a la etapa que lo escribe.
 */
const construyo = (d) => Boolean(d.imageDigest);

/**
 * ¿La base pudo seguir en vuelo cuando Railway evaluó a este deployment? (hallazgo Q10)
 *
 * El harness reconstruía la base como "el último que produjo imagen", y con el gate puesto
 * eso es falso: un deployment se queda en `WAITING` esperando el check suite y puede
 * construir DESPUÉS de que se creó el siguiente. El 11-ago `6efbaaa` se creó 16:37:35 y
 * empezó a construir 16:42:30, mientras `304b901` se creó 16:39:13 — el harness lo tomó de
 * base, el rango salió sin rutas observadas y reportó un DESACUERDO que no existía.
 *
 * La señal es la SEPARACIÓN entre creaciones, y el umbral sale de dos números ya medidos en
 * este repo (`CLAUDE.md`, sección del gate): con "Wait for CI" encendido, push → inicio de
 * build pasó de ~7s a **~2m50s**, y el build tarda **140-185s**. O sea que un deployment no
 * está desplegado hasta ~5m35s después de crearse. Con menos de eso entre dos creaciones,
 * la base es dudosa y no se juzga.
 *
 * Lo que este umbral CUESTA, y se elige a sabiendas: dos pushes seguidos dejan de juzgarse,
 * así que un desacuerdo real en esa ventana no se ve. La dirección contraria —inventar
 * desacuerdos— es peor: este harness ya encontró un error real del modelo el 09-ago, y su
 * exit 1 solo sirve si nadie lo descarta a ojo.
 */
const MARGEN_BASE_MS = 6 * 60 * 1000;
function paseloEnVuelo(base, d) {
  if (!base || !base.creadoEn || !d.creadoEn) return false;
  const separacion = new Date(d.creadoEn).getTime() - new Date(base.creadoEn).getTime();
  return Number.isFinite(separacion) && separacion >= 0 && separacion < MARGEN_BASE_MS;
}

/**
 * Estados transitorios: Railway todavía no terminó de decidir. No se juzgan.
 *
 * El enum completo de la API (introspección, 07-ago) es `BUILDING CRASHED DEPLOYING FAILED
 * INITIALIZING NEEDS_APPROVAL QUEUED REMOVED REMOVING SKIPPED SLEEPING SUCCESS WAITING`. Los
 * que faltan acá caen a propósito en las otras ramas, pero el set no se puede leer como
 * exhaustivo: un estado nuevo cae en `sin-imagen` si además no produjo imagen.
 */
const EN_VUELO = new Set([
  'WAITING', 'QUEUED', 'INITIALIZING', 'BUILDING', 'DEPLOYING', 'NEEDS_APPROVAL', 'REMOVING', 'SLEEPING',
]);

const short = (s) => (s ? s.slice(0, 7) : s);

function done(code, verdict, extra = {}) {
  console.log(JSON.stringify({ verdict, ...extra }, null, 2));
  process.exitCode = code;
  return code;
}

/**
 * Los archivos que Railway miró: el diff desde el último commit **DESPLEGADO**, no desde el
 * commit anterior. Es la sutileza que hace que un revert salga `"No changes to watched
 * files"` —deja el árbol idéntico a lo que ya corre— y `backend-deploy-fresh` la implementa
 * igual. Devuelve `null` si git no tiene alguno de los dos commits.
 */
export function archivosDelDiff(desde, hasta, cwd) {
  try {
    return execFileSync('git', ['diff', '--name-only', '-z', `${desde}..${hasta}`], { cwd, encoding: 'utf8' })
      .split('\0').map((s) => s.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * ¿Qué patrones DECIDIERON esta fila? Un patrón es decisivo si sacarlo de la lista cambia el
 * veredicto sobre estos archivos. Es lo que convierte "48 de acuerdo" en una afirmación
 * concreta: sin esto, un patrón que nunca decidió nada se ve igual de verificado que uno que
 * decidió cuarenta filas.
 */
function patronesDecisivos(patrones, archivos, veredicto) {
  const decisivos = [];
  for (let i = 1; i < patrones.length; i++) { // el 0 es `**`; sacarlo no es una variante útil
    const sinEste = patrones.filter((_, j) => j !== i);
    let dispara;
    try { dispara = crearPredicado(sinEste); } catch { continue; }
    if (archivos.some(dispara) !== veredicto) decisivos.push(patrones[i]);
  }
  return decisivos;
}

/**
 * ¿El ANCLA DE RAÍZ de un patrón `!/*.ext` llegó a ser decisiva en esta fila?
 *
 * Fue durante meses la única suposición del modelo que ninguna observación de Railway
 * sostenía. `!/*.md` excluye los `.md` de la raíz —eso sí estaba medido (`aaed32e`,
 * `cf6029b`, `cde2525`)— pero esas observaciones son igual de compatibles con que el patrón
 * sea RECURSIVO y excluya también `handlers/notas.md`. Para separarlas hace falta un commit
 * cuyo veredicto dependa solo de un `.md` ANIDADO, y en toda la historia no hubo ninguno.
 *
 * **Se midió el 08-ago-2026 con un deploy de control** (`00dd65d`, que tocó únicamente
 * `.claude/commands/deploy.md` — `.claude/` está observado): Railway **construyó**, o sea
 * que el ancla existe y el modelo era correcto. Esta función es lo que convierte esa fila
 * en cobertura: devuelve `true` sobre ella, y con la mutación recursiva el harness sale
 * exit 1. Antes de ese commit, esa mutación pasaba en verde sobre toda la ventana.
 *
 * SIGUE HACIENDO FALTA, y no es ceremonia: la ventana son los últimos N deployments, así
 * que `00dd65d` se va a caer de ella con el tiempo y la cobertura vuelve a 0. Eso no
 * desmide el ancla —lo medido, medido está— pero sí significa que ESTA corrida dejó de
 * poder distinguirla. El `aviso` de abajo dice exactamente eso, y no otra cosa.
 *
 * DECISIVA, no presente. La primera versión de esto contaba las filas que TENÍAN un `.md`
 * anidado y reportaba 18 sobre 48, que es exactamente la conclusión equivocada: en las 18
 * había además archivos de backend, así que el veredicto no dependía del ancla ni un poco.
 * Un contador de cobertura que cuenta lo que no verifica es peor que no tenerlo.
 */
function ejercitaElAncla(reglas, archivos, veredicto) {
  const recursivas = reglas.map((r) =>
    r.forma === 'extRaiz' ? { ...r, test: (f) => f.endsWith(r.clave) } : r,
  );
  return archivos.some((f) => evaluarReglas(recursivas, f)) !== veredicto;
}

/**
 * El corazón, puro y testeable: dada la secuencia de deployments (del más VIEJO al más nuevo)
 * y una forma de obtener el diff, ¿en qué difiere el modelo de lo que Railway hizo?
 */
export function compararConRailway(deployments, obtenerArchivos) {
  const filas = [];
  let ultimoDesplegado = null;
  // La fila del último que construyó, no solo su sha: hace falta su `updatedAt` para saber
  // si ya había terminado cuando se creó el que estamos juzgando (Q10).
  let ultimoDesplegadoFila = null;

  for (const d of deployments) {
    const llegoAConstruir = construyo(d);
    const saltadoPorPatrones = d.skippedReason === SIN_CAMBIOS;
    const fila = { sha: short(d.sha), status: d.status, skippedReason: d.skippedReason || null };

    // Railway dio un veredicto de watchPatterns SOLO en dos casos: dijo "no hay nada que
    // observar" (y lo nombra), o construyó. Cualquier otro estado —en vuelo, frenado por el
    // gate, superado antes de arrancar— no es un veredicto y juzgarlo inventa desacuerdos.
    // La primera versión derivaba `realidad` únicamente de `skippedReason`, así que un
    // deployment sin motivo de skip y sin build contaba como "construyó".
    // Q10: la base NO es "el último que produjo imagen", es "el último que YA HABÍA
    // TERMINADO de construir cuando Railway evaluó a éste". Con el gate puesto, un
    // deployment puede quedarse minutos en WAITING y construir DESPUÉS de que se creó el
    // siguiente — pasó el 11-ago con `6efbaaa` (creado 16:37:35, empezó a construir
    // 16:42:30) y `304b901` (creado 16:39:13). El harness tomó a `6efbaaa` de base, el
    // rango salió vacío de rutas observadas y reportó un DESACUERDO que no existía: la base
    // real era un commit anterior, y ese rango sí traía `handlers/webhook.js`.
    //
    // No se adivina cuál era la base verdadera: el caso no se juzga. Es una SUBCUENTA de
    // cobertura, igual que `sin-imagen` — un desacuerdo inventado es mucho peor que un
    // juzgable de menos, porque este harness existe para que su exit 1 se tome en serio.
    //
    // ⚠️ La primera versión usaba `updatedAt` de la base como "cuándo terminó de construir"
    // y eso NO sirve: a un deployment que pasa a REMOVED Railway le pisa `updatedAt` con la
    // hora del REEMPLAZO, que por construcción es posterior a la creación del siguiente. Se
    // midió antes de shipearla: clasificaba **99 de 100** como `base-en-vuelo` y dejaba el
    // harness ciego con 0 juzgables. Ver `paseloEnVuelo`.
    const baseEnVuelo = paseloEnVuelo(ultimoDesplegadoFila, d);
    if (!ultimoDesplegado) {
      fila.clase = 'sin-base'; // el más viejo de la ventana no tiene contra qué diffear
    } else if (baseEnVuelo) {
      fila.clase = 'base-en-vuelo';
      fila.base = short(ultimoDesplegado);
      fila.detalle = 'la base pudo seguir construyendo cuando se creó este deployment';
    } else if (d.skippedReason && !saltadoPorPatrones) {
      // El gate lo frenó ANTES de que Railway resolviera la config: no dice nada del modelo.
      fila.clase = 'frenado-antes-de-watchpatterns';
    } else if (!saltadoPorPatrones && !llegoAConstruir) {
      // OJO con el nombre: `sin-imagen` NO es lo mismo que "Railway no evaluó watchPatterns".
      // Railway decide construir ANTES de producir la imagen, así que uno que arrancó el build
      // y fue superado a mitad —`cbf267c`, 10 líneas de buildLogs— sí dio un veredicto que
      // acá no se juzga. Es una SUBCUENTA de cobertura, no un desacuerdo falso: la base
      // tampoco debe avanzar sobre él. Distinguirlos cuesta una consulta de `buildLogs` por
      // deployment, y hoy no vale ese precio; si algún día importa, ésa es la señal.
      fila.clase = EN_VUELO.has(d.status) ? 'todavia-sin-veredicto' : 'sin-imagen';
    } else if (!Array.isArray(d.patrones) || d.patrones.length === 0) {
      // Sin patrones en el `meta` no hay con qué juzgar. Con la regla de `imageDigest` esto
      // ya casi no pasa: los `meta` incompletos son justo los que no llegaron a construir.
      fila.clase = 'sin-patrones-declarados';
    } else {
      const archivos = obtenerArchivos(ultimoDesplegado, d.sha);
      if (archivos === null) {
        fila.clase = 'sin-historia-local';
      } else {
        let dispara, reglas;
        try {
          reglas = compilarPatrones(d.patrones);
          dispara = crearPredicado(d.patrones);
        } catch (e) {
          fila.clase = 'patrones-no-compilables';
          fila.detalle = String(e.message).split('\n')[0];
          filas.push(fila);
          if (llegoAConstruir) { ultimoDesplegado = d.sha; ultimoDesplegadoFila = d; }
          continue;
        }
        const observados = archivos.filter(dispara);
        const modelo = observados.length > 0; //  el predicado dice: Railway construye
        const realidad = !saltadoPorPatrones; //  lo que Railway hizo

        fila.clase = modelo === realidad ? 'de-acuerdo' : 'DESACUERDO';
        fila.base = short(ultimoDesplegado);
        fila.archivos = archivos.length;
        fila.observados = observados.slice(0, 5);
        fila.modelo = modelo ? 'redespliega' : 'no redespliega';
        fila.railway = realidad ? 'construyó' : SIN_CAMBIOS;
        fila.decisivos = patronesDecisivos(d.patrones, archivos, modelo);
        fila.ancla = ejercitaElAncla(reglas, archivos, modelo);
      }
    }

    filas.push(fila);
    if (llegoAConstruir) { ultimoDesplegado = d.sha; ultimoDesplegadoFila = d; }
  }

  return filas;
}

async function main() {
  const token = process.env.RAILWAY_API_TOKEN;
  if (!token) {
    // Mismo criterio que backend-deploy-gated: sin credencial el guard se vuelve no-op, y un
    // no-op es verde por vacuidad. Falla, no se saltea.
    return done(1, 'falta RAILWAY_API_TOKEN', {
      hint: 'Está en el .env de app/ y en el secret de CI. Sin él este harness no mide nada.',
    });
  }

  const query = `query($input: DeploymentListInput!, $first: Int!) {
    deployments(first: $first, input: $input) {
      edges { node { status meta createdAt updatedAt } }
    }
  }`;
  const r = await consultarRailway({
    token,
    query,
    variables: { first: VENTANA, input: { projectId: PROJECT_ID, serviceId: SERVICE_ID, environmentId: ENVIRONMENT_ID } },
    campoEsperado: 'deployments',
  });
  if (!r.data) return done(2, 'no se pudo consultar la API de Railway', { errores: r.errores });

  const deployments = r.data.edges
    .map((e) => e.node)
    .map((n) => ({
      sha: n.meta?.commitHash,
      status: n.status,
      skippedReason: n.meta?.skippedReason || null,
      imageDigest: n.meta?.imageDigest || null,
      creadoEn: n.createdAt || null,
      // Cota SUPERIOR del fin del build, no el fin: cuando un deployment pasa a REMOVED,
      // Railway le pisa `updatedAt` con la hora del reemplazo. Alcanza para lo que se usa
      // acá —detectar que la base pudo estar todavía en vuelo— y no para más.
      tocadoEn: n.updatedAt || null,
      patrones: n.meta?.serviceManifest?.build?.watchPatterns,
    }))
    .filter((d) => d.sha)
    .reverse(); // del más viejo al más nuevo: el "último desplegado" se acumula hacia adelante

  if (!deployments.length) return done(2, 'la API no devolvió deployments con commit', {});

  // `fileURLToPath`, no `.pathname`: éste último viene percent-encoded, así que un espacio o
  // un acento en la ruta del repo daba un cwd inexistente. Todas las filas caían en
  // `sin-historia-local` y el harness salía exit 2 mandando a correr `git fetch --unshallow`.
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const filas = compararConRailway(deployments, (a, b) => archivosDelDiff(a, b, cwd));

  const por = (clase) => filas.filter((f) => f.clase === clase);
  const desacuerdos = por('DESACUERDO');
  const juzgados = desacuerdos.length + por('de-acuerdo').length;

  // Qué distinciones del modelo llegó a ejercitar esta ventana. Sin esto, un PASS se lee
  // como "el modelo está verificado" cuando puede significar "nada lo puso a prueba".
  const juzgadas = filas.filter((f) => f.clase === 'de-acuerdo' || f.clase === 'DESACUERDO');
  const porPatron = {};
  for (const f of juzgadas) for (const p of f.decisivos || []) porPatron[p] = (porPatron[p] || 0) + 1;
  const anclaEjercitada = juzgadas.filter((f) => f.ancla).length;

  // TODAS las clases, no solo las que me acordé. Con un subconjunto, una corrida en la que
  // todo cayera en una clase no reportada saldría exit 2 con un hint sobre la ventana, sin
  // mencionar la causa real. El total tiene que cerrar contra `deployments`.
  const noJuzgadas = {};
  for (const f of filas) {
    if (f.clase === 'de-acuerdo' || f.clase === 'DESACUERDO') continue;
    noJuzgadas[f.clase] = (noJuzgadas[f.clase] || 0) + 1;
  }

  const resumen = {
    deployments: filas.length,
    juzgados,
    deAcuerdo: por('de-acuerdo').length,
    desacuerdos: desacuerdos.length,
    noJuzgadas,
    ejercitado: { porPatronDecisivo: porPatron, anclaDeRaizEjercitada: anclaEjercitada },
  };

  const nuncaDecidieron = (WATCH_PATTERNS_HOY || []).slice(1).filter((p) => !porPatron[p]);
  if (nuncaDecidieron.length) {
    resumen.ejercitado.patronesQueNuncaDecidieron = nuncaDecidieron;
  }
  if (!WATCH_PATTERNS_HOY) {
    resumen.ejercitado.avisoConfig = 'railway.json no se pudo leer: falta la cobertura por patrón declarado';
  }
  if (!anclaEjercitada) {
    // OJO con lo que este aviso puede y no puede decir. Hasta el 08-ago-2026 decía que el
    // ancla era indistinguible de un patrón recursivo, y eso HOY ES FALSO: se midió con el
    // deploy de control `00dd65d` (tocó solo `.claude/commands/deploy.md`, un `.md` anidado,
    // y Railway construyó). Lo que este aviso reporta es una propiedad de ESTA VENTANA, no
    // del estado del conocimiento — y son cosas distintas justamente porque la ventana se
    // corre sola y `00dd65d` se va a caer de ella. Un aviso que confunde "no lo vi acá" con
    // "no se sabe" manda a remedir algo ya medido.
    resumen.ejercitado.aviso =
      'ningún commit de ESTA ventana dependió del ANCLA DE RAÍZ de `!/*.ext`, así que esta ' +
      'corrida no la distingue de un patrón recursivo. No significa que esté sin medir: se ' +
      'midió el 08-ago-2026 con el deploy de control `00dd65d`. Para volver a ejercitarla ' +
      'acá hace falta subir NETO_WP_VENTANA hasta alcanzarlo, u otro commit que dependa solo ' +
      'de un `.md` anidado.';
  }

  if (desacuerdos.length) {
    return done(1, 'EL MODELO NO COINCIDE CON RAILWAY', {
      ...resumen,
      desacuerdo: desacuerdos,
      hint: 'Antes de tocar el compilador de globs, comprobá la BASE del diff (campo `base`): ' +
        'es el último deployment que produjo imagen, y si Railway usó otra, el desacuerdo es ' +
        'de la reconstrucción y no del modelo. Recién si la base es correcta, mirá qué forma ' +
        'de patrón decide esos archivos en qa-e2e/lib/railway-watch.mjs.',
    });
  }

  if (juzgados < MIN_JUZGADOS) {
    return done(2, `solo ${juzgados} deployment(s) juzgables (mínimo ${MIN_JUZGADOS})`, {
      ...resumen,
      hint: 'Un verde sobre esta muestra no significaría nada. ¿La ventana es muy corta, o ' +
        'falta historia local (git fetch --unshallow)?',
    });
  }

  return done(0, 'PASS', { ...resumen, lectura: `el modelo coincide con Railway en ${juzgados} deployment(s)` });
}

/** Ver la nota en `backend-deploy-fresh.mjs`: la comparación cruda con `process.argv[1]` falla
 *  detrás de un junction y deja el harness en exit 0 sin output, que el canary lee como PASS. */
function esEntrypoint() {
  const arg = process.argv[1];
  if (!arg) return false;
  let real = null;
  try { real = realpathSync(arg); } catch { /* el path puede no existir */ }
  return [arg, real].some((p) => p && import.meta.url === pathToFileURL(p).href);
}

if (esEntrypoint()) {
  await main();
}
