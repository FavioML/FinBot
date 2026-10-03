#!/usr/bin/env node
/**
 * UN NOMBRE DICHO ESCRIBE SOLO SOBRE LA FILA QUE NOMBRA, contra PRODUCCIÓN y por el webhook real
 * (02-oct-2026, `lib/resolver-nombre.js`). Es la clase que `lib/datos-dichos.js` declaró fuera de su
 * alcance: con un nombre que SÍ está en el mensaje, el handler escribía sobre otra fila porque
 * buscaba por subcadena y, sin coincidencia, caía a la más reciente.
 *
 * Lo que se afirma, sobre usuarios efímeros. Cada caso tiene una parte que se afirma SIEMPRE (la
 * fila que nadie nombró no se toca, vaya a donde vaya el clasificador) y un control que depende de
 * que el clasificador llegue al intent (si no llega, no se juzga y la corrida sale exit 2):
 *
 *   A. Metas Laptop (la más reciente) y Viaje Cusco: "elimina la meta moto" no borra ninguna;
 *      "elimina la meta viaje" no borra Laptop; control "elimina la meta viaje cusco" borra Viaje
 *      Cusco y deja Laptop (el nombre de la meta llega en `meta_id`: si el remapeo se cae, falla acá).
 *   B. Deudas activas con Luisa (la más reciente) y con Luis: "salda todo con Luis" no salda a Luisa;
 *      control: Luis queda pagada.
 *   C. Borrados pendientes Cine (el último) y KFC: "recupera el gasto de la pizza" no restaura nada;
 *      control "recupera el kfc" restaura el KFC y no el cine.
 *   D. Gastos Uber Eats (el más reciente) y Uber, los dos en Otros: "el uber era transporte" no
 *      mueve el Uber Eats (pregunta: son dos nombres); control "el uber eats era salud" mueve ese.
 *   E. Gastos Lina y Gasolina en Otros: "el de lina era salud, siempre" no mueve la Gasolina; control:
 *      Lina pasa a Salud.
 *
 * Cómo no le escribe a nadie: el molde de `qa-datos-no-dichos.mjs` (is_test_user, número `510000…`,
 * limpieza COMPROBADA desde un `finally` y ante Ctrl+C). Los borrados de `transacciones` y `deudas`
 * dejan su copia en `borrados_auditoria`, que `service_role` no puede limpiar (migración 055): es el
 * mismo precio que pagan los harness del borrado.
 *
 * Corre DESPUÉS del deploy: contra el commit anterior es el CONTROL (tiene que fallar).
 *
 *   node qa-e2e/qa-resolucion-de-filas.mjs
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
    contacts: [{ wa_id: from, profile: { name: 'QA Resolucion' } }],
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

async function decir(u, texto) {
  if (abortado) throw new Error('cortado a mano antes de mandar ' + JSON.stringify(texto));
  const st = await enviarTexto(vars.META_APP_SECRET, u.whatsapp, texto, `wamid.qa-resolucion-${sufijo}-${++n}`);
  if (st !== 200) throw new Error('el webhook devolvió HTTP ' + st);
  const r = await esperarRespuesta(sb, u.id, texto, u.piso);
  u.piso = r.entranteId;
  console.log(`    > ${JSON.stringify(texto)}\n    < ${r.texto === null ? '(sin respuesta)' : JSON.stringify(r.texto.slice(0, 260))}`);
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
      const deudas = await sb.select('deudas', `usuario_id=eq.${u.id}&select=id`);
      for (const d of deudas) await sb.del('deuda_abonos', `deuda_id=eq.${d.id}`);
      for (const t of ['transacciones', 'transacciones_eliminadas', 'deudas', 'meta_aportes', 'metas_ahorro', 'reglas_comercio',
        'categorias_usuario', 'conversaciones', 'notificaciones', 'notification_deliveries', 'nlp_errors', 'logros']) {
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
const haceMin = (m) => new Date(Date.now() - m * 60000).toISOString();
const EN_PRUEBA = () => ({
  nombre: 'Rayza', onboarding_paso: 0, onboarding_completado: true,
  plan: 'premium', trial_estado: 'activo', trial_vence: sumarDias(hoyLima(), 10),
});
const uno = async (tabla, id, cols) => (await sb.select(tabla, `id=eq.${id}&select=${cols}`))[0] || null;
const gasto = (u, comercio, dias, extra = {}) => sb.insert('transacciones', {
  usuario_id: u.id, tipo: 'gasto', monto: 20, monto_pen: 20, moneda: 'PEN', comercio, categoria: 'Otros',
  fecha: sumarDias(hoyLima(), -dias), ...extra,
});

let errorFatal = null;
try {
  // ── A: metas ────────────────────────────────────────────────────────────────────────────────
  console.log('\nA · "elimina la meta moto" con Laptop y Viaje Cusco');
  const a = await crear(EN_PRUEBA());
  const viaje = await sb.insert('metas_ahorro', { usuario_id: a.id, nombre: 'Viaje Cusco', monto_objetivo: 2000, monto_actual: 100, status: 'active', created_at: haceMin(60) });
  const laptop = await sb.insert('metas_ahorro', { usuario_id: a.id, nombre: 'Laptop', monto_objetivo: 3000, monto_actual: 200, status: 'active', created_at: haceMin(30) });
  const ra = await decir(a, 'elimina la meta moto');
  check(!!(await uno('metas_ahorro', laptop.id, 'id')), 'A: Laptop sigue ahí');
  check(!!(await uno('metas_ahorro', viaje.id, 'id')), 'A: Viaje Cusco sigue ahí');
  check(!/Eliminé la meta/.test(ra), 'A: no contesta "Eliminé la meta"');
  // El modelo alarga "viaje" a "Viaje Cusco" (12 de 12 medido) y eso pregunta "¿Hablas de…?": el
  // control usa el nombre entero, que es la salida que esa pregunta ofrece.
  const rv = await decir(a, 'elimina la meta viaje');
  check(!!(await uno('metas_ahorro', laptop.id, 'id')), 'A: "elimina la meta viaje" no borra Laptop');
  if (!/Hablas de|Eliminé la meta \*Viaje Cusco\*/.test(rv)) nota('A: "elimina la meta viaje" contestó otra cosa: ' + JSON.stringify(rv.slice(0, 80)));
  if (await uno('metas_ahorro', viaje.id, 'id')) await decir(a, 'elimina la meta viaje cusco');
  if (await uno('metas_ahorro', viaje.id, 'id')) { nota('A: "elimina la meta viaje cusco" no borró Viaje Cusco, el control no se juzga'); noEjercitados.push('A'); }
  else check(!!(await uno('metas_ahorro', laptop.id, 'id')), 'A: control, borra Viaje Cusco y deja Laptop');

  // ── B: deudas ───────────────────────────────────────────────────────────────────────────────
  console.log('\nB · "salda todo con Luis" con Luis y Luisa');
  const b = await crear(EN_PRUEBA());
  const luis = await sb.insert('deudas', { usuario_id: b.id, tipo: 'me_deben', contraparte: 'Luis', monto_original: 50, monto_pendiente: 50, moneda: 'PEN', estado: 'activa', created_at: haceMin(60) });
  const luisa = await sb.insert('deudas', { usuario_id: b.id, tipo: 'me_deben', contraparte: 'Luisa', monto_original: 100, monto_pendiente: 100, moneda: 'PEN', estado: 'activa', created_at: haceMin(30) });
  await decir(b, 'salda todo con Luis');
  const fLuisa = await uno('deudas', luisa.id, 'estado,monto_pendiente');
  check(fLuisa && fLuisa.estado === 'activa' && Number(fLuisa.monto_pendiente) === 100, 'B: la deuda con Luisa sigue activa y entera', JSON.stringify(fLuisa));
  const fLuis = await uno('deudas', luis.id, 'estado');
  if (!fLuis || fLuis.estado !== 'pagada') { nota('B: Luis no quedó pagada (' + JSON.stringify(fLuis) + '), el control no se juzga'); noEjercitados.push('B'); }
  else check(true, 'B: control, Luis quedó pagada');

  // ── C: restaurar ────────────────────────────────────────────────────────────────────────────
  console.log('\nC · "recupera el gasto de la pizza" con Cine y KFC borrados');
  const c = await crear(EN_PRUEBA());
  const snap = (comercio, monto) => ({ comercio, monto, monto_pen: monto, moneda: 'PEN', categoria: 'Ocio', tipo: 'gasto', fecha: sumarDias(hoyLima(), -1) });
  await sb.insert('transacciones_eliminadas', { usuario_id: c.id, tx_id: crypto.randomUUID(), snapshot: snap('KFC', 25), deleted_at: haceMin(60) });
  await sb.insert('transacciones_eliminadas', { usuario_id: c.id, tx_id: crypto.randomUUID(), snapshot: snap('Cine', 30), deleted_at: haceMin(30) });
  const rc = await decir(c, 'recupera el gasto de la pizza');
  const txC = await sb.select('transacciones', `usuario_id=eq.${c.id}&select=comercio`);
  check(txC.length === 0, 'C: no restaura nada', 'restauró ' + JSON.stringify(txC.map((t) => t.comercio)));
  check(!/Restauré/.test(rc), 'C: no contesta "Restauré"');
  await decir(c, 'recupera el kfc');
  const txC2 = await sb.select('transacciones', `usuario_id=eq.${c.id}&select=comercio`);
  check(!txC2.some((t) => t.comercio === 'Cine'), 'C: el cine nunca se restaura', JSON.stringify(txC2.map((t) => t.comercio)));
  if (!txC2.some((t) => t.comercio === 'KFC')) { nota('C: "recupera el kfc" no restauró el KFC, el control no se juzga'); noEjercitados.push('C'); }
  else check(txC2.length === 1, 'C: control, restaura solo el KFC');

  // ── D: corregir la categoría de un comercio ────────────────────────────────────────────────
  console.log('\nD · "el uber era transporte" con Uber Eats (último) y Uber');
  const d = await crear(EN_PRUEBA());
  const uber = await gasto(d, 'Uber', 2);
  const uberEats = await gasto(d, 'Uber Eats', 1);
  const rd = await decir(d, 'el uber era transporte');
  const fUe = await uno('transacciones', uberEats.id, 'categoria');
  check(fUe.categoria === 'Otros', 'D: el Uber Eats no se mueve', 'categoria=' + fUe.categoria);
  // Desde la cuarta vuelta "uber" con Uber y Uber Eats PREGUNTA (el exacto no tiene prioridad): el
  // control nombra el comercio entero.
  check(/Uber Eats/.test(rd), 'D: pregunta entre Uber y Uber Eats', JSON.stringify(rd.slice(0, 80)));
  await decir(d, 'el uber eats era salud');
  const fUe2 = await uno('transacciones', uberEats.id, 'categoria');
  const fU = await uno('transacciones', uber.id, 'categoria');
  if (fUe2.categoria === 'Otros') { nota('D: "el uber eats era salud" no movió el Uber Eats, el control no se juzga'); noEjercitados.push('D'); }
  else {
    check(fUe2.categoria === 'Salud', 'D: control, el Uber Eats pasa a Salud', 'categoria=' + fUe2.categoria);
    check(fU.categoria === 'Otros', 'D: control, el Uber no se arrastra', 'categoria=' + fU.categoria);
  }

  // ── E: una regla con "siempre" no se derrama por subcadena ─────────────────────────────────
  console.log('\nE · "el de lina era salud, siempre" con Lina y Gasolina');
  const e = await crear(EN_PRUEBA());
  const lina = await gasto(e, 'Lina', 3);
  const gasolina = await gasto(e, 'Gasolina', 2);
  // "todo lo de Lina siempre va en Salud" no le saca el comercio al clasificador (medido dos veces
  // contra prod): la corrección con alcance ("siempre") también retroaplica.
  await decir(e, 'el de lina era salud, siempre');
  await dormir(3000);   // la retroaplicación de `corregir_categoria` no se espera en el handler
  const fG = await uno('transacciones', gasolina.id, 'categoria');
  check(fG.categoria === 'Otros', 'E: la Gasolina no se mueve', 'categoria=' + fG.categoria);
  const fL = await uno('transacciones', lina.id, 'categoria');
  if (fL.categoria === 'Otros') { nota('E: Lina no se movió, el control no se juzga'); noEjercitados.push('E'); }
  else check(fL.categoria === 'Salud', 'E: control, Lina pasa a Salud', 'categoria=' + fL.categoria);
} catch (err) {
  errorFatal = err;
  console.error('\nNo se pudo medir: ' + err.message);
} finally {
  await limpiar();
}

console.log(`\nResultado: ${fallos.length ? fallos.length + ' fallo(s): ' + fallos.join(' · ') : 'todo PASS'}`);
if (noEjercitados.length) console.log('No se ejercitó: ' + noEjercitados.join(', ') + (fallos.length ? '' : '. Repetir la corrida (exit 2).'));
process.exit(fallos.length ? 1 : (errorFatal || noEjercitados.length) ? 2 : 0);
