#!/usr/bin/env node
/**
 * EL PARSER QUE DICE POR QUÉ NO REGISTRA, contra PRODUCCIÓN y por el webhook real (chip 1 de la
 * tanda "respuestas malas del día 0", 30-sep-2026). Reporte:
 * `C:\Vortik.dev\memory\reports\neto-respuestas-malas-medicion-2026-09-30.md`.
 *
 * Cada caso es un mensaje real de las clases 1 y 4, y lo que se afirma es la PLATA: qué fila
 * nació en `transacciones` (tipo y monto) o que no nació ninguna. El texto se mira después, y
 * sólo para saber si el caso llegó al camino que dice probar.
 *
 *   clase 1   "Almuerzo 10" y "Uñas 35" rebotaban 4 de 4 con "No pude leer el monto".
 *   clase 4   "35.00" entraba como INGRESO; "tengo que pagar 380" y un cupo de tarjeta como
 *             gasto de hoy; "Neto es 15800" lo registraba el rescate. Ninguno tiene que dejar fila.
 *   moneda    "20 euros" entraba como S/20. Tiene que rebotar diciendo que sólo se anotan soles
 *             y dólares.
 *   deuda     "presté 100 a Juan" tiene que quedar `me_deben` (si el clasificador lo manda a
 *             deudas; si lo manda a otro lado, el caso no se ejercitó y sale exit 2).
 *   signo     "me yapearon 50" es un INGRESO de S/50 (un prompt intermedio lo daba gasto).
 *   control   "gasté 12 en taxi" registra S/12, antes y después del cambio.
 *
 * El orden importa: los números sueltos van ANTES de que exista cualquier movimiento, porque con
 * uno reciente el clasificador puede leer "35.00" como corrección del último (clase 8, chip 5) y
 * el caso no llegaría al parser. Además, cada turno compara TODAS las filas del usuario contra
 * las de antes: una fila editada sin pedirlo sale como "no ejercitado", con la diferencia a la
 * vista, en vez de pasar como "no creó nada".
 *
 * **Cómo no le escribe a nadie** — el molde de `qa-dia0-respuestas.mjs`: un solo usuario efímero
 * `is_test_user` con número `510000…` (no asignable), prueba activa sembrada, limpieza COMPROBADA
 * desde un `finally` y ante Ctrl+C. **Lo que deja:** las transacciones y la deuda que cree el bot
 * se borran, y cada una deja su copia en `borrados_auditoria` (append-only): como máximo 5 filas
 * por corrida, todas con el id del usuario efímero.
 *
 * Corre DESPUÉS del deploy: contra el commit anterior es el CONTROL (tiene que fallar).
 *
 *   node qa-e2e/qa-respuestas-malas-parser.mjs
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
    contacts: [{ wa_id: from, profile: { name: 'QA Parser' } }],
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

const filasTx = () => sb.select('transacciones', `usuario_id=eq.${u.id}&select=id,tipo,monto,moneda,comercio&order=id.asc`);
const firma = (f) => `${f.tipo}|${Number(f.monto)}|${f.moneda}|${f.comercio}`;

/**
 * Manda un mensaje y devuelve la respuesta y el EFECTO sobre la plata: las filas nuevas y las
 * que cambiaron (mismo id, otro tipo/monto/moneda/comercio).
 */
async function decir(texto) {
  if (abortado) throw new Error('cortado a mano antes de mandar ' + JSON.stringify(texto));
  const antes = new Map((await filasTx()).map((f) => [f.id, f]));
  const st = await enviarTexto(vars.META_APP_SECRET, whatsapp, texto, `wamid.qa-parser-${sufijo}-${++n}`);
  if (st !== 200) throw new Error('el webhook devolvió HTTP ' + st);
  const r = await esperarRespuesta(sb, u.id, texto, piso);
  piso = r.entranteId;
  const despues = await filasTx();
  const nuevas = despues.filter((f) => !antes.has(f.id));
  const editadas = despues.filter((f) => antes.has(f.id) && firma(antes.get(f.id)) !== firma(f))
    .map((f) => `${firma(antes.get(f.id))} → ${firma(f)}`);
  console.log(`    > ${JSON.stringify(texto)}\n    < ${r.texto === null ? '(sin respuesta)' : JSON.stringify(r.texto.slice(0, 240))}`);
  if (nuevas.length) console.log(`    filas nuevas: ${nuevas.map(firma).join(' ; ')}`);
  if (editadas.length) console.log(`    filas EDITADAS: ${editadas.join(' ; ')}`);
  return { texto: r.texto, nuevas, editadas };
}

