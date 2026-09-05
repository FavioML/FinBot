// E2E de la INTEGRIDAD del trial: los estados que no pueden existir, y los mensajes que
// no pueden salir. Hermano de qa-trial-gate.mjs, que verifica que el muro BLOQUEA; este
// verifica que el trial ENTREGA y que nadie se lo puede quitar por accidente.
//
// Cubre los seis huecos de la auditoría del 2026-08-01 (rango e9449d0..ca4bc8f + migr 052).
// Todos habían pasado los 501 tests que existían: ninguno era un test roto, eran cosas que
// ningún test miraba. Los dos que más duelen:
//
//   · checkPremiumExpiry mataba el trial de quien traía un premium_vence viejo. Le pasó a
//     un ex-pagador real: trial a las 15:23 UTC, muerto a las 16:41, y encima "tu plan Pro
//     venció". Quedó con plan='free' y trial_estado='activo' a la vez, o sea con el banner
//     de prueba arriba del paywall.
//   · El mensaje del día 15 se armaba con una fila PARCIAL (el cron no seleccionaba
//     trial_estado), caía en la rama equivocada y prometía 14 días gratis a quien acababa
//     de gastarlos.
//
// Por qué un harness y no solo unit tests: los dos bugs vivían en la JUNTA entre una query
// y una función pura. El unit test de mensajeMuro pasaba porque le pasaban la fila completa;
// producción le pasaba otra. Acá se corre el cron de verdad contra la Supabase real.
//
// Corre contra la Supabase REAL con usuarios throwaway (se borran al final).
// Correr:  node qa-e2e/qa-trial-integridad.mjs   (desde app/)  → exit 0 si pasa.

import 'dotenv/config';
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { instalarGuard, permitirUsuarioDePrueba } from './lib/qa-guard.mjs';

const require = createRequire(import.meta.url);
const supabase = instalarGuard(require, '../lib/db');

const APP = process.env.QA_WEBAPP_URL || 'https://app.neto.pe';

const RUN = Date.now();
// Todos los throwaway de esta corrida comparten este prefijo de número (ver sembrar()).
const WA_PREFIJO = '51900' + String(RUN).slice(-5);

// ── Spy de salida: instalado ANTES de requerir cron/checks ───────────────────────────
// `checkPremiumExpiry` es un cron BULK: barre TODOS los usuarios con el Pro por vencer y les
// manda "tu plan NETO Pro vence en 3 días". La barrera qa-guard cubre las escrituras a
// Supabase, pero `notificarUsuario` manda el WhatsApp ANTES del insert in-app
// (lib/notify-user.js:128) y ese envío es HTTP a Meta, invisible para la barrera.
// Va acá arriba porque notify-user destructura `enviarWhatsapp` al cargar.
const enviosAjenos = [];
const waPath = require.resolve('../lib/whatsapp.js');
const waReal = require(waPath);
const realEnviar = waReal.enviarWhatsapp;
require.cache[waPath].exports = {
  ...waReal,
  enviarWhatsapp: async (to, msg, opts = {}) => {
    if (String(to).startsWith(WA_PREFIJO)) return realEnviar(to, msg, opts);
    enviosAjenos.push(String(to));
    return { ok: true, skipped: 'qa_destino_ajeno' };
  },
};

const trial = require('../lib/trial');
const { guardarTransaccion } = require('../services/transactions');
const { checkPremiumExpiry } = require('../cron/checks');
const { hoyPeru, sumarDias } = require('../lib/dates');
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond, detail });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
  return !!cond;
};

// Cada caso siembra su propio usuario. El marcador va en el nombre para que la limpieza
// barra por prefijo aunque una corrida anterior se haya muerto a la mitad.
const TAG = 'QA-TRIAL-INT';
const creados = [];

async function sembrar(etiqueta, extra = {}) {
  const wa = WA_PREFIJO + String(creados.length);
  const { data, error } = await supabase.from('usuarios').insert({
    whatsapp: wa, nombre: TAG + ' ' + etiqueta, plan: 'free',
    onboarding_completado: true, is_test_user: true, ...extra,
  }).select('*').single();
  if (error) throw new Error('no se pudo sembrar ' + etiqueta + ': ' + error.message);
  creados.push(data.id);
  return data;
}

