// ¿Revivir la redacción con IA hizo a NETO más verboso, más lento o menos exacto?
//
// Contexto: hasta el 2026-07-21 redactarConNETO fallaba SIEMPRE (timeout en el body → 400) y
// cada handler caía a su texto fijo. Esos textos fijos son lo que los usuarios vinieron
// recibiendo durante meses. Al arreglarlo, las respuestas pasan a ser generadas, y eso puede
// regresionar la UX aunque el tono "suene" bien: más largas, más lentas y con cifras
// reformuladas por un modelo. Este script mide las tres cosas contra el texto fijo real,
// copiado literal de handlers/intents/*.js y lib/formatters.js.
//
// Correr:  node qa-e2e/qa-ia-vs-fijo.mjs   (desde app/)
//          node qa-e2e/qa-ia-vs-fijo.mjs 3 (repite cada caso 3 veces: el modelo no es estable)

import 'dotenv/config';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { redactarConNETO } = require(path.join(appRoot, 'services/neto-gpt.js'));
const { construirNetoPrompt } = require(path.join(appRoot, 'lib/neto-prompt.js'));

const REPS = parseInt(process.argv[2], 10) || 1;

// `fijo` es el texto EXACTO que producción devolvía cuando redactarConNETO daba null.
const CASOS = [
  { id: 'saludo', msg: 'hola',
    ctx: 'El usuario saluda. Contexto: este mes lleva S/ 1240 en gastos (31 movimientos), S/ 3200 en ingresos registrados, balance S/ 1960.',
    fijo: '👋 Hola, Favio. Soy NETO.\n\nEste mes llevas *S/ 1240* en 31 movimientos.\n\n¿Que revisamos?' },
  { id: 'ayuda', msg: '¿qué puedes hacer?',
    ctx: 'El usuario pregunta que puede hacer NETO o como funciona. Explica brevemente las capacidades: ver gastos, resumen semanal y mensual, presupuestos, reporte PDF, corregir categorias. Todo en tono NETO.',
    fijo: 'Puedo ayudarte con tus gastos, presupuestos y reportes. Escribe como quieras: _"cuanto gaste esta semana"_, _"como va mi delivery"_, _"dame mi reporte"_. ¿Por donde empezamos?' },
  { id: 'agradecimiento', msg: 'gracias crack',
    ctx: 'El usuario agradece o felicita a NETO. Responde breve y motivacional. No hagas preguntas. Contexto: lleva S/1240 en 31 movimientos este mes.',
    fijo: '¡De nada! Aquí andamos cuidando tu bolsillo. 💪' },
  { id: 'queja', msg: 'no me registraste el gasto de ayer',
    ctx: 'El usuario reporta un problema o se queja de algo que no funciona. Empatiza brevemente, ofrece verificar y da el contacto de soporte: WhatsApp 970398192. No te disculpes de mas, se directo.',
    fijo: 'Entendido. Déjame revisar.\n\nSi el problema persiste, escríbenos al 970398192 y lo resolvemos.' },
  { id: 'gastos_mes', msg: '¿cuánto gasté este mes?',
    ctx: 'Jul 2026: 31 movimientos. Total: S/ 1240.50. Categorias con emoji: 🍔 Comida: S/ 480.00, 🚗 Transporte: S/ 310.00, 🎬 Entretenimiento: S/ 220.50. Subcategorias: 🍔Comida: delivery S/280.00, restaurante S/120.00.',
    fijo: '📊 *en Jul*\nTotal: *S/ 1240.50* • 31 movimientos\n\n🍔 Comida: *S/ 480.00* (39%)\n🚗 Transporte: *S/ 310.00* (25%)\n🎬 Entretenimiento: *S/ 220.50* (18%)\n' },
  { id: 'gastos_semana', msg: 'cuanto gaste esta semana',
    ctx: 'Semana actual: 9 movimientos. Total: S/ 312.40. Mayor gasto: Rappi S/ 68.90 el 19/07. Semana pasada fue S/ 198.00.',
    fijo: '📊 *esta semana*\nTotal: *S/ 312.40* • 9 movimientos\n' },
  { id: 'presupuesto', msg: 'como va mi presupuesto de comida',
    ctx: 'Presupuesto Comida: limite S/ 500, gastado S/ 480.00 (96%). Quedan 9 dias del mes. Ritmo actual proyecta cierre en S/ 640.',
    fijo: null },
  { id: 'balance', msg: 'como voy este mes',
    ctx: 'Ingresos del mes: S/ 3200. Gastos: S/ 1240.50. Balance: S/ 1959.50 positivo. Mes pasado el balance fue S/ 820.',
    fijo: null },
  { id: 'comparativa', msg: 'gasto mas que el mes pasado?',
    ctx: 'Jul 2026: S/ 1240.50 en 31 movimientos. Jun 2026: S/ 1580.00 en 38 movimientos. Diferencia: S/ 339.50 menos (21% abajo). Categoria que mas bajo: Entretenimiento (S/ 210 menos).',
    fijo: null },
  { id: 'correccion', msg: 'netflix no es comida',
    ctx: 'El usuario corrigio una categoria. Netflix paso de Comida a Entretenimiento > streaming. Se aplico a 3 movimientos anteriores del mismo comercio.',
    fijo: null },
  { id: 'desconocido', msg: 'oe y el clima como esta',
    ctx: 'El usuario envio un mensaje que no encaja claramente con ninguna intencion: "oe y el clima como esta". Responde en tono NETO: reconoce el mensaje, ofrece ayuda concreta con los gastos o finanzas del usuario.',
    fijo: 'No entendi bien, pero estoy aqui. Escribe _"cuanto gaste esta semana"_ o _"dame mi reporte"_ y arrancamos. ¿Que necesitas?' },
];

