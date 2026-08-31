// E2E del cron `checkResumenDeudasSemanal` (el resumen de deudas por correo, lunes 9am Lima).
//
// Hermano de `qa-cron-deudas.mjs`, y existe porque el 31-ago-2026 el correo se MUDÓ: dejó de
// salir uno por cada deuda —un usuario con 6 deudas activas recibió 4 correos en 11 segundos— y
// pasó a un resumen agrupado por persona. Aquel harness cubría el pipeline real del correo; al
// sacarle el canal, esa cobertura se quedó sin dueño. Este la recupera del lado nuevo.
//
// **Lo que sólo se puede afirmar acá.** `tests/cron/resumen-deudas-semanal.test.js` mockea
// `notificarUsuario` entero, así que puede probar la DECISIÓN (a quién, con qué texto, con qué
// flags) y no el CAMINO. Todo lo que vive del otro lado del chokepoint queda sin ejercitar:
//   · que el canal declarado (`SOLO_IN_APP` + `email`) produzca de verdad UNA fila de correo y
//     NINGUNA de WhatsApp en `notification_deliveries`, que es la fuente de verdad de entrega;
//   · que `claimInApp` escriba la campana ANTES y que el dedup lea esa misma fila;
//   · que el `tipo` nuevo (`deuda_resumen`) sea el que efectivamente se escribe, y no el del
//     cron vecino — de eso depende que los dos avisos del lunes no se maten entre sí.
//
// Aislamiento hermético (radio de daño = 0 aunque otros usuarios tengan deudas en ventana):
//   - Stub de `obtenerDeudasParaResumenSemanal`: llama a la query REAL y recorta al usuario QA,
//     igual que su hermano y por el mismo motivo (una copia a mano del `select` diverge; ya pasó
//     con `usuarios.plan` y las 9 aserciones fallaban sin nada roto en producción).
//   - Spy sobre `enviarWhatsapp` que CAPTURA todo intento (y lanza sólo ante un destino que no
//     sea el QA). Acá no es sólo aislamiento: capturar en vez de lanzar es lo que convierte "no
//     sale por WhatsApp" en una ASERCIÓN legible del veredicto, comprobada en el transporte y no
//     en el parámetro. Su hermano lanza porque allá el envío SÍ es el comportamiento correcto.
//   - Reloj pineado al próximo LUNES 09:05 Lima, que es el gate del cron.
//   - `is_test_user` del QA hace que ni Meta ni Resend reciban nada, pero las filas de
//     `notification_deliveries` se escriben igual (`skipped_test`).
//
// Aserciones: TRIGGER (una sola llamada para DOS deudas, el correo, cero WhatsApp, la campana con
// su tipo propio, y el cuerpo con las dos contrapartes adentro), IDEMPOTENCIA (re-run = no-op por
// el claim), SKIP (recordatorios_activos=false). Autolimpieza total.
//
// Correr:  node qa-e2e/qa-cron-deudas-semanal.mjs   (desde app/)  → exit 0 si todo pasa.

import 'dotenv/config';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { instalarGuard } from './lib/qa-guard.mjs';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const QA_ID = 'ded7e219-e5fd-4ff4-b5a3-3cd5cdffd172';
const QA_WHATSAPP = 'qa-test-dashboard';

const TIPO_ENTREGA = 'resumen_deudas_semanal';   // notification_deliveries.tipo
const TIPO_IN_APP = 'deuda_resumen';             // notificaciones.tipo
const TITULO = 'Tus deudas pendientes';

