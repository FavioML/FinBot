// ¿El backend que corre api.neto.pe (Railway) está fresco respecto de `main`?
//
// Espejo de probe-deploy-fresh.mjs (que hace lo mismo para el webapp de Vercel),
// pero para el backend de WhatsApp en Railway. El backend en proceso valida el
// CÓDIGO local; ESTE valida que el código correcto esté REALMENTE desplegado —
// las dos mitades de "el producto funciona".
//
// El invariante NO es "deployed == HEAD de main" (frágil: un push que solo toca
// webapp/, qa-e2e/ o docs/ NO redespliega Railway por el watchPatterns de
// railway.json, así que HEAD avanza sin que el backend esté stale). El invariante
// correcto e inmune a esa config es: **¿hay algún commit en main, después del
// desplegado, que toque un archivo que Railway SÍ observa?** — o sea, cualquier
// archivo menos la lista negra de railway.json (webapp/, qa-e2e/, docs/, *.md raíz).
//
// El SHA desplegado sale de /version (RAILWAY_GIT_COMMIT_SHA, que Railway inyecta
// solo). Requiere que ese endpoint ya esté en prod: hasta entonces devuelve exit 2.
//
// Exit 0 = fresco (o deploy en vuelo). Exit 1 = STALE (cambio de backend sin
// desplegar → Railway falló en silencio o está atrasado). Exit 2 = no se pudo
// determinar (endpoint caído, gh/red, o el SHA no es ancestro de main) — infra.
//
// Usage: node qa-e2e/backend-deploy-fresh.mjs   (desde app/)
// Requiere: `gh` autenticado con acceso a FavioML/FinBot.
//
// Nota Windows: se usa process.exitCode (no process.exit) para no disparar la
// assertion de libuv al salir con el socket keep-alive de fetch aún cerrándose.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

import { leerPatrones, crearPredicado } from './lib/railway-watch.mjs';

const API = process.env.NETO_API_URL || 'https://api.neto.pe';
const REPO = process.env.NETO_REPO || 'FavioML/FinBot';
// Un push < IN_FLIGHT_MIN atrás puede estar todavía construyendo en Railway.
const IN_FLIGHT_MIN = Number(process.env.NETO_INFLIGHT_MIN ?? 10);

// La lista negra de `railway.json`, LEÍDA de `railway.json`. Un archivo dispara build de
// Railway si no cae en ninguna exclusión.
//
// Hasta el 07-ago-2026 estaba copiada acá a mano, con un test de paridad pagando el precio
// de la copia. El argumento para copiarla era que implementar el dialecto de globs a mano
// era más superficie de error silencioso que comparar las dos listas. Medido: era al revés.
// Tres mutaciones distintas pasaban las cinco pruebas en verde mientras el harness
// sub-reportaba y este archivo daba PASS sobre un backend genuinamente stale. El detalle
// de las tres, y por qué comparar proyecciones de una lista contra la otra no alcanza,
// está en `qa-e2e/lib/railway-watch.mjs`.
//
// La derivación es PEREZOSA, y eso no es estética. Hecha al importar, un `railway.json` roto
// o con una forma de glob no soportada tiraba en el import, o sea ANTES de que corriera
// cualquier `main()`: exit 1 con un stack trace y sin JSON. Los dos harness que importan de
// acá tienen `on_fail` distintos y los dos habrían mentido — el de `backend-deploy-fresh` dice
// STALE, el de `backend-deploy-tested` dice "api.neto.pe corre un commit que no pasó la suite".
// Alarma máxima con el diagnóstico equivocado, por un problema de config. La convención del
// repo es exit 2 = no se pudo determinar, y para poder devolver eso hay que llegar a `main()`.
//
// Cada uno lo maneja distinto, a propósito: acá `main()` corta temprano con exit 2, porque sin
// la lista no hay veredicto posible. `backend-deploy-tested` NO necesita la lista para su
// pregunta —solo la usa para el triage de `severidad()`, que ya tiene su try/catch— así que
// sigue contestando y pierde nada más el detalle de qué archivos llegaron sin testear.
let _patrones = null;
let _predicado = null;
let _errorDeConfig = null;
try {
  _patrones = leerPatrones();
  _predicado = crearPredicado(_patrones);
} catch (e) {
  _errorDeConfig = e;
}

/** Los patrones declarados, o `null` si `railway.json` no se pudo interpretar. */
export const WATCH_PATTERNS = _patrones;

/** El motivo, si la config no se pudo interpretar. `null` cuando está sana. */
export function errorDeConfig() {
  return _errorDeConfig ? String(_errorDeConfig.message).split('\n')[0] : null;
}

export function disparaBuildRailway(f) {
  if (_errorDeConfig) throw _errorDeConfig;
  return _predicado(f);
}