const palabras = (t) => (t || '').trim().split(/\s+/).filter(Boolean).length;

// Cifras que el usuario podría creerse. Se ignoran fechas (19/07) y porcentajes sueltos.
function cifras(t) {
  return [...(t || '').matchAll(/(?:S\/|\$|USD)\s*([\d.,]+)|([\d.,]+)\s*(?:soles|d[óo]lares)/gi)]
    .map(m => parseFloat((m[1] || m[2]).replace(/,/g, '')))
    .filter(n => Number.isFinite(n));
}

// Una cifra es defendible si está en el contexto, o si es suma/resta de dos que sí están
// (el prompt pide proyecciones y comparativas, así que derivar es legítimo).
function inventadas(respuesta, ctx) {
  const base = cifras(ctx).concat([...ctx.matchAll(/\b(\d+(?:\.\d+)?)\b/g)].map(m => parseFloat(m[1])));
  const derivables = new Set(base.map(n => n.toFixed(2)));
  for (const a of base) for (const b of base) {
    derivables.add(Math.abs(a - b).toFixed(2));
    derivables.add((a + b).toFixed(2));
  }
  return cifras(respuesta).filter(n => !derivables.has(n.toFixed(2)));
}

async function main() {
  const prompt = construirNetoPrompt({ nombre: 'Favio', plan: 'free', correoConectado: false });
  console.log('Midiendo ' + CASOS.length + ' casos x' + REPS + ' — largo, latencia y fidelidad numérica\n');
  console.log('caso            | IA palabras | fijo | ratio | latencia | cifras inventadas');
  console.log('----------------|-------------|------|-------|----------|------------------');

  const lat = [], ratios = [], sospechosas = [];
  for (const c of CASOS) {
    let pal = 0, ms = 0, inv = [];
    for (let i = 0; i < REPS; i++) {
      const t0 = Date.now();
      const r = await redactarConNETO(prompt, c.ctx, c.msg, []);
      ms += Date.now() - t0;
      pal += palabras(r);
      const x = inventadas(r, c.ctx);
      if (x.length) { inv.push(...x); sospechosas.push({ id: c.id, cifras: x, texto: r }); }
      await new Promise(r2 => setTimeout(r2, 150));
    }
    pal = Math.round(pal / REPS); ms = Math.round(ms / REPS);
    lat.push(ms);
    const pf = c.fijo ? palabras(c.fijo) : null;
    const ratio = pf ? (pal / pf) : null;
    if (ratio) ratios.push(ratio);
    console.log(
      c.id.padEnd(15) + ' | ' + String(pal).padStart(11) + ' | ' + String(pf ?? '-').padStart(4) +
      ' | ' + (ratio ? (ratio.toFixed(1) + 'x').padStart(5) : '    -') +
      ' | ' + (ms + 'ms').padStart(8) + ' | ' + (inv.length ? inv.join(', ') : '-'));
  }

  const media = (a) => a.reduce((s, n) => s + n, 0) / a.length;
  console.log('\nLargo: la IA usa en promedio ' + media(ratios).toFixed(1) + 'x las palabras del texto fijo.');
  console.log('Latencia: media ' + Math.round(media(lat)) + 'ms, peor caso ' + Math.max(...lat) + 'ms.');
  console.log('Antes del fix la respuesta era instantánea: el 400 caía al texto fijo sin generar nada.');

  if (sospechosas.length) {
    console.log('\nCifras que no salen del contexto (revisar a ojo, puede ser derivación válida):');
    for (const s of sospechosas) console.log('  [' + s.id + '] ' + s.cifras.join(', ') + '\n      ' + (s.texto || '').replace(/\n/g, ' | '));
  } else {
    console.log('\nNinguna cifra fuera del contexto: el modelo no inventó montos en esta corrida.');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
