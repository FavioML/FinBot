#!/usr/bin/env node
/**
 * LAS RESPUESTAS MALAS DEL DÍA 0, contra PRODUCCIÓN y por el webhook real (plan día 0→1, 14-sep-2026).
 *
 * Cada caso es la frase que un usuario real escribió el día de su alta y que terminó con él
 * yéndose. La suite prueba el working tree con dobles; esto prueba que el backend que CORRE en
 * `api.neto.pe` —con el clasificador de verdad, gpt-4o-mini incluido— contesta bien.
 *
 *   categoria    "Por categoría" entraba en bucle de "Dime la categoría" (95aaa7dd, 11-ago).
 *   reinicio     "empecemos de cero, cancela todo" borraba el último movimiento sin preguntar.
 *   meta         "¿cuánto por día?" volvía a crear la meta: 2 filas y "extender el plazo 190
 *                meses" (2a917ac4, 27-ago).
 *
 * Dos casos del mismo trabajo NO están acá porque sus arreglos se retiraron antes del push ("4 en
 * pan y maca" y "¿vas a perder el registro?"): ver `docs/DEFECTOS.md`, 14-sep.
 *
 * **Cómo no le escribe a nadie.** Un solo usuario efímero con `is_test_user = true` (`enviarWhatsapp`
 * no llama a Meta), alta cerrada y prueba activa sembrada. El número es `510000` + 6 dígitos:
 * con `9` después del 51 sería un celular peruano válido, y si `isTestUser` fallara abierto
 * (`lib/whatsapp.js`) el mensaje saldría a una persona. Si el número ya existe, el INSERT choca
 * con el único de `usuarios.whatsapp` y aborta antes de mandar nada. Borra y COMPRUEBA el borrado
 * desde un `finally` y también ante Ctrl+C.
 *
 * **Lo que deja, dicho:** no siembra transacciones por REST, porque borrar una deja su copia en
 * `borrados_auditoria` (append-only). La única la crea el propio bot ("gasté 12 en taxi"), así que
 * cada corrida deja como máximo UNA fila de auditoría, con el id del usuario efímero.
 *
 * **Lo que se pagó en las corridas de control (14-sep):**
 *   - La respuesta se ata al mensaje por `conversaciones.id`, NO por `created_at > reloj local`.
 *   - `reinicio` exige movimientos antes (exit 2 si no hay) y corre ANTES de crear la meta: con
 *     una meta viva el modelo mandó "cancela todo" a `abandonar_plan` y el caso no examinó nada.
 *   - `categoria` afirma el MONTO del desglose: la repregunta vieja trae "Alimentación" en su ejemplo.
 *   - `meta/duplicado` NO discrimina en una corrida (depende de a qué intent mande el modelo la
 *     pregunta); lo cubre el test unitario y acá se reporta. La cuota por día que diga el modelo se
 *     compara contra la correcta como NOTA: en el control inventó S/233 contra ~S/65.
 *
 * Corre DESPUÉS del deploy: contra el commit anterior es el CONTROL (tiene que fallar).
 * Credenciales como `qa-atribucion-wa.mjs`: `RAILWAY_API_TOKEN` en `app/.env` (o en el entorno),
 * el resto de Railway.
 *
 *   node qa-e2e/qa-dia0-respuestas.mjs
 *
 * exit 0 = todo pasa y no quedó nada · 1 = algún caso falla o quedó basura · 2 = no pudo medir.
 * NO va al canary: cada corrida pasa por OpenAI y escribe en tablas de prod.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

const RAILWAY = { P: 'e2aac0f3-c2ee-4347-892c-b36d8c76929e', S: '1085b433-8f29-4487-9ce7-3a66b64ef244', E: '1600a753-bc8c-492c-aca7-27fdac946747' };
const WEBHOOK = process.env.NETO_WEBHOOK || 'https://api.neto.pe/webhook';
// Esta vez SÍ pasa por el clasificador y a veces por gpt-4o: la espera es por el modelo.
const ESPERA_MS = 60000;
// Una respuesta puede salir en varias filas (confirmación + cola): margen para las demás.
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
    contacts: [{ wa_id: from, profile: { name: 'QA Dia0' } }],
    messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: texto } }],
  };
  const body = { object: 'whatsapp_business_account', entry: [{ id: 'qa', changes: [{ field: 'messages', value }] }] };
  const raw = Buffer.from(JSON.stringify(body));
  const firma = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const r = await fetch(WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': firma }, body: raw });
  return r.status;
}

const fallos = [];
// Un caso que pasó sin haber ejercitado lo que dice probar no es un PASS: sale exit 2.
const noEjercitados = [];
function check(ok, etiqueta, detalle = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${etiqueta}${detalle ? '  (' + detalle + ')' : ''}`);
  if (!ok) fallos.push(etiqueta);
}
const nota = (t) => console.log('  NOTA  ' + t);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * La respuesta de Neto a ESTE mensaje, atada por id y no por reloj: primero la fila `usuario` con
 * este texto posterior al piso, después las filas `neto` con id mayor, más COLA_MS de margen.
 */
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
  const st = await enviarTexto(vars.META_APP_SECRET, whatsapp, texto, `wamid.qa-dia0-${sufijo}-${++n}`);
  if (st !== 200) throw new Error('el webhook devolvió HTTP ' + st);
  const r = await esperarRespuesta(sb, u.id, texto, piso);
  piso = r.entranteId;
  console.log(`    > ${JSON.stringify(texto)}\n    < ${r.texto === null ? '(sin respuesta)' : JSON.stringify(r.texto.slice(0, 240))}`);
  return r.texto;
}

