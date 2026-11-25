#!/usr/bin/env node
/**
 * "QUIERO PAGARLE A NETO", contra PRODUCCIÓN y por el webhook real (24-nov-2026). Reporte:
 * `C:\Vortik.dev\memory\reports\neto-usuarios-2026-11-24.md` (sección 1).
 *
 * El 11-nov una pagadora escribió "quiero pagar mi mensualidad" y recibió el fallback de
 * recordatorios, y después "quiero pagar por tu aplicacion" y recibió "No hay problema, no tienes
 * que pagar nada". El arreglo (`quierePagarNeto` en handlers/intents/premium.js y el desvío de
 * handlers/message-processor.js) manda el pedido a `ver_premium`, que a quien ya paga le dice
 * ahora cómo renovar.
 *
 * El usuario es un PAGADOR vigente a propósito (el caso real) y los mensajes van en el orden en
 * que llegaron, así que cada uno se clasifica con el historial del anterior (producción usa los
 * últimos turnos): es el historial adverso. Controles: un recordatorio de la luz sigue siendo un
 * recordatorio, y "no quiero pagar pro" sigue en su texto.
 *
 * **Cómo no le escribe a nadie** — el molde de `qa-respuestas-malas-preguntas.mjs`: un solo usuario
 * efímero `is_test_user` con número `510000…` (no asignable), sin fila en `pagos` (no entra al
 * MRR), con recordatorios apagados, y limpieza COMPROBADA desde un `finally` y ante Ctrl+C.
 *
 * Corre DESPUÉS del deploy: contra el commit anterior es el CONTROL (tiene que fallar).
 *
 *   node qa-e2e/qa-quiere-pagar.mjs
 *
 * exit 0 = todo pasa y no quedó nada · 1 = algún caso falla o quedó basura · 2 = no pudo medir.
 * NO va al canary: cada corrida pasa por OpenAI y escribe en prod.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

const RAILWAY = { P: 'e2aac0f3-c2ee-4347-892c-b36d8c76929e', S: '1085b433-8f29-4487-9ce7-3a66b64ef244', E: '1600a753-bc8c-492c-aca7-27fdac946747' };
const WEBHOOK = process.env.NETO_WEBHOOK || 'https://api.neto.pe/webhook';
const ESPERA_MS = 60000;
const COLA_MS = 4000;

function envLocal(clave) {
  if (process.env[clave]) return process.env[clave];
  const txt = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
  return txt.split('\n').find((l) => l.startsWith(clave + '='))?.split('=').slice(1).join('=').trim();
}

async function credenciales() {
  const token = envLocal('RAILWAY_API_TOKEN');
  if (!token) throw new Error('Falta RAILWAY_API_TOKEN en app/.env');
  const q = `query{variables(projectId:"${RAILWAY.P}",environmentId:"${RAILWAY.E}",serviceId:"${RAILWAY.S}")}`;
  const r = await fetch('https://backboard.railway.com/graphql/v2', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q }),
  });
  const j = await r.json();
  if (j.errors) throw new Error('Railway API: ' + JSON.stringify(j.errors).slice(0, 200));
  const v = j.data.variables;
  for (const k of ['SUPABASE_URL', 'SUPABASE_KEY', 'META_APP_SECRET']) {
    if (!v[k]) throw new Error('Falta ' + k + ' en Railway');
  }
  return v;
}

// REST directo y no supabase-js: este harness es el ORÁCULO. Las tres operaciones LANZAN.
function db(vars) {
  const base = vars.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/';
  const h = { apikey: vars.SUPABASE_KEY, Authorization: 'Bearer ' + vars.SUPABASE_KEY, 'Content-Type': 'application/json' };
  return {
    async insert(tabla, fila) {
      const r = await fetch(base + tabla, { method: 'POST', headers: { ...h, Prefer: 'return=representation' }, body: JSON.stringify(fila) });
      const j = await r.json();
      if (!r.ok) throw new Error(`insert ${tabla}: ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
      return j[0];
    },
    async select(tabla, query) {
      const r = await fetch(base + tabla + '?' + query, { headers: h });
      if (!r.ok) throw new Error(`select ${tabla}: ${r.status}`);
      return r.json();
    },
    async del(tabla, query) {
      const r = await fetch(base + tabla + '?' + query, { method: 'DELETE', headers: h });
      if (!r.ok) throw new Error(`delete ${tabla}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    },
  };
}

async function enviarTexto(secret, from, texto, id) {
  const value = {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '51933014505', phone_number_id: 'qa' },
    contacts: [{ wa_id: from, profile: { name: 'QA Quiere Pagar' } }],
    messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: texto } }],
  };
  const body = { object: 'whatsapp_business_account', entry: [{ id: 'qa', changes: [{ field: 'messages', value }] }] };
  const raw = Buffer.from(JSON.stringify(body));
  const firma = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const r = await fetch(WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': firma }, body: raw });
  return r.status;
}

const fallos = [];
function check(ok, etiqueta, detalle = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${etiqueta}${detalle ? '  (' + detalle + ')' : ''}`);
  if (!ok) fallos.push(etiqueta);
}
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/** La respuesta a ESTE mensaje, atada por `conversaciones.id` y no por reloj. */
async function esperarRespuesta(sb, usuarioId, texto, pisoId) {
  const hasta = Date.now() + ESPERA_MS;
  let entrante = null;
  while (Date.now() < hasta && !entrante) {
    const filas = await sb.select('conversaciones',
      `usuario_id=eq.${usuarioId}&rol=eq.usuario&id=gt.${pisoId}&select=id,mensaje&order=id.asc`);
    entrante = filas.find((f) => f.mensaje === texto) || null;
    if (!entrante) await dormir(1500);
  }
  if (!entrante) return { entranteId: pisoId, texto: null };
  const leer = () => sb.select('conversaciones',
    `usuario_id=eq.${usuarioId}&rol=eq.neto&id=gt.${entrante.id}&select=id,mensaje&order=id.asc`);
  let respuesta = [];
  while (Date.now() < hasta) {
    respuesta = await leer();
    if (respuesta.length) break;
    await dormir(2000);
  }
  if (!respuesta.length) return { entranteId: entrante.id, texto: null };
  await dormir(COLA_MS);
  respuesta = await leer();
  return { entranteId: respuesta[respuesta.length - 1].id, texto: respuesta.map((f) => f.mensaje).join('\n---\n') };
}

