#!/usr/bin/env node
/**
 * EL NOMBRE Y LA TENDENCIA DEL SCORE, contra PRODUCCIÓN y por el webhook real (chip 4 de la tanda
 * "respuestas malas del día 0", 30-sep-2026). Reporte:
 * `C:\Vortik.dev\memory\reports\neto-respuestas-malas-medicion-2026-09-30.md`.
 *
 * Clase 7: 3 de 49 altas guardaron una frase como nombre ("Como funciona?" → "¡Listo, *Como*!") y
 * el renombre guardó lo que el modelo inventó ("Nvf", "Hola"). Y el score decía "+N vs semana
 * pasada" a quien llevaba dos días.
 *
 * Lo que se afirma, sobre tres usuarios efímeros:
 *
 *   A. alta: "hola" → pide el nombre; "Como funciona?" NO se guarda y se repregunta; "Ana María"
 *      se guarda y cierra el alta saludando a Ana.
 *   B. alta: "Quisiera registrarme" no se guarda; la segunda frase ("Debe estar en apuros
 *      económicos.", real) cierra el alta SIN nombre: nadie queda trabado.
 *   C. ya dado de alta: los dos mensajes reales que terminaron en un renombre inventado dejan el
 *      nombre como estaba (esto se afirma SIEMPRE, vaya a donde vaya el clasificador); "llámame
 *      Ana" sí renombra (si el clasificador lo lleva al renombre); y con una sola fila de score de
 *      AYER, ver el score no dice "vs semana pasada".
 *
 * Los pasos A y B son deterministas (la máquina del alta no pasa por el modelo). En C, un pedido
 * que el clasificador manda a otro lado se anota como no ejercitado (exit 2 si no hay ninguno).
 *
 * **Cómo no le escribe a nadie**, el molde de `qa-dia0-respuestas.mjs`: usuarios `is_test_user`
 * con número `510000…` (no asignable), limpieza COMPROBADA desde un `finally` y ante Ctrl+C. No deja
 * transacciones: ninguno de estos mensajes registra plata, y si alguno lo hiciera es un FAIL.
 *
 * Corre DESPUÉS del deploy: contra el commit anterior es el CONTROL (tiene que fallar).
 *
 *   node qa-e2e/qa-respuestas-malas-nombre.mjs
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
    contacts: [{ wa_id: from, profile: { name: 'QA Nombre' } }],
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

const leerUsuario = async (u) => (await sb.select('usuarios',
  `id=eq.${u.id}&select=nombre,nombre_intentos,onboarding_paso,onboarding_completado`))[0];
const contarTx = async (u) => (await sb.select('transacciones', `usuario_id=eq.${u.id}&select=id`)).length;

async function crear(fila) {
  const whatsapp = '510000' + String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
  const u = await sb.insert('usuarios', { whatsapp, is_test_user: true, recordatorios_activos: false, ...fila });
  const reg = { id: u.id, whatsapp, piso: 0 };
  creados.push(reg);
  return reg;
}

async function decir(u, texto) {
  if (abortado) throw new Error('cortado a mano antes de mandar ' + JSON.stringify(texto));
  const txAntes = await contarTx(u);
  const st = await enviarTexto(vars.META_APP_SECRET, u.whatsapp, texto, `wamid.qa-nombre-${sufijo}-${++n}`);
  if (st !== 200) throw new Error('el webhook devolvió HTTP ' + st);
  const r = await esperarRespuesta(sb, u.id, texto, u.piso);
  u.piso = r.entranteId;
  console.log(`    > ${JSON.stringify(texto)}\n    < ${r.texto === null ? '(sin respuesta)' : JSON.stringify(r.texto.slice(0, 220))}`);
  check(r.texto !== null, JSON.stringify(texto) + ': hubo respuesta');
  check((await contarTx(u)) === txAntes, JSON.stringify(texto) + ': no registra plata');
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
const ALTA_NUEVA = { nombre: null, nombre_intentos: 0, onboarding_paso: 0, onboarding_completado: false, plan: 'free' };

let errorFatal = null;
try {
  // ── A: una pregunta no es un nombre, y después el nombre real entra ─────────────────────────
  console.log('\nA · alta con "Como funciona?"');
  const a = await crear(ALTA_NUEVA);
  const r0 = await decir(a, 'hola');
  check((await leerUsuario(a)).onboarding_paso === 100 && /c[oó]mo te llamas/i.test(r0), 'A: "hola" pide el nombre');
  const r1 = await decir(a, 'Como funciona?');
  const a1 = await leerUsuario(a);
  check(a1.nombre === null, 'A: "Como funciona?" no se guarda como nombre', 'nombre=' + JSON.stringify(a1.nombre));
  check(a1.onboarding_completado === false && a1.nombre_intentos === 1, 'A: el alta sigue abierta y cuenta un intento',
    `completado=${a1.onboarding_completado} intentos=${a1.nombre_intentos}`);
  check(!/¡Listo/.test(r1) && /nombre/i.test(r1), 'A: repregunta el nombre en vez de saludar a "Como"');
  const r2 = await decir(a, 'Ana María');
  const a2 = await leerUsuario(a);
  check(a2.nombre === 'Ana María' && a2.onboarding_completado === true, 'A: después "Ana María" se guarda y cierra el alta',
    `nombre=${JSON.stringify(a2.nombre)} completado=${a2.onboarding_completado}`);
  check(/¡Listo, \*Ana\*!/.test(r2), 'A: saluda a Ana');

  // ── B: dos frases seguidas cierran el alta sin nombre ───────────────────────────────────────
  console.log('\nB · alta con dos frases');
  const b = await crear(ALTA_NUEVA);
  await decir(b, 'hola');
  await decir(b, 'Quisiera registrarme');
  const b1 = await leerUsuario(b);
  check(b1.nombre === null && b1.onboarding_completado === false, 'B: "Quisiera registrarme" no se guarda',
    `nombre=${JSON.stringify(b1.nombre)}`);
  const rb = await decir(b, 'Debe estar en apuros económicos.');
  const b2 = await leerUsuario(b);
  check(b2.nombre === null && b2.onboarding_completado === true, 'B: la segunda frase cierra el alta SIN nombre',
    `nombre=${JSON.stringify(b2.nombre)} completado=${b2.onboarding_completado}`);
  check(/^¡Listo! 🤝/.test(rb) && !/Debe/.test(rb), 'B: "¡Listo!" sin nombre');

  // ── C: renombre y tendencia ─────────────────────────────────────────────────────────────────
  console.log('\nC · renombre y score');
  const hoy = hoyLima();
  const c = await crear({
    nombre: 'Gerson', nombre_intentos: 0, onboarding_paso: 0, onboarding_completado: true,
    plan: 'premium', trial_estado: 'activo', trial_vence: sumarDias(hoy, 10),
  });
  // Una fila de AYER y nada más: "la semana pasada" no existe.
  await sb.insert('neto_scores', { user_id: c.id, period: sumarDias(hoy, -1), score: 99 });

  for (const texto of [
    'Esto lo quiero usar para mi negocio de consultoría. Lo podemos personalizar?',
    'Mis categorías de gastos son de empresa',
    'hola, puedes cambiarme de nombre?',
  ]) {
    const r = await decir(c, texto);
    const fc = await leerUsuario(c);
    check(fc.nombre === 'Gerson', 'C: ' + JSON.stringify(texto) + ' no cambia el nombre', 'nombre=' + JSON.stringify(fc.nombre));
    check(!/ahora te llamo/i.test(r), 'C: ' + JSON.stringify(texto) + ' no dice "ahora te llamo"');
  }

  const rRen = await decir(c, 'llámame Ana');
  const cRen = await leerUsuario(c);
  if (/No cambié tu nombre/.test(rRen)) check(false, 'C: "llámame Ana" renombra', 'la guarda lo rechazó: falso rechazo');
  else if (cRen.nombre === 'Ana') check(/ahora te llamo \*Ana\*/.test(rRen), 'C: "llámame Ana" renombra a Ana');
  else { nota('C: "llámame Ana" no llegó al renombre (nombre=' + JSON.stringify(cRen.nombre) + '), no se juzga'); noEjercitados.push('"llámame Ana"'); }

  let scoreEjercitado = false;
  for (const texto of ['cuál es mi neto score', 'ver mi neto score']) {
    const r = await decir(c, texto);
    if (!/Neto Score es/.test(r)) { nota('C: ' + JSON.stringify(texto) + ' no llegó al score, no se juzga'); continue; }
    scoreEjercitado = true;
    check(!/semana pasada/.test(r), 'C: con una sola fila de ayer, el score no dice "vs semana pasada"');
    break;
  }
  if (!scoreEjercitado) noEjercitados.push('ver el score');
} catch (e) {
  errorFatal = e;
  console.error('\nNo se pudo medir: ' + e.message);
} finally {
  await limpiar();
}

console.log(`\nResultado: ${fallos.length ? fallos.length + ' fallo(s): ' + fallos.join(' · ') : 'todo PASS'}`);
if (noEjercitados.length) console.log('No se ejercitó: ' + noEjercitados.join(', ') + (fallos.length ? '' : '. Repetir la corrida (exit 2).'));
process.exit(fallos.length ? 1 : (errorFatal || noEjercitados.length) ? 2 : 0);
