// Aceptación del clasificador con `tema` en `social_response` (chip 2 de la tanda "respuestas
// malas del día 0", 30-sep-2026): las preguntas sobre Neto tienen que caer cada una en su tema, y
// el resto de los intents no se puede mover.
//
// Un prompt no se mata por mutación: los tests mockean OpenAI. Esta sonda llama al modelo REAL
// con el system prompt y las tools de cada versión, sin historial (en frío, como el NLP agent):
//
//   el system prompt se extrae del fuente de `handlers/message-processor.js` (el literal que
//   empieza en `content: 'Eres NETO` y termina en `sin_categoria.'`) y se evalúa con un usuario
//   y una fecha fijos; las tools salen de `handlers/neto-tools.js` del mismo commit.
//
// Configuraciones, todas sobre los mismos mensajes:
//   ref-auto   la versión de `--contra <ref>` (default HEAD) con tool_choice 'auto' = producción
//   act-auto   el árbol de trabajo con 'auto'
//   act-req    el árbol de trabajo con 'required'
// `act-auto` contra `act-req` aísla el efecto de tool_choice; `ref-auto` contra el que se
// despliegue mide el cambio entero.
//
// Baterías:
//   reales     las preguntas de producción (60 días al 30-sep). Esperado fijo: N de N.
//   parafrasis formas que NO están escritas en el prompt (los ejemplos del prompt son otros, a
//              propósito: si la sonda midiera los mismos textos que el prompt cita, mediría la
//              memoria del modelo). Esperado fijo, se reporta la tasa.
//   controles  mensajes que NO son preguntas sobre Neto y no pueden caer en `ayuda`.
//   pool       los casos de `tests/nlp/pool.js` (N=1). Regresión = la referencia acierta la
//              etiqueta del pool y la versión nueva no.
//
// Read-only, cero DB. Correr desde app/:
//   node qa-e2e/probe-ayuda-temas.mjs [--n 2] [--contra HEAD] [--solo reales|parafrasis|controles|pool]
// Exit 1 si una pregunta real no cae N de N en su tema con la configuración elegida
// (`--elegida act-req|act-auto`, default act-req), o si en el pool empeoran MÁS casos de los que
// mejoran. No se exige cero: con N=1 el pool se mueve solo entre corridas (la misma configuración
// dio entre 471 y 478 aciertos el 30-sep, con 5 a 7 casos distintos cada vez), así que un cero
// sería una vara que la referencia tampoco pasa contra sí misma.

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const N = Number(arg('--n', 2));
const CONTRA = arg('--contra', 'HEAD');
const SOLO = arg('--solo', null);
const ELEGIDA = arg('--elegida', 'act-req');
const CONCURRENCIA = 6;

const { openai } = require(path.join(appRoot, 'lib/ai.js'));

