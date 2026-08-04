// E2E — el mes que gana un referrer EN TRIAL sobrevive al barrido del día 15.
//
// El bug (auditoría 2026-08-03, hallazgo B1): `procesarConversionProReferido` escribía el
// premio con `plan:'premium'` + `premium_vence` pero NO tocaba `trial_estado`. Como
// `checkTrialExpiry` baja al muro a todo el que tenga `trial_estado='activo'` y `trial_vence`
// pasado — **sin mirar `premium_vence`** — el mes que ya se le había anunciado por WhatsApp
// ("Tu Pro ahora vence: X") se evaporaba en silencio. Nada lo restauraba.
//
// El fix se cubrió con tests unitarios (mocks), pero nunca corrió contra la base real. Esto lo
// cierra: ejercita la función REAL contra la Supabase de PRODUCCIÓN con usuarios throwaway, y
// usa como oráculo del downgrade **la misma query que corre el cron**
// (`cron/checks.js`: `.eq('trial_estado','activo').lt('trial_vence', hoy)`), no una paráfrasis.
//
// Cero envíos: `lib/whatsapp` y `lib/notify-user` van stubeados (el spy además afirma que la
// fecha ANUNCIADA es la misma que quedó en la base — el bug era justo que se prometía una
// fecha que después desaparecía). Cero OpenAI. Cero crons.
//
// Correr:  node qa-e2e/qa-referido-premio-trial.mjs   (desde app/)  → exit 0 si todo pasa.

import 'dotenv/config';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { instalarGuard, permitirUsuarioDePrueba } from './lib/qa-guard.mjs';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const supabase = instalarGuard(require, path.join(appRoot, 'lib/db.js'));

