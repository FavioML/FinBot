#!/usr/bin/env node
/**
 * LAS EDICIONES QUE NADIE PIDIÓ, contra PRODUCCIÓN y por el webhook real (chip 5 de la tanda
 * "respuestas malas del día 0", 01-oct-2026). Reporte:
 * `C:\Vortik.dev\memory\reports\neto-respuestas-malas-medicion-2026-09-30.md`.
 *
 * Clase 8: detrás de un gasto recién anotado, el clasificador mandaba el gasto SIGUIENTE a una
 * edición del anterior. 12 ediciones por WhatsApp en toda la historia, 5 equivocadas. Este harness
 * repite las tres conversaciones reales, en su orden, sobre usuarios efímeros:
 *
 *   A. "gaste 10 en almuerzo", "25 para traer tronco", después "aby 143", "Aby 143" y "“145 Aby”":
 *      "traer tronco" tiene que seguir siendo "traer tronco" por S/25. Después, la salida que
 *      ofrece la pregunta ("gasté 143 en Aby") registra el gasto nuevo.
 *   B. "Ingreso independiente de 320 soles", después "Manos libres" (la respuesta real al cierre
 *      del día 2): el ingreso no se renombra y el Modo Manos Libres queda prendido; un segundo
 *      "Manos libres" no lo apaga.
 *   C. "12.00 cigarros", después "El pago de 12.00 de cigarros, lo pagué con la tarjeta de crédito
 *      BCP": el comercio no pasa a ser la tarjeta.
 *   D. CONTROL de que la guarda no frena lo legítimo: "Comida gaste 250" y "300 para ser exacto"
 *      deja el monto en 300; "Cambiar fecha 29 septiembre" cambia la fecha. Si el clasificador no
 *      lleva alguno a la edición, se anota como no ejercitado.
 *
 * Lo que se afirma SIEMPRE, vaya donde vaya el clasificador, es lo que pasa en la base: ninguna
 * fila que el mensaje no nombró cambia. El texto de la respuesta se anota.
 *
 * **Cómo no le escribe a nadie**, el molde de `qa-dia0-respuestas.mjs`: usuarios `is_test_user`
 * con número `510000…` (no asignable), limpieza COMPROBADA desde un `finally` y ante Ctrl+C. Las
 * transacciones que crea se van con el usuario (cascada).
 *
 * Corre DESPUÉS del deploy: contra el commit anterior es el CONTROL (tiene que fallar).
 *
 *   node qa-e2e/qa-respuestas-malas-edicion.mjs
 *
 * exit 0 = todo pasa y no quedó nada · 1 = algún caso falla o quedó basura · 2 = no pudo medir o
 * algún control no se ejercitó. NO va al canary: pasa por OpenAI y escribe en prod.
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

// REST directo y no supabase-js: este harness es el ORÁCULO. Las operaciones LANZAN.
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
    contacts: [{ wa_id: from, profile: { name: 'QA Edicion' } }],
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
let abortado = false;
const creados = [];   // { id, whatsapp, piso }

async function crear(fila) {
  const whatsapp = '510000' + String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
  const u = await sb.insert('usuarios', { whatsapp, is_test_user: true, recordatorios_activos: false, ...fila });
  const reg = { id: u.id, whatsapp, piso: 0 };
  creados.push(reg);
  return reg;
}


let limpio = false;
async function limpiar() {
  if (limpio || !creados.length) return;
  limpio = true;
  console.log('\nLimpieza');
  for (const u of creados) {
    try {
      for (const t of ['transacciones', 'conversaciones', 'notificaciones', 'notification_deliveries', 'nlp_errors']) {
        await sb.del(t, `usuario_id=eq.${u.id}`);
      }
      await sb.del('neto_scores', `user_id=eq.${u.id}`);
      await sb.del('usuarios', `id=eq.${u.id}`);
      const quedan = await sb.select('usuarios', `id=eq.${u.id}&select=id`);
      check(quedan.length === 0, 'se borró el usuario efímero ' + u.id.slice(0, 8), quedan.length ? 'QUEDÓ, bórralo a mano' : '');
    } catch (e) {
      check(false, 'se borró el usuario efímero ' + u.id.slice(0, 8), 'el borrado falló: ' + e.message);
    }
  }
}
// Ctrl+C no limpia en paralelo: borrar el usuario mientras el backend procesa el turno en vuelo
// lo recrea SIN `is_test_user` (revisión adversarial del molde, 14-sep).
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (abortado) { console.error('\nSalida forzada SIN limpiar: revisa ' + creados.map((u) => u.whatsapp).join(', ')); process.exit(1); }
    abortado = true;
    console.error('\nCortando: termino el turno en vuelo y limpio (otro Ctrl+C sale sin limpiar).');
  });
}

async function decir(u, texto) {
  if (abortado) throw new Error('cortado a mano antes de mandar ' + JSON.stringify(texto));
  const st = await enviarTexto(vars.META_APP_SECRET, u.whatsapp, texto, `wamid.qa-edicion-${sufijo}-${++n}`);
  if (st !== 200) throw new Error('el webhook devolvió HTTP ' + st);
  const r = await esperarRespuesta(sb, u.id, texto, u.piso);
  u.piso = r.entranteId;
  console.log(`    > ${JSON.stringify(texto)}\n    < ${r.texto === null ? '(sin respuesta)' : JSON.stringify(r.texto.slice(0, 220))}`);
  check(r.texto !== null, JSON.stringify(texto) + ': hubo respuesta');
  return r.texto || '';
}

const txs = (u) => sb.select('transacciones', `usuario_id=eq.${u.id}&select=id,comercio,monto,fecha,tipo&order=created_at.asc`);
const fila = async (id) => (await sb.select('transacciones', `id=eq.${id}&select=id,comercio,monto,fecha,tipo`))[0];
const manosLibres = async (u) => (await sb.select('usuarios', `id=eq.${u.id}&select=manos_libres`))[0].manos_libres;

/** Registra y devuelve la fila nueva; si no registró, el caso no se puede montar. */
async function registrar(u, texto) {
  const antes = (await txs(u)).map((t) => t.id);
  await decir(u, texto);
  const nueva = (await txs(u)).find((t) => !antes.includes(t.id));
  if (!nueva) throw new Error('el gasto de base ' + JSON.stringify(texto) + ' no se registró: no se puede montar el caso');
  return nueva;
}

