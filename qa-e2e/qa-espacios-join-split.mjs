// Que le pasa al reparto de los que YA estaban cuando entra alguien, contra PRODUCCION.
//
// El caso que ningun harness cubria: un espacio con reparto DESIGUAL al que se
// suma un tercero. Los dos caminos de join lo rompian distinto (el backend
// reescribia a todos a 100/n, la webapp metia al nuevo con un 50 fijo), y con dos
// miembros al 50/50 (el unico espacio que se probaba) los dos parecian correctos.
//
// Que verifica:
//   1. Join real por la API de la webapp sobre un espacio 80/40: a los que ya
//      estaban NO se les toca el peso, y el que entra toma el promedio (60).
//      Se usa 80/40 y no 70/30 a proposito: en un 70/30 el promedio da 50, o sea
//      exactamente el valor que la webapp hardcodeaba antes, y el check no
//      distinguiria el codigo nuevo del viejo.
//   2. Los % efectivos quedan 44.4/22.2/33.3 y la proporcion 80:40 sobrevive.
//   3. Un gasto registrado despues se divide con ese reparto, no en partes iguales.
//   4. El camino de WhatsApp (`unirseEspacio`) deja EXACTAMENTE el mismo estado
//      que el camino de la webapp sobre el mismo espacio de partida.
//   5. Un espacio sin personalizar (50/50) sigue quedando en partes iguales.
//
// El backend corre LOCAL contra la Supabase de produccion (mismo codigo que
// Railway). `enviarWhatsapp` se stubea: aca se prueba el reparto, no la
// mensajeria, y no hay por que mandarle WhatsApps a nadie por una corrida de QA.
//
// Limpia todo lo que crea.

import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
if (!M3 || !FREE || !PRO) {
  console.error('Faltan NETO_QA_USUARIO_ID / NETO_QA_FREE_USUARIO_ID / NETO_QA_M3_USUARIO_ID en ~/.config/neto/qa.env');
  process.exit(1);
}

const svc = createClient(backendEnv.SUPABASE_URL, backendEnv.SUPABASE_KEY);

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
const { unirseEspacio, registrarGastoCompartido } = require(join(HERE, '..', 'services', 'shared-spaces'));
const { effectiveSplitPercents, shareCents } = require(join(HERE, '..', 'services', 'spaces-split'));

// --- sesion webapp del usuario que se une ------------------------------------
async function forge() {
  const SUPA = env.NETO_QA_URL, ANON = env.NETO_QA_ANON;
  const g = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env.NETO_QA_EMAIL, password: env.NETO_QA_PASSWORD }),
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
const ctx = await br.newContext();
await ctx.addCookies(await forge());
const pg = await ctx.newPage();
await pg.goto(`${APP}/dashboard`, { waitUntil: 'domcontentloaded' });
await pg.waitForTimeout(800);
const api = (path, opts) => pg.evaluate(async ({ path, opts }) => {
  const r = await fetch(path, opts);
  let b = null; try { b = await r.json(); } catch {}
  return { status: r.status, body: b };
}, { path, opts: opts || {} });

const J = (o) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });

const R = {};
const fails = [];
const check = (nombre, ok, detalle) => {
  R[nombre] = ok ? 'PASS' : `FAIL ${detalle ?? ''}`.trim();
  if (!ok) fails.push(nombre);
};

const creados = [];
const code = () => 'QA' + Math.random().toString(36).slice(2, 8).toUpperCase();

/** Espacio de partida: lo posee M3 (sin auth) para que el usuario QA pueda unirse de verdad. */
async function crearEspacio(nombre, pesos) {
  const invite = code();
  const { data: sp, error } = await svc.from('shared_spaces').insert({
    name: nombre, type: 'custom', invite_code: invite, created_by: M3,
  }).select().single();
  if (error) throw error;
  creados.push(sp.id);

  const filas = Object.entries(pesos).map(([user_id, split_percentage], i) => ({
    space_id: sp.id, user_id, split_percentage, role: i === 0 ? 'owner' : 'member',
  }));
  const { error: eM } = await svc.from('space_members').insert(filas);
  if (eM) throw eM;
  return { ...sp, invite_code: invite };
}

const miembros = async (spaceId) => {
  const { data } = await svc.from('space_members')
    .select('user_id, split_percentage').eq('space_id', spaceId).order('user_id');
  return data || [];
};
const pesoDe = (ms, uid) => Number(ms.find(m => m.user_id === uid)?.split_percentage);

