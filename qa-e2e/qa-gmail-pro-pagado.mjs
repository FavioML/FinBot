// E2E del gate de Gmail: solo un Pro PAGADO puede consumir un cupo de OAuth.
//
// Cada conexión de Gmail consume uno de los 100 cupos de Google que tenemos hasta la
// certificación CASA. Durante el trial `plan` vale 'premium' (migración 052), así que los
// gates viejos (`plan !== 'premium'`, `maxGmailAccounts === 0`) dejaban conectar al que
// prueba: 14 días quemaban un cupo permanente.
//
// Por qué un harness y no solo unit tests: el gate vive en TRES capas que se llaman entre sí
// (webapp Next → backend Express → predicado), y cada una podía tener su propia idea de qué
// es "Pro". Los unit tests prueban cada capa con la otra mockeada; esto prueba la cadena real
// contra app.neto.pe y api.neto.pe con una sesión de verdad.
//
// El caso que importa es el del MEDIO: free y pagado se comportaban bien incluso con el gate
// viejo. Solo el trial distingue el gate correcto del incorrecto.
//
// Usa el usuario QA free, lo mueve por los tres estados y lo restaura al final (mismo
// mecanismo que qa-trial-integridad.mjs).
//
// Correr:  node qa-e2e/qa-gmail-pro-pagado.mjs   (desde app/)  → exit 0 si pasa.

import 'dotenv/config';
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { instalarGuard } from './lib/qa-guard.mjs';

const require = createRequire(import.meta.url);
const supabase = instalarGuard(require, '../lib/db');
const { hoyPeru, sumarDias } = require('../lib/dates');

const APP = process.env.QA_WEBAPP_URL || 'https://app.neto.pe';

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond, detail });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
  return !!cond;
};

function loadEnv(path) {
  const env = {};
  try {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* sin creds los checks de webapp se saltan */ }
  return env;
}
const qaEnv = loadEnv(join(homedir(), '.config', 'neto', 'qa.env'));

async function loginQA(prefijo) {
  const SUPA = qaEnv.NETO_QA_URL, ANON = qaEnv.NETO_QA_ANON;
  const email = qaEnv[prefijo + 'EMAIL'], password = qaEnv[prefijo + 'PASSWORD'];
  if (!SUPA || !ANON || !email || !password) return null;
  const grant = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!grant.ok) throw new Error('password grant falló: ' + grant.status);
  const value = 'base64-' + Buffer.from(JSON.stringify(await grant.json()), 'utf8').toString('base64url');
  const name = `sb-${new URL(SUPA).hostname.split('.')[0]}-auth-token`;
  const MAX = 3180;
  if (value.length <= MAX) return `${name}=${value}`;
  const pairs = [];
  for (let i = 0, p = 0; p < value.length; i++, p += MAX) pairs.push(`${name}.${i}=${value.slice(p, p + MAX)}`);
  return pairs.join('; ');
}

const leer = async (id) => (await supabase.from('usuarios').select('*').eq('id', id).maybeSingle()).data;

async function pedirEnlace(cookie) {
  const r = await fetch(`${APP}/api/pro/gmail-auth-url`, { headers: { Cookie: cookie }, redirect: 'manual' });
  let body = {};
  try { body = await r.json(); } catch { /* respuesta no-JSON */ }
  return { status: r.status, body };
}

