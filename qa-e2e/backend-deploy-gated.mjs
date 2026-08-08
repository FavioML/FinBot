// ¿El deploy que puso este commit en prod ESPERÓ a su suite, o se le adelantó?
//
// El tercero de la familia, y las tres preguntas son distintas sobre el mismo commit:
//
//   backend-deploy-fresh   ¿está al día?              → quedó backend en main sin desplegar
//   backend-deploy-tested  ¿lo que corre pasó tests?  → se desplegó algo con la suite roja
//   backend-deploy-gated   ¿el deploy esperó?         → el gate se saltó, verde o no
//
// POR QUÉ HACE FALTA EL TERCERO. `backend-deploy-tested` se escribió el 07-ago-2026 creyendo
// que tapaba el fail-open del 06-ago, y tapa la mitad: pregunta si el commit desplegado tuvo
// suite verde. Si el gate se salta un commit y la suite después sale VERDE, ese harness da
// PASS, `backend-deploy-fresh` da PASS y `verify-railway-gate` da PASS —el toggle sigue
// prendido, nunca se apagó—, así que el bypass no deja un solo rastro. El 06-ago se vio solo
// porque además la suite estaba roja. La próxima vez puede no estarlo.
//
// LO QUE MIRA: el INICIO del build, contra el fin de la suite. El delator ya estaba escrito en
// CLAUDE.md sin automatizar: "push → inicio de build pasó de ~7 segundos a ~2m50s". Con el gate
// sano Railway deja el deployment en WAITING y no construye hasta que el check suite termina.
//
// LA PRIMERA VERSIÓN DE ESTO MIRABA EL FIN Y ESTABA MAL. `updatedAt − runTerminado` es en
// realidad `duraciónBuild − duraciónSuite`: cuando el build tarda más que la suite —lo normal
// acá, 140-185s de build contra 39-180s de suite— un deploy SIN gate igual termina después y
// salía "esperó". Sobre el historial real detectaba el **16%** de los deploys sin gate, y 0% en
// los dos días en que el gate demostrablemente no existía. Lo encontró una revisión
// adversarial. El inicio del build separa las dos poblaciones sin solaparse, y no depende de
// cuánto tarde el build.
//
// De dónde sale el inicio: el timestamp más viejo de `buildLogs`. NO de `createdAt` (Railway
// crea la fila apenas llega el push, incluso cuando va a quedarse en WAITING) ni de
// `updatedAt`, que además es el ÚLTIMO cambio de estado: cuando un deployment pasa a `REMOVED`
// ese campo se pisa con la hora del reemplazo, así que ni siquiera sirve para auditar el
// pasado. Hoy `096593a` figura con `updatedAt` del 07-ago 07:27, la hora en que lo
// reemplazaron. Este harness mira solo el deployment VIGENTE, y si no tiene logs de build
// (Railway los purga) devuelve exit 2, nunca PASS.
//
// Exit 0 = el deploy esperó a su suite. Exit 1 = no esperó (o falta el token, que no se
// saltea). Exit 2 = no se pudo determinar (endpoint caído, gh/red, deployment fuera de la
// ventana consultada) — infra, sin veredicto.
//
// Usage: node qa-e2e/backend-deploy-gated.mjs   (desde app/)
// Requiere: `gh` autenticado + RAILWAY_API_TOKEN (del .env local o del entorno).

import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

import { consultarRailway, PROJECT_ID, SERVICE_ID, ENVIRONMENT_ID } from '../scripts/railway-api.mjs';

const API = process.env.NETO_API_URL || 'https://api.neto.pe';
const REPO = process.env.NETO_REPO || 'FavioML/FinBot';
const WORKFLOW = process.env.NETO_CI_WORKFLOW || 'ci.yml';
// Cuántos deployments recientes se recorren buscando el del sha que corre en prod.
const VENTANA = Number(process.env.NETO_GATE_VENTANA ?? 100);

