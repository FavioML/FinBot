#!/usr/bin/env node
/**
 * LA PROMESA DEL CIERRE DEL DÍA, contra PRODUCCIÓN y por el webhook real (plan día 0→1, paso 2,
 * 14-sep-2026). Lo que la suite prueba con dobles, acá se prueba con el clasificador de verdad:
 *
 *   promesa    el primer gasto (el que estrena la prueba) avisa "esta noche a las 9 te mando el
 *              cierre de tu día" si son antes de las 21h Lima; después, no.
 *
 * El cierre en sí lo manda un cron a las 21h a quien escribió ese día, y no se puede disparar
 * desde acá: se verifica con el dry-run (`scripts/preview-cierre-dia-prueba.js`) a las ~20:50 y
 * con `notification_deliveries` (`tipo='cierre_dia_prueba'`) después de las 21:15.
 *
 * Tenía además tres casos del "sí" a la oferta del día 2. Se fueron con esa rama: la oferta ahora
 * es "Escribe /manoslibres", un comando que ya existe y ya está cubierto (ver `docs/DEFECTOS.md`,
 * 14-sep, sobre por qué se retiró el "sí").
 *
 * Mismo molde que `qa-dia0-respuestas.mjs`, y por los mismos motivos:
 *   - usuario efímero `is_test_user` con número `510000…` (no es un celular válido; `enviarWhatsapp`
 *     no llama a Meta para un usuario de prueba);
 *   - la respuesta se ata al mensaje por `conversaciones.id`, no por reloj;
 *   - Ctrl+C marca y el `finally` limpia (limpiar en paralelo recrearía el número sin la marca);
 *   - un caso que pasa sin haber ejercitado lo que dice probar sale exit 2, no PASS.
 *
 * Deja, dicho: el primer gasto lo registra el bot, así que al borrar queda UNA fila en
 * `borrados_auditoria` (append-only) con el id del usuario efímero.
 *
 * Corre DESPUÉS del deploy; contra el commit anterior es el CONTROL (la promesa tiene que faltar).
 *
 *   node qa-e2e/qa-dia0-cierre.mjs
 *
 * exit 0 = pasa y no quedó nada · 1 = falla o quedó basura · 2 = no pudo medir o corrió después de
 * las 21h (el caso positivo no se ejercita). NO va al canary: pasa por OpenAI y escribe en prod.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

const RAILWAY = { P: 'e2aac0f3-c2ee-4347-892c-b36d8c76929e', S: '1085b433-8f29-4487-9ce7-3a66b64ef244', E: '1600a753-bc8c-492c-aca7-27fdac946747' };
const WEBHOOK = process.env.NETO_WEBHOOK || 'https://api.neto.pe/webhook';
const ESPERA_MS = 60000;
const COLA_MS = 4000;
const PROMESA = /Esta noche a las 9 te mando el cierre de tu d[ií]a/;

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

// REST directo y no supabase-js: este harness es el ORÁCULO. Todas las operaciones LANZAN.
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
    contacts: [{ wa_id: from, profile: { name: 'QA Cierre' } }],
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
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

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
async function decir(texto) {
  if (abortado) throw new Error('cortado a mano antes de mandar ' + JSON.stringify(texto));
  const st = await enviarTexto(vars.META_APP_SECRET, whatsapp, texto, `wamid.qa-cierre-${sufijo}-${++n}`);
  if (st !== 200) throw new Error('el webhook devolvió HTTP ' + st);
  const r = await esperarRespuesta(sb, u.id, texto, piso);
  piso = r.entranteId;
  console.log(`    > ${JSON.stringify(texto)}\n    < ${r.texto === null ? '(sin respuesta)' : JSON.stringify(r.texto.slice(0, 260))}`);
  return r.texto;
}

let limpio = false;
async function limpiar() {
  if (limpio || !u) return;
  limpio = true;
  console.log('\nLimpieza');
  try {
    // `survey_events` nombra su columna `user_id`, no `usuario_id`: la primera corrida de control
    // se cortó ahí y dejó la fila del usuario efímero.
    for (const [t, col] of [['metas_ahorro', 'usuario_id'], ['transacciones', 'usuario_id'], ['transacciones_eliminadas', 'usuario_id'],
      ['conversaciones', 'usuario_id'], ['notificaciones', 'usuario_id'], ['notification_deliveries', 'usuario_id'], ['survey_events', 'user_id']]) {
      await sb.del(t, `${col}=eq.${u.id}`);
    }
    await sb.del('usuarios', `id=eq.${u.id}`);
    const quedan = await sb.select('usuarios', `id=eq.${u.id}&select=id`);
    check(quedan.length === 0, 'se borró el usuario efímero', quedan.length ? 'QUEDÓ la fila ' + u.id + ', bórrala a mano' : '');
  } catch (e) {
    check(false, 'se borró el usuario efímero', 'el borrado falló: ' + e.message + ', revisa ' + u.id);
  }
}
let abortado = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (abortado) { console.error('\nSalida forzada SIN limpiar: revisa usuarios con whatsapp=' + whatsapp); process.exit(1); }
    abortado = true;
    console.error('\nCortando: termino el turno en vuelo y limpio (otro Ctrl+C sale sin limpiar).');
  });
}

const horaLima = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Lima', hour: 'numeric', hourCycle: 'h23' }).format(new Date()));

let errorFatal = null;
try {
  whatsapp = '510000' + String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
  // SIN prueba: el primer gasto es el que la estrena, y la promesa sólo va en esa respuesta.
  // `recordatorios_activos` en true a propósito: con false la promesa no sale (el cron lo excluye).
  // Nadie le escribe igual: es `is_test_user`, y el cron del cierre también los excluye.
  u = await sb.insert('usuarios', {
    whatsapp, nombre: 'QA Cierre', is_test_user: true,
    onboarding_completado: true, onboarding_paso: 0,
    plan: 'free', trial_estado: null, recordatorios_activos: true, manos_libres: false,
  });
  console.log('usuario efímero ' + u.id + ' · hora Lima ' + horaLima + 'h');

  console.log('\npromesa');
  const rGasto = await decir('gasté 12 en taxi');
  const fila = (await sb.select('usuarios', `id=eq.${u.id}&select=trial_estado`))[0];
  check(rGasto !== null && /12[.,]00/.test(rGasto), 'registra el primer gasto');
  if (fila.trial_estado !== 'activo') {
    throw new Error('el primer gasto no estrenó la prueba (trial_estado=' + fila.trial_estado + '): la promesa no se puede medir');
  }
  if (horaLima < 21) {
    check(rGasto !== null && PROMESA.test(rGasto), 'antes de las 21h promete el cierre de la noche');
  } else {
    check(rGasto === null || !PROMESA.test(rGasto), 'después de las 21h NO promete el cierre');
    noEjercitados.push('promesa (corrió después de las 21h Lima: el caso positivo no se ejercitó)');
  }
} catch (e) {
  errorFatal = e;
  console.error('\nNo se pudo medir: ' + e.message);
} finally {
  await limpiar();
}

console.log(`\nResultado: ${fallos.length ? fallos.length + ' fallo(s): ' + fallos.join(' · ') : 'todo PASS'}`);
if (!fallos.length && noEjercitados.length) {
  console.log('Pero NO se ejercitó: ' + noEjercitados.join(', ') + '. Repetir antes de las 21h (exit 2).');
}
process.exit(fallos.length ? 1 : (errorFatal || noEjercitados.length) ? 2 : 0);