// ── Reloj pineado: el próximo LUNES a las 09:05 Lima ──────────────────────────────────────
//
// El gate del cron es `getDay() === 1 && getHours() === 9 && getMinutes() <= 14`. Se calcula el
// lunes en vez de fijar una fecha: una constante `'2026-08-31'` convierte este harness en algo
// que sólo puede pasar el día que se escribió, que es la clase `asercion-atada-al-calendario` de
// `docs/DEFECTOS.md`. Si hoy ES lunes, se usa hoy.
const RealDate = Date;
const todayLima = new RealDate().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
function sumarDiasISO(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new RealDate(RealDate.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
function diaSemanaISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new RealDate(RealDate.UTC(y, m - 1, d)).getUTCDay();
}
let LUNES = todayLima;
while (diaSemanaISO(LUNES) !== 1) LUNES = sumarDiasISO(LUNES, 1);
// Perú es UTC-5 todo el año (sin DST) → 14:05Z = 09:05 Lima.
const fixedMs = RealDate.parse(LUNES + 'T14:05:00.000Z');

// Las dos deudas del fixture, elegidas para que el agrupamiento sea observable: si el cron
// volviera a notificar por deuda, serían DOS avisos en vez de uno. Y son de tipos opuestos, así
// que el cuerpo tiene que traer los dos bloques.
const VENC_VENCIDA = sumarDiasISO(LUNES, -40);   // el tramo sin piso: vencida hace rato
const VENC_SEMANA = sumarDiasISO(LUNES, 3);      // dentro de los 7 días

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

// ── Spy de WhatsApp: acá cualquier envío es una regresión, no sólo uno a destino ajeno ──────
//
// El resumen declara `CANALES.SOLO_IN_APP`. Si alguien lo pasa a `AMBOS` —el default del
// producto, o sea el cambio más fácil de hacer sin querer— el usuario recibiría por WhatsApp el
// mismo contenido que ya sale deuda por deuda: la ráfaga que este cron vino a sacar, un nivel más
// arriba. Se captura en vez de lanzar para que el veredicto lo diga como aserción y no como
// excepción, que es más fácil de leer en el canary.
const sent = [];
const waPath = require.resolve(path.join(appRoot, 'lib/whatsapp.js'));
const waReal = require(waPath);
require.cache[waPath].exports = {
  ...waReal,
  enviarWhatsapp: async (to, msg, opts = {}) => {
    sent.push({ to, msg, opts });
    if (String(to) !== QA_WHATSAPP) throw new Error('GUARD: envío a destino no-QA: ' + to);
    return { ok: false, skipped: 'qa_harness' };
  },
};

const supabase = instalarGuard(require, path.join(appRoot, 'lib/db.js'));

// ── Stub del data-source: misma query real, scopeada al usuario QA ──────────────────────────
const debtsPath = require.resolve(path.join(appRoot, 'services/debts.js'));
const debtsReal = require(debtsPath);
require.cache[debtsPath].exports = {
  ...debtsReal,
  obtenerDeudasParaResumenSemanal: async () => {
    const todas = await debtsReal.obtenerDeudasParaResumenSemanal();
    return todas.filter((d) => d.usuario_id === QA_ID);
  },
};

// checks.js se requiere DESPUÉS de instalar los stubs (destructura en el require)
const { checkResumenDeudasSemanal } = require(path.join(appRoot, 'cron/checks.js'));

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
}

// Misma línea que su hermano entre "no se pudo medir" y "el cron dejó de disparar": lo que
// impide llegar a preguntar es exit 2; un TRIGGER rojo es exit 1 y es EL hallazgo.
class Inconcluso extends Error {}
const inconcluso = (motivo) => { throw new Inconcluso(motivo); };

let ORIG_RECORD = false;
let limpiezaFallo = null;
const SEMBRADAS = [];

async function setUserRecordatorios(val) {
  const { error } = await supabase.from('usuarios').update({ recordatorios_activos: val }).eq('id', QA_ID);
  if (error) throw error;
}
async function deliveries() {
  const { data, error } = await supabase.from('notification_deliveries')
    .select('canal, estado').eq('usuario_id', QA_ID).eq('tipo', TIPO_ENTREGA);
  if (error) throw error;
  return data || [];
}
async function notifs() {
  const { data, error } = await supabase.from('notificaciones')
    .select('titulo, tipo, mensaje, datos').eq('usuario_id', QA_ID).eq('tipo', TIPO_IN_APP);
  if (error) throw error;
  return data || [];
}
/** Borra la fila de la campana, que es el CLAIM del que vive el dedup. */
async function limpiarClaim() {
  const { error } = await supabase.from('notificaciones').delete().eq('usuario_id', QA_ID).eq('tipo', TIPO_IN_APP);
  if (error) throw error;
}
async function limpiarEntregas() {
  const { error } = await supabase.from('notification_deliveries').delete().eq('usuario_id', QA_ID).eq('tipo', TIPO_ENTREGA);
  if (error) throw error;
}
async function runCron() {
  installClock();
  try { await checkResumenDeudasSemanal(); }
  finally { restoreClock(); }
}

async function sembrar(over) {
  const { data, error } = await supabase.from('deudas').insert({
    usuario_id: QA_ID, estado: 'activa', moneda: 'PEN', recordatorios_enviados: [], ...over,
  }).select('id').single();
  if (error || !data) inconcluso('no se pudo sembrar la deuda throwaway: ' + (error?.message || 'sin fila'));
  SEMBRADAS.push(data.id);
  return data.id;
}