// Colchón para desfase de reloj entre los relojes de Railway y de GitHub. Las dos poblaciones
// medidas sobre el historial real del servicio (12 deployments, 07-ago-2026) no se solapan ni
// de cerca, así que la tolerancia no es un parámetro delicado:
//
//   con gate   (b6e44e8, 0c55f6b, 89206ac, 52241cd) → el build arranca +5 a +6s DESPUÉS
//   sin gate   (a9c5bdf, 3611f9b, 9728433, 0b697e0, 87f3682, e92e2d8) → −44 a −159s
//   `096593a`  (el incidente)                        → −1068s
//
// El +5/+6s es el intervalo con que Railway mira el check suite. 15s deja 9s de aire sobre
// esa constante y atrapa hasta −15s, muy por encima del peor caso sin gate (−44s).
export const TOLERANCIA_MS = Number(process.env.NETO_GATE_TOLERANCIA_MS ?? 15_000);

// Techo del margen. Más que esto y el run que se está mirando no puede ser el del push que
// disparó este build: es un redeploy o un rollback manual, que no consulta el gate.
export const MARGEN_MAX_MS = Number(process.env.NETO_GATE_MARGEN_MAX_MS ?? 60 * 60 * 1000);

const short = (s) => (s ? s.slice(0, 7) : s);
const seg = (ms) => Math.round(ms / 1000);

// `new Date(null)` es epoch 0, no NaN, y `Number.isFinite(0)` es true. O sea que un campo
// ausente pasaba el control de legibilidad como una fecha de 1970 y salía clasificado como
// FAIL_OPEN: alarma máxima por un dato que faltaba. Lo encontró el test, no la lectura.
const instante = (v) => (typeof v === 'string' && v ? new Date(v).getTime() : NaN);

