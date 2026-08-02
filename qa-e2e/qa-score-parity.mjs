// Paridad del Neto Score: backend (fuente de verdad que persiste `neto_scores`)
// vs webapp fresh-calc (/api/score?refresh=true).
//
// POR QUE EXISTE: el score se calcula en DOS lugares que deben dar el MISMO numero.
//   - Backend `services/neto-score.js` -> `calcularNetoScore` -> lo asienta el cron 6am.
//   - Webapp `api/score/route.ts` -> `calculateFreshScore` -> corre en usuario nuevo o
//     con ?refresh=true, y TAMBIEN persiste. Si divergen, el usuario ve un score en la
//     web tras refresh distinto del que dejo el cron. El fix del 20-jul (goals/debts/
//     budget) cerro las divergencias de formula; este harness lo ancla y ademas cubre
//     dos divergencias LATENTES de la ventana de datos:
//       A) ventana de mes: el backend consultaba el mes actual SIN cota superior
//          (`.gte(primeroDeMes)`), el webapp con `.lt(monthEnd)`. Una tx con fecha
//          futura contaba en el backend y no en el webapp (savings/budget divergen).
//       B) monto_pen nullable: el backend suma `monto_pen || monto`, el webapp solo
//          `monto_pen` -> un monto_pen null da NaN y envenena savings/budget.
//
// COMO COMPARA: llama a `calcularNetoScore` en proceso (codigo real del backend, read-
// only, NO persiste) y al endpoint desplegado con la cookie SSR forjada del QA Pro
// (codigo real del webapp). Mismo Supabase, mismo usuario. Afirma que los 6 factores +
// el total coinciden EXACTO.
//
// FASES:
//   1. Paridad sobre la data real del QA Pro (read-only). Apta para canary.
//   2. --adversarial: siembra un gasto con fecha del mes siguiente (reproduce A),
//      re-corre ambos caminos y exige que SIGAN coincidiendo. Limpia la fila sembrada
//      y re-persiste un refresh limpio. Antes del fix esta fase FALLA (divergencia);
//      despues, PASA.
//
// Correr:  node qa-e2e/qa-score-parity.mjs               (desde app/, solo Fase 1)
//          node qa-e2e/qa-score-parity.mjs --adversarial (Fase 1 + 2, siembra y limpia)
//
// Exit 0 = paridad OK. 1 = divergencia (regresion real). 2 = infra (login/red/creds).
//
// Nota Windows (igual que qa-gating-score): usar process.exitCode, no process.exit(),
// para que el cierre del socket keep-alive de fetch no devuelva 127.

import 'dotenv/config';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { instalarGuard } from './lib/qa-guard.mjs';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { calcularNetoScore } = require(path.join(appRoot, 'services/neto-score.js'));
const supabase = instalarGuard(require, path.join(appRoot, 'lib/db.js'));

const APP = process.env.NETO_APP_URL || 'https://app.neto.pe';
const ADVERSARIAL = process.argv.includes('--adversarial');

// Los 6 factores en el orden canonico del score.
const FACTORS = ['consistency', 'budget', 'savings', 'goals', 'debts', 'visibility'];

function loadEnv(p) {
  const env = {};
  try {
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) env[m[1]] = m[2];
    }
  } catch { /* archivo opcional */ }
  return env;
}

const fileEnv = loadEnv(path.join(homedir(), '.config', 'neto', 'qa.env'));
const pick = (k) => process.env[k] ?? fileEnv[k];

const QA = {
  url: pick('NETO_QA_URL'),
  anon: pick('NETO_QA_ANON'),
  email: pick('NETO_QA_EMAIL'),
  password: pick('NETO_QA_PASSWORD'),
  usuarioId: pick('NETO_QA_USUARIO_ID') || 'ded7e219-e5fd-4ff4-b5a3-3cd5cdffd172',
};

async function forgeCookie({ url, anon, email, password }) {
  const g = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anon, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!g.ok) throw new Error(`password grant ${g.status}`);
  const session = await g.json();
  const ref = new URL(url).hostname.split('.')[0];
  const cn = `sb-${ref}-auth-token`;
  const v = 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
  const MAX = 3180;
  if (v.length <= MAX) return `${cn}=${v}`;
  const parts = [];
  for (let i = 0, p = 0; p < v.length; i++, p += MAX) parts.push(`${cn}.${i}=${v.slice(p, p + MAX)}`);
  return parts.join('; ');
}

// Score por el webapp desplegado (codigo real de api/score/route.ts). ?refresh=true
// fuerza el fresh-calc y persiste. Devuelve { score, factors }.
async function webScore(cookie) {
  const r = await fetch(`${APP}/api/score?refresh=true`, { headers: { cookie } });
  const body = await r.json().catch(() => null);
  if (r.status !== 200 || !body) throw new Error(`/api/score?refresh=true -> ${r.status} ${JSON.stringify(body)}`);
  if (!body.factors) throw new Error('la respuesta no trae factors (¿el QA user dejó de ser Pro?)');
  return { score: body.score, factors: body.factors };
}

// Score por el backend en proceso (codigo real de services/neto-score.js). Read-only.
async function backendScore(usuarioId) {
  return calcularNetoScore(usuarioId); // { score, factors }
}

// Compara 6 factores + total. Devuelve { ok, diffs: [{factor, backend, web}] }.
function comparar(backend, web) {
  const diffs = [];
  for (const f of FACTORS) {
    if (Number(backend.factors[f]) !== Number(web.factors[f])) {
      diffs.push({ factor: f, backend: backend.factors[f], web: web.factors[f] });
    }
  }
  if (Number(backend.score) !== Number(web.score)) {
    diffs.push({ factor: 'TOTAL', backend: backend.score, web: web.score });
  }
  return { ok: diffs.length === 0, diffs };
}