try {
  // ---------------------------------------------------------------- 1. webapp
  const sp = await crearEspacio('QA join 80/40 web', { [M3]: 80, [FREE]: 40 });
  const antes = await miembros(sp.id);

  const res = await api('/api/spaces/join', J({ code: sp.invite_code }));
  check('join webapp responde 201', res.status === 201, `status ${res.status} ${JSON.stringify(res.body)}`);

  const despues = await miembros(sp.id);
  check('el espacio quedo con 3 miembros', despues.length === 3, `${despues.length}`);
  check('al owner NO se le toco el peso (80)', pesoDe(despues, M3) === 80, `${pesoDe(despues, M3)}`);
  check('al otro miembro NO se le toco el peso (40)', pesoDe(despues, FREE) === 40, `${pesoDe(despues, FREE)}`);
  check('el que entra toma el promedio (60), no el 50 fijo de antes', pesoDe(despues, PRO) === 60, `${pesoDe(despues, PRO)}`);
  check('los pesos previos son identicos', JSON.stringify(antes) === JSON.stringify(
    despues.filter(m => m.user_id !== PRO)
  ), JSON.stringify(despues));

  const pct = effectiveSplitPercents(despues);
  check('% efectivos = 44.4 / 22.2 / 33.3',
    pct[M3] === 44.4 && pct[FREE] === 22.2 && pct[PRO] === 33.3, JSON.stringify(pct));
  // Invariante de la regla: con el peso promedio, el que entra siempre toma
  // exactamente 1/(n+1). Ni mas (no diluye de mas a los que estaban) ni menos.
  check('el que entra toma exactamente un tercio', pct[PRO] === 33.3, JSON.stringify(pct));
  check('NO se re-repartio a partes iguales', pct[M3] !== 33.3, JSON.stringify(pct));

  // La proporcion pactada entre los dos originales sobrevive al join.
  check('la proporcion 80:40 se conserva', Math.abs(pct[M3] / pct[FREE] - 80 / 40) < 0.01,
    `${pct[M3]}/${pct[FREE]}`);

  // ------------------------------------------- 2. un gasto real usa ese reparto
  const gasto = await api(`/api/spaces/${sp.id}/expenses`, J({ amount: 300, description: 'QA join split' }));
  check('gasto de S/300 registrado', gasto.status === 201, `status ${gasto.status}`);
  const snap = gasto.body?.split_snapshot;
  const partes = {
    m3: shareCents(snap, M3) / 100,
    free: shareCents(snap, FREE) / 100,
    pro: shareCents(snap, PRO) / 100,
  };
  check('el gasto se dividio 133.33 / 66.67 / 100.00',
    partes.m3 === 133.33 && partes.free === 66.67 && partes.pro === 100, JSON.stringify(partes));
  check('las partes suman el monto exacto',
    partes.m3 + partes.free + partes.pro === 300, JSON.stringify(partes));

  // --------------------------------------------- 3. paridad con el camino WhatsApp
  const sp2 = await crearEspacio('QA join 80/40 wa', { [M3]: 80, [FREE]: 40 });
  const r2 = await unirseEspacio(PRO, sp2.invite_code);
  check('join WhatsApp entro al espacio', !!r2 && r2.alreadyMember === false, JSON.stringify(r2?.alreadyMember));

  const despuesWa = await miembros(sp2.id);
  const norm = (ms) => ms.map(m => [m.user_id, Number(m.split_percentage)]).sort();
  check('WhatsApp y webapp dejan EXACTAMENTE el mismo reparto',
    JSON.stringify(norm(despuesWa)) === JSON.stringify(norm(despues)),
    `wa=${JSON.stringify(norm(despuesWa))} web=${JSON.stringify(norm(despues))}`);

  // Y un gasto por WhatsApp cae en la misma division que el de la webapp.
  const { snapshot: snapWa } = await registrarGastoCompartido(PRO, sp2.id, 300, 'QA join split wa');
  check('gasto por WhatsApp da la misma division',
    shareCents(snapWa, M3) === 13333 && shareCents(snapWa, FREE) === 6667 && shareCents(snapWa, PRO) === 10000,
    JSON.stringify(snapWa?.shares));

  // ------------------------------------- 4. espacio sin personalizar: equitativo
  const sp3 = await crearEspacio('QA join 50/50', { [M3]: 50, [FREE]: 50 });
  const r3 = await api('/api/spaces/join', J({ code: sp3.invite_code }));
  check('join en espacio sin personalizar responde 201', r3.status === 201, `status ${r3.status}`);
  const pct3 = effectiveSplitPercents(await miembros(sp3.id));
  check('50/50 + uno = tercios exactos',
    pct3[M3] === 33.3 && pct3[FREE] === 33.3 && pct3[PRO] === 33.3, JSON.stringify(pct3));
} catch (e) {
  check('corrida sin excepciones', false, e.message);
} finally {
  for (const id of creados) {
    await svc.from('space_expenses').delete().eq('space_id', id);
    await svc.from('space_settlements').delete().eq('space_id', id);
    await svc.from('space_members').delete().eq('space_id', id);
    await svc.from('shared_spaces').delete().eq('id', id);
  }
  await br.close();
}

console.log(JSON.stringify(R, null, 2));
console.log(fails.length ? `\nFAIL (${fails.length}): ${fails.join(', ')}` : '\nOK — todos los checks pasaron');
process.exit(fails.length ? 1 : 0);
