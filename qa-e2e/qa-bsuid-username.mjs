// E2E del camino por BSUID contra PRODUCCIÓN.
//
// Ejercita el caso que NO se puede producir a mano: un usuario que activó un username de
// WhatsApp, así que Meta manda su mensaje SIN `from` y solo con `from_user_id`. Golpea el
// webhook real de api.neto.pe con firma HMAC válida, o sea por el mismo camino que Meta.
//
// Desde el 12-sep-2026 a esa persona SE LE CONTESTA por su BSUID (`recipient`, sin `to`). Lo que
// este harness mide es que la respuesta se dirigió a su BSUID sin mandarle nada a nadie real: los
// fixtures llevan `is_test_user`, `enviarWhatsapp` los reconoce POR BSUID y deja en
// `notification_deliveries` una fila `respuesta_bsuid / skipped_test` en vez de llamar a Meta.
// Esa fila es la prueba de las dos cosas a la vez: que la respuesta salió por BSUID y que el
// freno de fixtures funcionó. Antes de ese día `isTestUser` buscaba el BSUID en `whatsapp`, no
// lo encontraba, y el fixture le escribía a Meta de verdad.
//
// Casos:
//   A.  BSUID conocido, fixture CON número: registra el gasto y contesta al BSUID
//   A2. BSUID conocido, fixture SIN número (el caso real): lo mismo
//   C.  callback de estado: el mapeo pasivo del BSUID sigue aprendiendo
//
// Lo que ya NO corre acá, a propósito: el BSUID DESCONOCIDO. Desde el 12-sep ese mensaje DA DE
// ALTA a la persona, y en producción eso crearía una fila sin `is_test_user` que entra al embudo
// y a los crons, y le escribiría a Meta de verdad. Se prueba contra el webhook en proceso, en
// `qa-bsuid-alta.mjs`.
//
// Self-cleaning: siembra sus propios usuarios efímeros y los borra al final, pase o falle.
//
//   node qa-e2e/qa-bsuid-username.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';

const RAILWAY = { P: 'e2aac0f3-c2ee-4347-892c-b36d8c76929e', S: '1085b433-8f29-4487-9ce7-3a66b64ef244', E: '1600a753-bc8c-492c-aca7-27fdac946747' };
const WEBHOOK = process.env.NETO_WEBHOOK || 'https://api.neto.pe/webhook';
const ESPERA_MS = 20000;   // el parser pasa por OpenAI; el webhook responde 200 y sigue async

function envLocal(clave) {
  const txt = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
  return txt.split('\n').find(l => l.startsWith(clave + '='))?.split('=').slice(1).join('=').trim();
}