// Stubs de salida ANTES de requerir services/referrals (destructura notificarUsuario al cargar).
const avisos = [];
for (const [rel, exports] of [
  ['lib/whatsapp.js', { enviarWhatsapp: async () => ({ ok: true, skipped: 'qa' }) }],
  ['lib/notify-user.js', {
    CANALES: { AMBOS: 'ambos', SOLO_WHATSAPP: 'solo_wa', SOLO_IN_APP: 'solo_inapp' },
    notificarUsuario: async (args) => { avisos.push(args); return { wa: { ok: true }, inApp: true }; },
  }],
]) {
  const p = require.resolve(path.join(appRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

const { procesarConversionProReferido } = require(path.join(appRoot, 'services/referrals.js'));
const { hoyPeru, sumarDias, sumarMeses } = require(path.join(appRoot, 'lib/dates.js'));

const RUN = Date.now();
const TAG = 'QA-REF-PREMIO';
const results = [];
function check(nombre, ok, detalle = '') {
  results.push({ nombre, ok });
  console.log((ok ? '  OK   ' : '  FALLA') + '  ' + nombre + (detalle ? '  [' + detalle + ']' : ''));
  return ok;
}

const creados = [];      // ids de usuarios throwaway
const vinculos = [];     // ids de filas de referidos

async function sembrarUsuario(nombre, extra) {
  const { data, error } = await supabase.from('usuarios')
    .insert({ nombre: TAG + ' ' + nombre + ' ' + RUN, is_test_user: true, onboarding_completado: true, ...extra })
    .select('id').single();
  if (error) throw new Error('no se pudo sembrar ' + nombre + ': ' + error.message);
  creados.push(data.id);
  await permitirUsuarioDePrueba(data.id);
  return data.id;
}

async function vincular(referrerId, referidoId) {
  const { data, error } = await supabase.from('referidos')
    .insert({ ref_code: 'QA' + String(RUN).slice(-6), referrer_id: referrerId, referido_id: referidoId, convertido_pro: false })
    .select('id').single();
  if (error) throw new Error('no se pudo vincular: ' + error.message);
  vinculos.push(data.id);
}

const leer = async (id) => (await supabase.from('usuarios')
  .select('plan, trial_estado, trial_vence, premium_vence, referidos_meses_otorgados').eq('id', id).single()).data;

/** El oráculo: LA MISMA query del downgrade de cron/checks.js, acotada al throwaway. */
async function elCronLoBarreria(id) {
  const { data } = await supabase.from('usuarios')
    .select('id').eq('trial_estado', 'activo').lt('trial_vence', hoyPeru()).eq('id', id);
  return (data || []).length > 0;
}

async function main() {
  const hoy = hoyPeru();

  // ── Caso 1: referrer EN TRIAL con prueba vigente ────────────────────────────────────
  // El mes debe apilarse sobre lo que le queda de prueba, no sobre hoy (si no, se solapa
  // con Pro que ya tenía gratis y el regalo vale menos de un mes).
  const venceTrial = sumarDias(hoy, 10);
  const refTrial = await sembrarUsuario('referrer-trial', {
    plan: 'premium', trial_estado: 'activo', trial_vence: venceTrial, premium_vence: null,
  });
  const refdo1 = await sembrarUsuario('referido-1', { plan: 'free' });
  await vincular(refTrial, refdo1);
  check('setup: el referrer arranca EN TRIAL, sin premium_vence', true, 'trial_vence=' + venceTrial);

  await procesarConversionProReferido(refdo1);
  const u1 = await leer(refTrial);

  check('el mes se apila sobre el FIN DEL TRIAL, no sobre hoy',
    u1.premium_vence === sumarMeses(venceTrial, 1),
    'vence=' + u1.premium_vence + ' esperado=' + sumarMeses(venceTrial, 1));
  // Independiente de sumarMeses: lo que el bug producía era la fecha calculada desde HOY.
  check('y por lo tanto NO es la fecha que daba el cálculo viejo (hoy + 1 mes)',
    u1.premium_vence !== sumarMeses(hoy, 1),
    'viejo habría sido ' + sumarMeses(hoy, 1));
  check('el trial queda sellado como convertido (deja de contar como prueba)',
    u1.trial_estado === 'convertido', 'estado=' + u1.trial_estado);
  check('sigue premium y se contabilizó 1 mes otorgado',
    u1.plan === 'premium' && u1.referidos_meses_otorgados === 1,
    'plan=' + u1.plan + ' meses=' + u1.referidos_meses_otorgados);
  check('el aviso que SALE anuncia exactamente la fecha que quedó en la base',
    avisos.length === 1 && String(avisos[0].mensaje || '').includes(u1.premium_vence),
    'avisos=' + avisos.length);

  // ── Caso 2: el barrido del día 15 (LA regresión) ────────────────────────────────────
  // Referrer cuyo trial ya venció ayer: es exactamente a quien el cron levanta esta noche.
  const refPorVencer = await sembrarUsuario('referrer-vencehoy', {
    plan: 'premium', trial_estado: 'activo', trial_vence: sumarDias(hoy, -1), premium_vence: null,
  });
  const refdo2 = await sembrarUsuario('referido-2', { plan: 'free' });
  await vincular(refPorVencer, refdo2);

  check('control: ANTES del premio, el cron SÍ lo barrería (el caso no es vacuo)',
    await elCronLoBarreria(refPorVencer) === true);

  await procesarConversionProReferido(refdo2);
  const u2 = await leer(refPorVencer);

  check('DESPUÉS del premio, el cron ya NO lo barre → el mes sobrevive al día 15',
    await elCronLoBarreria(refPorVencer) === false,
    'estado=' + u2.trial_estado + ' vence=' + u2.premium_vence);
  check('y conserva su mes de Pro por delante',
    u2.plan === 'premium' && u2.premium_vence > hoy,
    'vence=' + u2.premium_vence);

  // ── Caso 3: control — un referrer que YA PAGA no debe verse afectado ────────────────
  const venceP = sumarDias(hoy, 20);
  const refPagado = await sembrarUsuario('referrer-pagado', {
    plan: 'premium', trial_estado: 'convertido', premium_vence: venceP,
  });
  const refdo3 = await sembrarUsuario('referido-3', { plan: 'free' });
  await vincular(refPagado, refdo3);

  await procesarConversionProReferido(refdo3);
  const u3 = await leer(refPagado);
  check('al pagador el mes se le apila sobre su vencimiento vigente',
    u3.premium_vence === sumarMeses(venceP, 1),
    'vence=' + u3.premium_vence + ' esperado=' + sumarMeses(venceP, 1));
  check('y su trial_estado no se toca', u3.trial_estado === 'convertido', 'estado=' + u3.trial_estado);
}

async function limpiar() {
  for (const id of vinculos) await supabase.from('referidos').delete().eq('id', id);
  for (const id of creados) await supabase.from('usuarios').delete().eq('id', id);
  // La re-lectura ES el check: confirma que no quedó basura en producción.
  const { data } = await supabase.from('usuarios').select('id').in('id', creados.length ? creados : ['00000000-0000-0000-0000-000000000000']);
  check('limpieza: no quedó ningún throwaway en producción', (data || []).length === 0,
    'sembrados=' + creados.length);
}

let salida = 0;
try {
  await main();
} catch (e) {
  console.error('\nINCONCLUSO (infra, no regresión): ' + e.message);
  salida = 2;
} finally {
  try { await limpiar(); } catch (e) { console.error('  FALLA  limpieza: ' + e.message); results.push({ nombre: 'limpieza', ok: false }); }
}

const fallidos = results.filter((r) => !r.ok);
console.log('\n=== ' + (results.length - fallidos.length) + '/' + results.length + ' checks OK ===');
if (fallidos.length) { console.log(JSON.stringify({ verdict: 'FAIL', fallidos: fallidos.map((f) => f.nombre) }, null, 2)); salida = salida || 1; }
else if (!salida) console.log(JSON.stringify({ verdict: 'PASS — el mes del referrer en trial sobrevive al día 15' }, null, 2));
process.exit(salida);
