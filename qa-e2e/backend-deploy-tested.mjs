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
// Exit 0 = el commit desplegado tuvo su CI verde. Exit 1 = no la tuvo (nunca corrió, falló,
// se canceló, o sigue corriendo) o el guard quedó ciego. Exit 2 = no se pudo determinar
// (endpoint caído, gh/red) — infra, sin veredicto.
//
// Usage: node qa-e2e/backend-deploy-tested.mjs   (desde app/)
// Requiere: `gh` autenticado con acceso a FavioML/FinBot.
//
// Nota Windows: process.exitCode y no process.exit, igual que el harness hermano.

import { execFileSync } from 'node:child_process';

import { disparaBuildRailway } from './backend-deploy-fresh.mjs';

const API = process.env.NETO_API_URL || 'https://api.neto.pe';
const REPO = process.env.NETO_REPO || 'FavioML/FinBot';
// El archivo, no el `name:` del workflow: renombrar el display no debería cambiar a qué
// mira el guard. Si el ARCHIVO se renombra, esto da 404 y abajo eso es exit 1, no exit 0.
const WORKFLOW = process.env.NETO_CI_WORKFLOW || 'ci.yml';
// Cuántos runs verdes recientes se recorren buscando el ancestro verde más nuevo. Solo
// alimenta el diagnóstico de severidad; no cambia el veredicto.
const MAX_ANCESTROS = 5;

const short = (s) => (s ? s.slice(0, 7) : s);

// `gh` escribe el motivo real ("Not Found (HTTP 404)") en STDERR; el `message` de la
// excepción solo trae "Command failed: gh api ...". Mirar únicamente el message hacía que
// la rama de guard-ciego de abajo no se alcanzara nunca y un 404 saliera como exit 2
// (infra). Lo encontró la prueba por mutación, no la lectura del código.
const detalleError = (e) => [e?.stderr, e?.message].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

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
 * Qué cambió entre el último commit con CI verde y el desplegado, y cuánto de eso es
 * runtime del backend. Es la diferencia entre "anotalo" y "arreglalo ahora": el 06-ago el
 * deploy sin gate no tuvo consecuencia porque entre el último commit testeado y ese no
 * cambió un solo archivo que Railway observe. Solo corre cuando ya hay veredicto malo.
 */
function severidad(deployed) {
  try {
    const verdes = JSON.parse(
      gh(
        `repos/${REPO}/actions/workflows/${WORKFLOW}/runs?status=success&per_page=${MAX_ANCESTROS * 4}`,
        '[.workflow_runs[] | .head_sha]',
      ),
    );

    let intentos = 0;
    for (const verde of verdes) {
      if (verde === deployed || intentos >= MAX_ANCESTROS) continue;
      intentos++;
      let cmp;
      try {
        cmp = JSON.parse(
          gh(`repos/${REPO}/compare/${verde}...${deployed}`, '{status, files: [.files[]?.filename]}'),
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
    return { lectura: 'no se encontró un commit verde reciente que sea ancestro del desplegado' };
  } catch (e) {
    return { error: String(e).split('\n')[0] };
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
    if (/404|Not Found/i.test(err)) {
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

  if (ultimo.conclusion !== 'success') {
    return done(1, `EL COMMIT DESPLEGADO NO PASÓ LA SUITE (${ultimo.conclusion})`, {
      deployed: short(deployed),
      conclusion: ultimo.conclusion,
      run: ultimo.url,
      ...severidad(deployed),
      hint: 'api.neto.pe corre código cuya suite no salió verde. Arreglar la suite y ' +
        'redesplegar sobre un commit verde.',
    });
  }

  return done(0, 'PASS', {
    deployed: short(deployed),
    conclusion: ultimo.conclusion,
    run: ultimo.url,
    corridas: runs.length,
  });
}

await main();
