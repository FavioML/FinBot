// E2E del cron `checkRecordatorioDeudas` (recordatorio de deudas por vencer).
//
// Los crons NO pasan por el webhook: se invoca la función exportada de cron/checks.js
// directamente. El flag `is_test_user` del QA user hace que `enviarWhatsapp` saltee Meta
// pero SÍ escriba `notification_deliveries` (estado='skipped_test'), así que espiando el
// envío obtenemos la salida capturada Y ejercemos la fila real de entrega
// (notification_deliveries = fuente de verdad de entrega; ver memory project_notifications_delivery).
//
// Aislamiento hermético (radio de daño = 0 aunque otros usuarios tengan deudas en ventana):
//   - Spy sobre enviarWhatsapp: captura (to,msg,opts) y delega al real SOLO para el QA user.
//   - Stub de obtenerDeudasProximasVencer: la MISMA query real pero scopeada a la deuda
//     throwaway del QA user (el WHERE global se reemplaza; la lógica de touches la sigue
//     decidiendo el cron, así que se ejerce de verdad).
//   - Reloj pineado (subclase de Date): fija "hoy Lima 09:05" para pasar el gate horario del
//     cron (getHours()===9) y anclar hoyPeru() → diffDias determinista.
//
// Aserciones binarias: TRIGGER (envío + copy exacta + delivery + notif in-app + ledger),
// IDEMPOTENCIA (re-run = no-op por el ledger recordatorios_enviados), SKIP (recordatorios_activos=false).
// Autolimpieza total: la deuda es throwaway; deliveries/notifs del QA se borran; se restaura el flag.
//
// Correr:  node qa-e2e/qa-cron-deudas.mjs   (desde app/)  → exit 0 si todo pasa.

import 'dotenv/config';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { instalarGuard } from './lib/qa-guard.mjs';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const QA_ID = 'ded7e219-e5fd-4ff4-b5a3-3cd5cdffd172';
const QA_WHATSAPP = 'qa-test-dashboard';

// ── Reloj pineado: hoy (Lima) 09:05. Perú es UTC-5 todo el año (sin DST) → 14:05Z = 09:05 Lima ──
const RealDate = Date;
const todayLima = new RealDate().toLocaleDateString('en-CA', { timeZone: 'America/Lima' }); // YYYY-MM-DD
const fixedMs = RealDate.parse(todayLima + 'T14:05:00.000Z');
function nextDay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new RealDate(RealDate.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}
const VENC = nextDay(todayLima); // vence mañana → touch v1

function installClock() {
  class MockDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(fixedMs); else super(...a); }
    static now() { return fixedMs; }
  }
  MockDate.parse = RealDate.parse;
  MockDate.UTC = RealDate.UTC;
  global.Date = MockDate;
}
function restoreClock() { global.Date = RealDate; }

// ── Spy de salida: capturar enviarWhatsapp ANTES de requerir checks.js. Delega al real solo
//    para el QA user; cualquier otro destino es un bug de aislamiento → lanza. ──
const sent = [];
const waPath = require.resolve(path.join(appRoot, 'lib/whatsapp.js'));
const waReal = require(waPath);
const realEnviar = waReal.enviarWhatsapp;
require.cache[waPath].exports = {
  ...waReal,
  enviarWhatsapp: async (to, msg, opts = {}) => {
    sent.push({ to, msg, opts });
    if (String(to) !== QA_WHATSAPP) throw new Error('GUARD: envío a destino no-QA: ' + to);
    return realEnviar(to, msg, opts); // is_test_user → salta Meta, escribe notification_deliveries
  },
};

const supabase = instalarGuard(require, path.join(appRoot, 'lib/db.js'));

// ── Stub del data-source: misma query real, scopeada a la deuda throwaway ──
let THROWAWAY_ID = null;
const debtsPath = require.resolve(path.join(appRoot, 'services/debts.js'));
const debtsReal = require(debtsPath);
require.cache[debtsPath].exports = {
  ...debtsReal,
  // Llama a la query REAL y recorta el resultado al throwaway, en vez de reescribirla.
  // Antes era una copia a mano del `select`, y divergió: la real sumó `usuarios.plan`
  // (el cron saltea a quien está en el muro, `checks.js:703`) y la copia no. Con la fila
  // parcial, `estaEnMuro()` lee `plan === undefined` y devuelve true, así que el cron
  // saltaba SIEMPRE y las 9 aserciones de TRIGGER fallaban sin que nada estuviera roto en
  // producción. Es la trampa de "una fila parcial no puede decidir" del CLAUDE.md, servida
  // por el harness que venía a vigilarla. Recortar después preserva el aislamiento (el
  // cron sigue viendo una sola deuda); leer de más es gratis y la barrera deja pasar lecturas.
  obtenerDeudasProximasVencer: async () => {
    if (!THROWAWAY_ID) return [];
    const todas = await debtsReal.obtenerDeudasProximasVencer();
    return todas.filter((d) => d.id === THROWAWAY_ID);
  },
};

