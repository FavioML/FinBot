// QA de tono — audita que las respuestas redactadas por IA respeten el system prompt maestro.
//
// Por qué existe: hasta el 2026-07-21 la redacción con IA estuvo caída al 100% (timeout en el
// body → 400) y el system prompt se leía de una ruta inexistente. Todo lo que veía el usuario
// era el texto fijo de cada handler. Ahora que el modelo sí redacta, hace falta una forma
// objetiva de verificar el tono sin esperar tráfico orgánico: Neto mueve ~23 mensajes por
// semana y la tabla `conversaciones` se auto-purga a los últimos 10 turnos por usuario.
//
// Qué hace: llama redactarConNETO con el prompt real y contextos calcados de los handlers
// (handlers/intents/*.js), y pasa cada respuesta por un linter de las reglas DURAS del prompt,
// las que se pueden verificar sin criterio: frases de call center, markdown que WhatsApp no
// renderiza, formato de moneda, mencionar comandos, admitir ser un bot, largo.
//
// Lo subjetivo (¿suena a amigo que sabe de plata?) no se automatiza: se imprime todo para leer.
//
// Correr:  node qa-e2e/qa-tono-neto.mjs   (desde app/)  → exit 0 si no hay violaciones.
//          node qa-e2e/qa-tono-neto.mjs --reales        → audita además lo último que Neto
//                                                          respondió a usuarios de verdad.

import 'dotenv/config';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { instalarGuard } from './lib/qa-guard.mjs';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { redactarConNETO } = require(path.join(appRoot, 'services/neto-gpt.js'));
const { construirNetoPrompt } = require(path.join(appRoot, 'lib/neto-prompt.js'));
const supabase = instalarGuard(require, path.join(appRoot, 'lib/db.js'));

const AUDITAR_REALES = process.argv.includes('--reales');

// Copiado literal de handlers/intents/utilidades.js → case 'consulta_financiera'.
const CTX_FINANCIERO = 'El usuario hace una pregunta sobre conceptos financieros. Responde como educador financiero peruano: breve y claro, máximo 6 líneas. Define el concepto y su contexto peruano específico (CTS, AFP, ONP, gratificación, etc.). PROHIBIDO hacer cálculos o dar ejemplos con montos ("si ganas S/X recibirías S/Y"): nunca cites cifras de dinero ni tasas de interés. Sí puedes mencionar plazos y porcentajes fijados por ley. Si el usuario necesita un monto exacto, dile que lo confirme con su banco o en la SBS (sbs.gob.pe).';

// Contextos calcados de handlers/intents/*.js: mismo formato de string que arma producción.
//
// Desde el 2026-07-22 solo DOS intents siguen redactando con IA (ver
// docs/SESION-ia-vs-texto-fijo.md): chiste_finanzas y consulta_financiera. Los otros 15 volvieron
// a texto fijo, así que auditarlos acá era lintear caminos muertos y reportaba fallas que ningún
// usuario podía ver.
const CASOS = [
  { id: 'chiste', msg: 'cuéntame un chiste',
    ctx: 'El usuario quiere un chiste o dato curioso sobre finanzas. Cuenta un chiste corto y gracioso relacionado con dinero, ahorro o finanzas personales. Usa humor peruano si puedes. Máximo 3 líneas.' },
  { id: 'consulta_cts', msg: 'que es la CTS?',
    ctx: CTX_FINANCIERO },
  { id: 'consulta_afp', msg: 'me conviene AFP u ONP?',
    ctx: CTX_FINANCIERO },
  { id: 'consulta_interes', msg: 'que es el interes compuesto',
    ctx: CTX_FINANCIERO },
  // "¿lees mis correos?" (restricción CASA) ya no pasa por IA: cae en el intent de ayuda,
  // que es texto fijo. Ese chequeo vive en probe-system-prompt.mjs, sección D.
];