const gh = (ruta, jq) =>
  execFileSync('gh', jq ? ['api', ruta, '--jq', jq] : ['api', ruta], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

function done(code, verdict, extra = {}) {
  console.log(JSON.stringify({ verdict, ...extra }, null, 2));
  process.exitCode = code;
  return code;
}

// NO existe un `horizonteRetencion()`, y borrarlo fue el resultado de la revisión: el intento y
// el porqué quedan acá para que nadie lo reconstruya.
//
// La idea era descartar la causa benigna de "no hay run" (Actions borró el run y el deployment de
// Railway le sobrevivió) preguntando cuál es el run más viejo que TODAVÍA existe, y ablandar a
// exit 2 los builds anteriores a esa fecha. Se implementó, se midió, y el número no significaba
// lo que decía:
//
//   run más viejo de ci.yml : 2026-03-21T23:03:16Z
//   commit que CREA ci.yml  : 2026-03-21T22:50:09Z  (`48155ca`)
//
// Trece minutos. **No expiró ni un run**: el "horizonte de retención" era la fecha en que nació
// el workflow. La observación "no hay runs anteriores a X" es exactamente igual de compatible con
// "la retención los borró" que con "el workflow no existía todavía", y las dos piden lo
// CONTRARIO: un build anterior al primer run de CI es el fail-open más puro que hay, porque no
// había CI. Ablandarlo a "no se pudo determinar" es apagar la alarma justo donde más importa.
//
// Y el disparador era realista, no teórico: un workflow nuevo o renombrado —lo que el hint del
// harness hermano te manda a hacer— devuelve un horizonte de hace días. Con eso, el fail-open del
// 06-ago (`096593a`, el incidente que estos cuatro harness existen para atrapar) salía exit 2 con
// un detalle afirmando una causa falsa.
//
// Para que la retención sirva como explicación hace falta evidencia INDEPENDIENTE de que se
// borraron runs (la retención configurada del repo/org, o un run que existía y ya no está). Sin
// eso, no se ablanda nada. Si alguna vez se consigue ese dato, ojo también con que
// `total_count` viene clampeado en 40000 y la paginación corta en la página 400: sobre un repo
// grande la "última página" no trae el run más viejo, y el error cae del lado de ablandar.

/**
 * El corazón, puro a propósito: sin red, sin `gh`, sin Railway. Así se puede probar contra
 * los timestamps REALES del incidente del 06-ago en vez de contra un mock de mi propia
 * lectura del problema. Ver `tests/railway-gate-timing.test.js`.
 *
 * `ok: null` = no alcanza para decidir. Nunca se devuelve `ok: true` por falta de datos.
 */
export function evaluarGate(
  { buildEmpezoAt, runCreadoAt, runTerminadoAt, runCompletado },
  toleranciaMs = TOLERANCIA_MS,
) {
  const dep = instante(buildEmpezoAt);
  if (!Number.isFinite(dep)) {
    return { ok: null, clase: 'INDETERMINADO', detalle: 'no se pudo determinar cuándo empezó el build' };
  }

  // Sin run, la pregunta es si eso PRUEBA un fail-open, y hasta el 08-ago acá se afirmaba que
  // sí: el detalle decía "NUNCA existió un run de CI para ese commit". Eso es una afirmación
  // sobre la HISTORIA, y lo único observado es "hoy no hay un run para este sha". La diferencia
  // no es retórica: hay causas que producen lo segundo sin lo primero.
  //
  // | causa | ¿medida en este repo? |
  // |---|---|
  // | **commit intermedio de un push en lote** | **SÍ, dos casos.** GitHub crea UN run por evento de push, con `head_sha` en la PUNTA: `112734f` (mismo segundo que `89206ac`, que sí tiene run) y `373f82b` no tienen run ni check suite |
  // | retención de Actions sobre un deployment de larga vida | **el mecanismo existe, pero acá no hay una sola observación de que haya pasado.** Ver la nota donde vivía `horizonteRetencion()`: el run más viejo de `ci.yml` es 13 minutos posterior al commit que lo creó, o sea que no expiró ninguno |
  // | sha que llegó a main por PR | **NO aplica hoy**: `ci.yml` corre `on: push: branches:[main]`, así que toda punta de main tiene su run. Solo sería un problema si se quitara ese trigger |
  //
  // **Ninguna se puede separar automáticamente**, porque las tres dejan el mismo rastro. Así que
  // el veredicto sigue siendo exit 1 y lo que cambia es SOLO el texto: se reporta lo observado y
  // se nombra la causa benigna que comparte el rastro, en vez de afirmar la que no se midió.
  //
  // Y para la PREGUNTA de este harness las tres son lo mismo igual: si el sha desplegado no tiene
  // run, Railway no tuvo ningún check suite que esperar. Un commit intermedio desplegado es
  // benigno para "¿se rompió algo?", no para "¿esperó?".
  if (!runCreadoAt) {
    return {
      ok: false,
      clase: 'FAIL_OPEN_SIN_RUN',
      detalle: 'no existe HOY ningún run de CI para el sha desplegado. Puede ser que se '
        + 'desplegara sin gate, o que el sha sea un commit INTERMEDIO de un push en lote '
        + '(GitHub crea un run por push, con head_sha en la punta), o que Actions haya borrado '
        + 'el run por retención — las tres dejan el mismo rastro y ninguna se descarta desde '
        + 'acá. Para este harness las tres significan que no hubo suite que esperar',
    };
  }

  const creado = instante(runCreadoAt);
  if (!Number.isFinite(creado)) {
    return { ok: null, clase: 'INDETERMINADO', detalle: 'el run no trae hora de creación legible' };
  }
  if (dep < creado) {
    return {
      ok: false,
      clase: 'FAIL_OPEN',
      margenSeg: seg(creado - dep),
      detalle: `el build EMPEZÓ ${seg(creado - dep)}s antes de que el run de CI existiera: ` +
        'Railway no encontró ningún check suite que esperar y construyó igual',
    };
  }

  // El build ya arrancó y la suite sigue corriendo: se le adelantó, aunque el run exista.
  if (!runCompletado) {
    return {
      ok: false,
      clase: 'NO_ESPERO',
      detalle: 'el build ya arrancó y su suite todavía está corriendo',
    };
  }

  const terminado = instante(runTerminadoAt);
  if (!Number.isFinite(terminado)) {
    return { ok: null, clase: 'INDETERMINADO', detalle: 'el run no trae hora de finalización' };
  }
  if (dep < terminado - toleranciaMs) {
    return {
      ok: false,
      clase: 'NO_ESPERO',
      margenSeg: seg(terminado - dep),
      detalle: `el build arrancó ${seg(terminado - dep)}s ANTES de que su suite terminara`,
    };
  }

  // Cota superior: un margen de horas o días no es "esperó muchísimo", es que el run que se
  // está mirando no es el del push que produjo este build (redeploy manual, rollback, re-run).
  // Sin esto un rollback desde el dashboard —que NO consulta "Wait for CI"— salía PASS con
  // margen de días. No se puede afirmar que haya habido gate, así que es indeterminado.
  const margen = dep - terminado;
  if (margen > MARGEN_MAX_MS) {
    return {
      ok: null,
      clase: 'INDETERMINADO',
      margenSeg: seg(margen),
      detalle: `el build arrancó ${seg(margen)}s después de la suite, demasiado para ser el ` +
        'build de ese push: probablemente un redeploy o rollback manual, que no pasa por el gate',
    };
  }

  return { ok: true, clase: 'ESPERO', margenSeg: seg(margen) };
}

const QUERY = `query($p:String!,$s:String!,$e:String!,$n:Int!){
  deployments(first:$n, input:{projectId:$p, serviceId:$s, environmentId:$e}){
    edges { node { id status createdAt updatedAt meta } }
  }
}`;

const QUERY_LOGS = `query($id:String!){ buildLogs(deploymentId:$id, limit:5000){ timestamp } }`;

/**
 * Cuándo arrancó de verdad el build: el timestamp más viejo de los logs de build.
 *
 * NO se usa `createdAt` (Railway crea la fila apenas llega el push, y con el gate sano se
 * queda en WAITING sin construir) ni `updatedAt` (el FIN). La primera versión de este harness
 * comparaba el fin, y eso mide `duraciónBuild − duraciónSuite`: cuando el build tarda más que
 * la suite, un deploy SIN gate igual termina después y salía "esperó". Sobre el historial real
 * del servicio esa regla detectaba el 16% de los deploys sin gate. El inicio del build separa
 * las dos poblaciones sin solaparse, y es el delator que CLAUDE.md ya nombraba: "push → inicio
 * de build pasó de ~7 segundos a ~2m50s".
 */
async function inicioDelBuild(token, deploymentId) {
  const { data } = await consultarRailway({
    token, query: QUERY_LOGS, variables: { id: deploymentId }, campoEsperado: 'buildLogs',
  });
  const ts = (data || []).map((l) => new Date(l.timestamp).getTime()).filter(Number.isFinite);
  return ts.length ? new Date(Math.min(...ts)).toISOString() : null;
}

async function main() {
  const token = process.env.RAILWAY_API_TOKEN;
  // No se saltea por falta de secret: un guard que se vuelve no-op cuando falta una credencial
  // es verde por vacuidad, indistinguible de un guard que pasó. Misma regla que verify-railway-gate.
  if (!token) {
    return done(1, 'falta RAILWAY_API_TOKEN: este chequeo no puede correr', {
      hint: 'Local: va en el .env de app/ (gitignoreado). Token de cuenta en https://railway.com/account/tokens',
    });
  }

  // 1) Qué sha corre en prod, dicho por prod.
  let deployed;
  try {
    const res = await fetch(`${API}/version`, { headers: { 'Cache-Control': 'no-store' } });
    if (!res.ok) return done(2, 'no se pudo leer /version', { status: res.status });
    const body = await res.json();
    deployed = body.sha;
    if (!deployed) return done(2, '/version respondió sin sha', { body });
  } catch (e) {
    return done(2, 'fetch a /version falló', { error: String(e).split('\n')[0] });
  }

  // 2) El deployment de Railway que puso ESE sha en prod.
  const { data, errores } = await consultarRailway({
    token,
    query: QUERY,
    variables: { p: PROJECT_ID, s: SERVICE_ID, e: ENVIRONMENT_ID, n: VENTANA },
    campoEsperado: 'deployments',
  });
  if (!data) {
    return done(2, 'no se pudieron leer los deployments de Railway', {
      intentos: errores,
      hint: '¿Token vencido o sin alcance sobre el proyecto peaceful-stillness?',
    });
  }

  const nodos = (data.edges || []).map((e) => e.node);
  const dep = nodos.find((n) => n.meta?.commitHash === deployed && n.status === 'SUCCESS');
  if (!dep) {
    return done(2, `no se encontró un deployment SUCCESS para el sha que corre en prod`, {
      deployed: short(deployed),
      ventana: VENTANA,
      hint: 'Puede ser un redeploy viejo que ya salió de la ventana consultada, o que Railway ' +
        'todavía no refleje el deployment. Subir NETO_GATE_VENTANA (hoy ' + VENTANA + ') o mirar el dashboard.',
    });
  }

  // 3) Cuándo arrancó el build de ese deployment.
  const buildEmpezoAt = await inicioDelBuild(token, dep.id);
  if (!buildEmpezoAt) {
    return done(2, 'el deployment no tiene logs de build: no se puede saber cuándo arrancó', {
      deployed: short(deployed),
      deploymentId: dep.id,
      hint: 'Railway purga los logs de builds viejos. Sin ellos NO se afirma que el gate haya ' +
        'funcionado: esto es exit 2 (sin veredicto), no PASS.',
    });
  }

  // 4) El run de CI de ese sha, y de él el INTENTO ORIGINAL. Un "Re-run all jobs" reusa el
  //    mismo run id, deja `created_at` intacto y pisa `updated_at`: `cf6029b` tiene el
  //    attempt 1 terminado 18:31Z y el objeto del run diciendo 23:14Z, cinco horas después.
  //    Tomar ese `updated_at` daba un falso "NO ESPERÓ" de 5h con el gate perfectamente sano.
  //    Por eso se pide `/attempts/1`, que es inmutable, y se cae al run entero solo si no está.
  let run;
  try {
    run = JSON.parse(
      execFileSync('gh', ['api',
        `repos/${REPO}/actions/workflows/${WORKFLOW}/runs?head_sha=${deployed}&per_page=20`,
        '--jq', '[.workflow_runs[] | {id, created_at, updated_at, status, conclusion, url: .html_url, intentos: .run_attempt}] | sort_by(.created_at) | first // null',
      ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }),
    );
    if (run && run.intentos > 1) {
      try {
        const a1 = JSON.parse(gh(`repos/${REPO}/actions/runs/${run.id}/attempts/1`, '{created_at, updated_at, status, conclusion}'));
        run = { ...run, ...a1, deIntento: 1 };
      } catch { run = { ...run, deIntento: `no se pudo leer el intento 1 de ${run.intentos}` }; }
    }
  } catch (e) {
    return done(2, 'no se pudieron leer los runs de CI (gh)', {
      deployed: short(deployed),
      error: String(e?.stderr ?? e?.message ?? e).split('\n')[0],
    });
  }

  const veredicto = evaluarGate({
    buildEmpezoAt,
    runCreadoAt: run?.created_at ?? null,
    runTerminadoAt: run?.updated_at ?? null,
    runCompletado: run?.status === 'completed',
  });

  const contexto = {
    deployed: short(deployed),
    deployCreado: dep.createdAt,
    buildEmpezo: buildEmpezoAt,
    deployTerminado: dep.updatedAt,
    runCreado: run?.created_at ?? null,
    runTerminado: run?.updated_at ?? null,
    runIntentos: run?.intentos ?? null,
    runConclusion: run?.conclusion ?? null,
    run: run?.url ?? null,
    margenSeg: veredicto.margenSeg,
  };

  if (veredicto.ok === true) {
    return done(0, 'PASS', {
      ...contexto,
      lectura: `el build arrancó ${veredicto.margenSeg}s DESPUÉS de que su suite terminó: esperó`,
    });
  }
  if (veredicto.ok === null) {
    return done(2, `no se pudo determinar: ${veredicto.detalle}`, contexto);
  }

  return done(1, `EL DEPLOY NO ESPERÓ A SU SUITE (${veredicto.clase})`, {
    ...contexto,
    detalle: veredicto.detalle,
    hint: 'El toggle "Wait for CI" solo espera los check suites que EXISTEN cuando Railway ' +
      'evalúa; con GitHub degradado no encuentra ninguno y despliega. No tiene arreglo del ' +
      'lado de Railway. Correr `node qa-e2e/backend-deploy-tested.mjs` para saber si además ' +
      'lo que corre está roto, y redesplegar sobre un commit con suite verde.',
  });
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