async function main() {
  const { data: orig, error: eLeer } = await supabase.from('usuarios')
    .select('recordatorios_activos, is_test_user, whatsapp, nombre, email, plan').eq('id', QA_ID).single();
  // supabase-js NO lanza: sin leer `error`, una caída se lee como "no había nada" y el harness
  // seguiría con `orig` undefined, fallando por la razón equivocada.
  if (eLeer || !orig) inconcluso('no se pudo leer al usuario QA (' + QA_ID + '): ' + (eLeer?.message || 'sin fila'));
  ORIG_RECORD = orig.recordatorios_activos ?? false;

  // Precondiciones de FIXTURE, no aserciones sobre el producto.
  if (orig.is_test_user !== true || orig.whatsapp !== QA_WHATSAPP) {
    inconcluso('el usuario QA dejó de ser un fixture válido (is_test_user=' + orig.is_test_user +
      ', whatsapp=' + orig.whatsapp + ')');
  }
  // Sin `plan='premium'` el cron lo saltea por el muro y los TRIGGER fallarían sin que haya nada
  // roto — la misma trampa de la fila parcial que ya costó las 9 aserciones del harness hermano.
  if (orig.plan !== 'premium') inconcluso('el usuario QA no es premium (plan=' + orig.plan + '): el muro lo saltea');
  // Y sin correo, el `to` sale null y la fila queda `skipped_no_email`: el harness pasaría por
  // el motivo equivocado, afirmando un canal apagado con cara de canal encendido.
  if (!orig.email) inconcluso('el usuario QA no tiene email: el canal de correo no se puede afirmar');
  check('QA user es fixture válido, premium y con correo', true, 'nombre=' + orig.nombre);

  await sembrar({ tipo: 'debo', contraparte: 'QA-SEM Tarjeta', monto_original: 800, monto_pendiente: 800, fecha_vencimiento: VENC_VENCIDA });
  await sembrar({ tipo: 'me_deben', contraparte: 'QA-SEM Rocio', monto_original: 300, monto_pendiente: 300, fecha_vencimiento: VENC_SEMANA });
  console.log('fixture: 2 deudas throwaway (' + VENC_VENCIDA + ' vencida, ' + VENC_SEMANA + ' esta semana), lunes pineado ' + LUNES);

  // ══════════ TRIGGER ══════════
  await setUserRecordatorios(true);
  await limpiarClaim();
  await limpiarEntregas();
  sent.length = 0;
  await runCron();

  const dels = await deliveries();
  // UNA sola fila para DOS deudas: es la aserción central del cambio. Si el cron volviera a
  // notificar por deuda serían dos, y el conteo exacto es lo único que lo delata (un `>= 1` lo
  // dejaría pasar).
  check('TRIGGER: 1 sola entrega para 2 deudas (agrupado por persona)',
    dels.length === 1, 'filas=' + dels.length + ' ' + JSON.stringify(dels.map((d) => d.canal)));
  check('TRIGGER: el canal es email', dels[0]?.canal === 'email', 'canal=' + dels[0]?.canal);

  // El estado depende del entorno y por eso se afirma el CONJUNTO: sin `RESEND_API_KEY` sale
  // `skipped_sin_proveedor`; con la key puesta, el `is_test_user` del QA lo corta con
  // `skipped_test`. Lo que NO puede pasar en ninguno de los dos es `sent`: sería un correo de
  // verdad a la casilla de pruebas.
  check('TRIGGER: el correo no salió de verdad (skipped_*, nunca sent)',
    ['skipped_sin_proveedor', 'skipped_test', 'skipped_no_email', 'skipped_sin_baja'].includes(dels[0]?.estado),
    'estado=' + dels[0]?.estado);

  // Comprobado en el TRANSPORTE, no en el parámetro: el resumen no puede salir por WhatsApp.
  check('TRIGGER: CERO envíos de WhatsApp (el toque fechado ya sale por ahí)',
    sent.length === 0, 'capturados=' + sent.length);

  const ns = await notifs();
  check('TRIGGER: 1 fila de campana con el tipo PROPIO', ns.length === 1, 'filas=' + ns.length);
  check('TRIGGER: titulo "' + TITULO + '"', ns[0]?.titulo === TITULO, 'titulo=' + ns[0]?.titulo);
  // El cuerpo es lo que prueba el AGRUPAMIENTO de verdad: una sola fila podría ser una sola
  // deuda si el cron se quedara con la primera. Las dos contrapartes adentro no.
  check('TRIGGER: el cuerpo trae las DOS deudas',
    !!ns[0]?.mensaje && ns[0].mensaje.includes('QA-SEM Tarjeta') && ns[0].mensaje.includes('QA-SEM Rocio'),
    JSON.stringify(ns[0]?.mensaje?.slice(0, 120)));
  // Y los dos bloques, que es la separación por lado. El markdown de WhatsApp lo saca
  // `sanitizarParaWeb`, así que acá van sin asteriscos.
  check('TRIGGER: separa "Debes" de "Te deben"',
    !!ns[0]?.mensaje && ns[0].mensaje.includes('Debes:') && ns[0].mensaje.includes('Te deben:'),
    '');
  // El tramo sin piso: la deuda de hace 40 días tiene que estar, y nombrada en pasado.
  check('TRIGGER: la deuda vencida hace 40 días entra, en pasado',
    !!ns[0]?.mensaje && /venci[oó] el/.test(ns[0].mensaje), '');

  // ══════════ IDEMPOTENCIA (el claim es el dedup) ══════════
  sent.length = 0;
  await runCron();
  const dels2 = await deliveries();
  const ns2 = await notifs();
  check('IDEMP: 0 entregas nuevas (dedup por la fila de la campana)', dels2.length === 1, 'filas=' + dels2.length);
  check('IDEMP: 0 filas de campana nuevas', ns2.length === 1, 'filas=' + ns2.length);

  // Y la contraprueba de que el dedup es el CLAIM y no otra cosa: borrada esa fila, vuelve a
  // salir. Sin esto, un cron que hubiera dejado de disparar por cualquier motivo pasaría la
  // idempotencia por vacuidad.
  await limpiarClaim();
  await limpiarEntregas();
  await runCron();
  check('IDEMP: sin la fila de la campana, vuelve a salir (el dedup es el claim)',
    (await deliveries()).length === 1 && (await notifs()).length === 1, '');

  // ══════════ SKIP (recordatorios_activos=false) ══════════
  await setUserRecordatorios(false);
  await limpiarClaim();
  await limpiarEntregas();
  sent.length = 0;
  await runCron();
  check('SKIP: 0 entregas con recordatorios_activos=false', (await deliveries()).length === 0, '');
  check('SKIP: 0 filas de campana', (await notifs()).length === 0, '');
}

