#!/usr/bin/env node
/**
 * LA DIRECCIÓN DE UN PRÉSTAMO Y EL ABONO A UNA DEUDA EXISTENTE, contra PRODUCCIÓN y por el webhook
 * firmado (07-oct-2026). La decisión vive en `lib/prestamos.js` y se aplica en `dispatchIntent`.
 *
 * Los casos de prod (usuario d21c11e0):
 *   16-sep  "Y preste 118 soles" → "Anotado. Le debes S/ 118.00 a desconocida" (era al revés: prestó).
 *           Lo corrigió sola con "No no, yo le preste 118 soles a mi madre".
 *   14-sep  "Me preste 50 soles" → GASTO Finanzas > Prestamo.
 *   DEFECTOS 30-sep: con tool_choice 'required', "Me pagó mi tío 150 que me debía" va a
 *           `registrar_deuda` 3 de 3 (crea una deuda nueva en vez de abonar).
 *
 * Lo que se afirma, sobre la BASE (no sobre el texto, salvo que pregunte), en usuarios efímeros:
 *
 *   ambiguo-sin-tilde  "Y preste 118 soles"            no escribe nada y pregunta la dirección
 *   ambiguo-me-preste  "Me preste 50 soles"            no escribe nada (ni gasto) y pregunta
 *   le-preste          "No no, yo le preste 118 soles a mi madre"   UNA deuda me_deben de 118
 *   me-presto          "Mi mamá me prestó 200"         UNA deuda debo de 200
 *   abono              deuda me_deben Tío 300 sembrada + "Me pagó mi tío 150 que me debía":
 *                      ninguna deuda nueva, monto_pendiente 150 y UN deuda_abonos de 150
 *   abono-lado         sembradas me_deben Tío 300 y, MÁS RECIENTE, debo Tío 80: el abono va a la
 *                      me_deben (la que paga "me pagó") y la debo no se toca
 *   sin-deuda          la misma frase sin deuda sembrada: no escribe nada y pregunta
 *
 * Y en todos: ninguna transacción. Un préstamo nunca entra como gasto ni como ingreso.
 *
 * Cada caso corre `--n` veces (default 3), cada vez con un usuario NUEVO: el historial no puede
 * contaminar al clasificador, y la corrección automática de la "opuesta" de `registrar_deuda` (5 min)
 * no puede borrar una deuda de la corrida anterior.
 *
 * Cómo no le escribe a nadie: el molde de `qa-datos-no-dichos.mjs` (is_test_user, número `510000…`,
 * limpieza COMPROBADA desde un `finally` y ante Ctrl+C).
 *
 *   node qa-e2e/qa-prestamos-direccion.mjs [--n 3] [--solo abono,sin-deuda]
 *
 * Corre DESPUÉS del deploy (confirmado con `backend-deploy-fresh.mjs`): contra el commit anterior es
 * el CONTROL y tiene que fallar.
 *
 * exit 0 = todo pasa y no quedó nada · 1 = algún caso falla o quedó basura · 2 = no pudo medir.
 * NO va al canary: pasa por OpenAI y escribe en prod.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

const RAILWAY = { P: 'e2aac0f3-c2ee-4347-892c-b36d8c76929e', S: '1085b433-8f29-4487-9ce7-3a66b64ef244', E: '1600a753-bc8c-492c-aca7-27fdac946747' };
const WEBHOOK = process.env.NETO_WEBHOOK || 'https://api.neto.pe/webhook';
const ESPERA_MS = 75000;
const COLA_MS = 4000;

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const N = Number(arg('--n', 3));
const SOLO = arg('--solo', null);

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
    contacts: [{ wa_id: from, profile: { name: 'QA Prestamos' } }],
    messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: texto } }],
  };
  const body = { object: 'whatsapp_business_account', entry: [{ id: 'qa', changes: [{ field: 'messages', value }] }] };
  const raw = Buffer.from(JSON.stringify(body));
  const firma = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const r = await fetch(WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': firma }, body: raw });
  return r.status;
}

const fallos = [];
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/** La respuesta a ESTE mensaje, atada por `conversaciones.id` y no por reloj (ver el molde). */
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
  let respuesta = [];
  while (Date.now() < hasta) {
    respuesta = await leer();
    if (respuesta.length) break;
    await dormir(2000);
  }
  if (!respuesta.length) return null;
  await dormir(COLA_MS);
  respuesta = await leer();
  return respuesta.map((f) => f.mensaje).join('\n---\n');
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
const creados = [];

const hoyLima = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
const sumarDias = (iso, d) => { const f = new Date(iso + 'T12:00:00Z'); f.setUTCDate(f.getUTCDate() + d); return f.toISOString().slice(0, 10); };

async function crearUsuario() {
  const whatsapp = '510000' + String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
  // En prueba Pro: `registrar_deuda` y `abonar_deuda` los cobra el muro.
  const u = await sb.insert('usuarios', {
    whatsapp, is_test_user: true, recordatorios_activos: false,
    nombre: 'Rayza', onboarding_paso: 0, onboarding_completado: true,
    plan: 'premium', trial_estado: 'activo', trial_vence: sumarDias(hoyLima(), 10),
  });
  const reg = { id: u.id, whatsapp };
  creados.push(reg);
  return reg;
}

