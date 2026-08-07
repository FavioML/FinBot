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
// LO QUE MIRA. El delator ya estaba escrito en CLAUDE.md sin automatizar: "push → inicio de
// build pasó de ~7 segundos a ~2m50s". Con el gate sano el deploy TERMINA después de que la
// suite termina; sin gate, termina antes de que la suite exista siquiera. Son dos timestamps
// que ya publican las dos APIs.
//
// GOTCHA que define el diseño: `deployment.updatedAt` de Railway es el ÚLTIMO cambio de
// estado, no el fin del deploy. Cuando un deployment pasa a `REMOVED` (reemplazado por el
// siguiente) ese campo se pisa con la hora del reemplazo. O sea que solo es confiable para el
// deployment VIGENTE, que es justo el que este harness mira. No sirve para auditar el pasado:
// hoy `096593a` figura con `updatedAt` del 07-ago 07:27, la hora en que lo reemplazaron, y un
// barrido histórico lo daría por bueno.
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

import { consultarRailway, PROJECT_ID, SERVICE_ID, ENVIRONMENT_ID } from '../scripts/railway-api.mjs';

const API = process.env.NETO_API_URL || 'https://api.neto.pe';
const REPO = process.env.NETO_REPO || 'FavioML/FinBot';
const WORKFLOW = process.env.NETO_CI_WORKFLOW || 'ci.yml';
// Cuántos deployments recientes se recorren buscando el del sha que corre en prod.
const VENTANA = 30;

// Colchón para desfase de reloj entre Railway y GitHub. El margen real medido en un deploy
// gateado sano (`89206ac`, 07-ago) fue de +38.7s —el deploy terminó DESPUÉS que la suite—, y
// en el fail-open de `096593a` el deploy terminó 126 segundos ANTES de que el run existiera.
// Con 30s no se toca ninguno de los dos casos reales. Subirla por encima de ~38s empezaría a
// tragarse bypasses cortos, y hay un test que lo impide.
export const TOLERANCIA_MS = Number(process.env.NETO_GATE_TOLERANCIA_MS ?? 30_000);

const short = (s) => (s ? s.slice(0, 7) : s);
const seg = (ms) => Math.round(ms / 1000);

// `new Date(null)` es epoch 0, no NaN, y `Number.isFinite(0)` es true. O sea que un campo
// ausente pasaba el control de legibilidad como una fecha de 1970 y salía clasificado como
// FAIL_OPEN: alarma máxima por un dato que faltaba. Lo encontró el test, no la lectura.
const instante = (v) => (typeof v === 'string' && v ? new Date(v).getTime() : NaN);

function done(code, verdict, extra = {}) {
  console.log(JSON.stringify({ verdict, ...extra }, null, 2));
  process.exitCode = code;
  return code;
}

/**
 * El corazón, puro a propósito: sin red, sin `gh`, sin Railway. Así se puede probar contra
 * los timestamps REALES del incidente del 06-ago en vez de contra un mock de mi propia
 * lectura del problema. Ver `tests/railway-gate-timing.test.js`.
 *
 * `ok: null` = no alcanza para decidir. Nunca se devuelve `ok: true` por falta de datos.
 */
export function evaluarGate(
  { deployTerminadoAt, runCreadoAt, runTerminadoAt, runCompletado },
  toleranciaMs = TOLERANCIA_MS,
) {
  const dep = instante(deployTerminadoAt);
  if (!Number.isFinite(dep)) {
    return { ok: null, clase: 'INDETERMINADO', detalle: 'el deployment no trae un timestamp legible' };
  }

  // Sin run no hay nada que Railway pudiera haber esperado. Es el fail-open en su forma pura.
  if (!runCreadoAt) {
    return {
      ok: false,
      clase: 'FAIL_OPEN_SIN_RUN',
      detalle: 'se desplegó y NUNCA existió un run de CI para ese commit',
    };
  }

  const creado = instante(runCreadoAt);
  if (Number.isFinite(creado) && dep < creado) {
    return {
      ok: false,
      clase: 'FAIL_OPEN',
      margenSeg: seg(creado - dep),
      detalle: `el deploy TERMINÓ ${seg(creado - dep)}s antes de que el run de CI existiera: ` +
        'Railway no encontró ningún check suite que esperar y desplegó igual',
    };
  }

  // El deploy ya terminó y la suite sigue corriendo: se le adelantó, aunque el run exista.
  if (!runCompletado) {
    return {
      ok: false,
      clase: 'NO_ESPERO',
      detalle: 'el deploy ya terminó y su suite todavía está corriendo',
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
      detalle: `el deploy terminó ${seg(terminado - dep)}s ANTES que su suite`,
    };
  }

  return { ok: true, clase: 'ESPERO', margenSeg: seg(dep - terminado) };
}

const QUERY = `query($p:String!,$s:String!,$e:String!,$n:Int!){
  deployments(first:$n, input:{projectId:$p, serviceId:$s, environmentId:$e}){
    edges { node { id status createdAt updatedAt meta } }
  }
}`;

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
        'todavía no refleje el deployment. Subir NETO_GATE_VENTANA o mirar el dashboard.',
    });
  }

  // 3) El run de CI de ese sha. Se usa el MÁS VIEJO y no el más nuevo, al revés que
  //    backend-deploy-tested: aquel quiere el último veredicto, éste quiere el run original
  //    del push. Un re-run posterior movería la hora de finalización hacia adelante y haría
  //    parecer que el deploy se le adelantó cuando en realidad lo esperó.
  let run;
  try {
    run = JSON.parse(
      execFileSync('gh', ['api',
        `repos/${REPO}/actions/workflows/${WORKFLOW}/runs?head_sha=${deployed}&per_page=20`,
        '--jq', '[.workflow_runs[] | {created_at, updated_at, status, conclusion, url: .html_url}] | sort_by(.created_at) | first // null',
      ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }),
    );
  } catch (e) {
    return done(2, 'no se pudieron leer los runs de CI (gh)', {
      deployed: short(deployed),
      error: String(e?.stderr ?? e?.message ?? e).split('\n')[0],
    });
  }

  const veredicto = evaluarGate({
    deployTerminadoAt: dep.updatedAt,
    runCreadoAt: run?.created_at ?? null,
    runTerminadoAt: run?.updated_at ?? null,
    runCompletado: run?.status === 'completed',
  });

  const contexto = {
    deployed: short(deployed),
    deployCreado: dep.createdAt,
    deployTerminado: dep.updatedAt,
    runCreado: run?.created_at ?? null,
    runTerminado: run?.updated_at ?? null,
    runConclusion: run?.conclusion ?? null,
    run: run?.url ?? null,
    margenSeg: veredicto.margenSeg,
  };

  if (veredicto.ok === true) {
    return done(0, 'PASS', {
      ...contexto,
      lectura: `el deploy terminó ${veredicto.margenSeg}s DESPUÉS que su suite: esperó`,
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