let limpio = false;
async function limpiar() {
  if (limpio || !u) return;
  limpio = true;
  console.log('\nLimpieza');
  try {
    for (const t of ['metas_ahorro', 'transacciones', 'transacciones_eliminadas', 'conversaciones', 'notificaciones', 'notification_deliveries']) {
      await sb.del(t, `usuario_id=eq.${u.id}`);
    }
    await sb.del('usuarios', `id=eq.${u.id}`);
    const quedan = await sb.select('usuarios', `id=eq.${u.id}&select=id`);
    check(quedan.length === 0, 'se borró el usuario efímero', quedan.length ? 'QUEDÓ la fila ' + u.id + ', bórrala a mano' : '');
  } catch (e) {
    check(false, 'se borró el usuario efímero', 'el borrado falló: ' + e.message + ', revisa ' + u.id);
  }
}
// Ctrl+C / SIGTERM NO limpian en paralelo: si se borra la fila del usuario mientras el backend
// todavía procesa el mensaje en vuelo, `obtenerOCrearUsuario` recrea a ese número SIN
// `is_test_user` y nadie la limpia (revisión adversarial, 14-sep). Se marca, el flujo principal
// no manda nada más, termina de esperar el turno en vuelo y limpia el `finally`. Un segundo
// Ctrl+C sale sin limpiar, y lo dice.
let abortado = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (abortado) { console.error('\nSalida forzada SIN limpiar: revisa usuarios con whatsapp=' + whatsapp); process.exit(1); }
    abortado = true;
    console.error('\nCortando: termino el turno en vuelo y limpio (otro Ctrl+C sale sin limpiar).');
  });
}

