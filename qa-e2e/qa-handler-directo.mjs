// Despacha intents directamente contra el intent-registry, saltando la clasificación NLP.
//
// Por qué existe: qa-respuestas-finales.mjs corre el pipeline completo, pero ahí el NLP decide
// a qué intent va cada frase y con frases cortas manda "cuanto gaste este mes" a
// ver_total_gastado o "como va mi presupuesto" a ver_balance. Eso hace imposible verificar de
// forma determinista el texto de UN handler concreto. Este harness fija la intención y los
// datos, arma el mismo ctx que message-processor y llama al handler.
//
// Es read-only por construcción: solo se listan intents de consulta. No metas aquí intents que
// escriben (deshacer_ultimo, eliminar_transaccion) porque corre contra la Supabase real.
//
// Correr:  node qa-e2e/qa-handler-directo.mjs   (desde app/)

import 'dotenv/config';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (m) => require(path.join(appRoot, m));

const { supabase } = R('lib/db.js');
const { openai } = R('lib/ai.js');
const log = R('lib/logger.js');
const { hoyPeru, ayerPeru, ultimoDiaMes } = R('lib/dates.js');
const { CATEGORIAS_VALIDAS, CATEGORIA_MAP } = R('lib/constants.js');
const { validarMonto, normalizarCategoria } = R('lib/validators.js');
const { getEmojiCategoria, formatearResumen, formatearCategoriasMsg, barraProgreso, generarRefCode, formatFecha } = R('lib/formatters.js');
const { enviarWhatsapp } = R('lib/whatsapp.js');
const T = R('services/transactions.js');
const B = R('services/budget.js');
const P = R('services/parsers.js');
const { notificarErrorAdmin } = R('lib/admin-notify.js');
const { registrarError } = R('lib/error-monitor.js');
const { obtenerCuentasGmail } = R('gmail.js');
const RC = R('services/recommendations.js');
const D = R('services/debts.js');
const M = R('services/metas.js');
const C = R('services/categories.js');
const { redactarConNETO } = R('services/neto-gpt.js');
const { escanearGmailYRegistrar } = R('services/gmail-scanner.js');
const { generarYEnviarReporte } = R('services/reports.js');
const { guardarMensaje, obtenerHistorial, getUserPlanConfig, getHistoryDateLimit } = R('helpers/db-helpers.js');
const { getHandler } = R('handlers/intent-registry.js');
const { construirNetoPrompt } = R('lib/neto-prompt.js');

const QA_USER_ID = 'ded7e219-e5fd-4ff4-b5a3-3cd5cdffd172';

// `ia: true` = sigue redactando con el modelo a propósito (decisión de docs/SESION-ia-vs-texto-fijo.md).
const CASOS = [
  { intencion: 'saludo', msg: 'hola', datos: {} },
  { intencion: 'ayuda', msg: 'que puedes hacer', datos: {} },
  { intencion: 'agradecimiento', msg: 'gracias crack', datos: {} },
  { intencion: 'queja', msg: 'no me registraste el gasto de ayer', datos: {} },
  { intencion: 'chiste_finanzas', msg: 'cuentame un chiste', datos: {}, ia: true },
  { intencion: 'como_empezar', msg: 'como empiezo', datos: {} },
  { intencion: 'listar_gastos_mes', msg: 'cuanto gaste este mes', datos: {} },
  { intencion: 'listar_gastos_semana', msg: 'cuanto gaste esta semana', datos: {} },
  // 2026-07-15 es el día con más movimientos del usuario QA (11): ejercita el corte de 8.
  { intencion: 'listar_gastos_dia', msg: 'que gaste el 15', datos: { fecha: '2026-07-15' } },
  { intencion: 'listar_gastos_dia', msg: 'que gaste el 8', datos: { fecha: '2026-07-08' } },
  { intencion: 'ver_total_gastado', msg: 'cuanto llevo gastado', datos: { periodo: 'mes' } },
  { intencion: 'ver_presupuesto', msg: 'como va mi presupuesto', datos: {} },
  { intencion: 'ver_balance', msg: 'como voy este mes', datos: {} },
  { intencion: 'comparar_meses', msg: 'gaste mas que el mes pasado', datos: {} },
  { intencion: 'consulta_financiera', msg: 'que es la CTS', datos: {}, ia: true },
  { intencion: 'ver_ingresos', msg: 'cuanto he ingresado este mes', datos: {} },
  { intencion: 'corregir_categoria', msg: 'ese gasto esta mal', datos: {} },
];

async function main() {
  const { data: usuario } = await supabase.from('usuarios').select('*').eq('id', QA_USER_ID).single();
  if (!usuario) { console.error('Usuario QA no encontrado'); process.exit(1); }

  const hoyParts = hoyPeru().split('-');
  const ctx = {
    supabase, openai, log,
    hoyPeru, fechaHoyPeru: () => hoyPeru(), fechaAyerPeru: () => ayerPeru(), formatFecha, ultimoDiaMes,
    mesActual: parseInt(hoyParts[1], 10), anioActual: parseInt(hoyParts[0], 10),
    mE: ['','Enero','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'],
    netoPrompt: construirNetoPrompt({ nombre: usuario.nombre, plan: usuario.plan, correoConectado: false }),
    historialConv: await obtenerHistorial(usuario.id),
    planUsuario: usuario.plan || 'free',
    enviarWhatsapp, notificarErrorAdmin, registrarError,
    CATEGORIAS_VALIDAS, CATEGORIA_MAP, validarMonto, normalizarCategoria,
    getEmojiCategoria, formatearResumen, formatearCategoriasMsg, barraProgreso, generarRefCode,
    ...T, ...B, ...P, ...RC, ...D, ...C,
    obtenerCuentasGmail,
    obtenerMetasService: M.obtenerMetas, abonarMetaService: M.abonarMeta,
    calcularRitmoAhorro: M.calcularRitmoAhorro, registrarLogro: M.registrarLogro,
    obtenerLogros: M.obtenerLogros, verificarRachaAportes: M.verificarRachaAportes,
    redactarConNETO, escanearGmailYRegistrar, generarYEnviarReporte,
    guardarMensaje, obtenerHistorial, getUserPlanConfig, getHistoryDateLimit,
  };

  const lentos = [];
  for (const c of CASOS) {
    const handler = getHandler(c.intencion);
    if (!handler) { console.log('=== ' + c.intencion + '  SIN HANDLER REGISTRADO\n'); continue; }
    const t0 = Date.now();
    const r = await handler({ intencion: c.intencion, msg: c.msg, datos: c.datos, usuario, from: usuario.whatsapp, ctx });
    const ms = Date.now() - t0;
    if (!c.ia && ms > 900) lentos.push({ intencion: c.intencion, ms });
    console.log('=== ' + c.intencion + (c.ia ? '  [IA]' : '  [fijo]') + '  ' + ms + 'ms');
    console.log(r);
    console.log('');
  }

  if (lentos.length) {
    console.log('ATENCION: intents de texto fijo que tardaron >900ms (¿quedó una llamada al modelo?):');
    lentos.forEach(l => console.log('  ' + l.ms + 'ms  ' + l.intencion));
  } else {
    console.log('Ningun intent de texto fijo pasó de 900ms: no queda ninguna llamada al modelo.');
  }
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
