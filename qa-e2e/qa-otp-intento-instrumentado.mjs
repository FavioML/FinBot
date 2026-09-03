// ¿De verdad queda registrado que alguien INTENTÓ vincular su WhatsApp desde la webapp?
//
// La migración 083 agregó `usuarios.otp_solicitado_at` y `usuarios.otp_solicitudes`, y de esas
// dos columnas depende una decisión de producto: si la gente que se da de alta por la web y
// nunca vincula lo INTENTÓ y no pudo, el arreglo es la pantalla de vinculación; si ni lo
// intentó, el arreglo es pedir el teléfono en el alta. Son arreglos opuestos.
//
// Una instrumentación que no escribe es peor que ninguna: dentro de tres semanas se va a leer
// "0 intentaron" y eso es indistinguible de "la columna no se está escribiendo". Por eso esto
// corre contra PRODUCCIÓN y contra el endpoint real, no contra un doble.
//
// Las dos cosas que asevera, y la segunda es la que un test de "se escribió algo" no ve:
//   · el primer POST escribe la fecha y deja el contador en 1;
//   · el segundo POST **incrementa el contador y NO mueve la fecha**. `otp_solicitado_at` es un
//     hecho (cuándo lo intentó por primera vez), no un estado. Sin este caso, cambiar el
//     `current.otp_solicitado_at || ...` por un `new Date()` pelado pasa en verde y la columna
//     pasa a decir "la última vez", que es otra pregunta.
//
// ─── Lo que toca de producción, y cómo lo devuelve ──────────────────────────────────────
//
// El endpoint corta con `alreadyLinked` si el usuario ya tiene número, y los dos usuarios QA
// tienen un centinela (`qa-test-dashboard`). Así que el harness lo pone en NULL, mide, y lo
// restaura — comprobando la restauración, no anunciándola. Si el cuerpo revienta, el `finally`
// restaura igual; y si la restauración falla, sale FALLA con el UPDATE para pegar a mano.
//
// El número que se manda (`999999999`) sólo viaja a `webapp_otp.whatsapp_claimed`, que vence en
// 15 minutos y se borra acá al final. Nunca toca `usuarios.whatsapp` de nadie: eso lo escribe el
// webhook cuando llega el código desde el WhatsApp de la persona, que es el punto entero del
// OTP inverso.
//
// Uso:  node qa-e2e/qa-otp-intento-instrumentado.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function loadEnv(file) {
  const out = {};
  try {
    for (const linea of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = linea.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* el llamador decide si falta algo */ }
  return out;
}

const env = loadEnv(path.join(os.homedir(), '.config', 'neto', 'qa.env'));
// Ojo con el nombre: `NETO_QA_URL` es la URL de SUPABASE, no la de la app. Cuesta un rato
// descubrirlo y el harness hermano lo usa igual.
const APP = process.env.NETO_APP_URL || 'https://app.neto.pe';
const SUPA = env.NETO_QA_URL;
const ANON = env.NETO_QA_ANON;
const U = { email: env.NETO_QA_EMAIL, password: env.NETO_QA_PASSWORD, uid: env.NETO_QA_USUARIO_ID };
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY
  || env.SUPABASE_SERVICE_ROLE_KEY
  || loadEnv(new URL('../webapp/.env.local', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')).SUPABASE_SERVICE_ROLE_KEY;

if (!SUPA || !ANON || !U.email || !U.password || !U.uid) {
  console.error('Faltan creds en ~/.config/neto/qa.env (NETO_QA_*).');
  process.exit(2);
}
if (!SERVICE) {
  console.error('Falta SUPABASE_SERVICE_ROLE_KEY (entorno o webapp/.env.local).');
  process.exit(2);
}

const cookieName = `sb-${new URL(SUPA).hostname.split('.')[0]}-auth-token`;

async function sb(ruta, init = {}) {
  const r = await fetch(`${SUPA}/rest/v1/${ruta}`, {
    ...init,
    headers: {
      apikey: SERVICE, Authorization: `Bearer ${SERVICE}`,
      'Content-Type': 'application/json', Prefer: 'return=representation',
      ...(init.headers || {}),
    },
  });
  const texto = await r.text();
  if (!r.ok) throw new Error(`${init.method || 'GET'} ${ruta} -> ${r.status} ${texto}`);
  return texto ? JSON.parse(texto) : null;
}

async function login() {
  const grant = await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: U.email, password: U.password }),
  });
  if (!grant.ok) throw new Error(`Password grant falló: ${grant.status}`);
  const sesion = await grant.json();
  const valor = 'base64-' + Buffer.from(JSON.stringify(sesion), 'utf8').toString('base64url');
  const MAX = 3180;
  const pares = [];
  if (valor.length <= MAX) pares.push(`${cookieName}=${valor}`);
  else for (let i = 0, p = 0; p < valor.length; i++, p += MAX) pares.push(`${cookieName}.${i}=${valor.slice(p, p + MAX)}`);
  return pares.join('; ');
}

