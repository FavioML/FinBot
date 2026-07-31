// E2E del LINK DE ACTIVACIÓN: el puente WhatsApp → webapp que reemplazó al OTP
// para quien nace en el chat.
//
// Lo que este harness cuida, y es el riesgo real del diseño: el token lo FIRMA el
// backend (Railway) y lo VERIFICA la webapp (Vercel) con un secreto compartido,
// sin hop de red entre ellos. Si `ACTIVATION_TOKEN_SECRET` no es idéntico en las
// dos plataformas, no se rompe nada visible — simplemente TODOS los links de
// activación dejan de funcionar en silencio y el usuario cae en un login normal.
// Un test que corra de un solo lado no puede detectar eso; este corre de los dos.
//
// Lo que NO cubre, a propósito:
//   - La adopción y la fusión de filas (bindActivacion). Requeriría fabricar una
//     segunda identidad de Google, que no se puede hacer sin tocar auth.users; y
//     probarlo contra el usuario QA real haría que merge_and_link le adoptara el
//     número del throwaway (whatsapp = COALESCE(loser, survivor)) y le rompiera
//     su vínculo real. La fusión ya está cubierta por qa-web-signup-merge.mjs,
//     que ejercita el MISMO rpc con la misma orientación survivor/loser.
//   - La confirmación con sesión abierta (/activar/confirmar), que necesita un
//     navegador logueado.
//
// Corre contra PRODUCCIÓN (app.neto.pe). Solo lee: no crea ni muta usuarios.
//
// Correr:  node qa-e2e/qa-activacion-link.mjs   (desde app/)  → exit 0 si pasa.

import 'dotenv/config';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { construirTokenActivacion, construirLinkActivacion } = require('../lib/activacion');

const WEBAPP = process.env.QA_WEBAPP_URL || 'https://app.neto.pe';
const UID_FICTICIO = '00000000-0000-4000-8000-000000000000';   // uuid válido que no existe

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond, detail });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
  return !!cond;
};

// fetch sin seguir redirects: lo que se quiere ver es el 3xx y su Location/Set-Cookie.
function abrir(url) {
  return fetch(url, { redirect: 'manual' });
}

async function run() {
  if (!check('ACTIVATION_TOKEN_SECRET está configurada en este entorno',
    !!process.env.ACTIVATION_TOKEN_SECRET, 'sin ella el backend no emite links')) return;

  const token = construirTokenActivacion(UID_FICTICIO);
  if (!check('el backend firma un token', !!token)) return;

  const link = construirLinkActivacion(UID_FICTICIO);
  check('el link apunta a /activar de la webapp', /\/activar\?t=/.test(link || ''), link?.slice(0, 60));

  // ── El token firmado acá lo acepta la webapp desplegada ───────────────────
  const rOk = await abrir(`${WEBAPP}/activar?t=${encodeURIComponent(token)}`);
  const locOk = rOk.headers.get('location') || '';
  check('la webapp responde con un redirect al link de activación',
    rOk.status >= 300 && rOk.status < 400, 'status=' + rOk.status);
  check('el token firmado por el backend es ACEPTADO por la webapp (mismo secreto)',
    /\/login\?activar=1/.test(locOk),
    'location=' + locOk + (/-activacion=expirado/.test(locOk) ? '  ← ¿secreto distinto en Vercel?' : ''));

  const cookies = rOk.headers.getSetCookie ? rOk.headers.getSetCookie() : [rOk.headers.get('set-cookie') || ''];
  const actCookie = cookies.find((c) => c && c.startsWith('neto_act='));
  check('deja el token en la cookie neto_act para el otro lado del login', !!actCookie,
    actCookie ? actCookie.split(';')[0].slice(0, 30) + '…' : 'sin cookie');
  check('la cookie es httpOnly (el token no debe quedar al alcance del JS de la página)',
    /httponly/i.test(actCookie || ''), actCookie ? actCookie.split(';').slice(1).join(';').trim() : '—');

  // ── Rechazos ──────────────────────────────────────────────────────────────
  const [payload, firma] = token.split('.');
  const firmaAlterada = firma.slice(0, -1) + (firma.slice(-1) === 'A' ? 'B' : 'A');
  const rForjado = await abrir(`${WEBAPP}/activar?t=${encodeURIComponent(payload + '.' + firmaAlterada)}`);
  check('la webapp RECHAZA un token con la firma alterada',
    /\/login\?activacion=expirado/.test(rForjado.headers.get('location') || ''),
    'location=' + rForjado.headers.get('location'));

  const otroPayload = Buffer.from(JSON.stringify({ uid: 'otro-usuario', ts: Date.now() })).toString('base64url');
  const rSuplantado = await abrir(`${WEBAPP}/activar?t=${encodeURIComponent(otroPayload + '.' + firma)}`);
  check('la webapp RECHAZA un payload cambiado con una firma prestada',
    /\/login\?activacion=expirado/.test(rSuplantado.headers.get('location') || ''),
    'location=' + rSuplantado.headers.get('location'));

  const vencido = Buffer.from(JSON.stringify({ uid: UID_FICTICIO, ts: Date.now() - 8 * 24 * 60 * 60 * 1000 })).toString('base64url');
  const { createHmac } = await import('crypto');
  const firmaVencida = createHmac('sha256', process.env.ACTIVATION_TOKEN_SECRET).update(vencido).digest('base64url');
  const rVencido = await abrir(`${WEBAPP}/activar?t=${encodeURIComponent(vencido + '.' + firmaVencida)}`);
  check('la webapp RECHAZA un token vencido aunque la firma sea buena',
    /\/login\?activacion=expirado/.test(rVencido.headers.get('location') || ''),
    'location=' + rVencido.headers.get('location'));

  const rVacio = await abrir(`${WEBAPP}/activar`);
  check('la webapp RECHAZA una visita sin token',
    /\/login\?activacion=expirado/.test(rVacio.headers.get('location') || ''),
    'location=' + rVacio.headers.get('location'));

  // ── El endpoint de confirmación no se puede llamar sin sesión ─────────────
  const rConfirmar = await fetch(`${WEBAPP}/api/activar/confirmar`, { method: 'POST' });
  check('POST /api/activar/confirmar sin sesión responde 401',
    rConfirmar.status === 401, 'status=' + rConfirmar.status);
}

let fatal = null;
try { await run(); } catch (e) { fatal = e; console.log('FAIL excepción — ' + e.message); }

const fallidos = results.filter((r) => !r.pass);
console.log('\n=== ' + (results.length - fallidos.length) + '/' + results.length + ' checks OK ===');
if (fatal) console.log(fatal.stack);
process.exit(fallidos.length === 0 && !fatal ? 0 : 1);