let vars, sb;
try {
  vars = await credenciales();
  sb = db(vars);
} catch (e) {
  console.error('No se pudo medir: ' + e.message);
  process.exit(2);
}

const sufijo = crypto.randomBytes(4).toString('hex');
let n = 0;
let u = null;
let whatsapp = null;
let piso = 0;
let abortado = false;

const filasTx = () => sb.select('transacciones', `usuario_id=eq.${u.id}&select=id,tipo,monto,comercio&order=id.asc`);
const filasDeudas = () => sb.select('deudas', `usuario_id=eq.${u.id}&select=id`);

async function decir(texto) {
  if (abortado) throw new Error('cortado a mano antes de mandar ' + JSON.stringify(texto));
  const txAntes = (await filasTx()).length;
  const deudasAntes = (await filasDeudas()).length;
  const st = await enviarTexto(vars.META_APP_SECRET, whatsapp, texto, `wamid.qa-quiere-pagar-${sufijo}-${++n}`);
  if (st !== 200) throw new Error('el webhook devolvió HTTP ' + st);
  const r = await esperarRespuesta(sb, u.id, texto, piso);
  piso = r.entranteId;
  const escribio = (await filasTx()).length !== txAntes || (await filasDeudas()).length !== deudasAntes;
  console.log(`    > ${JSON.stringify(texto)}\n    < ${r.texto === null ? '(sin respuesta)' : JSON.stringify(r.texto.slice(0, 300))}`);
  return { texto: r.texto, escribio };
}

const COMO_RENOVAR = /Yapea al \*970398192\*/;
const NO_PIERDES = /no pierdes d[ií]as/;
const NO_PAGUES = /no tienes que pagar nada/;
const RECORDATORIO = /recordatorios con la fecha|recordatorio/i;

