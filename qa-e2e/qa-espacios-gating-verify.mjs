// Verifies the "host pays" espacios gating + custom-split-drives-balances + default-split endpoint.
// Asserts against PROD post-deploy. Cleans up every space it creates.
//   Part A (Free): create 1 space ok, 2nd owned space 403, split-rules 403, budgets 403,
//                  default-split 200 + persists, GET isPro=false.
//   Part B (Pro+Free member): Pro space, Free joins, custom rule 70/30 drives the real balance.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cerrar } from './lib/veredicto.mjs';
import 'dotenv/config';
import { createRequire } from 'module';
import { instalarGuard } from './lib/qa-guard.mjs';

const require = createRequire(import.meta.url);
const supabase = instalarGuard(require, '../lib/db');
const APP = 'https://app.neto.pe';
const env = {};
for (const l of readFileSync(join(homedir(), '.config', 'neto', 'qa.env'), 'utf8').split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2]; }
async function forge(P) {
  const SUPA = env[P + 'URL'] || env.NETO_QA_URL, ANON = env[P + 'ANON'] || env.NETO_QA_ANON;
  const g = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: env[P + 'EMAIL'], password: env[P + 'PASSWORD'] || env.NETO_QA_PASSWORD }) });
  const s = await g.json(); const ref = new URL(SUPA).hostname.split('.')[0];
  const v = 'base64-' + Buffer.from(JSON.stringify(s), 'utf8').toString('base64url');
  const MAX = 3180, domain = new URL(APP).hostname, ck = [];
  if (v.length <= MAX) ck.push({ name: `sb-${ref}-auth-token`, value: v }); else for (let i = 0, p = 0; p < v.length; i++, p += MAX) ck.push({ name: `sb-${ref}-auth-token.${i}`, value: v.slice(p, p + MAX) });
  return ck.map(c => ({ name: c.name, value: c.value, domain, path: '/', httpOnly: false, secure: true, sameSite: 'Lax' }));
}
const br = await chromium.launch();
async function ctxFor(P) {
  const ctx = await br.newContext(); await ctx.addCookies(await forge(P));
  const pg = await ctx.newPage(); await pg.goto(`${APP}/dashboard`, { waitUntil: 'domcontentloaded' }); await pg.waitForTimeout(800);
  const api = (path, opts) => pg.evaluate(async ({ path, opts }) => { const r = await fetch(path, opts); let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b }; }, { path, opts: opts || {} });
  return { ctx, api };
}
const J = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
const JP = (o) => ({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
const R = { A_free: {}, B_balances: {} };

// ── Precondición: el usuario "QA Free" tiene que estar DE VERDAD en el muro ──
//
// El fixture se auto-destruye y por eso hay que comprobarlo en cada corrida, no suponerlo.
// El trial arranca solo con el PRIMER GASTO, así que cualquier harness que le registre uno a
// este usuario (money-edge, por-revisar, los sweeps) le da 14 días de `plan='premium'` y deja
// de ser Free. Y como durante el trial `plan` vale `premium`, entregarle todo Pro pasa a ser
// el comportamiento CORRECTO.
//
// Medido el 09-ago-2026, la primera vez que este archivo tuvo exit code: el usuario estaba en
// `trial_estado='activo'` hasta el 18-ago y las cinco aserciones de la Parte A salían rojas.
// Ninguna era una regresión. Sin esta comprobación, este harness reporta "las features Pro
// están abiertas para el Free" —lo más alarmante que puede decir— cada vez que alguien le
// registra un gasto de prueba.
let preconFree = null;
{
  const { data: uFree } = await supabase.from('usuarios')
    .select('plan, trial_estado, trial_vence').eq('id', env.NETO_QA_FREE_USUARIO_ID).maybeSingle();
  R.preconFree = uFree || null;
  if (!uFree) {
    preconFree = 'no se pudo leer al usuario QA Free (' + env.NETO_QA_FREE_USUARIO_ID + ')';
  } else if (uFree.plan === 'premium') {
    preconFree = `el usuario "QA Free" NO está en el muro: plan=${uFree.plan}, trial_estado=${uFree.trial_estado}` +
      (uFree.trial_vence ? `, vence ${uFree.trial_vence}` : '') + '. Durante el trial `plan` vale ' +
      '`premium`, así que darle las features Pro es CORRECTO y la Parte A no puede afirmar nada. ' +
      'Alguien (probablemente otro harness) le registró un gasto y le arrancó el trial. Para volver ' +
      "a usarlo: UPDATE usuarios SET plan='free', trial_estado='vencido' WHERE id='" + env.NETO_QA_FREE_USUARIO_ID + "'";
  }
}

// ---------- Part A: Free gating ----------
{
  const { ctx, api } = await ctxFor('NETO_QA_FREE_');
  const freeUid = env.NETO_QA_FREE_USUARIO_ID;
  const created = [];
  // Desde M14 (`e29ca88`) crear un espacio es Pro en los DOS canales, así que acá se
  // espera 403 y `id1` queda undefined: las afirmaciones Pro-only de más abajo (que
  // necesitaban un espacio del Free para comprobar que 403ean) ya no son alcanzables
  // por esta vía y las cubre el `budgetStatus_expect200` de la Parte B, sobre un
  // espacio del Pro. Se deja el POST porque el 403 ES la afirmación.
  const s1 = await api('/api/spaces', J({ name: 'QA_GATE_FREE_1', type: 'custom' }));
  R.A_free.create1 = s1.status; const id1 = s1.body?.id; if (id1) created.push(id1);
  const s2 = await api('/api/spaces', J({ name: 'QA_GATE_FREE_2', type: 'custom' }));
  R.A_free.create2_expect403 = s2.status; if (s2.body?.id) created.push(s2.body.id);
  if (id1) {
    R.A_free.splitRules_expect403 = (await api(`/api/spaces/${id1}/split-rules`, JP({ rules: [{ id: 'r1', category: 'Alimentación', splits: { [freeUid]: 100 } }] }))).status;
    R.A_free.budgets_expect403 = (await api(`/api/spaces/${id1}/budgets`, JP({ budgets: [{ id: 'b1', category: 'Alimentación', limit: 200 }] }))).status;
    R.A_free.defaultSplit_expect200 = (await api(`/api/spaces/${id1}/default-split`, JP({ splits: { [freeUid]: 100 } }))).status;
    const det = await api(`/api/spaces/${id1}`);
    R.A_free.detIsPro_expectFalse = det.body?.isPro;
    R.A_free.detSplitRulesLen_expect0 = (det.body?.splitRules || []).length;
    R.A_free.ownerPct_expect100 = det.body?.members?.find(m => m.user_id === freeUid)?.split_percentage;
  }
  for (const id of created) await api(`/api/spaces/${id}`, { method: 'DELETE' });
  R.A_free.cleaned = created.length;
  await ctx.close();
}

// ---------- Part B: Pro space, Free joins, custom rule drives balance ----------
{
  const pro = await ctxFor('NETO_QA_');
  const free = await ctxFor('NETO_QA_FREE_');
  const proUid = env.NETO_QA_USUARIO_ID, freeUid = env.NETO_QA_FREE_USUARIO_ID;
  const sp = await pro.api('/api/spaces', J({ name: 'QA_GATE_PRO_BAL', type: 'custom' }));
  const spId = sp.body?.id;
  R.B_balances.proCreate = sp.status;
  try {
    const det0 = await pro.api(`/api/spaces/${spId}`);
    const code = det0.body?.space?.invite_code;
    // Free joins
    const joined = await free.api('/api/spaces/join', J({ code }));
    R.B_balances.freeJoin = joined.status;
    // Pro sets custom rule 70/30 for Alimentación
    R.B_balances.ruleStatus_expect200 = (await pro.api(`/api/spaces/${spId}/split-rules`, JP({ rules: [{ id: 'r1', category: 'Alimentación', splits: { [proUid]: 70, [freeUid]: 30 } }] }))).status;
    R.B_balances.budgetStatus_expect200 = (await pro.api(`/api/spaces/${spId}/budgets`, JP({ budgets: [{ id: 'b1', category: 'Alimentación', limit: 500 }] }))).status;
    // Two expenses paid by pro: 100 Alimentación (ruled 70/30), 100 Transporte (default 50/50)
    await pro.api(`/api/spaces/${spId}/expenses`, J({ amount: 100, description: 'QA alim', category: 'Alimentación' }));
    await pro.api(`/api/spaces/${spId}/expenses`, J({ amount: 100, description: 'QA trans', category: 'Transporte' }));
    const det = await pro.api(`/api/spaces/${spId}`);
    R.B_balances.isPro_expectTrue = det.body?.isPro;
    const bal = det.body?.balance || {};
    // Expected: Alim pro +30/free -30 ; Trans pro +50/free -50 => pro +80 / free -80
    R.B_balances.proBalance_expect80 = Math.round((bal[proUid] ?? 0) * 100) / 100;
    R.B_balances.freeBalance_expectNeg80 = Math.round((bal[freeUid] ?? 0) * 100) / 100;
    R.B_balances.ruleApplied = Math.abs((bal[proUid] ?? 0) - 80) < 0.5; // false if 50/50 (would be 100)
  } catch (e) { R.B_balances.err = String(e).split('\n')[0]; }
  if (spId) R.B_balances.cleanup = (await pro.api(`/api/spaces/${spId}`, { method: 'DELETE' })).status;
  await pro.ctx.close(); await free.ctx.close();
}

// ── Veredicto ───────────────────────────────────────────────────────────────
// Los nombres de campo YA son el contrato: `create2_expect403`, `detIsPro_expectFalse`,
// `proBalance_expect80`. Se leen como declaración en vez de reescribir las expectativas
// abajo, y eso tiene una propiedad que una lista a mano no tiene: un campo `_expect*`
// NUEVO queda asertado solo. La lista paralela se habría desincronizado al primer agregado,
// que es el mismo modo de fallo que el stub copiado de qa-cron-deudas.
//
// (No es "medir el nombre en vez del comportamiento": acá el sufijo no es una heurística
// sobre qué hace el archivo, es la expectativa que el autor escribió explícitamente.)
const fallas = [];
let medidos = 0;

const esperado = (clave) => {
  let m;
  if ((m = clave.match(/_expectNeg(\d+(?:\.\d+)?)$/))) return { hay: true, val: -Number(m[1]) };
  if ((m = clave.match(/_expect(\d+(?:\.\d+)?)$/)))    return { hay: true, val: Number(m[1]) };
  if (/_expectTrue$/.test(clave))                       return { hay: true, val: true };
  if (/_expectFalse$/.test(clave))                      return { hay: true, val: false };
  return { hay: false };
};

for (const [seccion, campos] of Object.entries(R)) {
  for (const [clave, real] of Object.entries(campos)) {
    const e = esperado(clave);
    if (!e.hay) continue;
    medidos++;
    if (real !== e.val) fallas.push(`${seccion}.${clave}: esperaba ${JSON.stringify(e.val)}, vino ${JSON.stringify(real)}`);
  }
}

// Los que no llevan el sufijo en el nombre pero sí son afirmaciones.
//
// **Esta aserción decía lo contrario hasta el 13-ago y estaba VIEJA, no rota.** Afirmaba
// *"un Free tiene que poder crear SU PRIMER espacio"*, que era cierto cuando se escribió
// y dejó de serlo con **M14** (`e29ca88`, 11-ago): la webapp concedía 1 espacio con un
// `>= 1` a mano mientras `PLAN_CONFIG.free.maxSpaces` valía **0** y WhatsApp daba 0. Al
// alinear los dos canales, el 403 pasó a ser el comportamiento CORRECTO y este harness
// empezó a reportar la decisión como regresión.
//
// Es la misma clase que B29 (`asercion-atada-a-una-decision-que-cambio`): el rojo no
// venía del código sino de una expectativa que ya no era la del producto. Se descubrió
// corriéndolo tras un cambio que no tocaba ni esta ruta ni `hasReachedLimit`.
if (R.A_free.create1 !== undefined) {
  medidos++;
  if (R.A_free.create1 !== 403) fallas.push(`A_free.create1: crear espacios es Pro (maxSpaces=0), se esperaba 403 y vino ${R.A_free.create1}`);
}
if (R.B_balances.freeJoin !== undefined) {
  medidos++;
  if (!(R.B_balances.freeJoin < 300)) fallas.push(`B_balances.freeJoin: el Free no pudo unirse al espacio del Pro, vino ${R.B_balances.freeJoin}`);
}
if (R.B_balances.ruleApplied !== undefined) {
  medidos++;
  // Sin esto, un motor que ignore split_rules y divida 50/50 daría balance 100 en vez de 80,
  // que es exactamente la divergencia que este archivo existe para vigilar.
  if (R.B_balances.ruleApplied !== true) fallas.push('B_balances.ruleApplied: la regla 70/30 por categoría NO movió los balances (¿se está dividiendo 50/50?)');
}

// Con la precondición rota, las rojas de la Parte A son ruido: se descartan y el veredicto
// pasa a inconcluso. Las de la Parte B (que NO dependen de que el Free sea free, porque
// miden el motor de reparto de un espacio del Pro) se conservan.
let inconcluso = null;
if (preconFree) {
  const antes = fallas.length;
  for (let i = fallas.length - 1; i >= 0; i--) if (fallas[i].startsWith('A_free.')) fallas.splice(i, 1);
  R.descartadasPorPrecondicion = antes - fallas.length;
  inconcluso = preconFree;
} else if (R.B_balances.err) {
  // Antivacuidad con otra forma: la parte B se cayó entera y dejaría la A verde por sí sola.
  inconcluso = 'la parte B (balances con regla por categoría) se cayó y no llegó a medir: ' + R.B_balances.err;
}

cerrar({ nombre: 'ESPACIOS-GATING', fallas, medidos, inconcluso, R });
await br.close();
