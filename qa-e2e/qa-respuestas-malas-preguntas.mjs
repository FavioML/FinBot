#!/usr/bin/env node
/**
 * LAS PREGUNTAS SOBRE NETO, contra PRODUCCIÓN y por el webhook real (chip 2 de la tanda
 * "respuestas malas del día 0", 30-sep-2026). Reporte:
 * `C:\Vortik.dev\memory\reports\neto-respuestas-malas-medicion-2026-09-30.md`.
 *
 * Cada caso es una pregunta real que en 60 días recibió el texto genérico ("Puedo ayudarte con
 * tus gastos…"), una respuesta de otro tema, o un efecto que nadie pidió:
 *
 *   clase 2/6  "¿tienes app?", "¿te conectas con Uber?", "¿después cuánto pago?", "¿vas a perder
 *              el registro?"… tienen que recibir el texto de SU tema (social.js, `textoAyuda`).
 *              "Pregunta: después de 14 días, cuánto es el costo" iba a `consulta_financiera`
 *              (gpt-4o) y contestó sobre períodos de gracia de préstamos.
 *   clase 3    "No deseo el pro" iba a otro intent y dejaba abierta la espera del comprobante
 *              (48h en que una foto de un Yape se lee como pago y no se registra). Se arma la
 *              espera con "cuánto cuesta pro" y se afirma que "No deseo el pro" la CIERRA.
 *              "Quiero eliminar mi cuenta" abría un menú titulado "Desconectar cuenta · No tienes
 *              cuentas Gmail conectadas". Va ÚLTIMO: deja el paso -1 abierto, y nada de esta
 *              corrida manda la frase que borra.
 *   control    "gasté 12 en taxi" registra S/12 (y es lo que contesta "¿se registró?").
 *
 * Se afirma el TEXTO de la respuesta (cada tema tiene una marca que solo dice su texto) y que
 * ninguna pregunta deje plata. El usuario está en el MURO a propósito: es el estado donde
 * `ver_premium` arma la espera, y todas estas respuestas son libres (intents-acceso.js).
 *
 * **Cómo no le escribe a nadie** — el molde de `qa-dia0-respuestas.mjs`: un solo usuario efímero
 * `is_test_user` con número `510000…` (no asignable), limpieza COMPROBADA desde un `finally` y
 * ante Ctrl+C. **Lo que deja:** la transacción del control se borra y deja su copia en
 * `borrados_auditoria` (append-only): una fila por corrida, con el id del usuario efímero.
 *
 * Corre DESPUÉS del deploy: contra el commit anterior es el CONTROL (tiene que fallar).
 *
 *   node qa-e2e/qa-respuestas-malas-preguntas.mjs
 *
 * exit 0 = todo pasa y no quedó nada · 1 = algún caso falla o quedó basura · 2 = no pudo medir o
 * algún caso no se ejercitó. NO va al canary: cada corrida pasa por OpenAI y escribe en prod.
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
    contacts: [{ wa_id: from, profile: { name: 'QA Preguntas' } }],
    messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: texto } }],
  };
  const body = { object: 'whatsapp_business_account', entry: [{ id: 'qa', changes: [{ field: 'messages', value }] }] };
  const raw = Buffer.from(JSON.stringify(body));
  const firma = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const r = await fetch(WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': firma }, body: raw });
  return r.status;
}

const fallos = [];
const noEjercitados = [];
function check(ok, etiqueta, detalle = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${etiqueta}${detalle ? '  (' + detalle + ')' : ''}`);
  if (!ok) fallos.push(etiqueta);
}
const nota = (t) => console.log('  NOTA  ' + t);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/** La respuesta a ESTE mensaje, atada por `conversaciones.id` y no por reloj (ver el molde). */
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

const filasTx = () => sb.select('transacciones', `usuario_id=eq.${u.id}&select=id,tipo,monto,moneda,comercio&order=id.asc`);
const firma = (f) => `${f.tipo}|${Number(f.monto)}|${f.moneda}|${f.comercio}`;
const leerUsuario = async () => (await sb.select('usuarios', `id=eq.${u.id}&select=esperando_comprobante,onboarding_paso`))[0];

