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

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { redactarConNETO } = require(path.join(appRoot, 'services/neto-gpt.js'));
const { construirNetoPrompt } = require(path.join(appRoot, 'lib/neto-prompt.js'));
const { supabase } = require(path.join(appRoot, 'lib/db.js'));

const AUDITAR_REALES = process.argv.includes('--reales');

// Contextos calcados de handlers/intents/*.js: mismo formato de string que arma producción.
const CASOS = [
  { id: 'saludo', msg: 'hola',
    ctx: 'El usuario saluda. Contexto: este mes lleva S/ 1240 en gastos (31 movimientos), S/ 3200 en ingresos registrados, balance S/ 1960.' },
  { id: 'ayuda', msg: '¿qué puedes hacer?',
    ctx: 'El usuario pregunta que puede hacer NETO o como funciona. Explica brevemente las capacidades: ver gastos, resumen semanal y mensual, presupuestos, reporte PDF, corregir categorias. Todo en tono NETO.' },
  { id: 'agradecimiento', msg: 'gracias crack',
    ctx: 'El usuario agradece o felicita a NETO. Responde breve y motivacional. No hagas preguntas. Contexto: lleva S/1240 en 31 movimientos este mes.' },
  { id: 'queja', msg: 'no me registraste el gasto de ayer',
    ctx: 'El usuario reporta un problema o se queja de algo que no funciona. Empatiza brevemente, ofrece verificar y da el contacto de soporte: WhatsApp 970398192. No te disculpes de mas, se directo.' },
  { id: 'gastos_mes', msg: '¿cuánto gasté este mes?',
    ctx: 'Jul 2026: 31 movimientos. Total: S/ 1240.50. Categorias con emoji: 🍔 Comida: S/ 480.00, 🚗 Transporte: S/ 310.00, 🎬 Entretenimiento: S/ 220.50. Subcategorias: 🍔Comida: delivery S/280.00, restaurante S/120.00.' },
  { id: 'gastos_semana', msg: 'cuanto gaste esta semana',
    ctx: 'Semana actual: 9 movimientos. Total: S/ 312.40. Mayor gasto: Rappi S/ 68.90 el 19/07. Semana pasada fue S/ 198.00.' },
  { id: 'presupuesto', msg: 'como va mi presupuesto de comida',
    ctx: 'Presupuesto Comida: limite S/ 500, gastado S/ 480.00 (96%). Quedan 9 dias del mes. Ritmo actual proyecta cierre en S/ 640.' },
  { id: 'balance', msg: 'como voy este mes',
    ctx: 'Ingresos del mes: S/ 3200. Gastos: S/ 1240.50. Balance: S/ 1959.50 positivo. Mes pasado el balance fue S/ 820.' },
  { id: 'ingresos', msg: 'cuanto he ganado',
    ctx: 'Ingresos Jul 2026: S/ 3200 en 2 movimientos (sueldo S/ 2800, freelance S/ 400).' },
  { id: 'comparativa', msg: 'gasto mas que el mes pasado?',
    ctx: 'Jul 2026: S/ 1240.50 en 31 movimientos. Jun 2026: S/ 1580.00 en 38 movimientos. Diferencia: S/ 339.50 menos (21% abajo). Categoria que mas bajo: Entretenimiento (S/ 210 menos).' },
  { id: 'correccion', msg: 'netflix no es comida',
    ctx: 'El usuario corrigio una categoria. Netflix paso de Comida a Entretenimiento > streaming. Se aplico a 3 movimientos anteriores del mismo comercio.' },
  { id: 'desconocido', msg: 'oe y el clima como esta',
    ctx: 'El usuario envio un mensaje que no encaja claramente con ninguna intencion: "oe y el clima como esta". Responde en tono NETO: reconoce el mensaje, ofrece ayuda concreta con los gastos o finanzas del usuario.' },
  { id: 'correos', msg: '¿estás leyendo mis correos del BCP?',
    ctx: 'El usuario pregunta si NETO esta leyendo automaticamente sus correos bancarios del BCP.' },
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
const REGLA_CORREOS = { id: 'miente-correos', desc: 'afirma leer correos sin correo conectado',
  re: /(s[íi]\b|ya|claro)[^.!?]{0,40}(le(o|yendo)|reviso|revisando|sincroniz)|le(o|emos) tus correos|los? reviso autom/i };

function auditar(texto, { chequearCorreos = true } = {}) {
  const t = (texto || '').trim();
  if (!t) return [{ id: 'vacio', desc: 'la IA no devolvió nada (revisar logs NETO_GPT)' }];
  const reglas = chequearCorreos ? [...REGLAS, REGLA_CORREOS] : REGLAS;
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
    const texto = await redactarConNETO(prompt, c.ctx, c.msg, []);
    return { ...c, texto, fallas: auditar(texto) };
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
