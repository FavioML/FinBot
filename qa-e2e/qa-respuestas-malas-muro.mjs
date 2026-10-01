#!/usr/bin/env node
/**
 * EL MURO ANTES DEL PRIMER GASTO, contra PRODUCCIÓN y por el webhook real (chip 3 de la tanda
 * "respuestas malas del día 0", 30-sep-2026). Reporte:
 * `C:\Vortik.dev\memory\reports\neto-respuestas-malas-medicion-2026-09-30.md`.
 *
 * Clase 5: siete personas, todas en su día 0, recibieron "para ver tus gastos en gráficos
 * necesitas Neto Pro" ante pedidos que no eran de gráficos ("quiero sacar el presupuesto para mi
 * mes", "Quiero saber si puedo preguntarte cuánto he gastado en una semana"…). Quien todavía no
 * anotó nada es `plan='free'` con `trial_estado` NULL, y toda lectura suya cae en `mensajeMuro`.
 *
 * Lo que se afirma, sobre un usuario efímero SIN prueba y SIN movimientos:
 *
 *   1. los comandos `/` de lectura (cascada de webhook.js, determinista) y los pedidos reales
 *      (por el clasificador) reciben el texto nuevo: no nombra los gráficos, dice que lo pedido
 *      es de Pro y que no hay gastos ni ingresos, y pide el primero con un ejemplo;
 *   2. la PROMESA de ese texto es cierta: "almuerzo 15" registra S/15 y abre la prueba
 *      (`trial_estado='activo'`, `trial_vence` = hoy Lima + 14);
 *   3. después de eso `/mes` ya no responde con el muro y muestra el S/15.
 *
 * Un pedido por el clasificador que no cae en el muro (lo mandó a otro tema) no cuenta ni a
 * favor ni en contra: se anota como no ejercitado. Hace falta al menos uno ejercitado.
 *
 * **Cómo no le escribe a nadie**, el molde de `qa-dia0-respuestas.mjs`: un solo usuario efímero
 * `is_test_user` con número `510000…` (no asignable), limpieza COMPROBADA desde un `finally` y
 * ante Ctrl+C. **Lo que deja:** la transacción del punto 2 se borra y deja su copia en
 * `borrados_auditoria` (append-only): una fila por corrida, con el id del usuario efímero.
 *
 * Corre DESPUÉS del deploy: contra el commit anterior es el CONTROL (tiene que fallar).
 *
 *   node qa-e2e/qa-respuestas-malas-muro.mjs
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
const TRIAL_DIAS = 14;

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
    contacts: [{ wa_id: from, profile: { name: 'QA Muro' } }],
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

/**
 * La respuesta a ESTE mensaje, atada por `conversaciones.id` y no por reloj (ver el molde).
 * La cascada de comandos `/` de webhook.js guarda solo la fila `neto`, no la del usuario: para
 * esos el ancla es el piso, y cada turno espera al anterior, así que no hay otra fila en vuelo.
 */