/**
 * Un mensaje que NO tiene que dejar plata. `copy` dice si llegó al camino que el caso prueba.
 *
 * `opcional`: el clasificador lo manda a otro intent la mayoría de las veces (medido en la
 * corrida de control del 30-sep: "Neto es 15800" fue al Neto Score y "tengo que pagar 380" a
 * deudas). Ahí se afirma lo mismo —que no nazca plata— pero que no llegue al parser no hace la
 * corrida inconcluyente: esos dos se miden en la sonda del parser, sin clasificador.
 */
async function noRegistra(caso, texto, copy, etiquetaCopy, { opcional = false } = {}) {
  console.log('\n' + caso);
  const r = await decir(texto);
  check(r.texto !== null, 'hubo respuesta');
  check(r.nuevas.length === 0, 'no crea ninguna transacción', r.nuevas.map(firma).join(' ; '));
  if (r.editadas.length) {
    // Clase 8 (chip 5): el clasificador lo tomó como corrección del último. El parser no se
    // ejercitó, y "no creó nada" no dice nada sobre él.
    noEjercitados.push(caso);
    nota('editó un movimiento existente: el caso no llegó al parser (no ejercitado)');
    return r;
  }
  if (r.texto !== null && copy.test(r.texto)) {
    check(true, etiquetaCopy);
  } else if (opcional) {
    nota(`no llegó al parser (el clasificador lo mandó a otro lado); sólo se afirma que no nació plata`);
  } else {
    noEjercitados.push(caso);
    nota(`la respuesta no es la de ${etiquetaCopy}: el clasificador lo mandó a otro lado (no ejercitado)`);
  }
  return r;
}

/** Un mensaje que tiene que dejar EXACTAMENTE una fila, con este tipo y este monto. */
async function registra(caso, texto, tipo, monto) {
  console.log('\n' + caso);
  const r = await decir(texto);
  check(r.nuevas.length === 1, 'crea exactamente una transacción', 'filas=' + r.nuevas.length);
  const f = r.nuevas[0];
  check(!!f && f.tipo === tipo && Math.abs(Number(f.monto) - monto) < 0.005 && f.moneda === 'PEN',
    `la fila es ${tipo} S/${monto}`, f ? firma(f) : 'sin fila');
  check(r.editadas.length === 0, 'no edita otro movimiento', r.editadas.join(' ; '));
  return r;
}

let limpio = false;
async function limpiar() {
  if (limpio || !u) return;
  limpio = true;
  console.log('\nLimpieza');
  try {
    // `deuda_abonos` NO tiene `usuario_id`: cuelga de la deuda. La primera corrida de control
    // (30-sep) lo borraba por `usuario_id`, el DELETE dio 400 y el usuario efímero quedó vivo.
    const suyas = await sb.select('deudas', `usuario_id=eq.${u.id}&select=id`);
    if (suyas.length) await sb.del('deuda_abonos', `deuda_id=in.(${suyas.map((d) => d.id).join(',')})`);
    for (const t of ['deudas', 'transacciones', 'transacciones_eliminadas', 'conversaciones', 'notificaciones', 'notification_deliveries']) {
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
// lo recrea SIN `is_test_user` (revisión adversarial del molde, 14-sep). Se marca y limpia el
// `finally`; un segundo Ctrl+C sale sin limpiar y lo dice.
let abortado = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (abortado) { console.error('\nSalida forzada SIN limpiar: revisa usuarios con whatsapp=' + whatsapp); process.exit(1); }
    abortado = true;
    console.error('\nCortando: termino el turno en vuelo y limpio (otro Ctrl+C sale sin limpiar).');
  });
}

