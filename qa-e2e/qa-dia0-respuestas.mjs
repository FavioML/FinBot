#!/usr/bin/env node
/**
 * LAS RESPUESTAS MALAS DEL DÍA 0, contra PRODUCCIÓN y por el webhook real (plan día 0→1, 14-sep-2026).
 *
 * Cada caso es la frase que un usuario real escribió el día de su alta y que terminó con él
 * yéndose. La suite prueba el working tree con dobles; esto prueba que el backend que CORRE en
 * `api.neto.pe` —con el clasificador de verdad, gpt-4o-mini incluido— contesta bien.
 *
 *   categoria    "Por categoría" entraba en bucle de "Dime la categoría" (95aaa7dd, 11-ago).
 *   reinicio     "empecemos de cero, cancela todo" borraba el último movimiento sin preguntar, y
 *                después (07-oct) abría el menú de ELIMINAR LA CUENTA. Hoy: ni borra ni abre el
 *                menú; contesta el texto de `reiniciar_o_borrar`.
 *   menu         (07-oct) con el menú de la cuenta abierto, el mensaje siguiente se perdía:
 *                "Quiero ahorrar 7000…" recibía "Cancelado." y la meta no existía. Hoy el menú se
 *                cierra, el mensaje se procesa, y en ese turno un "borra el último" no borra.
 *   meta         "¿cuánto por día?" volvía a crear la meta: 2 filas y "extender el plazo 190
 *                meses" (2a917ac4, 27-ago).
 *
 * Dos casos del mismo trabajo NO están acá porque sus arreglos se retiraron antes del push ("4 en
 * pan y maca" y "¿vas a perder el registro?"): ver `docs/DEFECTOS.md`, 14-sep.
 *
 * **Un usuario efímero POR CASO** (07-oct). Hasta ese día era uno solo para todo, y el estado
 * se arrastraba: el `reinicio` dejaba el menú de la cuenta abierto y el caso `meta` corría con el
 * menú todavía ahí, así que medía el menú y no la meta. Cada usuario lleva `is_test_user = true`
 * (`enviarWhatsapp` no llama a Meta), alta cerrada y prueba activa sembrada. El número es `510000`
 * + 6 dígitos: con `9` después del 51 sería un celular peruano válido, y si `isTestUser` fallara
 * abierto (`lib/whatsapp.js`) el mensaje saldría a una persona. Si el número ya existe, el INSERT
 * choca con el único de `usuarios.whatsapp` y aborta antes de mandar nada. Borra y COMPRUEBA el
 * borrado de cada uno desde un `finally` y también ante Ctrl+C.
 *
 * **Lo que deja, dicho:** no siembra transacciones por REST, porque borrar una deja su copia en
 * `borrados_auditoria` (append-only). Las crea el propio bot, así que cada corrida deja como máximo
 * una fila de auditoría por usuario efímero que registró un gasto.
 *
 * **Lo que se pagó en las corridas de control (14-sep):**
 *   - La respuesta se ata al mensaje por `conversaciones.id`, NO por `created_at > reloj local`.
 *   - `reinicio` exige movimientos antes (exit 2 si no hay) y corre sin metas: con una meta viva el
 *     modelo mandó "cancela todo" a `abandonar_plan` y el caso no examinó nada.
 *   - `categoria` afirma el MONTO del desglose: la repregunta vieja trae "Alimentación" en su ejemplo.
 *   - `meta/duplicado` NO discrimina en una corrida (depende de a qué intent mande el modelo la
 *     pregunta); lo cubre el test unitario y acá se reporta. La cuota por día que diga el modelo se
 *     compara contra la correcta como NOTA: en el control inventó S/233 contra ~S/65.
 *   - `menu` abre el menú con "Quiero eliminar mi cuenta" y lo CONFIRMA en la base
 *     (`onboarding_paso = -1`); si el clasificador no lo abrió, el caso sale no ejercitado (exit 2).
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
// Un usuario efímero por caso: `{ u, whatsapp, piso }`. Los creados quedan en `creados` para que
// la limpieza los alcance aunque el caso se corte a la mitad.
const creados = [];
let abortado = false;

async function crearUsuario(etiqueta) {
  const en13 = new Date(Date.now() + 13 * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
  const whatsapp = '510000' + String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
  const caso = { whatsapp, piso: 0, u: null };
  creados.push(caso);
  caso.u = await sb.insert('usuarios', {
    whatsapp, nombre: 'QA Dia0', is_test_user: true,
    onboarding_completado: true, onboarding_paso: 0,
    plan: 'premium', trial_estado: 'activo', trial_inicio: new Date().toISOString(), trial_vence: en13,
    recordatorios_activos: false,
  });
  console.log(`  usuario efímero (${etiqueta}) ${caso.u.id}`);
  return caso;
}

async function decir(caso, texto) {
  if (abortado) throw new Error('cortado a mano antes de mandar ' + JSON.stringify(texto));
  const st = await enviarTexto(vars.META_APP_SECRET, caso.whatsapp, texto, `wamid.qa-dia0-${sufijo}-${++n}`);
  if (st !== 200) throw new Error('el webhook devolvió HTTP ' + st);
  const r = await esperarRespuesta(sb, caso.u.id, texto, caso.piso);
  caso.piso = r.entranteId;
  console.log(`    > ${JSON.stringify(texto)}\n    < ${r.texto === null ? '(sin respuesta)' : JSON.stringify(r.texto.slice(0, 240))}`);
  return r.texto;
}

// La fila del usuario tal como está ahora: el menú vive en `onboarding_paso` y el borrado de la
// cuenta deja `cuenta_borrada_at`. Mirar la base y no solo el texto es lo que hace que el caso
// `menu` no dependa de cómo redacte el modelo.
async function fila(caso) {
  const [f] = await sb.select('usuarios', `id=eq.${caso.u.id}&select=onboarding_paso,cuenta_borrada_at`);
  return f || null;
}
const contar = async (tabla, caso) => (await sb.select(tabla, `usuario_id=eq.${caso.u.id}&select=id`)).length;

let limpio = false;
async function limpiar() {
  if (limpio) return;
  limpio = true;
  if (!creados.length) return;
  console.log('\nLimpieza');
  for (const caso of creados) {
    if (!caso.u) continue;
    try {
      for (const t of ['metas_ahorro', 'transacciones', 'transacciones_eliminadas', 'conversaciones', 'notificaciones', 'notification_deliveries']) {
        await sb.del(t, `usuario_id=eq.${caso.u.id}`);
      }
      await sb.del('usuarios', `id=eq.${caso.u.id}`);
      const quedan = await sb.select('usuarios', `id=eq.${caso.u.id}&select=id`);
      check(quedan.length === 0, 'se borró el usuario efímero ' + caso.u.id, quedan.length ? 'QUEDÓ la fila, bórrala a mano' : '');
    } catch (e) {
      check(false, 'se borró el usuario efímero ' + caso.u.id, 'el borrado falló: ' + e.message);
    }
  }
}
// Ctrl+C / SIGTERM NO limpian en paralelo: si se borra la fila del usuario mientras el backend
// todavía procesa el mensaje en vuelo, `obtenerOCrearUsuario` recrea a ese número SIN
// `is_test_user` y nadie la limpia (revisión adversarial, 14-sep). Se marca, el flujo principal
// no manda nada más, termina de esperar el turno en vuelo y limpia el `finally`. Un segundo
// Ctrl+C sale sin limpiar, y lo dice.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (abortado) { console.error('\nSalida forzada SIN limpiar: revisa usuarios con whatsapp en ' + creados.map((c) => c.whatsapp).join(', ')); process.exit(1); }
    abortado = true;
    console.error('\nCortando: termino el turno en vuelo y limpio (otro Ctrl+C sale sin limpiar).');
  });
}

const hoyLima = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });

let errorFatal = null;
try {
  // ── usuario 1: datos → categoria → reinicio (sin metas, a propósito: ver la cabecera) ──
  console.log('\ndatos');
  const c1 = await crearUsuario('datos/categoria/reinicio');
  const rTaxi = await decir(c1, 'gasté 12 en taxi');
  check(rTaxi !== null && /S\/\s?12\.00/.test(rTaxi), 'registra el gasto de control (S/12 en taxi)');

  console.log('\ncategoria');
  const rCat = await decir(c1, 'Por categoría');
  check(rCat !== null && !/Dime la categor/i.test(rCat), 'no repregunta la categoría');
  check(rCat !== null && /12[.,]00/.test(rCat), 'el desglose trae el monto del gasto (S/12.00)');

  console.log('\nreinicio');
  const antes = await contar('transacciones', c1);
  if (antes === 0) throw new Error('reinicio: no hay movimientos, "no borró nada" sería verde por vacuidad');
  const rRei = await decir(c1, 'empecemos de cero, cancela todo');
  const despues = await contar('transacciones', c1);
  const f1 = await fila(c1);
  check(despues === antes, 'no borra ningún movimiento', `antes=${antes} después=${despues}`);
  check(rRei !== null && !/Deshecho|Elimin[eé] \*/.test(rRei), 'no confirma un borrado');
  check(f1 && f1.onboarding_paso !== -1 && !/Eliminar tu cuenta/.test(rRei || ''), 'no abre el menú de eliminar la cuenta',
    'onboarding_paso=' + (f1 && f1.onboarding_paso));
  check(rRei !== null && /no tengo un botón para reiniciar/.test(rRei), 'contesta el texto de reiniciar_o_borrar');

  // ── usuario 2: el mensaje que sigue al menú de la cuenta ──
  console.log('\nmenu');
  const c2 = await crearUsuario('menu');
  const rAbre = await decir(c2, 'Quiero eliminar mi cuenta');
  const fAbre = await fila(c2);
  if (!fAbre || fAbre.onboarding_paso !== -1) {
    // El clasificador no abrió el menú: el caso no examinó lo que dice examinar.
    noEjercitados.push('menu');
    nota('el menú no quedó abierto (onboarding_paso=' + (fAbre && fAbre.onboarding_paso) + '): el caso NO se ejercitó');
  } else {
    check(/confirmo borrar mi cuenta/.test(rAbre || ''), 'el menú pide la frase de confirmación');
    let rMetaMenu = await decir(c2, 'Quiero ahorrar 7000 soles para el 31 de diciembre');
    const fTras = await fila(c2);
    check(!/^Cancelado/.test(rMetaMenu || ''), 'el mensaje que sigue al menú NO se contesta con "Cancelado"');
    check(/Cerré el menú/.test(rMetaMenu || ''), 'avisa que cerró el menú');
    check(fTras && fTras.onboarding_paso === 0, 'el menú queda cerrado en la base', 'onboarding_paso=' + (fTras && fTras.onboarding_paso));
    if (rMetaMenu !== null && !/Plan de ahorro creado/.test(rMetaMenu) && /fecha/i.test(rMetaMenu)) rMetaMenu = await decir(c2, 'Máximo 31 de diciembre');
    check(rMetaMenu !== null && /Plan de ahorro creado/.test(rMetaMenu), 'el mensaje se procesó: la meta existe en la respuesta');
    check((await contar('metas_ahorro', c2)) === 1, 'el mensaje se procesó: la meta existe en la base');
    check(fTras && fTras.cuenta_borrada_at === null, 'la cuenta no se borró');

    // Con el menú abierto, un borrado de un gasto no se ejecuta: borrar con el menú abierto es la frase.
    const rPan = await decir(c2, 'gasté 7 en pan');
    check(rPan !== null && /S\/\s?7\.00/.test(rPan), 'registra un gasto con el menú cerrado (control)');
    const txAntes = await contar('transacciones', c2);
    const metasAntes = await contar('metas_ahorro', c2);
    await decir(c2, 'Quiero eliminar mi cuenta');
    const fReabre = await fila(c2);
    if (!fReabre || fReabre.onboarding_paso !== -1) {
      noEjercitados.push('menu/borrado');
      nota('el menú no se reabrió: el borrado con el menú abierto NO se ejercitó');
    } else {
      const rBorra = await decir(c2, 'borra el último gasto');
      const txDespues = await contar('transacciones', c2);
      const metasDespues = await contar('metas_ahorro', c2);
      const fFin = await fila(c2);
      check(txDespues === txAntes, 'con el menú abierto, "borra el último gasto" no borra', `antes=${txAntes} después=${txDespues}`);
      check(rBorra !== null && !/Deshecho|Elimin[eé] \*/.test(rBorra), 'no confirma un borrado');
      // Con una meta viva el modelo puede mandar "borra" a `eliminar_meta`: tampoco se ejecuta.
      check(metasDespues === metasAntes, 'tampoco borra la meta', `antes=${metasAntes} después=${metasDespues}`);
      check(fFin && fFin.cuenta_borrada_at === null, 'la cuenta sigue viva');
    }
  }

  // ── usuario 3: la meta, sin nada abierto antes ──
  console.log('\nmeta');
  const c3 = await crearUsuario('meta');
  let rMeta = await decir(c3, 'Quiero ahorrar 7000 soles para el 31 de diciembre');
  if (rMeta !== null && !/Plan de ahorro creado/.test(rMeta) && /fecha/i.test(rMeta)) rMeta = await decir(c3, 'Máximo 31 de diciembre');
  check(rMeta !== null && /Plan de ahorro creado/.test(rMeta), 'crea el plan');
  // El usuario efímero no tiene un mes cerrado: la viabilidad NO puede opinar. En el control el
  // código viejo dijo "Tu margen libre es S/0/mes ... extender el plazo 1943 meses más".
  check(rMeta !== null && /mes completo/.test(rMeta), 'sin un mes cerrado, no da veredicto de viabilidad');
  check(rMeta !== null && !/\d{3,} meses/.test(rMeta), 'no promete plazos de cientos de meses');
  check(rMeta !== null && /por día/.test(rMeta), 'la creación trae la cuota por día');
  const rDia = await decir(c3, 'Y cuanto necesitaría ahorrar por día');
  check((await contar('metas_ahorro', c3)) === 1, 'la pregunta de seguimiento NO crea otra meta');
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