async function esperarRespuesta(sb, usuarioId, texto, pisoId) {
  const hasta = Date.now() + ESPERA_MS;
  let entrante = texto.startsWith('/') ? { id: pisoId } : null;
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
let abortado = false;

const filasTx = () => sb.select('transacciones', `usuario_id=eq.${u.id}&select=id,tipo,monto,moneda&order=id.asc`);
const leerUsuario = async () => (await sb.select('usuarios', `id=eq.${u.id}&select=plan,trial_estado,trial_vence`))[0];

async function decir(texto) {
  if (abortado) throw new Error('cortado a mano antes de mandar ' + JSON.stringify(texto));
  const antes = new Set((await filasTx()).map((f) => f.id));
  const st = await enviarTexto(vars.META_APP_SECRET, whatsapp, texto, `wamid.qa-muro-${sufijo}-${++n}`);
  if (st !== 200) throw new Error('el webhook devolvió HTTP ' + st);
  const r = await esperarRespuesta(sb, u.id, texto, piso);
  piso = r.entranteId;
  const nuevas = (await filasTx()).filter((f) => !antes.has(f.id));
  console.log(`    > ${JSON.stringify(texto)}\n    < ${r.texto === null ? '(sin respuesta)' : JSON.stringify(r.texto.slice(0, 260))}`);
  return { texto: r.texto, nuevas };
}

// El muro, en su forma vieja o nueva. Lo que NO es muro (otro tema) no se juzga.
const ES_MURO = /necesitas \*Neto Pro\*|d[ií]as gratis|es parte de \*Neto Pro\*|se abre \*Neto Pro\*/;

/** Una lectura de quien no tiene prueba ni movimientos. Devuelve si cayó en el muro. */
async function lecturaSinPrueba(caso, texto, { determinista }) {
  console.log('\n' + caso);
  const r = await decir(texto);
  check(r.texto !== null, caso + ': hubo respuesta');
  check(r.nuevas.length === 0, caso + ': no deja plata', r.nuevas.map((f) => f.tipo + ' ' + f.monto).join(' ; '));
  if (r.texto === null) return false;
  if (!ES_MURO.test(r.texto)) {
    if (determinista) check(false, caso + ': responde con el muro', 'la cascada de `/` tenía que gatearlo');
    else nota(caso + ': el clasificador no lo mandó a una lectura, no se juzga');
    return false;
  }
  check(!/gr[aá]fico/i.test(r.texto), caso + ': no habla de gráficos');
  check(/todav[ií]a no empez[oó]/.test(r.texto), caso + ': dice que la prueba todavía no empezó');
  check(!/nada que mostrar/i.test(r.texto), caso + ': no supone que quería ver algo');
  check(/almuerzo 15/.test(r.texto) && /an[oó]ta/i.test(r.texto), caso + ': invita a anotar el primero');
  check(new RegExp(TRIAL_DIAS + ' d[ií]as').test(r.texto), caso + ': nombra los ' + TRIAL_DIAS + ' días');
  check(!/S\/\d+/.test(r.texto), caso + ': no le cobra a quien no probó nada');
  return true;
}

let limpio = false;
async function limpiar() {
  if (limpio || !u) return;
  limpio = true;
  console.log('\nLimpieza');
  try {
    for (const t of ['transacciones', 'transacciones_eliminadas', 'conversaciones', 'notificaciones', 'notification_deliveries', 'nlp_errors']) {
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
// lo recrea SIN `is_test_user` (revisión adversarial del molde, 14-sep).
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (abortado) { console.error('\nSalida forzada SIN limpiar: revisa usuarios con whatsapp=' + whatsapp); process.exit(1); }
    abortado = true;
    console.error('\nCortando: termino el turno en vuelo y limpio (otro Ctrl+C sale sin limpiar).');
  });
}

const hoyLima = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
const sumarDias = (iso, d) => { const f = new Date(iso + 'T12:00:00Z'); f.setUTCDate(f.getUTCDate() + d); return f.toISOString().slice(0, 10); };

let errorFatal = null;
try {
  whatsapp = '510000' + String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
  // Recién dado de alta: alta cerrada, sin prueba, sin movimientos. Es el estado del día 0.
  u = await sb.insert('usuarios', {
    whatsapp, nombre: 'QA Muro', is_test_user: true,
    onboarding_completado: true, onboarding_paso: 0,
    plan: 'free', trial_estado: null, recordatorios_activos: false,
  });
  console.log('usuario efímero ' + u.id + ' (sin prueba, sin movimientos)');

  await lecturaSinPrueba('comando /mes', '/mes', { determinista: true });
  await lecturaSinPrueba('comando /presupuesto', '/presupuesto', { determinista: true });

  let ejercitadosNlp = 0;
  for (const texto of [
    'quiero sacar el presupuesto para mi mes',
    'Quiero saber si puedo preguntarte cuánto he gastado en una semana',
    'cuánto gasté esta semana',
    'muéstrame mis gastos del mes',
  ]) {
    if (await lecturaSinPrueba('pedido real · ' + texto, texto, { determinista: false })) ejercitadosNlp++;
  }
  if (!ejercitadosNlp) noEjercitados.push('ningún pedido por el clasificador cayó en el muro');

  const antesDelGasto = await leerUsuario();
  check(antesDelGasto.trial_estado === null, 'las lecturas no abrieron la prueba', 'trial_estado=' + antesDelGasto.trial_estado);

  // La promesa del texto: el ejemplo que da, tal cual, abre la prueba.
  console.log('\nla promesa · "almuerzo 15"');
  const rGasto = await decir('almuerzo 15');
  check(rGasto.nuevas.length === 1 && rGasto.nuevas[0].tipo === 'gasto' && Number(rGasto.nuevas[0].monto) === 15,
    'el ejemplo del texto registra S/15', rGasto.nuevas.map((f) => f.tipo + ' ' + f.monto).join(' ; ') || 'nada');
  const trasGasto = await leerUsuario();
  const venceEsperado = sumarDias(hoyLima(), TRIAL_DIAS);
  check(trasGasto.trial_estado === 'activo' && trasGasto.plan === 'premium', 'y abre la prueba',
    `plan=${trasGasto.plan} trial_estado=${trasGasto.trial_estado}`);
  check(String(trasGasto.trial_vence).slice(0, 10) === venceEsperado, 'por ' + TRIAL_DIAS + ' días desde hoy',
    `trial_vence=${trasGasto.trial_vence}, esperado ${venceEsperado}`);

  console.log('\nya en prueba · /mes');
  const rMes = await decir('/mes');
  check(rMes.texto !== null && !ES_MURO.test(rMes.texto), '/mes ya no responde con el muro');
  // Positivo, no solo "no es el muro": un "Tuve un problema consultando tus datos" también lo es.
  check(rMes.texto !== null && /\b15(\.00)?\b/.test(rMes.texto), '/mes muestra el gasto de S/15', (rMes.texto || '').slice(0, 80));
} catch (e) {
  errorFatal = e;
  console.error('\nNo se pudo medir: ' + e.message);
} finally {
  await limpiar();
}

console.log(`\nResultado: ${fallos.length ? fallos.length + ' fallo(s): ' + fallos.join(' · ') : 'todo PASS'}`);
if (noEjercitados.length) console.log('No se ejercitó: ' + noEjercitados.join(', ') + (fallos.length ? '' : '. Repetir la corrida (exit 2).'));
process.exit(fallos.length ? 1 : (errorFatal || noEjercitados.length) ? 2 : 0);