// ─── Las dos versiones ────────────────────────────────────────────────────────
function systemPromptDe(src) {
  const a = src.indexOf("content: 'Eres NETO");
  const fin = "sin_categoria.'";
  const b = src.indexOf(fin, a) + fin.length;
  if (a < 0 || b < fin.length) throw new Error('No encontré el system prompt del clasificador en message-processor.js');
  const expr = src.slice(a + 'content: '.length, b);
  const mE = ['', 'Enero', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  const mesActual = 9, anioActual = 2026, hoyPeru = () => '2026-09-30';
  const usuario = { nombre: 'Ana' }, planUsuario = 'premium';
  // eval sobre el fuente de ESTE repo (el árbol o un commit propio), en una sonda local: es la
  // única forma de obtener el prompt exacto sin duplicarlo acá, que es como envejecen las copias.
  // eslint-disable-next-line no-eval
  return eval(expr);
}

// La copia de la referencia va al directorio temporal, NUNCA dentro del repo (mismo motivo que
// probe-parser-decision.mjs: una copia en `handlers/` quedaba a un `git add -A` de un commit).
const temporales = [];
function toolsDeRef(ref) {
  const src = execFileSync('git', ['show', `${ref}:handlers/neto-tools.js`], { cwd: appRoot, encoding: 'utf8' });
  const p = path.join(os.tmpdir(), `neto-tools-ref-${process.pid}.cjs`);
  fs.writeFileSync(p, src);
  temporales.push(p);
  return require(p);
}
const limpiar = () => { for (const p of temporales) if (fs.existsSync(p)) fs.unlinkSync(p); };
process.on('exit', limpiar);
process.on('SIGINT', () => { limpiar(); process.exit(130); });

const ref = {
  system: systemPromptDe(execFileSync('git', ['show', `${CONTRA}:handlers/message-processor.js`], { cwd: appRoot, encoding: 'utf8' })),
  ...toolsDeRef(CONTRA),
};
const act = {
  system: systemPromptDe(fs.readFileSync(path.join(appRoot, 'handlers/message-processor.js'), 'utf8')),
  ...require(path.join(appRoot, 'handlers/neto-tools.js')),
};
const CONFIGS = {
  'ref-auto': { v: ref, toolChoice: 'auto' },
  'act-auto': { v: act, toolChoice: 'auto' },
  'act-req': { v: act, toolChoice: 'required' },
};

// ─── Clasificar ───────────────────────────────────────────────────────────────
async function clasificar(cfg, msg) {
  for (let intento = 0; intento < 5; intento++) {
    try {
      const res = await openai.chat.completions.create({
        model: 'gpt-4o-mini', temperature: 0,
        tools: cfg.v.NETO_TOOLS, tool_choice: cfg.toolChoice,
        messages: [{ role: 'system', content: cfg.v.system }, { role: 'user', content: msg }],
      });
      const m = res.choices[0].message;
      if (!m.tool_calls || !m.tool_calls.length) return 'TEXTO';
      const t = m.tool_calls[0];
      let a = {};
      try { a = JSON.parse(t.function.arguments); } catch { /* args rotos: se mapea igual */ }
      const { intencion, datos } = cfg.v.mapToolToIntent(t.function.name, a);
      return intencion === 'ayuda' ? 'ayuda/' + (datos.tema || '-') : intencion;
    } catch (e) {
      if (/429|rate/i.test(e.message)) { await new Promise((r) => setTimeout(r, 2000 * (intento + 1))); continue; }
      return 'ERR:' + e.message.slice(0, 40);
    }
  }
  return 'ERR:429';
}

async function enParalelo(tareas) {
  const out = new Array(tareas.length);
  let i = 0;
  await Promise.all(Array.from({ length: CONCURRENCIA }, async () => {
    while (i < tareas.length) { const k = i++; out[k] = await tareas[k](); }
  }));
  return out;
}

async function correr(cfgNombre, mensajes, n) {
  const cfg = CONFIGS[cfgNombre];
  const tareas = [];
  for (const m of mensajes) for (let r = 0; r < n; r++) tareas.push(() => clasificar(cfg, m));
  const plano = await enParalelo(tareas);
  return mensajes.map((_, k) => plano.slice(k * n, (k + 1) * n));
}

// ─── Baterías ─────────────────────────────────────────────────────────────────
// `esp` acepta alternativas con '|'. Las preguntas reales llevan el texto tal cual llegó.
const REALES = [
  { msg: 'Te puedes conectar con Uber?', esp: 'ayuda/conexiones' },
  { msg: 'Tienes alguna app', esp: 'ayuda/app_movil' },
  { msg: 'Donde descargo tu app para celular', esp: 'ayuda/app_movil' },
  { msg: 'Puedo registrar alguna tarjeta de débito o crédito en la app?', esp: 'ayuda/conexiones' },
  { msg: 'El cierre no debe ser a las 00 horas?', esp: 'ayuda/periodo_del_mes' },
  { msg: 'Puedes diferenciar por el método de pago también?', esp: 'ayuda/conexiones' },
  // Los dos temas contestan lo mismo de dos lados: los dos dicen el precio y qué pasa si no se
  // paga. El modelo elige `que_pasa_si_no_pago` 2 de 2 y la respuesta es correcta igual.
  { msg: 'Y después cuanto pago?', esp: 'ayuda/precio_despues_prueba|ayuda/que_pasa_si_no_pago' },
  { msg: 'Pero vas a perder el registro o como?', esp: 'ayuda/que_pasa_si_no_pago' },
  { msg: 'No puedes leer mis correos?', esp: 'ayuda/gmail' },
  // Sin contexto no se sabe qué quiere personalizar: cualquier tema de ayuda es honesto.
  { msg: 'Lo podemos personalizar?', esp: 'ayuda/otro|ayuda/uso_negocio|ayuda/-', suave: true },
  { msg: 'Quiero reiniciar', esp: 'ayuda/reiniciar_o_borrar' },
  { msg: 'Se registro si o no.?', esp: 'ver_ultima_transaccion' },
  { msg: 'Pregunta: después de 14 días, cuánto es el costo', esp: 'ayuda/precio_despues_prueba' },
  { msg: 'No deseo el pro', esp: 'ayuda/no_quiero_pro' },
  { msg: 'Quiero eliminar mi cuenta', esp: 'desconectar_cuenta' },
];

const PARAFRASIS = [
  { msg: 'cuánto cuesta el plan cuando se acaben los 14 días gratis?', esp: 'ayuda/precio_despues_prueba|ver_premium' },
  { msg: 'si no pago se pierde todo lo que anoté?', esp: 'ayuda/que_pasa_si_no_pago' },
  { msg: 'hay app en la play store?', esp: 'ayuda/app_movil' },
  { msg: 'te sincronizas con mi cuenta del BCP?', esp: 'ayuda/conexiones' },
  { msg: 'puedes conectarte con yape?', esp: 'ayuda/conexiones' },
  // "Leer los correos" también es pedir el escaneo: `escanear_gmail` contesta lo mismo a quien no paga.
  { msg: 'me puedes leer los correos del banco?', esp: 'ayuda/gmail|agregar_gmail|escanear_gmail' },
  { msg: 'a qué hora me mandas el resumen del día?', esp: 'ayuda/periodo_del_mes' },
  { msg: 'quedó anotado lo que te mandé?', esp: 'ver_ultima_transaccion' },
  { msg: 'puedo usar neto para mi emprendimiento?', esp: 'ayuda/uso_negocio' },
  { msg: 'quiero empezar de cero', esp: 'ayuda/reiniciar_o_borrar' },
  { msg: 'no voy a pagar pro, gracias', esp: 'ayuda/no_quiero_pro' },
  { msg: 'para qué sirves?', esp: 'ayuda/otro|como_empezar' },
];

// No son preguntas sobre Neto: no pueden terminar en `ayuda`.
const CONTROLES = [
  { msg: 'cuanto gaste este mes', esp: '!ayuda' },
  { msg: 'gaste 20 en uber', esp: 'registrar_manual' },
  { msg: 'que es la CTS?', esp: 'consulta_financiera' },
  { msg: 'quiero pro', esp: 'ver_premium' },
  { msg: 'cuanto cuesta pro', esp: 'ver_premium|ayuda/precio_despues_prueba' },
  { msg: 'borra el de S/15', esp: 'eliminar_transaccion' },
  { msg: 'conecta mi gmail', esp: 'agregar_gmail' },
  // El texto de `reiniciar_o_borrar` le dice a la persona que escriba esto: si cayera en la ayuda,
  // sería un bucle.
  { msg: 'borrar mi cuenta', esp: 'desconectar_cuenta' },
  { msg: 'hola', esp: 'saludo' },
  { msg: 'gracias', esp: 'agradecimiento' },
  { msg: 'Neto es 15800', esp: '!ayuda', suave: true },
];

function cumple(resultado, esp) {
  if (esp.startsWith('!')) return !resultado.startsWith(esp.slice(1));
  return esp.split('|').includes(resultado);
}

function resumen(rs) {
  const c = {};
  for (const r of rs) c[r] = (c[r] || 0) + 1;
  return Object.entries(c).map(([k, v]) => `${k}×${v}`).join(' ');
}

async function bateriaFija(nombre, casos) {
  console.log(`\n══ ${nombre} (N=${N}) ══`);
  const msgs = casos.map((c) => c.msg);
  const res = {};
  for (const cfg of Object.keys(CONFIGS)) res[cfg] = await correr(cfg, msgs, N);
  const fallos = { 'ref-auto': 0, 'act-auto': 0, 'act-req': 0 };
  const duros = [];
  casos.forEach((c, k) => {
    const marcas = Object.keys(CONFIGS).map((cfg) => {
      const ok = res[cfg][k].every((r) => cumple(r, c.esp));
      if (!ok) fallos[cfg]++;
      if (!ok && cfg === ELEGIDA && !c.suave) duros.push(c.msg);
      return `${cfg}:${ok ? 'OK' : 'NO'} [${resumen(res[cfg][k])}]`;
    });
    console.log(`${JSON.stringify(c.msg).padEnd(64)} esp=${c.esp}${c.suave ? ' (suave)' : ''}\n    ${marcas.join('\n    ')}`);
  });
  console.log(`  fallos por config: ${JSON.stringify(fallos)}`);
  return duros;
}

async function bateriaPool() {
  const pool = require(path.join(appRoot, 'tests/nlp/pool.js'));
  console.log(`\n══ pool (${pool.length} casos, N=1) ══`);
  const msgs = pool.map((c) => c.msg);
  const res = {};
  for (const cfg of Object.keys(CONFIGS)) res[cfg] = (await correr(cfg, msgs, 1)).map((r) => r[0]);
  const norm = (r) => (r.startsWith('ayuda/') ? 'ayuda' : r);
  const aciertos = {};
  for (const cfg of Object.keys(CONFIGS)) aciertos[cfg] = pool.filter((c, k) => norm(res[cfg][k]) === c.intent).length;
  console.log(`  aciertos contra la etiqueta del pool: ${JSON.stringify(aciertos)}`);
  console.log(`  TEXTO (sin tool call): ${JSON.stringify(Object.fromEntries(Object.keys(CONFIGS).map((cfg) => [cfg, res[cfg].filter((r) => r === 'TEXTO').length])))}`);

  const cambios = (a, b) => pool.map((c, k) => ({ c, a: res[a][k], b: res[b][k] })).filter((x) => norm(x.a) !== norm(x.b));
  for (const [a, b] of [['act-auto', 'act-req'], ['ref-auto', ELEGIDA]]) {
    const cs = cambios(a, b);
    const reg = cs.filter((x) => norm(x.a) === x.c.intent && norm(x.b) !== x.c.intent);
    const mej = cs.filter((x) => norm(x.a) !== x.c.intent && norm(x.b) === x.c.intent);
    console.log(`\n  ${a} → ${b}: ${cs.length} cambian · ${mej.length} mejoran · ${reg.length} empeoran`);
    for (const x of cs) {
      const m = norm(x.a) === x.c.intent ? 'EMPEORA' : norm(x.b) === x.c.intent ? 'mejora ' : 'cambia ';
      console.log(`    ${m} ${JSON.stringify(x.c.msg).padEnd(58)} pool=${x.c.intent.padEnd(24)} ${x.a} → ${x.b}`);
    }
  }
  const cs = cambios('ref-auto', ELEGIDA);
  return {
    empeoran: cs.filter((x) => norm(x.a) === x.c.intent && norm(x.b) !== x.c.intent).length,
    mejoran: cs.filter((x) => norm(x.a) !== x.c.intent && norm(x.b) === x.c.intent).length,
  };
}

const duros = [];
if (!SOLO || SOLO === 'reales') duros.push(...await bateriaFija('reales', REALES));
if (!SOLO || SOLO === 'parafrasis') await bateriaFija('parafrasis', PARAFRASIS);
if (!SOLO || SOLO === 'controles') duros.push(...await bateriaFija('controles', CONTROLES));
let pool = { empeoran: 0, mejoran: 0 };
if (!SOLO || SOLO === 'pool') pool = await bateriaPool();

console.log(`\n${ELEGIDA}: ${duros.length} preguntas/controles fuera de su esperado; pool contra ${CONTRA}: ${pool.mejoran} mejoran, ${pool.empeoran} empeoran`);
process.exit(duros.length || pool.empeoran > pool.mejoran ? 1 : 0);
