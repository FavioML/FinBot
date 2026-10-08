#!/usr/bin/env node
/**
 * UNA CORRECCIÓN DE CATEGORÍA MUEVE LA FILA QUE SE NOMBRA, Y UNA PREGUNTA NO ESCRIBE NADA, contra
 * PRODUCCIÓN y por el webhook firmado (08-oct-2026, ítem 45 del backlog y DEFECTOS L736(2)).
 *
 * Los casos de prod (usuario 90ba3e37, Pro pagado), con la conversación real como historial:
 *   25-sep  "si pero 11.40 a Salud"                → movió BOTICAS Y SALUD (S/ 15.00). El de 11.40 era
 *                                                    IKF 38 SANTA ANITA 1.
 *   25-sep  "y lo de IKF 38 SANTA ANITA 1 ?"       → una pregunta; volvió a mover BOTICAS Y SALUD.
 *   27-sep  "a que te refieres con los 15 soles en boticas y salud?"
 *                                                  → una pregunta; movió IKF 38 a Salud, guardó la
 *                                                    regla y la retroaplicó a los 9 gastos de IKF.
 *
 * Siembra, por usuario efímero: BOTICAS Y SALUD 15.00 (Alimentación), IKF 38 SANTA ANITA 1 11.40
 * (Alimentación > Snacks) y un CENTINELA, IKF 38 SANTA ANITA 1 23.00 más viejo: es la fila que una
 * regla retroaplicada o un "el más reciente del comercio" mueve sin que nadie la nombre.
 *
 * Lo que se afirma, sobre la BASE:
 *   monto       "si pero 11.40 a Salud"  → mueve SOLO la fila de 11.40 a Salud, o no escribe nada y
 *               pregunta. BOTICAS y el centinela no se tocan, y no queda ninguna regla de comercio
 *               (un monto elige UN gasto: no dice nada de los demás de ese comercio)
 *   pregunta-y  "y lo de IKF 38 SANTA ANITA 1 ?"                         → no escribe NADA
 *   pregunta-15 "a que te refieres con los 15 soles en boticas y salud?" → no escribe NADA
 * "Nada" = ninguna fila de `transacciones` cambia de categoría/subcategoría y `reglas_comercio`
 * queda vacía. Cada caso va con el historial real de ese momento (`--sin-historial` lo quita).
 *
 * Cada caso corre `--n` veces (default 3), cada vez con un usuario NUEVO.
 * Molde y limpieza: `qa-prestamos-direccion.mjs` (is_test_user, número `510000…`, borrado comprobado).
 *
 *   node qa-e2e/qa-corregir-categoria-fila.mjs [--n 3] [--solo monto,pregunta-y] [--sin-historial]
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
// `guardarReglaComercio` y `retroaplicarRegla` NO se esperan en el handler: la respuesta sale antes
// de que escriban. Sin esta espera extra, una pregunta que guarda una regla saldría PASS.
const ESPERA_FUEGO_MS = 6000;

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const N = Number(arg('--n', 3));
const SOLO = arg('--solo', null);
const SIN_HISTORIAL = args.includes('--sin-historial');

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
    contacts: [{ wa_id: from, profile: { name: 'QA Corregir' } }],
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

/** La respuesta a ESTE mensaje, atada por `conversaciones.id` y no por reloj. */
async function esperarRespuesta(sb, usuarioId, texto) {
  const hasta = Date.now() + ESPERA_MS;
  let entrante = null;
  while (Date.now() < hasta && !entrante) {
    const filas = await sb.select('conversaciones', `usuario_id=eq.${usuarioId}&rol=eq.usuario&select=id,mensaje&order=id.asc`);
    entrante = filas.filter((f) => f.mensaje === texto).pop() || null;
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
  const u = await sb.insert('usuarios', {
    whatsapp, is_test_user: true, recordatorios_activos: false,
    nombre: 'Rayza', onboarding_paso: 0, onboarding_completado: true,
    plan: 'premium', trial_estado: 'activo', trial_vence: sumarDias(hoyLima(), 10),
  });
  const reg = { id: u.id, whatsapp };
  creados.push(reg);
  return reg;
}

const BOTICAS = 'BOTICAS Y SALUD';
const IKF = 'IKF 38 SANTA ANITA 1';

async function sembrarGastos(u) {
  const hoy = hoyLima();
  const tx = (comercio, monto, fecha, sub) => sb.insert('transacciones', {
    usuario_id: u.id, tipo: 'gasto', monto, monto_pen: monto, moneda: 'PEN', comercio,
    categoria: 'Alimentación', subcategoria: sub, banco: 'BCP', fecha, confirmado: true,
  });
  // El centinela primero: es el más VIEJO de IKF, nadie lo nombra.
  const centinela = await tx(IKF, 23.00, sumarDias(hoy, -15), 'Snacks');
  await dormir(1100);
  const boticas = await tx(BOTICAS, 15.00, sumarDias(hoy, -16), 'Snacks');
  await dormir(1100);
  const ikf = await tx(IKF, 11.40, hoy, 'Snacks');
  return { centinela, boticas, ikf };
}

async function sembrarHistorial(u, turnos) {
  if (SIN_HISTORIAL) return;
  for (const [rol, mensaje] of turnos) {
    await sb.insert('conversaciones', { usuario_id: u.id, rol, mensaje });
  }
}

async function decir(u, texto) {
  if (abortado) throw new Error('cortado a mano antes de mandar ' + JSON.stringify(texto));
  const st = await enviarTexto(vars.META_APP_SECRET, u.whatsapp, texto, `wamid.qa-corregir-fila-${sufijo}-${++n}`);
  if (st !== 200) throw new Error('el webhook devolvió HTTP ' + st);
  return esperarRespuesta(sb, u.id, texto);
}

const txDe = (u) => sb.select('transacciones', `usuario_id=eq.${u.id}&select=id,comercio,monto,categoria,subcategoria&order=created_at.asc`);
const reglasDe = (u) => sb.select('reglas_comercio', `usuario_id=eq.${u.id}&select=comercio_pattern,categoria`);

const fila = (txs, id) => txs.find((t) => t.id === id);
const igual = (antes, despues) => despues && antes.categoria === despues.categoria && (antes.subcategoria || null) === (despues.subcategoria || null);
const desc = (t) => (t ? `${t.comercio} ${t.monto} ${t.categoria}${t.subcategoria ? ' > ' + t.subcategoria : ''}` : '(no está)');
// Afirma que movió algo. Una pregunta (`¿`) sin afirmación es la salida legítima de "no sé cuál".
// La confirmación real es "Listo! Movi …"; con /Movi/i suelto, "No moví nada" contaba como mover.
const afirmaMover = (r) => /Listo!|✅|Apliqu/.test(r || '');
const pregunta = (r) => /¿/.test(r || '') && !afirmaMover(r);

// Lo que Neto había dicho justo antes de cada mensaje, tal como pasó.
const H_MOVIO_BOTICAS = 'Listo! Movi *BOTICAS Y SALUD* (S/ 15.00) a *Salud*.\n\n_Aplique el cambio a todos los pagos anteriores de BOTICAS Y SALUD._';
const H_PREVIO = [['usuario', 'eso no va alimentacion snacks, eso va en medicamentos'], ['neto', H_MOVIO_BOTICAS]];

function noEscribioNada(s, txs, reglas) {
  return [
    [igual(s.boticas, fila(txs, s.boticas.id)), 'BOTICAS no cambia', desc(fila(txs, s.boticas.id))],
    [igual(s.ikf, fila(txs, s.ikf.id)), 'IKF 11.40 no cambia', desc(fila(txs, s.ikf.id))],
    [igual(s.centinela, fila(txs, s.centinela.id)), 'el centinela IKF 23.00 no cambia', desc(fila(txs, s.centinela.id))],
    [reglas.length === 0, 'ninguna regla de comercio', JSON.stringify(reglas)],
  ];
}

const CASOS = {
  monto: {
    msg: 'si pero 11.40 a Salud',
    historial: H_PREVIO,
    afirmar(r, s, txs, reglas) {
      const ikf = fila(txs, s.ikf.id);
      const movida = ikf && ikf.categoria === 'Salud';
      return [
        [movida || (igual(s.ikf, ikf) && pregunta(r)), 'mueve la fila de 11.40 a Salud, o no la toca y pregunta', desc(ikf)],
        [igual(s.boticas, fila(txs, s.boticas.id)), 'BOTICAS no cambia', desc(fila(txs, s.boticas.id))],
        [igual(s.centinela, fila(txs, s.centinela.id)), 'el centinela IKF 23.00 no cambia', desc(fila(txs, s.centinela.id))],
        [reglas.length === 0, 'ninguna regla de comercio (un monto elige UN gasto)', JSON.stringify(reglas)],
        [movida ? !/BOTICAS/i.test(r) : true, 'la respuesta no nombra a BOTICAS como movido'],
      ];
    },
  },
  'pregunta-y': {
    msg: 'y lo de IKF 38 SANTA ANITA 1 ?',
    historial: [...H_PREVIO, ['usuario', 'si pero 11.40 a Salud'], ['neto', H_MOVIO_BOTICAS]],
    afirmar(r, s, txs, reglas) {
      return [...noEscribioNada(s, txs, reglas), [!afirmaMover(r), 'no dice que movió algo']];
    },
  },
  'pregunta-15': {
    msg: 'a que te refieres con los 15 soles en boticas y salud?',
    historial: [...H_PREVIO, ['usuario', 'si pero 11.40 a Salud'], ['neto', H_MOVIO_BOTICAS],
      ['usuario', 'y lo de IKF 38 SANTA ANITA 1 ?'], ['neto', H_MOVIO_BOTICAS]],
    afirmar(r, s, txs, reglas) {
      return [...noEscribioNada(s, txs, reglas), [!afirmaMover(r), 'no dice que movió algo']];
    },
  },
};

async function correrCaso(nombre, corrida) {
  const caso = CASOS[nombre];
  const u = await crearUsuario();
  const s = await sembrarGastos(u);
  await sembrarHistorial(u, caso.historial);
  const r = await decir(u, caso.msg);
  if (r !== null) await dormir(ESPERA_FUEGO_MS);
  const etiqueta = `${nombre} #${corrida}`;
  const lineas = [`${etiqueta}  > ${JSON.stringify(caso.msg)}`, `    < ${r === null ? '(sin respuesta)' : JSON.stringify(r.slice(0, 300))}`];
  const checks = r === null ? [[false, 'hubo respuesta']] : caso.afirmar(r, s, await txDe(u), await reglasDe(u));
  const txs = await txDe(u);
  checks.push([txs.length === 3, 'ni altas ni bajas de transacciones', JSON.stringify(txs.map(desc))]);
  for (const [ok, d, det] of checks) {
    lineas.push(`    ${ok ? 'PASS' : 'FAIL'}  ${d}${!ok && det ? '  (' + det + ')' : ''}`);
    if (!ok) fallos.push(`${etiqueta}: ${d}`);
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
      for (const t of ['transacciones', 'reglas_comercio', 'categorias_usuario', 'conversaciones', 'notificaciones', 'notification_deliveries', 'nlp_errors']) {
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
    console.log(`\n══ corrida ${i} de ${N}${SIN_HISTORIAL ? ' (sin historial)' : ''} ══`);
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