async function sembrarDeuda(u, tipo, contraparte, monto) {
  return sb.insert('deudas', {
    usuario_id: u.id, tipo, contraparte, monto_original: monto, monto_pendiente: monto, moneda: 'PEN', estado: 'activa',
  });
}

async function decir(u, texto) {
  if (abortado) throw new Error('cortado a mano antes de mandar ' + JSON.stringify(texto));
  const st = await enviarTexto(vars.META_APP_SECRET, u.whatsapp, texto, `wamid.qa-prestamos-${sufijo}-${++n}`);
  if (st !== 200) throw new Error('el webhook devolvió HTTP ' + st);
  return esperarRespuesta(sb, u.id, texto);
}

const deudasDe = (u) => sb.select('deudas', `usuario_id=eq.${u.id}&select=id,tipo,contraparte,monto_original,monto_pendiente,estado&order=created_at.asc`);
const txDe = (u) => sb.select('transacciones', `usuario_id=eq.${u.id}&select=id,tipo,monto,categoria`);
const abonosDe = async (deudaIds) => (deudaIds.length
  ? sb.select('deuda_abonos', `deuda_id=in.(${deudaIds.join(',')})&select=deuda_id,monto`) : []);

// "Pregunta" = abre una pregunta y no afirma que anotó nada. Con `¿` y no con `?`: la confirmación
// de un gasto trae el link de activación (`/activar?t=…`), y con `?` el control del 07-oct dio PASS
// sobre "✅ S/50.00 en Finanzas > Prestamo".
const pregunta = (r) => /¿/.test(r || '') && !/Anotado|Abono anotado|Listo,|✅/.test(r || '');
// El texto exacto de `preguntaDireccionPrestamo`: con /prest/ a secas pasaba también "¿A quién se lo
// prestaste?", que es una dirección DECIDIDA sin contraparte (revisión del 07-oct).
const preguntaDireccion = (r) => pregunta(r) && /prestaste tú o te los? prestaron|préstamo o un gasto/.test(r || '');

const CASOS = {
  'ambiguo-sin-tilde': {
    msg: 'Y preste 118 soles',
    async afirmar(u, r) {
      const d = await deudasDe(u);
      return [
        [d.length === 0, 'no crea ninguna deuda', JSON.stringify(d.map((x) => x.tipo + ' ' + x.monto_original))],
        [preguntaDireccion(r), 'pregunta si prestó o le prestaron'],
      ];
    },
  },
  'ambiguo-me-preste': {
    msg: 'Me preste 50 soles',
    async afirmar(u, r) {
      const d = await deudasDe(u);
      return [
        [d.length === 0, 'no crea ninguna deuda', JSON.stringify(d.map((x) => x.tipo + ' ' + x.monto_original))],
        [preguntaDireccion(r), 'pregunta si prestó o le prestaron'],
      ];
    },
  },
  'le-preste': {
    msg: 'No no, yo le preste 118 soles a mi madre',
    async afirmar(u) {
      const d = await deudasDe(u);
      return [[d.length === 1 && d[0].tipo === 'me_deben' && Number(d[0].monto_original) === 118 && /madre/i.test(d[0].contraparte),
        'UNA deuda me_deben de 118 con la madre', JSON.stringify(d.map((x) => `${x.tipo} ${x.monto_original} ${x.contraparte}`))]];
    },
  },
  'me-presto': {
    msg: 'Mi mamá me prestó 200',
    async afirmar(u) {
      const d = await deudasDe(u);
      return [[d.length === 1 && d[0].tipo === 'debo' && Number(d[0].monto_original) === 200 && /mam/i.test(d[0].contraparte),
        'UNA deuda debo de 200 con la mamá', JSON.stringify(d.map((x) => `${x.tipo} ${x.monto_original} ${x.contraparte}`))]];
    },
  },
  abono: {
    msg: 'Me pagó mi tío 150 que me debía',
    async sembrar(u) { return { meDeben: await sembrarDeuda(u, 'me_deben', 'Tío', 300) }; },
    async afirmar(u, r, s) {
      const d = await deudasDe(u);
      const ab = await abonosDe(d.map((x) => x.id));
      const md = d.find((x) => x.id === s.meDeben.id);
      return [
        [d.length === 1, 'no crea una deuda nueva', JSON.stringify(d.map((x) => `${x.tipo} ${x.monto_original} ${x.contraparte}`))],
        [md && Number(md.monto_pendiente) === 150, 'monto_pendiente de la me_deben queda en 150', 'pendiente=' + (md && md.monto_pendiente)],
        [ab.length === 1 && Number(ab[0].monto) === 150 && ab[0].deuda_id === s.meDeben.id, 'UN deuda_abonos de 150 sobre esa deuda', JSON.stringify(ab)],
      ];
    },
  },
  'abono-lado': {
    msg: 'Me pagó mi tío 150 que me debía',
    async sembrar(u) {
      const meDeben = await sembrarDeuda(u, 'me_deben', 'Tío', 300);
      await dormir(1100); // la debo es MÁS reciente: es la que `abonarDeuda` tomaba sin mirar el tipo
      const debo = await sembrarDeuda(u, 'debo', 'Tío', 80);
      return { meDeben, debo };
    },
    async afirmar(u, r, s) {
      const d = await deudasDe(u);
      const ab = await abonosDe(d.map((x) => x.id));
      const md = d.find((x) => x.id === s.meDeben.id);
      const db_ = d.find((x) => x.id === s.debo.id);
      return [
        [d.length === 2, 'no crea una deuda nueva', JSON.stringify(d.map((x) => `${x.tipo} ${x.monto_original} ${x.contraparte}`))],
        [md && Number(md.monto_pendiente) === 150, 'el abono va a la me_deben (pendiente 150)', 'pendiente=' + (md && md.monto_pendiente)],
        [db_ && Number(db_.monto_pendiente) === 80 && !ab.some((x) => x.deuda_id === s.debo.id), 'la debo no se toca', 'pendiente=' + (db_ && db_.monto_pendiente)],
      ];
    },
  },
  'sin-deuda': {
    msg: 'Me pagó mi tío 150 que me debía',
    async afirmar(u, r) {
      const d = await deudasDe(u);
      return [
        [d.length === 0, 'no crea ninguna deuda', JSON.stringify(d.map((x) => `${x.tipo} ${x.monto_original} ${x.contraparte}`))],
        [pregunta(r) && /No tengo anotado que/.test(r || ''), 'dice que no hay esa deuda y pregunta qué era'],
      ];
    },
  },
};