async function credenciales() {
  const token = envLocal('RAILWAY_API_TOKEN');
  if (!token) throw new Error('Falta RAILWAY_API_TOKEN en .env');
  const q = `query{variables(projectId:"${RAILWAY.P}",environmentId:"${RAILWAY.E}",serviceId:"${RAILWAY.S}")}`;
  const r = await fetch('https://backboard.railway.com/graphql/v2', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
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

// Cliente REST mínimo de Supabase con service role. No se importa supabase-js a propósito:
// este harness es el ORÁCULO, y compartir cliente con el código bajo prueba deja de serlo.
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
    // Lanza igual que `insert`/`select`. Un DELETE que falla deja una fila con un número peruano
    // PLAUSIBLE (`519` + 8 dígitos al azar) viva en la `usuarios` de producción. Si esa persona
    // alguna vez le escribe a Neto, el alta ADOPTA la fila y hereda `is_test_user`: el bot le
    // queda mudo para siempre. El daño no lo paga el harness, lo paga un tercero.
    async del(tabla, query) {
      const r = await fetch(base + tabla + '?' + query, { method: 'DELETE', headers: h });
      if (!r.ok) throw new Error(`delete ${tabla}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    },
  };
}

async function enviarWebhook(secret, message) {
  return postFirmado(secret, {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '51933014505', phone_number_id: 'qa' },
    contacts: [{ user_id: message.from_user_id, profile: { name: 'QA BSUID' } }],
    messages: [message],
  });
}

// Callback de ESTADO, el otro camino por el que llega el BSUID. Meta lo manda cuando NOSOTROS
// enviamos algo, con las dos identidades juntas, así que mapea sin que el usuario escriba.
async function enviarStatus(secret, { numero, bsuid, estado = 'sent' }) {
  return postFirmado(secret, {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '51933014505', phone_number_id: 'qa' },
    statuses: [{
      id: 'wamid.qa-status-' + Math.random().toString(36).slice(2),
      status: estado,
      timestamp: String(Math.floor(Date.now() / 1000)),
      recipient_id: numero,
      recipient_user_id: bsuid,
    }],
  });
}

async function postFirmado(secret, value) {
  const body = { object: 'whatsapp_business_account', entry: [{ id: 'qa', changes: [{ field: 'messages', value }] }] };
  const raw = Buffer.from(JSON.stringify(body));
  const firma = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const r = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': firma },
    body: raw,
  });
  return r.status;
}

const fallos = [];
function check(ok, etiqueta, detalle = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${etiqueta}${detalle ? '  (' + detalle + ')' : ''}`);
  if (!ok) fallos.push(etiqueta);
}

// Borrar y COMPROBAR que se borró, con el resultado atado al exit code. Corre siempre desde un
// `finally`, así que se traga sus propios errores: si revienta mientras ya venía subiendo una
// excepción del cuerpo, lanzar acá la REEMPLAZA. Queda registrado como FAIL, que hace ruido igual.
//
// Las tablas hijas se borran explícitamente en vez de confiar en el cascade: si mañana una FK
// cambia, el harness ensucia producción sin que nadie lo note.
async function borrarUsuarioVerificado(sb, id, etiqueta) {
  try {
    for (const t of ['transacciones', 'notificaciones', 'notification_deliveries', 'conversaciones']) {
      await sb.del(t, `usuario_id=eq.${id}`);
    }
    await sb.del('usuarios', `id=eq.${id}`);
    const quedan = await sb.select('usuarios', `id=eq.${id}&select=id`);
    check(quedan.length === 0, `se borró el usuario efímero (${etiqueta})`,
      quedan.length ? 'QUEDÓ la fila ' + id + ' — bórrala a mano YA' : '');
  } catch (e) {
    check(false, `se borró el usuario efímero (${etiqueta})`,
      'el borrado falló: ' + e.message + ' — revisa la fila ' + id);
  }
}

/**
 * La prueba de que la respuesta se dirigió al BSUID: una fila `respuesta_bsuid` del fixture en
 * `skipped_test`. Si el fixture no se reconociera por BSUID, la fila diría `sent` o `error` —o
 * sea que el mensaje habría ido a Meta—, y eso es un FAIL por sí mismo.
 */
async function verificarRespuestaPorBsuid(sb, usuarioId) {
  const filas = await sb.select('notification_deliveries',
    `usuario_id=eq.${usuarioId}&tipo=eq.respuesta_bsuid&select=estado`);
  check(filas.length >= 1, 'se le contestó por BSUID (fila respuesta_bsuid)', filas.length + ' filas');
  const noFrenadas = filas.filter(f => f.estado !== 'skipped_test');
  check(filas.length > 0 && noFrenadas.length === 0, 'el freno de fixtures funcionó: nada salió a Meta',
    noFrenadas.length ? 'estados: ' + noFrenadas.map(f => f.estado).join(',') : '');
}

const vars = await credenciales();
const sb = db(vars);
const sufijo = crypto.randomBytes(6).toString('hex');
const BSUID_CONOCIDO = 'PE.qa' + sufijo;
const WHATSAPP_QA = '519' + Math.floor(10000000 + Math.random() * 89999999);
let usuario = null;

try {
  // `is_test_user` no es decorativo: este harness le pega al webhook de PRODUCCIÓN, y el número
  // es `519` + 8 dígitos al azar, o sea un celular peruano que puede ser de cualquiera.
  console.log('Sembrando usuario efímero con BSUID', BSUID_CONOCIDO);
  usuario = await sb.insert('usuarios', { whatsapp: WHATSAPP_QA, nombre: 'QA BSUID', bsuid: BSUID_CONOCIDO, is_test_user: true, onboarding_completado: true, onboarding_paso: 0 });

  // --- A: fixture con número, mensaje sin `from` ---
  console.log('\nA. mensaje SIN `from`, con BSUID conocido (el fixture tiene número)');
  const st = await enviarWebhook(vars.META_APP_SECRET, {
    id: 'wamid.qa-conocido-' + sufijo, timestamp: String(Math.floor(Date.now() / 1000)),
    type: 'text', text: { body: 'gasté 37.50 soles en el almuerzo' },
    from_user_id: BSUID_CONOCIDO,   // <-- sin `from`, que es el caso entero
  });
  check(st === 200, 'el webhook acepta el payload sin `from`', 'HTTP ' + st);
  await new Promise(r => setTimeout(r, ESPERA_MS));
  const txs = await sb.select('transacciones', `usuario_id=eq.${usuario.id}&select=id,monto,tipo`);
  check(txs.length === 1, 'se registró exactamente 1 transacción', txs.length + ' encontradas');
  if (txs.length) {
    check(Number(txs[0].monto) === 37.5, 'el monto es el del mensaje', 'monto=' + txs[0].monto);
    check(txs[0].tipo === 'gasto', 'se guardó como gasto', 'tipo=' + txs[0].tipo);
  }
  await verificarRespuestaPorBsuid(sb, usuario.id);

  // --- A2: el caso REAL, que es el que no tiene número ---
  console.log('\nA2. mismo caso pero SIN número guardado');
  const sinNumero = await sb.insert('usuarios', {
    whatsapp: null, nombre: 'QA BSUID sin numero', bsuid: 'PE.qasinnum' + sufijo,
    is_test_user: true, onboarding_completado: true, onboarding_paso: 0,
  });
  try {
    check(!sinNumero.whatsapp, 'el fixture arranca SIN número', 'whatsapp=' + sinNumero.whatsapp);
    const st1b = await enviarWebhook(vars.META_APP_SECRET, {
      id: 'wamid.qa-sinnum-' + sufijo, timestamp: String(Math.floor(Date.now() / 1000)),
      type: 'text', text: { body: 'gasté 42.25 soles en la farmacia' },
      from_user_id: sinNumero.bsuid,
    });
    check(st1b === 200, 'el webhook acepta el payload', 'HTTP ' + st1b);
    await new Promise(r => setTimeout(r, ESPERA_MS));
    const txs1b = await sb.select('transacciones', `usuario_id=eq.${sinNumero.id}&select=id,monto`);
    check(txs1b.length === 1, 'se registró el gasto', txs1b.length + ' encontradas');
    if (txs1b.length) check(Number(txs1b[0].monto) === 42.25, 'con su monto', 'monto=' + txs1b[0].monto);
    await verificarRespuestaPorBsuid(sb, sinNumero.id);
    // El alta no puede haber partido la identidad: la fila sigue siendo UNA, sin número.
    const filas = await sb.select('usuarios', `bsuid=eq.${sinNumero.bsuid}&select=id,whatsapp`);
    check(filas.length === 1 && filas[0].id === sinNumero.id, 'no se duplicó la persona', filas.length + ' filas');
  } finally {
    await borrarUsuarioVerificado(sb, sinNumero.id, 'sin número');
  }

  // --- C: el mapeo PASIVO, que es lo que cubre a quien no escribe ---
  // Sobre un usuario SIN bsuid, para que el PASS solo pueda venir de que el callback lo enseñó.
  console.log('\nC. callback de estado (mapeo pasivo, sin que el usuario escriba)');
  const numeroPasivo = '519' + Math.floor(10000000 + Math.random() * 89999999);
  const bsuidPasivo = 'PE.qapasivo' + sufijo;
  const pasivo = await sb.insert('usuarios', { whatsapp: numeroPasivo, nombre: 'QA BSUID pasivo', is_test_user: true, onboarding_completado: true, onboarding_paso: 0 });
  try {
    check(!pasivo.bsuid, 'el usuario arranca SIN bsuid', 'bsuid=' + pasivo.bsuid);
    const st3 = await enviarStatus(vars.META_APP_SECRET, { numero: numeroPasivo, bsuid: bsuidPasivo, estado: 'sent' });
    check(st3 === 200, 'el webhook acepta el callback de estado', 'HTTP ' + st3);
    await new Promise(r => setTimeout(r, 8000));   // sin OpenAI de por medio: es solo un UPDATE
    const [tras] = await sb.select('usuarios', `id=eq.${pasivo.id}&select=bsuid`);
    check(tras && tras.bsuid === bsuidPasivo, 'aprendió el BSUID desde el callback', 'bsuid=' + (tras && tras.bsuid));
  } finally {
    await borrarUsuarioVerificado(sb, pasivo.id, 'pasivo');
  }
} finally {
  console.log('\nLimpiando usuarios efímeros...');
  if (usuario) await borrarUsuarioVerificado(sb, usuario.id, 'conocido');

  // Por si algún caso dejó una fila en `errores` (no debería: los tres tienen dueño). El filtro va
  // por el `sufijo` de ESTA corrida, así que no puede tocar la de otra corrida ni la de un usuario.
  try {
    const sucias = await sb.select('errores', `select=id&detalle=like.*${sufijo}*`);
    if (sucias.length) await sb.del('errores', `detalle=like.*${sufijo}*`);
    console.log(`  errores del harness borrados: ${sucias.length}`);
  } catch (e) {
    check(false, 'se limpiaron las filas de `errores` del harness', e.message);
  }
}

console.log(fallos.length === 0 ? '\nOK — el camino por BSUID funciona en producción' : '\nFALLOS: ' + fallos.join(' | '));
process.exit(fallos.length === 0 ? 0 : 1);