// Reglas DURAS del prompt (secciones 1 y 2). Cada una es verificable sin criterio.
const REGLAS = [
  { id: 'frase-call-center', desc: 'frases de bot prohibidas por el prompt',
    // "estoy aquí para ayudarte" y "aquí estoy para ayudarte" son la misma frase: cubrir
    // ambos órdenes, y también "aquí andamos/estoy" suelto como muletilla de cierre.
    re: /¡?\b(entendido|por supuesto|claro que s[íi]|con gusto)\b!?|(estoy aqu[íi]|aqu[íi] (estoy|andamos|estamos))( para (ayudarte|lo que necesites))?/i },
  { id: 'markdown-pesado', desc: 'markdown que WhatsApp no renderiza (##, **, tablas)',
    re: /(^|\n)\s*#{2,}\s|\*\*|\|\s*-{3,}\s*\|/ },
  { id: 'moneda-soles', desc: 'soles mal formateados (debe ser S/380, no "380 soles" ni "PEN 380")',
    re: /\b\d+([.,]\d+)?\s*soles\b|\bPEN\s*\d/i },
  { id: 'moneda-dolares', desc: 'dólares mal formateados (debe ser $8.73 o USD 8.73)',
    re: /\b\d+([.,]\d+)?\s*d[óo]lares\b/i },
  { id: 'menciona-comandos', desc: 'instruye sintaxis técnica al usuario',
    re: /\/(cambiar|reporte|ayuda|gastos)\b|\bcomando\b/i },
  { id: 'admite-ser-bot', desc: 'dice que es una IA o un bot',
    re: /\b(soy (una |un )?(ia|bot|inteligencia artificial|asistente virtual|modelo)|como (ia|bot|modelo de lenguaje))\b/i },
  { id: 'largo', desc: 'más de 6 líneas (redactarConNETO pide máximo 6)',
    test: (t) => t.split('\n').filter(l => l.trim()).length > 6 },
  // Neto WhatsApp dejó de ser conversacional por decisión de producto: confirma acciones,
  // no le saca charla al usuario. Solo se permite preguntar lo que hace falta para poder
  // ejecutar (a qué categoría mover algo, si un cargo duplicado es real).
  { id: 'pregunta-relleno', desc: 'cierra con pregunta de relleno en vez de dar el dato y parar',
    test: (t) => {
      const ultima = t.split('\n').filter(l => l.trim()).pop() || '';
      if (!/\?/.test(ultima)) return false;
      const necesaria = /(a )?qu[ée] categor[íi]a|d[óo]nde lo (pongo|muevo)|es un duplicado|son dos compras|para qu[ée] fue|c[óo]mo lo registro|de qu[ée] fue/i;
      return !necesaria.test(ultima);
    } },
];

// Solo aplica cuando el usuario NO tiene correo conectado, que es el caso de 68 de 74 reales.
// Los \b de le(o|yendo) no son decorativos: sin ellos "empleo" matchea "leo" y cualquier
// respuesta que diga "si pierdes tu empleo" se reportaba como que NETO afirma leer correos.
const REGLA_CORREOS = { id: 'miente-correos', desc: 'afirma leer correos sin correo conectado',
  re: /(s[íi]\b|ya|claro)[^.!?]{0,40}\b(le(o|yendo)|reviso|revisando|sincroniz\w*)\b|\ble(o|emos)\b tus correos|los? reviso autom/i };

// Guardarraíl de consulta_financiera: lo que falló fue el CÁLCULO ("si tu sueldo es S/1000,
// recibirías S/1000 al año"), no el dato regulatorio. Por eso la regla persigue montos de
// dinero, que en una respuesta conceptual solo pueden salir de un cálculo o de la nada. Los
// porcentajes fijados por ley (el 95.5% de retiro AFP) son correctos y no se penalizan.
const REGLA_SIN_MONTOS = { id: 'inventa-montos', desc: 'da montos de dinero en una consulta conceptual (solo pueden venir de un cálculo)',
  re: /S\/\s?\d|\$\s?\d|\b\d+([.,]\d+)?\s*(soles|d[óo]lares)\b|\b\d+([.,]\d+)?\s*(sueldos?|remuneraciones?)\b/i };

// El chiste es prosa, no un dato: no reporta ningún monto real del usuario, así que no le
// aplican ni la pregunta-relleno (los chistes son pregunta-respuesta) ni el formato de moneda
// ("billete de 100 soles" es como se dice, "billete de S/100" no).
const REGLAS_CHISTE_EXENTAS = new Set(['pregunta-relleno', 'moneda-soles', 'moneda-dolares']);

function auditar(texto, { chequearCorreos = true, sinMontos = false, esChiste = false } = {}) {
  const t = (texto || '').trim();
  if (!t) return [{ id: 'vacio', desc: 'la IA no devolvió nada (revisar logs NETO_GPT)' }];
  const reglas = REGLAS.filter(r => !(esChiste && REGLAS_CHISTE_EXENTAS.has(r.id)));
  if (chequearCorreos) reglas.push(REGLA_CORREOS);
  if (sinMontos) reglas.push(REGLA_SIN_MONTOS);
  return reglas.filter(r => (r.test ? r.test(t) : r.re.test(t)));
}

// Concurrencia baja a propósito: la org OpenAI de Neto está en tier bajo y un flood da 429.
async function enTandas(items, fn, tam = 3) {
  const out = [];
  for (let i = 0; i < items.length; i += tam) {
    out.push(...await Promise.all(items.slice(i, i + tam).map(fn)));
    await new Promise(r => setTimeout(r, 150));
  }
  return out;
}

async function main() {
  // Usuario tipo: el 92% no tiene correo conectado, así que ese es el caso por defecto.
  const prompt = construirNetoPrompt({ nombre: 'Favio', plan: 'free', correoConectado: false });

  console.log('Auditando ' + CASOS.length + ' respuestas redactadas con el prompt maestro real...\n');
  const filas = await enTandas(CASOS, async (c) => {
    // Mismo modelo que usa producción para ese intent: consulta_financiera corre en gpt-4o.
    const esFinanciero = c.ctx === CTX_FINANCIERO;
    const texto = await redactarConNETO(prompt, c.ctx, c.msg, [], esFinanciero ? { model: 'gpt-4o' } : {});
    return { ...c, texto, fallas: auditar(texto, { sinMontos: esFinanciero, esChiste: c.id === 'chiste' }) };
  });

  for (const f of filas) {
    const marca = f.fallas.length ? 'FALLA' : 'OK   ';
    console.log(marca + ' [' + f.id + '] "' + f.msg + '"');
    console.log('      ' + (f.texto || '(sin respuesta)').replace(/\n/g, '\n      '));
    for (const x of f.fallas) console.log('      ↳ ' + x.id + ': ' + x.desc);
    console.log('');
  }

  let violaciones = filas.reduce((n, f) => n + f.fallas.length, 0);

  // Muestreo de producción: lo último que Neto realmente le respondió a usuarios de verdad.
  if (AUDITAR_REALES) {
    const { data } = await supabase.from('conversaciones')
      .select('mensaje, created_at, usuario_id, usuarios!inner(is_test_user)')
      .eq('rol', 'neto').eq('usuarios.is_test_user', false)
      .order('created_at', { ascending: false }).limit(30);
    console.log('─── ' + (data?.length || 0) + ' respuestas reales de producción ───\n');
    for (const m of data || []) {
      // Muchas respuestas de producción son texto fijo del handler, no redacción con IA:
      // se auditan igual porque el usuario las lee, pero sin la regla de correos.
      const fallas = auditar(m.mensaje, { chequearCorreos: false });
      if (!fallas.length) continue;
      violaciones += fallas.length;
      console.log('FALLA ' + m.created_at + '\n      ' + m.mensaje.slice(0, 200).replace(/\n/g, ' | '));
      for (const x of fallas) console.log('      ↳ ' + x.id + ': ' + x.desc);
      console.log('');
    }
  }

  const okCasos = filas.filter(f => !f.fallas.length).length;
  console.log('=== ' + okCasos + '/' + filas.length + ' casos limpios, ' + violaciones + ' violaciones en total ===');
  if (violaciones) console.log('Las reglas duras son objetivas; el tono fino se lee a ojo en el volcado de arriba.');
  process.exit(violaciones ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