// checks.js se requiere DESPUÉS de instalar los stubs (destructura en el require)
const { checkRecordatorioDeudas } = require(path.join(appRoot, 'cron/checks.js'));

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
}

let ORIG_RECORD = false;

async function setUserRecordatorios(val) {
  const { error } = await supabase.from('usuarios').update({ recordatorios_activos: val }).eq('id', QA_ID);
  if (error) throw error;
}
async function setLedger(arr) {
  const { error } = await supabase.from('deudas').update({ recordatorios_enviados: arr }).eq('id', THROWAWAY_ID);
  if (error) throw error;
}
async function getLedger() {
  const { data } = await supabase.from('deudas').select('recordatorios_enviados').eq('id', THROWAWAY_ID).single();
  return data?.recordatorios_enviados;
}
async function countDeliveries() {
  const { count } = await supabase.from('notification_deliveries')
    .select('id', { count: 'exact', head: true }).eq('usuario_id', QA_ID).eq('tipo', 'deuda');
  return count || 0;
}
async function getNotifs() {
  const { data } = await supabase.from('notificaciones')
    .select('titulo, tipo, datos').eq('usuario_id', QA_ID).eq('tipo', 'deuda_vence');
  return data || [];
}
async function runCron() {
  installClock();
  try { await checkRecordatorioDeudas(); }
  finally { restoreClock(); }
}

