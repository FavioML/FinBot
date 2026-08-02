// Verificación E2E de la decisión IA-vs-texto-fijo (docs/SESION-ia-vs-texto-fijo.md).
//
// Corre el pipeline REAL: procesarMensajeLibre → NLP → handler → respuesta. No mockea nada
// y usa el usuario QA contra la Supabase de producción. Mide cuánto tarda cada intent y
// deja ver la respuesta exacta que recibiría el usuario en WhatsApp.
//
// Los 15 intents que volvieron a texto fijo deben responder en decenas de ms (sin llamada al
// modelo salvo el NLP de clasificación) y no pueden mostrar variación entre corridas.
// chiste_finanzas y consulta_financiera siguen redactando con IA a propósito.
//
// Correr:  node qa-e2e/qa-respuestas-finales.mjs   (desde app/)

import 'dotenv/config';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { instalarGuard } from './lib/qa-guard.mjs';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { procesarMensajeLibre } = require(path.join(appRoot, 'handlers/message-processor.js'));
const supabase = instalarGuard(require, path.join(appRoot, 'lib/db.js'));
// El webhook guarda la respuesta de NETO en el historial DESPUES de procesarMensajeLibre.
// Si el harness no lo replica, el historial queda con N turnos seguidos del usuario y el NLP
// clasifica el mensaje anterior en vez del actual.
const { guardarMensaje } = require(path.join(appRoot, 'helpers/db-helpers.js'));

const QA_USER_ID = 'ded7e219-e5fd-4ff4-b5a3-3cd5cdffd172';

// `ia: true` = sigue redactando con el modelo a propósito.
const CASOS = [
  { msg: 'hola', esperado: 'saludo' },
  { msg: '¿qué puedes hacer?', esperado: 'ayuda' },
  { msg: 'gracias crack', esperado: 'agradecimiento' },
  { msg: 'no me registraste el gasto de ayer', esperado: 'queja' },
  { msg: 'cuéntame un chiste de finanzas', esperado: 'chiste_finanzas', ia: true },
  { msg: 'como empiezo a usarte', esperado: 'como_empezar' },
  { msg: 'cuanto gaste este mes', esperado: 'listar_gastos_mes' },
  { msg: 'cuanto gaste esta semana', esperado: 'listar_gastos_semana' },
  { msg: 'que gaste hoy', esperado: 'listar_gastos_dia' },
  { msg: 'cuanto llevo gastado en comida', esperado: 'ver_total_gastado' },
  { msg: 'como va mi presupuesto', esperado: 'ver_presupuesto' },
  { msg: 'como voy este mes', esperado: 'ver_balance' },
  { msg: 'gaste mas que el mes pasado?', esperado: 'comparar_meses' },
  { msg: 'que es la CTS?', esperado: 'consulta_financiera', ia: true },
  { msg: 'cuanto he ingresado este mes', esperado: 'ver_ingresos' },
  { msg: 'ese gasto esta mal', esperado: 'corregir_categoria' },
  { msg: 'oe y el clima como esta', esperado: 'fallback' },
];

async function main() {
  const { data: usuario } = await supabase.from('usuarios').select('*').eq('id', QA_USER_ID).single();
  if (!usuario) { console.error('Usuario QA no encontrado'); process.exit(1); }
  console.log('Usuario QA: ' + usuario.nombre + ' (plan ' + usuario.plan + ')\n');

  const lentos = [];
  for (const c of CASOS) {
    const t0 = Date.now();
    const r = await procesarMensajeLibre(c.msg, usuario, usuario.whatsapp);
    const ms = Date.now() - t0;
    try { await guardarMensaje(usuario.id, 'neto', (r || '').substring(0, 500)); } catch(e) {}
    if (!c.ia && ms > 2500) lentos.push({ msg: c.msg, ms });

    console.log('=== ' + c.esperado + (c.ia ? '  [IA]' : '  [fijo]') + '  ' + ms + 'ms');
    console.log('> ' + c.msg);
    console.log(r);
    console.log('');
  }

  if (lentos.length) {
    console.log('\nATENCION: intents de texto fijo que tardaron >2.5s (¿quedó una llamada al modelo?):');
    lentos.forEach(l => console.log('  ' + l.ms + 'ms  "' + l.msg + '"'));
  } else {
    console.log('\nNingun intent de texto fijo pasó de 2.5s.');
  }
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
