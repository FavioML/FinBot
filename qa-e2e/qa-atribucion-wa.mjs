#!/usr/bin/env node
/**
 * EL BACKEND DESPLEGADO LEE LOS TEXTOS QUE SE REPARTEN — contra PRODUCCIÓN, por el webhook real.
 *
 * La mitad de la atribución que ningún otro instrumento mira. `landing/scripts/verify-atribucion.mjs`
 * prueba que los links SALEN con el corchete `[posicion|origen]`, y `tests/lib/atribucion.test.js`
 * que el parser del working tree lo lee. Ninguno de los dos dice si el backend que CORRE en
 * `api.neto.pe` convierte ese texto en `usuarios.origen`: son dos repos y dos CI, y el día que
 * alguien cambie el formato en uno solo, lo que se rompe no es un test, son las altas, en silencio.
 *
 * Cada caso es un texto que hoy se reparte de verdad, copiado del sitio que lo arma:
 *
 *   referido     landing `src/lib/constants.ts` → `waReferralLink`. Es el único texto donde el
 *                corchete convive con OTRO contrato (`^hola neto ref:CODE`, el de referidos), así
 *                que además de la etiqueta se afirma que el texto sigue empezando como ese regex pide.
 *   invitacion   webapp `src/app/join/marco.tsx` → `WA_INVITACION`.
 *   login        webapp `src/app/login/page.tsx` → `waLogin('ig')`.
 *   blog         landing `blog-content.ts` + `<HtmlAtribuido>` con una visita desde Google.
 *   sin-corchete control: el primer mensaje sin etiqueta NO escribe nada (queda NULL). Sin este
 *                caso, un backend que escribiera siempre algo haría pasar a los otros cuatro.
 *
 * **Cómo no le escribe a nadie.** Siembra cada usuario ANTES de mandar el mensaje, con
 * `is_test_user = true` (así `enviarWhatsapp` no llama a Meta, `lib/whatsapp.js`) y el alta abierta
 * (`onboarding_completado = false`, `origen` NULL), que es exactamente la fila que el webhook adopta
 * en el primer mensaje. El número es `519` + 8 dígitos al azar: si por azar ya existe, el INSERT
 * choca con el único de `usuarios.whatsapp` y el harness aborta antes de mandar nada. Borra y
 * COMPRUEBA el borrado desde un `finally`, pase o falle.
 *
 * El código de referido es inventado a propósito: el backend no lo resuelve y no vincula a nadie,
 * o sea que no toca las estadísticas ni la plata de ningún referrer real.
 *
 * Credenciales: `RAILWAY_API_TOKEN` en `app/.env`; el resto (Supabase y `META_APP_SECRET`) se lee de
 * las variables del servicio en Railway, igual que `qa-bsuid-username.mjs`.
 *
 * NO va al canary: el backend no cambia sin commit, y cada corrida escribe en `usuarios` de prod.
 * Se corre a mano al tocar el formato del corchete o cualquiera de los textos de arriba.
 *
 *   node qa-e2e/qa-atribucion-wa.mjs
 *
 * exit 0 = los cinco casos pasan y no quedó nada · 1 = alguno falla o quedó basura · 2 = no pudo medir.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

const RAILWAY = { P: 'e2aac0f3-c2ee-4347-892c-b36d8c76929e', S: '1085b433-8f29-4487-9ce7-3a66b64ef244', E: '1600a753-bc8c-492c-aca7-27fdac946747' };
const WEBHOOK = process.env.NETO_WEBHOOK || 'https://api.neto.pe/webhook';
// La atribución corre ANTES del NLP (handlers/webhook.js, justo después de resolver al usuario),
// así que no espera a OpenAI. 20s es holgura para el cold path del webhook, no para el modelo.
const ESPERA_MS = 20000;

const CASOS = [
  { id: 'referido', texto: 'Hola NETO ref:QAPROBE1 [referido|referido]', origen: 'referido', cta: 'referido' },
  { id: 'invitacion', texto: 'Hola Neto, quiero empezar a ordenar mis finanzas [invitacion|invitacion] 👋', origen: 'invitacion', cta: 'invitacion' },
  { id: 'login', texto: 'Hola Neto, quiero empezar a ordenar mis finanzas [login|ig] 👋', origen: 'ig', cta: 'login' },
  { id: 'blog', texto: 'Hola Neto, quiero empezar [blog|google] 👋', origen: 'google', cta: 'blog' },
  { id: 'sin-corchete', texto: 'Hola Neto, quiero empezar 👋', origen: null, cta: null },
];

function envLocal(clave) {
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

// REST directo y no supabase-js: este harness es el ORÁCULO, y compartir cliente con el código
// bajo prueba deja de serlo. Las tres operaciones LANZAN ante un status malo.
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
    contacts: [{ wa_id: from, profile: { name: 'QA Atribucion' } }],
    messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: texto } }],
  };
  const body = { object: 'whatsapp_business_account', entry: [{ id: 'qa', changes: [{ field: 'messages', value }] }] };
  const raw = Buffer.from(JSON.stringify(body));
  const firma = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const r = await fetch(WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': firma }, body: raw });
  return r.status;
}

const fallos = [];
function check(ok, etiqueta, detalle = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${etiqueta}${detalle ? '  (' + detalle + ')' : ''}`);
  if (!ok) fallos.push(etiqueta);
}

const sembrados = [];

// Corre desde el `finally`, así que se traga sus errores a propósito (lanzar acá reemplazaría la
// excepción que venía subiendo). Queda como FAIL, que hace el mismo ruido.
async function borrarVerificado(sb, u) {
  try {
    await sb.del('transacciones', `usuario_id=eq.${u.id}`);
    await sb.del('notificaciones', `usuario_id=eq.${u.id}`);
    await sb.del('usuarios', `id=eq.${u.id}`);
    const quedan = await sb.select('usuarios', `id=eq.${u.id}&select=id`);
    check(quedan.length === 0, `se borró el usuario efímero (${u.caso})`, quedan.length ? 'QUEDÓ la fila ' + u.id + ', bórrala a mano' : '');
  } catch (e) {
    check(false, `se borró el usuario efímero (${u.caso})`, 'el borrado falló: ' + e.message + ', revisa la fila ' + u.id);
  }
}

async function esperarOrigen(sb, id, esperaAlgo) {
  const hasta = Date.now() + ESPERA_MS;
  let fila;
  do {
    [fila] = await sb.select('usuarios', `id=eq.${id}&select=origen,origen_cta`);
    if (esperaAlgo ? fila?.origen : false) return fila;
    await new Promise((r) => setTimeout(r, 1500));
  } while (Date.now() < hasta);
  return fila;
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
let errorFatal = null;
try {
  for (const c of CASOS) {
    console.log(`\n${c.id}: ${JSON.stringify(c.texto)}`);
    const whatsapp = '519' + Math.floor(10000000 + Math.random() * 89999999);
    const u = await sb.insert('usuarios', {
      whatsapp,
      nombre: 'QA Atribucion',
      is_test_user: true,
      onboarding_completado: false,
      onboarding_paso: 0,
    });
    sembrados.push({ id: u.id, caso: c.id });
    check(u.origen == null, 'el fixture arranca SIN origen', 'origen=' + u.origen);

    const st = await enviarTexto(vars.META_APP_SECRET, whatsapp, c.texto, `wamid.qa-atr-${sufijo}-${c.id}`);
    check(st === 200, 'el webhook acepta el mensaje firmado', 'HTTP ' + st);

    const fila = await esperarOrigen(sb, u.id, c.origen !== null);
    check(fila?.origen === c.origen, `origen = ${JSON.stringify(c.origen)}`, 'got ' + JSON.stringify(fila?.origen));
    check(fila?.origen_cta === c.cta, `origen_cta = ${JSON.stringify(c.cta)}`, 'got ' + JSON.stringify(fila?.origen_cta));
  }
} catch (e) {
  errorFatal = e;
  console.error('\nNo se pudo medir: ' + e.message);
} finally {
  console.log('\nLimpieza');
  for (const u of sembrados) await borrarVerificado(sb, u);
}

console.log(`\nResultado: ${fallos.length ? fallos.length + ' fallo(s): ' + fallos.join(' · ') : 'todo PASS'}`);
process.exit(errorFatal && !fallos.length ? 2 : fallos.length ? 1 : 0);