async function pedidoDePago(caso, texto) {
  console.log('\n' + caso);
  const r = await decir(texto);
  check(r.texto !== null, caso + ': hubo respuesta');
  check(!r.escribio, caso + ': no anota plata ni deudas');
  if (r.texto === null) return;
  check(COMO_RENOVAR.test(r.texto), caso + ': dice cómo pagar', 'esperaba ' + COMO_RENOVAR);
  check(NO_PIERDES.test(r.texto), caso + ': dice que renovar antes no pierde días');
  check(!NO_PAGUES.test(r.texto), caso + ': no dice "no tienes que pagar nada"');
  check(!/Todav[ií]a no puedo crear recordatorios/.test(r.texto), caso + ': no es el fallback de recordatorios');
}

let limpio = false;
async function limpiar() {
  if (limpio || !u) return;
  limpio = true;
  console.log('\nLimpieza');
  try {
    for (const t of ['transacciones', 'transacciones_eliminadas', 'deudas', 'conversaciones', 'notificaciones', 'notification_deliveries', 'nlp_errors']) {
      await sb.del(t, `usuario_id=eq.${u.id}`);
    }
    await sb.del('usuarios', `id=eq.${u.id}`);
    const quedan = await sb.select('usuarios', `id=eq.${u.id}&select=id`);
    check(quedan.length === 0, 'se borró el usuario efímero', quedan.length ? 'QUEDÓ la fila ' + u.id + ', bórrala a mano' : '');
  } catch (e) {
    check(false, 'se borró el usuario efímero', 'el borrado falló: ' + e.message + ', revisa ' + u.id);
  }
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (abortado) { console.error('\nSalida forzada SIN limpiar: revisa usuarios con whatsapp=' + whatsapp); process.exit(1); }
    abortado = true;
    console.error('\nCortando: termino el turno en vuelo y limpio (otro Ctrl+C sale sin limpiar).');
  });
}

const enDias = (d) => new Date(Date.now() + d * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Lima' });

let errorFatal = null;
try {
  whatsapp = '510000' + String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
  // Pagador mensual vigente, como la pagadora del 11-nov. Sin fila en `pagos` y con
  // `is_test_user`: no entra al MRR ni al panel. Vence en 12 días: ningún cron de vencimiento lo toca.
  u = await sb.insert('usuarios', {
    whatsapp, nombre: 'QA Quiere Pagar', is_test_user: true,
    onboarding_completado: true, onboarding_paso: 0,
    plan: 'premium', tipo_plan: 'mensual', trial_estado: 'convertido', premium_vence: enDias(12),
    recordatorios_activos: false,
  });
  console.log('usuario efímero ' + u.id + ' (pagador mensual, vence ' + enDias(12) + ')');

  // Control primero, y además deja historial de "pagar" en la conversación.
  console.log('\ncontrol · un recordatorio de otro pago');
  const rLuz = await decir('quiero pagar la luz el 15');
  check(rLuz.texto !== null && !COMO_RENOVAR.test(rLuz.texto), 'la luz no recibe cómo pagar Neto');
  check(rLuz.texto !== null && RECORDATORIO.test(rLuz.texto), 'la luz sigue en recordatorios', (rLuz.texto || '').slice(0, 80));

  // La secuencia real del 11-nov, en orden: cada una con el historial de la anterior.
  await pedidoDePago('caso real 1 · "quiero pagar mi mensualidad"', 'quiero pagar mi mensualidad');
  await pedidoDePago('caso real 2 · "quiero pagar por tu aplicacion"', 'quiero pagar por tu aplicacion');
  await pedidoDePago('variante · "deseo pagar la suscripción"', 'deseo pagar la suscripción');

  console.log('\ncontrol · "no quiero pagar pro"');
  const rNo = await decir('no quiero pagar pro');
  check(rNo.texto !== null && NO_PAGUES.test(rNo.texto), 'sigue recibiendo "no tienes que pagar nada"', (rNo.texto || '').slice(0, 80));
} catch (e) {
  errorFatal = e;
  console.error('\nNo se pudo medir: ' + e.message);
} finally {
  await limpiar();
}

console.log(`\nResultado: ${fallos.length ? fallos.length + ' fallo(s): ' + fallos.join(' · ') : 'todo PASS'}`);
process.exit(fallos.length ? 1 : errorFatal ? 2 : 0);