// ── Sesión de la webapp: password grant + cookie SSR forjada. Mismo mecanismo que
// qa-money-edge.mjs (el magic link se consume solo y Supabase rate-limitea el OTP).
function loadEnv(path) {
  const env = {};
  try {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* opcional: sin creds los checks de webapp se saltan */ }
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
const gasto = (id) => guardarTransaccion(id, {
  monto: 25, moneda: 'PEN', comercio: TAG, categoria: 'Alimentación', subcategoria: 'restaurante',
  tipo: 'gasto', fecha: hoyPeru(), descripcion_original: TAG + ' ' + RUN,
});

async function run() {
  const ayer = sumarDias(hoyPeru(), -1);

  // ── 1. El trial no hereda el vencimiento de una suscripción vieja ──────────
  // Este es el estado exacto del incidente: alguien que pagó, churneó, y vuelve.
  const exPagador = await sembrar('ex-pagador', {
    premium_desde: sumarDias(hoyPeru(), -60), premium_vence: sumarDias(hoyPeru(), -30),
    trial_estado: null,
  });
  await gasto(exPagador.id);
  const u1 = await leer(exPagador.id);
  check('un premium_vence viejo NO sobrevive al arranque del trial',
    u1.trial_estado === 'activo' && u1.premium_vence === null,
    'estado=' + u1.trial_estado + ' premium_vence=' + u1.premium_vence);

  // ── 2. checkPremiumExpiry no puede tocar un trial vivo ─────────────────────
  // Se le vuelve a poner el premium_vence viejo A MANO para simular el estado que producía
  // el incidente, y se corre el cron de verdad. Sin el guard, acá el plan cae a 'free'.
  await supabase.from('usuarios').update({ premium_vence: ayer }).eq('id', exPagador.id);
  // Pre-vuelo antes de correr el cron bulk contra producción: a cuánta gente real alcanza.
  // Con 0 en ventana solo puede tocar a los throwaway; con >0, el spy del encabezado es lo
  // único que evita que les llegue un WhatsApp, así que el número queda impreso.
  const { data: enVentana } = await supabase.from('usuarios').select('id, is_test_user')
    .eq('plan', 'premium').lte('premium_vence', sumarDias(hoyPeru(), 3));
  const realesEnVentana = (enVentana || []).filter((u) => u.is_test_user !== true);
  check('pre-vuelo: se midió el radio del cron bulk ANTES de correrlo', true,
    realesEnVentana.length + ' usuarios reales en la ventana del cron');
  await checkPremiumExpiry();
  const u2 = await leer(exPagador.id);
  check('checkPremiumExpiry NO baja a quien está en trial, aunque tenga premium_vence vencido',
    u2.plan === 'premium' && u2.trial_estado === 'activo',
    'plan=' + u2.plan + ' estado=' + u2.trial_estado);

  // ── 3. El estado contradictorio es inconstruible ───────────────────────────
  // plan y trial_estado se pueden desincronizar en la DB (una escritura a mano, un cron
  // futuro), pero el PREDICADO tiene que resistirlo: es lo que decide si se pinta el
  // banner de prueba. Si enTrial mira una sola columna, vuelve la pantalla contradictoria.
  const roto = { plan: 'free', trial_estado: 'activo', trial_vence: sumarDias(hoyPeru(), 10) };
  check('enTrial() exige plan Y estado: el estado desincronizado no es un trial',
    trial.enTrial(roto) === false && trial.estaEnMuro(roto) === true, '');
  check('...y diasRestantesTrial no cuenta días de una prueba que el plan ya no respalda',
    trial.diasRestantesTrial(roto) === null, '');

  // ── 4. Un ex-pagador sellado NO se gana otra prueba ────────────────────────
  const convertido = await sembrar('convertido', {
    trial_estado: 'convertido', premium_desde: sumarDias(hoyPeru(), -90),
    premium_vence: sumarDias(hoyPeru(), -10),
  });
  await gasto(convertido.id);
  const u4 = await leer(convertido.id);
  check('un ex-pagador (convertido) no recibe trial con su próximo gasto',
    u4.trial_estado === 'convertido' && u4.plan === 'free',
    'estado=' + u4.trial_estado + ' plan=' + u4.plan);

  // ── 5. El mensaje del día 15, con la fila que REALMENTE le pasa el cron ────
  // El bug no estaba en mensajeMuro: estaba en el select del llamador. Así que se replica
  // el select, no se arma el objeto a mano — es la única forma de que este check valga.
  // Desde el 05-sep-2026 se DERIVA de `trial.COLUMNAS_MURO` en vez de copiarlo: la copia de
  // acá ya divergió una vez (le faltó `supabase_auth_id` el mismo día que el cron lo ganó), y
  // una réplica que envejece sola no replica nada.
  const vencido = await sembrar('vencido', {
    trial_estado: 'vencido', trial_vence: ayer,
  });
  const { data: filaCron } = await supabase.from('usuarios')
    .select(trial.COLUMNAS_MURO + ', whatsapp')
    .eq('id', vencido.id).maybeSingle();
  const msgVencido = trial.mensajeMuro(filaCron, 40);
  check('a quien terminó su prueba NO se le ofrecen otros 14 días gratis',
    !msgVencido.includes('días gratis'), msgVencido.slice(0, 60).replace(/\n/g, ' '));
  check('...y se le nombra que fue una PRUEBA lo que terminó',
    msgVencido.includes('prueba'), '');

  // ── 6. Al ex-cliente se le habla de su Pro, no de una prueba ───────────────
  const { data: filaExCliente } = await supabase.from('usuarios')
    .select(trial.COLUMNAS_MURO + ', whatsapp')
    .eq('id', convertido.id).maybeSingle();
  const msgExCliente = trial.mensajeMuro(filaExCliente, 87);
  check('al ex-pagador se le nombra su *Pro*, no una prueba que nunca tuvo',
    msgExCliente.includes('Pro* venció') && !msgExCliente.includes('prueba'),
    msgExCliente.slice(0, 60).replace(/\n/g, ' '));

  // ── 7. Una fila incompleta no puede elegir rama ────────────────────────────
  const msgParcial = trial.mensajeMuro({ id: vencido.id, nombre: 'Ana', trial_vence: ayer }, 40);
  check('sin trial_estado en la fila, el mensaje NO promete un trial',
    !msgParcial.includes('días gratis'), msgParcial.slice(0, 60).replace(/\n/g, ' '));

  // ── 8. La base no tiene estados imposibles ────────────────────────────────
  // Las invariantes que dejó la migración 054, verificadas sobre usuarios REALES.
  const cuenta = async (filtro) => {
    let q = supabase.from('usuarios').select('id', { count: 'exact', head: true }).eq('is_test_user', false);
    q = filtro(q);
    const { count } = await q;
    return count || 0;
  };
  const muroConTrial = await cuenta((q) => q.eq('plan', 'free').eq('trial_estado', 'activo'));
  check('ningún usuario real está en el muro con el trial "activo"', muroConTrial === 0,
    'encontrados=' + muroConTrial);
  const trialConVence = await cuenta((q) => q.eq('trial_estado', 'activo').not('premium_vence', 'is', null));
  check('ningún trial vivo arrastra un premium_vence', trialConVence === 0,
    'encontrados=' + trialConVence);
  const exSinSellar = await cuenta((q) =>
    q.is('trial_estado', null).not('premium_vence', 'is', null).neq('plan', 'premium'));
  check('ningún ex-pagador quedó sin sellar (se ganaría un trial que el cron mataría)',
    exSinSellar === 0, 'encontrados=' + exSinSellar);

  // ── 9. /api/pro/status con un usuario EN TRIAL (el bug que costaba plata) ──
  // Se corre contra app.neto.pe con sesión real: el usuario QA free se pone en trial
  // durante el check y se restaura al final. Es el único camino que prueba de punta a
  // punta que la pantalla de pago aparece y que el descuento deja de estar escondido.
  const cookieFree = await loginQA('NETO_QA_FREE_').catch((e) => { console.log('  (login QA falló: ' + e.message + ')'); return null; });
  const qaFreeId = qaEnv.NETO_QA_FREE_USUARIO_ID;
  if (!cookieFree || !qaFreeId) {
    check('checks de webapp: creds QA presentes', false, 'faltan NETO_QA_FREE_* en ~/.config/neto/qa.env');
  } else {
    const antes = await leer(qaFreeId);
    try {
      await supabase.from('usuarios').update({
        plan: 'premium', trial_estado: 'activo', trial_vence: sumarDias(hoyPeru(), 10),
        premium_vence: null, referido_dscto_pct: 50, referido_dscto_vence: sumarDias(hoyPeru(), 17),
      }).eq('id', qaFreeId);

      const r = await fetch(`${APP}/api/pro/status`, { headers: { Cookie: cookieFree }, redirect: 'manual' });
      const st = r.ok ? await r.json() : null;
      check('/api/pro/status expone el estado del trial', !!st && st.trialEstado === 'activo' && !!st.trialVence,
        st ? 'estado=' + st.trialEstado + ' vence=' + st.trialVence : 'status=' + r.status);
      // Antes: descuentoActivo exigía plan !== 'premium', y en trial esa columna vale
      // 'premium'. El 50% off anclado al fin del trial era invisible durante el trial.
      check('el descuento de referido SE VE durante el trial (no solo en el muro)',
        !!st && !!st.descuento && st.descuento.pct === 50,
        st ? 'descuento=' + JSON.stringify(st.descuento) : '');
      // Y las lecturas siguen abiertas: durante el trial es Pro de verdad.
      const rDash = await fetch(`${APP}/api/dashboard`, { headers: { Cookie: cookieFree }, redirect: 'manual' });
      check('en trial las lecturas NO devuelven 402', rDash.status === 200, 'status=' + rDash.status);
    } finally {
      await supabase.from('usuarios').update({
        plan: antes.plan, trial_estado: antes.trial_estado, trial_vence: antes.trial_vence,
        premium_vence: antes.premium_vence,
        referido_dscto_pct: antes.referido_dscto_pct, referido_dscto_vence: antes.referido_dscto_vence,
      }).eq('id', qaFreeId);
      const post = await leer(qaFreeId);
      check('el usuario QA quedó como estaba', post.plan === antes.plan && post.trial_estado === antes.trial_estado,
        'plan=' + post.plan + ' estado=' + post.trial_estado);
    }
  }
}

async function cleanup() {
  // Por id de esta corrida y, además, por marcador: si una corrida anterior murió a la
  // mitad, sus filas se van ahora en vez de acumularse.
  check('el cron bulk no le escribió a NINGÚN usuario real',
    enviosAjenos.length === 0,
    enviosAjenos.length ? 'destinos ajenos: ' + [...new Set(enviosAjenos)].join(', ') : 'solo a los throwaway');

  const { data: viejos } = await supabase.from('usuarios').select('id').like('nombre', TAG + '%');
  const ids = [...new Set([...creados, ...(viejos || []).map((u) => u.id)])];
  if (ids.length === 0) { check('limpieza: nada que borrar', true, ''); return; }
  // Los `viejos` vienen de un `like`, que NO cosecha en la barrera (solo eq./in. fijan
  // sujeto), así que sin registrarlos el DELETE de abajo abortaría y el barrido de huérfanos
  // de corridas muertas —el motivo por el que existe esta query— nunca borraría nada.
  // permitirUsuarioDePrueba revalida is_test_user contra la DB antes de aceptar cada uno.
  for (const id of ids) await permitirUsuarioDePrueba(id);
  for (const t of ['transacciones', 'notificaciones', 'categorias_usuario', 'pagos', 'notification_deliveries']) {
    await supabase.from(t).delete().in('usuario_id', ids);
  }
  const { error } = await supabase.from('usuarios').delete().in('id', ids);
  const { count } = await supabase.from('usuarios')
    .select('id', { count: 'exact', head: true }).like('nombre', TAG + '%');
  check('se borraron los usuarios throwaway y todo lo suyo', !error && !count,
    error ? error.message : ids.length + ' borrados');
}

let fatal = null;
try { await run(); } catch (e) { fatal = e; console.log('FAIL excepción — ' + e.message); }
try { await cleanup(); } catch (e) { console.log('FAIL limpieza — ' + e.message); fatal = fatal || e; }

const fallidos = results.filter((r) => !r.pass);
console.log('\n=== ' + (results.length - fallidos.length) + '/' + results.length + ' checks OK ===');
if (fatal) console.log(fatal.stack);
process.exit(fallidos.length === 0 && !fatal ? 0 : 1);
