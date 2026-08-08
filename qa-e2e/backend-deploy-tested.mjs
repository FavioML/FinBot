// ¿El backend que corre api.neto.pe pasó los tests ANTES de desplegarse?
//
// Hermano de backend-deploy-fresh.mjs, y la pregunta NO es la misma. Aquel pregunta
// "¿está al día?" (¿quedó código de backend en main sin desplegar?). Este pregunta
// "¿lo que está corriendo pasó la suite?". Se pueden contestar distinto sobre el mismo
// commit, y el caso que importa es justo ese: un commit desplegado SIN suite verde es
// PASS para el otro harness —el commit sí está desplegado, no hay nada pendiente— y es
// exactamente el agujero que este viene a tapar.
//
// EL AGUJERO (06-ago-2026). El gate del backend es el toggle "Wait for CI" de Railway, y
// **espera los check suites que EXISTEN cuando evalúa**. Ese día, con Actions degradado,
// GitHub tardó 3 minutos en crear el workflow run de `096593a`: Railway no encontró nada
// que esperar, desplegó, y terminó 2 minutos ANTES de que el run existiera. El gate falla
// cerrado cuando la suite corre y sale roja; falla ABIERTO cuando la suite nunca arranca.
// No tiene arreglo del lado de Railway —no se puede esperar algo que no existe—, así que
// lo único que lo atrapa es preguntar después. Esto es ese después.
//
// POR QUÉ MIRA EL WORKFLOW DE CI Y NO LOS CHECK SUITES. Railway gatea sobre el check suite
// entero, que sería lo más fiel, pero un commit puede tener VARIOS suites de github-actions:
// `bd9b77a` tiene dos, el del push de CI y el del "Backup DB" agendado que corrió sobre el
// mismo sha. Exigirlos todos verdes pondría esto rojo cuando falla un backup, que no dice
// nada sobre si el código pasó los tests, y un guard que grita por lo que no es se termina
// ignorando. La pregunta es "¿pasó la suite?", y el oráculo de eso es el run de ci.yml.
//
// Y NO ALCANZA CON QUE EL RUN ESTÉ VERDE. La conclusion de un run es un agregado, y un job
// `skipped` la deja en `success` — `nlp-agent` lo demuestra en todos los runs desde el 14-jul.
// El oráculo es el JOB `test`, mirado en las dos ramas. Hasta el 08-ago la rama verde
// devolvía PASS sin consultar un solo job, así que un `if:` nuevo sobre ese job (un filtro por
// paths, un toggle de standby) habría dejado pasar un deploy con la suite del backend sin
// correr, en el harness escrito para atrapar justamente eso.
//
// Exit 0 = el commit desplegado tuvo su CI verde Y el job de tests corrió y pasó. Exit 1 = no
// (nunca corrió la suite, falló, se canceló, sigue corriendo, el job de tests quedó skipped)
// o el guard quedó ciego (workflow renombrado, job renombrado). Exit 2 = no se pudo determinar
// (endpoint caído, gh/red, lista de jobs ilegible) — infra, sin veredicto.
//
// Usage: node qa-e2e/backend-deploy-tested.mjs   (desde app/)
// Requiere: `gh` autenticado con acceso a FavioML/FinBot.
//
// Nota Windows: process.exitCode y no process.exit, igual que el harness hermano.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

import { disparaBuildRailway } from './backend-deploy-fresh.mjs';

const API = process.env.NETO_API_URL || 'https://api.neto.pe';
const REPO = process.env.NETO_REPO || 'FavioML/FinBot';
// El archivo, no el `name:` del workflow: renombrar el display no debería cambiar a qué
// mira el guard. Si el ARCHIVO se renombra, esto da 404 y abajo eso es exit 1, no exit 0.
const WORKFLOW = process.env.NETO_CI_WORKFLOW || 'ci.yml';
// Cuántos runs verdes recientes se recorren buscando el ancestro verde más nuevo. Solo
// alimenta el diagnóstico de severidad; no cambia el veredicto.
const MAX_ANCESTROS = 5;
// El job de `ci.yml` que de verdad responde "¿el backend pasó los tests?". Los otros del
// mismo workflow (`webapp`, `deploy-webapp`, `railway-gate`) pueden ponerlo rojo por motivos
// que no tienen nada que ver con este código.
const JOB_TESTS = process.env.NETO_CI_JOB_TESTS || 'test';

