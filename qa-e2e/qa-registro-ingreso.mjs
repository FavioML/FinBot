#!/usr/bin/env node
/**
 * REGISTRAR UN INGRESO DICHO CON LA PALABRA "INGRESO" O "ENTRÓ", contra PRODUCCIÓN y por el webhook
 * firmado (24-nov-2026). La decisión vive en `tipoContradiceElMensaje` (lib/nlp-guards.js), que corre
 * sobre lo que devuelve el parser en `registrar_manual`.
 *
 * El caso de prod (770ad4dd, 21-oct): "150.00 ingreso de cita en estilista 03/10" y "150.00 entró a mi
 * cuenta 03/10 de cita estilista" quedaron como GASTO en Compras > Belleza (el parser real da gasto 3 de
 * 3 con las dos). La persona los borró en la webapp tres horas después. El arreglo no escribe ingreso
 * por su cuenta: cuando el parser dice gasto y el mensaje sólo nombra el ingreso, pregunta.
 *
 * Cada caso con un usuario NUEVO y sin movimientos; se afirma sobre la BASE (qué filas quedan).
 *
 *   node qa-e2e/qa-registro-ingreso.mjs [--n 3] [--solo ingreso-sustantivo,entro-a-mi-cuenta]
 *
 * Desde `fecha-ddmm` también mira la FECHA: "gasté 20 en taxi 03/10" quedaba con la de hoy (el parser
 * duda entre día/mes y mes/día con el día en 12 o menos); lo corrige `resolverFechaDiaMes` (lib/dates.js).
 *
 * Desde `editar-fecha-*` también la EDICIÓN de fecha en frío: un gasto sembrado directo en la base, sin
 * conversación (el clasificador no tiene historial), y "cámbialo al 15/10". Con hoy 24-nov el
 * clasificador real trae 2023-10-15 y `editar_fecha` lo escribía; lo ancla `anclarAnioDeEdicion`.
 *
 * Desde `duplicar-*` también la COPIA: "duplícalo para el 15/10" sobre un gasto sembrado. La fecha de la
 * copia sale del texto (`fechaDeLaCopia`, lib/orden-edicion.js); antes salía con la de hoy.
 *
 * Corre DESPUÉS del deploy (confirmado con `/version`): contra el commit anterior es el CONTROL y tiene
 * que fallar en los dos casos de producción.
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
    contacts: [{ wa_id: from, profile: { name: 'QA Ingreso' } }],
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
  // En prueba Pro.
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
  const st = await enviarTexto(vars.META_APP_SECRET, u.whatsapp, texto, `wamid.qa-ingreso-${sufijo}-${++n}`);
  if (st !== 200) throw new Error('el webhook devolvió HTTP ' + st);
  return esperarRespuesta(sb, u.id, texto);
}



const txDe = (u) => sb.select('transacciones', `usuario_id=eq.${u.id}&select=id,tipo,monto,comercio,categoria,fecha&order=created_at.asc`);
const resumen = (txs) => JSON.stringify(txs.map((t) => `${t.tipo} ${t.monto} ${t.comercio} ${t.fecha}`));
const PREGUNTA = /entraron o salieron/;

// El mensaje dice que la plata entró: o no queda NINGUNA fila y se pregunta, o queda UNA de ingreso.
// Nunca un gasto. Las dos salidas valen porque el parser es un modelo: si un día lee bien, mejor.
function nuncaGasto(monto) {
  return async (u, r) => {
    const txs = await txDe(u);
    const ok = txs.length === 0 ? PREGUNTA.test(r || '') : (txs.length === 1 && txs[0].tipo === 'ingreso' && Number(txs[0].monto) === monto);
    return [
      [!txs.some((t) => t.tipo === 'gasto'), `ningún gasto de ${monto}`, resumen(txs)],
      [ok, `pregunta sin escribir, o una fila de ingreso de ${monto}`, resumen(txs)],
    ];
  };
}
function unaFila(tipo, monto, fecha) {
  return async (u) => {
    const txs = await txDe(u);
    const checks = [[txs.length === 1 && txs[0].tipo === tipo && Number(txs[0].monto) === monto, `una fila de ${tipo} de ${monto}`, resumen(txs)]];
    if (fecha) checks.push([txs.length === 1 && txs[0].fecha === fecha, `con fecha ${fecha}`, resumen(txs)]);
    return checks;
  };
}

// Una fecha dd/mm con el día en 12 o menos y de un mes ANTERIOR al actual: la forma en que el parser
// devolvía hoy (24-nov-2026, "03/10"). Se calcula para que siempre caiga en el pasado.
const FECHA_DDMM = (() => {
  const f = new Date(hoyLima() + 'T12:00:00Z');
  // Día 3, salvo en marzo ("03/03": con día = mes no hay nada que confundir y la guarda no actúa).
  f.setUTCDate(1); f.setUTCMonth(f.getUTCMonth() - 1); f.setUTCDate(f.getUTCMonth() === 2 ? 4 : 3);
  const iso = f.toISOString().slice(0, 10);
  return { iso, texto: iso.slice(8, 10) + '/' + iso.slice(5, 7) };
})();

// La fecha del mes ANTERIOR con el día `dia`: siempre en el pasado (en enero, diciembre del año pasado).
const MESES_TXT = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
function mesAnterior(dia) {
  const f = new Date(hoyLima() + 'T12:00:00Z');
  f.setUTCDate(1); f.setUTCMonth(f.getUTCMonth() - 1); f.setUTCDate(dia);
  const iso = f.toISOString().slice(0, 10);
  return { iso, ddmm: iso.slice(8, 10) + '/' + iso.slice(5, 7), texto: dia + ' de ' + MESES_TXT[f.getUTCMonth()] };
}
// El gasto a corregir, sembrado sin pasar por WhatsApp: así el clasificador lo ve sin historial.
async function sembrarGasto(u) {
  await sb.insert('transacciones', {
    usuario_id: u.id, tipo: 'gasto', monto: 20, monto_pen: 20, moneda: 'PEN', comercio: 'Taxi',
    categoria: 'Transporte', subcategoria: 'taxi', fecha: hoyLima(), descripcion_original: 'qa-editar-fecha',
  });
}
function fechaEditada(fecha) {
  return async (u) => {
    const txs = await txDe(u);
    return [[txs.length === 1 && txs[0].fecha === fecha, `el gasto sembrado queda con fecha ${fecha}`, resumen(txs)]];
  };
}

// La copia de "duplícalo para ..." (DEFECTOS 24-nov: salía con la fecha de HOY porque el clasificador no
// manda la fecha de la copia). Quedan DOS filas: el sembrado intacto, con la de hoy, y la copia.
function copiaCon(fecha) {
  return async (u) => {
    const txs = await txDe(u);
    const original = txs.filter((t) => t.fecha === hoyLima() && Number(t.monto) === 20);
    const copia = fecha === hoyLima() ? original.length === 2 : txs.some((t) => t.fecha === fecha && Number(t.monto) === 20 && t.comercio === 'Taxi');
    return [
      [txs.length === 2 && txs.every((t) => t.tipo === 'gasto'), 'dos gastos: el original y la copia', resumen(txs)],
      [original.length >= 1, 'el original sigue con la fecha de hoy', resumen(txs)],
      [copia, `la copia con fecha ${fecha}`, resumen(txs)],
    ];
  };
}

// Un día de la semana de hace 4 días: ni hoy ni ayer, así que "fue el <día>" sólo tiene una lectura.
const DIAS_TXT = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const HACE_4 = (() => { const iso = sumarDias(hoyLima(), -4); return { iso, dia: DIAS_TXT[new Date(iso + 'T12:00:00Z').getUTCDay()] }; })();

const CASOS = {
  // Las dos frases de producción.
  'ingreso-sustantivo': { msg: '150.00 ingreso de cita en estilista 03/10', afirmar: nuncaGasto(150) },
  'entro-a-mi-cuenta': { msg: '150.00 entró a mi cuenta 03/10 de cita estilista', afirmar: nuncaGasto(150) },
  // Lo que la persona escribió después, que es lo que la pregunta le enseña: entra como ingreso.
  'respuesta-con-verbo': {
    previos: ['150.00 ingreso de cita en estilista 03/10'], msg: 'Me pagaron 150.00 de arreglo de cabello el 03/10',
    afirmar: unaFila('ingreso', 150),
  },
  // CONTROLES: la forma corta de ingreso sigue entrando, y los gastos no preguntan.
  'ingreso-corto': { msg: 'Ingreso 480', afirmar: unaFila('ingreso', 480) },
  'pague-el-ingreso': { msg: 'pagué 20 de ingreso al museo', afirmar: unaFila('gasto', 20) },
  'gasto-normal': { msg: 'gasté 20 en taxi', afirmar: unaFila('gasto', 20, hoyLima()) },
  // La fecha escrita como dd/mm (DEFECTOS 24-nov: "03/10" quedaba con la fecha de hoy).
  'fecha-ddmm': { msg: 'gasté 20 en taxi ' + FECHA_DDMM.texto, afirmar: unaFila('gasto', 20, FECHA_DDMM.iso) },
  // Edición de fecha en frío (DEFECTOS 24-nov: el clasificador inventaba el AÑO y se escribía).
  'editar-fecha-anio': { sembrar: true, msg: 'cámbialo al ' + mesAnterior(15).ddmm, afirmar: fechaEditada(mesAnterior(15).iso) },
  'editar-fecha-mes-texto': { sembrar: true, msg: 'cámbialo al ' + mesAnterior(15).texto, afirmar: fechaEditada(mesAnterior(15).iso) },
  'editar-fecha-ddmm': { sembrar: true, msg: 'cámbialo al ' + mesAnterior(3).ddmm, afirmar: fechaEditada(mesAnterior(3).iso) },
  // Editar la fecha DETRÁS de la confirmación de un gasto (DEFECTOS 24-nov): "la fecha es el 15/10" iba a
  // registrar_manual y no escribía; "fue el <día>" llegaba con otro día y se escribía.
  'editar-fecha-tras-confirmacion': { previos: ['gasté 20 en taxi'], msg: 'la fecha es el ' + mesAnterior(15).ddmm, afirmar: fechaEditada(mesAnterior(15).iso) },
  'editar-fecha-dia-semana': { previos: ['gasté 20 en taxi'], msg: 'fue el ' + HACE_4.dia, afirmar: fechaEditada(HACE_4.iso) },
  // Duplicar para otra fecha (DEFECTOS 24-nov). "repítelo para el 15 de <mes>" en frío llegaba como
  // `editar_fecha`: lo reencamina `esOrdenDeDuplicar`.
  'duplicar-ddmm': { sembrar: true, msg: 'duplícalo para el ' + mesAnterior(15).ddmm, afirmar: copiaCon(mesAnterior(15).iso) },
  'duplicar-mes-texto': { sembrar: true, msg: 'repítelo para el ' + mesAnterior(15).texto, afirmar: copiaCon(mesAnterior(15).iso) },
  'duplicar-ayer': { sembrar: true, msg: 'duplícalo para ayer', afirmar: copiaCon(sumarDias(hoyLima(), -1)) },
  'duplicar-sin-fecha': { sembrar: true, msg: 'duplícalo', afirmar: copiaCon(hoyLima()) },
};

async function correrCaso(nombre, corrida) {
  const caso = CASOS[nombre];
  const u = await crearUsuario();
  if (caso.sembrar) await sembrarGasto(u);
  for (const previo of caso.previos || []) await decir(u, previo);
  if (caso.conCaptura) await sembrarConfirmacionCaptura(u, caso.conCaptura);
  const r = await decir(u, caso.msg);
  const etiqueta = `${nombre} #${corrida}`;
  const lineas = [`${etiqueta}  > ${JSON.stringify(caso.msg)}`, `    < ${r === null ? '(sin respuesta)' : JSON.stringify(r.slice(0, 240))}`];
  const checks = r === null ? [[false, 'hubo respuesta']] : await caso.afirmar(u, r);
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