async function decir(texto) {
  if (abortado) throw new Error('cortado a mano antes de mandar ' + JSON.stringify(texto));
  const antes = new Map((await filasTx()).map((f) => [f.id, f]));
  const st = await enviarTexto(vars.META_APP_SECRET, whatsapp, texto, `wamid.qa-preguntas-${sufijo}-${++n}`);
  if (st !== 200) throw new Error('el webhook devolvió HTTP ' + st);
  const r = await esperarRespuesta(sb, u.id, texto, piso);
  piso = r.entranteId;
  const despues = await filasTx();
  const nuevas = despues.filter((f) => !antes.has(f.id));
  const editadas = despues.filter((f) => antes.has(f.id) && firma(antes.get(f.id)) !== firma(f));
  console.log(`    > ${JSON.stringify(texto)}\n    < ${r.texto === null ? '(sin respuesta)' : JSON.stringify(r.texto.slice(0, 260))}`);
  return { texto: r.texto, nuevas, editadas };
}

/**
 * Una pregunta sobre Neto: tiene que recibir el texto de su tema y no tocar la plata.
 * `marca` es una frase que SOLO dice el texto de ese tema (social.js); `prohibido`, lo que no
 * puede aparecer (el genérico, una afirmación falsa).
 */
const GENERICO = /Puedo ayudarte con tus gastos, presupuestos y reportes/;
async function pregunta(caso, texto, marca, { prohibido = null } = {}) {
  console.log('\n' + caso);
  const r = await decir(texto);
  check(r.texto !== null, caso + ': hubo respuesta');
  check(r.nuevas.length === 0 && r.editadas.length === 0, caso + ': no toca la plata',
    [...r.nuevas.map(firma), ...r.editadas.map(firma)].join(' ; '));
  if (r.texto === null) return r;
  check(marca.test(r.texto), caso + ': contesta su tema', 'esperaba ' + marca);
  check(!GENERICO.test(r.texto), caso + ': no es el texto genérico');
  if (prohibido) check(!prohibido.test(r.texto), caso + ': no afirma lo que no existe', String(prohibido));
  return r;
}

let limpio = false;
async function limpiar() {
  if (limpio || !u) return;
  limpio = true;
  console.log('\nLimpieza');
  try {
    for (const t of ['transacciones', 'transacciones_eliminadas', 'conversaciones', 'notificaciones', 'notification_deliveries', 'nlp_errors']) {
      await sb.del(t, `usuario_id=eq.${u.id}`);
    }
    await sb.del('usuarios', `id=eq.${u.id}`);
    const quedan = await sb.select('usuarios', `id=eq.${u.id}&select=id`);
    check(quedan.length === 0, 'se borró el usuario efímero', quedan.length ? 'QUEDÓ la fila ' + u.id + ', bórrala a mano' : '');
  } catch (e) {
    check(false, 'se borró el usuario efímero', 'el borrado falló: ' + e.message + ', revisa ' + u.id);
  }
}
// Ctrl+C no limpia en paralelo: borrar el usuario mientras el backend procesa el turno en vuelo
// lo recrea SIN `is_test_user` (revisión adversarial del molde, 14-sep).
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (abortado) { console.error('\nSalida forzada SIN limpiar: revisa usuarios con whatsapp=' + whatsapp); process.exit(1); }
    abortado = true;
    console.error('\nCortando: termino el turno en vuelo y limpio (otro Ctrl+C sale sin limpiar).');
  });
}