async function cleanup() {
  restoreClock();
  try {
    await supabase.from('notificaciones').delete().eq('usuario_id', QA_ID).eq('tipo', TIPO_IN_APP);
    await supabase.from('notification_deliveries').delete().eq('usuario_id', QA_ID).eq('tipo', TIPO_ENTREGA);
    for (const id of SEMBRADAS) await supabase.from('deudas').delete().eq('id', id);
    await supabase.from('usuarios').update({ recordatorios_activos: ORIG_RECORD }).eq('id', QA_ID);
    console.log('cleanup ok (' + SEMBRADAS.length + ' deudas borradas, recordatorios_activos restaurado a ' + ORIG_RECORD + ')');
  } catch (e) { limpiezaFallo = e; console.log('CLEANUP WARN: ' + e.message); }
}

(async () => {
  let fatal = null;
  let infra = null;
  try { await main(); } catch (e) {
    if (e instanceof Inconcluso) { infra = e; console.log('INCONCLUSO — ' + e.message); }
    else { fatal = e; console.log('FAIL excepción — ' + e.message); }
  }
  // Corre siempre: si el aborto fue después de sembrar, las deudas throwaway quedaron en
  // PRODUCCIÓN y sacarlas importa más que el veredicto.
  await cleanup();

  const fallidos = results.filter((r) => !r.pass);
  console.log('\n=== ' + (results.length - fallidos.length) + '/' + results.length + ' checks OK ===');
  if (fatal) console.log(fatal.stack);

  // Mismo orden de precedencia que el harness hermano: un check rojo gana sobre el inconcluso, y
  // la limpieza fallida es exit 1 y no un warning suelto (quedan filas reales en producción).
  // `process.exitCode` y NO `process.exit()`: en Windows, salir con sockets keep-alive de fetch
  // abiertos devuelve 127 y el canary lo lee como fallo desconocido.
  if (fallidos.length || fatal) {
    console.log('==> REGRESIÓN (exit 1)');
    process.exitCode = 1;
  } else if (limpiezaFallo) {
    console.log('==> LIMPIEZA FALLIDA (exit 1): quedaron filas en producción — ' + limpiezaFallo.message);
    process.exitCode = 1;
  } else if (infra) {
    console.log('==> INCONCLUSO (exit 2) — ' + infra.message);
    process.exitCode = 2;
  } else {
    console.log('==> OK');
    process.exitCode = 0;
  }
})();
