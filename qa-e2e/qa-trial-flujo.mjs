// E2E de FLUJO del trial: las tres cadenas que `qa-trial-gate.mjs` NO toca.
//
// qa-trial-gate verifica el estado en DB y las funciones de decisión llamándolas
// directo. Eso deja tres huecos donde el bug no se ve desde ninguno de los dos lados:
//
//   A. Los avisos de día 11 y 14. El otro harness rebobina el trial a "venció ayer",
//      así que corre la rama del downgrade y SALTEA las dos ramas de aviso: el copy,
//      el dedup por día y el payload del template nunca se ejecutaban.
//
//   B. El muro contra el NLP REAL. Todo lo demás llama `requiereLectura('ver_reporte')`
//      con el nombre ya resuelto. Pero quien resuelve el nombre en producción es
//      OpenAI: si clasifica "cuánto gasté" con un intent que no está en la lista, el
//      muro se filtra y el test unitario sigue verde. Acá se manda la FRASE.
//
//   C. El arranque del trial por la webapp. El usuario web-first no pasa por
//      services/transactions.js: su gasto viaja POST /api/transactions → after() →
//      iniciarTrialBackend → /internal/trial-iniciar en Railway → CAS. Cuatro saltos,
//      cero cobertura hasta ahora.
//
// Gasta llamadas a OpenAI (bloque B, ~7). Corre contra prod. Limpia lo que siembra.
//
// Correr:  node qa-e2e/qa-trial-flujo.mjs   (desde app/)  → exit 0 si pasa.

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { supabase } = require('../lib/db');
const { checkTrialExpiry } = require('../cron/checks');
const { procesarMensajeLibre } = require('../handlers/message-processor');
const { hoyPeru, sumarDias } = require('../lib/dates');
const { AVISO_DIAS_ANTES } = require('../lib/trial');

const APP = process.env.QA_WEBAPP_URL || 'https://app.neto.pe';
const RUN = Date.now();
const WA = '51900' + String(RUN).slice(-6);

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond, detail });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
  return !!cond;
};
const seccion = (t) => console.log('\n' + t);

let userId = null;
const set = (patch) => supabase.from('usuarios').update(patch).eq('id', userId);
const notifs = async (titulo) => {
  const { data } = await supabase.from('notificaciones').select('mensaje')
    .eq('usuario_id', userId).eq('titulo', titulo);
  return data || [];
};
const entregas = async (tipo) => {
  const { data } = await supabase.from('notification_deliveries').select('canal, estado')
    .eq('usuario_id', userId).eq('tipo', tipo);
  return data || [];
};

// ─── A. Avisos día 11 y día 14 ──────────────────────────────────────────────
async function bloqueAvisos() {
  seccion('── A. Avisos de fin de trial (día 11 y 14)');

  // Día 11 = faltan AVISO_DIAS_ANTES. Sin cuenta web: el copy tiene que empujar a
  // ACTIVAR, no a pagar — está por terminar 14 días de Pro sin haber visto nunca lo
  // que se le acaba, y pedirle plata por algo que no vio no puede funcionar.
  await set({ plan: 'premium', trial_estado: 'activo', trial_vence: sumarDias(hoyPeru(), AVISO_DIAS_ANTES), supabase_auth_id: null });
  await checkTrialExpiry();
  const d11 = await notifs('Tu prueba Pro termina en 3 días');
  check('el día 11 crea el aviso', d11.length === 1, 'notificaciones=' + d11.length);
  check('sin cuenta web, el aviso empuja a ACTIVAR (no a pagar)',
    d11[0] && /activar\?t=|no has entrado/i.test(d11[0].mensaje),
    (d11[0]?.mensaje || '').slice(0, 80).replace(/\n/g, ' '));
  check('...y NO le pide plata todavía', d11[0] && !/S\/10\/mes/.test(d11[0].mensaje));

  // Correr de nuevo el mismo día no puede duplicar: el cron corre cada hora y sin el
  // dedup mandaría el mismo aviso 24 veces (es el bug que ya pasó con checkPremiumExpiry).
  await checkTrialExpiry();
  const d11bis = await notifs('Tu prueba Pro termina en 3 días');
  check('correr el cron otra vez el mismo día NO duplica el aviso', d11bis.length === 1,
    'notificaciones=' + d11bis.length);

  // Con cuenta web ya activada, el copy sí es comercial.
  await supabase.from('notificaciones').delete().eq('usuario_id', userId);
  await set({ supabase_auth_id: '00000000-0000-4000-8000-' + String(RUN).slice(-12) });
  await checkTrialExpiry();
  const d11web = await notifs('Tu prueba Pro termina en 3 días');
  check('con cuenta web activada, el aviso sí nombra el precio',
    d11web[0] && /S\/10\/mes/.test(d11web[0].mensaje),
    (d11web[0]?.mensaje || '').slice(0, 80).replace(/\n/g, ' '));

  // Día 14 = vence hoy.
  await set({ trial_vence: hoyPeru() });
  await checkTrialExpiry();
  const d14 = await notifs('Tu prueba Pro termina hoy');
  check('el día 14 crea su propio aviso', d14.length === 1, 'notificaciones=' + d14.length);
  check('el aviso del día 14 dice "hoy"', d14[0] && /termina hoy/i.test(d14[0].mensaje),
    (d14[0]?.mensaje || '').slice(0, 70).replace(/\n/g, ' '));
  const sigueActivo = await supabase.from('usuarios').select('plan, trial_estado').eq('id', userId).maybeSingle();
  check('avisar NO baja el plan (el último día todavía es Pro)',
    sigueActivo.data.plan === 'premium' && sigueActivo.data.trial_estado === 'activo',
    'plan=' + sigueActivo.data.plan + ' estado=' + sigueActivo.data.trial_estado);

  // Con el flag on el envío tiene que salir por TEMPLATE (canal whatsapp_template en
  // notification_deliveries). Es lo único observable sin tocar Meta.
  await supabase.from('notificaciones').delete().eq('usuario_id', userId);
  await supabase.from('notification_deliveries').delete().eq('usuario_id', userId);
  process.env.WA_TRIAL_TEMPLATE_ENABLED = 'true';
  await set({ trial_vence: sumarDias(hoyPeru(), AVISO_DIAS_ANTES) });
  await checkTrialExpiry();
  const eTpl = await entregas('trial_d11');
  check('con WA_TRIAL_TEMPLATE_ENABLED=true el envío usa canal template',
    eTpl.some((e) => e.canal === 'whatsapp_template'), JSON.stringify(eTpl));
  delete process.env.WA_TRIAL_TEMPLATE_ENABLED;

  await supabase.from('notificaciones').delete().eq('usuario_id', userId);
  await supabase.from('notification_deliveries').delete().eq('usuario_id', userId);
}

