// ¿El bundle que sirve app.neto.pe corresponde al HEAD de `main`?
//
// Reemplaza a probe-deploy-fetchnetouser.mjs, que buscaba un string literal en
// los chunks y se pudría en cuanto alguien tocara ese mensaje. Este compara el
// commit REAL del deployment (que la webapp publica en /api/version, vía la env
// VERCEL_GIT_COMMIT_SHA que Vercel inyecta solo) contra el HEAD de main. No hay
// texto que mantener: mientras el endpoint exista, el check no envejece.
//
// Caza un deploy de Vercel que falló en silencio o quedó atrás — riesgo real que
// hoy no cubre nadie (Better Stack mira uptime, no frescura).
//
// Exit 0 = fresco (o deploy en vuelo). Exit 1 = stale (fallo real). Exit 2 = no
// se pudo determinar (endpoint caído, gh/red) — infra, no necesariamente stale.
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
// Un push < IN_FLIGHT_MIN atrás puede estar todavía construyendo en Vercel: no es
// stale, es un deploy en vuelo. Solo alarmamos si el HEAD ya tuvo tiempo de salir.
const IN_FLIGHT_MIN = 10;

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

  // 2) HEAD de main (sha + fecha del commit), vía gh.
  let head, headDate;
  try {
    const raw = execFileSync(
      'gh',
      ['api', `repos/${REPO}/commits/main`, '--jq', '{sha: .sha, date: .commit.committer.date}'],
      { encoding: 'utf8' },
    );
    const parsed = JSON.parse(raw);
    head = parsed.sha;
    headDate = new Date(parsed.date);
  } catch (e) {
    return done(2, 'no se pudo resolver HEAD de main con gh', { error: String(e).split('\n')[0] });
  }

  // 3) Veredicto.
  if (deployed === head) {
    return done(0, 'PASS', { deployed: short(deployed), head: short(head) });
  }

  const ageMin = Math.round((Date.now() - headDate.getTime()) / 60000);
  if (ageMin < IN_FLIGHT_MIN) {
    return done(0, 'PASS', {
      reason: `deploy en vuelo (HEAD tiene ${ageMin} min, < ${IN_FLIGHT_MIN})`,
      deployed: short(deployed),
      head: short(head),
    });
  }

  return done(1, 'STALE: app.neto.pe no sirve el HEAD de main', {
    deployed: short(deployed),
    head: short(head),
    headAgeMin: ageMin,
    hint: 'Revisar el último deployment en el dashboard de Vercel (¿build falló?).',
  });
}

await main();