async function correrCaso(nombre, corrida) {
  const caso = CASOS[nombre];
  const u = await crearUsuario();
  const s = caso.sembrar ? await caso.sembrar(u) : {};
  const r = await decir(u, caso.msg);
  const etiqueta = `${nombre} #${corrida}`;
  const lineas = [`${etiqueta}  > ${JSON.stringify(caso.msg)}`, `    < ${r === null ? '(sin respuesta)' : JSON.stringify(r.slice(0, 240))}`];
  const checks = r === null ? [[false, 'hubo respuesta']] : await caso.afirmar(u, r, s);
  const tx = await txDe(u);
  checks.push([tx.length === 0, 'ninguna transacción', JSON.stringify(tx.map((x) => `${x.tipo} ${x.monto} ${x.categoria}`))]);
  for (const [ok, desc, det] of checks) {
    lineas.push(`    ${ok ? 'PASS' : 'FAIL'}  ${desc}${!ok && det ? '  (' + det + ')' : ''}`);
    if (!ok) fallos.push(`${etiqueta}: ${desc}`);
  }
  console.log(lineas.join('\n'));
}

let limpio = false;
async function limpiar() {
  if (limpio || !creados.length) return;
  limpio = true;
  console.log('\nLimpieza');
  let quedaron = 0;
  for (const u of creados) {
    try {
      const d = await sb.select('deudas', `usuario_id=eq.${u.id}&select=id`);
      if (d.length) await sb.del('deuda_abonos', `deuda_id=in.(${d.map((x) => x.id).join(',')})`);
      for (const t of ['transacciones', 'deudas', 'conversaciones', 'notificaciones', 'notification_deliveries', 'nlp_errors']) {
        await sb.del(t, `usuario_id=eq.${u.id}`);
      }
      await sb.del('usuarios', `id=eq.${u.id}`);
      if ((await sb.select('usuarios', `id=eq.${u.id}&select=id`)).length) { quedaron++; fallos.push('quedó el usuario ' + u.id); }
    } catch (e) {
      quedaron++;
      fallos.push('el borrado de ' + u.id.slice(0, 8) + ' falló: ' + e.message);
    }
  }
  console.log(`  ${quedaron ? 'FAIL' : 'PASS'}  ${creados.length - quedaron} de ${creados.length} usuarios efímeros borrados`);
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (abortado) { console.error('\nSalida forzada SIN limpiar: revisa ' + creados.map((u) => u.whatsapp).join(', ')); process.exit(1); }
    abortado = true;
    console.error('\nCortando: termino los turnos en vuelo y limpio (otro Ctrl+C sale sin limpiar).');
  });
}

const nombres = SOLO ? SOLO.split(',') : Object.keys(CASOS);
let errorFatal = null;
try {
  for (const k of nombres) if (!CASOS[k]) throw new Error('caso desconocido: ' + k);
  for (let i = 1; i <= N; i++) {
    console.log(`\n══ corrida ${i} de ${N} ══`);
    // Los casos de una corrida van en paralelo: cada uno tiene su usuario.
    await Promise.all(nombres.map((k) => correrCaso(k, i)));
  }
} catch (e) {
  errorFatal = e;
} finally {
  await limpiar();
}

if (errorFatal) {
  console.error('\nNo se pudo medir: ' + errorFatal.message);
  process.exit(fallos.length ? 1 : 2);
}
console.log(`\n${fallos.length ? 'FAIL' : 'PASS'}: ${fallos.length} fallos en ${nombres.length} casos × ${N}`);
for (const f of fallos) console.log('  - ' + f);
process.exit(fallos.length ? 1 : 0);
