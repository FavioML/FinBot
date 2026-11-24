// Sonda: ¿qué `fecha_nueva` le da el clasificador real a una edición de fecha dd/mm? (24-nov-2026)
//
// El registro tenía un defecto día/mes: con "03/10" y hoy 24-nov, gpt-4o-mini devolvía la fecha de
// HOY o la leía mes/día (arreglado en a6e2e7d con `resolverFechaDiaMes`). La edición de fecha por
// WhatsApp (`editar_fecha`) no pasa por ese arreglo: el handler escribe `datos.fecha_nueva` tal
// cual sale del clasificador. Esta sonda mide qué sale.
//
// Mismo método que probe-ayuda-temas.mjs: el system prompt se extrae del fuente de
// `handlers/message-processor.js` (no se copia), las tools salen de `handlers/neto-tools.js`, y la
// salida pasa por `mapToolToIntent` y después por el case `editar_fecha` real (con una base falsa que
// captura el UPDATE). Se reporta lo que el handler ESCRIBIRÍA, o por qué no escribe.
//
// Dos contextos por mensaje: en frío, y detrás de la confirmación de un gasto (así llega una
// corrección real: el usuario acaba de ver "✅ S/ 20.00 ...").
//
// Read-only, cero DB. Gasta del proyecto OpenAI de la llave de `app/.env` (Neto Pruebas); lo
// verifica con la cabecera `openai-project` y aborta si no es ése.
// Correr desde app/:  node qa-e2e/probe-editar-fecha.mjs [--n 3] [--hoy 2026-11-24] [--extra] [--duplicar]
// Exit 1 si algún caso escribiría una fecha distinta de la esperada.

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const N = Number(arg('--n', 3));
const HOY = arg('--hoy', '2026-11-24');
const PROYECTO_PRUEBAS = 'proj_W2I31z7YfYiiBFA6CMu9fgRn';

const { openai } = require(path.join(appRoot, 'lib/ai.js'));
const { NETO_TOOLS, mapToolToIntent } = require(path.join(appRoot, 'handlers/neto-tools.js'));
const { sumarDias } = require(path.join(appRoot, 'lib/dates.js'));
// El mismo reencaminamiento que hace `dispatchIntent` (handlers/intent-registry.js) antes del handler.
const { esOrdenDeDuplicar, esOrdenDeFecha } = require(path.join(appRoot, 'lib/orden-edicion.js'));

