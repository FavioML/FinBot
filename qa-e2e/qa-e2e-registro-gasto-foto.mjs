// E2E del registro de gasto por FOTO (Vision), punta a punta, por el webhook real
// contra la Supabase real. Hermano de qa-e2e-registro-gasto.mjs (ese es el branch
// text; este es el branch image).
//
// Qué ejercita (todo el pipeline, con Vision REAL):
//   webhook firmado (HMAC) → limiter → webhook.js (branch `type === 'image'`)
//   → 2 fetch a graph.facebook.com STUBEADOS (metadata → {url}, luego bytes del
//     fixture) — ver postImage en webhook-harness.mjs
//   → GPT-4o Vision REAL parsea la captura de Yape → guardarTransaccion
//   → fila en `transacciones` → confirmación "📸 *Gasto registrado*" capturada.
//
// Camino NO-Pro: el usuario NO está esperando comprobante (el flujo Pro Yape, que
// enruta la misma captura como pago de suscripción, es otra sesión). Como
// precondición se fuerza y se asevera ese estado reusando el predicado real
// esperaComprobante() de lib/pro-payment.js.
//
// Fixture: qa-e2e/fixtures/yape-gasto.png — screenshot sintético de Yape con
// ground-truth conocido ("¡Yapeaste!" → gasto, S/ 23.45, "Pollería El Rancho",
// motivo "almuerzo" → categoría esperada Alimentación). Monto FIJO: el dedup manual
// es ventana de 10s (services/transactions.js), así que un monto fijo + limpieza
// previa no colisiona entre corridas. Regenerar: node qa-e2e/fixtures/render-yape.mjs
//
// Veredicto BINARIO y sin falso positivo: no confía solo en el texto — verifica el
// EFECTO en DB (la fila insertada con el monto exacto, tipo y categoría válida).
//
// Escribe 1 transacción y la borra. Cuesta 1 llamada Vision (GPT-4o). NO es
// canariable por eso (escribe + $); es manual post-deploy.
//
// Correr:  node qa-e2e/qa-e2e-registro-gasto-foto.mjs   (desde app/)  → exit 0 si pasa.

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { startWebhookHarness } from './webhook-harness.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const { CATEGORIAS_VALIDAS } = require(path.join(appRoot, 'lib/constants.js'));
const { hoyPeru } = require(path.join(appRoot, 'lib/dates.js'));
const { esperaComprobante } = require(path.join(appRoot, 'lib/pro-payment.js'));

// Usuario QA de prueba, Pro (is_test_user=true → cero envíos Meta reales). Ver
// reference_neto_qa_test_user.
const QA_ID = 'ded7e219-e5fd-4ff4-b5a3-3cd5cdffd172';
const QA_WHATSAPP = 'qa-test-dashboard';

// Ground-truth del fixture yape-gasto.png.
const FIXTURE = path.join(here, 'fixtures', 'yape-gasto.png');
const MONTO = 23.45;
const MONTO_STR = MONTO.toFixed(2); // "23.45"
const COMERCIO = 'Pollería El Rancho';

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond, detail });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
  return !!cond;
};

// Filas de este run: gasto del usuario QA con el monto del fixture. Ancla ironclad
// para localizar y borrar exactamente lo que creó este run.
async function filasDelRun(h) {
  const { data, error } = await h.supabase.from('transacciones')
    .select('id, monto, tipo, categoria, subcategoria, fecha')
    .eq('usuario_id', QA_ID).eq('monto', MONTO).eq('tipo', 'gasto')
    .order('id', { ascending: false });
  if (error) throw new Error('query transacciones: ' + error.message);
  return data || [];
}

