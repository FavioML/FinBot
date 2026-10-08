#!/usr/bin/env node
/**
 * VARIOS MOVIMIENTOS EN UN MENSAJE, contra PRODUCCIÓN y por el webhook real (07-oct-2026).
 *
 * Un mensaje con N movimientos registra los N, o no escribe ninguno y le dice a la persona cuáles
 * no anotó. Nunca un ✅ de un subconjunto en silencio. Las cuatro primeras frases son de usuarios
 * reales y en producción dejaron UNA fila (o ninguna, con "No pude procesar eso"):
 *
 *   d21c11e0 16-sep   "Gaste 2 soles más en pasajes, gaste 1.30 en cigarros y preste 118 soles" → ✅ S/2
 *   02d9398d 19-sep   "70 que realice antes de ayer en comprar juguetes y 34.5 en el almuerzo de hoy" → ✅ S/70
 *   1baf9d04 28-sep   dos gastos en dos líneas → "No pude procesar eso" (hoy, tras 6aac09d, un solo objeto)
 *   c21774f4 07-oct   "Recibí mil soles hoy y gasté 280 … y 300 …" → ✅ S/280 + "No pude leer el monto"
 *
 * más "pan 3 leche 5" (S/3 en 1 de 3 corridas, docs/DEFECTOS.md 30-sep) y "gasté $20 en taxi y $5
 * en café" (el fanout fijaba la moneda en PEN), tres frases de las revisiones adversariales ("el
 * cambio de aceite", "depa 800", "medias 15") y dos CONTROLES de un solo movimiento, uno con una
 * fecha "el 06/10" que no puede contarse como segundo monto.
 *
 * **Se afirma sobre la TABLA `transacciones`, no sobre el texto**: cuántas filas, y para cada una
 * monto, tipo y moneda. El texto sólo se mira en la salida "no anoté ninguno", que es aceptable
 * únicamente donde un movimiento es de verdad dudoso ("preste 118 soles": ¿prestó o le
 * prestaron?), y ahí tiene que nombrar los tres montos.
 *
 * Por ser modelo, cada frase corre 3 veces, cada vez con un usuario efímero NUEVO (`is_test_user`,
 * número `510000` + 6 dígitos que no es un celular válido; ver `qa-dia0-respuestas.mjs`, de donde
 * sale el andamiaje). Borra y COMPRUEBA el borrado desde un `finally`. Lo que deja: una fila de
 * `borrados_auditoria` por transacción que creó el bot.
 *
 *   node qa-e2e/qa-varios-movimientos.mjs            (todas, 3 corridas)
 *   NETO_QA_CORRIDAS=1 node qa-e2e/qa-varios-movimientos.mjs
 *   NETO_QA_SOLO=depa,medias node qa-e2e/qa-varios-movimientos.mjs
 *   NETO_QA_HISTORIAL=1 node qa-e2e/qa-varios-movimientos.mjs   (con un gasto y una consulta antes)
 *
 * exit 0 = todo pasa y no quedó nada · 1 = alguna corrida falla o quedó basura · 2 = no pudo medir.
 * NO va al canary: pasa por OpenAI y escribe en tablas de prod.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

const RAILWAY = { P: 'e2aac0f3-c2ee-4347-892c-b36d8c76929e', S: '1085b433-8f29-4487-9ce7-3a66b64ef244', E: '1600a753-bc8c-492c-aca7-27fdac946747' };
const WEBHOOK = process.env.NETO_WEBHOOK || 'https://api.neto.pe/webhook';
const ESPERA_MS = 90000;
const COLA_MS = 4000;
const CORRIDAS = Number(process.env.NETO_QA_CORRIDAS || 3);
const HISTORIAL = process.env.NETO_QA_HISTORIAL === '1';

const G = (monto, moneda = 'PEN') => ({ monto, tipo: 'gasto', moneda });
const I = (monto, moneda = 'PEN') => ({ monto, tipo: 'ingreso', moneda });

// `esperado`: las filas exactas. `oNinguno`: si se acepta 0 filas, alternativas de lo que el texto tiene
// que nombrar. Sin `oNinguno`, 0 filas es un FAIL: esas frases no tienen nada dudoso.
const CASOS = [
  { id: 'd21c11e0', texto: 'Gaste 2 soles más en pasajes, gaste 1.30 en cigarros y preste 118 soles',
    // Con "preste" el enrutador de préstamos (`lib/prestamos.js`, 07-oct) pregunta ANTES del camino
    // de varios movimientos y contesta "No anoté nada todavía": también es "ninguno, y se dice".
    esperado: [G(2), G(1.3), G(118)], oNinguno: [[/\b2\b/, /1[.,]30/, /118/], [/No anoté nada/]] },
  { id: '02d9398d', texto: '70 que realice antes de ayer en comprar juguetes y 34.5 en el almuerzo de hoy',
    esperado: [G(70), G(34.5)] },
  { id: '1baf9d04', texto: 'Gaste 15.92 en la comida de Willy (mi perrito)\nGasté 5 soles en el estacionamiento',
    esperado: [G(15.92), G(5)] },
  { id: 'c21774f4', texto: 'Recibí mil soles hoy y gasté 280 en pago de parachoque y 300 gasto de chancalatas',
    esperado: [I(1000), G(280), G(300)] },
  { id: 'pan-leche', texto: 'pan 3 leche 5', esperado: [G(3), G(5)] },
  { id: 'dolares', texto: 'gasté $20 en taxi y $5 en café', esperado: [G(20, 'USD'), G(5, 'USD')] },
  // De las revisiones adversariales del 07-oct: una heurística del contador o la palabra "cambio"
  // mandaban estos mensajes de dos gastos al camino de uno.
  { id: 'cambio-aceite', texto: 'gasté 30 en el cambio de aceite y 15 en taxi', esperado: [G(30), G(15)] },
  { id: 'depa', texto: 'alquiler depa 800 y luz 120', esperado: [G(800), G(120)] },
  { id: 'medias', texto: 'polo 35, medias 15', esperado: [G(35), G(15)] },
  { id: 'control-uno', texto: 'gasté 12 en taxi', esperado: [G(12)] },
  { id: 'control-fecha', texto: 'gasté S/10 en cuota para futbol el 06/10', esperado: [G(10)] },
];

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
    contacts: [{ wa_id: from, profile: { name: 'QA Varios' } }],
    messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: texto } }],
  };
  const body = { object: 'whatsapp_business_account', entry: [{ id: 'qa', changes: [{ field: 'messages', value }] }] };
  const raw = Buffer.from(JSON.stringify(body));
  const firma = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const r = await fetch(WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': firma }, body: raw });
  return r.status;
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// La respuesta a ESTE mensaje, atada por `conversaciones.id` y no por reloj (ver qa-dia0-respuestas).
async function esperarRespuesta(sb, usuarioId, texto) {
  const hasta = Date.now() + ESPERA_MS;
  let entrante = null;
  while (Date.now() < hasta && !entrante) {
    const filas = await sb.select('conversaciones', `usuario_id=eq.${usuarioId}&rol=eq.usuario&select=id,mensaje&order=id.asc`);
    entrante = filas.find((f) => f.mensaje === texto) || null;
    if (!entrante) await dormir(1500);
  }
  if (!entrante) return null;
  const leer = () => sb.select('conversaciones', `usuario_id=eq.${usuarioId}&rol=eq.neto&id=gt.${entrante.id}&select=id,mensaje&order=id.asc`);
  let resp = [];
  while (Date.now() < hasta) {
    resp = await leer();
    if (resp.length) break;
    await dormir(2000);
  }
  if (!resp.length) return null;
  await dormir(COLA_MS);
  resp = await leer();
  return resp.map((f) => f.mensaje).join('\n---\n');
}

const clave = (f) => `${Number(f.monto).toFixed(2)}|${f.tipo}|${f.moneda}`;

/**
 * El veredicto de UNA corrida sobre las filas que dejó. Puro, para poder leerlo sin la red.
 * @returns {{ ok: boolean, detalle: string }}
 */