/** Manda `texto` y afirma que la fila `base` quedó EXACTAMENTE como estaba. */
async function noToca(u, base, texto) {
  const r = await decir(u, texto);
  const despues = await fila(base.id);
  const igual = !!despues && despues.comercio === base.comercio && Number(despues.monto) === Number(base.monto)
    && despues.fecha === base.fecha && despues.tipo === base.tipo;
  check(igual, JSON.stringify(texto) + ': no edita ' + JSON.stringify(base.comercio),
    igual ? '' : 'quedó ' + JSON.stringify(despues));
  check(!/corregid[oa]/i.test(r), JSON.stringify(texto) + ': no dice "corregido"');
  return r;
}

const hoyLima = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
const sumarDias = (iso, d) => { const f = new Date(iso + 'T12:00:00Z'); f.setUTCDate(f.getUTCDate() + d); return f.toISOString().slice(0, 10); };
const EN_PRUEBA = () => ({
  nombre: 'QA', nombre_intentos: 0, onboarding_paso: 0, onboarding_completado: true,
  plan: 'premium', trial_estado: 'activo', trial_vence: sumarDias(hoyLima(), 10), manos_libres: false,
});

let errorFatal = null;
try {
  // ── A: la conversación de "Aby" ─────────────────────────────────────────────────────────────
  console.log('\nA · "aby 143" detrás de "25 para traer tronco"');
  const a = await crear(EN_PRUEBA());
  await registrar(a, 'gaste 10 en almuerzo');
  const tronco = await registrar(a, '25 para traer tronco');
  await noToca(a, tronco, 'aby 143');
  await noToca(a, tronco, 'Aby 143');
  await noToca(a, tronco, '“145 Aby”');
  // Regla 3: la respuesta corta a una pregunta de NETO sobre algo que NO guardó. "35.00" rebota
  // con "¿entraron o salieron?"; "es ingreso" no puede caerle a "traer tronco".
  await noToca(a, tronco, '35.00');
  await noToca(a, tronco, 'es ingreso');
  const nuevaAby = await registrar(a, 'gasté 143 en Aby');
  check(Number(nuevaAby.monto) === 143 && nuevaAby.tipo === 'gasto', 'A: la salida de la pregunta registra el gasto nuevo de S/143',
    JSON.stringify(nuevaAby));

  // ── B: "Manos libres" ───────────────────────────────────────────────────────────────────────
  console.log('\nB · "Manos libres" detrás de un ingreso');
  const b = await crear(EN_PRUEBA());
  const ingreso = await registrar(b, 'Ingreso independiente de 320 soles');
  const rb = await noToca(b, ingreso, 'Manos libres');
  check((await manosLibres(b)) === true, 'B: "Manos libres" prende el modo');
  check(/Manos Libres activado/.test(rb), 'B: lo confirma');
  const rb2 = await decir(b, 'Manos libres');
  check((await manosLibres(b)) === true, 'B: un segundo "Manos libres" no lo apaga');
  check(/ya está activado/.test(rb2), 'B: dice que ya estaba activado');

  // ── C: el método de pago no es un comercio ──────────────────────────────────────────────────
  console.log('\nC · el método de pago');
  const c = await crear(EN_PRUEBA());
  const cig = await registrar(c, '12.00 cigarros');
  const txC = (await txs(c)).length;
  await noToca(c, cig, 'El pago de 12.00 de cigarros, lo pagué con la tarjeta de crédito BCP');
  const txC2 = (await txs(c)).length;
  if (txC2 !== txC) nota('C: el mensaje de la tarjeta registró ' + (txC2 - txC) + ' movimiento(s) nuevo(s) (no es la clase 8, se anota)');

  // ── D: CONTROL, lo legítimo sigue editando ──────────────────────────────────────────────────
  console.log('\nD · control: correcciones legítimas');
  const d = await crear(EN_PRUEBA());
  const comida = await registrar(d, 'Comida gaste 250');
  const r300 = await decir(d, '300 para ser exacto');
  const comida2 = await fila(comida.id);
  if (/Monto corregido/.test(r300)) check(Number(comida2.monto) === 300, 'D: "300 para ser exacto" deja el monto en 300', JSON.stringify(comida2));
  else if (/corregir lo último/.test(r300)) check(false, 'D: "300 para ser exacto" edita', 'la guarda lo frenó: falso rechazo');
  else { nota('D: "300 para ser exacto" no llegó a la edición, no se juzga'); noEjercitados.push('"300 para ser exacto"'); }

  const anio = hoyLima().slice(0, 4);
  const rF = await decir(d, 'Cambiar fecha 29 septiembre');
  const comida3 = await fila(comida.id);
  if (/Fecha corregida/.test(rF)) check(comida3.fecha === anio + '-09-29', 'D: "Cambiar fecha 29 septiembre" cambia la fecha', JSON.stringify(comida3));
  else if (/corregir lo último/.test(rF)) check(false, 'D: "Cambiar fecha 29 septiembre" edita', 'la guarda lo frenó: falso rechazo');
  else { nota('D: "Cambiar fecha 29 septiembre" no llegó a la edición, no se juzga'); noEjercitados.push('"Cambiar fecha 29 septiembre"'); }
} catch (e) {
  errorFatal = e;
  console.error('\nNo se pudo medir: ' + e.message);
} finally {
  await limpiar();
}

console.log(`\nResultado: ${fallos.length ? fallos.length + ' fallo(s): ' + fallos.join(' · ') : 'todo PASS'}`);
if (noEjercitados.length) console.log('No se ejercitó: ' + noEjercitados.join(', ') + (fallos.length ? '' : '. Repetir la corrida (exit 2).'));
process.exit(fallos.length ? 1 : (errorFatal || noEjercitados.length) ? 2 : 0);