const en13 = new Date(Date.now() + 13 * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
const PREGUNTA_TIPO = /entraron o salieron/i;

let errorFatal = null;
try {
  whatsapp = '510000' + String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
  u = await sb.insert('usuarios', {
    whatsapp, nombre: 'QA Parser', is_test_user: true,
    onboarding_completado: true, onboarding_paso: 0,
    plan: 'premium', trial_estado: 'activo', trial_inicio: new Date().toISOString(), trial_vence: en13,
    recordatorios_activos: false,
  });
  console.log('usuario efímero ' + u.id);

  // Números sueltos primero, sin movimientos que el clasificador pueda querer corregir.
  const r35 = await noRegistra('clase 4 · número solo', '35.00', PREGUNTA_TIPO, 'la pregunta de tipo');
  if (r35.texto && PREGUNTA_TIPO.test(r35.texto)) check(/S\/35\b/.test(r35.texto), 'la pregunta nombra el monto (S/35)');
  await noRegistra('clase 4 · "Neto es"', 'Neto es 15800', PREGUNTA_TIPO, 'la pregunta de tipo', { opcional: true });
  await noRegistra('clase 4 · pago futuro', 'tengo que pagar 380', /Eso no lo anoté/, 'el rechazo de no-movimiento', { opcional: true });
  await noRegistra('clase 4 · cupo de tarjeta', 'saqué una tarjeta de crédito con 500 disponibles', /Eso no lo anoté/, 'el rechazo de no-movimiento');
  await noRegistra('moneda', 'Eh gastado 20 euros en un polo', /solo anoto soles y dólares/, 'el rechazo de moneda');

  await registra('control', 'gasté 12 en taxi', 'gasto', 12);
  await registra('clase 1 · forma corta', 'Almuerzo 10', 'gasto', 10);
  await registra('clase 1 · forma corta', 'Uñas 35', 'gasto', 35);
  // El signo: la segunda revisión adversarial encontró que un prompt intermedio daba "me yapearon
  // 50" como GASTO. Lo cuida el invariante `tipoContradiceElMensaje` además del prompt.
  await registra('signo · ingreso por Yape', 'me yapearon 50', 'ingreso', 50);

  console.log('\ndeuda · "presté" sin "le"');
  const antesDeuda = await sb.select('deudas', `usuario_id=eq.${u.id}&select=id`);
  const rDeuda = await decir('presté 100 a Juan');
  const deudas = await sb.select('deudas', `usuario_id=eq.${u.id}&select=id,tipo,monto_original,contraparte`);
  const nuevaDeuda = deudas.filter((d) => !antesDeuda.some((a) => a.id === d.id));
  if (nuevaDeuda.length) {
    check(nuevaDeuda.length === 1 && nuevaDeuda[0].tipo === 'me_deben' && Number(nuevaDeuda[0].monto_original) === 100,
      'la deuda es me_deben por S/100', nuevaDeuda.map((d) => `${d.tipo} ${d.monto_original} ${d.contraparte}`).join(' ; '));
  } else {
    noEjercitados.push('deuda');
    nota(`no se creó deuda: el clasificador lo mandó a otro lado (${rDeuda.nuevas.length ? 'dejó un GASTO: ' + rDeuda.nuevas.map(firma).join(' ; ') : 'sin fila'}); no ejercitado`);
  }
} catch (e) {
  errorFatal = e;
  console.error('\nNo se pudo medir: ' + e.message);
} finally {
  await limpiar();
}

console.log(`\nResultado: ${fallos.length ? fallos.length + ' fallo(s): ' + fallos.join(' · ') : 'todo PASS'}`);
if (noEjercitados.length) console.log('No se ejercitó: ' + noEjercitados.join(', ') + (fallos.length ? '' : '. Repetir la corrida (exit 2).'));
process.exit(fallos.length ? 1 : (errorFatal || noEjercitados.length) ? 2 : 0);
