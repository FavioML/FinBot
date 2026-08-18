// Quinta medición: ¿es SEGURO consultar `extraerGastoSinIA` antes de rebotar?
//
// El rescate determinista ya existe y ya está en producción, pero en OTRA posición: hoy
// corre en el camino del 429, donde NO hay clasificador y tiene que bastarse solo. La
// propuesta es consultarlo también cuando el parser devuelve ok:false — o sea DESPUÉS de
// que el clasificador ya dijo `registrar_manual`.
//
// Sobre el pool de 510 casos, `extraerGastoSinIA` responde en 20 mensajes cuyo intent
// esperado NO es registrar_manual. Ese 5% es la cota SUPERIOR del daño: en la posición
// propuesta el rescate solo se dispara si ADEMÁS (a) el clasificador mandó el mensaje a
// registrar_manual y (b) el parser devolvió ok:false. Esta sonda mide esas dos condiciones
// sobre esos 20 mensajes exactos, que es el riesgo real y no la cota.
//
// Un mensaje que el clasificador manda a `eliminar_transaccion` nunca llega al rescate,
// por más que el extractor sepa leerle un monto.
//
// Read-only, cero DB. Correr:  node qa-e2e/probe-parser-montos-rescate.mjs   (desde app/)

import 'dotenv/config';
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (m) => require(path.join(appRoot, m));

process.env.META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || 'qa-probe-token';
process.env.META_PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID || 'qa-probe-phone';
process.env.META_APP_SECRET = process.env.META_APP_SECRET || 'qa-probe-secret';
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;

const logPath = require.resolve(path.join(appRoot, 'lib/logger.js'));
const logReal = require(logPath);
const mute = () => {};
require.cache[logPath].exports = { ...logReal, info: mute, warn: mute, error: mute, debug: mute, fatal: mute };

const { openai } = R('lib/ai.js');
const { mapToolToIntent } = R('handlers/neto-tools.js');
const { parsearRegistroManual } = R('services/parsers.js');
const { extraerGastoSinIA } = R('lib/nlp-guards.js');
const pool = R('tests/nlp/pool.js');

const FECHA = '2026-08-18';

async function capturarPromptClasificador() {
  const { startWebhookHarness } = await import('./webhook-harness.mjs');
  const llamadas = [];
  const createReal = openai.chat.completions.create.bind(openai.chat.completions);
  openai.chat.completions.create = async (params, ...rest) => { llamadas.push(params); return createReal(params, ...rest); };
  const h = await startWebhookHarness();
  const before = h.sent.length;
  await h.postText('cuanto gaste este mes', 'qa-test-dashboard');
  await h.waitForReply(before);
  await h.close();
  openai.chat.completions.create = createReal;
  const c = llamadas.find((p) => Array.isArray(p.tools) && p.tools.length && p.messages && p.messages[0]
    && p.messages[0].role === 'system'
    && /Analiza el mensaje del usuario y usa la herramienta mas adecuada/.test(p.messages[0].content));
  if (!c) throw new Error('no capturé la llamada del clasificador');
  return { system: c.messages[0].content, tools: c.tools, model: c.model, temperature: c.temperature };
}

async function clasificar(tpl, msg) {
  const res = await openai.chat.completions.create({
    model: tpl.model,
    messages: [{ role: 'system', content: tpl.system }, { role: 'user', content: msg }],
    tools: tpl.tools, tool_choice: 'auto', temperature: tpl.temperature,
  });
  const ch = res.choices[0];
  if (!ch.message.tool_calls || !ch.message.tool_calls.length) return 'desconocido';
  let args = {};
  try { args = JSON.parse(ch.message.tool_calls[0].function.arguments); } catch (e) { /* {} */ }
  return mapToolToIntent(ch.message.tool_calls[0].function.name, args).intencion;
}

// Los mensajes del pool donde el rescate responde y el intent esperado NO es registro.
const sospechosos = pool
  .filter((c) => c.intent !== 'registrar_manual' && extraerGastoSinIA(c.msg));

console.log('Rescate determinista — riesgo REAL vs. cota superior\n');
console.log('Cota superior (el extractor responde y el intent esperado no es registro): '
  + sospechosos.length + ' de ' + pool.filter((c) => c.intent !== 'registrar_manual').length + '\n');

const tpl = await capturarPromptClasificador();

const filas = [];
let peligrosos = 0;
for (const c of sospechosos) {
  const intencion = await clasificar(tpl, c.msg);
  let parserOk = null;
  if (intencion === 'registrar_manual') {
    let p;
    try { p = await parsearRegistroManual(c.msg, FECHA); } catch (e) { p = { ok: false }; }
    parserOk = !!(p.ok && p.monto > 0);
  }
  // El rescate se dispara solo si el clasificador mandó a registrar_manual Y el parser falló.
  const dispara = intencion === 'registrar_manual' && parserOk === false;
  if (dispara) peligrosos++;
  filas.push({ msg: c.msg, esperado: c.intent, intencion, parserOk, dispara, rescate: extraerGastoSinIA(c.msg) });
  console.log('  ' + (dispara ? 'DISPARA' : '  -    ') + '  ' + JSON.stringify(c.msg).padEnd(46)
    + ' esperado=' + String(c.intent).padEnd(22) + ' clasificó=' + intencion
    + (parserOk === null ? '' : '  parserOk=' + parserOk));
}

console.log('\n== RESUMEN ==');
console.log('  cota superior (solo el extractor):           ' + sospechosos.length);
console.log('  riesgo real (clasificador + parser fallado): ' + peligrosos);
const desviados = filas.filter((f) => f.intencion !== 'registrar_manual').length;
console.log('  el clasificador los mandó a otro intent:     ' + desviados);
const rescatados = filas.filter((f) => f.intencion === 'registrar_manual' && f.parserOk === true).length;
console.log('  llegaron a registro pero el parser SÍ leyó:  ' + rescatados);

fs.writeFileSync(path.join(appRoot, 'qa-e2e', 'out-parser-montos-rescate.json'), JSON.stringify(filas, null, 2));
console.log('\nDetalle -> qa-e2e/out-parser-montos-rescate.json');
