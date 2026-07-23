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

const API = process.env.NETO_API_URL || 'https://api.neto.pe';
const REPO = process.env.NETO_REPO || 'FavioML/FinBot';
// Un push < IN_FLIGHT_MIN atrás puede estar todavía construyendo en Railway.
const IN_FLIGHT_MIN = Number(process.env.NETO_INFLIGHT_MIN ?? 10);

// Lista negra de railway.json: ["**", "!webapp/**", "!qa-e2e/**", "!docs/**", "!/*.md"].
// Un archivo dispara build de Railway si NO cae en ninguna exclusión.
function disparaBuildRailway(f) {
  if (!f) return false;
  if (f.startsWith('webapp/')) return false;
  if (f.startsWith('qa-e2e/')) return false;
  if (f.startsWith('docs/')) return false;
  if (!f.includes('/') && f.endsWith('.md')) return false; // *.md de la raíz
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

await main();
