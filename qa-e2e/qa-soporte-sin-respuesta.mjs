// E2E — un ticket que nadie contestó sobrevive al /salir de la persona (25-nov-2026).
//
// Por qué existe. `cerrarSesion` ponía `estado = 'cerrado'` viniera de donde viniera, y el bot
// le dice a la persona "Escribe /salir cuando quieras volver al asistente". Un pagador contó su
// problema el 30-oct, mandó /salir 13 segundos después, y su ticket salió de /tickets, de la
// cola y del panel sin que nadie lo leyera. Desde la migración 095 queda `sin_respuesta`.
//
// Qué cubre que los tests unitarios no: la BASE REAL acepta el estado nuevo (el CHECK de la 095;
// contra el CHECK viejo el /salir falla y este archivo sale rojo, que es su control), y el
// pipeline entero del webhook —HMAC → comandos → modo soporte → NLP— decide el ruteo con la
// fila real: después del /salir el siguiente mensaje lo contesta el bot, no el equipo.
//
// Corre en proceso con `webhook-harness.mjs`: valida el CÓDIGO del working tree contra la base
// de producción. Usuario QA (is_test_user), WhatsApp y Telegram capturados, nada sale.
//
// Correr:  node qa-e2e/qa-soporte-sin-respuesta.mjs   (desde app/)  → exit 0 si todo pasa.

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { startWebhookHarness } from './webhook-harness.mjs';
import { cerrar } from './lib/veredicto.mjs';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const QA_ID = 'ded7e219-e5fd-4ff4-b5a3-3cd5cdffd172';
const QA_WA = 'qa-test-dashboard';
const TEXTO = 'qa-e2e sin-respuesta: la web no me carga desde ayer';

const fallas = [];
let medidos = 0;
function check(ok, etiqueta, detalle = '') {
  medidos++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${etiqueta}${detalle ? '  (' + String(detalle).replace(/\n/g, ' ').slice(0, 140) + ')' : ''}`);
  if (!ok) fallas.push(etiqueta);
}

const h = await startWebhookHarness();
const sb = h.supabase;

async function ticketsQA() {
  const { data, error } = await sb.from('tickets_soporte')
    .select('id, estado, updated_at').eq('usuario_id', QA_ID).order('created_at', { ascending: false });
  if (error) throw new Error('no pude leer los tickets del QA: ' + error.message);
  return data || [];
}
async function limpiar() {
  const { error } = await sb.from('tickets_soporte').delete().eq('usuario_id', QA_ID);
  if (error) throw new Error('no pude limpiar los tickets del QA: ' + error.message);
}
async function decir(texto) {
  const antes = h.sent.length;
  await h.postText(texto, QA_WA);
  return h.waitForReply(antes);
}

let inconcluso = null;
try {
  const { data: u0, error: eU } = await sb.from('usuarios').select('is_test_user').eq('id', QA_ID).maybeSingle();
  if (eU || !u0 || u0.is_test_user !== true) throw new Error('el usuario del harness no es de prueba: no sigo');
  await limpiar();

  // Historial adverso: una consulta sin contestar justo antes. El ruteo de soporte corre antes
  // del NLP, así que no tendría que importar; si importa, es justo lo que hay que ver.
  await decir('cuánto gasté este mes');

  const rAbre = await decir('/soporte');
  check(/Modo soporte activado|Ya estás en modo soporte/.test(rAbre), '/soporte abre la conversación', rAbre);

  const tgAntes = h.telegrams.length;
  const rMsg = await decir(TEXTO);
  check(/Recibido|Enviado al equipo/.test(rMsg), 'el mensaje llega al equipo y se lo confirma a la persona', rMsg);
  check(h.telegrams.slice(tgAntes).some((t) => t.includes(TEXTO)), 'el admin recibe el aviso en el momento (Telegram capturado)');
  let [t] = await ticketsQA();
  check(t && t.estado === 'pendiente', 'el ticket queda pendiente', t && t.estado);

  const rSalir = await decir('/salir');
  check(/Saliste del modo soporte/.test(rSalir), '/salir saca a la persona del modo soporte', rSalir);
  check(/equipo ya tiene tu mensaje/i.test(rSalir), '/salir le dice que su pregunta sigue con el equipo', rSalir);
  [t] = await ticketsQA();
  check(t && t.estado === 'sin_respuesta', 'el ticket queda sin_respuesta, NO cerrado', t && t.estado);

  // NO "hola": el webhook intercepta el saludo antes del ruteo de soporte, y en el control
  // (sesión todavía viva) lo contestaba el bot igual. Una consulta sí pasa por el ruteo.
  const tgAntes2 = h.telegrams.length;
  const rBot = await decir('cuánto gasté hoy');
  check(!/Enviado al equipo|Recibido\./.test(rBot), 'el mensaje siguiente lo contesta el bot, no va al equipo', rBot);
  check(!h.telegrams.slice(tgAntes2).some((x) => x.includes('conversación de soporte')), 'y no le llega al admin como mensaje de soporte');

  // El aviso diario: el ticket recién nacido no entra (2h de gracia). Se envejece la fila del QA
  // y se pide el resumen con el código de producción.
  const { resumenTicketsSinRespuesta } = require(path.join(appRoot, 'lib/support-tickets.js'));
  const r0 = await resumenTicketsSinRespuesta();
  check(!String(r0 || '').includes(QA_WA), 'un ticket de hace segundos no entra al aviso diario');
  const viejo = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  const { error: eAge } = await sb.from('tickets_soporte').update({ updated_at: viejo }).eq('id', t.id);
  if (eAge) throw new Error('no pude envejecer el ticket del QA: ' + eAge.message);
  const r1 = await resumenTicketsSinRespuesta();
  check(String(r1 || '').includes(QA_WA) && String(r1 || '').includes('qa-e2e sin-respuesta'), 'con 3h de espera, el aviso diario lo lista', '');
  check(/\/responder/.test(r1 || '') && /\/cerrar/.test(r1 || ''), 'el aviso dice cómo responder y cómo descartar');

  // El admin lo descarta: /cerrar lo encuentra aunque no sea una sesión activa, y a la persona
  // no le llega "el equipo cerró tu conversación" sobre una pregunta que nadie contestó.
  const { procesarComandoAdmin } = require(path.join(appRoot, 'handlers/admin-commands.js'));
  const enviadosAntes = h.sent.length;
  const rCerrar = await procesarComandoAdmin('/cerrar ' + QA_WA, '/cerrar ' + QA_WA);
  check(/cerrada/.test(String(rCerrar)), '/cerrar del admin lo cierra', rCerrar);
  [t] = await ticketsQA();
  check(t && t.estado === 'cerrado', 'el ticket queda cerrado', t && t.estado);
  check(h.sent.length === enviadosAntes, 'a la persona no se le manda nada al descartar un sin_respuesta', h.sent.slice(enviadosAntes).map((s) => s.msg).join(' | '));
  const r2 = await resumenTicketsSinRespuesta();
  check(!String(r2 || '').includes(QA_WA), 'descartado, sale del aviso diario');
} catch (e) {
  inconcluso = e.message;
} finally {
  try { await limpiar(); } catch (e) { inconcluso = inconcluso || e.message; }
  await h.close();
}

cerrar({ nombre: 'qa-soporte-sin-respuesta', fallas, medidos, inconcluso });
process.exit(process.exitCode || 0);