const hace = (d) => new Date(Date.now() - d * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Lima' });

let errorFatal = null;
try {
  whatsapp = '510000' + String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
  // En el muro: prueba vencida hace 3 días. Todo lo que se pregunta acá es libre.
  u = await sb.insert('usuarios', {
    whatsapp, nombre: 'QA Preguntas', is_test_user: true,
    onboarding_completado: true, onboarding_paso: 0,
    plan: 'free', trial_estado: 'vencido', trial_inicio: new Date(Date.now() - 17 * 86400000).toISOString(), trial_vence: hace(3),
    recordatorios_activos: false,
  });
  console.log('usuario efímero ' + u.id + ' (en el muro)');

  await pregunta('clase 2 · app', 'Tienes alguna app', /No tengo app en Play Store ni en App Store/, { prohibido: /Neto Finanzas|desc[aá]rgala/i });
  await pregunta('clase 2 · app', 'Donde descargo tu app para celular', /No tengo app en Play Store ni en App Store/);
  await pregunta('clase 2 · conexiones', 'Te puedes conectar con Uber?', /No me conecto con bancos, tarjetas, Yape ni Uber/);
  await pregunta('clase 2 · conexiones', 'Puedo registrar alguna tarjeta de débito o crédito en la app?', /No me conecto con bancos, tarjetas, Yape ni Uber/);
  await pregunta('clase 2 · método de pago', 'Puedes diferenciar por el método de pago también?', /No me conecto con bancos|con qué pagaste/);
  await pregunta('clase 2 · cierre', 'El cierre no debe ser a las 00 horas?', /no cierra nada/);
  await pregunta('clase 2 · precio', 'Y después cuanto pago?', /No te cobro nada automático|No pierdes nada de lo que registraste/i);
  // La marca no puede ser el precio: en el muro, `consulta_financiera` muere en el muro y ESE texto
  // trae el precio (la corrida de control del 30-sep pasaba por ahí). Lo que solo dice el tema es
  // que no hay cobro automático.
  await pregunta('clase 6 · precio (iba a consulta_financiera)', 'Pregunta: después de 14 días, cuánto es el costo', /No te cobro nada automático|No pierdes nada de lo que registraste/i,
    { prohibido: /per[ií]odo de gracia|pr[eé]stamo/i });
  await pregunta('clase 2 · perder el registro', 'Pero vas a perder el registro o como?', /No pierdes nada de lo que registraste/);
  await pregunta('clase 2 · gmail', 'No puedes leer mis correos?', /Neto Pro pagado/, { prohibido: /sin que escribas nada/i });
  await pregunta('clase 3 · reiniciar', 'Quiero reiniciar', /no tengo un botón para reiniciar/i);

  console.log('\ncontrol · un gasto');
  const rGasto = await decir('gasté 12 en taxi');
  check(rGasto.nuevas.length === 1 && rGasto.nuevas[0].tipo === 'gasto' && Number(rGasto.nuevas[0].monto) === 12, 'registra S/12', rGasto.nuevas.map(firma).join(' ; '));
  await pregunta('clase 2 · se registró', 'Se registro si o no.?', /Tu último movimiento/);

  // "No deseo el pro" tiene que CERRAR la espera que "cuánto cuesta pro" abre en el muro. Si
  // la precondición no se da (el clasificador no fue a `ver_premium`), el cierre no se ejercitó.
  console.log('\nclase 3 · "No deseo el pro" después de preguntar el precio');
  await decir('cuánto cuesta pro');
  const armada = (await leerUsuario()).esperando_comprobante === true;
  if (!armada) nota('"cuánto cuesta pro" no abrió la espera del comprobante: el cierre no se ejercita');
  await pregunta('clase 3 · no quiero pro', 'No deseo el pro', /no tienes que pagar nada/);
  const despues = await leerUsuario();
  check(despues.esperando_comprobante !== true, 'la espera del comprobante queda cerrada', 'esperando_comprobante=' + despues.esperando_comprobante);
  if (!armada) noEjercitados.push('cierre de la espera');

  // ÚLTIMO: abre el paso -1. Nada de esta corrida manda la frase que borra.
  await pregunta('clase 3 · eliminar cuenta', 'Quiero eliminar mi cuenta', /^⚠️ \*Eliminar tu cuenta\*/, { prohibido: /Gmail/ });
} catch (e) {
  errorFatal = e;
  console.error('\nNo se pudo medir: ' + e.message);
} finally {
  await limpiar();
}

console.log(`\nResultado: ${fallos.length ? fallos.length + ' fallo(s): ' + fallos.join(' · ') : 'todo PASS'}`);
if (noEjercitados.length) console.log('No se ejercitó: ' + noEjercitados.join(', ') + (fallos.length ? '' : '. Repetir la corrida (exit 2).'));
process.exit(fallos.length ? 1 : (errorFatal || noEjercitados.length) ? 2 : 0);
