#!/usr/bin/env node
/**
 * ESCRITURAS CON DATOS QUE EL MENSAJE NO NOMBRA, contra PRODUCCIÓN y por el webhook real (chip 6,
 * 02-oct-2026, la tanda "respuestas malas del día 0"). Reporte:
 * `C:\Vortik.dev\memory\reports\neto-respuestas-malas-medicion-2026-09-30.md`.
 *
 * El caso real: 3ccd5bf5 anotó "Debo 20 a bidon de agua", escribió "No aparece en mi dashboard" y
 * Neto contestó "Anotado. Le debes S/20 a bidon de agua" e insertó OTRA deuda: el clasificador copió
 * monto y contraparte del turno anterior. La guarda vive en `dispatchIntent` (lib/datos-dichos.js).
 *
 * Lo que se afirma, sobre usuarios efímeros:
 *
 *   A. "Debo 20 a bidon de agua" deja UNA deuda; "No aparece en mi dashboard" (las dos veces, como
 *      en prod) no agrega ninguna. Se afirma SIEMPRE, vaya a donde vaya el clasificador.
 *   B. Con dos pagos a "Ricardo arauco v" (el viejo en Otros), "Cambiar Plin de ricardo como taxi"
 *      mueve el ÚLTIMO a Transporte y NO toca el viejo: la regla corre hacia adelante y el pasado
 *      solo si se pide. Si el clasificador no lo lleva a recategorizar, no se juzga.
 *   C. "Ya pague pro y no se activa", en el muro y con el comprobante en revisión: el estado del
 *      pago, nunca el texto de venta.
 *
 * Cómo no le escribe a nadie: el molde de `qa-dia0-respuestas.mjs` (is_test_user, número
 * `510000…`, limpieza COMPROBADA desde un `finally` y ante Ctrl+C). C pone `pago_pendiente` en un
 * usuario efímero sin fila en `pagos`; ningún cron lee esa columna (solo `routes/admin.js`).
 *
 * Corre DESPUÉS del deploy: contra el commit anterior es el CONTROL (tiene que fallar).
 *
 *   node qa-e2e/qa-datos-no-dichos.mjs
 *
 * exit 0 = todo pasa y no quedó nada · 1 = algún caso falla o quedó basura · 2 = no pudo medir o
 * algún caso no se ejercitó. NO va al canary: pasa por OpenAI y escribe en prod.
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
    contacts: [{ wa_id: from, profile: { name: 'QA Datos' } }],
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

const contar = async (tabla, u) => (await sb.select(tabla, `usuario_id=eq.${u.id}&select=id`)).length;

async function crear(fila) {
  const whatsapp = '510000' + String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
  const u = await sb.insert('usuarios', { whatsapp, is_test_user: true, recordatorios_activos: false, ...fila });
  const reg = { id: u.id, whatsapp, piso: 0 };
  creados.push(reg);
  return reg;
}

async function decir(u, texto) {
  if (abortado) throw new Error('cortado a mano antes de mandar ' + JSON.stringify(texto));
  const st = await enviarTexto(vars.META_APP_SECRET, u.whatsapp, texto, `wamid.qa-datos-${sufijo}-${++n}`);
  if (st !== 200) throw new Error('el webhook devolvió HTTP ' + st);
  const r = await esperarRespuesta(sb, u.id, texto, u.piso);
  u.piso = r.entranteId;
  console.log(`    > ${JSON.stringify(texto)}\n    < ${r.texto === null ? '(sin respuesta)' : JSON.stringify(r.texto.slice(0, 220))}`);
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
      for (const t of ['transacciones', 'deudas', 'reglas_comercio', 'conversaciones', 'notificaciones', 'notification_deliveries', 'nlp_errors']) {
        await sb.del(t, `usuario_id=eq.${u.id}`);
      }
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
const EN_PRUEBA = () => ({
  nombre: 'Rayza', onboarding_paso: 0, onboarding_completado: true,
  plan: 'premium', trial_estado: 'activo', trial_vence: sumarDias(hoyLima(), 10),
});

let errorFatal = null;
try {
  // ── A: el caso de prod ──────────────────────────────────────────────────────────────────────
  console.log('\nA · "No aparece en mi dashboard" después de una deuda');
  const a = await crear(EN_PRUEBA());
  await decir(a, 'Debo 20 a bidon de agua');
  const deudasTrasAnotar = await contar('deudas', a);
  if (deudasTrasAnotar !== 1) { nota('A: "Debo 20 a bidon de agua" dejó ' + deudasTrasAnotar + ' deudas, no se juzga'); noEjercitados.push('A'); }
  else {
    for (let i = 1; i <= 2; i++) {
      const r = await decir(a, 'No aparece en mi dashboard');
      const d = await contar('deudas', a);
      check(d === 1, `A: "No aparece en mi dashboard" (${i}) no crea otra deuda`, 'deudas=' + d);
      check(!/Anotado\. Le debes/.test(r), `A: (${i}) no contesta "Anotado. Le debes"`);
    }
    check((await contar('transacciones', a)) === 0, 'A: tampoco registra un gasto');
  }

  // ── B: la regla de comercio no reescribe el pasado sin pedirlo ─────────────────────────────
  console.log('\nB · "Cambiar Plin de ricardo como taxi"');
  const b = await crear(EN_PRUEBA());
  const hoy = hoyLima();
  const vieja = await sb.insert('transacciones', { usuario_id: b.id, tipo: 'gasto', monto: 8, monto_pen: 8, moneda: 'PEN', comercio: 'Ricardo arauco v', categoria: 'Otros', fecha: sumarDias(hoy, -5) });
  const ultima = await sb.insert('transacciones', { usuario_id: b.id, tipo: 'gasto', monto: 12.6, monto_pen: 12.6, moneda: 'PEN', comercio: 'Ricardo arauco v', categoria: 'Otros', fecha: hoy });
  const rb = await decir(b, 'Cambiar Plin de ricardo como taxi');
  const [fv] = await sb.select('transacciones', `id=eq.${vieja.id}&select=categoria`);
  const [fu] = await sb.select('transacciones', `id=eq.${ultima.id}&select=categoria`);
  // El control del 02-oct contra 41d1e61 creó "Plin → Transporte (siempre)": se afirma vaya donde vaya.
  const reglas = await sb.select('reglas_comercio', `usuario_id=eq.${b.id}&select=comercio_pattern`);
  check(!reglas.some((x) => /plin/i.test(x.comercio_pattern || '')), 'B: no crea una regla permanente para "Plin"',
    'reglas=' + JSON.stringify(reglas.map((x) => x.comercio_pattern)));
  check(!/Regla creada/.test(rb), 'B: no contesta "Regla creada"');
  if (fu.categoria === 'Otros') { nota('B: el último no se movió (respuesta: ' + JSON.stringify(rb.slice(0, 80)) + '), no se juzga'); noEjercitados.push('B'); }
  else {
    check(fu.categoria === 'Transporte', 'B: el último pasa a Transporte', 'categoria=' + fu.categoria);
    check(fv.categoria === 'Otros', 'B: el pago VIEJO no se toca', 'categoria=' + fv.categoria);
    check(!/todos los pagos anteriores/.test(rb), 'B: no dice "Apliqué el cambio a todos los pagos anteriores"');
  }

  // ── C: quien ya pagó recibe el estado, no la venta ─────────────────────────────────────────
  console.log('\nC · "Ya pague pro y no se activa"');
  const c = await crear({ nombre: 'Rayza', onboarding_paso: 0, onboarding_completado: true, plan: 'free', trial_estado: 'vencido', pago_pendiente: true });
  const rc = await decir(c, 'Ya pague pro y no se activa');
  check(!/Desbloquea todo el potencial/.test(rc), 'C: no recibe el texto de venta');
  check(/lo estoy revisando/.test(rc), 'C: le dice que el comprobante está en revisión');
} catch (e) {
  errorFatal = e;
  console.error('\nNo se pudo medir: ' + e.message);
} finally {
  await limpiar();
}

console.log(`\nResultado: ${fallos.length ? fallos.length + ' fallo(s): ' + fallos.join(' · ') : 'todo PASS'}`);
if (noEjercitados.length) console.log('No se ejercitó: ' + noEjercitados.join(', ') + (fallos.length ? '' : '. Repetir la corrida (exit 2).'));
process.exit(fallos.length ? 1 : (errorFatal || noEjercitados.length) ? 2 : 0);
