// E2E del loop núcleo del producto: registrar un gasto por lenguaje natural, punta
// a punta, por el webhook de WhatsApp REAL contra la Supabase real.
//
// Qué ejercita (todo el pipeline, sin mockear nada):
//   webhook firmado (HMAC) → limiter → webhook.js (branch text) → procesarMensajeLibre
//   → OpenAI Function Calling (clasifica register_transaction) → intent registrar_manual
//   → parsearRegistroManual + detectarCategoriaIA → guardarTransaccion → fila en `transacciones`
//   → string de confirmación "✅ S/… en <cat> > <subcat> · <fecha>" capturado.
//
// Veredicto BINARIO y sin falsos positivos:
//   - No confía solo en el texto: verifica el EFECTO en DB (la fila insertada).
//   - Monto ÚNICO por corrida (centavos aleatorios) → dedup_hash fresco → NUNCA
//     colisiona con una corrida previa dentro de la ventana de dedup, y permite
//     localizar y BORRAR exactamente la fila que creó este run (autolimpieza).
//   - No cubre frescura de deploy: corre el código del working tree en proceso
//     (eso es lo que hace fiable el veredicto). El deploy de Railway lo valida
//     backend-deploy-fresh, aparte.
//
// Escribe 1 transacción y la borra. Cuesta ~2 llamadas OpenAI (clasificación +
// categorización). NO es canariable por eso (escribe + $); es manual post-deploy.
//
// Correr:  node qa-e2e/qa-e2e-registro-gasto.mjs   (desde app/)  → exit 0 si pasa.

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { startWebhookHarness } from './webhook-harness.mjs';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { CATEGORIAS_VALIDAS } = require(path.join(appRoot, 'lib/constants.js'));
const { hoyPeru } = require(path.join(appRoot, 'lib/dates.js'));

// Usuario QA de prueba (is_test_user=true → cero envíos Meta reales). Ver
// reference_neto_qa_test_user. `whatsapp` es el identificador que espera el pipeline.
const QA_ID = 'ded7e219-e5fd-4ff4-b5a3-3cd5cdffd172';
const QA_WHATSAPP = 'qa-test-dashboard';

// Monto único: 50.10–50.99. Hace el dedup_hash irrepetible y sirve de ancla para
// localizar la fila exacta que creó este run.
const CENTS = 10 + Math.floor(Math.random() * 90);
const MONTO = 50 + CENTS / 100;
const MONTO_STR = MONTO.toFixed(2);
const MSG = `gasté ${MONTO_STR} soles en taxi`;

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond, detail });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
  return !!cond;
};

// Filas de este run: gasto del usuario QA con el monto único. Identidad ironclad,
// sin depender de created_at (que llega sin zona y se parsearía como local).
async function filasDelRun(h) {
  const { data, error } = await h.supabase.from('transacciones')
    .select('id, monto, tipo, categoria, subcategoria, fecha')
    .eq('usuario_id', QA_ID).eq('monto', MONTO).eq('tipo', 'gasto')
    .order('id', { ascending: false });
  if (error) throw new Error('query transacciones: ' + error.message);
  return data || [];
}

async function run(h) {
  // Sanity: el usuario QA existe y es de prueba (no vamos a ensuciar a un real).
  const { data: user } = await h.supabase.from('usuarios')
    .select('id, whatsapp, is_test_user, plan').eq('id', QA_ID).single();
  if (!check('usuario QA existe y es de prueba',
    user?.is_test_user === true && user?.whatsapp === QA_WHATSAPP,
    'whatsapp=' + user?.whatsapp + ' plan=' + user?.plan)) return;

  // Precondición: nadie más tiene ese monto único → lo que aparezca después lo creó
  // este run. Si por un run abortado quedó una fila, se limpia para no falsear.
  let antesRows = await filasDelRun(h);
  if (antesRows.length) {
    await h.supabase.from('transacciones').delete().in('id', antesRows.map((r) => r.id));
    antesRows = await filasDelRun(h);
  }
  if (!check('precondición: sin filas previas con el monto único', antesRows.length === 0,
    antesRows.length + ' filas residuales')) return;

  // ── Enviar el gasto por el webhook real ──────────────────────────────────────
  const before = h.sent.length;
  const status = await h.postText(MSG, QA_WHATSAPP);
  check('el webhook acepta el mensaje firmado', status === 200, 'status=' + status);

  const reply = (await h.waitForReply(before)).trim();
  console.log('\n--- respuesta al usuario ---\n' + reply + '\n');
  check('el usuario recibió respuesta', reply.length > 0, reply ? 'sí' : 'silencio en 60s');

  // ── Asertar el TEXTO de confirmación ─────────────────────────────────────────
  check('la confirmación empieza con ✅ y trae el monto exacto',
    /^✅/.test(reply) && reply.includes('S/' + MONTO_STR),
    'busca "S/' + MONTO_STR + '"');
  check('la confirmación nombra una categoría (formato "en <cat> > <sub>")',
    / en .+ > .+ · /.test(reply) || / en Ingresos · /.test(reply),
    reply.slice(0, 80));

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
  // "taxi" es inequívoco → Transporte. Blando (log), no rompe el veredicto: la
  // clasificación fina es del dominio del NLP agent CI, no de este E2E.
  if (row.categoria !== 'Transporte') {
    console.log('  (nota) "taxi" se categorizó como ' + row.categoria + ', no Transporte — revisar si se repite.');
  }

  // El texto y la DB deben coincidir en categoría. Se compara case-insensitive por
  // robustez, pero desde el fix de normalización el texto de WhatsApp ya muestra la
  // categoría persistida ("Transporte > Taxi"), no la cruda del parser ("transporte >
  // taxi"): texto y DB coinciden también en case. El invariante es la identidad
  // semántica; el case-insensitive es un colchón, no una excusa para divergir.
  check('el texto de confirmación coincide con la categoría persistida (semántica)',
    reply.toLowerCase().includes(row.categoria.toLowerCase()),
    'DB=' + row.categoria);

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
