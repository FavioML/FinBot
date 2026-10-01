#!/usr/bin/env node
/**
 * EL COMERCIO DE UN REGISTRO MANUAL, contra PRODUCCIÓN y por el webhook real (regresión del chip
 * 1, 01-oct-2026).
 *
 * Desde el deploy de `6aac09d` (30-sep 18:53 Lima) el parser con `json_schema` estricto guardaba
 * `transacciones.comercio = ''`: 16 filas reales en un día ("39 aguas", "Taxi 8.50", "Desayuno 8",
 * "Ingreso 84 soles"...), contra 1 en los siete días anteriores. Una fila sin nombre no se
 * distingue en la webapp, no le aplica ninguna regla de comercio y no se puede borrar nombrándola.
 *
 * Lo que se afirma, sobre UN usuario efímero ya dado de alta y en la prueba Pro, con mensajes
 * reales de ese día: cada mensaje deja EXACTAMENTE una fila nueva, con el monto y el tipo
 * esperados, y con un comercio que no está vacío ni es la etiqueta fija del piso ("Sin comercio":
 * el piso evita el vacío, pero usarlo es que el nombre no salió).
 *
 * **Cómo no le escribe a nadie**, el molde de `qa-respuestas-malas-nombre.mjs`: usuario
 * `is_test_user` con número `510000…` (no asignable), limpieza COMPROBADA desde un `finally` y
 * ante Ctrl+C.
 *
 * Corre DESPUÉS del deploy: contra el commit anterior es el CONTROL (tiene que fallar).
 *
 *   node qa-e2e/qa-respuestas-malas-comercio.mjs
 *
 * exit 0 = todo pasa y no quedó nada · 1 = algún caso falla o quedó basura · 2 = no pudo medir.
 * NO va al canary: pasa por OpenAI y escribe en prod.
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
    contacts: [{ wa_id: from, profile: { name: 'QA Comercio' } }],
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

const leerTx = async (u) => sb.select('transacciones', `usuario_id=eq.${u.id}&select=id,tipo,monto,comercio&order=created_at.asc`);

async function crear(fila) {
  const whatsapp = '510000' + String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
  const u = await sb.insert('usuarios', { whatsapp, is_test_user: true, recordatorios_activos: false, ...fila });
  const reg = { id: u.id, whatsapp, piso: 0 };
  creados.push(reg);
  return reg;
}

async function decir(u, texto) {
  if (abortado) throw new Error('cortado a mano antes de mandar ' + JSON.stringify(texto));
  const st = await enviarTexto(vars.META_APP_SECRET, u.whatsapp, texto, `wamid.qa-comercio-${sufijo}-${++n}`);
  if (st !== 200) throw new Error('el webhook devolvió HTTP ' + st);
  const r = await esperarRespuesta(sb, u.id, texto, u.piso);
  u.piso = r.entranteId;
  console.log(`    > ${JSON.stringify(texto)}\n    < ${r.texto === null ? '(sin respuesta)' : JSON.stringify(r.texto.slice(0, 160))}`);
  check(r.texto !== null, JSON.stringify(texto) + ': hubo respuesta');
  return r.texto || '';
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

const hoyLima = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
const sumarDias = (iso, d) => { const f = new Date(iso + 'T12:00:00Z'); f.setUTCDate(f.getUTCDate() + d); return f.toISOString().slice(0, 10); };

// Mensajes reales que el 30-sep y el 01-oct quedaron con comercio ''. Montos distintos a propósito:
// con el mismo monto y el mismo día, dos filas vacías compartían `dedup_hash`.
const CASOS = [
  ['39 aguas', 'gasto', 39],
  ['Taxi 8.50', 'gasto', 8.5],
  ['Desayuno 8', 'gasto', 8],
  ['Gaste 74.1 en mercado', 'gasto', 74.1],
  ['25 para traer tronco', 'gasto', 25],
  ['Ingreso 84 soles', 'ingreso', 84],
];

let errorFatal = null;
try {
  console.log('\nRegistros manuales con el nombre que la persona escribió');
  const u = await crear({
    nombre: 'QA Comercio', nombre_intentos: 0, onboarding_paso: 0, onboarding_completado: true,
    plan: 'premium', trial_estado: 'activo', trial_vence: sumarDias(hoyLima(), 10),
  });
  for (const [texto, tipo, monto] of CASOS) {
    const antes = await leerTx(u);
    await decir(u, texto);
    const despues = await leerTx(u);
    const nuevas = despues.filter((t) => !antes.some((a) => a.id === t.id));
    check(nuevas.length === 1, JSON.stringify(texto) + ': deja exactamente una fila', 'nuevas=' + nuevas.length);
    if (nuevas.length !== 1) continue;
    const t = nuevas[0];
    check(t.tipo === tipo && Number(t.monto) === monto, JSON.stringify(texto) + `: ${tipo} ${monto}`, `${t.tipo} ${t.monto}`);
    const c = (t.comercio || '').trim();
    check(c !== '' && c !== 'Sin comercio', JSON.stringify(texto) + ': tiene comercio', 'comercio=' + JSON.stringify(t.comercio));
  }
} catch (e) {
  errorFatal = e;
  console.error('\nNo se pudo medir: ' + e.message);
} finally {
  await limpiar();
}

console.log(`\nResultado: ${fallos.length ? fallos.length + ' fallo(s): ' + fallos.join(' · ') : 'todo PASS'}`);
process.exit(fallos.length ? 1 : errorFatal ? 2 : 0);
