// E2E del OTP inverso SIN número, contra PRODUCCIÓN.
//
// Ejercita el caso que quedó abierto hasta el 02-sep-2026: alguien con el número oculto
// (WhatsApp Usernames) que manda su código `NETO-XXXXXX` para verificar su cuenta web. Ese
// mensaje moría en el `if (!from)` del webhook ~360 líneas antes del matcheo del código, así que
// el onboarding quedaba colgado en "Esperando tu confirmación..." para siempre. Golpea el webhook
// real de api.neto.pe con firma HMAC válida, o sea por el mismo camino que Meta.
//
// Tres casos, y los dos últimos son los que le dan valor al primero:
//   A. código VÁLIDO         -> vincula el BSUID a la cuenta web y marca el OTP verificado
//   B. código INEXISTENTE    -> no vincula nada (si no, A pasaría por "vincula siempre")
//   C. código de OTRA cuenta -> vincula a ESA cuenta y no a la de A (si no, A pasaría por
//                               "vincula a la última fila que encuentre", que es justo el
//                               desenlace que ataría el WhatsApp de alguien a la cuenta de otro)
//
// Self-cleaning: siembra sus propias filas efímeras y las borra al final, pase o falle.
// Todo usuario sembrado va con `is_test_user: true` — el aviso al admin lo saltea, así que esto
// NO le manda un Telegram a Favio (regresión del 13-ago-2026).
//
//   node qa-e2e/qa-otp-sin-numero.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';

const RAILWAY = { P: 'e2aac0f3-c2ee-4347-892c-b36d8c76929e', S: '1085b433-8f29-4487-9ce7-3a66b64ef244', E: '1600a753-bc8c-492c-aca7-27fdac946747' };
const WEBHOOK = process.env.NETO_WEBHOOK || 'https://api.neto.pe/webhook';
const ESPERA_MS = 8000; // el webhook responde 200 y sigue async

function envLocal(clave) {
  const txt = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
  return txt.split('\n').find((l) => l.startsWith(clave + '='))?.split('=').slice(1).join('=').trim();
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

// Cliente REST mínimo con service role. No se importa supabase-js a propósito: este harness es el
// ORÁCULO, y compartir cliente con el código bajo prueba deja de serlo.
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

async function enviarCodigo(secret, { bsuid, texto }) {
  const body = {
    object: 'whatsapp_business_account',
    entry: [{ id: 'qa', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: '51933014505', phone_number_id: 'qa' },
      contacts: [{ profile: { name: 'QA OTP', username: 'qa_otp' }, user_id: bsuid }],
      messages: [{ id: 'wamid.qa-otp-' + crypto.randomUUID(), from_user_id: bsuid, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: texto } }],
    } }] }],
  };
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

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const codigo = () => 'NETO-' + String(100000 + Math.floor(Math.random() * 900000));
// El prefijo `PE.qa` es lo que permite separar estas filas de los eventos REALES al contar
// `errores`. Sin él, un harness contamina la única métrica que dice cuánta gente quedó sin
// atender (documentado en el CLAUDE.md, medición del 13-ago-2026).
const bsuidQA = () => 'PE.qa' + Math.floor(Math.random() * 1e12);

// Borra y COMPRUEBA que se borró, con el resultado atado al exit code: una fila filtrada en la
// `usuarios` de producción con `is_test_user` puesto deja al bot mudo para quien la adopte.
async function limpiar(sb, ids, authIds) {
  for (const id of ids) {
    try {
      await sb.del('usuarios', `id=eq.${id}`);
      const quedan = await sb.select('usuarios', `id=eq.${id}&select=id`);
      check(quedan.length === 0, 'limpieza de usuarios ' + id.slice(0, 8));
    } catch (e) { check(false, 'limpieza de usuarios ' + id.slice(0, 8), e.message); }
  }
  for (const a of authIds) {
    try {
      await sb.del('webapp_otp', `supabase_auth_id=eq.${a}`);
      const quedan = await sb.select('webapp_otp', `supabase_auth_id=eq.${a}&select=id`);
      check(quedan.length === 0, 'limpieza de webapp_otp ' + a.slice(0, 8));
    } catch (e) { check(false, 'limpieza de webapp_otp ' + a.slice(0, 8), e.message); }
  }
}