export function juzgar(caso, filas, respuesta) {
  const got = filas.map(clave).sort();
  const want = caso.esperado.map(clave).sort();
  if (got.length === want.length && got.every((g, i) => g === want[i])) return { ok: true, detalle: `${got.length} fila(s) exactas` };
  if (filas.length === 0 && caso.oNinguno) {
    // `oNinguno` es una lista de alternativas; cada una, regex que la respuesta tiene que cumplir todas.
    const nombra = caso.oNinguno.some((alt) => alt.every((re) => re.test(respuesta || '')));
    return { ok: nombra, detalle: nombra ? '0 filas y la respuesta nombra los montos' : '0 filas y la respuesta NO nombra todos los montos' };
  }
  return { ok: false, detalle: `filas [${got.join(', ') || 'ninguna'}] contra [${want.join(', ')}]` };
}

// Importable desde un test (por `juzgar`) sin disparar nada contra producción.
const esMain = !!process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('qa-e2e/qa-varios-movimientos.mjs');

if (esMain) {
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
  const creados = [];
  const fallos = [];
  let abortado = false;
  let errorFatal = null;

  async function crearUsuario() {
    const en13 = new Date(Date.now() + 13 * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
    const whatsapp = '510000' + String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
    const caso = { whatsapp, u: null };
    creados.push(caso);
    caso.u = await sb.insert('usuarios', {
      whatsapp, nombre: 'QA Varios', is_test_user: true,
      onboarding_completado: true, onboarding_paso: 0,
      plan: 'premium', trial_estado: 'activo', trial_inicio: new Date().toISOString(), trial_vence: en13,
      recordatorios_activos: false,
    });
    return caso;
  }

  let limpio = false;
  async function limpiar() {
    if (limpio) return;
    limpio = true;
    if (!creados.length) return;
    console.log('\nLimpieza');
    let ok = 0;
    for (const c of creados) {
      if (!c.u) continue;
      try {
        for (const t of ['transacciones', 'transacciones_eliminadas', 'conversaciones', 'notificaciones', 'notification_deliveries']) {
          await sb.del(t, `usuario_id=eq.${c.u.id}`);
        }
        await sb.del('usuarios', `id=eq.${c.u.id}`);
        const quedan = await sb.select('usuarios', `id=eq.${c.u.id}&select=id`);
        if (quedan.length) { fallos.push('limpieza ' + c.u.id); console.log('  FAIL  quedó el usuario ' + c.u.id); } else ok++;
      } catch (e) {
        fallos.push('limpieza ' + c.u.id);
        console.log('  FAIL  no se pudo borrar ' + c.u.id + ': ' + e.message);
      }
    }
    console.log(`  ${ok} de ${creados.filter((c) => c.u).length} usuarios efímeros borrados y comprobados`);
  }
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      if (abortado) { console.error('\nSalida forzada SIN limpiar: ' + creados.map((c) => c.whatsapp).join(', ')); process.exit(1); }
      abortado = true;
      console.error('\nCortando: termino la corrida en vuelo y limpio.');
    });
  }

  async function correr(caso, k) {
    if (abortado) return;
    const c = await crearUsuario();
    // Con NETO_QA_HISTORIAL=1 la persona ya conversó: el clasificador recibe las últimas 4 filas
    // (`historialConv.slice(-4)`), y un gasto y una consulta previos son el historial que más lo
    // empuja a otra intención. Las filas de esos turnos no cuentan para el veredicto.
    const previas = new Set();
    if (HISTORIAL) {
      for (const texto of ['gasté 12 en taxi', 'cuánto llevo hoy']) {
        const stH = await enviarTexto(vars.META_APP_SECRET, c.whatsapp, texto, `wamid.qa-varios-${sufijo}-${++n}`);
        if (stH !== 200 || (await esperarRespuesta(sb, c.u.id, texto)) === null) {
          await dormir(60000);
          throw new Error(`${caso.id} #${k}: el historial previo no tuvo respuesta`);
        }
      }
      for (const f of await sb.select('transacciones', `usuario_id=eq.${c.u.id}&select=id`)) previas.add(f.id);
    }
    const st = await enviarTexto(vars.META_APP_SECRET, c.whatsapp, caso.texto, `wamid.qa-varios-${sufijo}-${++n}`);
    if (st !== 200) throw new Error('el webhook devolvió HTTP ' + st);
    const resp = await esperarRespuesta(sb, c.u.id, caso.texto);
    if (resp === null) {
      // El backend puede seguir procesando (este camino hace varias llamadas al modelo). Borrar al
      // usuario con el mensaje en vuelo hace que el backend lo recree SIN `is_test_user`
      // (qa-dia0-respuestas, 14-sep): se le da un minuto más antes de que la limpieza corra.
      await dormir(60000);
      throw new Error(`${caso.id} #${k}: sin respuesta en ${ESPERA_MS / 1000}s`);
    }
    const filas = (await sb.select('transacciones', `usuario_id=eq.${c.u.id}&select=id,monto,tipo,moneda`))
      .filter((f) => !previas.has(f.id));
    const v = juzgar(caso, filas, resp);
    console.log(`  ${v.ok ? 'PASS' : 'FAIL'}  ${caso.id} #${k}  ${v.detalle}\n        < ${JSON.stringify(resp.slice(0, 200))}`);
    if (!v.ok) fallos.push(`${caso.id} #${k}`);
  }

  try {
    console.log(`Webhook ${WEBHOOK} · ${CASOS.length} frases × ${CORRIDAS} corridas${HISTORIAL ? ' · con historial previo' : ''}`);
    // NETO_QA_SOLO=id1,id2 corre sólo esas frases (para un control parcial).
    const solo = (process.env.NETO_QA_SOLO || '').split(',').filter(Boolean);
    for (const caso of CASOS.filter((c) => !solo.length || solo.includes(c.id))) {
      console.log('\n' + caso.id + '  ' + JSON.stringify(caso.texto));
      // Las corridas de una frase van en paralelo: cada una es un usuario distinto.
      // allSettled y no all: con `all`, el primer error saltaba a la limpieza mientras las otras
      // corridas seguían en vuelo, y borrar al usuario con un mensaje en proceso hace que el
      // backend lo recree SIN `is_test_user` (qa-dia0-respuestas, 14-sep).
      const rs = await Promise.allSettled(Array.from({ length: CORRIDAS }, (_, i) => correr(caso, i + 1)));
      const rechazo = rs.find((r) => r.status === 'rejected');
      if (rechazo) throw rechazo.reason;
    }
  } catch (e) {
    errorFatal = e;
    console.error('\nNo se pudo medir: ' + e.message);
  } finally {
    await limpiar();
  }

  console.log(`\nResultado: ${fallos.length ? fallos.length + ' fallo(s): ' + fallos.join(' · ') : 'todo PASS'}`);
  process.exit(fallos.length ? 1 : errorFatal ? 2 : 0);
}
