#!/usr/bin/env node
/**
 * CAMBIAR EL TIPO (gasto ↔ ingreso) DEL ÚLTIMO MOVIMIENTO POR WHATSAPP, contra PRODUCCIÓN y por el
 * webhook firmado (24-nov-2026). La decisión vive en `lib/orden-edicion.js` (`esOrdenDeTipo`,
 * `tipoDicho`, `selectorDeTipo`) y se aplica en `dispatchIntent` y en el case `marcar_como_ingreso`.
 *
 * El caso de prod (ec843051, 16 y 17-nov): un estacionamiento de S/9.60 quedó como INGRESO y la persona
 * probó "Corregir como gasto", "Cambiar los 9.60 de estacionamiento como gasto" y "Cambia 9.60 de ingreso
 * como gasto" (las tres recibieron la pregunta fija y nada cambió), y al día siguiente "Corregir es
 * gasto", que fue a deudas, recibió "¿Con quién es?" y terminó en una deuda de S/4.80 a su propio
 * nombre. Borró la fila y la creó de nuevo en la app.
 *
 * Cada caso siembra el último movimiento en la base, manda la frase real y afirma sobre la BASE: el tipo
 * de la fila sembrada, que no aparezcan transacciones ni deudas de más. Cada caso con un usuario NUEVO.
 *
 *   node qa-e2e/qa-correccion-tipo.mjs [--n 3] [--solo corregir-como-gasto,ya-es-gasto]
 *
 * Corre DESPUÉS del deploy (confirmado con `/version`): contra el commit anterior es el CONTROL y tiene
 * que fallar en los casos que cambian el tipo.
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
    contacts: [{ wa_id: from, profile: { name: 'QA Tipo' } }],
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
  // En prueba Pro, como quien se quejó (ec843051 estaba en su prueba).
  const u = await sb.insert('usuarios', {
    whatsapp, is_test_user: true, recordatorios_activos: false,
    nombre: 'Rayza', onboarding_paso: 0, onboarding_completado: true,
    plan: 'premium', trial_estado: 'activo', trial_vence: sumarDias(hoyLima(), 10),
  });
  const reg = { id: u.id, whatsapp };
  creados.push(reg);
  return reg;
}

async function decir(u, texto) {
  if (abortado) throw new Error('cortado a mano antes de mandar ' + JSON.stringify(texto));
  const st = await enviarTexto(vars.META_APP_SECRET, u.whatsapp, texto, `wamid.qa-tipo-${sufijo}-${++n}`);
  if (st !== 200) throw new Error('el webhook devolvió HTTP ' + st);
  return esperarRespuesta(sb, u.id, texto);
}

const txDe = (u) => sb.select('transacciones', `usuario_id=eq.${u.id}&select=id,tipo,monto,comercio,categoria&order=created_at.asc`);
const deudasDe = (u) => sb.select('deudas', `usuario_id=eq.${u.id}&select=id,tipo,monto_original,contraparte`);

async function sembrarTx(u, tipo) {
  return sb.insert('transacciones', {
    usuario_id: u.id, tipo, monto: 9.6, monto_pen: 9.6, moneda: 'PEN', comercio: 'Estacionamiento',
    categoria: 'Transporte', subcategoria: 'Estacionamiento', fecha: hoyLima(), confirmado: true,
  });
}

// El turno que deja la captura desde este cambio (handlers/webhook.js), con el mismo formato.
async function sembrarConfirmacionCaptura(u, monto) {
  await sb.insert('conversaciones', { usuario_id: u.id, rol: 'neto',
    mensaje: '📸 *Ingreso registrado*\n\n💵 *Estacionamiento* — S/ ' + monto + '\nTransporte > Estacionamiento · ' + hoyLima() });
}

const tipoDe = async (u, id) => ((await txDe(u)).find((t) => t.id === id) || {}).tipo;
const resumen = (txs) => JSON.stringify(txs.map((t) => `${t.tipo} ${t.monto} ${t.comercio}`));

// Lo común: la fila sembrada termina con `tipoFinal`, no hay transacciones nuevas ni deudas de más.
function quedaComo(tipoFinal, { deudas = 0, extra } = {}) {
  return async (u, r, s) => {
    const txs = await txDe(u);
    const d = await deudasDe(u);
    const checks = [
      [(await tipoDe(u, s.tx.id)) === tipoFinal, `la fila sembrada queda como ${tipoFinal}`, resumen(txs)],
      [txs.length === 1, 'ninguna transacción nueva', resumen(txs)],
      [d.length === deudas, deudas ? 'solo la deuda del turno previo' : 'ninguna deuda', JSON.stringify(d.map((x) => `${x.tipo} ${x.monto_original} ${x.contraparte}`))],
    ];
    if (extra) checks.push(...extra(r));
    return checks;
  };
}

const CASOS = {
  // Las frases de producción, sobre el último movimiento.
  'corregir-como-gasto': { msg: 'Corregir como gasto', afirmar: quedaComo('gasto') },
  'con-monto-y-nombre': { msg: 'Cambiar los 9.60 de estacionamiento como gasto', afirmar: quedaComo('gasto') },
  'con-monto': { msg: 'Cambia 9.60 de ingreso como gasto', afirmar: quedaComo('gasto') },
  // Con una deuda anotada justo antes: el historial con el que "Corregir es gasto" se fue a deudas.
  'corregir-es-gasto-tras-deuda': {
    previos: ['Debo a Gonzalo Paredes 500 soles'], msg: 'Corregir es gasto',
    afirmar: quedaComo('gasto', { deudas: 1, extra: (r) => [[!/Con quién es/.test(r || ''), 'no pregunta "¿Con quién es?"']] }),
  },
  // El ejemplo de la propia pregunta fija: hacia gasto no pasaba nunca.
  'marcalo-como-gasto': { msg: 'márcalo como gasto', afirmar: quedaComo('gasto') },
  // La otra dirección, que ya andaba.
  'marcalo-como-ingreso': { sembrarTipo: 'gasto', msg: 'márcalo como ingreso', afirmar: quedaComo('ingreso') },
  // La forma corta detrás de la confirmación de una captura.
  'eliptica-tras-captura': { conCaptura: '9.60', msg: 'Es un gasto', afirmar: quedaComo('gasto') },

  // Lo que NO cambia nada.
  'ya-es-gasto': {
    sembrarTipo: 'gasto', msg: 'Corregir es gasto',
    afirmar: quedaComo('gasto', { extra: (r) => [[/ya está como \*gasto\*/.test(r || ''), 'dice que ya estaba como gasto']] }),
  },
  'monto-ajeno': {
    msg: 'Cambia 30 de gasolina como gasto',
    afirmar: quedaComo('ingreso', { extra: (r) => [[/No cambié nada/.test(r || ''), 'dice que no cambió nada']] }),
  },
  // La confirmación de OTRA captura (otro monto) no ancla la elíptica sobre esta fila.
  'eliptica-otra-captura': { conCaptura: '5.59', msg: 'Es un gasto', afirmar: quedaComo('ingreso') },
  'eliptica-sin-confirmacion': { msg: 'es gasto', afirmar: quedaComo('ingreso') },
  'nombre-y-monto-sin-deuda': {
    msg: 'Rayza Quispe Arana 4.8 es gasto cambiar',
    afirmar: quedaComo('ingreso', { extra: (r) => [[!/Le debes|te debe/.test(r || ''), 'no anota una deuda']] }),
  },
  // CONTROL: un gasto nuevo detrás del ingreso es una fila nueva y no toca el ingreso.
  'gasto-nuevo': {
    msg: 'gasté 20 en taxi',
    async afirmar(u, r, s) {
      const txs = await txDe(u);
      return [
        [(await tipoDe(u, s.tx.id)) === 'ingreso', 'el ingreso sembrado no se toca', resumen(txs)],
        [txs.length === 2 && txs.some((t) => t.id !== s.tx.id && t.tipo === 'gasto' && Number(t.monto) === 20), 'anota el gasto nuevo de 20', resumen(txs)],
      ];
    },
  },
};

async function correrCaso(nombre, corrida) {
  const caso = CASOS[nombre];
  const u = await crearUsuario();
  const s = { tx: await sembrarTx(u, caso.sembrarTipo || 'ingreso') };
  for (const previo of caso.previos || []) await decir(u, previo);
  if (caso.conCaptura) await sembrarConfirmacionCaptura(u, caso.conCaptura);
  const r = await decir(u, caso.msg);
  const etiqueta = `${nombre} #${corrida}`;
  const lineas = [`${etiqueta}  > ${JSON.stringify(caso.msg)}`, `    < ${r === null ? '(sin respuesta)' : JSON.stringify(r.slice(0, 240))}`];
  const checks = r === null ? [[false, 'hubo respuesta']] : await caso.afirmar(u, r, s);
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
      for (const t of ['transacciones', 'transacciones_eliminadas', 'deudas', 'conversaciones', 'notificaciones', 'notification_deliveries', 'nlp_errors']) {
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
