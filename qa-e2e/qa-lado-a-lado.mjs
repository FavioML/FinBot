// Lado a lado: para cada uno de los 17 caminos que pasan por redactarConNETO, imprime
// la respuesta que genera la IA y el texto fijo EXACTO que el handler devuelve cuando
// la IA falla (el `|| '...'`). Sirve para decidir intent por intent cuál se queda.
//
// Los `ctx` están calcados literal de handlers/intents/*.js con datos de ejemplo
// realistas y consistentes entre casos (Favio, Jul 2026, S/1240.50 en 31 movimientos).
//
// Correr:  node qa-e2e/qa-lado-a-lado.mjs            (todos)
//          node qa-e2e/qa-lado-a-lado.mjs saludo ayuda   (solo esos ids)

import 'dotenv/config';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { redactarConNETO } = require(path.join(appRoot, 'services/neto-gpt.js'));
const { construirNetoPrompt } = require(path.join(appRoot, 'lib/neto-prompt.js'));

const CASOS = [
  // ---------- social.js ----------
  {
    id: 'saludo', archivo: 'handlers/intents/social.js', intent: 'saludo',
    msg: 'hola',
    ctx: 'El usuario saluda. Contexto: este mes lleva S/ 1241 en gastos (31 movimientos), S/ 3200 en ingresos registrados, balance S/ 1959.',
    fijo: '👋 Hola, Favio. Soy NETO.\n\nEste mes llevas *S/ 1241* en 31 movimientos.\n\n¿Que revisamos?',
  },
  {
    id: 'ayuda', archivo: 'handlers/intents/social.js', intent: 'ayuda',
    msg: '¿qué puedes hacer?',
    ctx: 'El usuario pregunta que puede hacer NETO o como funciona. Explica brevemente las capacidades: ver gastos, resumen semanal y mensual, presupuestos, reporte PDF, corregir categorias. Todo en tono NETO.',
    fijo: 'Puedo ayudarte con tus gastos, presupuestos y reportes. Escribe como quieras: _"cuanto gaste esta semana"_, _"como va mi delivery"_, _"dame mi reporte"_. ¿Por donde empezamos?',
  },
  {
    id: 'agradecimiento', archivo: 'handlers/intents/social.js', intent: 'agradecimiento',
    msg: 'gracias crack',
    ctx: 'El usuario agradece o felicita a NETO. Responde breve y motivacional, mencionando algun dato positivo de sus finanzas si lo tienes. No hagas preguntas. Contexto: lleva S/1241 en 31 movimientos este mes.',
    fijo: '¡De nada! Aquí andamos cuidando tu bolsillo. 💪',
  },
  {
    id: 'queja', archivo: 'handlers/intents/social.js', intent: 'queja',
    msg: 'no me registraste el gasto de ayer',
    ctx: 'El usuario reporta un problema o se queja de algo que no funciona. Empatiza brevemente, ofrece verificar y da el contacto de soporte: WhatsApp 970398192. No te disculpes de más, se directo.',
    fijo: 'Entendido. Déjame revisar.\n\nSi el problema persiste, escríbenos al 970398192 y lo resolvemos.',
  },
  {
    id: 'chiste', archivo: 'handlers/intents/social.js', intent: 'chiste_finanzas',
    msg: 'cuéntame un chiste',
    ctx: 'El usuario quiere un chiste o dato curioso sobre finanzas. Cuenta un chiste corto y gracioso relacionado con dinero, ahorro o finanzas personales. Usa humor peruano si puedes. Máximo 3 líneas.',
    fijo: '¿Sabes cuál es el banco favorito de los peces? 🐟\n\n¡El banco de arena! 😄\n\n_Ahora sí, ¿revisamos tus gastos?_',
  },
  {
    id: 'como_empezar', archivo: 'handlers/intents/social.js', intent: 'como_empezar',
    msg: 'como empiezo',
    ctx: 'El usuario es nuevo o quiere saber cómo empezar. Guíalo paso a paso de forma amigable: 1) Registrar gastos manualmente ("gasté 50 en taxi"), enviar fotos de comprobantes Yape/Plin, o cargar un Excel, 2) Ver su resumen con "mis gastos del mes" o entrar a https://app.neto.pe, 3) Menciona que con el Plan Pro (S/10/mes) puede conectar su Gmail y Neto lee sus correos bancarios automáticamente. Máximo 8 líneas, tono motivador.',
    fijo: '¡Bienvenido a Neto! 🎉\n\n*3 pasos para empezar:*\n\n1️⃣ Registra un gasto → _"gasté 50 en taxi"_\n2️⃣ Envía una foto Yape/Plin 📸\n3️⃣ Ve tu resumen → _"mis gastos del mes"_\n\n📊 Dashboard: https://app.neto.pe\n⭐ *Pro (S/10/mes):* Neto lee tus correos bancarios automáticamente\n\n_¿Empezamos? Dime tu primer gasto._',
  },

  // ---------- gastos.js ----------
  {
    id: 'gastos_mes', archivo: 'handlers/intents/gastos.js', intent: 'listar_gastos_mes',
    msg: '¿cuánto gasté este mes?',
    ctx: 'Jul 2026: 31 movimientos. Total: S/ 1240.50. Categorias con emoji: 🍔 Comida: S/ 480.00, 🚗 Transporte: S/ 310.00, 🎬 Entretenimiento: S/ 220.50, 🏠 Hogar: S/ 230.00. Subcategorias: 🍔Comida: delivery S/280.00, restaurante S/120.00, mercado S/80.00 | 🚗Transporte: taxi S/190.00, gasolina S/120.00 | 🎬Entretenimiento: streaming S/60.50, salidas S/160.00 | 🏠Hogar: servicios S/230.00.',
    fijo: '📊 *en Jul*\nTotal: *S/ 1240.50* • 31 movimientos\n\n🍔 Comida: *S/ 480.00* (39%)\n🚗 Transporte: *S/ 310.00* (25%)\n🏠 Hogar: *S/ 230.00* (19%)\n🎬 Entretenimiento: *S/ 220.50* (18%)\n',
  },
  {
    id: 'gastos_semana', archivo: 'handlers/intents/gastos.js', intent: 'listar_gastos_semana',
    msg: 'cuanto gaste esta semana',
    ctx: 'Semana: 9 movimientos. Total: S/ 312.40. Semana anterior: S/ 198.00. Diferencia: +S/ 114.40. Top categorias con emoji: 🍔 Comida: S/ 168.90, 🚗 Transporte: S/ 88.50, 🎬 Entretenimiento: S/ 55.00. Subcategorias: 🍔Comida: delivery S/118.90, restaurante S/50.00 | 🚗Transporte: taxi S/88.50 | 🎬Entretenimiento: salidas S/55.00. Dia mas caro: 2026-07-19.',
    fijo: '📊 *esta semana*\nTotal: *S/ 312.40* • 9 movimientos\n\n🍔 Comida: *S/ 168.90* (54%)\n🚗 Transporte: *S/ 88.50* (28%)\n🎬 Entretenimiento: *S/ 55.00* (18%)\n',
  },
  {
    id: 'gastos_dia', archivo: 'handlers/intents/gastos.js', intent: 'listar_gastos_dia',
    msg: 'que gaste hoy',
    ctx: '21 de julio: 4 movimientos. Gastos: S/ 96.40 en 4 transacciones. Categorias: 🍔 Comida: S/ 68.90, 🚗 Transporte: S/ 27.50. Detalle: 💸 Rappi S/48.90 [Comida], 💸 Tambo S/20.00 [Comida], 💸 Uber S/15.50 [Transporte], 💸 Uber S/12.00 [Transporte]',
    fijo: '📊 *21 de julio*\nGastos: S/ 96.40 (4 movimientos)\n\n🍔 Comida: S/ 68.90, 🚗 Transporte: S/ 27.50',
  },
  {
    id: 'total_gastado', archivo: 'handlers/intents/gastos.js', intent: 'ver_total_gastado',
    msg: 'cuanto llevo gastado en comida',
    ctx: 'Categoria comida en mes: S/ 480.00 en 12 movimientos.',
    fijo: 'Llevas *S/ 480.00* en comida esta mes (12 movimientos).',
  },

  // ---------- presupuestos.js ----------
  {
    id: 'presupuesto', archivo: 'handlers/intents/presupuestos.js', intent: 'ver_presupuesto',
    msg: 'como va mi presupuesto',
    ctx: 'Estado del presupuesto del usuario: Tu presupuesto de julio\n---------------\n\nComida\n🟡 ▓▓▓▓▓▓▓▓▓░ 96%\nS/ 480.00 / S/ 500.00 (resta S/ 20.00)\n\nTransporte\n🟢 ▓▓▓▓▓▓░░░░ 62%\nS/ 310.00 / S/ 500.00 (resta S/ 190.00)\n\n',
    fijo: '*Tu presupuesto de julio*\n---------------\n\n*Comida*\n🟡 ▓▓▓▓▓▓▓▓▓░ 96%\nS/ 480.00 / S/ 500.00 (resta S/ 20.00)\n\n*Transporte*\n🟢 ▓▓▓▓▓▓░░░░ 62%\nS/ 310.00 / S/ 500.00 (resta S/ 190.00)\n\n',
  },
  {
    id: 'balance', archivo: 'handlers/intents/presupuestos.js', intent: 'ver_balance',
    msg: 'como voy este mes',
    ctx: 'Balance de Jul 2026: Ingresos S/3200.00, Gastos S/1240.50, Balance +S/1959.50. Ha gastado 39% de sus ingresos.',
    fijo: '✅ *Balance Jul*\n\n💰 Ingresos: S/ 3200.00\n💸 Gastos: S/ 1240.50\n📊 Balance: *+S/ 1959.50*',
  },

  // ---------- utilidades.js ----------
  {
    id: 'comparar_meses', archivo: 'handlers/intents/utilidades.js', intent: 'comparar_meses',
    msg: 'gasto mas que el mes pasado?',
    ctx: 'Jul 2026: S/1240.50 (31 gastos) vs Jun 2026: S/1580.00 (38 gastos). Diferencia: -S/339.50 (-21%). Categorias con mayor cambio: 🎬Entretenimiento: S/220 vs S/430 (-210), 🍔Comida: S/480 vs S/520 (-40), 🚗Transporte: S/310 vs S/380 (-70), 🏠Hogar: S/230 vs S/250 (-20)',
    fijo: '📊 *Jul vs Jun*\n\nJul: S/ 1240.50\nJun: S/ 1580.00\nDiferencia: -S/ 339.50 (-21%)',
  },
  {
    id: 'consulta_financiera', archivo: 'handlers/intents/utilidades.js', intent: 'consulta_financiera',
    msg: 'que es la CTS?',
    ctx: 'El usuario hace una pregunta sobre conceptos financieros. Responde como educador financiero peruano: breve, claro, con ejemplos locales (bancos peruanos, montos en soles). Máximo 6 líneas. Si es sobre CTS, AFP, ONP, gratificación, etc., explica el contexto peruano específico.',
    fijo: 'Buena pregunta. Te recomiendo consultar con tu banco o la SBS (sbs.gob.pe) para información detallada.\n\n¿Necesitas algo más con tus finanzas?',
  },

  // ---------- analytics.js ----------
  {
    id: 'ingresos', archivo: 'handlers/intents/analytics.js', intent: 'ver_ingresos',
    msg: 'cuanto he ingresado este mes',
    ctx: 'Ingresos de Jul 2026: S/ 3200.00 en 2 movimientos. Detalle: 💰 Sueldo — S/ 3000.00 (05 de julio), 💰 Freelance — S/ 200.00 (14 de julio)',
    fijo: '💰 *Ingresos de Jul*\n\nTotal: *S/ 3200.00*\n\n💰 Sueldo — S/ 3000.00 (05 de julio)\n💰 Freelance — S/ 200.00 (14 de julio)',
  },

  // ---------- transacciones.js ----------
  {
    id: 'corregir_categoria', archivo: 'handlers/intents/transacciones.js', intent: 'corregir_categoria (sin categoría destino)',
    msg: 'ese gasto está mal',
    ctx: 'El usuario quiere mover un gasto pero no especifico la categoria. Ultimo gasto: Rappi S/48.90. Pregunta a que categoria moverlo. Puede ser una categoria personalizada.',
    fijo: '¿A qué categoría lo muevo? Díme y lo cambio.',
  },

  // ---------- message-processor.js ----------
  {
    id: 'desconocido', archivo: 'handlers/message-processor.js', intent: 'fallback (intent no clasificado)',
    msg: 'oe y el clima como esta',
    ctx: 'El usuario envio un mensaje que no encaja claramente con ninguna intencion: "oe y el clima como esta". Responde en tono NETO: reconoce el mensaje, ofrece ayuda concreta con los gastos o finanzas del usuario.',
    fijo: 'No entendi bien, pero estoy aqui. Escribe _"cuanto gaste esta semana"_ o _"dame mi reporte"_ y arrancamos. ¿Que necesitas?',
  },
];

const palabras = (t) => (t || '').trim().split(/\s+/).filter(Boolean).length;
const lineas = (t) => (t || '').split('\n').length;

async function main() {
  const filtro = process.argv.slice(2);
  const casos = filtro.length ? CASOS.filter(c => filtro.includes(c.id)) : CASOS;
  const prompt = construirNetoPrompt({ nombre: 'Favio', plan: 'free', correoConectado: false });

  for (let i = 0; i < casos.length; i++) {
    const c = casos[i];
    const t0 = Date.now();
    const ia = await redactarConNETO(prompt, c.ctx, c.msg, []);
    const ms = Date.now() - t0;

    console.log('\n=== ' + (i + 1) + '. ' + c.id + ' — ' + c.intent + '  (' + c.archivo + ')');
    console.log('Usuario: "' + c.msg + '"');
    console.log('\n--- IA (' + palabras(ia) + ' palabras, ' + lineas(ia) + ' líneas, ' + ms + 'ms) ---');
    console.log(ia);
    console.log('\n--- FIJO (' + palabras(c.fijo) + ' palabras, ' + lineas(c.fijo) + ' líneas, 0ms) ---');
    console.log(c.fijo);
    await new Promise(r => setTimeout(r, 200));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