async function run() {
  const cookie = await loginQA('NETO_QA_FREE_');
  const qaId = qaEnv.NETO_QA_FREE_USUARIO_ID;
  if (!cookie || !qaId) {
    check('creds QA presentes', false, 'faltan NETO_QA_FREE_* en ~/.config/neto/qa.env');
    return;
  }

  const antes = await leer(qaId);
  const estadoOriginal = {
    plan: antes.plan, trial_estado: antes.trial_estado,
    trial_vence: antes.trial_vence, premium_vence: antes.premium_vence,
  };

  try {
    // ── 1. En el muro ────────────────────────────────────────────────────────
    await supabase.from('usuarios').update({
      plan: 'free', trial_estado: 'vencido', trial_vence: sumarDias(hoyPeru(), -3), premium_vence: null,
    }).eq('id', qaId);
    const muro = await pedirEnlace(cookie);
    check('en el muro NO se entrega enlace de OAuth', muro.status === 403, 'status=' + muro.status);
    check('...y se nombra el motivo, no un error genérico',
      muro.body.motivo === 'pro_pagado_requerido', 'motivo=' + muro.body.motivo);

    // ── 2. EN TRIAL — el caso que motivó todo ────────────────────────────────
    // `plan` vale 'premium' acá. Un gate escrito como `plan === 'premium'` (o `isPremium`)
    // devuelve 200 y le quema un cupo a alguien que todavía no pagó un sol.
    await supabase.from('usuarios').update({
      plan: 'premium', trial_estado: 'activo', trial_vence: sumarDias(hoyPeru(), 9), premium_vence: null,
    }).eq('id', qaId);
    const enTrial = await pedirEnlace(cookie);
    check('EN TRIAL no se entrega enlace, aunque plan valga premium',
      enTrial.status === 403, 'status=' + enTrial.status);
    check('...y no se filtra ninguna URL de OAuth en el cuerpo',
      !JSON.stringify(enTrial.body).includes('accounts.google.com'),
      'body=' + JSON.stringify(enTrial.body).slice(0, 90));

    // ── 3. Pro PAGADO ────────────────────────────────────────────────────────
    // Sin este caso, un gate que niegue SIEMPRE se vería idéntico a uno correcto: los dos
    // checks de arriba pasarían con la ruta rota o el backend caído.
    await supabase.from('usuarios').update({
      plan: 'premium', trial_estado: 'convertido', premium_vence: sumarDias(hoyPeru(), 20),
    }).eq('id', qaId);
    const pagado = await pedirEnlace(cookie);
    check('el Pro PAGADO sí recibe su enlace', pagado.status === 200, 'status=' + pagado.status);
    check('...y es una URL de OAuth de Google de verdad',
      typeof pagado.body.url === 'string' && pagado.body.url.includes('accounts.google.com'),
      'url=' + String(pagado.body.url).slice(0, 60));
    check('...con el scope de solo lectura de Gmail',
      String(pagado.body.url).includes('gmail.readonly'),
      'scope presente=' + String(pagado.body.url).includes('gmail.readonly'));
  } finally {
    await supabase.from('usuarios').update(estadoOriginal).eq('id', qaId);
  }

  const restaurado = await leer(qaId);
  check('el usuario QA quedó como estaba',
    restaurado.plan === estadoOriginal.plan && restaurado.trial_estado === estadoOriginal.trial_estado,
    'plan=' + restaurado.plan + ' estado=' + restaurado.trial_estado);

  // ── 4. Ningún cupo vivo de un no-pagador ─────────────────────────────────
  // El invariante que el barrido (checkGmailHuerfanos) sostiene. Se mira la realidad, no
  // el código: si alguien baja un plan por SQL a mano, esto lo ve.
  const { data: cuentas } = await supabase.from('gmail_cuentas')
    .select('usuario_id, usuarios!inner(plan, trial_estado)').eq('activa', true);
  const colgados = (cuentas || []).filter(
    (c) => !(c.usuarios.plan === 'premium' && c.usuarios.trial_estado !== 'activo'));
  check('ninguna cuenta Gmail activa pertenece a un no-pagador',
    colgados.length === 0,
    'activas=' + (cuentas || []).length + ' colgadas=' + colgados.length);
}

run()
  .catch((e) => { console.error('ERROR', e); results.push({ pass: false, name: 'excepción: ' + e.message }); })
  .finally(() => {
    const ok = results.filter((r) => r.pass).length;
    console.log(`\n=== ${ok}/${results.length} checks OK ===`);
    process.exit(ok === results.length ? 0 : 1);
  });
