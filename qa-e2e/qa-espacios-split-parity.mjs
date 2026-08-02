// Paridad de division de gastos entre la webapp y el backend de WhatsApp.
//
// Este es el caso que nadie probaba: 3 miembros con porcentajes DESIGUALES y una
// regla Pro por categoria. Con 2 miembros al 50/50 los motores coincidian de
// casualidad, y por eso la divergencia (el backend ignoraba split_rules y dividia
// siempre en partes iguales) vivio sin que ningun test la viera.
//
// Que verifica, contra PRODUCCION:
//   1. La webapp y el backend devuelven EXACTAMENTE los mismos balances.
//   2. Los balances del espacio suman cero.
//   3. Cada gasto guarda su division congelada y las partes suman el monto exacto.
//   4. Cambiar una regla NO mueve los balances de gastos ya registrados.
//   5. No se puede remover a un miembro con saldo pendiente (409); saldado, si.
//
// El balance del backend se calcula corriendo `obtenerBalanceEspacio` LOCAL contra
// la Supabase de produccion (mismo codigo que corre en Railway). `enviarWhatsapp`
// se stubea: aca se prueba la matematica, no la mensajeria, y no hay por que
// mandarle WhatsApps a nadie por una corrida de QA.
//
// Limpia todo lo que crea. El tercer miembro (NETO_QA_M3_USUARIO_ID) es un usuario
// QA permanente sin cuenta auth: nunca inicia sesion, solo existe para ser el
// tercero en el espacio.

import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clienteGuardado } from './lib/qa-guard.mjs';

const APP = 'https://app.neto.pe';
const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function parseEnv(file) {
  const out = {};
  for (const l of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

const env = parseEnv(join(homedir(), '.config', 'neto', 'qa.env'));
const backendEnv = parseEnv(join(HERE, '..', '.env'));

const PRO = env.NETO_QA_USUARIO_ID;
const FREE = env.NETO_QA_FREE_USUARIO_ID;
const M3 = env.NETO_QA_M3_USUARIO_ID;
if (!M3) {
  console.error('Falta NETO_QA_M3_USUARIO_ID en ~/.config/neto/qa.env (tercer miembro QA).');
  process.exit(1);
}

const svc = clienteGuardado(backendEnv.SUPABASE_URL, backendEnv.SUPABASE_KEY);

// --- backend local: stub de WhatsApp antes de cargar el servicio -------------
process.env.SUPABASE_URL = backendEnv.SUPABASE_URL;
process.env.SUPABASE_KEY = backendEnv.SUPABASE_KEY;
const waPath = require.resolve(join(HERE, '..', 'lib', 'whatsapp.js'));
require.cache[waPath] = {
  id: waPath,
  filename: waPath,
  loaded: true,
  exports: { enviarWhatsapp: async () => true },
};
const { registrarGastoCompartido, obtenerBalanceEspacio } = require(join(HERE, '..', 'services', 'shared-spaces'));

// --- sesiones webapp ---------------------------------------------------------
async function forge(P) {
  const SUPA = env[P + 'URL'] || env.NETO_QA_URL;
  const ANON = env[P + 'ANON'] || env.NETO_QA_ANON;
  const g = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env[P + 'EMAIL'], password: env[P + 'PASSWORD'] || env.NETO_QA_PASSWORD }),
  });
  const s = await g.json();
  const ref = new URL(SUPA).hostname.split('.')[0];
  const v = 'base64-' + Buffer.from(JSON.stringify(s), 'utf8').toString('base64url');
  const MAX = 3180, domain = new URL(APP).hostname, ck = [];
  if (v.length <= MAX) ck.push({ name: `sb-${ref}-auth-token`, value: v });
  else for (let i = 0, p = 0; p < v.length; i++, p += MAX) ck.push({ name: `sb-${ref}-auth-token.${i}`, value: v.slice(p, p + MAX) });
  return ck.map(c => ({ name: c.name, value: c.value, domain, path: '/', httpOnly: false, secure: true, sameSite: 'Lax' }));
}