async function pedirCodigo(cookie) {
  const r = await fetch(`${APP}/api/onboarding`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ whatsapp: '999999999' }),
    redirect: 'manual',
  });
  const texto = await r.text().catch(() => '');
  let json = null;
  try { json = texto ? JSON.parse(texto) : null; } catch { /* no-json */ }
  return { status: r.status, json };
}

const fallos = [];
const check = (etiqueta, ok, detalle = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${etiqueta}${detalle ? '  (' + detalle + ')' : ''}`);
  if (!ok) fallos.push(etiqueta);
};

const COLS = 'id,whatsapp,otp_solicitado_at,otp_solicitudes';
const leer = async () => (await sb(`usuarios?id=eq.${U.uid}&select=${COLS}`))[0];

const antes = await leer();
console.log(`usuario QA: ${U.uid}  whatsapp=${JSON.stringify(antes.whatsapp)}  ` +
  `otp_solicitado_at=${antes.otp_solicitado_at}  otp_solicitudes=${antes.otp_solicitudes}`);

// El centinela es un texto, no un número: si acá hubiera un teléfono de verdad, esto no es el
// usuario QA y no se toca nada.
if (antes.whatsapp && /^\d/.test(String(antes.whatsapp))) {
  console.error('ABORTA: el usuario QA tiene lo que parece un número real. No lo toco.');
  process.exit(2);
}

try {
  await sb(`usuarios?id=eq.${U.uid}`, { method: 'PATCH', body: JSON.stringify({ whatsapp: null }) });

  console.log('\n1. primer pedido de código');
  const cookie = await login();
  const r1 = await pedirCodigo(cookie);
  check('el endpoint devuelve un código', r1.status === 200 && !!(r1.json && r1.json.code),
    'HTTP ' + r1.status + ' ' + JSON.stringify(r1.json && Object.keys(r1.json)));
  const t1 = await leer();
  check('quedó registrado el intento', !!t1.otp_solicitado_at, 'otp_solicitado_at=' + t1.otp_solicitado_at);
  check('el contador arrancó en 1', t1.otp_solicitudes === (antes.otp_solicitudes || 0) + 1,
    'otp_solicitudes=' + t1.otp_solicitudes);

  console.log('\n2. segundo pedido: la fecha es un HECHO, el contador es un contador');
  const r2 = await pedirCodigo(cookie);
  check('el endpoint responde de nuevo', r2.status === 200, 'HTTP ' + r2.status);
  const t2 = await leer();
  check('el contador subió', t2.otp_solicitudes === t1.otp_solicitudes + 1, 'otp_solicitudes=' + t2.otp_solicitudes);
  check('la fecha del PRIMER intento NO se movió', t2.otp_solicitado_at === t1.otp_solicitado_at,
    t1.otp_solicitado_at + ' -> ' + t2.otp_solicitado_at);
} finally {
  console.log('\nRestaurando el fixture...');
  try {
    await sb(`usuarios?id=eq.${U.uid}`, {
      method: 'PATCH',
      body: JSON.stringify({
        whatsapp: antes.whatsapp,
        otp_solicitado_at: antes.otp_solicitado_at,
        otp_solicitudes: antes.otp_solicitudes,
      }),
    });
    // El OTP pendiente que dejó el harness: vence solo en 15 minutos, pero dejarlo haría que
    // `webapp_otp` —que ya es una ventana viva y no un historial— quede además con una fila de
    // QA reclamando un número inventado.
    const auth = env.NETO_QA_AUTH_ID;
    if (auth) await sb(`webapp_otp?supabase_auth_id=eq.${auth}`, { method: 'DELETE' });
    const fin = await leer();
    check('el fixture quedó como estaba',
      fin.whatsapp === antes.whatsapp
      && fin.otp_solicitado_at === antes.otp_solicitado_at
      && fin.otp_solicitudes === antes.otp_solicitudes,
      'whatsapp=' + JSON.stringify(fin.whatsapp) + ' at=' + fin.otp_solicitado_at + ' n=' + fin.otp_solicitudes);
  } catch (e) {
    check('el fixture quedó como estaba', false,
      'FALLÓ la restauración: ' + e.message +
      ` — corré a mano: update usuarios set whatsapp='${antes.whatsapp}', otp_solicitado_at=` +
      (antes.otp_solicitado_at ? `'${antes.otp_solicitado_at}'` : 'null') +
      `, otp_solicitudes=${antes.otp_solicitudes} where id='${U.uid}';`);
  }
}

console.log(fallos.length === 0
  ? '\nOK — el intento de vinculación queda medido en producción'
  : '\nFALLOS: ' + fallos.join(' | '));
process.exitCode = fallos.length === 0 ? 0 : 1;