async function run(h) {
  // ── Precondición 1: usuario QA de prueba ────────────────────────────────────
  const { data: user } = await h.supabase.from('usuarios')
    .select('id, whatsapp, is_test_user, plan, onboarding_paso, esperando_comprobante, comprobante_solicitado_at')
    .eq('id', QA_ID).single();
  if (!check('usuario QA existe y es de prueba',
    user?.is_test_user === true && user?.whatsapp === QA_WHATSAPP,
    'whatsapp=' + user?.whatsapp + ' plan=' + user?.plan)) return;

  // ── Precondición 2: camino NO-Pro (usuario NO esperando comprobante) ─────────
  // Si un test previo dejó el flag stale, se resetea para probar el branch correcto.
  if (esperaComprobante(user)) {
    await h.supabase.from('usuarios')
      .update({ esperando_comprobante: false }).eq('id', QA_ID);
    const { data: u2 } = await h.supabase.from('usuarios')
      .select('onboarding_paso, esperando_comprobante, comprobante_solicitado_at')
      .eq('id', QA_ID).single();
    user.onboarding_paso = u2?.onboarding_paso;
    user.esperando_comprobante = u2?.esperando_comprobante;
    user.comprobante_solicitado_at = u2?.comprobante_solicitado_at;
  }
  if (!check('precondición: el usuario NO está esperando comprobante (camino NO-Pro)',
    esperaComprobante(user) === false,
    'onboarding_paso=' + user?.onboarding_paso + ' esperando_comprobante=' + user?.esperando_comprobante)) return;

  // ── Precondición 3: sin filas residuales con el monto del fixture ────────────
  let antesRows = await filasDelRun(h);
  if (antesRows.length) {
    await h.supabase.from('transacciones').delete().in('id', antesRows.map((r) => r.id));
    antesRows = await filasDelRun(h);
  }
  if (!check('precondición: sin filas previas con el monto del fixture', antesRows.length === 0,
    antesRows.length + ' filas residuales')) return;

  // ── Enviar la FOTO por el webhook real ───────────────────────────────────────
  const before = h.sent.length;
  const status = await h.postImage(FIXTURE, QA_WHATSAPP);
  check('el webhook acepta la imagen firmada', status === 200, 'status=' + status);

  const reply = (await h.waitForReply(before)).trim();
  console.log('\n--- respuesta al usuario ---\n' + reply + '\n');
  check('el usuario recibió respuesta', reply.length > 0, reply ? 'sí' : 'silencio en 60s');

  // ── Asertar el TEXTO de confirmación ─────────────────────────────────────────
  check('la confirmación es de gasto registrado por foto (📸)',
    /^📸/.test(reply) && /Gasto registrado/i.test(reply),
    reply.slice(0, 60));
  check('la confirmación trae el monto exacto del fixture (S/ ' + MONTO_STR + ')',
    reply.includes('S/ ' + MONTO_STR) || reply.includes('S/' + MONTO_STR),
    'busca "' + MONTO_STR + '"');

  // ── Asertar el EFECTO en DB (lo que blinda contra falso positivo) ────────────
  const despuesRows = await filasDelRun(h);
  check('se insertó exactamente una transacción con el monto exacto',
    despuesRows.length === 1,
    despuesRows.length + ' filas (esperaba 1)');
  const row = despuesRows[0];
  if (!row) return;

  check('la fila quedó como gasto con fecha de hoy (Perú)',
    row.tipo === 'gasto' && row.fecha === hoyPeru(),
    'tipo=' + row.tipo + ' fecha=' + row.fecha + ' hoy=' + hoyPeru());
  check('la categoría persistida es una categoría válida del backend',
    !!row.categoria && CATEGORIAS_VALIDAS.has(row.categoria),
    'categoria=' + row.categoria + ' > ' + row.subcategoria);
  // "Pollería" + motivo "almuerzo" es inequívoco → Alimentación. Blando (log), no
  // rompe el veredicto: la clasificación fina es del dominio del NLP, no de este E2E.
  if (row.categoria !== 'Alimentación') {
    console.log('  (nota) el fixture de pollería se categorizó como ' + row.categoria + ', no Alimentación — revisar si se repite.');
  }

  // ── Autolimpieza ─────────────────────────────────────────────────────────────
  const { error: delErr } = await h.supabase.from('transacciones').delete().eq('id', row.id);
  check('se limpió la transacción de prueba', !delErr, delErr ? delErr.message : 'id=' + row.id + ' borrado');
}

const h = await startWebhookHarness();
let fatal = null;
try { await run(h); } catch (e) { fatal = e; console.log('FAIL excepción — ' + e.message); }
await h.close();

const fallidos = results.filter((r) => !r.pass);
console.log('\n=== ' + (results.length - fallidos.length) + '/' + results.length + ' checks OK ===');
if (fatal) console.log(fatal.stack);
process.exit(fallidos.length === 0 && !fatal ? 0 : 1);
