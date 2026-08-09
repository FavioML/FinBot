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
// Siembra un usuario THROWAWAY con un gasto porque la página de llegada resuelve
// nombre y gastos del uid firmado: sin fila real, un token con firma BUENA
// redirige igual que uno forjado (ambos a /login?activacion=expirado) y el
// chequeo de paridad del secreto se volvería vacuo. De paso verifica que la
// página muestre los datos correctos. Se borra todo al final.
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
// Corre contra PRODUCCIÓN (app.neto.pe) con la Supabase real.
//
// Correr:  node qa-e2e/qa-activacion-link.mjs   (desde app/)  → exit 0 si pasa.

import 'dotenv/config';
import { createRequire } from 'module';
import { instalarGuard } from './lib/qa-guard.mjs';

const require = createRequire(import.meta.url);
const { construirTokenActivacion, construirLinkActivacion } = require('../lib/activacion');
const supabase = instalarGuard(require, '../lib/db');

const WEBAPP = process.env.QA_WEBAPP_URL || 'https://app.neto.pe';
const RUN = Date.now();
const WA = '51900' + String(RUN).slice(-6);
const NOMBRE = 'Ana Prueba';

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond, detail });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
  return !!cond;
};

let userId = null;

// ── La línea entre "no se pudo medir" (exit 2) y "el secreto ya no coincide" (exit 1) ──
//
// Hasta el 09-ago-2026 este harness solo tenía exit 1, así que una caída de red salía
// igual que el fallo que existe para detectar y el canary no podía distinguirlos.
//
// Lo que NO se movió a exit 2, y es el punto: un 3xx a `/login?activacion=expirado` sigue
// siendo exit 1. Ese es EL hallazgo (el secreto dejó de ser idéntico entre Railway y
// Vercel). Meterlo en la bolsa de infra convertiría el harness en decorativo, que es
// justo el modo de fallo que el resto de este repo viene pagando. Solo es inconcluso lo
// que impide llegar a preguntar: sin credencial local, sin webapp en pie, sin poder
// sembrar en Supabase, o un fetch que ni siquiera completa.
class Inconcluso extends Error {}
const inconcluso = (motivo) => { throw new Inconcluso(motivo); };

// fetch sin seguir redirects: lo que se quiere ver es el 3xx y su Location.
// Un fallo de RED nunca es un veredicto: no llegamos a ver qué respondería la webapp.
const abrir = async (url) => {
  try {
    return await fetch(url, { redirect: 'manual' });
  } catch (e) {
    inconcluso('no se pudo alcanzar ' + new URL(url).origin + ': ' + e.message);
  }
};

