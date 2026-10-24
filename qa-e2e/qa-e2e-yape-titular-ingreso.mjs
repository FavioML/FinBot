// E2E: el "¡Yapeaste!" hacia el PROPIO usuario se registra como INGRESO (24-oct-2026).
//
// Caso de producción: un psicólogo recibía por WhatsApp los comprobantes de Yape de sus pacientes.
// La captura sale del celular de quien paga, dice "¡Yapeaste! S/120 Jaime Car*", y Vision la
// registraba como gasto. Ver lib/titular.js.
//
// Mismo pipeline que qa-e2e-registro-gasto-foto.mjs (webhook firmado en proceso, contra el
// working tree, Vision REAL y Supabase REAL), con el fixture yape-titular.png: el destinatario es
// "Camila Roj*" y el usuario QA se llama Camila Rojas. El control negativo (una captura a OTRA
// persona sigue siendo gasto) es el harness hermano, que se corre junto a este.
//
// Escribe 1 transacción y la borra. Cuesta 1 llamada Vision. Manual, fuera del canary.
//
// Correr:  node qa-e2e/qa-e2e-yape-titular-ingreso.mjs   (desde app/)  → exit 0 si pasa.

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { startWebhookHarness } from './webhook-harness.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const { esperaComprobante } = require(path.join(appRoot, 'lib/pro-payment.js'));

// Usuario QA (is_test_user=true → cero envíos reales a Meta). Ver reference_neto_qa_test_user.
const QA_ID = 'ded7e219-e5fd-4ff4-b5a3-3cd5cdffd172';
const QA_WHATSAPP = 'qa-test-dashboard';
const QA_NOMBRE = 'Camila Rojas';

const FIXTURE = path.join(here, 'fixtures', 'yape-titular.png');
const MONTO = 37.8;
const MONTO_STR = '37.80';
const FECHA_RECIBO = '2026-10-20';

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond, detail });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
  return !!cond;
};

// Las filas con el monto del fixture, de CUALQUIER tipo: si el arreglo falla la fila sale gasto,
// y el harness tiene que verla para decirlo (y para limpiarla).
async function filasDelRun(h) {
  const { data, error } = await h.supabase.from('transacciones')
    .select('id, monto, tipo, categoria, comercio, fecha')
    .eq('usuario_id', QA_ID).eq('monto', MONTO).order('id', { ascending: false });
  if (error) throw new Error('query transacciones: ' + error.message);
  return data || [];
}

async function run(h) {
  const { data: user } = await h.supabase.from('usuarios')
    .select('id, nombre, whatsapp, is_test_user, onboarding_paso, esperando_comprobante, comprobante_solicitado_at')
    .eq('id', QA_ID).single();
  if (!check('usuario QA existe, es de prueba y se llama ' + QA_NOMBRE,
    user?.is_test_user === true && user?.whatsapp === QA_WHATSAPP && user?.nombre === QA_NOMBRE,
    'nombre=' + user?.nombre)) return;

  if (esperaComprobante(user)) {
    await h.supabase.from('usuarios').update({ esperando_comprobante: false }).eq('id', QA_ID);
    user.esperando_comprobante = false;
  }
  if (!check('precondición: el usuario NO está esperando comprobante', esperaComprobante(user) === false)) return;

  let previas = await filasDelRun(h);
  if (previas.length) {
    await h.supabase.from('transacciones').delete().in('id', previas.map((r) => r.id));
    previas = await filasDelRun(h);
  }
  if (!check('precondición: sin filas previas con el monto del fixture', previas.length === 0)) return;

  const before = h.sent.length;
  const status = await h.postImage(FIXTURE, QA_WHATSAPP);
  check('el webhook acepta la imagen firmada', status === 200, 'status=' + status);

  const reply = (await h.waitForReply(before)).trim();
  console.log('\n--- respuesta al usuario ---\n' + reply + '\n');
  check('la confirmación dice INGRESO registrado, no gasto',
    /Ingreso registrado/i.test(reply) && !/Gasto registrado/i.test(reply), reply.slice(0, 60));
  check('la confirmación trae el monto exacto (S/ ' + MONTO_STR + ')', reply.includes(MONTO_STR));

  const filas = await filasDelRun(h);
  check('se insertó exactamente una transacción con el monto exacto', filas.length === 1, filas.length + ' filas');
  const row = filas[0];
  if (!row) return;
  check('la fila quedó como INGRESO (el efecto en DB, no el texto)', row.tipo === 'ingreso',
    'tipo=' + row.tipo + ' comercio=' + row.comercio + ' categoria=' + row.categoria);
  check('la fecha es la impresa en el recibo', row.fecha === FECHA_RECIBO, 'fecha=' + row.fecha);

  const { error: delErr } = await h.supabase.from('transacciones').delete().eq('id', row.id);
  check('se limpió la transacción de prueba', !delErr, delErr ? delErr.message : 'id=' + row.id);
}

const h = await startWebhookHarness();
let fatal = null;
try { await run(h); } catch (e) { fatal = e; console.log('FAIL excepción — ' + e.message); }
await h.close();

const fallidos = results.filter((r) => !r.pass);
console.log('\n=== ' + (results.length - fallidos.length) + '/' + results.length + ' checks OK ===');
if (fatal) console.log(fatal.stack);
process.exit(fallidos.length === 0 && !fatal ? 0 : 1);