const short = (s) => (s ? s.slice(0, 7) : s);
function done(code, verdict, extra = {}) {
  console.log(JSON.stringify({ verdict, ...extra }, null, 2));
  process.exitCode = code;
  return code;
}

async function main() {
  // 0) ¿La lista de `railway.json` se pudo interpretar? Sin ella no hay veredicto posible, y
  // eso es exit 2 (infra), no exit 1 (STALE): nadie tiene que ir a mirar los logs de Railway.
  const malaConfig = errorDeConfig();
  if (malaConfig) {
    return done(2, 'no se pudo interpretar build.watchPatterns de railway.json', {
      detalle: malaConfig,
      hint: 'Sin la lista, este harness no puede decidir si un commit pendiente redespliega. ' +
        'Arreglá railway.json; `npm test` ya debería estar rojo por el test de paridad.',
    });
  }

  // 1) SHA desplegado, desde el endpoint que publica el backend.
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

  // 2) ¿Qué cambió en main desde el commit desplegado?
  let cmp;
  try {
    const raw = execFileSync(
      'gh',
      ['api', `repos/${REPO}/compare/${deployed}...main`,
        '--jq', '{status, ahead_by, truncado: ((.files|length) >= 300), files: [.files[]? | .filename, .previous_filename] | map(select(.)), newest: (.commits[-1]?.commit.committer.date)}'],
      { encoding: 'utf8' },
    );
    cmp = JSON.parse(raw);
  } catch (e) {
    return done(2, 'no se pudo comparar el SHA desplegado con main (gh)', {
      deployed: short(deployed),
      error: String(e).split('\n')[0],
      hint: '¿El SHA desplegado existe en el repo? ¿gh autenticado?',
    });
  }

  // 3) deployed debería ser ancestro de main (Railway construye desde main).
  if (cmp.status === 'behind' || cmp.status === 'diverged') {
    return done(2, `el SHA desplegado no es ancestro de main (status: ${cmp.status})`, {
      deployed: short(deployed),
      hint: '¿main fue reescrito (force-push/revert) o el deploy quedó fuera de main?',
    });
  }

  // 4) deployed == HEAD, nada pendiente.
  if (cmp.status === 'identical' || cmp.ahead_by === 0) {
    return done(0, 'PASS', { deployed: short(deployed), pending: 'ninguno (== HEAD)' });
  }

  // 5) Hay commits después del desplegado. ¿Alguno dispara build de Railway?
  const pendingBackend = (cmp.files || []).filter(disparaBuildRailway);
  if (pendingBackend.length === 0) {
    return done(0, 'PASS', {
      deployed: short(deployed),
      pending: `${cmp.ahead_by} commit(s) tras el desplegado, ninguno toca archivos que Railway observe`,
    });
  }

  // 6) Hay cambio de backend sin desplegar. ¿Deploy en vuelo o stale?
  const ageMin = cmp.newest ? Math.round((Date.now() - new Date(cmp.newest).getTime()) / 60000) : null;
  if (ageMin !== null && ageMin < IN_FLIGHT_MIN) {
    return done(0, 'PASS', {
      reason: `deploy en vuelo (commit más nuevo tiene ${ageMin} min, < ${IN_FLIGHT_MIN})`,
      deployed: short(deployed),
      pendingBackend: pendingBackend.slice(0, 5),
    });
  }

  return done(1, 'STALE: hay cambios de backend en main sin desplegar', {
    deployed: short(deployed),
    pendingBackend: pendingBackend.slice(0, 5),
    newestCommitAgeMin: ageMin,
    hint: 'Revisar el último deployment en Railway (¿build falló?). ¿watchPatterns excluyó algo que no debía?',
  });
}

// Solo corre si se lo invoca directo. Sin esto, `import`arlo desde el test de paridad
// dispararía el fetch a prod y el `gh api` como efecto secundario de leer el predicado.
/**
 * ¿Se invocó este archivo directamente, o alguien lo importó?
 *
 * `import.meta.url` es el REALPATH; `process.argv[1]` es el path tal como se tipeó. Detrás de
 * un junction o symlink no coinciden, y la comparación cruda daba `false`: `main()` no corría y
 * el proceso salía con **exit 0 y cero output**, que el canary lee como PASS. Un guard que se
 * vuelve no-op es verde por vacuidad, justo lo que `verify-railway-gate.mjs` declara
 * inaceptable. Importa acá porque este workspace usa junctions para los worktrees.
 */
export function esEntrypoint() {
  const arg = process.argv[1];
  if (!arg) return false;
  let real = null;
  try { real = realpathSync(arg); } catch { /* el path puede no existir */ }
  return [arg, real].some((p) => p && import.meta.url === pathToFileURL(p).href);
}

if (esEntrypoint()) {
  await main();
}