// ─── B. El muro contra el NLP real ──────────────────────────────────────────
async function bloqueNlp() {
  seccion('── B. El muro contra el NLP real (frases, no nombres de intent)');

  await set({ plan: 'free', trial_estado: 'vencido', trial_vence: sumarDias(hoyPeru(), -2), supabase_auth_id: null });
  const { data: u } = await supabase.from('usuarios').select('*').eq('id', userId).maybeSingle();

  const LECTURAS = [
    'cuanto gaste este mes',
    'dame mi reporte',
    'cuanto pago en suscripciones',
    'en que se me va la plata',
    'como va mi presupuesto',
    'cual es mi score',
  ];
  for (const frase of LECTURAS) {
    const r = await procesarMensajeLibre(frase, u, WA);
    check('bloquea: "' + frase + '"', typeof r === 'string' && /🔒/.test(r) && /prueba de \*Neto Pro\*/.test(r),
      (r || '').slice(0, 55).replace(/\n/g, ' '));
  }

  // Y lo que NO se toca: registrar un gasto.
  const antes = await supabase.from('transacciones').select('id', { count: 'exact', head: true }).eq('usuario_id', userId);
  const rGasto = await procesarMensajeLibre('gaste 30 en taxi', u, WA);
  const despues = await supabase.from('transacciones').select('id', { count: 'exact', head: true }).eq('usuario_id', userId);
  check('EN EL MURO SE SIGUE REGISTRANDO: "gaste 30 en taxi" guarda una fila',
    despues.count === antes.count + 1, 'antes=' + antes.count + ' después=' + despues.count);
  check('...y la confirmación trae el total del mes',
    typeof rGasto === 'string' && /Van \*S\//.test(rGasto), (rGasto || '').slice(0, 90).replace(/\n/g, ' '));
  check('...y NO trae el mensaje del muro', typeof rGasto === 'string' && !/🔒/.test(rGasto));
}

// ─── C. Arranque del trial desde la webapp (web-first) ──────────────────────
async function bloqueWebFirst() {
  seccion('── C. Arranque del trial por la webapp (POST /api/transactions → Railway)');

  let env;
  try {
    env = readFileSync(join(homedir(), '.config', 'neto', 'qa.env'), 'utf8')
      .split(/\r?\n/).reduce((e, l) => { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) e[m[1]] = m[2]; return e; }, {});
  } catch {
    check('qa.env disponible para el bloque web-first', false, 'no se pudo leer ~/.config/neto/qa.env');
    return;
  }
  const SUPA = env.NETO_QA_URL, ANON = env.NETO_QA_ANON;
  const EMAIL = env.NETO_QA_FREE_EMAIL, PASSWORD = env.NETO_QA_FREE_PASSWORD, UID = env.NETO_QA_FREE_USUARIO_ID;
  if (!UID) { check('qa.env trae el usuario free', false, 'falta NETO_QA_FREE_USUARIO_ID'); return; }

  // Guardar el estado del fixture para restaurarlo pase lo que pase.
  const { data: previo } = await supabase.from('usuarios')
    .select('plan, trial_estado, trial_inicio, trial_vence').eq('id', UID).maybeSingle();

  let txId = null;
  try {
    const g = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
      method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    const s = await g.json();
    const ref = new URL(SUPA).hostname.split('.')[0];
    const v = 'base64-' + Buffer.from(JSON.stringify(s), 'utf8').toString('base64url');
    const MAX = 3180, cn = `sb-${ref}-auth-token`;
    const cookie = v.length <= MAX
      ? `${cn}=${v}`
      : Array.from({ length: Math.ceil(v.length / MAX) }, (_, i) => `${cn}.${i}=${v.slice(i * MAX, (i + 1) * MAX)}`).join('; ');

    // El fixture vuelve a "nunca tuvo trial": es el estado del usuario web-first real.
    await supabase.from('usuarios')
      .update({ plan: 'free', trial_estado: null, trial_inicio: null, trial_vence: null }).eq('id', UID);

    const res = await fetch(`${APP}/api/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ monto: 19.9, moneda: 'PEN', comercio: 'QA web-first', categoria: 'Alimentación', subcategoria: 'Mercado', fecha: hoyPeru(), tipo: 'gasto' }),
    });
    const creada = await res.json().catch(() => null);
    txId = creada && creada.id;
    check('POST /api/transactions con sesión responde 200', res.status === 200, 'status=' + res.status);

    // after() corre DESPUÉS de la respuesta y el hop a Railway tarda: se sondea.
    let final = null;
    for (let i = 0; i < 15; i++) {
      const { data } = await supabase.from('usuarios').select('plan, trial_estado, trial_vence').eq('id', UID).maybeSingle();
      if (data && data.trial_estado === 'activo') { final = data; break; }
      await new Promise((r) => setTimeout(r, 2000));
      final = data;
    }
    check('el gasto desde la WEBAPP arranca el trial (webapp → Railway → CAS)',
      final && final.trial_estado === 'activo', 'estado=' + (final && final.trial_estado));
    check('y le entrega Pro', final && final.plan === 'premium', 'plan=' + (final && final.plan));
    check('con los 14 días completos', final && String(final.trial_vence).slice(0, 10) === sumarDias(hoyPeru(), 14),
      'vence=' + (final && final.trial_vence));
  } finally {
    if (txId) await supabase.from('transacciones').delete().eq('id', txId);
    await supabase.from('usuarios').update(previo).eq('id', UID);
    const { data: rest } = await supabase.from('usuarios').select('plan, trial_estado').eq('id', UID).maybeSingle();
    check('el fixture QA free quedó restaurado',
      rest.plan === previo.plan && rest.trial_estado === previo.trial_estado, JSON.stringify(rest));
  }

  // Contrato del endpoint interno: sin la clave compartida no hace nada.
  const rSinClave = await fetch('https://api.neto.pe/internal/trial-iniciar', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usuario_id: UID }),
  });
  check('POST /internal/trial-iniciar sin x-internal-key responde 401', rSinClave.status === 401,
    'status=' + rSinClave.status);
}

async function run() {
  const { data: creado, error } = await supabase.from('usuarios').insert({
    whatsapp: WA, nombre: 'Flujo Prueba', plan: 'free',
    onboarding_completado: true, is_test_user: true,
  }).select('id').single();
  if (!check('se sembró el usuario throwaway', !error && creado, error ? error.message : 'wa=' + WA)) return;
  userId = creado.id;

  await bloqueAvisos();
  await bloqueNlp();
  await bloqueWebFirst();
}

async function cleanup() {
  if (!userId) return;
  for (const t of ['transacciones', 'notificaciones', 'categorias_usuario', 'conversaciones', 'notification_deliveries', 'nlp_errors']) {
    await supabase.from(t).delete().eq('usuario_id', userId);
  }
  const { error } = await supabase.from('usuarios').delete().eq('id', userId);
  const { data: sigue } = await supabase.from('usuarios').select('id').eq('id', userId).maybeSingle();
  check('se borró el usuario throwaway', !error && !sigue, error ? error.message : 'id=' + userId);
}

let fatal = null;
try { await run(); } catch (e) { fatal = e; console.log('FAIL excepción — ' + e.message); }
try { await cleanup(); } catch (e) { console.log('FAIL limpieza — ' + e.message); fatal = fatal || e; }

const fallidos = results.filter((r) => !r.pass);
console.log('\n=== ' + (results.length - fallidos.length) + '/' + results.length + ' checks OK ===');
if (fatal) console.log(fatal.stack);
process.exit(fallidos.length === 0 && !fatal ? 0 : 1);