async function run() {
  if (!process.env.ACTIVATION_TOKEN_SECRET) {
    // Es el .env de la máquina que corre esto, no dice NADA de producción.
    inconcluso('falta ACTIVATION_TOKEN_SECRET en este entorno: sin ella el backend no emite links');
  }
  check('ACTIVATION_TOKEN_SECRET está configurada en este entorno', true, 'presente');

  // ── Pre-vuelo: ¿la webapp está en pie? ────────────────────────────────────
  // Sin esto, la webapp caída y el secreto desincronizado se ven igual desde acá: los dos
  // dejan de devolver 200 en /activar. Con una ruta conocida-buena de por medio, un fallo
  // de /activar con /login sano SÍ es un veredicto sobre /activar.
  const vivo = await abrir(`${WEBAPP}/login`);
  if (vivo.status >= 500) {
    inconcluso('la webapp responde ' + vivo.status + ' en /login: está caída, no hay veredicto posible sobre /activar');
  }
  check('pre-vuelo: la webapp está en pie (/login no da 5xx)', true, 'status=' + vivo.status);

  // ── Sembrar el usuario throwaway con un gasto ─────────────────────────────
  const { data: creado, error: insErr } = await supabase.from('usuarios').insert({
    whatsapp: WA, is_test_user: true, nombre: NOMBRE,
    onboarding_paso: 0, onboarding_completado: true, plan: 'free',
  }).select('id').single();
  // Sin la fila, un token con firma BUENA redirige igual que uno forjado y el chequeo de
  // paridad del secreto se vuelve vacuo: no es un fallo, es no haber podido preguntar.
  if (insErr || !creado) inconcluso('no se pudo sembrar el usuario throwaway: ' + (insErr?.message || 'sin fila devuelta'));
  check('se sembró el usuario throwaway', true, 'id=' + creado.id);
  userId = creado.id;

  const { error: txErr } = await supabase.from('transacciones').insert({
    usuario_id: userId, monto: 20, monto_pen: 20, moneda: 'PEN',
    comercio: 'Taxi QA', categoria: 'Transporte', subcategoria: 'Taxi',
    tipo: 'gasto', fecha: new Date().toISOString().slice(0, 10),
  });
  check('se sembró un gasto', !txErr, txErr ? txErr.message : 'S/20 en Taxi QA');

  const token = construirTokenActivacion(userId);
  if (!check('el backend firma un token', !!token)) return;
  check('el link apunta a /activar de la webapp',
    /\/activar\?t=/.test(construirLinkActivacion(userId) || ''), 'ok');

  // ── El token firmado acá lo acepta la webapp desplegada ───────────────────
  const rOk = await abrir(`${WEBAPP}/activar?t=${encodeURIComponent(token)}`);
  const html = rOk.status === 200 ? await rOk.text() : '';
  check('el token firmado por el backend es ACEPTADO por la webapp (mismo secreto)',
    rOk.status === 200,
    'status=' + rOk.status + (rOk.status !== 200 ? ' location=' + rOk.headers.get('location') + '  ← ¿secreto distinto en Vercel?' : ''));

  const cookies = rOk.headers.getSetCookie ? rOk.headers.getSetCookie() : [rOk.headers.get('set-cookie') || ''];
  const actCookie = cookies.find((c) => c && c.startsWith('neto_act='));
  check('deja el token en la cookie neto_act para el otro lado del login', !!actCookie,
    actCookie ? actCookie.split(';')[0].slice(0, 28) + '…' : 'sin cookie');
  check('la cookie es httpOnly (el token no debe quedar al alcance del JS de la página)',
    /httponly/i.test(actCookie || ''), actCookie ? 'HttpOnly presente' : '—');

  // ── La página de llegada reconoce a la persona ────────────────────────────
  check('saluda por su nombre', html.includes('Ana,'), html.includes('Ana,') ? 'ok' : 'sin nombre en el HTML');
  check('dice que su cuenta YA existe (no "crea tu cuenta")',
    /ya existe/i.test(html) && !/crea tu cuenta/i.test(html), 'ok');
  check('muestra el gasto que registró', html.includes('Taxi QA') && html.includes('S/20.00'), 'ok');
  check('muestra su número enmascarado, no completo',
    html.includes('••• ' + WA.slice(-4)) && !html.includes(WA), 'termina en ' + WA.slice(-4));
  check('NO le ofrece volver a WhatsApp ni el pitch de correos bancarios',
    !/Empezar por WhatsApp/i.test(html) && !/Sin anotar nada/i.test(html), 'ok');
  check('ofrece Google como camino primario', /Continuar con Google/i.test(html), 'ok');

  // ── Rechazos ──────────────────────────────────────────────────────────────
  const [payload, firma] = token.split('.');
  const firmaAlterada = firma.slice(0, -1) + (firma.slice(-1) === 'A' ? 'B' : 'A');
  const rForjado = await abrir(`${WEBAPP}/activar?t=${encodeURIComponent(payload + '.' + firmaAlterada)}`);
  check('RECHAZA un token con la firma alterada',
    /\/login\?activacion=expirado/.test(rForjado.headers.get('location') || ''),
    'location=' + rForjado.headers.get('location'));

  const otroPayload = Buffer.from(JSON.stringify({ uid: userId, ts: Date.now() })).toString('base64url');
  const rSuplantado = await abrir(`${WEBAPP}/activar?t=${encodeURIComponent(otroPayload + '.' + firma)}`);
  check('RECHAZA un payload rearmado con una firma prestada',
    /\/login\?activacion=expirado/.test(rSuplantado.headers.get('location') || ''),
    'location=' + rSuplantado.headers.get('location'));

  const vencido = Buffer.from(JSON.stringify({ uid: userId, ts: Date.now() - 8 * 24 * 60 * 60 * 1000 })).toString('base64url');
  const { createHmac } = await import('crypto');
  const firmaVencida = createHmac('sha256', process.env.ACTIVATION_TOKEN_SECRET).update(vencido).digest('base64url');
  const rVencido = await abrir(`${WEBAPP}/activar?t=${encodeURIComponent(vencido + '.' + firmaVencida)}`);
  check('RECHAZA un token vencido aunque la firma sea buena',
    /\/login\?activacion=expirado/.test(rVencido.headers.get('location') || ''),
    'location=' + rVencido.headers.get('location'));

  const rVacio = await abrir(`${WEBAPP}/activar`);
  check('RECHAZA una visita sin token',
    /\/login\?activacion=expirado/.test(rVacio.headers.get('location') || ''),
    'location=' + rVacio.headers.get('location'));

  // ── Un solo uso: activada la cuenta, el token queda inerte ────────────────
  await supabase.from('usuarios')
    .update({ supabase_auth_id: '00000000-0000-4000-8000-' + String(RUN).slice(-12) })
    .eq('id', userId);
  const rInerte = await abrir(`${WEBAPP}/activar?t=${encodeURIComponent(token)}`);
  check('sobre una cuenta YA activada el token es inerte (no re-vincula)',
    (rInerte.headers.get('location') || '').endsWith('/login'),
    'location=' + rInerte.headers.get('location'));

  // ── El endpoint de confirmación no se puede llamar sin sesión ─────────────
  const rConfirmar = await fetch(`${WEBAPP}/api/activar/confirmar`, { method: 'POST' });
  check('POST /api/activar/confirmar sin sesión responde 401',
    rConfirmar.status === 401, 'status=' + rConfirmar.status);
}

