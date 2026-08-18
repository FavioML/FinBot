// Sonda de medición: ¿POR DÓNDE sale cada uno de los 20 mensajes reales que recibieron
// "No pude extraer el monto"? Separa las tres hipótesis del prompt de la sesión:
//
//   H1 el clasificador maestro nunca mandó el mensaje a registrar_manual
//   H2 el pre-check (tienePatronGasto / detectarQuerySinMonto) lo desvió a una query
//   H3 parsearRegistroManual (gpt-4o-mini) no devolvió monto
//
// Read-only: no escribe una sola fila. No usa el webhook para medir; recorre EN ORDEN los
// mismos filtros que atraviesa un mensaje de texto en procesarMensajeLibre, usando las
// funciones REALES del working tree. El único trozo que no es una función exportada es el
// system prompt del clasificador (está inline en message-processor.js): se CAPTURA de una
// corrida real por el webhook, no se transcribe, para que no derive del código.
//
// Costo: 2 llamadas gpt-4o-mini por caso (clasificación + parser) + 1 corrida de captura.
//
// Correr:  node qa-e2e/probe-parser-montos.mjs   (desde app/)

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

// Silenciar el logger: la sonda imprime su propia tabla.
const logPath = require.resolve(path.join(appRoot, 'lib/logger.js'));
const logReal = require(logPath);
const mute = () => {};
require.cache[logPath].exports = { ...logReal, info: mute, warn: mute, error: mute, debug: mute, fatal: mute };

const { openai } = R('lib/ai.js');
const { mapToolToIntent } = R('handlers/neto-tools.js');
const { detectarMultiGasto, detectarIngresoMasGastos } = R('services/multi-gasto-detector.js');
const { detectarQuerySinMonto } = R('handlers/intents/transacciones.js');
const { parsearRegistroManual } = R('services/parsers.js');
const { extraerGastoSinIA } = R('lib/nlp-guards.js');

// El regex del pre-check vive inline en el handler, no exportado. Se LEE del archivo y se
// recompila con `new RegExp` (no `eval`): si alguien lo edita, la sonda usa el nuevo en vez
// de una copia que envejece. Si el literal ya no está donde se espera, aborta.
const srcTx = fs.readFileSync(path.join(appRoot, 'handlers/intents/transacciones.js'), 'utf8');
const srcMP = fs.readFileSync(path.join(appRoot, 'handlers/message-processor.js'), 'utf8');
const mPat = srcTx.match(/const tienePatronGasto = \/(.*)\/([a-z]*)\.test\(msg \|\| ''\)/);
if (!mPat) { console.error('ABORT: no encontré el literal de tienePatronGasto en transacciones.js'); process.exit(2); }
const RE_PATRON_GASTO = new RegExp(mPat[1], mPat[2]);

// Los 20 casos medidos el 2026-08-17 (`conversaciones` ya purgó 3 de ellos).
// fecha = el día en que la persona lo escribió (hora Perú), para que los guards de fecha
// y el prompt del parser vean el mismo "hoy" que vieron ese día.
const CASOS = [
  { uid: 'fb6e9ef4', msg: 'Gasté 1.5 en Movilidad', fecha: '2026-08-17' },
  { uid: 'fb6e9ef4', msg: 'Gasté 2.5 en Movilidad', fecha: '2026-08-17' },
  { uid: 'fb6e9ef4', msg: '11.30 para Snack', fecha: '2026-08-17' },
  { uid: 'fb6e9ef4', msg: 'suscripción de DIRECTV por el mes de julio', fecha: '2026-08-13' },
  { uid: '77c40c95', msg: 'Gasté 14.8 Alimentos', fecha: '2026-08-14' },
  { uid: '77c40c95', msg: 'Gaste 2.5 transporte', fecha: '2026-08-13' },
  { uid: '95aaa7dd', msg: '4 en pan y maca', fecha: '2026-08-11' },
  { uid: '250c9267', msg: 'Carne, ciento noventa y ocho punto setenta.', fecha: '2026-08-07' },
  { uid: '250c9267', msg: 'Carne, ciento diez punto setenta.', fecha: '2026-08-07' },
  { uid: '500f5643', msg: 'En mi cuenta de ahorros de BCP en soles tengo 1045.21 soles', fecha: '2026-08-05' },
  { uid: 'bd3552b0', msg: 'Pancito Chapala 3 \nQueso fresco 6.24 \nYogurt la Molina 11', fecha: '2026-07-27' },
  { uid: 'dcbfb181', msg: 'Pago de NPS a nombre de JB de 102', fecha: '2026-07-13' },
  { uid: 'e4332f63', msg: 'Caramelos 2.50 soles', fecha: '2026-06-22' },
  { uid: 'd9dcdc25', msg: 'Gaste 2 en snack', fecha: '2026-06-13' },
  { uid: '8693a755', msg: '10 comida', fecha: '2026-06-02' },
  { uid: '8ae683a5', msg: 'Eso lo tengo yape 156.40 y Plin 100', fecha: '2026-04-13' },
  { uid: '8ae683a5', msg: 'Yo gano al mes cada 05 487.50', fecha: '2026-04-13' },
  { uid: 'ed45226e', msg: 'Agrega 120 a comida', fecha: '2026-03-28' },
  { uid: 'ef9be664', msg: '592.91', fecha: '2026-08-01' },
  { uid: 'a18944c4', msg: 'El día 25 de julio de 2026', fecha: '2026-08-01' },
];

