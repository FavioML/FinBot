// E2E: la constancia de transferencia de BCP a nombre del PROPIO usuario no entra como gasto
// (04-nov-2026, DEFECTOS).
//
// Caso de producción: BCP le manda la "Constancia de Transferencia" también al beneficiario cuando
// quien paga anota su correo. El barrido de Gmail la registraba como gasto del beneficiario, con su
// propio nombre de comercio. Ver `beneficiarioEsElTitular` en services/parsers.js.
//
// Corre el barrido REAL (`escanearGmailYRegistrar`) en proceso contra el working tree, con Supabase
// REAL, el parser con OpenAI REAL y el usuario QA (is_test_user=true, "Camila Rojas"). Lo único
// stubeado es la lectura del buzón (no hay buzón de prueba con constancias de BCP), el `full_name`
// de Auth (la cuenta QA no entra con Google) y la tarjeta de WhatsApp, que se apaga con
// `enviarAlertas: false`. Dos correos en la misma corrida:
//   1. constancia con beneficiario "Rojas Castro Camila A."  → NO se registra
//   2. control: constancia con beneficiario "Torres Vega Mario A." → se registra como gasto
// Sin el control, un barrido que no registra nada pasaría el caso 1.
//
// Escribe a lo sumo 2 transacciones del usuario QA y las borra. Cuesta 2 llamadas a gpt-4o-mini
// (proyecto Neto Pruebas, `app/.env`). Manual, fuera del canary.
//
// Correr:  node qa-e2e/qa-e2e-gmail-constancia-titular.mjs   (desde app/)  → exit 0 si pasa.

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { instalarGuard, permitirUsuarioDePrueba } from './lib/qa-guard.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
require('dotenv').config({ path: path.join(appRoot, '.env'), quiet: true });

const QA_ID = 'ded7e219-e5fd-4ff4-b5a3-3cd5cdffd172';
const QA_NOMBRE = 'Camila Rojas';
const ID_TITULAR = 'qa-constancia-titular-1';
const ID_CONTROL = 'qa-constancia-control-1';
const ASUNTO = 'Constancia de Transferencia a Terceros BCP - Servicio de Notificaciones BCP';

const constancia = (beneficiario, monto, mensaje) =>
  `Constancia de Transferencia a Terceros BCP. Hola. Tu transferencia fue realizada con éxito. ` +
  `Monto transferido S/ ${monto}. Enviado a: ${beneficiario}. Cuenta destino: ***4521. ` +
  `Desde: Cuenta de Ahorros ***1180. Fecha y hora: 03 de noviembre de 2026 - 16:20. ` +
  `Número de operación: 7654321. Mensaje: ${mensaje}`;

const MENSAJES = [
  { id: ID_TITULAR, texto: constancia('Rojas Castro Camila A.', '41.30', 'sesion'), asunto: ASUNTO, fecha: '2026-11-03', recibidoEnMs: Date.now() },
  { id: ID_CONTROL, texto: constancia('Torres Vega Mario A.', '41.70', 'alquiler'), asunto: ASUNTO, fecha: '2026-11-03', recibidoEnMs: Date.now() },
];

// Stub del buzón y de la tarjeta de WhatsApp ANTES de cargar el barrido.
const stub = (rel, exports) => {
  const p = require.resolve(path.join(appRoot, rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
const gmailReal = require(path.join(appRoot, 'gmail.js'));
stub('gmail.js', { ...gmailReal, leerCorreosBancarios: async () => ({ error: null, mensajes: MENSAJES, salteados: 0 }) });

// La barrera envuelve el cliente compartido: el barrido escribe por `guardarTransaccion`, y lo que no
// sea del usuario QA se rechaza antes de llegar a la base.
const supabase = instalarGuard(require, path.join(appRoot, 'lib/db.js'));
await permitirUsuarioDePrueba(QA_ID);
// La cuenta QA entra con magic link, no con Google, así que su usuario de Auth no trae `full_name`, que
// es de donde el barrido saca el nombre del titular. Se simula SOLO esa lectura, y solo para ella.
const getUserByIdReal = supabase.auth.admin.getUserById.bind(supabase.auth.admin);
supabase.auth.admin.getUserById = async (id) => {
  const res = await getUserByIdReal(id);
  if (res?.data?.user) res.data.user.user_metadata = { ...(res.data.user.user_metadata || {}), full_name: QA_NOMBRE };
  return res;
};
const { escanearGmailYRegistrar } = require(path.join(appRoot, 'services/gmail-scanner.js'));

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
  return !!cond;
};

async function filasDelRun() {
  const { data, error } = await supabase.from('transacciones')
    .select('id, tipo, monto, comercio, gmail_msg_id')
    .eq('usuario_id', QA_ID).in('gmail_msg_id', [ID_TITULAR, ID_CONTROL]);
  if (error) throw new Error('query transacciones: ' + error.message);
  return data || [];
}

async function limpiar() {
  const filas = await filasDelRun();
  if (filas.length) {
    const { error } = await supabase.from('transacciones').delete().eq('usuario_id', QA_ID).in('id', filas.map((f) => f.id));
    if (error) throw new Error('limpieza: ' + error.message);
  }
}

async function run() {
  const { data: usuario, error } = await supabase.from('usuarios').select('*').eq('id', QA_ID).single();
  if (error) throw new Error('usuario QA: ' + error.message);
  if (!check('usuario QA existe, es de prueba y se llama ' + QA_NOMBRE,
    usuario.is_test_user === true && usuario.nombre === QA_NOMBRE, 'nombre=' + usuario.nombre)) return;

  await limpiar();
  if (!check('precondición: sin filas previas de esta corrida', (await filasDelRun()).length === 0)) return;

  await escanearGmailYRegistrar(usuario, { enviarAlertas: false });
  const filas = await filasDelRun();
  const titular = filas.filter((f) => f.gmail_msg_id === ID_TITULAR);
  const control = filas.filter((f) => f.gmail_msg_id === ID_CONTROL);
  console.log('\n--- filas escritas ---\n' + JSON.stringify(filas, null, 2) + '\n');

  check('la constancia a nombre de la usuaria NO se registró', titular.length === 0,
    titular.map((f) => f.tipo + ' ' + f.monto + ' ' + f.comercio).join(', '));
  check('control: la transferencia a un tercero SÍ se registró como gasto',
    control.length === 1 && control[0].tipo === 'gasto' && Number(control[0].monto) === 41.7,
    control.map((f) => f.tipo + ' ' + f.monto + ' ' + f.comercio).join(', ') || 'ninguna fila');
}

let code = 0;
try {
  await run();
} catch (e) {
  console.log('FAIL excepción: ' + e.message);
  code = 1;
} finally {
  try { await limpiar(); check('limpieza: no quedan filas de la corrida', (await filasDelRun()).length === 0); }
  catch (e) { console.log('FAIL limpieza: ' + e.message); code = 1; }
}
const fallos = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - fallos}/${results.length} PASS`);
process.exit(fallos || code ? 1 : 0);