async function main() {
  const { data: orig } = await supabase.from('usuarios')
    .select('recordatorios_activos, is_test_user, whatsapp, nombre').eq('id', QA_ID).single();
  ORIG_RECORD = orig?.recordatorios_activos ?? false;
  check('QA user es test user con whatsapp esperado',
    orig?.is_test_user === true && orig?.whatsapp === QA_WHATSAPP, 'nombre=' + orig?.nombre);

  const { data: seeded, error: eSeed } = await supabase.from('deudas').insert({
    usuario_id: QA_ID, tipo: 'debo', contraparte: 'QA-CRON Tarjeta',
    monto_original: 800, monto_pendiente: 800, moneda: 'PEN',
    fecha_vencimiento: VENC, estado: 'activa', recordatorios_enviados: [],
  }).select('id').single();
  if (eSeed) throw eSeed;
  THROWAWAY_ID = seeded.id;
  console.log('fixture: deuda throwaway ' + THROWAWAY_ID + '  vence ' + VENC + '  (hoy Lima ' + todayLima + ')');

  // ══════════ TRIGGER ══════════
  await setUserRecordatorios(true);
  await setLedger([]);
  const del0 = await countDeliveries();
  const notif0 = (await getNotifs()).length;
  sent.length = 0;
  await runCron();

  // El saludo se DERIVA del nombre del QA user, no se fija: el cron lo arma con
  // `nombre.split(' ')[0]` y acá estaba escrito 'QA,' de cuando el usuario se llamaba así.
  // Renombrarlo (hoy es Camila Rojas) rompía la aserción sin que el copy hubiera cambiado.
  // Sigue siendo exacta —el saludo completo, la coma y el resto del texto— pero afirma la
  // REGLA (primer nombre + ', ') en vez de un valor de fixture que envejece.
  const primerNombre = orig?.nombre ? orig.nombre.split(' ')[0] : null;
  const saludo = primerNombre ? primerNombre + ', ' : '';
  const expectedMsg = '⏰ ' + saludo + 'mañana vence tu deuda con *QA-CRON Tarjeta* (S/ 800.00). ¡Que no se te pase!';
  check('TRIGGER: se capturó exactamente 1 envío', sent.length === 1, 'capturados=' + sent.length);
  check('TRIGGER: copy exacta del touch v1 (mañana, debo)', sent[0]?.msg === expectedMsg, JSON.stringify(sent[0]?.msg));
  check('TRIGGER: opts.tipo=deuda + usuarioId correcto + template null',
    sent[0]?.opts?.tipo === 'deuda' && sent[0]?.opts?.usuarioId === QA_ID && !sent[0]?.opts?.template,
    'tipo=' + sent[0]?.opts?.tipo + ' usuarioId=' + (sent[0]?.opts?.usuarioId === QA_ID));

  const del1 = await countDeliveries();
  check('TRIGGER: +1 fila en notification_deliveries', del1 === del0 + 1, del0 + '→' + del1);
  const { data: lastDel } = await supabase.from('notification_deliveries')
    .select('estado, canal, tipo').eq('usuario_id', QA_ID).eq('tipo', 'deuda')
    .order('id', { ascending: false }).limit(1);
  check('TRIGGER: entrega estado=skipped_test (test user, sin Meta), canal=whatsapp',
    lastDel?.[0]?.estado === 'skipped_test' && lastDel?.[0]?.canal === 'whatsapp',
    'estado=' + lastDel?.[0]?.estado);

  const notifs1 = await getNotifs();
  const notifMatch = notifs1.find(n => n.datos?.deuda_id === THROWAWAY_ID);
  check('TRIGGER: +1 notificación in-app deuda_vence', notifs1.length === notif0 + 1 && !!notifMatch,
    'titulo=' + notifMatch?.titulo);
  check('TRIGGER: titulo "Deuda vence en 1 días"', notifMatch?.titulo === 'Deuda vence en 1 días', notifMatch?.titulo);

  const ledger1 = await getLedger();
  check('TRIGGER: ledger recordatorios_enviados = [v1,v3]',
    JSON.stringify((ledger1 || []).slice().sort()) === JSON.stringify(['v1', 'v3']), JSON.stringify(ledger1));

  // ══════════ IDEMPOTENCIA (re-run: touch ya en ledger → no-op) ══════════
  sent.length = 0;
  const del2 = await countDeliveries();
  const notif2 = (await getNotifs()).length;
  await runCron();
  check('IDEMP: 0 envíos nuevos (dedup por ledger)', sent.length === 0, 'capturados=' + sent.length);
  check('IDEMP: 0 deliveries nuevas', (await countDeliveries()) === del2, 'del=' + del2);
  check('IDEMP: 0 notificaciones nuevas', (await getNotifs()).length === notif2, 'notif=' + notif2);
  check('IDEMP: ledger intacto [v1,v3]',
    JSON.stringify(((await getLedger()) || []).slice().sort()) === JSON.stringify(['v1', 'v3']), '');

  // ══════════ SKIP (recordatorios_activos=false) ══════════
  await setUserRecordatorios(false);
  await setLedger([]);
  sent.length = 0;
  const del3 = await countDeliveries();
  await runCron();
  check('SKIP: 0 envíos con recordatorios_activos=false', sent.length === 0, 'capturados=' + sent.length);
  check('SKIP: 0 deliveries nuevas', (await countDeliveries()) === del3, 'del=' + del3);
  check('SKIP: ledger no se tocó (sigue [])', JSON.stringify(await getLedger()) === JSON.stringify([]), JSON.stringify(await getLedger()));
}

async function cleanup() {
  restoreClock();
  try {
    if (THROWAWAY_ID) {
      // baseline QA verificado: 0 deliveries tipo='deuda', 0 notifs deuda_vence → borrado seguro
      await supabase.from('notificaciones').delete().eq('usuario_id', QA_ID).eq('tipo', 'deuda_vence');
      await supabase.from('notification_deliveries').delete().eq('usuario_id', QA_ID).eq('tipo', 'deuda');
      await supabase.from('deudas').delete().eq('id', THROWAWAY_ID);
    }
    await supabase.from('usuarios').update({ recordatorios_activos: ORIG_RECORD }).eq('id', QA_ID);
    console.log('cleanup ok (recordatorios_activos restaurado a ' + ORIG_RECORD + ')');
  } catch (e) { console.log('CLEANUP WARN: ' + e.message); }
}

(async () => {
  let fatal = null;
  try { await main(); } catch (e) { fatal = e; console.log('FAIL excepción — ' + e.message); }
  await cleanup();
  const fallidos = results.filter(r => !r.pass);
  console.log('\n=== ' + (results.length - fallidos.length) + '/' + results.length + ' checks OK ===');
  if (fatal) console.log(fatal.stack);
  process.exit(fallidos.length === 0 && !fatal ? 0 : 1);
})();