const short = (s) => (s ? s.slice(0, 7) : s);

// `gh` escribe el motivo real ("Not Found (HTTP 404)") en STDERR; el `message` de la
// excepción solo trae "Command failed: gh api ...". Mirar únicamente el message hacía que
// la rama de guard-ciego de abajo no se alcanzara nunca y un 404 saliera como exit 2
// (infra). Lo encontró la prueba por mutación, no la lectura del código.
const detalleError = (e) => [e?.stderr, e?.message].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

// Se REPORTAN los dos, pero se CLASIFICA solo por stderr, y la diferencia importa: el
// `message` incluye la línea de comando entera, o sea la URL con el sha desplegado pegado.
// Un sha hex que contenga "404" (≈1% de los sha) convertía cualquier caída de red o de auth
// en un falso "GUARD CIEGO: se renombró ci.yml", que manda a arreglar algo que no pasó. El
// bug original era el opuesto —clasificar solo por `message`, y la rama no se alcanzaba
// nunca—, así que la corrección de un lado había abierto el otro. stderr no lleva la URL.
export const es404 = (e) => /HTTP 404|Not Found/i.test(String(e?.stderr ?? ''));

function done(code, verdict, extra = {}) {
  console.log(JSON.stringify({ verdict, ...extra }, null, 2));
  process.exitCode = code;
  return code;
}