// CONTROLES: mensajes de los MISMOS usuarios que SÍ entraron, del mismo día o vecino.
// Sin esto no hay forma de saber si un fallo es del mensaje o del pipeline entero.
const CONTROLES = [
  { uid: '77c40c95', msg: 'Gasté 13 almuerzo', fecha: '2026-08-14', esperado: 'OK' },
  { uid: '77c40c95', msg: 'Gasté 3 transporte bus', fecha: '2026-08-14', esperado: 'OK' },
  { uid: '77c40c95', msg: 'Gasté 9.40 taxi', fecha: '2026-08-13', esperado: 'OK' },
  { uid: '8693a755', msg: '8 taxi', fecha: '2026-06-01', esperado: 'OK' },
  { uid: '250c9267', msg: 'Gasté en carne ciento diez punto setenta soles.', fecha: '2026-08-07', esperado: 'OK' },
  { uid: 'fb6e9ef4', msg: '280 en lavado de cortinas de la casa', fecha: '2026-08-17', esperado: 'OK' },
  { uid: '95aaa7dd', msg: 'gasté 20 en taxi', fecha: '2026-08-11', esperado: 'OK' },
];

// Las etiquetas de mes que usa el clasificador NO son los nombres completos: son el array
// `mE` de message-processor.js, que abrevia todo menos Enero. Se lee del archivo para que la
// sonda no invente un mes que el modelo nunca vio.
const mME = srcMP.match(/const mE = (\[[^\]]*\]);/);
if (!mME) { console.error('ABORT: no encontre el array mE en message-processor.js'); process.exit(2); }
const MESES = JSON.parse(mME[1].replace(/'/g, '"'));

// Captura del system prompt real del clasificador: se espía openai.chat.completions.create
// y se corre UN mensaje de LECTURA por el webhook real (no escribe ninguna fila).
async function capturarPromptClasificador() {
  const { startWebhookHarness } = await import('./webhook-harness.mjs');
  const llamadas = [];
  const createReal = openai.chat.completions.create.bind(openai.chat.completions);
  openai.chat.completions.create = async (params, ...rest) => { llamadas.push(params); return createReal(params, ...rest); };
  const h = await startWebhookHarness();
  const before = h.sent.length;
  // 'hola' NO sirve de sonda: el saludo se resuelve antes de OpenAI y no hay llamada que
  // capturar. Esta consulta es de LECTURA (no escribe ninguna fila) y sí pasa por el clasificador.
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

// Reescribe la 1ª línea del prompt capturado con el mes/fecha/nombre/plan del caso.
// Si alguna sustitución no aplica, aborta: un prompt a medio ajustar mide otra cosa.
function ajustarPrompt(system, { fecha, nombre, plan }) {
  const y = Number(fecha.slice(0, 4));
  const mo = Number(fecha.slice(5, 7));
  let out = system;
  const subs = [
    [/El mes actual es \w+ \d{4}\./, 'El mes actual es ' + MESES[mo] + ' ' + y + '.'],
    [/Hoy es \d{4}-\d{2}-\d{2}\./, 'Hoy es ' + fecha + '.'],
    [/El usuario se llama .*? \(plan: .*?\)\./, 'El usuario se llama ' + nombre + ' (plan: ' + plan + ').'],
  ];
  for (const [re, rep] of subs) {
    if (!re.test(out)) throw new Error('sustitución no aplicó: ' + re);
    out = out.replace(re, rep);
  }
  return out;
}

async function clasificar(tpl, caso, historial) {
  const res = await openai.chat.completions.create({
    model: tpl.model,
    messages: [
      { role: 'system', content: ajustarPrompt(tpl.system, caso) },
      ...historial.slice(-4).map((h) => ({ role: h.rol === 'neto' ? 'assistant' : 'user', content: h.mensaje.substring(0, 200) })),
      { role: 'user', content: caso.msg },
    ],
    tools: tpl.tools,
    tool_choice: 'auto',
    temperature: tpl.temperature,
  });
  const choice = res.choices[0];
  if (!choice.message.tool_calls || !choice.message.tool_calls.length) {
    return { intencion: choice.message.content ? '(texto libre)' : 'desconocido', datos: {} };
  }
  const tc = choice.message.tool_calls[0];
  let args = {};
  try { args = JSON.parse(tc.function.arguments); } catch (e) { /* args inválidos = {} */ }
  return Object.assign({}, mapToolToIntent(tc.function.name, args), { tool: tc.function.name });
}

// Recorre los mismos filtros, en el mismo orden, que atraviesa el mensaje real.
async function medir(tpl, caso, historial) {
  const out = { uid: caso.uid, msg: caso.msg, fecha: caso.fecha };

  if (detectarIngresoMasGastos(caso.msg)) { out.salida = 'PRE:ingreso_mas_gastos'; return out; }
  const mg = detectarMultiGasto(caso.msg);
  if (mg && mg.length >= 2) { out.salida = 'PRE:multi_gasto(' + mg.length + ')'; return out; }

  const cls = await clasificar(tpl, caso, historial);
  out.intencion = cls.intencion;
  out.tool = cls.tool;
  if (cls.intencion !== 'registrar_manual') { out.salida = 'H1:clasificador->' + cls.intencion; return out; }

  out.patron = RE_PATRON_GASTO.test(caso.msg || '');
  if (!out.patron) {
    const rPre = detectarQuerySinMonto(caso.msg);
    if (rPre) { out.salida = 'H2:redirect_pre->' + rPre.intencion; return out; }
  }

  let parsed;
  try { parsed = await parsearRegistroManual(caso.msg, caso.fecha); }
  catch (e) { out.salida = 'EXCEPCION_PARSER: ' + e.message; return out; }
  out.parserOk = !!(parsed.ok && parsed.monto > 0);
  out.monto = parsed.monto;
  if (!out.parserOk) {
    const r = detectarQuerySinMonto(caso.msg);
    out.salida = r ? 'H3+redirect_post->' + r.intencion : 'H3:parser_sin_monto -> REBOTE';
    out.salvable = !!extraerGastoSinIA(caso.msg);
    return out;
  }
  out.salida = 'OK monto=' + parsed.monto + ' ' + (parsed.moneda || '') + ' ' + (parsed.tipo || '');
  return out;
}

// ── main ────────────────────────────────────────────────────────────────────
const { instalarGuard } = await import('./lib/qa-guard.mjs');
const supabase = instalarGuard(require, path.join(appRoot, 'lib/db.js'));

const uids = [...new Set([].concat(CASOS, CONTROLES).map((c) => c.uid))];
const { data: users } = await supabase.from('usuarios').select('id, nombre, plan, tipo_plan');
const perfil = {};
for (const u of users || []) {
  const s = u.id.slice(0, 8);
  if (uids.includes(s)) perfil[s] = { nombre: u.nombre || 'amigo', plan: u.tipo_plan || u.plan || 'free', id: u.id };
}

// Historial real: los 4 turnos previos al mensaje, del mismo usuario.
async function historialDe(caso) {
  const p = perfil[caso.uid];
  if (!p) return [];
  const { data } = await supabase.from('conversaciones')
    .select('id, rol, mensaje').eq('usuario_id', p.id)
    .lt('created_at', caso.fecha + 'T23:59:59Z')
    .order('id', { ascending: false }).limit(4);
  return (data || []).reverse();
}

console.log('Capturando el system prompt real del clasificador...');
const tpl = await capturarPromptClasificador();
console.log('  prompt capturado: ' + tpl.system.length + ' chars, ' + tpl.tools.length + ' tools, modelo ' + tpl.model);
const faltan = uids.filter((u) => !perfil[u]);
if (faltan.length) console.log('  sin perfil en `usuarios` (nombre/plan default, historial vacio): ' + faltan.join(', '));

const filas = [];
for (const par of [['CASO', CASOS], ['CTRL', CONTROLES]]) {
  const etiqueta = par[0];
  console.log('\n== ' + (etiqueta === 'CASO' ? 'LOS 20 REBOTES' : 'CONTROLES (mensajes que SI entraron)') + ' ==');
  for (const caso of par[1]) {
    const p = perfil[caso.uid] || { nombre: 'amigo', plan: 'free' };
    const hist = await historialDe(caso);
    const r = await medir(tpl, Object.assign({}, caso, { nombre: p.nombre, plan: p.plan }), hist);
    r.tipo = etiqueta;
    r.esperado = caso.esperado || 'REBOTE';
    r.hist = hist.length;
    filas.push(r);
    console.log((etiqueta === 'CTRL' ? '. ' : '  ') + caso.uid + '  '
      + JSON.stringify(caso.msg).padEnd(54) + ' hist=' + hist.length + '  -> ' + r.salida);
  }
}

const rebotes = filas.filter((f) => f.tipo === 'CASO');
const porH = {};
for (const f of rebotes) { const k = f.salida.split(/[:(]/)[0]; porH[k] = (porH[k] || 0) + 1; }
console.log('\n== RESUMEN (20 rebotes, reproducidos contra el codigo de HOY) ==');
for (const e of Object.entries(porH).sort((a, b) => b[1] - a[1])) console.log('  ' + e[0].padEnd(8) + ' ' + e[1]);
const ctrl = filas.filter((f) => f.tipo === 'CTRL');
console.log('  controles OK: ' + ctrl.filter((f) => f.salida.startsWith('OK')).length + '/' + ctrl.length);

fs.writeFileSync(path.join(appRoot, 'qa-e2e', 'out-parser-montos.json'), JSON.stringify(filas, null, 2));
console.log('\nDetalle -> qa-e2e/out-parser-montos.json');