function systemPrompt() {
  const src = fs.readFileSync(path.join(appRoot, 'handlers/message-processor.js'), 'utf8');
  const a = src.indexOf("content: 'Eres NETO");
  const fin = "sin_categoria.'";
  const b = src.indexOf(fin, a) + fin.length;
  if (a < 0 || b < fin.length) throw new Error('No encontré el system prompt del clasificador');
  const expr = src.slice(a + 'content: '.length, b);
  const mE = ['', 'Enero', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  const [anioActual, mesActual] = HOY.split('-').map(Number);
  const hoyPeru = () => HOY;
  const usuario = { nombre: 'Ana' }, planUsuario = 'premium';
  // eval sobre el fuente de ESTE repo, igual que probe-ayuda-temas.mjs: es la única forma de tener el
  // prompt exacto sin copiarlo. Las variables de arriba son las que ese literal interpola.
  void mE; void anioActual; void mesActual; void hoyPeru; void usuario; void planUsuario;
  // eslint-disable-next-line no-eval
  return eval(expr);
}
const SYSTEM = systemPrompt();

// Lo que ESCRIBIRÍA el case `editar_fecha`: el handler real, en proceso, contra una base falsa que
// sólo captura el UPDATE. Así la sonda mide el código y no una copia de su lógica.
const handlerTx = require(path.join(appRoot, 'handlers/intents/transacciones.js'));
async function loQueEscribe(msg, datos, historial, intencion = 'editar_fecha') {
  const updates = [];
  const copias = [];
  const cadena = {
    update(v) { updates.push(v); return cadena; },
    eq() { return cadena; },
    select() { return Promise.resolve({ data: [{ id: 'tx-probe' }], error: null }); },
  };
  const [anio, mes] = HOY.split('-').map(Number);
  const ctx = {
    supabase: { from: () => cadena }, mesActual: mes, anioActual: anio, historialConv: historial,
    obtenerUltimaTransaccion: async () => ({ id: 'tx-probe', comercio: 'Taxi', fecha: HOY, monto: 20, moneda: 'PEN', tipo: 'gasto' }),
    fechaHoyPeru: () => HOY, fechaAyerPeru: () => sumarDias(HOY, -1), formatFecha: (f) => f,
    guardarTransaccion: async (_uid, fila) => { copias.push(fila); return { id: 'tx-copia' }; },
  };
  const res = await handlerTx.handle({ intencion, msg, datos, usuario: { id: 'u-probe', plan: 'premium' }, from: 'probe', ctx });
  if (copias.length) return copias[0].fecha;
  return updates.length ? updates[0].fecha : '(no escribe: ' + String(res).split('\n')[0].slice(0, 50) + ')';
}

const ahora = Date.now();
const CONFIRMACION = [
  { rol: 'usuario', mensaje: 'gasté 20 en taxi', created_at: new Date(ahora - 60_000).toISOString() },
  { rol: 'neto', mensaje: '✅ S/ 20.00 en *Taxi* (Transporte)\n📅 Hoy', created_at: new Date(ahora - 55_000).toISOString() },
];

// `esp`: la fecha que tendría que escribirse. dd/mm siempre (Perú).
const CASOS = [
  { msg: 'cámbialo al 03/10', esp: '2026-10-03' },
  { msg: 'la fecha era 03/10', esp: '2026-10-03' },
  { msg: 'cambia la fecha al 3/10', esp: '2026-10-03' },
  { msg: 'era el 15/10', esp: '2026-10-15' },
];
// `--extra`: formas explícitas (pasan la gramática en frío) con día > 12, día ≤ 12 de otro mes, y
// sin barra. Existen porque en frío "era el 15/10" trajo un AÑO inventado (2023-10-15).
const EXTRA = [
  { msg: 'cambia la fecha al 15/10', esp: '2026-10-15' },
  { msg: 'cámbialo al 15/10', esp: '2026-10-15' },
  { msg: 'la fecha es el 15/10', esp: '2026-10-15' },
  { msg: 'cambia la fecha al 05/11', esp: '2026-11-05' },
  { msg: 'cámbialo al 10/9', esp: '2026-09-10' },
  { msg: 'cambia la fecha al 28/10', esp: '2026-10-28' },
  { msg: 'cámbialo al 15 de octubre', esp: '2026-10-15' },
  { msg: 'la fecha es el 15 de octubre', esp: '2026-10-15' },
  { msg: 'fue el viernes', esp: '2026-11-20' },
  { msg: 'cambia la fecha al 3 de octubre', esp: '2026-10-03' },
];
if (args.includes('--extra')) CASOS.push(...EXTRA);
// `--duplicar`: la fecha de la copia. El clasificador casi nunca la manda (0 de 12 y después 0 de 16, las
// dos el 24-nov) y "repítelo para el 15 de octubre" ni siquiera llega como duplicar; desde ese día la fecha
// sale del texto (`fechaDeLaCopia`) y la orden se reencamina (`esOrdenDeDuplicar`). Ver docs/DEFECTOS.md.
const DUPLICAR = [
  { msg: 'duplícalo para el 15/10', esp: '2026-10-15', intent: 'duplicar_gasto' },
  { msg: 'repítelo para el 15 de octubre', esp: '2026-10-15', intent: 'duplicar_gasto' },
  { msg: 'duplícalo para el 03/10', esp: '2026-10-03', intent: 'duplicar_gasto' },
  { msg: 'duplícalo para ayer', esp: '2026-11-23', intent: 'duplicar_gasto' },
  { msg: 'copia ese gasto para el lunes', esp: '2026-11-23', intent: 'duplicar_gasto' },
  { msg: 'duplícalo', esp: '2026-11-24', intent: 'duplicar_gasto' },
];
if (args.includes('--duplicar')) CASOS.push(...DUPLICAR);

let proyectoVisto = null;
async function clasificar(msg, historial) {
  for (let intento = 0; intento < 5; intento++) {
    try {
      const { data: res, response } = await openai.chat.completions.create({
        model: 'gpt-4o-mini', temperature: 0, tools: NETO_TOOLS, tool_choice: 'required',
        messages: [
          { role: 'system', content: SYSTEM },
          ...historial.map((h) => ({ role: h.rol === 'neto' ? 'assistant' : 'user', content: h.mensaje.substring(0, 200) })),
          { role: 'user', content: msg },
        ],
      }).withResponse();
      proyectoVisto = response.headers.get('openai-project');
      if (proyectoVisto !== PROYECTO_PRUEBAS) throw new Error('FUERA_DE_PRUEBAS:' + proyectoVisto);
      const t = res.choices[0].message.tool_calls?.[0];
      if (!t) return { intencion: 'TEXTO', datos: {} };
      let a = {};
      try { a = JSON.parse(t.function.arguments); } catch { /* se mapea igual */ }
      return { ...mapToolToIntent(t.function.name, a), crudo: t.function.name + ' ' + t.function.arguments };
    } catch (e) {
      if (String(e.message).startsWith('FUERA_DE_PRUEBAS')) throw e;
      if (/429|rate/i.test(e.message)) { await new Promise((r) => setTimeout(r, 2000 * (intento + 1))); continue; }
      return { intencion: 'ERR:' + e.message.slice(0, 60), datos: {} };
    }
  }
  return { intencion: 'ERR:429', datos: {} };
}

let fallos = 0;
for (const ctx of [{ nombre: 'frio', historial: [] }, { nombre: 'tras-confirmacion', historial: CONFIRMACION }]) {
  console.log(`\n=== ${ctx.nombre} (hoy ${HOY}) ===`);
  for (const c of CASOS) {
    const corridas = await Promise.all(Array.from({ length: N }, () => clasificar(c.msg, ctx.historial)));
    for (const r of corridas) {
      const intent = c.intent || 'editar_fecha';
      if (r.intencion !== 'editar_fecha' && esOrdenDeFecha(c.msg, ctx.historial)) { r.intencion = 'editar_fecha'; r.datos = {}; }
      if (r.intencion !== 'duplicar_gasto' && esOrdenDeDuplicar(c.msg)) { r.intencion = 'duplicar_gasto'; r.datos = {}; }
      const escribe = r.intencion === intent ? await loQueEscribe(c.msg, r.datos, ctx.historial, intent) : '(otro intent)';
      const ok = escribe === c.esp;
      if (!ok && /^\d{4}-/.test(escribe)) fallos++;
      console.log(`${ok ? 'OK ' : 'XX '} "${c.msg}" → ${r.intencion} fecha=${r.datos.fecha_nueva ?? r.datos.fecha ?? '-'} escribe=${escribe}   [${r.crudo || ''}]`);
    }
  }
}
console.log(`\nproyecto OpenAI: ${proyectoVisto}`);
console.log(`fechas equivocadas que se escribirían: ${fallos}`);
process.exit(fallos ? 1 : 0);