function gh(ruta, jq) {
  const args = ['api', ruta];
  if (jq) args.push('--jq', jq);
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

/**
 * ¿El job que responde "¿el backend pasó los tests?" salió verde?
 *
 * Puro para poder probarlo contra jobs reales (`tests/backend-deploy-tested-errores.test.js`).
 *
 * **Corre en las DOS ramas, la roja y la verde**, y esa es la corrección más importante de
 * este archivo. Hasta el 08-ago solo se llamaba con el run rojo: con el run verde el harness
 * devolvía PASS sin mirar un solo job. La conclusion de un run es un AGREGADO y un job
 * `skipped` lo deja verde — `nlp-agent` está skipped en todos los runs desde el 14-jul y
 * ninguno dejó de ser `success`. O sea que el día que `test` lleve un `if:` que evalúe false
 * (por ejemplo "no correr la suite en cambios de solo-docs", que es una optimización que
 * cualquiera escribiría), el run sale verde, este harness da PASS, y **la suite del backend
 * nunca corrió**. Es exactamente el fail-open que este archivo existe para atrapar, un nivel
 * más arriba. Reproducido el 08-ago: con `NETO_CI_JOB_TESTS=job-que-no-existe` seguía dando
 * PASS, prueba de que la rama verde no consultaba nada.
 *
 * Tres reglas, y las tres se pagaron:
 *
 * 1. **`filter`, no `find`.** Con una matriz que produzca varios jobs con el mismo nombre,
 *    `find` se queda con el primero: verde el primero y rojo el segundo devolvía
 *    `culpaDeLosTests: false` con `"test: failure"` listado en `jobsRojos` **en el mismo
 *    objeto**. TODAS las patas tienen que estar verdes.
 * 2. **`skipped` NO es `success` para ESTE job.** Sí lo es para `jobsRojos` (ahí el skip es
 *    deliberado y no debe gritar), y esa asimetría es a propósito: un job que no corrió no
 *    dice nada, y "no dice nada" no puede contar como "el backend está sano".
 * 3. **El nombre se compara EXACTO.** `test-e2e` no es `test`. Con `startsWith` los 10 tests
 *    que había seguían en verde, así que la exactitud no estaba fijada por nada.
 *
 * `pasaronLosTests: null` es "no sé", nunca "entonces estaba bien", y `motivo` separa los dos
 * casos porque quien llama los trata distinto: la lista ilegible es infra (exit 2), el job
 * ausente es el guard quedándose ciego (exit 1), igual que el 404 del workflow.
 */
export function clasificarJobs(jobs, jobTests = JOB_TESTS) {
  if (!Array.isArray(jobs)) {
    return { pasaronLosTests: null, motivo: 'sin-lista', jobsDeTests: [], jobsRojos: [] };
  }

  const jobsRojos = jobs
    .filter((j) => j.conclusion && j.conclusion !== 'success' && j.conclusion !== 'skipped')
    .map((j) => `${j.name}: ${j.conclusion}`);

  const deTests = jobs.filter((j) => j.name === jobTests);
  // `conclusion ?? status` a secas imprimía `test: completed` para un job COMPLETADO SIN
  // conclusion, que cae en 'fallo' (bien, falla cerrado) pero se lee como si hubiera un
  // resultado. No hay suite que arreglar ahí: es un estado indeterminado de GitHub.
  const etiquetas = deTests.map(
    (j) => `${j.name}: ${j.conclusion ?? `sin conclusion (status ${j.status})`}`,
  );

  // Sin el job de tests en la lista no se puede afirmar que el backend esté sano. Puede que
  // lo renombraran, y un guard que asume lo mejor ante un cambio que no entiende es el
  // mismo fallo que `validCheckSuites`.
  if (deTests.length === 0) {
    return { pasaronLosTests: null, motivo: 'job-ausente', jobsDeTests: [], jobsRojos };
  }

  const noCorrieron = deTests.filter((j) => j.status !== 'completed' || j.conclusion === 'skipped');
  const fallaron = deTests.filter((j) => j.status === 'completed' && j.conclusion !== 'skipped' && j.conclusion !== 'success');

  if (fallaron.length) return { pasaronLosTests: false, motivo: 'fallo', jobsDeTests: etiquetas, jobsRojos };
  if (noCorrieron.length) return { pasaronLosTests: false, motivo: 'no-corrio', jobsDeTests: etiquetas, jobsRojos };
  return { pasaronLosTests: true, motivo: 'ok', jobsDeTests: etiquetas, jobsRojos };
}

/**
 * La respuesta cruda de `/jobs` a `{ jobs, error }`, separado para poder probarlo.
 *
 * **Una lista truncada es peor que una ilegible**, y falla en las dos direcciones: si la pata
 * roja de una matriz queda fuera de la página, sale `ok` y el harness da PASS con la suite
 * roja; si el job de tests entero queda fuera, sale un GUARD CIEGO falso. Por eso truncada se
 * trata como ilegible, que es el lado seguro. `jq` emite `null` cuando falta el campo y
 * `Number(null)` es 0, así que un run legítimamente sin jobs NO se marca truncado: cae en
 * `job-ausente`, que también es exit 1.
 */
export function interpretarRespuestaDeJobs(r) {
  const jobs = Array.isArray(r?.jobs) ? r.jobs : null;
  if (!jobs) return { jobs: null, error: 'la respuesta de /jobs no trajo una lista' };
  if (Number(r.total) !== jobs.length) {
    return { jobs: null, error: `la lista de jobs vino truncada: ${jobs.length} de ${r.total}` };
  }
  return { jobs, error: null };
}

/**
 * Los jobs de un run. Devuelve `{ jobs: null, error }` si no se pueden leer, y eso NO es lo
 * mismo que "ningún job rojo": quien lo llama tiene que tratar el null como "no sé", nunca
 * como "está bien".
 *
 * Se llama SIEMPRE, también con el run verde. Es un `gh api` de más en el camino feliz, y lo
 * vale: sin él la rama verde contestaba PASS sobre un run cuya conclusion es un agregado —ver
 * `clasificarJobs()`—. Este harness corre una vez por día en el canary y una vez por push, no
 * en un bucle.
 *
 * **Se compara `total_count` contra lo que llegó.** La página son 100 jobs y no se pagina; una
 * lista truncada es peor que ilegible, porque falla en las DOS direcciones: si la pata roja de
 * una matriz queda fuera de la página, sale `ok` y el harness da PASS con la suite roja; si el
 * job `test` entero queda fuera, sale un GUARD CIEGO falso. Truncada se trata como ilegible.
 * Es justo el escenario que motivó pasar de `find` a `filter`, así que dejarlo sin cubrir sería
 * arreglar la mitad.
 *
 * El motivo del fallo se propaga: sin él, el exit 2 de la rama verde llega al canary de las
 * 10am sin una línea con la que diagnosticar.
 */
function jobsDelRun(run) {
  const id = String(run.url || '').match(/\/runs\/(\d+)/)?.[1];
  if (!id) return { jobs: null, error: `no se pudo extraer el id del run de "${run.url}"` };
  try {
    return interpretarRespuestaDeJobs(JSON.parse(
      gh(`repos/${REPO}/actions/runs/${id}/jobs?per_page=100`, '{total: .total_count, jobs: [.jobs[] | {name, status, conclusion}]}'),
    ));
  } catch (e) {
    return { jobs: null, error: detalleError(e) };
  }
}

/**
 * El mapeo de (color del run × motivo) a exit code, puro y probado.
 *
 * Existe porque el arreglo más importante de este archivo —consultar los jobs también con el
 * run verde— **no tenía un solo control automático**: una revisión adversarial revirtió esa
 * línea de `main()` a la versión anterior y los 17 tests del archivo y los 894 de la suite
 * siguieron en verde. Los tests cubrían `clasificarJobs()`, que es la parte fácil; la decisión
 * vivía en una cascada de `if` dentro de `main()`, sin cobertura. La lección de siempre: el
 * test que escribí junto al fix cubría todo menos el cambio de comportamiento.
 *
 * El `default` es exit 2 **a propósito**. Antes la cascada terminaba en `return done(0,'PASS')`
 * por caída libre, así que un `motivo` nuevo que alguien agregara después —y que por
 * construcción nadie habría contemplado acá— salía PASS. Asumir lo mejor ante un dato que no
 * se entiende es el fallo que este archivo cita tres veces para no cometerlo.
 */
export function decidir({ conclusion, motivo, pasaronLosTests }) {
  const runVerde = conclusion === 'success';

  if (motivo === 'sin-lista') {
    // Con el run rojo, el run rojo YA es la anomalía: no poder decir de quién fue la culpa no
    // lo vuelve benigno. Con el run verde no hay nada anómalo observado y lo único que falta
    // es la comprobación, que es la definición de exit 2 en esta familia de harness.
    return runVerde ? { code: 2, clase: 'JOBS_ILEGIBLES' } : { code: 1, clase: 'NO_PASO_SIN_JOBS' };
  }
  if (motivo === 'job-ausente') return { code: 1, clase: 'GUARD_CIEGO_JOB' };
  if (motivo === 'no-corrio') return { code: 1, clase: 'SUITE_NO_CORRIO' };
  if (motivo === 'fallo') return { code: 1, clase: 'NO_PASO' };
  if (motivo === 'ok' && pasaronLosTests === true) {
    return runVerde ? { code: 0, clase: 'PASS' } : { code: 1, clase: 'ROJO_NO_POR_TESTS' };
  }
  return { code: 2, clase: 'MOTIVO_DESCONOCIDO' };
}

/**
 * Qué cambió entre el último commit **cuya suite de backend de verdad corrió y pasó** y el
 * desplegado, y cuánto de eso es runtime del backend. Es la diferencia entre "anotalo" y
 * "arreglalo ahora": el 06-ago el deploy sin gate no tuvo consecuencia porque entre el último
 * commit testeado y ese no cambió un solo archivo que Railway observe. Solo corre cuando ya
 * hay veredicto malo, y por eso puede permitirse una consulta de jobs por candidato.
 */
export function severidad(deployed, { ghFn = gh, leerJobs = jobsDelRun } = {}) {
  try {
    const verdes = JSON.parse(
      ghFn(
        `repos/${REPO}/actions/workflows/${WORKFLOW}/runs?status=success&per_page=${MAX_ANCESTROS * 4}`,
        '[.workflow_runs[] | {sha: .head_sha, url: .html_url}]',
      ),
    );

    let intentos = 0;
    let ilegibles = 0;
    for (const { sha: verde, url } of verdes) {
      // `break`, no `continue`: agotados los intentos no queda nada por hacer, y seguir
      // iterando los 20 shas restantes sin mirarlos no cambia el resultado.
      if (intentos >= MAX_ANCESTROS) break;
      if (verde === deployed) continue;
      intentos++;

      // `status=success` es la conclusion del RUN, que es el oráculo agregado que este archivo
      // entero declara no confiable: un job `skipped` la deja verde. Sin bajar al job, el
      // triage se calcula contra un "último verde" que puede no haber corrido nunca la suite,
      // y el mensaje de abajo llegaría a decir "el runtime que corre es el mismo que sí se
      // testeó" cuando ninguno de los commits del tramo se testeó. Es el caso que se produce
      // solo si el job `test` se filtra por paths, o sea exactamente el escenario que la rama
      // `no-corrio` viene a detectar: el detector y su triage no pueden usar oráculos
      // distintos.
      const { jobs } = leerJobs({ url });
      const veredictoDelCandidato = clasificarJobs(jobs).pasaronLosTests;
      // `null` es "no pude leer los jobs", que NO es lo mismo que "este candidato no sirve".
      // Sin contarlos, un blip de red durante el triage descartaba los 5 candidatos y salía
      // la misma frase que en el caso legítimo, o sea una afirmación sobre la historia de CI
      // fabricada por la red. Y esa frase es la que el on_fail del canary usa para decidir
      // entre anotarlo y arreglarlo ahora.
      if (veredictoDelCandidato === null) { ilegibles++; continue; }
      if (veredictoDelCandidato !== true) continue;
      let cmp;
      try {
        cmp = JSON.parse(
          ghFn(`repos/${REPO}/compare/${verde}...${deployed}`, '{status, files: [.files[]?.filename]}'),
        );
      } catch {
        continue; // sha que ya no existe (rama borrada, force-push): probar el siguiente
      }
      if (cmp.status !== 'ahead' && cmp.status !== 'identical') continue; // no es ancestro
      const observados = (cmp.files || []).filter(disparaBuildRailway);
      return {
        ultimoVerdeAnterior: short(verde),
        archivosDesdeEseVerde: (cmp.files || []).length,
        archivosDeBackendSinTestear: observados,
        lectura: observados.length === 0
          ? 'CERO archivos que Railway observe cambiaron desde el último commit con CI verde: se desplegó sin gate, pero el runtime que corre es el mismo que sí se testeó'
          : 'HAY archivos observados por Railway que llegaron a prod sin suite verde: revisarlos uno por uno',
      };
    }
    if (ilegibles === intentos && intentos > 0) {
      return {
        candidatosRevisados: intentos,
        lectura: `no se pudo verificar NINGUNO de los ${intentos} candidatos: no se leyeron sus `
          + `jobs. Esto no dice que no haya un ancestro sano, dice que no se pudo mirar`,
      };
    }
    return {
      candidatosRevisados: intentos,
      candidatosSinLeer: ilegibles,
      lectura: `no se encontró, entre los ${intentos} candidatos revisados, un commit ancestro `
        + `del desplegado cuyo job \`${JOB_TESTS}\` haya corrido y pasado`,
    };
  } catch (e) {
    return { error: String(e).split('\n')[0] };
  }
}

/**
 * De los datos crudos al veredicto completo: exit code, título y cuerpo del JSON.
 *
 * **Es puro y por eso existe.** La versión anterior ensamblaba el veredicto con una cascada
 * de `if` dentro de `main()`, que hace red y no se puede testear, así que lo único que
 * cubría el arreglo más importante del archivo eran dos tests que leían el CÓDIGO FUENTE de
 * `main()` buscando la cadena `'PASS'`. Una revisión adversarial los evadió con comillas
 * dobles —`done(0, "PASS", …)`— y reintrodujo el fail-open entero con 31/31 en verde. Un
 * guard que depende del estilo de comillas del próximo autor no es un guard.
 *
 * `severidad` entra inyectada porque hace red; el default es la real.
 *
 * El `switch` es EXHAUSTIVO y su `default` es exit 2. Antes `main()` caía libre a
 * `done(0,'PASS')`, así que una `clase` nueva —agregada en `decidir()` por alguien que no
 * mirara acá— salía PASS. Es el mismo fallo que `decidir()` ya había cerrado un nivel más
 * abajo, y estaba repetido acá arriba.
 */
export function veredicto({ deployed, ultimo, jobs, errorJobs, corridas, jobTests = JOB_TESTS, severidadFn = severidad }) {
  const { pasaronLosTests, motivo, jobsDeTests, jobsRojos } = clasificarJobs(jobs, jobTests);
  const { code, clase } = decidir({ conclusion: ultimo.conclusion, motivo, pasaronLosTests });
  const base = { deployed: short(deployed), conclusion: ultimo.conclusion, run: ultimo.url };

  switch (clase) {
    case 'NO_PASO_SIN_JOBS':
      return { code, verdict: `EL COMMIT DESPLEGADO NO PASÓ LA SUITE (${ultimo.conclusion})`, extra: {
        ...base,
        jobsDeTests: 'no se pudo leer la lista de jobs: se trata como el caso grave',
        errorAlLeerJobs: errorJobs,
        ...severidadFn(deployed),
        hint: 'api.neto.pe corre código cuya suite no salió verde. No se pudo bajar al job para ' +
          'saber si la culpa fue de los tests o de otro job del workflow.',
      } };

    case 'JOBS_ILEGIBLES':
      return { code, verdict: 'no se pudo leer la lista de jobs del run', extra: {
        ...base,
        errorAlLeerJobs: errorJobs,
        hint: 'El run está verde, pero eso no alcanza: la conclusion agrega otros jobs y un ' +
          `\`skipped\` la deja verde. Sin los jobs no se puede confirmar que \`${jobTests}\` haya ` +
          'corrido. ¿gh autenticado? ¿red? ¿el run quedó fuera de retención?',
      } };

    case 'GUARD_CIEGO_JOB':
      return { code, verdict: `GUARD CIEGO: el run no tiene ningún job llamado \`${jobTests}\``, extra: {
        ...base,
        jobs: (jobs || []).map((j) => j.name),
        jobsRojos,
        hint: `¿Se renombró el job \`${jobTests}\` en .github/workflows/${WORKFLOW}? Sin él no se ` +
          'puede afirmar que el backend haya pasado los tests, sea cual sea el color del run. ' +
          'Actualizá NETO_CI_JOB_TESTS.',
      } };

    case 'SUITE_NO_CORRIO':
      return { code, verdict: `LA SUITE DEL BACKEND NO CORRIÓ (el run figura ${ultimo.conclusion})`, extra: {
        ...base,
        jobsDeTests,
        jobsRojos,
        ...severidadFn(deployed),
        hint: `El job \`${jobTests}\` quedó skipped o sin completar, así que la conclusion del run ` +
          'no dice nada sobre este código. Suele ser un `if:` nuevo en el job (un filtro por ' +
          'paths, un toggle de standby como el de `nlp-agent`) o un `needs:` que no se cumplió.',
      } };

    // El job de los tests verde con el run rojo: lo que corre en prod SÍ pasó los tests. Se
    // reporta igual (exit 1) porque un commit desplegado con el run rojo sigue siendo anómalo,
    // pero con el nombre correcto y sin mandar a arreglar lo que no está roto.
    case 'ROJO_NO_POR_TESTS':
      return { code, verdict: `EL RUN QUEDÓ ROJO, PERO NO POR LOS TESTS (${ultimo.conclusion})`, extra: {
        ...base,
        jobsDeTests,
        jobsRojos,
        hint: `El backend que corre SÍ pasó \`${jobTests}\`. Lo rojo es otro job del mismo workflow ` +
          '(típicamente `deploy-webapp` o `railway-gate`), que no dice nada sobre este código. ' +
          'Arreglar ESE job; no hace falta redesplegar el backend.',
      } };

    case 'NO_PASO':
      return { code, verdict: `EL COMMIT DESPLEGADO NO PASÓ LA SUITE (${ultimo.conclusion})`, extra: {
        ...base,
        jobsDeTests,
        jobsRojos,
        ...severidadFn(deployed),
        hint: 'api.neto.pe corre código cuya suite no salió verde. Arreglar la suite y ' +
          'redesplegar sobre un commit verde.',
      } };

    case 'PASS':
      return { code, verdict: 'PASS', extra: { ...base, jobsDeTests, corridas } };

    // `MOTIVO_DESCONOCIDO` y cualquier clase futura. No puede pasar hoy; existe para que el
    // día que alguien agregue una, el default sea "no sé" y no un PASS por caída libre.
    default:
      return { code: 2, verdict: `veredicto no contemplado (clase ${clase}, motivo ${motivo})`, extra: {
        ...base,
        pasaronLosTests,
        hint: 'clasificarJobs()/decidir() devolvieron algo que veredicto() no sabe redactar. ' +
          'Agregá el caso acá Y su fila en tests/backend-deploy-tested-errores.test.js.',
      } };
  }
}

async function main() {
  // 1) Qué sha está corriendo en prod, dicho por prod.
  let deployed;
  try {
    const res = await fetch(`${API}/version`, { headers: { 'Cache-Control': 'no-store' } });
    if (!res.ok) return done(2, 'no se pudo leer /version', { status: res.status });
    const body = await res.json();
    deployed = body.sha;
    if (!deployed) {
      return done(2, '/version respondió sin sha', {
        hint: 'RAILWAY_GIT_COMMIT_SHA vacío: ¿el deploy con el endpoint /version ya salió?',
        body,
      });
    }
  } catch (e) {
    return done(2, 'fetch a /version falló', { error: String(e).split('\n')[0] });
  }

  // 2) Los runs de CI de ESE commit.
  let runs;
  try {
    runs = JSON.parse(
      gh(
        `repos/${REPO}/actions/workflows/${WORKFLOW}/runs?head_sha=${deployed}&per_page=20`,
        '[.workflow_runs[] | {status, conclusion, event, url: .html_url, created_at}]',
      ),
    );
  } catch (e) {
    const err = detalleError(e);
    // Un 404 acá NO es infra: es el guard quedándose ciego. Devolver exit 2 lo mandaría al
    // cajón de "problemas de red" y el gate se quedaría sin testigo sin que nadie se entere,
    // que es la misma lección de `validCheckSuites` en verify-railway-gate.mjs.
    if (es404(e)) {
      return done(1, `GUARD CIEGO: no existe el workflow ${WORKFLOW} en ${REPO}`, {
        deployed: short(deployed),
        error: err,
        hint: `¿Se renombró .github/workflows/${WORKFLOW}? Actualizá NETO_CI_WORKFLOW y este harness.`,
      });
    }
    return done(2, 'no se pudieron leer los runs de CI (gh)', {
      deployed: short(deployed),
      error: err,
      hint: '¿gh autenticado? ¿red?',
    });
  }

  // 3) Cero runs = el modo fail-open, tal cual pasó el 06-ago.
  if (runs.length === 0) {
    return done(1, 'EL COMMIT DESPLEGADO NUNCA TUVO SUITE DE CI', {
      deployed: short(deployed),
      ...severidad(deployed),
      hint: 'Railway desplegó sin gate: "Wait for CI" solo espera los check suites que ya ' +
        'existían cuando evaluó. Pasa con GitHub degradado. Verificar el diff y redesplegar ' +
        'sobre un commit con suite verde.',
    });
  }

  // El más nuevo manda: un re-run sobre el mismo sha crea un run posterior, y lo que vale
  // es el último veredicto, no el primero.
  const ordenados = [...runs].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const ultimo = ordenados[0];

  // 4) Todavía corriendo = el deploy le ganó de mano a su propia suite. Es la ventana del
  //    fail-open en vivo, no un estado transitorio benigno: con el gate sano Railway
  //    despliega DESPUÉS de que la suite termina verde.
  if (ultimo.status !== 'completed') {
    return done(1, 'EL COMMIT DESPLEGADO TIENE LA SUITE TODAVÍA CORRIENDO', {
      deployed: short(deployed),
      status: ultimo.status,
      run: ultimo.url,
      hint: 'Con el gate sano esto no pasa: se despliega después de la suite verde. Volver a ' +
        'correr en unos minutos; si queda así, el deploy salió sin gate.',
    });
  }

  // 5) El oráculo NO es la conclusion del run, ni con el run rojo ni con el run verde.
  //
  //    Rojo: `ci.yml` también corre `deploy-webapp` (un `vercel deploy`) y `railway-gate`
  //    (que consulta la API de Railway). Un deploy de Vercel caído o un RAILWAY_API_TOKEN
  //    vencido lo ponen en rojo sin decir nada sobre el backend, y este harness mandaba a
  //    "arreglar la suite" con la suite del backend verde.
  //
  //    Verde: la conclusion es un AGREGADO y un job `skipped` no la ensucia. Un `test` que
  //    no corrió deja el run en `success`, y hasta el 08-ago eso salía PASS sin mirar nada.
  //
  //    Es el mismo argumento por el que se eligió `ci.yml` sobre los check suites —no gritar
  //    por lo que no es, y no callar por lo que no se miró— aplicado un nivel más adentro.
  const { jobs, error: errorJobs } = jobsDelRun(ultimo);
  const { code, verdict, extra } = veredicto({ deployed, ultimo, jobs, errorJobs, corridas: runs.length });
  return done(code, verdict, extra);
}

// Igual que el harness hermano: solo corre si se lo invoca directo. Sin esto, importar
// `es404` desde su test dispararía el fetch a prod y el `gh api` como efecto secundario.
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