const br = await chromium.launch();
async function ctxFor(P) {
  const ctx = await br.newContext();
  await ctx.addCookies(await forge(P));
  const pg = await ctx.newPage();
  await pg.goto(`${APP}/dashboard`, { waitUntil: 'domcontentloaded' });
  await pg.waitForTimeout(800);
  const api = (path, opts) => pg.evaluate(async ({ path, opts }) => {
    const r = await fetch(path, opts);
    let b = null; try { b = await r.json(); } catch {}
    return { status: r.status, body: b };
  }, { path, opts: opts || {} });
  return { ctx, api };
}

const J = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
const JP = (o) => ({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
const R = {};
const fails = [];
const check = (nombre, ok, detalle) => {
  R[nombre] = ok ? 'PASS' : `FAIL ${detalle ?? ''}`.trim();
  if (!ok) fails.push(nombre);
};
const cerca = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) < eps;

const pro = await ctxFor('NETO_QA_');
const free = await ctxFor('NETO_QA_FREE_');
let spId = null;

try {
  // ---------- 1. Espacio de 3 con porcentajes desiguales + regla Pro ----------
  const sp = await pro.api('/api/spaces', J({ name: 'QA_SPLIT_PARITY', type: 'custom' }));
  spId = sp.body?.id;
  check('crear_espacio', sp.status === 201 && !!spId, `status=${sp.status}`);

  // Gate de version. Vercel tarda mas que el `curl` que devuelve 307, asi que es
  // facil correr esto contra el build viejo: los asserts fallan en cascada y
  // parecen bugs de producto cuando en realidad el deploy no habia aterrizado.
  // El tope de monto es el marcador: si un gasto absurdo entra, el build es viejo.
  const marcador = await pro.api(`/api/spaces/${spId}/expenses`, J({ amount: 1e9, description: 'QA marcador de deploy' }));
  if (marcador.status !== 400) {
    await pro.api(`/api/spaces/${spId}`, { method: 'DELETE' });
    await br.close();
    console.error(`DEPLOY VIEJO: el tope de monto todavia no esta en produccion (POST 1e9 devolvio ${marcador.status}, se esperaba 400). Espera a que termine el deploy de Vercel y vuelve a correr. No se aserto nada; el espacio de prueba se borro.`);
    process.exit(2);
  }
  R.gate_deploy_al_dia = 'PASS';

  const det0 = await pro.api(`/api/spaces/${spId}`);
  const code = det0.body?.space?.invite_code;
  const joined = await free.api('/api/spaces/join', J({ code }));
  check('free_se_une', joined.status === 201, `status=${joined.status}`);

  // Tercer miembro: la fila que produciria un join real, insertada con service-role
  // porque este usuario QA no tiene cuenta auth (no necesita: solo existe para que
  // el espacio tenga tres).
  const { error: eM3 } = await svc.from('space_members').insert({
    space_id: spId, user_id: M3, role: 'member', split_percentage: 20,
  });
  check('tercer_miembro', !eM3, eM3?.message);

  const ds = await pro.api(`/api/spaces/${spId}/default-split`, JP({ splits: { [PRO]: 50, [FREE]: 30, [M3]: 20 } }));
  check('default_split_50_30_20', ds.status === 200, `status=${ds.status}`);

  const rule = await pro.api(`/api/spaces/${spId}/split-rules`, JP({
    rules: [{ id: 'r1', category: 'Alimentación', splits: { [PRO]: 70, [FREE]: 20, [M3]: 10 } }],
  }));
  check('regla_pro_70_20_10', rule.status === 200, `status=${rule.status}`);

  // ---------- 2. Gastos por los dos caminos ----------------------------------
  // 100.03 fuerza el reparto de centavos: 70/20/10 de 10003 no da entero.
  const e1 = await pro.api(`/api/spaces/${spId}/expenses`, J({ amount: 100.03, description: 'QA regla', category: 'Alimentación' }));
  check('gasto_webapp_con_regla', e1.status === 201, `status=${e1.status}`);
  const e2 = await free.api(`/api/spaces/${spId}/expenses`, J({ amount: 0.01, description: 'QA centavo', category: 'Transporte' }));
  check('gasto_webapp_un_centavo', e2.status === 201, `status=${e2.status}`);

  // El camino de WhatsApp. Antes ignoraba la regla y partia en tres iguales.
  const { snapshot: snapBackend } = await registrarGastoCompartido(PRO, spId, 250, 'QA backend', 'Alimentación');
  check('gasto_backend_respeta_regla',
    snapBackend?.source === 'rule' && snapBackend.shares.find(s => s.user_id === PRO)?.cents === 17500,
    JSON.stringify(snapBackend));

  // ---------- 2b. Montos que descuadrarian el grupo -------------------------
  // La columna aguanta hasta 10^10; sin tope, un miembro descuadra el balance de
  // todos. `1e999` sobrevive a JSON.parse como Infinity, y el guard viejo lo
  // dejaba pasar porque isNaN(Infinity) es false.
  // (El POST sobre el tope ya se probo arriba como gate de deploy.)
  const infinito = await pro.api(`/api/spaces/${spId}/expenses`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"amount":1e999,"description":"QA inf"}' });
  check('gasto_infinito_400', infinito.status === 400, `status=${infinito.status}`);
  const editAbsurdo = await pro.api(`/api/spaces/${spId}/expenses`, JP({ id: e1.body?.id, amount: 1e9 }));
  check('editar_sobre_el_tope_400', editAbsurdo.status === 400, `status=${editAbsurdo.status}`);
  const settleAbsurdo = await free.api(`/api/spaces/${spId}/settle`, J({ to_user: PRO, amount: 1e9 }));
  check('liquidacion_sobre_el_tope_400', settleAbsurdo.status === 400, `status=${settleAbsurdo.status}`);

  // ---------- 3. Conservacion de centavos en cada gasto ----------------------
  const { data: filas } = await svc.from('space_expenses').select('amount, split_snapshot').eq('space_id', spId);
  const conservan = (filas || []).every(f => {
    const suma = (f.split_snapshot?.shares || []).reduce((s, x) => s + x.cents, 0);
    return suma === Math.round(Number(f.amount) * 100);
  });
  check('cada_gasto_conserva_centavos', (filas || []).length === 3 && conservan, JSON.stringify(filas));

  // ---------- 4. Webapp vs backend: los mismos numeros ------------------------
  const det = await pro.api(`/api/spaces/${spId}`);
  const balWeb = det.body?.balance || {};
  const balBack = Object.fromEntries((await obtenerBalanceEspacio(spId)).balances.map(b => [b.userId, b.balance]));

  const mismos = [PRO, FREE, M3].every(uid => cerca(balWeb[uid], balBack[uid]));
  check('webapp_vs_backend_identicos', mismos, `web=${JSON.stringify(balWeb)} back=${JSON.stringify(balBack)}`);

  // Esperado: pro pago 100.03+250 y le tocaba 70.02+0.01+175 => +105.00
  //           free pago 0.01 y le tocaba 20.01+0+50        => -70.00
  //           m3   pago 0     y le tocaba 10.00+0+25       => -35.00
  check('balances_esperados',
    cerca(balWeb[PRO], 105) && cerca(balWeb[FREE], -70) && cerca(balWeb[M3], -35),
    JSON.stringify(balWeb));

  const sumaWeb = Object.values(balWeb).reduce((s, v) => s + v, 0);
  check('balances_suman_cero', cerca(sumaWeb, 0), `suma=${sumaWeb}`);

  // ---------- 5. La retroactividad murio -------------------------------------
  const antes = JSON.stringify(balWeb);
  const cambio = await pro.api(`/api/spaces/${spId}/split-rules`, JP({
    rules: [{ id: 'r1', category: 'Alimentación', splits: { [PRO]: 10, [FREE]: 10, [M3]: 80 } }],
  }));
  const det2 = await pro.api(`/api/spaces/${spId}`);
  const balDespues = det2.body?.balance || {};
  check('cambiar_regla_no_mueve_el_pasado',
    cambio.status === 200 && [PRO, FREE, M3].every(uid => cerca(balWeb[uid], balDespues[uid])),
    `antes=${antes} despues=${JSON.stringify(balDespues)}`);

  const balBack2 = Object.fromEntries((await obtenerBalanceEspacio(spId)).balances.map(b => [b.userId, b.balance]));
  check('backend_tampoco_reescribe_el_pasado',
    [PRO, FREE, M3].every(uid => cerca(balBack2[uid], balDespues[uid])),
    JSON.stringify(balBack2));

  // ---------- 6. No se sale del espacio debiendo ------------------------------
  const rmDebiendo = await pro.api(`/api/spaces/${spId}/members?userId=${M3}`, { method: 'DELETE' });
  check('remover_con_saldo_409', rmDebiendo.status === 409, `status=${rmDebiendo.status} body=${JSON.stringify(rmDebiendo.body)}`);

  // m3 paga sus 35 al pro. Se inserta con service-role porque m3 no tiene sesion;
  // es la misma fila que produciria POST /settle.
  const { error: eSettle } = await svc.from('space_settlements').insert({
    space_id: spId, from_user: M3, to_user: PRO, amount: 35, settled_at: new Date().toISOString(),
  });
  check('liquidacion_m3', !eSettle, eSettle?.message);

  const rmSaldado = await pro.api(`/api/spaces/${spId}/members?userId=${M3}`, { method: 'DELETE' });
  check('remover_saldado_200', rmSaldado.status === 200, `status=${rmSaldado.status} body=${JSON.stringify(rmSaldado.body)}`);

  // ---------- 7. Tras remover, la plata sigue cuadrando -----------------------
  const det3 = await pro.api(`/api/spaces/${spId}`);
  const balFinal = det3.body?.balance || {};
  const sumaFinal = Object.values(balFinal).reduce((s, v) => s + v, 0);
  check('ex_miembro_sigue_en_el_balance_en_cero', cerca(balFinal[M3] ?? null, 0), JSON.stringify(balFinal));
  check('balances_finales_suman_cero', cerca(sumaFinal, 0), `suma=${sumaFinal}`);
  check('acreedor_cobro_su_liquidacion', cerca(balFinal[PRO], 70), JSON.stringify(balFinal));

  const balBack3 = Object.fromEntries((await obtenerBalanceEspacio(spId)).balances.map(b => [b.userId, b.balance]));
  check('webapp_vs_backend_identicos_al_final',
    [PRO, FREE].every(uid => cerca(balFinal[uid], balBack3[uid])),
    `web=${JSON.stringify(balFinal)} back=${JSON.stringify(balBack3)}`);
} catch (e) {
  check('excepcion', false, e?.message);
} finally {
  if (spId) {
    const del = await pro.api(`/api/spaces/${spId}`, { method: 'DELETE' });
    R.cleanup = del.status;
    // Red de seguridad: si el DELETE de la API fallo, no dejar basura en prod.
    if (del.status !== 200) {
      await svc.from('space_settlements').delete().eq('space_id', spId);
      await svc.from('space_expenses').delete().eq('space_id', spId);
      await svc.from('space_members').delete().eq('space_id', spId);
      await svc.from('shared_spaces').delete().eq('id', spId);
      R.cleanup_forzado = true;
    }
  }
  await br.close();
}

R.resultado = fails.length === 0 ? 'ALL PASS' : `FALLAN ${fails.length}: ${fails.join(', ')}`;
console.log(JSON.stringify(R, null, 2));
process.exit(fails.length === 0 ? 0 : 1);
