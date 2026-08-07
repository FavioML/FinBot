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

const API = process.env.NETO_API_URL || 'https://api.neto.pe';
const REPO = process.env.NETO_REPO || 'FavioML/FinBot';
// Un push < IN_FLIGHT_MIN atrás puede estar todavía construyendo en Railway.
const IN_FLIGHT_MIN = Number(process.env.NETO_INFLIGHT_MIN ?? 10);

// La lista negra de `railway.json`, copiada acá a mano. Un archivo dispara build de
// Railway si NO cae en ninguna exclusión.
//
// Está duplicada A PROPÓSITO y no derivada en runtime: implementar el dialecto de globs
// de Railway (incluida la barra inicial de `!/*.md`, que ancla a la raíz) es más superficie
// de error silencioso que las comparaciones de abajo. El precio de la copia es que puede
// desincronizarse —alguien agrega una exclusión a railway.json, no toca esto, y el harness
// empieza a dar veredictos equivocados SIN romperse—, y ese precio lo paga
// `tests/railway-watchpatterns-paridad.test.js`, que compara las dos y falla si divergen.
// Por eso se exportan: el test necesita las dos mitades, la declarada y la implementada.
export const WATCH_PATTERNS = ['**', '!webapp/**', '!qa-e2e/**', '!docs/**', '!/*.md'];

// Las exclusiones, como DATOS y no escritas en el cuerpo de la función. No es estética:
// el test compara este objeto contra los patrones negados de railway.json COMO CONJUNTOS,
// y eso es lo único que ve una divergencia sobre una ruta que hoy no tiene ningún archivo
// versionado. Con el cuerpo escrito a mano no la veía: su otro test contrasta las dos
// implementaciones sobre el árbol real, y un directorio que todavía no existe no está en
// el árbol. Verificado por mutación el 07-ago-2026: agregar `'infra/'` de un solo lado
// pasaba las cuatro pruebas en verde.
//
// Los dos tests siguen siendo necesarios y no se solapan: éste fija QUÉ se excluye, el del
// corpus fija CÓMO (que `.md` ancle a la raíz no se ve comparando conjuntos).
export const EXCLUSIONES = {
  dirs: ['webapp/', 'qa-e2e/', 'docs/'], // de los patrones `!dir/**`
  extsRaiz: ['.md'], //                     de los patrones `!/*.ext` (solo la raíz)
};

export function disparaBuildRailway(f) {
  if (!f) return false;
  if (EXCLUSIONES.dirs.some((d) => f.startsWith(d))) return false;
  if (!f.includes('/') && EXCLUSIONES.extsRaiz.some((e) => f.endsWith(e))) return false;
  return true;
}

const short = (s) => (s ? s.slice(0, 7) : s);
function done(code, verdict, extra = {}) {
  console.log(JSON.stringify({ verdict, ...extra }, null, 2));
  process.exitCode = code;
  return code;
}

async function main() {
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
