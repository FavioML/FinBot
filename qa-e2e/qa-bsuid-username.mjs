// E2E del reconocimiento por BSUID contra PRODUCCIÓN.
//
// Ejercita el caso que NO se puede producir a mano: un usuario que activó un username de
// WhatsApp, así que Meta manda su mensaje SIN `from` y solo con `from_user_id`. Golpea el
// webhook real de api.neto.pe con firma HMAC válida, o sea por el mismo camino que Meta.
//
// Dos casos, y el segundo es el que le da valor al primero:
//   A. BSUID CONOCIDO   -> el gasto se registra aunque no haya a quién responder
//   B. BSUID DESCONOCIDO -> no se registra nada (si no, A pasaría por el motivo equivocado:
//                           "registra siempre" en vez de "registra a quien reconoce")
//
// Self-cleaning: siembra su propio usuario efímero y lo borra al final, pase o falle.
// No toca usuarios reales y no gasta cupo de nada.
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
    async del(tabla, query) {
      await fetch(base + tabla + '?' + query, { method: 'DELETE', headers: h });
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

const vars = await credenciales();
const sb = db(vars);
const sufijo = crypto.randomBytes(6).toString('hex');
const BSUID_CONOCIDO = 'PE.qa' + sufijo;
const BSUID_DESCONOCIDO = 'PE.qadesconocido' + sufijo;
const WHATSAPP_QA = '519' + Math.floor(10000000 + Math.random() * 89999999);
let usuario = null;

try {
  console.log('Sembrando usuario efímero con BSUID', BSUID_CONOCIDO);
  // `is_test_user` no es decorativo acá: este harness le pega al webhook de PRODUCCIÓN, y el
  // número es `519` + 8 dígitos al azar, o sea un celular peruano que puede ser de cualquiera.
  // La marca hace dos cosas, las dos necesarias: `enviarWhatsapp` no llama a Meta para esa fila
  // (lib/whatsapp.js), y `avisarPrimeraVezSilencioso` no dispara el Telegram al admin — que
  // llega con el comando del probe ya armado con este número inventado. El 13-ago-2026 esa
  // alerta salió por una corrida de este harness y se leyó como un usuario real.
  usuario = await sb.insert('usuarios', { whatsapp: WHATSAPP_QA, nombre: 'QA BSUID', bsuid: BSUID_CONOCIDO, is_test_user: true, onboarding_completado: true, onboarding_paso: 0 });

  // --- A: el usuario que SÍ reconocemos ---
  console.log('\nA. mensaje SIN `from`, con BSUID conocido');
  const st = await enviarWebhook(vars.META_APP_SECRET, {
    id: 'wamid.qa-conocido-' + sufijo, timestamp: String(Math.floor(Date.now() / 1000)),
    type: 'text', text: { body: 'gasté 37.50 soles en el almuerzo' },
    from_user_id: BSUID_CONOCIDO,   // <-- sin `from`, que es el caso entero
  });
  check(st === 200, 'el webhook acepta el payload sin `from`', 'HTTP ' + st);

  await new Promise(r => setTimeout(r, ESPERA_MS));
  const txs = await sb.select('transacciones', `usuario_id=eq.${usuario.id}&select=id,monto,moneda,tipo`);
  check(txs.length === 1, 'se registró exactamente 1 transacción', txs.length + ' encontradas');
  if (txs.length) {
    check(Number(txs[0].monto) === 37.5, 'el monto es el del mensaje', 'monto=' + txs[0].monto);
    check(txs[0].tipo === 'gasto', 'se guardó como gasto', 'tipo=' + txs[0].tipo);
  }

  // --- B: control negativo. Sin esto, A pasaría igual si registráramos a cualquiera ---
  console.log('\nB. control: mismo payload con un BSUID que NO conocemos');
  // El conjunto PREVIO de transacciones con ese monto, no "la última global": puede haber
  // una de 999 preexistente de cualquier usuario, y compararse contra ella daría un FAIL falso.
  const idsAntes = new Set((await sb.select('transacciones', 'select=id&monto=eq.999')).map(t => t.id));
  const st2 = await enviarWebhook(vars.META_APP_SECRET, {
    id: 'wamid.qa-desconocido-' + sufijo, timestamp: String(Math.floor(Date.now() / 1000)),
    type: 'text', text: { body: 'gasté 999 soles en algo que no debe guardarse' },
    from_user_id: BSUID_DESCONOCIDO,
  });
  check(st2 === 200, 'el webhook también responde 200 (no revienta)', 'HTTP ' + st2);
  await new Promise(r => setTimeout(r, ESPERA_MS));
  const despues = await sb.select('transacciones', 'select=id,usuario_id,monto&monto=eq.999');
  const nuevaHuerfana = despues.find(t => !idsAntes.has(t.id));
  check(!nuevaHuerfana, 'NO se registró nada para un BSUID desconocido', nuevaHuerfana ? 'apareció ' + nuevaHuerfana.id : '');
  // Si apareció, hay que limpiarla: no tiene dueño legítimo y el `finally` solo borra las del
  // usuario efímero.
  if (nuevaHuerfana) await sb.del('transacciones', `id=eq.${nuevaHuerfana.id}`);

  // --- C: el mapeo PASIVO, que es lo que cubre a quien no escribe ---
  // Se prueba sobre un usuario SIN bsuid, para que el PASS solo pueda venir de que el callback
  // lo enseñó. Es el camino que aprende de lo que NOSOTROS enviamos, no de lo que recibimos.
  console.log('\nC. callback de estado (mapeo pasivo, sin que el usuario escriba)');
  const numeroPasivo = '519' + Math.floor(10000000 + Math.random() * 89999999);
  const bsuidPasivo = 'PE.qapasivo' + sufijo;
  // Mismo motivo que arriba: es otro número al azar viviendo un rato en la `usuarios` de prod.
  const pasivo = await sb.insert('usuarios', { whatsapp: numeroPasivo, nombre: 'QA BSUID pasivo', is_test_user: true, onboarding_completado: true, onboarding_paso: 0 });
  try {
    check(!pasivo.bsuid, 'el usuario arranca SIN bsuid', 'bsuid=' + pasivo.bsuid);
    const st3 = await enviarStatus(vars.META_APP_SECRET, { numero: numeroPasivo, bsuid: bsuidPasivo, estado: 'sent' });
    check(st3 === 200, 'el webhook acepta el callback de estado', 'HTTP ' + st3);
    await new Promise(r => setTimeout(r, 8000));   // sin OpenAI de por medio: es solo un UPDATE
    const [tras] = await sb.select('usuarios', `id=eq.${pasivo.id}&select=bsuid`);
    check(tras && tras.bsuid === bsuidPasivo, 'aprendió el BSUID desde el callback', 'bsuid=' + (tras && tras.bsuid));
  } finally {
    await sb.del('usuarios', `id=eq.${pasivo.id}`);
  }
} finally {
  if (usuario) {
    console.log('\nLimpiando usuario efímero...');
    await sb.del('transacciones', `usuario_id=eq.${usuario.id}`);
    await sb.del('usuarios', `id=eq.${usuario.id}`);
    const quedan = await sb.select('usuarios', `id=eq.${usuario.id}&select=id`);
    console.log(quedan.length === 0 ? '  limpio' : '  OJO: quedó la fila ' + usuario.id);
  }
}

console.log(fallos.length === 0 ? '\nOK — el reconocimiento por BSUID funciona en producción' : '\nFALLOS: ' + fallos.join(' | '));
process.exit(fallos.length === 0 ? 0 : 1);