async function main() {
  const vars = await credenciales();
  const sb = db(vars);
  const usuarios = [];
  const auths = [];

  try {
    // ── Cuenta A: la que va a recibir el vínculo ──────────────────────────────
    const authA = crypto.randomUUID();
    const codigoA = codigo();
    const bsuidA = bsuidQA();
    auths.push(authA);
    const uA = await sb.insert('usuarios', {
      nombre: 'QA OTP BSUID A', email: `qa-otp-a-${Date.now()}@qa.neto.pe`,
      supabase_auth_id: authA, whatsapp: null, bsuid: null,
      is_test_user: true, onboarding_completado: false, onboarding_paso: 0,
    });
    usuarios.push(uA.id);
    await sb.insert('webapp_otp', {
      code: codigoA, supabase_auth_id: authA, email: uA.email, nombre: 'QA OTP BSUID A',
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    });

    // ── Cuenta B: el control de "vincula a la cuenta CORRECTA" ────────────────
    const authB = crypto.randomUUID();
    const codigoB = codigo();
    const bsuidB = bsuidQA();
    auths.push(authB);
    const uB = await sb.insert('usuarios', {
      nombre: 'QA OTP BSUID B', email: `qa-otp-b-${Date.now()}@qa.neto.pe`,
      supabase_auth_id: authB, whatsapp: null, bsuid: null,
      is_test_user: true, onboarding_completado: false, onboarding_paso: 0,
    });
    usuarios.push(uB.id);
    await sb.insert('webapp_otp', {
      code: codigoB, supabase_auth_id: authB, email: uB.email, nombre: 'QA OTP BSUID B',
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    });

    console.log('\nA. código VÁLIDO desde un BSUID desconocido');
    const s1 = await enviarCodigo(vars.META_APP_SECRET, { bsuid: bsuidA, texto: `Hola Neto, verifica mi cuenta web: ${codigoA}` });
    check(s1 === 200, 'el webhook aceptó el mensaje', 'status ' + s1);
    await dormir(ESPERA_MS);

    const [filaA] = await sb.select('usuarios', `id=eq.${uA.id}&select=id,bsuid,onboarding_completado`);
    check(filaA?.bsuid === bsuidA, 'el BSUID quedó vinculado a la cuenta web', 'bsuid=' + (filaA?.bsuid || 'null'));
    const [otpA] = await sb.select('webapp_otp', `code=eq.${codigoA}&select=verified_at`);
    check(!!otpA?.verified_at, 'el código quedó marcado verificado (es lo que destraba la webapp)');

    console.log('\nB. código INEXISTENTE desde otro BSUID desconocido');
    const bsuidX = bsuidQA();
    const s2 = await enviarCodigo(vars.META_APP_SECRET, { bsuid: bsuidX, texto: 'NETO-000001' });
    check(s2 === 200, 'el webhook aceptó el mensaje', 'status ' + s2);
    await dormir(ESPERA_MS);
    const huerfanos = await sb.select('usuarios', `bsuid=eq.${bsuidX}&select=id`);
    check(huerfanos.length === 0, 'un código que no existe NO vincula nada');

    console.log('\nC. el código de la cuenta B vincula a B, no a A');
    const s3 = await enviarCodigo(vars.META_APP_SECRET, { bsuid: bsuidB, texto: codigoB });
    check(s3 === 200, 'el webhook aceptó el mensaje', 'status ' + s3);
    await dormir(ESPERA_MS);
    const [filaB] = await sb.select('usuarios', `id=eq.${uB.id}&select=id,bsuid`);
    check(filaB?.bsuid === bsuidB, 'el BSUID de B quedó en la cuenta B', 'bsuid=' + (filaB?.bsuid || 'null'));
    const [reA] = await sb.select('usuarios', `id=eq.${uA.id}&select=bsuid`);
    check(reA?.bsuid === bsuidA, 'la cuenta A NO fue pisada por el código de B', 'bsuid=' + (reA?.bsuid || 'null'));
  } finally {
    console.log('\nLimpieza');
    await limpiar(sb, usuarios, auths);
  }

  console.log('');
  if (fallos.length) {
    console.log('FALLÓ: ' + fallos.length + ' chequeo(s) — ' + fallos.join(', '));
    return 1;
  }
  console.log('OK: el OTP inverso cierra sin número y vincula a la cuenta correcta');
  return 0;
}

// `process.exit()` con handles abiertos revienta libuv en Windows Y SE LLEVA EL EXIT CODE (un
// exit(2) llegó a salir 127). Se devuelve el código y se sale por `exitCode`.
main().then((c) => { process.exitCode = c; }).catch((e) => {
  console.error('ERROR: ' + (e && e.message));
  process.exitCode = 2;
});