async function cleanup() {
  if (!userId) {
    const { data } = await supabase.from('usuarios').select('id').eq('whatsapp', WA).maybeSingle();
    userId = data?.id || null;
  }
  if (!userId) { check('limpieza: no quedó usuario throwaway', true, 'nada que borrar'); return; }
  await supabase.from('transacciones').delete().eq('usuario_id', userId);
  await supabase.from('categorias_usuario').delete().eq('usuario_id', userId);
  const { error } = await supabase.from('usuarios').delete().eq('id', userId);
  const { data: sigue } = await supabase.from('usuarios').select('id').eq('id', userId).maybeSingle();
  check('se borró el usuario throwaway y su gasto', !error && !sigue,
    error ? error.message : 'id=' + userId + ' borrado');
}

let fatal = null;
let infra = null;
try { await run(); } catch (e) {
  if (e instanceof Inconcluso) { infra = e; console.log('INCONCLUSO — ' + e.message); }
  else { fatal = e; console.log('FAIL excepción — ' + e.message); }
}
// La limpieza corre igual: si el aborto fue después de sembrar, el throwaway está en
// PRODUCCIÓN y sacarlo importa más que el veredicto.
try { await cleanup(); } catch (e) { console.log('FAIL limpieza — ' + e.message); fatal = fatal || e; }

const fallidos = results.filter((r) => !r.pass);
console.log('\n=== ' + (results.length - fallidos.length) + '/' + results.length + ' checks OK ===');
if (fatal) console.log(fatal.stack);

// Un check rojo GANA sobre el inconcluso, siempre y a propósito. Si algo ya se midió y
// falló, eso es un veredicto, y no se degrada a "no pude opinar" porque después se cayera
// la red. La incertidumbre solo puede empujar hacia el lado ruidoso, nunca hacia el
// tranquilizador — es la misma regla con la que `decidirFrescura()` da exit 2 en vez de
// PASS cuando la lista de archivos viene truncada.
//
// `process.exitCode`, NO `process.exit()`, y no es estilo: en Windows, salir con sockets
// keep-alive de fetch todavía abiertos devuelve **127**. Antes no se notaba porque el
// único camino de salida corría después de completar todos los fetch; los abortos por
// inconcluso salen a mitad de camino y ahí sí aparece. Un exit 2 que llega como 127 es
// peor que no tenerlo: el canary lo lee como fallo desconocido. Misma nota que
// `qa-score-parity.mjs` y `qa-gating-score.mjs`.
if (fallidos.length || fatal) {
  console.log('==> REGRESIÓN (exit 1)');
  process.exitCode = 1;
} else if (infra) {
  console.log('==> INCONCLUSO (exit 2) — ' + infra.message);
  process.exitCode = 2;
} else {
  console.log('==> OK');
  process.exitCode = 0;
}
