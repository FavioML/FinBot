// ¿El webapp que sirve app.neto.pe está fresco respecto de `main`?
//
// Reemplaza a probe-deploy-fetchnetouser.mjs, que buscaba un string literal en
// los chunks y se pudría en cuanto alguien tocara ese mensaje.
//
// El invariante NO es "deployed == HEAD de main". Eso sería frágil: Vercel hoy
// redespliega en cada push, pero si alguien activa un "Ignored Build Step" o
// cambia el Root Directory, un push que solo toca el backend/qa/docs dejaría
// `deployed` atrás de HEAD sin que el webapp esté desactualizado — y el check
// cantaría STALE en falso. El invariante correcto e inmune a la config de Vercel
// es: **¿hay algún commit en main, después del desplegado, que toque `webapp/`?**
// Si no lo hay, el webapp está fresco aunque HEAD haya avanzado por commits de
// backend. Lo resuelve la API `compare` de GitHub en una llamada, mirando los
// archivos del rango.
//
// El SHA desplegado sale de /api/version (VERCEL_GIT_COMMIT_SHA, que Vercel
// inyecta solo — no hay env var que configurar).
//
// Exit 0 = fresco (o deploy en vuelo). Exit 1 = STALE (cambio de webapp sin
// desplegar). Exit 2 = no se pudo determinar (endpoint caído, gh/red, o el SHA
// desplegado no es ancestro de main) — infra, no necesariamente stale.
//
// Usage: node probe-deploy-fresh.mjs
// Requiere: `gh` autenticado con acceso a FavioML/FinBot.
//
// Nota: se usa `process.exitCode` (no `process.exit()`). En Windows, salir de
// golpe mientras el socket keep-alive de fetch aún se cierra dispara una
// assertion de libuv (UV_HANDLE_CLOSING) y devuelve 127 en vez del código real.

import { execFileSync } from 'node:child_process';

const APP = process.env.NETO_APP_URL || 'https://app.neto.pe';
const REPO = process.env.NETO_REPO || 'FavioML/FinBot';
// Carpeta (dentro del repo) desde la que Vercel construye el webapp. Un commit
// que toque algo aquí y no esté desplegado = STALE.
const WEBAPP_DIR = process.env.NETO_WEBAPP_DIR || 'webapp/';
// Un push < IN_FLIGHT_MIN atrás puede estar todavía construyendo en Vercel: no es
// stale, es un deploy en vuelo. Solo alarmamos si el commit ya tuvo tiempo de salir.
const IN_FLIGHT_MIN = Number(process.env.NETO_INFLIGHT_MIN ?? 10);

const short = (s) => (s ? s.slice(0, 7) : s);
function done(code, verdict, extra = {}) {
  console.log(JSON.stringify({ verdict, ...extra }, null, 2));
  process.exitCode = code;
  return code;
}

async function main() {
  // 1) SHA desplegado, desde el endpoint que publica la webapp.
  let deployed;
  try {
    const res = await fetch(`${APP}/api/version`, { headers: { 'Cache-Control': 'no-store' } });
    if (!res.ok) return done(2, 'no se pudo leer /api/version', { status: res.status });
    const body = await res.json();
    deployed = body.sha;
    if (!deployed) {
      return done(2, '/api/version respondió sin sha', {
        hint: 'VERCEL_GIT_COMMIT_SHA vacío: ¿el deploy con el endpoint ya salió?',
        body,
      });
    }
  } catch (e) {
    return done(2, 'fetch a /api/version falló', { error: String(e).split('\n')[0] });
  }

  // 2) ¿Qué cambió en main desde el commit desplegado? (status, files, commits).
  let cmp;
  try {
    const raw = execFileSync(
      'gh',
      ['api', `repos/${REPO}/compare/${deployed}...main`,
        '--jq', '{status, ahead_by, files: [.files[]?.filename], newest: (.commits[-1]?.commit.committer.date)}'],
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

  // 3) Casos anómalos: deployed debería ser ancestro de main (Vercel construye
  //    desde main). Si no lo es, no podemos afirmar frescura — es infra.
  if (cmp.status === 'behind' || cmp.status === 'diverged') {
    return done(2, `el SHA desplegado no es ancestro de main (status: ${cmp.status})`, {
      deployed: short(deployed),
      hint: '¿main fue reescrito (force-push/revert) o el deploy quedó en un commit fuera de main?',
    });
  }

  // 4) deployed == HEAD, nada pendiente.
  if (cmp.status === 'identical' || cmp.ahead_by === 0) {
    return done(0, 'PASS', { deployed: short(deployed), pending: 'ninguno (== HEAD)' });
  }

  // 5) Hay commits después del desplegado. ¿Alguno toca el webapp?
  const pendingWebapp = (cmp.files || []).filter((f) => f && f.startsWith(WEBAPP_DIR));
  if (pendingWebapp.length === 0) {
    return done(0, 'PASS', {
      deployed: short(deployed),
      pending: `${cmp.ahead_by} commit(s) tras el desplegado, ninguno toca ${WEBAPP_DIR}`,
    });
  }

  // 6) Hay cambio de webapp sin desplegar. ¿Es un deploy en vuelo o está stale?
  const ageMin = cmp.newest ? Math.round((Date.now() - new Date(cmp.newest).getTime()) / 60000) : null;
  if (ageMin !== null && ageMin < IN_FLIGHT_MIN) {
    return done(0, 'PASS', {
      reason: `deploy en vuelo (commit más nuevo tiene ${ageMin} min, < ${IN_FLIGHT_MIN})`,
      deployed: short(deployed),
      pendingWebapp: pendingWebapp.slice(0, 5),
    });
  }

  return done(1, 'STALE: hay cambios de webapp en main sin desplegar', {
    deployed: short(deployed),
    pendingWebapp: pendingWebapp.slice(0, 5),
    newestCommitAgeMin: ageMin,
    hint: 'Revisar el último deployment en el dashboard de Vercel (¿build falló?).',
  });
}

await main();