function linea(nombre, backend, web) {
  const b = backend.factors, w = web.factors;
  const cols = FACTORS.map((f) => {
    const eq = Number(b[f]) === Number(w[f]);
    return `${f}=${b[f]}${eq ? '' : `≠${w[f]}`}`;
  });
  const totalEq = Number(backend.score) === Number(web.score);
  console.log(`  [${nombre}] backend vs web:`);
  console.log('    ' + cols.join('  '));
  console.log(`    TOTAL=${backend.score}${totalEq ? '' : `≠${web.score}`}`);
}

// Fecha 'YYYY-MM-15' del mes SIGUIENTE en hora Lima (garantiza "mes futuro": el backend
// sin cota la incluye, el webapp con `.lt(monthEnd)` la excluye).
function fechaMesSiguiente() {
  const lima = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  const y = lima.getFullYear();
  const m = lima.getMonth() + 1; // 1-12
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-15`;
}

const SEED_HASH = 'qaparity_future_expense';

async function main() {
  const out = { app: APP, usuarioId: QA.usuarioId, phases: {} };

  if (!QA.email || !QA.password || !QA.url) {
    out.verdict = 'faltan creds QA (NETO_QA_URL/EMAIL/PASSWORD)';
    console.log(JSON.stringify(out, null, 2));
    process.exitCode = 2;
    return;
  }

  let cookie;
  try {
    cookie = await forgeCookie(QA);
  } catch (e) {
    out.verdict = 'login QA falló';
    out.error = String(e).split('\n')[0];
    console.log(JSON.stringify(out, null, 2));
    process.exitCode = 2;
    return;
  }

  let anyFail = false;

  // ── FASE 1: paridad sobre data real ──────────────────────────────────────
  console.log('── FASE 1: paridad sobre la data real del QA Pro ──');
  let b1, w1;
  try {
    // Orden: web primero (persiste today's row), luego backend calc. Da igual el orden
    // mientras la data no cambie entre ambos; el QA user es estático.
    w1 = await webScore(cookie);
    b1 = await backendScore(QA.usuarioId);
  } catch (e) {
    out.verdict = 'error corriendo Fase 1';
    out.error = String(e).split('\n')[0];
    console.log(JSON.stringify(out, null, 2));
    process.exitCode = 2;
    return;
  }
  const c1 = comparar(b1, w1);
  linea('real', b1, w1);
  out.phases.real = { ok: c1.ok, diffs: c1.diffs, backend: b1, web: w1 };
  console.log(`  -> ${c1.ok ? 'PASS (idénticos)' : 'FAIL — divergen: ' + JSON.stringify(c1.diffs)}\n`);
  if (!c1.ok) anyFail = true;

  // ── FASE 2: adversarial — reproduce Divergencia A ─────────────────────────
  if (ADVERSARIAL) {
    console.log('── FASE 2: adversarial (gasto con fecha del mes siguiente) ──');
    const fecha = fechaMesSiguiente();
    let sembrada = false;
    try {
      // Limpieza defensiva de corridas previas abortadas.
      await supabase.from('transacciones').delete()
        .eq('usuario_id', QA.usuarioId).eq('dedup_hash', SEED_HASH);

      const { error: eIns } = await supabase.from('transacciones').insert({
        usuario_id: QA.usuarioId,
        tipo: 'gasto',
        monto: 99999,
        monto_pen: 99999,
        fecha,
        categoria: 'Otros', // sin presupuesto -> aísla la divergencia en savings
        comercio: 'QA PARITY FUTURE',
        dedup_hash: SEED_HASH,
      });
      if (eIns) throw new Error('insert seed: ' + eIns.message);
      sembrada = true;
      console.log(`  sembrado: gasto S/99999 fecha ${fecha} (mes siguiente), categoría Otros`);

      const w2 = await webScore(cookie);
      const b2 = await backendScore(QA.usuarioId);
      const c2 = comparar(b2, w2);
      linea('adversarial', b2, w2);
      out.phases.adversarial = { ok: c2.ok, seedFecha: fecha, diffs: c2.diffs, backend: b2, web: w2 };
      if (c2.ok) {
        console.log('  -> PASS: ambos caminos tratan la tx futura IGUAL (mes acotado en los dos).\n');
      } else {
        anyFail = true;
        console.log('  -> FAIL: la tx futura mueve un camino y no el otro. Divergencia A viva:');
        console.log('     ' + JSON.stringify(c2.diffs) + '\n');
      }
    } catch (e) {
      anyFail = true;
      out.phases.adversarial = { ok: false, error: String(e).split('\n')[0] };
      console.log('  -> ERROR en fase adversarial: ' + String(e).split('\n')[0] + '\n');
    } finally {
      if (sembrada) {
        await supabase.from('transacciones').delete()
          .eq('usuario_id', QA.usuarioId).eq('dedup_hash', SEED_HASH);
        console.log('  limpieza: fila sembrada borrada.');
        // Re-persistir un refresh limpio para que la fila de neto_scores del día
        // vuelva al valor correcto (el refresh adversarial la había pisado).
        try { await webScore(cookie); console.log('  restore: refresh limpio re-persistido.\n'); }
        catch { console.log('  restore: no se pudo re-persistir (el cron lo corrige a las 6am).\n'); }
      }
    }
  }

  out.verdict = anyFail ? 'DIVERGENCIA' : 'PARIDAD OK';
  console.log('==> ' + out.verdict);
  process.exitCode = anyFail ? 1 : 0;
}

await main();