const hoyLima = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
const en13 = new Date(Date.now() + 13 * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Lima' });

let errorFatal = null;
try {
  whatsapp = '510000' + String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
  u = await sb.insert('usuarios', {
    whatsapp, nombre: 'QA Dia0', is_test_user: true,
    onboarding_completado: true, onboarding_paso: 0,
    plan: 'premium', trial_estado: 'activo', trial_inicio: new Date().toISOString(), trial_vence: en13,
    recordatorios_activos: false,
  });
  console.log('usuario efímero ' + u.id);

  console.log('\ndatos');
  const rTaxi = await decir('gasté 12 en taxi');
  check(rTaxi !== null && /S\/\s?12\.00/.test(rTaxi), 'registra el gasto de control (S/12 en taxi)');

  console.log('\ncategoria');
  const rCat = await decir('Por categoría');
  check(rCat !== null && !/Dime la categor/i.test(rCat), 'no repregunta la categoría');
  check(rCat !== null && /12[.,]00/.test(rCat), 'el desglose trae el monto del gasto (S/12.00)');

  // `reinicio` va ANTES de `meta` a propósito: con una meta viva, el modelo mandó "cancela todo"
  // a `abandonar_plan` y el caso pasó sin examinar la guarda. Sin meta, lo único a su alcance es
  // el último movimiento.
  console.log('\nreinicio');
  const antes = await sb.select('transacciones', `usuario_id=eq.${u.id}&select=id`);
  if (antes.length === 0) throw new Error('reinicio: no hay movimientos, "no borró nada" sería verde por vacuidad');
  const rRei = await decir('empecemos de cero, cancela todo');
  const despues = await sb.select('transacciones', `usuario_id=eq.${u.id}&select=id`);
  check(despues.length === antes.length, 'no borra ningún movimiento', `antes=${antes.length} después=${despues.length}`);
  check(rRei !== null && !/Deshecho|Elimin[eé] \*/.test(rRei), 'no confirma un borrado');
  if (rRei !== null && /borra el último/.test(rRei)) {
    nota('pidió la orden explícita: la guarda corrió');
  } else {
    // El modelo lo mandó a otro intent: "no borró" es cierto pero no dice nada de la guarda.
    noEjercitados.push('reinicio');
    nota('no mostró la confirmación: la guarda NO se ejercitó en esta corrida (cuenta como no ejercitado)');
  }

  console.log('\nmeta');
  let rMeta = await decir('Quiero ahorrar 7000 soles para el 31 de diciembre');
  if (rMeta !== null && !/Plan de ahorro creado/.test(rMeta) && /fecha/i.test(rMeta)) rMeta = await decir('Máximo 31 de diciembre');
  check(rMeta !== null && /Plan de ahorro creado/.test(rMeta), 'crea el plan');
  // El usuario efímero no tiene un mes cerrado: la viabilidad NO puede opinar. En el control el
  // código viejo dijo "Tu margen libre es S/0/mes ... extender el plazo 1943 meses más".
  check(rMeta !== null && /mes completo/.test(rMeta), 'sin un mes cerrado, no da veredicto de viabilidad');
  check(rMeta !== null && !/\d{3,} meses/.test(rMeta), 'no promete plazos de cientos de meses');
  check(rMeta !== null && /por día/.test(rMeta), 'la creación trae la cuota por día');
  const rDia = await decir('Y cuanto necesitaría ahorrar por día');
  const metas = await sb.select('metas_ahorro', `usuario_id=eq.${u.id}&select=id`);
  check(metas.length === 1, 'la pregunta de seguimiento NO crea otra meta', 'filas=' + metas.length);
  check(rDia !== null && !/Plan de ahorro creado/.test(rDia), 'no repite "Plan de ahorro creado"');
  nota('el duplicado no discrimina en una corrida: depende de a qué intent mande el modelo la pregunta');
  const anio = Number(hoyLima.slice(0, 4));
  const dias = Math.round((Date.parse(anio + '-12-31T00:00:00Z') - Date.parse(hoyLima + 'T00:00:00Z')) / 86400000) + 1;
  const esperadoDia = Math.ceil(7000 / dias);
  const mDia = rDia && rDia.match(/S\/\s?([\d.,]+)\s*(?:al|por|cada)\s*d[ií]a/i);
  if (mDia) {
    const dicho = parseFloat(mDia[1].replace(',', '.'));
    nota(`cuota por día dicha S/${dicho} contra la correcta S/${esperadoDia}` + (Math.abs(dicho - esperadoDia) / esperadoDia > 0.15 ? '  <-- CUENTA EQUIVOCADA (defecto abierto)' : ''));
  } else {
    nota(`la respuesta no trae una cuota por día (la correcta es S/${esperadoDia})`);
  }
} catch (e) {
  errorFatal = e;
  console.error('\nNo se pudo medir: ' + e.message);
} finally {
  await limpiar();
}

console.log(`\nResultado: ${fallos.length ? fallos.length + ' fallo(s): ' + fallos.join(' · ') : 'todo PASS'}`);
if (!fallos.length && noEjercitados.length) {
  console.log('Pero NO se ejercitó: ' + noEjercitados.join(', ') + '. Repetir la corrida (exit 2).');
}
process.exit(fallos.length ? 1 : (errorFatal || noEjercitados.length) ? 2 : 0);
